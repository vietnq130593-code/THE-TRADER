/**
 * src/lib/ml/features.ts — FEATURECONTRACT (P0-3) — NƠI TÍNH ĐẶC TRƯNG
 * DUY NHẤT của hệ thống + nạp rổ topByAdtv (P0-2).
 *
 * DATA_PLATFORM_BLUEPRINT v1.1 §3.2 (phiên #57): mọi consumer (agent-context
 * · bayes/evidence · S2 feature-store · A9 readiness) gọi qua giao diện này —
 * không còn 3 đường tính độc lập (indicators latest-only · tự tính trong
 * evidence · S2 tự tính). `indicators.ts` giữ nguyên vai trò vỏ API "giá trị
 * cuối" cho các chỉ báo ngoài hợp đồng (BOLL/ATR/Stoch/OBV) và UI.
 *
 * • `rollingFeatures(closes, volumes)` — chuỗi chỉ báo rolling O(N) (Wilder
 *   RSI · EMA MACD 12/26/9 · SMA window-sum) — thuật toán chuẩn duy nhất.
 * • `latestFeatureSnapshot` — bộ giá trị PHIÊN CUỐI dùng cho prompt/evidence/S2
 *   (SMA20/50 · RSI14 · MACD hist · động lượng 5 phiên · KL/TL20).
 * • `loadTopSeries` — rổ top-N theo topByAdtv (ADTV 45 phiên từ Bar.value —
 *   định nghĩa rổ duy nhất P0-2, thay ranking avg-volume cũ của fixbug F6 và
 *   quote-volume của latestFeatures).
 *
 * buildTrainingSet(topN): quét top-N mã thanh khoản rồi trượt cửa sổ trên
 * chuỗi EOD thật — mỗi phiên t đủ 60 phiên lịch sử và t+5 tồn tại → 16 đặc
 * trưng + nhãn hướng 5 phiên tới. Nhãn: close(t+5)/close(t)−1 > +0,5% → 2
 * (UP), < −0,5% → 0 (DOWN), còn lại 1 (FLAT).
 *
 * B1 (phiên #81 — ML_OPS_BLUEPRINT §4): bộ đặc trưng v2-lag16 — thêm 6 chiều
 * lag/đạo hàm THUẦN QUÁ KHỨ (PIT-an toàn) trên chuỗi EOD hiện có. 10 chiều
 * đầu GIỮ NGUYÊN thứ tự & công thức v1 (bản serving v8-lag10 đọc x[0..9] của
 * vector 16 chiều — tương thích ngược). windowHash KHÔNG đổi (hash trên bar,
 * không phụ thuộc đặc trưng) — cùng dữ liệu, khác bộ đặc trưng, cổng B2 so
 * trực tiếp v2 với v1 trên cùng windowHash.
 */

import { db } from "@/lib/db";
import { loadTopDatedSeries, topByAdtv } from "@/lib/dated-series";
// P1-2 PIT — SHA-256 window-hash của cửa sổ train (node:crypto, backend only)
import { createHash } from "node:crypto";

/** Số đặc trưng đầu vào của MLP (thay đổi phải đổi cả kiến trúc mạng).
 *  B1 (#81 — ML_OPS_BLUEPRINT §4): 10 → 16 (v2-lag16). */
export const ML_FEATURE_COUNT = 16;
/** Nhãn bộ đặc trưng hiện hành — lưu MlModel.meta.featureSet khi train
 *  (B1: bản v8 cũ không có trường này → đọc về "v1-lag10"). */
export const ML_FEATURE_SET = "v2-lag16";
/** Nhãn bộ đặc trưng v1 (10 chiều) — bản train trước B1. */
export const ML_FEATURE_SET_V1 = "v1-lag10";
/** Số phiên lịch sử tối thiểu trước điểm lấy mẫu (warmup RSI/MACD/SMA50/max60). */
export const ML_WARMUP_BARS = 60;
/** Horizon dự báo (phiên). */
export const ML_HORIZON_DAYS = 5;
/** Ngưỡng nhãn: |ret 5 phiên| > 0,5% mới tính UP/DOWN. */
export const ML_LABEL_THRESHOLD = 0.005;
/** Số mẫu huấn luyện tối đa (lấy gần nhất) — chống train quá 60s. */
export const ML_MAX_SAMPLES = 60_000;

/** Bộ dữ liệu huấn luyện: X (raw features) + y (0=DOWN 1=FLAT 2=UP). */
export interface TrainingSet {
  X: number[][];
  y: number[];
  /** Mã chứng khoán của từng mẫu (gán công topSymbols). */
  symbols: string[];
  /** Ngày phiên t của từng mẫu (ISO date — dùng cut 80/20 theo thời gian). */
  dates: string[];
}

/** Tham số chuẩn hoá z-score học từ tập train. */
export interface FeatureNorm {
  mean: number[];
  std: number[];
}

/* ── P1-2 PIT (blueprint v1.3 §5 — phiên #60): window-hash SHA-256 + biên ngày
 * train — tái lập được "hồi đó dữ liệu thế nào" khi train lại cho ra số khác
 * (§9.1: PIT là rủi ro duy nhất làm nghiên cứu hồi tố SAI không phát hiện —
 * Bar upsert đè lịch sử giờ để lại dấu vết so hash). */

