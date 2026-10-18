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
// F-04 (#129): chuỗi sentiment hằng ngày — chiều x[23] của v3-macro (F-01)
// (phần DB tách sang sentiment-daily.ts — sentiment.ts giữ thuần client-safe).
import { dailySentimentScores, weightedSentiment7 } from "@/lib/quant/sentiment-daily";
// P1-2 PIT — SHA-256 window-hash của cửa sổ train (node:crypto, backend only)
import { createHash } from "node:crypto";

/** Số đặc trưng đầu vào của MLP (thay đổi phải đổi cả kiến trúc mạng).
 *  B1 (#81 — ML_OPS_BLUEPRINT §4): 10 → 16 (v2-lag16).
 *  F-01 (#129 — AI_ENGINEER_REVIEW_BRAIN §3): 16 → 24 (v3-macro) — 8 chiều
 *  vĩ mô/định lượng căn chỉnh point-in-time (alignMacroBefore N4). */
export const ML_FEATURE_COUNT = 16;
/** Nhãn bộ đặc trưng hiện hành — lưu MlModel.meta.featureSet khi train
 *  (B1: bản v8 cũ không có trường này → đọc về "v1-lag10"). */
export const ML_FEATURE_SET = "v2-lag16";
/** F-01 (#129): bộ v3-macro — 16 chiều giá + 8 chiều vĩ mô (x[16]–x[23]).
 *  Chỉ vào serving khi thắng sweep (cổng championGate — N3). */
