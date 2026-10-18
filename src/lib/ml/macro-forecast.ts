/**
 * src/lib/ml/macro-forecast.ts — F-17 (#129-E · AI_ENGINEER_REVIEW_BRAIN v3
 * §3 F-17) · MACRO-MLP MULTI-ASSET — MÔ HÌNH DỰ BÁO THỨ HAI cho 8 tài sản
 * vĩ mô: VNINDEX · VN30 · US10Y · US30Y · DX-Y.NYB · VND=X · GC=F · CL=F.
 *
 * ĐÓNG KỲ VỌNG "TRÁI PHIẾU" CỦA CHỦ SỞ HỮU: nguyên văn *"…phán đoán nền kinh
 * tế, biến động tài chính, cổ phiếu, **trái phiếu**"* — trước F-17 lợi suất
 * Treasury chỉ là ĐẶC TRƯNG ĐẦU VÀO (x[16]/x[17] của não cổ phiếu), không có
 * chức năng nào DỰ BÁO cho chính tài sản trái phiếu/FX/hàng hoá. File này là
 * giọng nói định lượng độc lập cho từng tài sản — mỗi tài sản một MLP riêng
 * (registry kind dùng chung "macro-mlp", meta.assetSymbol phân biệt).
 *
 * Kiến trúc TÁI DÙNG tối đa (chi phí biên thấp theo review §5):
 *  - đặc trưng giá: `featureAt(roll, t).slice(0, 10)` — đúng 10 chiều v1 thuần
 *    giá (bản serving v8-lag10 đọc cùng công thức — tương thích ngược);
 *  - 4 chiều bối cảnh chung từ loader F-01 (`loadMacroContexts` /
 *    `latestMacroContext` trong features.ts): [ΔUS10Y_20 · DXY_mom20 ·
 *    breadth20 · sent7] → vector 14 chiều "macro-asset-v1";
 *  - MLP class + Adam/early-stop/class-weight của nn.ts — arch riêng
 *    14 → 24 ReLU → 12 ReLU → 3 softmax (699 tham số, deterministic seed 42
 *    qua MLP_FIT_DEFAULTS);
 *  - versioning/saveModel của train-mlp.ts — KHÔNG tự viết versioning.
 *
 * VERSIONING CHUNG 8 TÀI SẢN (quyết định thiết kế đáng chú ý nhất): kind
 * "macro-mlp" là MỘT kind cho cả 8 tài sản — version là max+1 CHUNG (vì
 * nextVersion/saveModel đếm theo kind). Hệ quả:
 *  (a) saveModel luôn gọi với promote:false — nếu promote, updateMany
 *      "archive mọi bản serving của kind" sẽ XOÁ status serving của 7 tài sản
 *      khác mỗi lần train 1 tài sản;
 *  (b) serving KHÔNG đọc status (mọi bản đều "archived") — chọn theo
 *      meta.assetSymbol + version DESC + featureSet khớp "macro-asset-v1".
 *
 * GATE N6 TRUNG THỰC (nghiệm thu F-17): mỗi tài sản chỉ "sống" khi Brier
 * rolling 60 phiên TỐT HƠN baseline "đi ngang luôn" (uniform 3 lớp → Brier
 * = 2/3 ≈ 0,667) — không đạt → `edge:false`, UI hiển thị "chưa đủ cạnh biên";
 * ≥ 2 tài sản đạt mới tính là chức năng sống. Model/dữ liệu thiếu → null,
 * không bịa số.
 */

import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import {
  featureAt,
  loadMacroContexts,
  latestMacroContext,
  ML_HORIZON_DAYS,
  ML_WARMUP_BARS,
  rollingFeatures,
  standardize,
  type MacroContext,
} from "@/lib/ml/features";
import { MLP, MLP_FIT_DEFAULTS, type MlpArch } from "@/lib/ml/nn";
import { saveModel, type MlModelMeta } from "@/lib/ml/train-mlp";

/* ─────────────────── Hằng số bộ đặc trưng / registry ─────────────────── */

/** Kind MlModel dùng chung 8 tài sản (String — hợp lệ ngay, 0 migrate). */
export const MACRO_MODEL_KIND = "macro-mlp";
/** Nhãn bộ đặc trưng: 10 chiều giá v1 + 4 chiều context vĩ mô. */
export const MACRO_FEATURE_SET = "macro-asset-v1";
/** 10 chiều đầu = bộ v1 thuần giá (x[0..9] — cùng công thức serving v8). */
export const MACRO_PRICE_FEATURES = 10;
/** Tổng chiều đầu vào MLP = 10 giá + 4 context. */
export const MACRO_FEATURE_COUNT = MACRO_PRICE_FEATURES + 4;
/** Kiến trúc MLP mỗi tài sản: 14 → 24 ReLU → 12 ReLU → 3 (699 tham số). */
export const MACRO_MLP_ARCH: MlpArch = { in: MACRO_FEATURE_COUNT, hidden: [24, 12], out: 3 };
/** Cap mẫu huấn luyện mỗi tài sản (giữ ngân sách train — mẫu gần nhất). */
export const MACRO_MAX_SAMPLES = 20_000;
/**
 * Số mẫu tối thiểu để train 1 tài sản: warmup 60 + horizon 5 + ~55 phiên hiệu
 * dụng (val 20% còn ≥ 24 mẫu cho early-stop). VNINDEX/VN30 ~2.2k · Treasury
 * ~380 · Yahoo ~185 · VND=X ~165 mẫu đo 17/10/2026 — 8/8 đạt ngưỡng.
 */
export const MACRO_MIN_SAMPLES = 120;
/** Cửa sổ Brier rolling (phiên) — gate nghiệm thu F-17. */
export const MACRO_BRIER_WINDOW = 60;
/** Baseline "đi ngang luôn" uniform 3 lớp: Σ(1/3−o)² = 2/3 ≈ 0,667. */
export const MACRO_BRIER_BASELINE = 2 / 3;
/** Giá trị hiển thị baseline (tròn 3 chữ số — khớp doc F-17 "0,667"). */
export const MACRO_BRIER_BASELINE_DISPLAY = 0.667;
/** Biên cạnh phải thắng baseline: Brier60 < 0,667 − 0,01 = 0,657. */
export const MACRO_EDGE_MARGIN = 0.01;
/** Trần quét meta khi tìm model mới nhất từng tài sản (an toàn bộ nhớ). */
export const MACRO_MODEL_SCAN_LIMIT = 1000;
/** Version chuỗi digest local (không import trainingWindowDigest — features.ts đang sửa song song). */
const MACRO_DIGEST_VERSION = "sha256-symbol-date-close-volume-macro-v1";