/** Meta PIT lưu MlModel.meta (JSON string) sau mỗi lần train. */
export interface TrainingWindowMeta {
  /** SHA-256 hex (64 ký tự) trên nội dung cửa sổ dữ liệu train — deterministic. */
  windowHash: string;
  /** Ngày phiên ĐẦU TIÊN dùng trong cửa sổ train. */
  trainDateFrom: string | null;
  /** Ngày phiên CUỐI CÙNG dùng trong cửa sổ train (biên trên — sau này PIT
   *  backtest biết hết hạn nhìn tới tương lai của window này). */
  trainDateTo: string | null;
  /** Số bar trong cửa sổ (per mã — digest tính trên chính các bar này). */
  bars: number;
  /** Số mẫu huấn luyện cuối (sau cap ML_MAX_SAMPLES). */
  samples: number;
  /** Rổ mã tham gia (train/serving cùng định nghĩa rổ — P0-2). */
  symbols: string[];
  horizonDays: number;
  featureCount: number;
  /** Thuật toán sinh hash (đổi cách hash → đổi version chuỗi này). */
  digestVersion: string;
}

/**
 * SHA-256 cửa sổ train: hash từng bar (symbol|date|close|volume) theo thứ tự
 * ổn định (symbol asc, date asc) — 2 lần train trên cùng dữ liệu cho cùng
 * hash; bar bị upsert đè (restate/PIT leak) → hash KHÁC → đối chiếu phát
 * hiện được. Kèm biên ngày from/to lấy từ chính các bar đó.
 */
export function trainingWindowDigest(
  series: SymbolSeries[],
  opts: { samples?: number; horizonDays?: number; featureCount?: number } = {}
): TrainingWindowMeta {
  const hash = createHash("sha256");
  let bars = 0;
  let from: string | null = null;
  let to: string | null = null;
  for (const s of [...series].sort((a, b) => (a.symbol < b.symbol ? -1 : 1))) {
    hash.update(`#${s.symbol}\n`);
    for (const b of s.bars) {
      const d = b.date.toISOString().slice(0, 10);
      hash.update(`${d}|${b.close}|${b.volume}\n`);
      bars++;
      if (from == null || d < from) from = d;
      if (to == null || d > to) to = d;
    }
  }
  return {
    windowHash: hash.digest("hex"),
    trainDateFrom: from,
    trainDateTo: to,
    bars,
    samples: opts.samples ?? 0,
    symbols: [...series].sort((a, b) => (a.symbol < b.symbol ? -1 : 1)).map((s) => s.symbol),
    horizonDays: opts.horizonDays ?? ML_HORIZON_DAYS,
    featureCount: opts.featureCount ?? ML_FEATURE_COUNT,
    digestVersion: "sha256-symbol-date-close-volume-v1",
  };
}

/** Chuỗi chỉ báo đã tính sẵn cho một mã (mảng cùng chiều closes, null khi warmup). */
interface RollingSeries {
  closes: number[];
  volumes: number[];
  ret1: (number | null)[];
  logret5: (number | null)[];
  logret10: (number | null)[];
  sma20: (number | null)[];
  sma50: (number | null)[];
  rsi14: (number | null)[];
  macdHist: (number | null)[];
  volz20: (number | null)[];
  std20ret: (number | null)[];
  max60: (number | null)[];
}

/** Dòng EOD tối thiểu để tính đặc trưng. */
interface BarRow {
  date: Date;
  close: number;
  volume: number;
}

/** Top-N mã thanh khoản (topByAdtv — P0-2) + chuỗi bar đầy đủ. */
export interface SymbolSeries {
  symbol: string;
  instrumentId: string;
  bars: BarRow[];
  closes: number[];
  volumes: number[];
}

/**
 * Nạp top-N mã isActive thanh khoản cao nhất kèm toàn bộ bar EOD (date asc).
 * P0-2 (phiên #57): xếp hạng qua `topByAdtv` — ADTV 45 PHIÊN EOD từ
 * `Bar.value` (giá trị giao dịch VND) — định nghĩa rổ DUY NHẤT của hệ thống,
 * thay thế ranking avg-volume cửa sổ 45 NGÀY LỊCH của fixbug #52-F6 (cùng
 * họ lỗi F6 nhưng đo "số cổ phiếu" thay "số tiền" — mã giá cao ít khối lượng
 * vẫn lọt top). Dùng chung cho buildTrainingSet (topN=20) · rổ Q-learning
 * (topN=10) · risk engine proxy (sinceDays ~500 phiên).
 * B5 (§3.4 MARKET_EXPANSION): khoá rổ ML về HOSE-STOCK — MLP/Q-learning
 * tiếp tục train trên chuỗi lịch sử sâu nhất; universe đa sàn KHÔNG làm
 * lệch thành phần rổ (train/serving phải cùng định nghĩa rổ).
 * Phiên #51 — CRB: options.sinceDays cắt cửa sổ bar theo ngày (risk engine
 * chỉ cần ~500 phiên cho CRB-6/8 — thay vì nạp full-history 30k dòng).
 */