export const ML_FEATURE_SET_V3 = "v3-macro";
/** F-01 (#129): số chiều của v3-macro. */
export const ML_FEATURE_COUNT_V3 = 24;
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
export function featureAt(
  r: RollingSeries,
  t: number,
  macro?: MacroContext | null
): number[] | null {
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
  const v16 = [
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
  // F-01 (#129): không có macro → vector 16 cũ NGUYÊN VẸN (tương thích ngược
  // cho serving v8 + mọi caller hiện có — bit-flip test F-01 nghiệm thu 1).
  if (macro == null) return v16;
  // 8 chiều vĩ mô — thiếu chuỗi thì chiều = 0 (trung tính, không bỏ mẫu — N2).
  return [
    ...v16,
    macro.dus10y20, // x[16] cb
    macro.slope10y5y, // x[17] cb
    macro.dxyMom20, // x[18] ratio
    macro.vndMom20, // x[19] ratio
    macro.cmdtyMom20, // x[20] ratio trung bình GC/CL/BZ
    macro.breadth20, // x[21] 0..1
    clip3(macro.flow20), // x[22] clip ±3 theo đặc tả F-03
    macro.sent7, // x[23] −1..+1
  ];
}

/** F-01 (#129) — clip flow ±3 (đặc tả F-03 mục 3). */
function clip3(v: number): number {
  return Math.max(-3, Math.min(3, v));
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
  /** F-01 (#129): featureSet thực tế đã build ("v2-lag16" | "v3-macro"). */
  featureSet: "v2-lag16" | "v3-macro";
  /** F-11 (#129): true nếu rổ chọn point-in-time (chống bias sống sót). */
  pointInTime: boolean;
  /** F-09 (#129): nhãn giàu (hướng + biên độ + biến động) — chỉ khi
   * opts.richLabels; cùng thứ tự X/y (caller multitask dùng). */
  rich?: RichLabel[];
}

/** F-01/F-11 (#129) — tuỳ chọn build tập train. */
export interface BuildTrainingOpts {
  /** v3-macro → 24 chiều (8 chiều vĩ mô); mặc định v2-lag16 (16 chiều). */
  featureSet?: "v2-lag16" | "v3-macro";
  /** F-11: rổ top-N chọn theo thanh khoản TẠI THỜI ĐIỂM lấy mẫu (weekly basket)
   * thay vì topByAdtv hiện tại — chống bias sống sót (đặc tả P1-6). */
  pointInTime?: boolean;
  /** F-09 (#129): kèm nhãn giàu (dir/mag/vol) cho task multitask. */
  richLabels?: boolean;
}

export async function buildTrainingSet(
  topN = 20,
  opts: BuildTrainingOpts = {}
): Promise<TrainingSetWithSeries> {
  const featureSet = opts.featureSet === ML_FEATURE_SET_V3 ? ML_FEATURE_SET_V3 : "v2-lag16";
  // F-11 (#129): đường PIT — rổ theo tuần (pointInTimeBaskets), chuỗi nạp cho
  // union toàn bộ rổ từng xuất hiện; mẫu chỉ giữ khi mã ∈ rổ của tuần đó.
  const series = opts.pointInTime
    ? await loadPitUnionSeries(topN)
    : await loadTopSeries(topN);
  const pitBaskets = opts.pointInTime ? await weeklyPitBaskets(topN) : null;
  const xs: number[][] = [];
  const ys: number[] = [];
  const syms: string[] = [];
  const dts: string[] = [];
  const rich: RichLabel[] = []; // F-09 (#129)

  // F-01 (#129): v3-macro — nạp MacroContext cho MỌI ngày lấy mẫu (1 truy
  // vấn breadth + 1 truy vấn bar vĩ mô + flow + sentiment, cache 10 phút).
  let macroByDate: Map<string, MacroContext> | null = null;
  if (featureSet === ML_FEATURE_SET_V3) {
    // Ngày lấy mẫu chưa biết trước (tuỳ rổ/warmup) — nạp cho TOÀN BỘ ngày
    // phiên HOSE (distinct) bằng breadth cache làm mốcchuẩn rồi lọc trong
    // vòng lặp: dùng breadthMap keys (đã có sẵn từ loader) làm nguồn ngày.
    macroByDate = null; // sẽ lazy-nạp bên dưới khi biết ngày đầu tiên
  }

  for (const s of series) {
    if (s.closes.length < ML_WARMUP_BARS + ML_HORIZON_DAYS) continue;
    const roll = buildRolling(s.closes, s.volumes);
    for (let t = ML_WARMUP_BARS - 1; t < s.closes.length; t++) {
      const dateStr = s.bars[t].date.toISOString().slice(0, 10);
      // F-11: lọc rổ PIT theo tuần của ngày lấy mẫu
      if (pitBaskets != null && !pitBaskets.inBasket(dateStr, s.instrumentId)) continue;
      // F-01: lazy nạp macro contexts một lần khi có ngày đầu tiên
      if (macroByDate === null && featureSet === ML_FEATURE_SET_V3) {
        const allDates = await hoseSessionDates(); // distinct Bar.date HOSE-STOCK
        macroByDate = await loadMacroContexts(allDates);
      }
      const macro =
        featureSet === ML_FEATURE_SET_V3 ? (macroByDate?.get(dateStr) ?? null) : undefined;
      const x = featureSet === ML_FEATURE_SET_V3 ? featureAt(roll, t, macro ?? undefined) : featureAt(roll, t);
      const y = labelAt(roll, t);
      if (x == null || y == null) continue;
      xs.push(x);
      ys.push(y);
      syms.push(s.symbol);
      dts.push(dateStr);
      if (opts.richLabels) {
        const rl = labelRichAt(roll, t);
        if (rl != null) rich.push(rl);
      }
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
    featureSet, // F-01 (#129)
    pointInTime: opts.pointInTime === true, // F-11 (#129)
    ...(opts.richLabels && rich.length === keep.length ? { rich: keep.map((i) => rich[i]!) } : {}),
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
 * F-01 (#129): `dims=24` → vector 24 chiều v3-macro (8 chiều vĩ mô phiên
 * cuối từ latestMacroContext — cache 10 phút, chỉ 1 lần breadth SQL);
 * mặc định 16 chiều như cũ (tương thích ngược 100%).
 */
export async function latestFeatures(
  dims: 16 | 24 = 16
): Promise<{ symbol: string; x: number[] }[]> {
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

  // F-01: macro context phiên cuối — 1 lần cho cả rổ (fail-soft → trung tính).
  let macroCtx: MacroContext | null = null;
  if (dims === 24) {
    macroCtx = await latestMacroContext().catch(() => null);
    if (macroCtx == null) {
      macroCtx = { dus10y20: 0, slope10y5y: 0, dxyMom20: 0, vndMom20: 0, cmdtyMom20: 0, breadth20: 0.5, flow20: 0, sent7: 0, missing: 8 };
    }
  }

  const out: { symbol: string; x: number[] }[] = [];
  ranked.forEach((t, i) => {
    const rows = barLists[i];
    if (rows.length < ML_WARMUP_BARS) return;
    const roll = buildRolling(
      rows.map((b) => b.close),
      rows.map((b) => b.volume)
    );
    const x = featureAt(roll, rows.length - 1, dims === 24 ? macroCtx : undefined);
    if (x != null && x.length === dims) out.push({ symbol: t.symbol, x });
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
 * Chuẩn hoá z-score theo cột: mean/std từng đặc trưng, std = 0 → 1 (cột
 * hằng). Trả mean/std (lưu featureNorm) + ma trận chuẩn hoá.
 *
 * AUDIT 137 B1 — opts.nTrain = số dòng ĐẦU (train split theo thời gian) dùng
 * tính mean/std; PHẦN CÒN LẠI vẫn được transform nhưng KHÔNG đóng góp thống kê
 * (chặn leakage block val tương lai vào phép biến đổi của train + vào chính
 * val khi được chấm). Không truyền nTrain = toàn chuỗi — giữ tương thích
 * call-site cũ đã TỰ CẮT Xtr train-only (src/lib/risk/forecast.ts).
 * KHỚP cut của nn.ts fit(): nTrain = Math.floor(n * (1 - valFraction)) —
 * caller truyền đúng valFraction mà fit sẽ dùng.
 */
export function standardize(
  X: number[][],
  opts?: { nTrain?: number }
): { mean: number[]; std: number[]; Xstd: number[][] } {
  const n = X.length;
  const d = n > 0 ? X[0].length : 0;
  const mean = new Array<number>(d).fill(0);
  const std = new Array<number>(d).fill(1);
  if (n === 0) return { mean, std, Xstd: [] };
  // AUDIT 137 B1 — clamp phòng thủ: nTrain ≤ 0 hoặc > n → tính trên toàn chuỗi
  // (hành vi cũ, không crash call-site lỗi).
  const nStats = opts?.nTrain != null && opts.nTrain > 0 && opts.nTrain < n ? opts.nTrain : n;
  for (let i = 0; i < nStats; i++) for (let j = 0; j < d; j++) mean[j] += X[i][j];
  for (let j = 0; j < d; j++) mean[j] /= nStats;
  for (let j = 0; j < d; j++) {
    let v = 0;
    for (let i = 0; i < nStats; i++) {
      const dv = X[i][j] - mean[j];
      v += dv * dv;
    }
    v /= nStats;
    std[j] = v > 0 ? Math.sqrt(v) : 1;
  }
  const Xstd = X.map((row) => row.map((v, j) => (v - mean[j]) / std[j]));
  return { mean, std, Xstd };
}

/** Áp norm z-score đã học cho 1 vector đặc trưng (serving). */
export function applyNorm(x: number[], mean: number[], std: number[]): number[] {
  return x.map((v, j) => (v - (mean[j] ?? 0)) / ((std[j] ?? 1) || 1));
}

/* ═══════════════════════════════════════════════════════════════════
 * F-01 (#129 — AI_ENGINEER_REVIEW_BRAIN §3 F-01) · MACRO CONTEXT LOADER
 * 8 chiều vĩ mô/định lượng cho feature set v3-macro (x[16]–x[23]) — mọi
 * chiều căn chỉnh point-in-time (N4): bar quốc tế dùng "bar cuối có
 * date < phiên VN t" (US đóng 04:00 ICT sáng nay → luôn "đã biết" khi VN
 * mở cửa 09:00); breadth/flow/sentiment dùng chính ngày t. Thiếu chuỗi →
 * chiều = 0 (trung tính) + đếm missing — KHÔNG bỏ mẫu, KHÔNG bịa (N2).
 * ═══════════════════════════════════════════════════════════════════ */

/** 8 chiều vĩ mô đã căn chỉnh cho MỘT phiên VN (key = "YYYY-MM-DD"). */
export interface MacroContext {
  /** Δ lợi suất US10Y 20 phiên (cb — Bar BOND_PCT×100 → /100). */
  dus10y20: number;
  /** Độ dốc đường cong 10Y−5Y (cb; âm/nghịch = lo ngại tăng trưởng). */
  slope10y5y: number;
  /** Động lượng đô la DXY 20 phiên (ratio). */
  dxyMom20: number;
  /** Sức ép tỷ giá VND=X 20 phiên (mất giá = dương). */
  vndMom20: number;
  /** Chu kỳ hàng hoá: trung bình MOM20 của GC=F/CL=F/BZ=F (ratio). */
  cmdtyMom20: number;
  /** Độ rộng thị trường: tỷ lệ mã HOSE có close > SMA20 (0..1). */
  breadth20: number;
  /** Dòng khối ngoại chuẩn hoá: Σ netValue(20p)/Σ ADTV(20p) — F-03. */
  flow20: number;
  /** Điểm sentiment lexicon 7 ngày (−1..+1) — F-04. */
  sent7: number;
  /** Số chiều vĩ mô thiếu dữ liệu tại phiên này (0..8) — trung thực N6. */
  missing: number;
}

/** Chuỗi bar 1 instrument vĩ mô (date string "YYYY-MM-DD" asc + close). */
interface MacroBarSeries {
  dates: string[];
  closes: number[];
}

/** Symbol vĩ mô phục vụ 8 chiều (14 instrument #126 — chỉ lấy số cần). */
const MACRO_BAR_SYMBOLS = ["US10Y", "US5Y", "DX-Y.NYB", "VND=X", "GC=F", "CL=F", "BZ=F"] as const;

/** Cache toàn bộ nguồn vĩ mô (bar + breadth + giá trị thị trường + flow +
 *  sentiment) — TTL 10 phút: buildTrainingSet tuần 1 lần + serving nhẹ. */
interface MacroCache {
  at: number;
  bars: Map<string, MacroBarSeries>;
  /** Breadth theo ngày: above/total (SQL window, ~0,7s toàn lịch sử). */
  breadth: Map<string, { above: number; total: number }>;
  /** Σ giá trị giao dịch HOSE-STOCK theo ngày (VND — làm mẫu ADTV). */
  mktValue: Map<string, number>;
  /** Σ ForeignFlow.netValue theo ngày (VND — dương = mua ròng). */
  flowNet: Map<string, number>;
  /** Điểm sentiment lexicon theo ngày (F-04). */
  sentDaily: Map<string, { score: number; n: number }>;
  /** Lịch phiên HOSE (distinct dates của breadth — sorted asc). */
  sessions: string[];
}
let macroCacheBox: MacroCache | null = null;
const MACRO_CACHE_TTL_MS = 10 * 60_000;

/** Nạp (hoặc đọc cache) toàn bộ nguồn vĩ mô — fail-soft từng nguồn (N2). */
async function loadMacroCache(): Promise<MacroCache> {
  if (macroCacheBox && Date.now() - macroCacheBox.at < MACRO_CACHE_TTL_MS) {
    return macroCacheBox;
  }
  const bars = new Map<string, MacroBarSeries>();
  try {
    const instruments = await db.instrument.findMany({
      where: { symbol: { in: [...MACRO_BAR_SYMBOLS] } },
      select: { id: true, symbol: true },
    });
    const idBySymbol = new Map(instruments.map((i) => [i.symbol, i.id]));
    const barRows = await db.bar.findMany({
      where: { instrumentId: { in: instruments.map((i) => i.id) } },
      orderBy: { date: "asc" },
      select: { instrumentId: true, date: true, close: true },
    });
    for (const row of barRows) {
      if (!(row.close > 0)) continue;
      const symbol = instruments.find((i) => i.id === row.instrumentId)?.symbol;
      if (!symbol) continue;
      let s = bars.get(symbol);
      if (!s) {
        s = { dates: [], closes: [] };
        bars.set(symbol, s);
      }
      s.dates.push(row.date.toISOString().slice(0, 10));
      s.closes.push(row.close);
    }
    void idBySymbol;
  } catch (err) {
    console.error("[ml/features] nạp bar vĩ mô lỗi (fail-soft → chiều = 0):", err);
  }

  // Breadth + tổng giá trị giao dịch 1 truy vấn SQL window (thử đo #129:
  // 3.439 ngày · 744ms toàn lịch sử — chấp nhận cho nhịp train/serving).
  const breadth = new Map<string, { above: number; total: number }>();
  const mktValue = new Map<string, number>();
  try {
    const rows = await db.$queryRaw<{ d: Date; above: bigint; total: bigint; val: bigint | null }[]>`
      WITH b AS (
        SELECT bar."instrumentId", (bar.date)::date AS d, bar.close,
               AVG(bar.close) OVER (PARTITION BY bar."instrumentId" ORDER BY bar.date
                 ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS sma20,
               (bar.close::bigint) * (bar.volume::bigint) AS val
        FROM "Bar" bar
        JOIN "Instrument" i ON i.id = bar."instrumentId"
        WHERE i."isActive" = true AND i.market = 'HOSE' AND i.type = 'STOCK' AND bar.close > 0
      )
      SELECT d,
             COUNT(*) FILTER (WHERE close > sma20) AS above,
             COUNT(*) FILTER (WHERE sma20 IS NOT NULL) AS total,
             SUM(val) AS val
      FROM b GROUP BY d ORDER BY d`;
    for (const r of rows) {
      const key = new Date(r.d).toISOString().slice(0, 10);
      breadth.set(key, { above: Number(r.above), total: Number(r.total) });
      mktValue.set(key, Number(r.val ?? 0));
    }
  } catch (err) {
    console.error("[ml/features] breadth SQL lỗi (fail-soft → chiều = 0):", err);
  }

  // Dòng khối ngoại theo ngày (768+ dòng — simulated khai báo, F-03 Pha A).
  const flowNet = new Map<string, number>();
  try {
    const rows = await db.$queryRaw<{ d: Date; net: bigint }[]>`
      SELECT (date)::date AS d, SUM("netValue") AS net FROM "ForeignFlow" GROUP BY 1`;
    for (const r of rows) {
      flowNet.set(new Date(r.d).toISOString().slice(0, 10), Number(r.net));
    }
  } catch (err) {
    console.error("[ml/features] ForeignFlow SQL lỗi (fail-soft):", err);
  }

  // Sentiment hằng ngày (F-04 — NewsItem toàn lịch sử tin còn giữ).
  let sentDaily = new Map<string, { score: number; n: number }>();
  try {
    sentDaily = await dailySentimentScores();
  } catch (err) {
    console.error("[ml/features] dailySentimentScores lỗi (fail-soft):", err);
  }

  const sessions = [...breadth.keys()].sort();
  const cache: MacroCache = { at: Date.now(), bars, breadth, mktValue, flowNet, sentDaily, sessions };
  macroCacheBox = cache;
  return cache;
}

/** alignMacroBefore (N4): index bar cuối có date < vnDate (binary search). */
function alignBefore(vnDate: string, dates: string[]): number {
  let lo = 0;
  let hi = dates.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid]! < vnDate) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** Căn chỉnh PIT: trả {i, c} của bar cuối TRƯỚC phiên VN — null khi chưa có. */
function macroAt(symbol: string, vnDate: string, bars: Map<string, MacroBarSeries>): { i: number; c: number } | null {
  const s = bars.get(symbol);
  if (!s) return null;
  const i = alignBefore(vnDate, s.dates);
  if (i < 0) return null;
  return { i, c: s.closes[i]! };
}

/** Δ value qua 20 PHIÊN của chuỗi vĩ mô tại index i (null khi thiếu depth). */
function delta20At(s: MacroBarSeries, i: number): number | null {
  if (i - 20 < 0) return null;
  return s.closes[i]! - s.closes[i - 20]!;
}

/** Momentum ratio 20 phiên tại index i (null khi thiếu depth). */
function mom20At(s: MacroBarSeries, i: number): number | null {
  if (i - 20 < 0) return null;
  const prev = s.closes[i - 20]!;
  return prev > 0 ? s.closes[i]! / prev - 1 : null;
}

/**
 * F-01 (#129): nạp MacroContext cho danh sách ngày phiên VN (key "YYYY-MM-DD").
 * 1 lần gọi = đọc cache 10 phút; thiếu ngày → context trung tính (missing=8).
 */
export async function loadMacroContexts(dates: string[]): Promise<Map<string, MacroContext>> {
  const out = new Map<string, MacroContext>();
  if (dates.length === 0) return out;
  const cache = await loadMacroCache();
  const sessions = cache.sessions;
  // Cửa sổ trượt 20 phiên cho flow/mktValue — cumulative sum theo sessions.
  const flowCum: number[] = new Array(sessions.length + 1).fill(0);
  const mktCum: number[] = new Array(sessions.length + 1).fill(0);
  for (let i = 0; i < sessions.length; i++) {
    flowCum[i + 1] = flowCum[i] + (cache.flowNet.get(sessions[i]!) ?? 0);
    mktCum[i + 1] = mktCum[i] + (cache.mktValue.get(sessions[i]!) ?? 0);
  }
  const sessionIdx = new Map<string, number>();
  sessions.forEach((d, i) => sessionIdx.set(d, i));

  for (const d of [...new Set(dates)]) {
    let missing = 0;
    // ── x[16] ΔUS10Y 20 phiên (cb) ──
    const us10 = macroAt("US10Y", d, cache.bars);
    const s10 = cache.bars.get("US10Y");
    let dus10y20 = 0;
    if (us10 && s10) {
      const dl = delta20At(s10, us10.i);
      if (dl != null) dus10y20 = dl / 100; // BOND_PCT×100 → cb
      else missing++;
    } else missing++;
    // ── x[17] slope 10Y−5Y (cb) ──
    const us5 = macroAt("US5Y", d, cache.bars);
    let slope10y5y = 0;
    if (us10 && us5) slope10y5y = (us10.c - us5.c) / 100;
    else missing++;
    // ── x[18]/x[19] momentum DXY / VND=X ──
    const dxy = macroAt("DX-Y.NYB", d, cache.bars);
    const dxyS = cache.bars.get("DX-Y.NYB");
    let dxyMom20 = 0;
    if (dxy && dxyS) {
      const m = mom20At(dxyS, dxy.i);
      if (m != null) dxyMom20 = m;
      else missing++;
    } else missing++;
    const vndx = macroAt("VND=X", d, cache.bars);
    const vndS = cache.bars.get("VND=X");
    let vndMom20 = 0;
    if (vndx && vndS) {
      const m = mom20At(vndS, vndx.i);
      if (m != null) vndMom20 = m;
      else missing++;
    } else missing++;
    // ── x[20] chu kỳ hàng hoá: trung bình MOM20 GC/CL/BZ (có mấy lấy trung bình mấy) ──
    const moms: number[] = [];
    for (const sym of ["GC=F", "CL=F", "BZ=F"] as const) {
      const at = macroAt(sym, d, cache.bars);
      const s = cache.bars.get(sym);
      if (at && s) {
        const m = mom20At(s, at.i);
        if (m != null) moms.push(m);
      }
    }
    const cmdtyMom20 = moms.length > 0 ? moms.reduce((a, b) => a + b, 0) / moms.length : 0;
    if (moms.length === 0) missing++;
    // ── x[21] breadth: tỷ lệ mã HOSE close > SMA20 ──
    const br = cache.breadth.get(d);
    const breadth20 = br && br.total >= 10 ? br.above / br.total : 0.5;
    if (!br || br.total < 10) missing++;
    // ── x[22] flow_20: Σ netValue(20 phiên ≤ d) / Σ giá trị GD(20 phiên ≤ d) ──
    let flow20 = 0;
    const idx = sessionIdx.get(d);
    if (idx != null && idx >= 0) {
      const from = Math.max(0, idx - 19);
      const netSum = flowCum[idx + 1] - flowCum[from];
      const valSum = mktCum[idx + 1] - mktCum[from];
      if (valSum > 0) flow20 = netSum / valSum;
      else missing++;
    } else missing++;
    // ── x[23] sent_7 (F-04 — trung bình trọng số theo độ tươi, n<5 → 0) ──
    const sent7 = weightedSentiment7(cache.sentDaily, d);

    out.set(d, {
      dus10y20,
      slope10y5y,
      dxyMom20,
      vndMom20,
      cmdtyMom20,
      breadth20,
      flow20,
      sent7,
      missing,
    });
  }
  return out;
}

/**
 * F-01/F-17 (#129): MacroContext cho PHIÊN VN CUỐI CÙNG (serving forward) —
 * dùng bar vĩ mô đã sync sáng nay (06:15 ICT) cho dự báo chiều hôm nay.
 */
export async function latestMacroContext(): Promise<MacroContext | null> {
  const cache = await loadMacroCache();
  const last = cache.sessions[cache.sessions.length - 1];
  if (last == null) return null;
  const map = await loadMacroContexts([last]);
  return map.get(last) ?? null;
}

/** F-01 (#129): lịch phiên HOSE (distinct dates) — dùng làm lịch chuẩn flow. */
export async function hoseSessionDates(): Promise<string[]> {
  const cache = await loadMacroCache();
  return cache.sessions;
}

/* ═══════════════════════════════════════════════════════════════════
 * F-11 (#129) · POINT-IN-TIME BASKET — chống bias sống sót (P1-6)
 * Rổ top-N theo Σ giá trị GD 45 phiên KẾT THÚC TRƯỚC tuần lấy mẫu (1 truy
 * vấn SQL window cho toàn bộ lịch sử ~30 mã × ~717 tuần ≈ 21k dòng).
 * Giới hạn trung thực: kho chỉ còn instrument isActive — mã đã thoái ngang
 * khỏi dchart không thể phục hồi (khai báo trong ML_OPS — không bịa).
 * ═══════════════════════════════════════════════════════════════════ */

export interface PitBaskets {
  /** Số tuần có rổ (tuần ISO). */
  weeks: number;
  /** instrumentId ∈ rổ của TUẦN TRƯỚC tuần chứa dateStr (AUDIT 137 B3 — rổ
   *  tuần wk rank từ bar cuối tuần wk nên rổ của chính tuần wk là lookahead;
   *  fallback = rổ tuần gần nhất TRƯỚC). */
  inBasket(dateStr: string, instrumentId: string): boolean;
  /** Toàn bộ instrumentId từng xuất hiện trong bất kỳ rổ nào (union). */
  unionIds: Set<string>;
}

/** Cache rổ PIT theo topN (TTL 10 phút — dùng trong buildTrainingSet). */
const pitBasketCache = new Map<number, { at: number; value: PitBaskets }>();

export async function weeklyPitBaskets(topN: number): Promise<PitBaskets> {
  const hit = pitBasketCache.get(topN);
  if (hit && Date.now() - hit.at < MACRO_CACHE_TTL_MS) return hit.value;
  // weekKey (YYYY-MM-DD thứ Hai) → instrumentId → adtv45 cuối tuần
  const byWeek = new Map<string, Map<string, number>>();
  try {
    const rows = await db.$queryRaw<{ instrumentId: string; wk: Date; adtv45: bigint }[]>`
      WITH r AS (
        SELECT b."instrumentId", (b.date)::date AS d,
               (SUM((b.close::bigint) * (b.volume::bigint)) OVER (PARTITION BY b."instrumentId"
                 ORDER BY b.date ROWS BETWEEN 45 PRECEDING AND 1 PRECEDING)) AS adtv45
        FROM "Bar" b
        JOIN "Instrument" i ON i.id = b."instrumentId"
        WHERE i."isActive" = true AND i.market = 'HOSE' AND i.type = 'STOCK' AND b.close > 0 AND b.volume > 0
      ),
      ranked AS (
        SELECT "instrumentId", date_trunc('week', d) AS wk, d, adtv45,
               ROW_NUMBER() OVER (PARTITION BY "instrumentId", date_trunc('week', d) ORDER BY d DESC) AS rn
        FROM r WHERE adtv45 IS NOT NULL
      )
      SELECT "instrumentId", wk, adtv45 FROM ranked WHERE rn = 1`;
    for (const r of rows) {
      const wk = new Date(r.wk).toISOString().slice(0, 10);
      let m = byWeek.get(wk);
      if (!m) {
        m = new Map();
        byWeek.set(wk, m);
      }
      m.set(r.instrumentId, Number(r.adtv45));
    }
  } catch (err) {
    console.error("[ml/features] weeklyPitBaskets SQL lỗi (fail-soft → rổ rỗng):", err);
  }
  const weekKeys = [...byWeek.keys()].sort();
  // top-N mỗi tuần → danh sách rổ theo tuần (giữ thứ tự tuần tăng dần)
  const basketsByWeek: { week: string; ids: Set<string> }[] = weekKeys.map((wk) => {
    const entries = [...byWeek.get(wk)!.entries()].sort((a, b) => b[1] - a[1]);
    return { week: wk, ids: new Set(entries.slice(0, topN).map((e) => e[0])) };
  });
  // Tra nhanh: weekKey(date) = date − dow ngày; binary search tuần gần nhất ≤
  const weekOf = (dateStr: string): string => {
    const d = new Date(`${dateStr}T00:00:00.000Z`);
    const dow = d.getUTCDay(); // 0=CN..6=T7 — thứ Hai = 1
    const delta = dow === 0 ? 6 : dow - 1;
    d.setUTCDate(d.getUTCDate() - delta);
    return d.toISOString().slice(0, 10);
  };
  const unionIds = new Set<string>();
  for (const b of basketsByWeek) for (const id of b.ids) unionIds.add(id);
  const value: PitBaskets = {
    weeks: basketsByWeek.length,
    inBasket(dateStr: string, instrumentId: string): boolean {
      const wk = weekOf(dateStr);
      // AUDIT 137 B3 — PIT: rổ tuần TRƯỚC (rank từ bar cuối tuần TRƯỚC), không
      // dùng rổ của CHÍNH tuần đang lấy mẫu — rổ tuần wk được xếp hạng từ bar
      // CUỐI tuần wk (SQL rn=1 ORDER BY d DESC) nên sample thứ Hai/thứ Ba của
      // tuần wk mà dùng rổ wk là nhìn 3-4 phiên tương lai. Comparator CHẶT
      // "< wk" (tuần nhỏ hơn tuần lấy mẫu) — fallback tuần gần nhất TRƯỚC.
      let lo = 0;
      let hi = basketsByWeek.length - 1;
      let ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (basketsByWeek[mid]!.week < wk) {
          ans = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (ans < 0) return false; // trước cả rổ đầu tiên — không có dữ liệu rổ
      return basketsByWeek[ans]!.ids.has(instrumentId);
    },
    unionIds,
  };
  pitBasketCache.set(topN, { at: Date.now(), value });
  return value;
}

/** F-11 (#129): nạp chuỗi SymbolSeries cho UNION toàn bộ rổ PIT từng tuần. */
async function loadPitUnionSeries(topN: number): Promise<SymbolSeries[]> {
  const baskets = await weeklyPitBaskets(topN);
  const ids = [...baskets.unionIds];
  if (ids.length === 0) return [];
  const instruments = await db.instrument.findMany({
    where: { id: { in: ids } },
    select: { id: true, symbol: true },
  });
  const symbolById = new Map(instruments.map((i) => [i.id, i.symbol]));
  const barRows = await db.bar.findMany({
    where: { instrumentId: { in: ids } },
    orderBy: [{ instrumentId: "asc" }, { date: "asc" }],
    select: { instrumentId: true, date: true, close: true, volume: true },
  });
  const byId = new Map<string, { date: Date[]; close: number[]; volume: number[] }>();
  for (const b of barRows) {
    if (!(b.close > 0)) continue;
    let e = byId.get(b.instrumentId);
    if (!e) {
      e = { date: [], close: [], volume: [] };
      byId.set(b.instrumentId, e);
    }
    e.date.push(b.date);
    e.close.push(b.close);
    e.volume.push(b.volume);
  }
  const out: SymbolSeries[] = [];
  for (const [id, e] of byId) {
    const symbol = symbolById.get(id);
    if (!symbol) continue;
    out.push({
      symbol,
      instrumentId: id,
      bars: e.date.map((date, i) => ({ date, close: e.close[i]!, volume: e.volume[i]! })),
      closes: e.close,
      volumes: e.volume,
    });
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════
 * F-09 (#129) · NHÃN ĐA NHIỆM — hướng + biên độ + biến động
 * labelAt (hướng) giữ nguyên cho sweep v2; labelRichAt phục vụ task
 * multitask (backbone dùng chung, 3 đầu ra — Loss CE + 0,3·MSE_mag +
 * 0,3·MSE_vol theo đặc tả F-09).
 * ═══════════════════════════════════════════════════════════════════ */

/** Scale biên độ: tanh(ret₅ × 25) — ±2,5% → ±0,76 (đưa về (−1,1) ổn định). */
export const ML_MAG_SCALE = 25;
/** Scale biến động: std(ret1, 5 phiên tới) / 0,02 — vol ngày 2% → 1,0. */
export const ML_VOL_SCALE = 0.02;

/** Nhãn giàu cho multitask (F-09). */
export interface RichLabel {
  /** 0=DOWN · 1=FLAT · 2=UP (cùng ngưỡng labelAt). */
  dir: number;
  /** |biên độ| 5 phiên tới (tanh×scale) — dấu theo hướng. */
  mag: number;
  /** realized vol 5 phiên tới (chuẩn hoá). */
  vol: number;
}

/** Nhãn đa nhiệm tại t — null khi chưa đủ 5 phiên tương lai (mirror labelAt). */
export function labelRichAt(r: RollingSeries, t: number): RichLabel | null {
  const future = t + ML_HORIZON_DAYS;
  if (future >= r.closes.length) return null;
  const ret5 = r.closes[future]! / r.closes[t]! - 1;
  let m = 0;
  let v = 0;
  const rets: number[] = [];
  for (let u = t + 1; u <= future; u++) {
    rets.push(r.ret1[u] ?? 0);
  }
  m = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0; // dùng mean thay std khi ít mẫu
  v = rets.length
    ? Math.sqrt(rets.reduce((a, b) => a + (b - m) * (b - m), 0) / rets.length)
    : 0;
  const dir = ret5 > ML_LABEL_THRESHOLD ? 2 : ret5 < -ML_LABEL_THRESHOLD ? 0 : 1;
  return {
    dir,
    mag: Math.tanh(ret5 * ML_MAG_SCALE),
    vol: v / ML_VOL_SCALE,
  };
}