/* ════════════════════════════════════════════════════════════════════════
 * ASSET_LABEL_SPEC — N5 · MỘT NGUỒN SỰ THẬT về ngưỡng nhãn 8 tài sản
 * (comment schema như UNIT_SPECS trong eod-sync.ts — đổi ngưỡng chỉ sửa đây).
 *
 * | symbol    | label (vi)                     | market     | type    | threshold |
 * |-----------|--------------------------------|------------|---------|-----------|
 * | VNINDEX   | VN-Index (HOSE)                | HOSE       | INDEX   | ±0,7%     |
 * | VN30      | VN30 (HOSE)                    | HOSE       | INDEX   | ±0,7%     |
 * | US10Y     | Trái phiếu Mỹ 10 năm (LS)      | BOND       | BOND    | ±12 cb    |
 * | US30Y     | Trái phiếu Mỹ 30 năm (LS)      | BOND       | BOND    | ±12 cb    |
 * | DX-Y.NYB  | Chỉ số Đô la Mỹ (DXY)          | FOREX      | FOREX   | ±0,8%     |
 * | VND=X     | Tỷ giá USD/VND                 | FOREX      | FOREX   | ±0,3%     |
 * | GC=F      | Vàng COMEX (tương lai)         | COMMODITY  | CMDTY   | ±1,5%     |
 * | CL=F      | Dầu thô WTI (tương lai)        | COMMODITY  | CMDTY   | ±1,5%     |
 *
 * Đơn vị `threshold` theo `type` (hàm labelOf):
 *  - INDEX/FOREX/CMDTY: TỶ LỆ % trên close(t+5)/close(t)−1 (0,007 = ±0,7%).
 *    Bar INDEX = điểm×100 · FOREX = tỷ giá×10.000 · CMDTY = cents×100 — mọi
 *    scale đều triệt tiêu trong phép chia nên ngưỡng % dùng trực tiếp.
 *  - BOND: ĐIỂM CƠ BẢN (cb) trên Δ đơn vị Bar.close — Bar BOND = lợi suất
 *    %×100 (UNIT_BOND) → 1 đơn vị close = 1 cb (cùng quy ước agent-context
 *    "Treasury: 1 đơn vị = 1 điểm cơ bản"). Ngưỡng ±12 cb ⇔ |Δclose| ≥ 12
 *    ⇔ |Δlợi suất| ≥ 0,12 điểm % trong 5 phiên.
 * `market` ghi theo enum Prisma; `type` là LỚP tài sản chọn quy tắc nhãn
 * (DB InstrumentType tương ứng: FOREX ↔ FX · CMDTY ↔ CMDTY · INDEX/BOND trùng tên).
 * ════════════════════════════════════════════════════════════════════════ */

/** Lớp tài sản — quyết định quy tắc nhãn (F-17 thiết kế #1). */
export type MacroAssetClass = "INDEX" | "BOND" | "FOREX" | "CMDTY";

/** Một dòng ASSET_LABEL_SPEC — N5, 1 nguồn sự thật duy nhất. */
export interface MacroAssetLabelSpec {
  /** Symbol Instrument (unique trong DB). */
  symbol: string;
  /** Nhãn tiếng Việt hiển thị bảng "DỰ BÁO 5 PHIÊN" (buildMacroInner). */
  label: string;
  /** Market enum trong DB: HOSE | BOND | FOREX | COMMODITY. */
  market: string;
  /** Lớp tài sản chọn quy tắc nhãn (DB InstrumentType: FOREX↔FX). */
  type: MacroAssetClass;
  /** Ngưỡng nhãn — đơn vị theo `type` (xem bảng schema trên). */
  threshold: number;
}

/** 8 tài sản F-17 — thứ tự cố định (UI hiển thị đúng bảng 8 dòng). */
export const ASSET_LABEL_SPEC: readonly MacroAssetLabelSpec[] = [
  { symbol: "VNINDEX", label: "VN-Index (HOSE)", market: "HOSE", type: "INDEX", threshold: 0.007 },
  { symbol: "VN30", label: "VN30 (HOSE)", market: "HOSE", type: "INDEX", threshold: 0.007 },
  { symbol: "US10Y", label: "Trái phiếu Chính phủ Mỹ 10 năm (lợi suất)", market: "BOND", type: "BOND", threshold: 12 },
  { symbol: "US30Y", label: "Trái phiếu Chính phủ Mỹ 30 năm (lợi suất)", market: "BOND", type: "BOND", threshold: 12 },
  { symbol: "DX-Y.NYB", label: "Chỉ số Đô la Mỹ (DXY)", market: "FOREX", type: "FOREX", threshold: 0.008 },
  { symbol: "VND=X", label: "Tỷ giá USD/VND", market: "FOREX", type: "FOREX", threshold: 0.003 },
  { symbol: "GC=F", label: "Vàng COMEX (tương lai)", market: "COMMODITY", type: "CMDTY", threshold: 0.015 },
  { symbol: "CL=F", label: "Dầu thô WTI (tương lai)", market: "COMMODITY", type: "CMDTY", threshold: 0.015 },
];

/** Tra spec theo symbol — null khi không thuộc 8 tài sản F-17. */
export function macroSpecOf(symbol: string): MacroAssetLabelSpec | null {
  return ASSET_LABEL_SPEC.find((s) => s.symbol === symbol) ?? null;
}

/**
 * Nhãn hướng 5 phiên tới của MỘT tài sản theo ASSET_LABEL_SPEC — cùng quy
 * ước class MLP: 0=DOWN · 1=FLAT · 2=UP. null khi chưa đủ phiên tương lai.
 * BOND: Δcb trên đơn vị Bar.close (%×100 → 1 đơn vị = 1 cb) — ngưỡng ±12 cb.
 * Còn lại: |close(t+5)/close(t)−1| so ngưỡng % (scale điểm/cents/tỷ giá triệt tiêu).
 */
export function macroLabelOf(
  spec: MacroAssetLabelSpec,
  closes: readonly number[],
  t: number,
  horizon: number = ML_HORIZON_DAYS
): 0 | 1 | 2 | null {
  const future = t + horizon;
  if (t < 0 || future >= closes.length) return null;
  const c0 = closes[t];
  const c5 = closes[future];
  if (!(c0 > 0) || !(c5 > 0)) return null;
  if (spec.type === "BOND") {
    const deltaCb = c5 - c0; // 1 đơn vị close BOND = 1 cb
    if (deltaCb > spec.threshold) return 2;
    if (deltaCb < -spec.threshold) return 0;
    return 1;
  }
  const ret = c5 / c0 - 1;
  if (ret > spec.threshold) return 2;
  if (ret < -spec.threshold) return 0;
  return 1;
}

/* ─────────────────── Nạp Instrument + Bar (spec F-17 #2) ─────────────────── */