export async function loadTopSeries(
  topN: number,
  options: { sinceDays?: number } = {}
): Promise<SymbolSeries[]> {
  const series = await loadTopDatedSeries(topN, {
    market: "HOSE",
    type: "STOCK",
    sinceDays: options.sinceDays,
  });
  return series.map((s) => ({
    symbol: s.symbol,
    instrumentId: s.instrumentId,
    bars: s.bars.map((b) => ({ date: b.date, close: b.close, volume: b.volume })),
    closes: s.bars.map((b) => b.close),
    volumes: s.bars.map((b) => b.volume),
  }));
}

/* ─────────────────── Rolling indicators O(N) ─────────────────── */

/**
 * FEATURECONTRACT (P0-3) — tính chuỗi chỉ báo tăng dần cho một mã: cùng
 * thuật toán chuẩn duy nhất (Wilder RSI, EMA MACD 12/26/9, SMA window-sum)
 * nhưng trả TOÀN chuỗi để lấy mẫu O(1). Trước đây `buildRolling` riêng tư —
 * giờ là điểm vào hợp đồng cho mọi consumer (evidence · S2 · A9 · MLP).
 */
export function rollingFeatures(
  closes: number[],
  volumes: number[]
): RollingSeries {
  return buildRolling(closes, volumes);
}

/** Trả lại tên cũ cho caller nội bộ (không đổi thuật toán). */
function buildRolling(closes: number[], volumes: number[]): RollingSeries {
  const n = closes.length;
  const ret1: (number | null)[] = new Array(n).fill(null);
  const logret5: (number | null)[] = new Array(n).fill(null);
  const logret10: (number | null)[] = new Array(n).fill(null);
  const sma20: (number | null)[] = new Array(n).fill(null);
  const sma50: (number | null)[] = new Array(n).fill(null);
  const rsi14: (number | null)[] = new Array(n).fill(null);
  const macdHist: (number | null)[] = new Array(n).fill(null);
  const volz20: (number | null)[] = new Array(n).fill(null);
  const std20ret: (number | null)[] = new Array(n).fill(null);
  const max60: (number | null)[] = new Array(n).fill(null);

  // log-return 1/5/10 phiên
  for (let i = 1; i < n; i++) ret1[i] = Math.log(closes[i] / closes[i - 1]);
  for (let i = 5; i < n; i++) logret5[i] = Math.log(closes[i] / closes[i - 5]);
  for (let i = 10; i < n; i++) logret10[i] = Math.log(closes[i] / closes[i - 10]);

  // SMA 20/50 — window sum trượt
  let s20 = 0;
  for (let i = 0; i < n; i++) {
    s20 += closes[i];
    if (i >= 20) s20 -= closes[i - 20];
    if (i >= 19) sma20[i] = s20 / 20;
  }
  let s50 = 0;
  for (let i = 0; i < n; i++) {
    s50 += closes[i];
    if (i >= 50) s50 -= closes[i - 50];
    if (i >= 49) sma50[i] = s50 / 50;
  }

  // RSI14 Wilder — seed trung bình 14 phiên đầu rồi làm mượt đệ quy
  if (n >= 15) {
    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= 14; i++) {
      const d = closes[i] - closes[i - 1];
      if (d > 0) gains += d;
      else losses -= d;
    }
    let avgGain = gains / 14;
    let avgLoss = losses / 14;
    for (let i = 14; i < n; i++) {
      if (i > 14) {
        const d = closes[i] - closes[i - 1];
        avgGain = (avgGain * 13 + Math.max(d, 0)) / 14;
        avgLoss = (avgLoss * 13 + Math.max(-d, 0)) / 14;
      }
      if (avgGain === 0 && avgLoss === 0) rsi14[i] = null; // chuỗi phẳng
      else if (avgLoss === 0) rsi14[i] = 100;
      else rsi14[i] = 100 - 100 / (1 + avgGain / avgLoss);
    }
  }

  // MACD histogram — EMA12/EMA26 trượt rồi signal = EMA9 của macd line
  if (n >= 26) {
    const k12 = 2 / 13;
    const k26 = 2 / 27;
    const k9 = 2 / 10;
    let e12 = 0;
    for (let i = 0; i < 12; i++) e12 += closes[i];
    e12 /= 12;
    let e26 = 0;
    for (let i = 0; i < 26; i++) e26 += closes[i];
    e26 /= 26;
    let signal = 0;
    let signalCount = 0;
    for (let i = 26; i < n; i++) {
      e12 = k12 * closes[i] + (1 - k12) * e12;
      e26 = k26 * closes[i] + (1 - k26) * e26;
      const line = e12 - e26;
      // seed signal = chính macd line đầu, sau đó EMA9
      if (signalCount === 0) {
        signal = line;
      } else {
        signal = k9 * line + (1 - k9) * signal;
      }
      signalCount++;
      if (signalCount >= 9) macdHist[i] = line - signal;
    }
  }

  // volz20 — z-score volume so TB/độ lệch 20 phiên
  if (n >= 20) {
    let vs = 0;
    let vs2 = 0;
    for (let i = 0; i < n; i++) {
      vs += volumes[i];
      vs2 += volumes[i] * volumes[i];
      if (i >= 20) {
        vs -= volumes[i - 20];
        vs2 -= volumes[i - 20] * volumes[i - 20];
      }
      if (i >= 19) {
        const mean = vs / 20;
        const varr = Math.max(0, vs2 / 20 - mean * mean);
        const sd = Math.sqrt(varr);
        volz20[i] = sd > 0 ? (volumes[i] - mean) / sd : 0;
      }
    }
  }

  // std20ret — độ lệch chuẩn log-ret1 trên 20 phiên (cần ret1[t-19..t])
  if (n >= 21) {
    for (let i = 20; i < n; i++) {
      let m = 0;
      for (let j = i - 19; j <= i; j++) m += ret1[j] ?? 0;
      m /= 20;
      let v = 0;
      for (let j = i - 19; j <= i; j++) {
        const r = ret1[j] ?? 0;
        v += (r - m) * (r - m);
      }
      std20ret[i] = Math.sqrt(v / 20);
    }
  }

  // max60 — đỉnh 60 phiên (quét cửa sổ — đủ nhanh với N ≈ 3k/mã)
  for (let i = 59; i < n; i++) {
    let hi = closes[i - 59];
    for (let j = i - 58; j <= i; j++) if (closes[j] > hi) hi = closes[j];
    max60[i] = hi;
  }

  return {
    closes, volumes, ret1, logret5, logret10, sma20, sma50,
    rsi14, macdHist, volz20, std20ret, max60,
  };
}

/** Clip z-score khối lượng ±8 (chung x[6] và Δvolz5 x[14]). */
function clip8(v: number): number {
  return Math.max(-8, Math.min(8, v));
}

/**
 * Vector 16 đặc trưng tại chỉ số t (đã qua warmup ≥ 60 phiên); null nếu
 * dữ liệu không đủ. Thứ tự cố định — mô hình serving phụ thuộc thứ tự này:
 * [0] rsi14/100          [1] macdHist/close    [2] logret5      [3] logret10
 * [4] sma20/sma50−1      [5] close/sma20−1     [6] volz20(clip ±8)
 * [7] std20(logret1)     [8] close/max60−1     [9] logret1
 * ——— B1 v2-lag16 (6 chiều mới, thuần quá khứ) ———
 * [10] r_lag1 = logret1(t−1)   [11] r_lag2 = logret1(t−2)   [12] r_lag3 = logret1(t−3)
 * [13] ΔRSI5   = (rsi14(t) − rsi14(t−5))/100   (quật đảo động lượng RSI)
 * [14] Δvolz5  = clip(volz20(t),±8) − clip(volz20(t−5),±8) (thay đổi tương đối KL)
 * [15] sma20slope = sma20(t)/sma20(t−5) − 1 (độ dốc đường trung bình)
 * 10 chiều đầu giữ NGUYÊN công thức v1 — bản v8-lag10 serving đọc đúng
 * x[0..9] của vector này (tương thích ngược khi hoán đổi theo cổng B2).
 */
// A3 (phiên #79): export cho ml/psi.ts đo drift — tái dùng CÙNG featureAt của
// train (FeatureContract P0-3 — không đường tính đặc trưng thứ 2).
export function featureAt(r: RollingSeries, t: number): number[] | null {
  if (t < ML_WARMUP_BARS - 1 || t >= r.closes.length) return null;
  const close = r.closes[t];
  const sma20 = r.sma20[t];
  const sma50 = r.sma50[t];
  if (sma20 == null || sma50 == null || sma20 <= 0 || sma50 <= 0) return null;
  const max60 = r.max60[t];
  if (max60 == null || max60 <= 0) return null;
  const rsi = r.rsi14[t];
  const hist = r.macdHist[t];
  // B1 — 6 đặc trưng lag v2 (t ≥ 59 ⇒ t−5 ≥ 54: mọi chuỗi con đã qua warmup;
  // nhánh t < 5 chỉ là belt-and-braces cho caller gọi tay với t nhỏ hơn)
  const rsiPrev5 = t >= 5 ? r.rsi14[t - 5] : null;
  const volzPrev5 = t >= 5 ? r.volz20[t - 5] : null;
  const sma20Prev5 = t >= 5 ? r.sma20[t - 5] : null;
  return [
    (rsi ?? 50) / 100, // RSI phẳng → trung tính 0,5
    hist != null ? hist / close : 0,
    r.logret5[t] ?? 0,
    r.logret10[t] ?? 0,
    sma20 / sma50 - 1,
    close / sma20 - 1,
    clip8(r.volz20[t] ?? 0), // clip đuôi dài z-score KL
    r.std20ret[t] ?? 0,
    close / max60 - 1,
    r.ret1[t] ?? 0,
    // ── B1 v2-lag16 ──
    t >= 1 ? (r.ret1[t - 1] ?? 0) : 0,
    t >= 2 ? (r.ret1[t - 2] ?? 0) : 0,
    t >= 3 ? (r.ret1[t - 3] ?? 0) : 0,
    ((rsi ?? 50) - (rsiPrev5 ?? 50)) / 100, // ΔRSI5 — cùng scale 0..1 với x[0]
    clip8(r.volz20[t] ?? 0) - clip8(volzPrev5 ?? 0), // Δvolz5 — biên ±16 tự nhiên
    sma20Prev5 != null && sma20Prev5 > 0 ? sma20 / sma20Prev5 - 1 : 0,
  ];
}