/** Chuỗi EOD sạch của một tài sản F-17 (đã lọc close>0 · volume≥0 · date asc). */
export interface MacroAssetBars {
  spec: MacroAssetLabelSpec;
  instrumentId: string;
  /** Ngày phiên ISO "YYYY-MM-DD" (tăng dần) — cùng định dạng key loadMacroContexts. */
  dates: string[];
  closes: number[];
  volumes: number[];
}

/**
 * Query 1 LẦN cho cả 8 instrument của ASSET_LABEL_SPEC → map theo symbol
 * (spec F-17: "có instrumentId map sẵn theo symbol — query 1 lần 8 instrument").
 */
export async function macroInstrumentMap(): Promise<
  Map<string, { id: string; market: string; type: string }>
> {
  const rows = await db.instrument.findMany({
    where: {
      symbol: { in: ASSET_LABEL_SPEC.map((s) => s.symbol) },
      isActive: true,
      deletedAt: null,
    },
    select: { id: true, symbol: true, market: true, type: true },
  });
  return new Map<string, { id: string; market: string; type: string }>(
    rows.map((r): [string, { id: string; market: string; type: string }] => [
      r.symbol,
      { id: r.id, market: r.market, type: r.type },
    ])
  );
}

/** Nạp toàn bộ bar EOD của MỘT tài sản (date asc, close>0, volume≥0). */
export async function loadMacroAssetBars(symbol: string): Promise<MacroAssetBars | null> {
  const spec = macroSpecOf(symbol);
  if (!spec) return null;
  const instMap = await macroInstrumentMap();
  const inst = instMap.get(symbol);
  if (!inst) return null; // chưa seed instrument vĩ mô — trung thực null
  const bars = await db.bar.findMany({
    where: { instrumentId: inst.id, close: { gt: 0 }, volume: { gte: 0 } },
    orderBy: { date: "asc" },
    select: { date: true, close: true, volume: true },
  });
  if (bars.length === 0) return null;
  return {
    spec,
    instrumentId: inst.id,
    dates: bars.map((b) => b.date.toISOString().slice(0, 10)),
    closes: bars.map((b) => b.close),
    volumes: bars.map((b) => b.volume),
  };
}

/**
 * Nạp chuỗi bar CẢ 8 tài sản trong 2 query (1 instrument + 1 bar gộp theo
 * instrumentId in) — dùng cho trainAllMacroAssets/macroAssetForecasts (tránh
 * 8+8 query rời). Assets thiếu instrument/bar đơn giản không có trong map.
 */
export async function loadAllMacroBars(): Promise<Map<string, MacroAssetBars>> {
  const instMap = await macroInstrumentMap();
  const ids = [...instMap.values()].map((i) => i.id);
  const out = new Map<string, MacroAssetBars>();
  if (ids.length === 0) return out;
  const rows = await db.bar.findMany({
    where: { instrumentId: { in: ids }, close: { gt: 0 }, volume: { gte: 0 } },
    orderBy: [{ instrumentId: "asc" }, { date: "asc" }],
    select: { instrumentId: true, date: true, close: true, volume: true },
  });
  const grouped = new Map<string, { date: Date; close: number; volume: number }[]>();
  for (const r of rows) {
    let g = grouped.get(r.instrumentId);
    if (!g) {
      g = [];
      grouped.set(r.instrumentId, g);
    }
    g.push({ date: r.date, close: r.close, volume: r.volume });
  }
  for (const spec of ASSET_LABEL_SPEC) {
    const inst = instMap.get(spec.symbol);
    if (!inst) continue;
    const g = grouped.get(inst.id);
    if (!g || g.length === 0) continue;
    out.set(spec.symbol, {
      spec,
      instrumentId: inst.id,
      dates: g.map((b) => b.date.toISOString().slice(0, 10)),
      closes: g.map((b) => b.close),
      volumes: g.map((b) => b.volume),
    });
  }
  return out;
}

/* ─────────────────── 4 chiều bối cảnh chung (loader F-01) ─────────────────── */

/** Thứ tự 4 chiều context của vector 14 chiều (ghi chú schema — N5). */
export const MACRO_CONTEXT_KEYS = ["dus10y20", "dxyMom20", "breadth20", "sent7"] as const;