/** Nhãn hướng 5 phiên tới: 0=DOWN · 1=FLAT · 2=UP. */
function labelAt(r: RollingSeries, t: number): number | null {
  const future = t + ML_HORIZON_DAYS;
  if (future >= r.closes.length) return null;
  const ret = r.closes[future] / r.closes[t] - 1;
  if (ret > ML_LABEL_THRESHOLD) return 2;
  if (ret < -ML_LABEL_THRESHOLD) return 0;
  return 1;
}

/**
 * Xây tập huấn luyện trên top-N mã thanh khoản: mọi phiên t đủ 60 phiên
 * lịch sử + t+5 tồn tại → (x, y). Sắp xếp THEO NGÀY tăng dần (stable) để
 * cut 80/20 theo thời gian đúng nghĩa — val là block ngày MỚI NHẤT. Cap
 * ML_MAX_SAMPLES mẫu gần nhất nếu vượt.
 */
/** Kết quả buildTrainingSet — kèm CHÍNH chuỗi dữ liệu vừa dùng (F-611-01/#61). */
export interface TrainingSetWithSeries extends TrainingSet {
  /** Chuỗi dữ liệu đã build tập train — digest PIT (P1-2) PHẢI hash trên
   * chuỗi NÀY (trước đây route load LẦN THỨ HAI độc lập → bar đổi giữa 2 lượt
   * nạp làm window-hash sai sự thật của cửa sổ đã train). */
  series: SymbolSeries[];
}

export async function buildTrainingSet(topN = 20): Promise<TrainingSetWithSeries> {
  const series = await loadTopSeries(topN);
  const xs: number[][] = [];
  const ys: number[] = [];
  const syms: string[] = [];
  const dts: string[] = [];

  for (const s of series) {
    if (s.closes.length < ML_WARMUP_BARS + ML_HORIZON_DAYS) continue;
    const roll = buildRolling(s.closes, s.volumes);
    for (let t = ML_WARMUP_BARS - 1; t < s.closes.length; t++) {
      const x = featureAt(roll, t);
      const y = labelAt(roll, t);
      if (x == null || y == null) continue;
      xs.push(x);
      ys.push(y);
      syms.push(s.symbol);
      dts.push(s.bars[t].date.toISOString().slice(0, 10));
    }
  }

  // Sort theo ngày (stable) — đảm bảo split 80/20 theo THỜI GIAN đúng
  const order = xs.map((_, i) => i).sort((a, b) => (dts[a] < dts[b] ? -1 : dts[a] > dts[b] ? 1 : 0));
  const take = Math.min(order.length, ML_MAX_SAMPLES);
  const keep = order.slice(order.length - take);
  return {
    X: keep.map((i) => xs[i]),
    y: keep.map((i) => ys[i]),
    symbols: keep.map((i) => syms[i]),
    dates: keep.map((i) => dts[i]),
    series, // F-611-01/#61 — digest phải hash CHÍNH chuỗi này
  };
}

/* ─────────────── B3 · Chuỗi đặc trưng cho GRU (ML_OPS_BLUEPRINT §4 B3) ─────────────── */

/** Tập huấn luyện CHUỖI cho GRU: mỗi mẫu = cửa sổ W phiên × 16 đặc trưng
 *  (t−W+1..t) + nhãn hướng 5 phiên tới tại t. Lấy mẫu từ t ≥ warmup+W−1
 *  (mọi bước u của cửa sổ đều hợp lệ featureAt — F-B811-02: trước đây t
 *  khởi đầu ở warmup−1 khiến 19 phiên đầu bị featureAt trả null, mẫu bị
 *  bỏ âm thầm). Là SUBSET của buildTrainingSet (thiếu W−1 mẫu đầu mỗi mã) —
 *  GRU tự cắt 80/20 riêng theo thời gian, không đòi khớp mẫu 1-1 với MLP. */
export interface SequenceTrainingSet {
  /** [n][window][16] — chuỗi đặc trưng RAW (chuẩn hoá z-score do GRU tự nắm). */
  X: number[][][];
  y: number[];
  symbols: string[];
  dates: string[];
  series: SymbolSeries[];
}

/** Số phiên trong cửa sổ chuỗi GRU (B3: window 20). */
export const ML_GRU_WINDOW = 20;

/**
 * Xây tập chuỗi trên top-N mã: mirror buildTrainingSet về điều kiện nhãn +
 *  sort theo ngày + cap ML_MAX_SAMPLES; khác ở shape (cửa sổ W×16 thay vì
 *  vector 16) và điểm bắt đầu (t ≥ ML_WARMUP_BARS−1+windowSize−1 — F-B811-02).
 */
export async function buildTrainingSequences(
  topN = 20,
  windowSize = ML_GRU_WINDOW
): Promise<SequenceTrainingSet> {
  const series = await loadTopSeries(topN);
  const xs: number[][][] = [];
  const ys: number[] = [];
  const syms: string[] = [];
  const dts: string[] = [];

  const tStart = ML_WARMUP_BARS - 1 + (windowSize - 1); // F-B811-02 — mọi bước u = t−W+1..t đều ≥ warmup−1
  for (const s of series) {
    if (s.closes.length < tStart + 1 + ML_HORIZON_DAYS) continue;
    const roll = buildRolling(s.closes, s.volumes);
    for (let t = tStart; t < s.closes.length; t++) {
      const y = labelAt(roll, t);
      if (y == null) continue;
      // Cửa sổ t−W+1..t: featureAt từng bước (u ≥ warmup−1 ⇒ không null)
      const win: number[][] = [];
      for (let u = t - windowSize + 1; u <= t; u++) {
        const x = featureAt(roll, u);
        if (x == null) {
          win.length = 0;
          break;
        }
        win.push(x);
      }
      if (win.length !== windowSize) continue;
      xs.push(win);
      ys.push(y);
      syms.push(s.symbol);
      dts.push(s.bars[t].date.toISOString().slice(0, 10));
    }
  }

  const order = xs.map((_, i) => i).sort((a, b) => (dts[a] < dts[b] ? -1 : dts[a] > dts[b] ? 1 : 0));
  const take = Math.min(order.length, ML_MAX_SAMPLES);
  const keep = order.slice(order.length - take);
  return {
    X: keep.map((i) => xs[i]),
    y: keep.map((i) => ys[i]),
    symbols: keep.map((i) => syms[i]),
    dates: keep.map((i) => dts[i]),
    series,
  };
}

/**
 * Cửa sổ W phiên × 16 đặc trưng PHIÊN CUỐI của từng mã top-10 (serving GRU —
 * mirror latestFeatures nhưng trả chuỗi thay vì vector đơn). Chỉ nạp đủ
 * warmup + W phiên/mã — nhẹ như latestFeatures.
 */
export async function latestFeatureWindows(
  windowSize = ML_GRU_WINDOW
): Promise<{ symbol: string; x: number[][] }[]> {
  const ranked = await topByAdtv(10, { market: "HOSE", type: "STOCK" });
  const need = ML_WARMUP_BARS + windowSize - 1;

  const barLists = await Promise.all(
    ranked.map((t) =>
      db.bar
        .findMany({
          where: { instrumentId: t.id },
          orderBy: { date: "desc" },
          take: need,
          select: { close: true, volume: true },
        })
        .then((rows) => rows.filter((b) => b.close > 0).reverse())
    )
  );

  const out: { symbol: string; x: number[][] }[] = [];
  ranked.forEach((t, i) => {
    const rows = barLists[i];
    if (rows.length < need) return;
    const roll = buildRolling(
      rows.map((b) => b.close),
      rows.map((b) => b.volume)
    );
    const t0 = rows.length - windowSize;
    const win: number[][] = [];
    for (let u = t0; u < rows.length; u++) {
      const x = featureAt(roll, u);
      if (x == null) return; // thiếu 1 bước → bỏ mã (fail-soft)
      win.push(x);
    }
    out.push({ symbol: t.symbol, x: win });
  });
  return out;
}

/* ─────────────── FEATURECONTRACT · snapshot phiên cuối (P0-3) ─────────────── */

/** Bộ giá trị PHIÊN CUỐI qua hợp đồng — một định nghĩa cho mọi consumer. */
export interface FeatureSnapshot {
  /** Số phiên EOD có dữ liệu (sau khi bỏ bar close ≤ 0). */
  sessions: number;
  /** Đủ warmup 60 phiên (ML_WARMUP_BARS). */
  warmup: boolean;
  sma20: number | null;
  sma50: number | null;
  /** RSI14 Wilder — cùng thuật toán với MLP (identical khi cùng chuỗi). */
  rsi14: number | null;
  /** MACD histogram (EMA12−EMA26 − signal EMA9) — đơn vị giá. */
  macdHist: number | null;
  /** Động lượng 5 phiên (%): (close_n/close_{n−5} − 1)×100. */
  mom5Pct: number | null;
  /** KL/TL20: khối lượng bar cuối / TB 20 phiên TRƯỚC nó (không tính chính nó). */
  volRatio20: number | null;
  /** Đủ 6 nhóm đặc trưng (readiness S2 · A9). */
  ready: boolean;
}

/** Tính snapshot PHIÊN CUỐI từ chuỗi closes/volumes (đã tăng dần theo ngày). */
export function latestFeatureSnapshot(
  closes: number[],
  volumes: number[]
): FeatureSnapshot | null {
  const n = closes.length;
  if (n === 0) return null;
  const roll = buildRolling(closes, volumes);
  const t = n - 1;
  const sma20 = roll.sma20[t] ?? null;
  const sma50 = roll.sma50[t] ?? null;
  const rsi14 = roll.rsi14[t] ?? null;
  const macdHist = roll.macdHist[t] ?? null;
  const mom5Pct =
    n >= 6 && closes[n - 6] > 0 ? (closes[n - 1] / closes[n - 6] - 1) * 100 : null;
  // KL/TL20 = volume cuối / mean(20 phiên trước nó) — cùng semantics
  // indicators.latestVsMean(volumes, 20) cũ (không đếm phiên đang so)
  let volRatio20: number | null = null;
  if (n >= 21) {
    let s = 0;
    for (let i = n - 21; i < n - 1; i++) s += volumes[i];
    const mean = s / 20;
    if (mean > 0) volRatio20 = volumes[n - 1] / mean;
  }
  const warmup = n >= ML_WARMUP_BARS;
  return {
    sessions: n,
    warmup,
    sma20,
    sma50,
    rsi14,
    macdHist,
    mom5Pct,
    volRatio20,
    ready:
      warmup &&
      sma20 != null &&
      sma50 != null &&
      rsi14 != null &&
      macdHist != null &&
      mom5Pct != null &&
      volRatio20 != null,
  };
}