function finiteOr0(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * 4 chiều bối cảnh chung từ MacroContext (loader F-01 trong features.ts):
 * [ΔUS10Y_20 · DXY_mom20 · breadth20 · sent7]. Thiếu context (macro chưa có
 * lịch sử cho ngày đó) → [0,0,0,0] — KHÔNG bỏ mẫu; caller đếm missing.
 */
export function macroContextVector(ctx: MacroContext | null | undefined): number[] {
  if (!ctx) return [0, 0, 0, 0];
  return [
    finiteOr0(ctx.dus10y20),
    finiteOr0(ctx.dxyMom20),
    finiteOr0(ctx.breadth20),
    finiteOr0(ctx.sent7),
  ];
}

/**
 * SHA-256 cửa sổ dữ liệu MỘT tài sản (symbol|date|close|volume, thứ tự ổn
 * định) — viết LOCAL theo khuôn trainingWindowDigest của features.ts nhưng
 * KHÔNG import (features.ts đang được sửa song song — hợp đồng import chỉ
 * gồm loader context). Cùng dữ liệu → cùng hash (PIT P1-2 tái lập được).
 */
function macroWindowDigest(symbol: string, dates: string[], closes: number[], volumes: number[]): string {
  const hash = createHash("sha256");
  hash.update(`#${symbol}\n`);
  for (let i = 0; i < dates.length; i++) {
    hash.update(`${dates[i]}|${closes[i]}|${volumes[i]}\n`);
  }
  return hash.digest("hex");
}

/* ─────────────────── Dataset 14 chiều (spec F-17 #2) ─────────────────── */

/** Tập huấn luyện một tài sản: X 14 chiều RAW + y 3 lớp + meta PIT. */
export interface MacroAssetDataSet {
  /** Symbol tài sản (khóa ASSET_LABEL_SPEC). */
  symbol: string;
  /** Ma trận đặc trưng RAW 14 chiều (z-score do caller làm sau khi train). */
  X: number[][];
  /** Nhãn 0=DOWN · 1=FLAT · 2=UP (macroLabelOf theo ASSET_LABEL_SPEC). */
  y: number[];
  /** Ngày phiên t của từng mẫu (ISO YYYY-MM-DD, tăng dần theo thời gian). */
  dates: string[];
  /** Số mẫu GIỮ LẠI (sau cap) có ngày KHÔNG có context vĩ mô (context = 0). */
  missingContext: number;
  /** Số bar hợp lệ của tài sản (close>0 · volume≥0). */
  bars: number;
  /** Ngày phiên ĐẦU chuỗi bar (semantics TrainingWindowMeta — hash cả chuỗi). */
  trainDateFrom: string | null;
  /** Ngày phiên CUỐI chuỗi bar (biên trên PIT). */
  trainDateTo: string | null;
  /** SHA-256 cửa sổ dữ liệu (macroWindowDigest local). */
  windowHash: string;
}

/**
 * Build tập 14 chiều từ chuỗi bar + map context (THUẦN — không query):
 * mỗi phiên t đủ warmup 60 (featureAt) VÀ t+5 tồn tại (nhãn realized theo
 * ASSET_LABEL_SPEC) → [10 chiều giá v1, 4 chiều context]. Thiếu context của
 * ngày → điền 0 + đếm missing (không bỏ mẫu — trung thực với lịch sử macro
 * còn ngắn). Sort theo ngày, cap MACRO_MAX_SAMPLES mẫu GẦN NHẤT.
 */
export function buildMacroAssetSetFromBars(
  bars: MacroAssetBars,
  contextByDate: Map<string, MacroContext>
): MacroAssetDataSet {
  const roll = rollingFeatures(bars.closes, bars.volumes);
  const xs: number[][] = [];
  const ys: number[] = [];
  const dts: string[] = [];
  for (let t = ML_WARMUP_BARS - 1; t < bars.closes.length; t++) {
    const x = featureAt(roll, t);
    if (x == null) continue;
    const label = macroLabelOf(bars.spec, bars.closes, t);
    if (label == null) continue;
    const ctx = contextByDate.get(bars.dates[t]);
    xs.push([...x.slice(0, MACRO_PRICE_FEATURES), ...macroContextVector(ctx)]);
    ys.push(label);
    dts.push(bars.dates[t]);
  }
  // Sort theo ngày tăng dần (stable — query đã asc nhưng giữ khuôn
  // buildTrainingSet) rồi cap mẫu GẦN NHẤT giữ ngân sách train.
  const order = dts
    .map((_, i) => i)
    .sort((a, b) => (dts[a] < dts[b] ? -1 : dts[a] > dts[b] ? 1 : 0));
  const take = Math.min(order.length, MACRO_MAX_SAMPLES);
  const keep = order.slice(order.length - take);
  const keptDates = keep.map((i) => dts[i]);
  let missingContext = 0;
  for (const d of keptDates) {
    if (!contextByDate.has(d)) missingContext++;
  }
  return {
    symbol: bars.spec.symbol,
    X: keep.map((i) => xs[i]),
    y: keep.map((i) => ys[i]),
    dates: keptDates,
    missingContext,
    bars: bars.closes.length,
    trainDateFrom: bars.dates[0] ?? null,
    trainDateTo: bars.dates[bars.dates.length - 1] ?? null,
    windowHash: macroWindowDigest(bars.spec.symbol, bars.dates, bars.closes, bars.volumes),
  };
}

/**
 * Dataset mỗi tài sản (spec F-17 #2) — tự query Instrument + toàn bộ Bar
 * (date asc · close>0 · volume≥0) rồi build 14 chiều. Trả null khi tài sản
 * không thuộc ASSET_LABEL_SPEC hoặc chưa có instrument/bar trong DB.
 * Caller muốn tránh query lại (trainAll/serving) dùng buildMacroAssetSetFromBars.
 */
export async function buildMacroAssetSet(
  symbol: string,
  contextByDate: Map<string, MacroContext>
): Promise<MacroAssetDataSet | null> {
  const bars = await loadMacroAssetBars(symbol);
  if (!bars) return null;
  return buildMacroAssetSetFromBars(bars, contextByDate);
}

/* ─────────────────── Train (spec F-17 #3) ─────────────────── */

/**
 * Meta MlModel của kind "macro-mlp" — TrainingWindowMeta (PIT) + trường riêng
 * F-17: assetSymbol (phân biệt 8 tài sản trong kind dùng chung) + featureSet
 * "macro-asset-v1" + missingContext (số mẫu thiếu context vĩ mô).
 */
export type MacroModelMeta = MlModelMeta & {
  /** Tài sản của bản này — kind "macro-mlp" dùng chung 8 tài sản. */
  assetSymbol: string;
  /** Luôn "macro-asset-v1" (10 chiều giá v1 + 4 chiều context). */
  featureSet: string;
  /** Số mẫu không có context vĩ mô (đặc trưng context điền 0). */
  missingContext?: number;
  /** AUDIT 137 B6 — số mẫu CUỐI được reserve làm holdout KHÔNG tham gia fit
   *  (Brier60/edge ở serving đo trên holdout này). Bản cũ không có trường →
   *  coi như 0 (toàn bộ mẫu đều vào fit — Brier60 in-sample val). */
  holdoutTail?: number;
  /** AUDIT 137 B6 — ngày phiên của mẫu fit CUỐI (biên trên phần dữ liệu mô
   *  hình ĐÃ học). Serving so với ngày bắt đầu cửa sổ Brier để trung thực
   * đánh dấu brier60Holdout. Bản cũ không có → null (không biết). */
  fitDateTo?: string | null;
};

/** Kết quả train 1 tài sản — metrics tối thiểu {valAcc, valLoss, samples, epochs}. */
export interface MacroTrainResult {
  symbol: string;
  label: string;
  /** Version MlModel vừa tạo (đánh max+1 CHUNG kind — meta.assetSymbol phân biệt). */
  modelVersion: number;
  metrics: {
    valAcc: number;
    valLoss: number;
    samples: number;
    epochs: number;
    trainAcc: number;
    trainLoss: number;
    /** AUDIT 137 B6 — số mẫu CUỐI reserve làm holdout (0 = không đủ mẫu để
     *  holdout — Brier60 khi đó vẫn in-sample val, trung thực qua số 0). */
    holdoutTail: number;
  };
  /** Số mẫu thiếu context vĩ mô (điền 0 khi train). */
  missingContext: number;
  trainDateTo: string | null;
  windowHash: string;
}

/**
 * Train MLP macro-asset-v1 cho 1 tài sản từ chuỗi bar + context đã nạp:
 * build → standardize → MLP {in:14, hidden:[24,12], out:3} (MLP_FIT_DEFAULTS
 * — deterministic seed 42, class-weight 1/freq, early-stop valLoss) → setNorm
 * → saveModel kind "macro-mlp" promote:false (versioning chung — xem header).
 * Throw khi thiếu dữ liệu — caller (trainAll/route) fail-soft từng tài sản.
 */
async function trainMacroMlpFromSet(
  bars: MacroAssetBars,
  contextByDate: Map<string, MacroContext>
): Promise<MacroTrainResult> {
  const symbol = bars.spec.symbol;
  const set = buildMacroAssetSetFromBars(bars, contextByDate);
  if (set.X.length < MACRO_MIN_SAMPLES) {
    throw new Error(
      `chỉ có ${set.X.length} mẫu cho ${symbol} (cần ≥ ${MACRO_MIN_SAMPLES} — ${bars.spec.label} thiếu lịch sử EOD)`
    );
  }
  if (set.X[0].length !== MACRO_FEATURE_COUNT) {
    throw new Error(
      `tập train ${set.X[0].length} chiều ≠ ${MACRO_FEATURE_COUNT} (featureSet macro-asset-v1 lệch?)`
    );
  }
  // AUDIT 137 B6 — reserve 60 mẫu CUỐI làm holdout KHÔNG tham gia fit: trước
  // đây Brier60/edge ở serving (cửa sổ 60 phiên cuối) đo trên CHÍNH val block
  // đã early-stop model → "US10Y 67,5%" lạc quan một phần. Giờ biên train/val
  // dời lùi 60 phiên — sau retrain, cửa sổ Brier60 = holdout thật (ngoài
  // mẫu). Guard: chỉ holdout khi phần còn lại đủ MACRO_MIN_SAMPLES để fit.
  const nHoldout = Math.min(
    MACRO_BRIER_WINDOW,
    Math.max(0, set.X.length - MACRO_MIN_SAMPLES)
  );
  const nFit = set.X.length - nHoldout;
  const Xfit = set.X.slice(0, nFit);
  const yFit = set.y.slice(0, nFit);
  const fitDateTo = set.dates[nFit - 1] ?? null; // ngày mẫu fit CUỐI (biên B6)
  // AUDIT 137 B1 — thống kê chỉ từ TRAIN split — chặn leakage: mean/std tính
  // trên nTrain dòng ĐẦU khớp CHÍNH XÁC cut của nn.ts fit() (clamp
  // [0,05..0,5] rồi Math.floor(n * (1 − v)) — MLP_FIT_DEFAULTS.valFraction
  // 0,2): trước đây standardize(set.X) tính trên 100% chuỗi (gồm val tương
  // lai) → valAcc lạc quan. LƯU Ý: valAcc sau vá NHẠT HƠN số cũ — đổi chuẩn
  // đo trung thực, không phải mô hình sa sút.
  const valFractionFit = Math.min(0.5, Math.max(0.05, MLP_FIT_DEFAULTS.valFraction));
  const nTrainStd = Math.floor(nFit * (1 - valFractionFit));
  const { mean, std, Xstd } = standardize(Xfit, { nTrain: nTrainStd });
  // Constructor mặc định: activations relu×2 · seed 42 (RNG_SEED nn.ts) —
  // tái dùng MLP_FIT_DEFAULTS cho opts fit (lr 0,01 · batch 32 · 60 epoch ·
  // patience 12 · lossWeights [1,1,1] · l2 0 · val 0,2 · seed 42) → kết quả
  // huấn luyện DETERMINISTIC/lặp lại được trên cùng cửa sổ dữ liệu.
  const mlp = new MLP(MACRO_MLP_ARCH);
  const fit = mlp.fit(Xstd, yFit, { ...MLP_FIT_DEFAULTS });
  mlp.setNorm({ mean, std });

  const metrics = {
    valAcc: fit.valAcc,
    valLoss: fit.valLoss,
    samples: fit.samples,
    epochs: fit.epochs,
    trainAcc: fit.trainAcc,
    trainLoss: fit.trainLoss,
    // AUDIT 137 B6 — đánh dấu trung thực: lần train này reserve holdout.
    holdoutTail: nHoldout,
    brier60Holdout: nHoldout > 0,
  };
  const meta: MacroModelMeta = {
    windowHash: set.windowHash,
    trainDateFrom: set.trainDateFrom,
    trainDateTo: set.trainDateTo,
    bars: set.bars,
    samples: set.X.length,
    symbols: [symbol],
    horizonDays: ML_HORIZON_DAYS,
    featureCount: MACRO_FEATURE_COUNT,
    digestVersion: MACRO_DIGEST_VERSION,
    assetSymbol: symbol,
    featureSet: MACRO_FEATURE_SET,
    missingContext: set.missingContext,
    // AUDIT 137 B6 — serving đọc 2 trường này để đánh dấu brier60Holdout.
    holdoutTail: nHoldout,
    fitDateTo,
  };
  // promote:false — LUÔN archived: kind dùng chung 8 tài sản, promote qua
  // updateMany serving sẽ archive lẫn nhau; serving chọn theo meta.assetSymbol.
  const modelVersion = await saveModel(
    MACRO_MODEL_KIND,
    mlp.toJSON(),
    JSON.stringify({ mean, std }),
    {
      ...metrics,
      horizonDays: ML_HORIZON_DAYS,
      features: MACRO_FEATURE_COUNT,
      assetSymbol: symbol,
      missingContext: set.missingContext,
      params: mlp.paramCount,
    },
    meta,
    { promote: false }
  );
  return {
    symbol,
    label: bars.spec.label,
    modelVersion,
    metrics,
    missingContext: set.missingContext,
    trainDateTo: set.trainDateTo,
    windowHash: set.windowHash,
  };
}

/**
 * Train 1 tài sản theo symbol (đường đơn lẻ — tự nạp bar + context):
 * loadMacroAssetBars → loadMacroContexts(toàn bộ ngày của tài sản) → train.
 * Throw lỗi dữ liệu rõ ràng (caller xử lý) — xem trainAllMacroAssets để
 * train cả 8 tài sản fail-soft.
 */
export async function trainMacroMlp(symbol: string): Promise<MacroTrainResult> {
  const spec = macroSpecOf(symbol);
  if (!spec) {
    throw new Error(`tài sản "${symbol}" không nằm trong ASSET_LABEL_SPEC (F-17 · 8 tài sản)`);
  }
  const bars = await loadMacroAssetBars(symbol);
  if (!bars) {
    throw new Error(
      `không tìm thấy instrument/bar active cho "${symbol}" — chạy seed/sync multi-market (p106) trước`
    );
  }
  const contexts = await loadMacroContexts(bars.dates);
  return trainMacroMlpFromSet(bars, contexts);
}

/** Tổng kết 1 đợt trainAllMacroAssets — fail-soft từng tài sản. */
export interface MacroTrainSummary {
  trained: {
    symbol: string;
    label: string;
    modelVersion: number;
    samples: number;
    epochs: number;
    valAcc: number;
    valLoss: number;
    missingContext: number;
    trainDateTo: string | null;
  }[];
  errors: { symbol: string; label: string; error: string }[];
  durationMs: number;
}

/**
 * Train cả 8 tài sản F-17 — 1 tài sản lỗi KHÔNG chặn 7 tài sản còn lại:
 * 2 query nạp bar cả 8 → 1 lời gọi loadMacroContexts cho UNION ngày (hiệu
 * quả hơn 8 lời gọi rời) → tuần tự train từng tài sản (CPU deterministic,
 * tránh 2 fit đè nhau), mỗi tài sản gói try/catch riêng → summary trung thực.
 */
export async function trainAllMacroAssets(): Promise<MacroTrainSummary> {
  const started = Date.now();
  const trained: MacroTrainSummary["trained"] = [];
  const errors: MacroTrainSummary["errors"] = [];
  const barsAll = await loadAllMacroBars();
  const unionDates = new Set<string>();
  for (const bars of barsAll.values()) {
    for (const d of bars.dates) unionDates.add(d);
  }
  let contexts = new Map<string, MacroContext>();
  if (unionDates.size > 0) {
    try {
      contexts = await loadMacroContexts([...unionDates]);
    } catch (err) {
      // Context toàn cục hỏng (DB/macro chưa có) → vẫn train với context 0
      // + missingContext đếm đủ — trung thực, không bỏ cả đợt train.
      console.error("[ml/macro-forecast] loadMacroContexts lỗi (train với context 0):", err);
    }
  }
  for (const spec of ASSET_LABEL_SPEC) {
    const bars = barsAll.get(spec.symbol);
    if (!bars) {
      errors.push({
        symbol: spec.symbol,
        label: spec.label,
        error: "không có instrument/bar active trong DB (chưa seed/sync multi-market)",
      });
      continue;
    }
    try {
      const r = await trainMacroMlpFromSet(bars, contexts);
      trained.push({
        symbol: r.symbol,
        label: r.label,
        modelVersion: r.modelVersion,
        samples: r.metrics.samples,
        epochs: r.metrics.epochs,
        valAcc: r.metrics.valAcc,
        valLoss: r.metrics.valLoss,
        missingContext: r.missingContext,
        trainDateTo: r.trainDateTo,
      });
    } catch (err) {
      console.error(`[ml/macro-forecast] trainMacroMlp(${spec.symbol}) lỗi:`, err);
      errors.push({
        symbol: spec.symbol,
        label: spec.label,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { trained, errors, durationMs: Date.now() - started };
}

/* ─────────────────── Serving + Brier rolling (spec F-17 #4) ─────────────────── */

/** Model mới nhất của một tài sản (chọn theo meta.assetSymbol + version desc). */
interface MacroModelRow {
  id: string;
  version: number;
  weights: string;
  /** AUDIT 137 B6 — meta JSON để đọc holdoutTail/fitDateTo (đánh dấu
   *  brier60Holdout trung thực; bản cũ không có → null). */
  fitDateTo: string | null;
  holdoutTail: number;
}

/**
 * Tìm model MỚI NHẤT cho TỪNG tài sản trong kind dùng chung "macro-mlp"
 * (mọi bản đều archived vì promote:false — KHÔNG đọc status):
 *  (1) quét meta theo version desc (chỉ meta — nhẹ), chỉ nhận bản có
 *      meta.assetSymbol khớp và featureSet === "macro-asset-v1";
 *  (2) nạp weights đúng ≤ 8 row đã chọn (không kéo cả lịch sử weights).
 */
async function latestMacroModels(): Promise<Map<string, MacroModelRow>> {
  const rows = await db.mlModel.findMany({
    where: { kind: MACRO_MODEL_KIND },
    orderBy: { version: "desc" },
    select: { id: true, version: true, meta: true },
    take: MACRO_MODEL_SCAN_LIMIT,
  });
  const pickedId = new Map<string, string>();
  const pickedVersion = new Map<string, number>();
  // AUDIT 137 B6 — đọc kèm fitDateTo/holdoutTail từ meta (fail-soft null/0).
  const pickedFit = new Map<string, { fitDateTo: string | null; holdoutTail: number }>();
  for (const row of rows) {
    let assetSymbol: string | null = null;
    let featureSet: string | null = null;
    let fitDateTo: string | null = null;
    let holdoutTail = 0;
    try {
      const m = JSON.parse(row.meta ?? "{}") as {
        assetSymbol?: unknown;
        featureSet?: unknown;
        fitDateTo?: unknown;
        holdoutTail?: unknown;
      };
      if (typeof m.assetSymbol === "string") assetSymbol = m.assetSymbol;
      if (typeof m.featureSet === "string") featureSet = m.featureSet;
      if (typeof m.fitDateTo === "string") fitDateTo = m.fitDateTo;
      if (typeof m.holdoutTail === "number" && Number.isFinite(m.holdoutTail)) {
        holdoutTail = m.holdoutTail;
      }
    } catch {
      // meta JSON hỏng — bỏ qua row (bản khác cùng tài sản vẫn được xét)
    }
    if (!assetSymbol || pickedId.has(assetSymbol)) continue;
    if (featureSet !== MACRO_FEATURE_SET) continue; // chỉ nhận bộ đặc trưng hiện hành
    pickedId.set(assetSymbol, row.id);
    pickedVersion.set(assetSymbol, row.version);
    pickedFit.set(assetSymbol, { fitDateTo, holdoutTail });
  }
  const out = new Map<string, MacroModelRow>();
  const ids = [...pickedId.values()];
  if (ids.length === 0) return out;
  const withWeights = await db.mlModel.findMany({
    where: { id: { in: ids } },
    select: { id: true, version: true, weights: true },
  });
  const byId = new Map(withWeights.map((w) => [w.id, w]));
  for (const [symbol, id] of pickedId) {
    const w = byId.get(id);
    if (w) {
      const fit = pickedFit.get(symbol) ?? { fitDateTo: null, holdoutTail: 0 };
      out.set(symbol, {
        id,
        version: pickedVersion.get(symbol) ?? w.version,
        weights: w.weights,
        fitDateTo: fit.fitDateTo,
        holdoutTail: fit.holdoutTail,
      });
    }
  }
  return out;
}

/** Một dòng dự báo trong bảng "DỰ BÁO 5 PHIÊN" (8 dòng — buildMacroInner/UI). */
export interface MacroAssetForecast {
  symbol: string;
  /** Nhãn tiếng Việt (ASSET_LABEL_SPEC). */
  label: string;
  /** Hướng argmax của [pUp, pFlat, pDown] — null khi chưa đủ dữ liệu/model. */
  direction: "UP" | "DOWN" | "FLAT" | null;
  pUp: number | null;
  pFlat: number | null;
  pDown: number | null;
  /** max(pUp, pFlat, pDown) — độ tin của giọng argmax. */
  confidence: number | null;
  /** Brier multi-class rolling 60 phiên realized — null = chưa đủ (trung thực). */
  brier60: number | null;
  /** Baseline "đi ngang luôn" uniform 3 lớp = 0,667 (hiển thị so sánh). */
  baseline: number;
  /** true ⇔ brier60 < 0,667 − 0,01 (gate F-17 "đủ cạnh biên"). */
  edge: boolean;
  /** Số phiên realized thực dùng tính Brier60 (≤ 60 — cửa sổ co khi dữ liệu ngắn). */
  brierWindow: number;
  /** AUDIT 137 B6 — true ⇔ cửa sổ Brier60 nằm HOÀN TOÀN sau biên fit của
   *  model (meta.fitDateTo — ngoài mẫu thật); false = trùng vùng model đã
   *  fit; null = bản train trước B6 không ghi biên (không biết — trung thực). */
  brier60Holdout: boolean | null;
  /** Version model đang phục vụ tài sản này — null khi chưa có model. */
  modelVersion: number | null;
  /** Số điểm đánh giá (cửa sổ Brier + phiên serving) KHÔNG có context vĩ mô. */
  missingContext: number;
  /** Ngày phiên cuối của chuỗi bar (neo thời gian của dự báo). */
  lastDate: string | null;
  /** Ghi chú trung thực khi thiếu dữ liệu (không bịa số). */
  note?: string;
}

/** Payload GET/POST /api/ml/macro-forecast. */
export interface MacroForecastPayload {
  /** Ngày phiên MỚI NHẤT trong các tài sản (neo dự báo) — fallback now ISO. */
  asOf: string;
  assets: MacroAssetForecast[];
  /** Ghi chú diễn giải baseline/gate + trạng thái thiếu hụt (N6 trung thực). */
  notes: string[];
}

/** Dòng dự báo rỗng (model/dữ liệu thiếu — mọi chỉ số null, kèm ghi chú). */
function emptyForecast(spec: MacroAssetLabelSpec, note: string, lastDate: string | null = null): MacroAssetForecast {
  return {
    symbol: spec.symbol,
    label: spec.label,
    direction: null,
    pUp: null,
    pFlat: null,
    pDown: null,
    confidence: null,
    brier60: null,
    baseline: MACRO_BRIER_BASELINE_DISPLAY,
    edge: false,
    brierWindow: 0,
    brier60Holdout: null,
    modelVersion: null,
    missingContext: 0,
    lastDate,
    note,
  };
}

/**
 * Brier multi-class của 1 phiên: Σ_c (p_c − o_c)² với class [DOWN, FLAT, UP],
 * p từ predictProba ([pUp, pFlat, pDown] → đảo thứ tự), o one-hot nhãn
 * realized. Baseline uniform [1/3,1/3,1/3] → 2×(1/9) + 4/9 = 2/3 ≈ 0,667.
 */
function brierMultiClass(pUp: number, pFlat: number, pDown: number, realized: number): number {
  const p = [pDown, pFlat, pUp]; // class order [DOWN, FLAT, UP]
  let s = 0;
  for (let c = 0; c < 3; c++) {
    const d = p[c] - (c === realized ? 1 : 0);
    s += d * d;
  }
  return s;
}

/**
 * Dự báo + Brier rolling của MỘT tài sản (đã có model + bar + context):
 *  (1) serving: featureAt PHIÊN CUỐI .slice(0,10) + macroContextVector(
 *      latestMacroContext) → predictProba → direction/confidence;
 *  (2) Brier rolling 60: tái dựng 60 phiên realized GẦN NHẤT (t ≤ n−1−5 để
 *      nhãn 5 phiên tới đã xảy ra) — mỗi phiên forward lại bằng featureAt +
 *      context LỊCH SỬ của đúng ngày đó (map contexts) → Brier multi-class
 *      so nhãn realized → mean. Mọi thứ thiếu → null (trung thực N6).
 */
function forecastAsset(
  spec: MacroAssetLabelSpec,
  bars: MacroAssetBars,
  model: MacroModelRow,
  contexts: Map<string, MacroContext>,
  latestCtx: MacroContext | null
): MacroAssetForecast {
  const n = bars.closes.length;
  const out: MacroAssetForecast = {
    symbol: spec.symbol,
    label: spec.label,
    direction: null,
    pUp: null,
    pFlat: null,
    pDown: null,
    confidence: null,
    brier60: null,
    baseline: MACRO_BRIER_BASELINE_DISPLAY,
    edge: false,
    brierWindow: 0,
    brier60Holdout: null, // AUDIT 137 B6 — tính ở phần Brier bên dưới
    modelVersion: model.version,
    missingContext: 0,
    lastDate: bars.dates[n - 1] ?? null,
  };
  let mlp: MLP;
  try {
    mlp = MLP.fromJSON(model.weights);
  } catch {
    return { ...out, note: `weights JSON hỏng — bỏ qua bản v${model.version}` };
  }
  // Belt-and-braces: weights 16 chiều vào vector 14 chiều sẽ cho NaN âm thầm.
  if (mlp.inputSize !== MACRO_FEATURE_COUNT) {
    return {
      ...out,
      note: `model ${mlp.inputSize} chiều ≠ ${MACRO_FEATURE_COUNT} — featureSet lệch, bỏ qua`,
    };
  }
  const roll = rollingFeatures(bars.closes, bars.volumes);
  let missing = 0;

  // (1) Serving phiên cuối
  const xLast = featureAt(roll, n - 1);
  if (xLast == null) {
    out.note = "chưa đủ warmup 60 phiên cho đặc trưng phiên cuối";
  } else {
    if (latestCtx == null) missing++;
    const x14 = [...xLast.slice(0, MACRO_PRICE_FEATURES), ...macroContextVector(latestCtx)];
    const [pUp, pFlat, pDown] = mlp.predictProba(x14);
    out.pUp = Number(pUp.toFixed(4));
    out.pFlat = Number(pFlat.toFixed(4));
    out.pDown = Number(pDown.toFixed(4));
    out.confidence = Number(Math.max(pUp, pFlat, pDown).toFixed(4));
    out.direction =
      pUp >= pFlat && pUp >= pDown ? "UP" : pDown >= pFlat ? "DOWN" : "FLAT";
  }

  // (2) Brier rolling 60 phiên realized (t ≤ n−1−horizon — nhãn đã xảy ra)
  const tLast = n - 1 - ML_HORIZON_DAYS;
  const tStart = Math.max(ML_WARMUP_BARS - 1, tLast - MACRO_BRIER_WINDOW + 1);
  // AUDIT 137 B6 — trung thực hóa nguồn số: cửa sổ Brier60 nằm HOÀN TOÀN sau
  // biên fit của model (meta.fitDateTo, ghi từ lần train sau B6 — holdout
  // 60 mẫu cuối không vào fit) → ngoài mẫu thật. Bản train TRƯỚC B6 không
  // ghi biên → null (không biết); cửa sổ đè vùng đã fit → false.
  if (model.fitDateTo != null) {
    const winStart = bars.dates[tStart] ?? null;
    out.brier60Holdout = winStart != null ? winStart > model.fitDateTo : null;
  }
  let brierSum = 0;
  let brierCount = 0;
  for (let t = tStart; t <= tLast; t++) {
    const label = macroLabelOf(spec, bars.closes, t);
    const x = featureAt(roll, t);
    if (label == null || x == null) continue;
    const ctx = contexts.get(bars.dates[t]);
    if (ctx == null) missing++;
    const x14 = [...x.slice(0, MACRO_PRICE_FEATURES), ...macroContextVector(ctx)];
    const [pUp, pFlat, pDown] = mlp.predictProba(x14);
    brierSum += brierMultiClass(pUp, pFlat, pDown, label);
    brierCount++;
  }
  out.brierWindow = brierCount;
  if (brierCount > 0) {
    out.brier60 = Number((brierSum / brierCount).toFixed(4));
    // Gate F-17: chỉ "đủ cạnh biên" khi thắng baseline với biên 0,01.
    out.edge = out.brier60 < MACRO_BRIER_BASELINE - MACRO_EDGE_MARGIN;
  } else if (out.direction != null) {
    out.note = "chưa đủ phiên realized để tính Brier rolling (cần phiên t+5 đã đóng)";
  }
  out.missingContext = missing;
  return out;
}

/**
 * Serving 8 tài sản (spec F-17 #4): mỗi tài sản — model mới nhất theo
 * meta.assetSymbol (version desc, featureSet khớp) → dự báo phiên cuối +
 * Brier rolling 60 phiên → {symbol, label, direction, p*, confidence,
 * brier60, baseline 0,667, edge, modelVersion, missingContext}. Fail-soft
 * TỪNG tài sản (1 tài sản lỗi không chặn bảng); model/dữ liệu thiếu → null
 * + ghi chú. Context: 1 lời gọi loadMacroContexts cho union cửa sổ Brier
 * của mọi tài sản có model + latestMacroContext() cho phiên serving.
 */
export async function macroAssetForecasts(): Promise<MacroForecastPayload> {
  const notes: string[] = [];
  const barsAll = await loadAllMacroBars();
  const models = await latestMacroModels();

  // Ngày cần context lịch sử: cửa sổ Brier 60 phiên của mọi tài sản CÓ model.
  const brierDates = new Set<string>();
  for (const spec of ASSET_LABEL_SPEC) {
    const bars = barsAll.get(spec.symbol);
    if (!bars || !models.has(spec.symbol)) continue;
    const tLast = bars.closes.length - 1 - ML_HORIZON_DAYS;
    const tStart = Math.max(ML_WARMUP_BARS - 1, tLast - MACRO_BRIER_WINDOW + 1);
    for (let t = tStart; t <= tLast; t++) brierDates.add(bars.dates[t]);
  }
  let contexts = new Map<string, MacroContext>();
  try {
    if (brierDates.size > 0) contexts = await loadMacroContexts([...brierDates]);
  } catch (err) {
    console.error("[ml/macro-forecast] loadMacroContexts lỗi (Brier dùng context 0):", err);
    notes.push("Bối cảnh vĩ mô lịch sử không tải được — Brier rolling tính với context 0.");
  }
  let latestCtx: MacroContext | null = null;
  try {
    latestCtx = await latestMacroContext();
  } catch (err) {
    console.error("[ml/macro-forecast] latestMacroContext lỗi (serving dùng context 0):", err);
    notes.push("Bối cảnh vĩ mô phiên cuối không tải được — dự báo phiên cuối dùng context 0.");
  }

  const assets: MacroAssetForecast[] = [];
  for (const spec of ASSET_LABEL_SPEC) {
    const bars = barsAll.get(spec.symbol);
    const lastDate = bars ? (bars.dates[bars.dates.length - 1] ?? null) : null;
    if (!bars) {
      assets.push(
        emptyForecast(spec, "chưa có dữ liệu bar (instrument chưa seed/sync multi-market)")
      );
      continue;
    }
    const model = models.get(spec.symbol);
    if (!model) {
      assets.push(
        emptyForecast(
          spec,
          'chưa train model macro-mlp cho tài sản này — POST /api/ml/macro-forecast {"train": true}',
          lastDate
        )
      );
      continue;
    }
    try {
      assets.push(forecastAsset(spec, bars, model, contexts, latestCtx));
    } catch (err) {
      console.error(`[ml/macro-forecast] forecastAsset(${spec.symbol}) lỗi:`, err);
      assets.push(
        emptyForecast(
          spec,
          `lỗi dự báo: ${err instanceof Error ? err.message : String(err)}`,
          lastDate
        )
      );
    }
  }

  // asOf = ngày phiên mới nhất trong các tài sản (neo dự báo) — fallback now.
  const lastDates = assets
    .map((a) => a.lastDate)
    .filter((d): d is string => d != null)
    .sort();
  const asOf = lastDates.length > 0 ? lastDates[lastDates.length - 1] : new Date().toISOString();

  notes.push(
    `Baseline "đi ngang luôn" (uniform 3 lớp): Brier = ${MACRO_BRIER_BASELINE_DISPLAY.toFixed(3)} — tài sản chỉ đạt edge khi Brier60 < ${(MACRO_BRIER_BASELINE - MACRO_EDGE_MARGIN).toFixed(3)} (gate F-17).`
  );
  const noModel = assets.filter((a) => a.modelVersion == null).length;
  if (noModel > 0) {
    notes.push(
      `${noModel}/${ASSET_LABEL_SPEC.length} tài sản chưa có model macro-mlp — POST /api/ml/macro-forecast với body {"train": true} để huấn luyện.`
    );
  }
  const withModel = assets.filter((a) => a.modelVersion != null);
  if (withModel.length > 0 && withModel.every((a) => !a.edge)) {
    notes.push(
      "Chưa tài sản nào đạt cạnh biên so baseline (N6 trung thực — gate F-17: ≥ 2 tài sản đạt mới tính là chức năng sống)."
    );
  }
  // AUDIT 137 B6 — ghi chú nguồn Brier60: model train sau B6 reserve 60 mẫu
  // cuối làm holdout (brier60Holdout=true ⇔ ngoài mẫu thật); còn lại đo trên
  // vùng chưa xác minh ngoài mẫu — không để bảng "DỰ BÁO 5 PHIÊN" đọc như
  // track record sạch khi chưa retrain.
  const notHoldout = withModel.filter((a) => a.brier60Holdout !== true).length;
  if (notHoldout > 0) {
    notes.push(
      `${notHoldout}/${withModel.length} tài sản đo Brier60 trên vùng chưa xác minh ngoài mẫu (audit 137 B6: bản train trước B6 chưa reserve holdout 60 phiên — retrain để trung thực hóa).`
    );
  }
  return { asOf, assets, notes };
}