/**
 * Đặc trưng phiên CUỐI của từng mã top-10 (chỉ nạp 60 bar/mã — nhẹ,
 * dùng cho serving predict). Trả [{symbol, x}] theo thứ tự thanh khoản.
 * P0-2 (phiên #57): rổ xếp qua topByAdtv (ADTV 45 phiên từ Bar.value) —
 * thay quote-volume ranking (lớp bug F6 còn sót ở đây); mã không có quote
 * vẫn vào rổ nếu đủ bar (feature tính từ bar, không cần quote).
 * B5: cùng rổ HOSE-STOCK như lúc train (loadTopSeries) — KHÔNG trộn
 * index/ETF/HNX vào feature serving (drift mô hình).
 */
export async function latestFeatures(): Promise<{ symbol: string; x: number[] }[]> {
  const ranked = await topByAdtv(10, { market: "HOSE", type: "STOCK" });

  const barLists = await Promise.all(
    ranked.map((t) =>
      db.bar
        .findMany({
          where: { instrumentId: t.id },
          orderBy: { date: "desc" },
          take: ML_WARMUP_BARS,
          select: { close: true, volume: true },
        })
        .then((rows) => rows.filter((b) => b.close > 0).reverse())
    )
  );

  const out: { symbol: string; x: number[] }[] = [];
  ranked.forEach((t, i) => {
    const rows = barLists[i];
    if (rows.length < ML_WARMUP_BARS) return;
    const roll = buildRolling(
      rows.map((b) => b.close),
      rows.map((b) => b.volume)
    );
    const x = featureAt(roll, rows.length - 1);
    if (x != null) out.push({ symbol: t.symbol, x });
  });
  return out;
}

/* ─────────────────── B5 · Segment baskets (§3.4) ─────────────────── */

/** 5 phân đoạn thị trường VN (INTERNATIONAL thêm ở B13). */
export const SEGMENT_KEYS = [
  "VN-HOSE-STOCK",
  "VN-HNX-STOCK",
  "VN-UPCOM-STOCK",
  "VN-ETF",
  "VN-INDEX",
] as const;
export type SegmentKey = (typeof SEGMENT_KEYS)[number];

/** Một mã trong rổ segment — kèm chuỗi closes/volumes đã cắt theo cửa sổ. */
export interface SegmentSymbol {
  symbol: string;
  instrumentId: string;
  name: string;
  sector: string;
  market: string;
  type: string;
  closes: number[];
  volumes: number[];
  last: number;
  changePct: number;
  /** ADTV 20 phiên (VND = close × volume) — 0 khi không đủ 20 phiên. */
  adtvVnd: number;
}

/** Rổ một phân đoạn theo §3.4 MARKET_EXPANSION_BLUEPRINT. */
export interface SegmentBasket {
  segment: SegmentKey;
  /** Nhãn tiếng Việt. */
  label: string;
  /** Rổ bằng chứng (top-ADTV slice theo §3.4; INDEX = cố định 4 mã). */
  symbols: SegmentSymbol[];
  /** Toàn bộ mã có quote của segment — breadth + số liệu nền dùng cái này. */
  quoted: SegmentSymbol[];
  /** Σ ADTV 20 phiên của rổ (VND) — trọng số composite; INDEX = null (0,05/index). */
  adtvVnd: number | null;
}

/** Chỉ số đứng trong rổ VN-INDEX (§3.4: VNINDEX + VN30 (+ HNX, UPCOM)). */
const INDEX_BASKET_SYMBOLS = ["VNINDEX", "VN30", "HNX", "UPCOM"];

/**
 * Nạp rổ 5 phân đoạn VN trong 2 QUERY (instruments+quotes · bars≥cutoff) rồi
 * phân đoạn IN-MEMORY — pattern B5: load MỘT LẦN, không chạy 7 vòng query
 * full bar-history (áp lực DB + ngân sách chu kỳ 180s).
 */
export async function loadSegmentBaskets(barsPerSymbol = 260): Promise<SegmentBasket[]> {
  const instruments = await db.instrument.findMany({
    where: { isActive: true, market: { in: ["HOSE", "HNX", "UPCOM"] } },
    select: {
      id: true,
      symbol: true,
      name: true,
      market: true,
      type: true,
      sector: true,
      quotes: {
        orderBy: { tradedAt: "desc" },
        take: 1,
        select: { last: true, changePct: true },
      },
    },
  });
  const quotedBase = instruments
    .map((i) => {
      const q = i.quotes[0];
      if (!q || !(q.last > 0)) return null;
      return {
        id: i.id,
        symbol: i.symbol,
        name: i.name,
        market: i.market,
        type: i.type,
        sector: i.sector ?? "Khác",
        last: q.last,
        changePct: q.changePct,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  if (quotedBase.length === 0) return [];

  // Query bar DUY NHẤT cho toàn bộ quoted (≈ 76 mã × ≤280 phiên ≈ 21k dòng)
  const cutoff = new Date(Date.now() - 420 * 86_400_000); // ~260 phiên GD ≈ 420 ngày
  const barRows = await db.bar.findMany({
    where: { instrumentId: { in: quotedBase.map((q) => q.id) }, date: { gte: cutoff } },
    orderBy: [{ instrumentId: "asc" }, { date: "asc" }],
    select: { instrumentId: true, close: true, volume: true },
  });
  const seriesById = new Map<string, { closes: number[]; volumes: number[] }>();
  for (const b of barRows) {
    if (!(b.close > 0)) continue;
    let entry = seriesById.get(b.instrumentId);
    if (!entry) {
      entry = { closes: [], volumes: [] };
      seriesById.set(b.instrumentId, entry);
    }
    entry.closes.push(b.close);
    entry.volumes.push(b.volume);
  }

  const symbols: SegmentSymbol[] = quotedBase.map((q) => {
    const s = seriesById.get(q.id) ?? { closes: [], volumes: [] };
    const closes = s.closes.slice(-barsPerSymbol);
    const volumes = s.volumes.slice(-barsPerSymbol);
    const tail = closes.slice(-20);
    const vols = volumes.slice(-20);
    let adtvVnd = 0;
    if (tail.length === 20) {
      let sum = 0;
      for (let i = 0; i < 20; i++) sum += tail[i] * vols[i];
      adtvVnd = sum / 20;
    }
    return {
      symbol: q.symbol,
      instrumentId: q.id,
      name: q.name,
      sector: q.sector,
      market: q.market,
      type: q.type,
      closes,
      volumes,
      last: q.last,
      changePct: q.changePct,
      adtvVnd,
    };
  });

  const hoseStock = symbols.filter((s) => s.market === "HOSE" && s.type === "STOCK");
  const hnxStock = symbols.filter((s) => s.market === "HNX" && s.type === "STOCK");
  const upcomStock = symbols.filter((s) => s.market === "UPCOM" && s.type === "STOCK");
  const etfs = symbols.filter((s) => s.type === "ETF");
  const indexes = symbols.filter(
    (s) => s.type === "INDEX" && INDEX_BASKET_SYMBOLS.includes(s.symbol)
  );

  const byAdtv = (arr: SegmentSymbol[]) => [...arr].sort((a, b) => b.adtvVnd - a.adtvVnd);
  const sumAdtv = (arr: SegmentSymbol[]) =>
    arr.reduce((s, x) => s + x.adtvVnd, 0);

  const hoseBasket = byAdtv(hoseStock).slice(0, 10);
  const hnxBasket = byAdtv(hnxStock).slice(0, 5);
  const upcomBasket = byAdtv(upcomStock).slice(0, 3);
  const etfBasket = byAdtv(etfs).slice(0, 10);

  return [
    {
      segment: "VN-HOSE-STOCK",
      label: "Cổ phiếu HOSE (top-10 thanh khoản)",
      symbols: hoseBasket,
      quoted: hoseStock,
      adtvVnd: sumAdtv(hoseBasket),
    },
    {
      segment: "VN-HNX-STOCK",
      label: "Cổ phiếu HNX (top-5 thanh khoản)",
      symbols: hnxBasket,
      quoted: hnxStock,
      adtvVnd: sumAdtv(hnxBasket),
    },
    {
      segment: "VN-UPCOM-STOCK",
      label: "Cổ phiếu UPCOM (top-3 thanh khoản)",
      symbols: upcomBasket,
      quoted: upcomStock,
      adtvVnd: sumAdtv(upcomBasket),
    },
    {
      segment: "VN-ETF",
      label: "ETF niêm yết (≤10 mã)",
      symbols: etfBasket,
      quoted: etfs,
      adtvVnd: sumAdtv(etfBasket),
    },
    {
      segment: "VN-INDEX",
      label: "Chỉ số VN (VNINDEX · VN30 · HNX · UPCOM)",
      symbols: indexes,
      quoted: indexes,
      adtvVnd: null, // §3.4: INDEX không có ADTV VND → trọng số cố định 0,05/index
    },
  ];
}

/**
 * Chuẩn hoá z-score theo cột (fit trên tập train): mean/std từng đặc trưng,
 * std = 0 → 1 (cột hằng). Trả mean/std (lưu featureNorm) + ma trận chuẩn hoá.
 */
export function standardize(X: number[][]): { mean: number[]; std: number[]; Xstd: number[][] } {
  const n = X.length;
  const d = n > 0 ? X[0].length : 0;
  const mean = new Array<number>(d).fill(0);
  const std = new Array<number>(d).fill(1);
  if (n === 0) return { mean, std, Xstd: [] };
  for (const row of X) for (let j = 0; j < d; j++) mean[j] += row[j];
  for (let j = 0; j < d; j++) mean[j] /= n;
  for (let j = 0; j < d; j++) {
    let v = 0;
    for (const row of X) v += (row[j] - mean[j]) * (row[j] - mean[j]);
    v /= n;
    std[j] = v > 0 ? Math.sqrt(v) : 1;
  }
  const Xstd = X.map((row) => row.map((v, j) => (v - mean[j]) / std[j]));
  return { mean, std, Xstd };
}

/** Áp norm z-score đã học cho 1 vector đặc trưng (serving). */
export function applyNorm(x: number[], mean: number[], std: number[]): number[] {
  return x.map((v, j) => (v - (mean[j] ?? 0)) / ((std[j] ?? 1) || 1));
}
