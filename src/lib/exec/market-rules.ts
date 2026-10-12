/**
 * src/lib/exec/market-rules.ts — E-EXEC #107 (COUNCIL_STEWARDSHIP_BLUEPRINT
 * v2.0 §5): LUẬT VI MÔ TỪNG THỊ TRƯỜNG cho sandbox đa thị trường — lệnh thử
 * nghiệm của Hội đồng được đặt trên CP VN (HOSE/HNX/UPCOM, giữ nguyên luật
 * lot-100 hiện hành), CP Mỹ/HK, trái phiếu Mỹ, forex, hàng hoá — tất cả từ
 * MỘT khoản tiền sandbox K1 (kế toán MỘT đồng tiền VND, blueprint §5.4).
 *
 * Nguyên tắc trung thực:
 *  · KHÔNG bịa giá phi-VN — khớp tại close EOD đã sync (Quote neo Bar thật).
 *  · Kế toán 1 tiền VND: tài sản USD/HKD quy VND qua USD/VND (VND=X);
 *    biến động USD/VND là lãi/lỗ TRỰC TIẾP của mọi vị thế quốc tế.
 *  · Tài sản DANH NGHĨA (trái phiếu/hàng hoá): 1 đơn vị = 1.000.000₫ triển
 *    khai tại lúc mua, giá trị theo sau chỉ số giá trị VND của tài sản gốc
 *    (hàng hoá: spot×fx; trái phiếu: mô hình duration −D·Δy+carry + fx).
 *    Blueprint §5.2-5.3 gốc định nghĩa hợp đồng thật × hệ số — nhưng hợp đồng
 *    đầy đủ (vd GC=F 100 oz ≈ 10,8 tỷ₫) KHÔNG mua nổi trên tài khoản 100tr₫
 *    (no-margin full-value) → chuyển sang đơn vị danh nghĩa 1tr₫/đv (ghi rõ
 *    §7.5a blueprint + worklog #107 — phục vụ đúng ý đồ "agents đầu tư từ
 *    khoản tiền thử nghiệm vào mọi thị trường").
 *  · CP Mỹ/HK: 1 đơn vị = 0,01 cp (fractional shares kiểu broker hiện đại)
 *    để định cỡ 5% NAV mua nổi cả mega-cap (AAPL ≈ 5,9tr₫/cp).
 *  · Forex: 1 đơn vị = 1 đơn vị tiền gốc, lot nano 100 (2 pip spread).
 */

import { db } from "@/lib/db";
import { unitKindOf } from "@/lib/format";

// ─────────────────────────────────────────────────────────────────
// Hằng số mô hình
// ─────────────────────────────────────────────────────────────────

/** 1 đơn vị danh nghĩa = 1.000.000₫ triển khai (trái phiếu + hàng hoá). */
export const NOTIONAL_UNIT_VND = 1_000_000;

/** Peg HKD/USD cố định 7,8 (không mô phỏng dải peg — blueprint §7.5). */
export const HKD_USD_PEG = 7.8;

/** Duration hiệu dụng theo tenor (mô hình trái phiếu §2.4 baskets.ts). */
export const BOND_DURATION: Record<string, number> = { US5Y: 4.5, US10Y: 8, US30Y: 17 };

/** Cặp forex ĐƯỢC đặt lệnh sandbox (USDJPY=X + DXY = chỉ tham chiếu §5.1). */
export const TRADABLE_FOREX_SYMBOLS = new Set(["EURUSD=X", "AUDUSD=X", "VND=X"]);

/** Đơn vị lệnh tối thiểu của từng loại tài sản (§5.2 + tinh chỉnh §7.5a). */
export const MIN_QTY = {
  VN: 100, // lot 100 cp (luật thật — KHÔNG đổi)
  US: 1, // 1 đv = 0,01 cp
  HK: 1, // 1 đv = 0,01 cp
  FOREX: 100, // lot nano 100 đv tiền gốc
  NOTIONAL: 1, // 1 đv danh nghĩa 1tr₫
} as const;

// ─────────────────────────────────────────────────────────────────
// Luật vi mô
// ─────────────────────────────────────────────────────────────────

/** Loại tài sản theo cách định giá + kế toán vị thế. */
export type ExecAssetKind =
  | "VN_PRICE" // HOSE/HNX/UPCOM: qty cp · giá VND · avgPrice (luật hiện hành)
  | "PRICE" // cp Mỹ/HK, forex: qty đv · giá DB native · avgCostVND (VND/đv)
  | "NOTIONAL"; // trái phiếu/hàng hoá: qty đv danh nghĩa · openIdxUnits

export interface ExecRule {
  sessionKind: "VN" | "US" | "HK" | "FX245";
  assetKind: ExecAssetKind;
  lotStep: number;
  minQty: number;
  /** Phí trên notional VND (0 = không phí; forex dùng feePipVND thay thế). */
  feeRate: number;
  /** Forex: phí VND trên MỖI đơn vị qty (spread 2 pip). */
  feePipVND: number | null;
  /** Băng trần/sàn ±7% — chỉ VN. */
  hasBand: boolean;
}

const RULE_VN: ExecRule = {
  sessionKind: "VN", assetKind: "VN_PRICE", lotStep: 100, minQty: MIN_QTY.VN,
  feeRate: 0.0015, feePipVND: null, hasBand: true,
};
const RULE_US: ExecRule = {
  sessionKind: "US", assetKind: "PRICE", lotStep: 1, minQty: MIN_QTY.US,
  feeRate: 0.0002, feePipVND: null, hasBand: false,
};
const RULE_HK: ExecRule = {
  sessionKind: "HK", assetKind: "PRICE", lotStep: 1, minQty: MIN_QTY.HK,
  feeRate: 0.001, feePipVND: null, hasBand: false,
};
const RULE_FOREX: ExecRule = {
  sessionKind: "FX245", assetKind: "PRICE", lotStep: 100, minQty: MIN_QTY.FOREX,
  feeRate: 0, feePipVND: null, hasBand: false, // feePipVND phụ thuộc từng cặp — xem foreignFeeVND
};
const RULE_BOND: ExecRule = {
  sessionKind: "US", assetKind: "NOTIONAL", lotStep: 1, minQty: MIN_QTY.NOTIONAL,
  feeRate: 0, feePipVND: null, hasBand: false,
};
const RULE_CMDTY: ExecRule = {
  sessionKind: "FX245", assetKind: "NOTIONAL", lotStep: 1, minQty: MIN_QTY.NOTIONAL,
  feeRate: 0.0003, feePipVND: null, hasBand: false,
};

/** Instrument tối thiểu cần cho mọi tra cứu trong file này. */
export interface InstrumentLite {
  symbol: string;
  market: string;
  type: string;
  currency?: string | null;
}

/** Có phải thị trường phi-VN (US/HK/BOND/FOREX/COMMODITY)? */
export function isForeignMarket(market: string): boolean {
  return market === "US" || market === "HK" || market === "BOND" || market === "FOREX" || market === "COMMODITY";
}

/**
 * Luật vi mô của instrument — null = KHÔNG đặt lệnh sandbox được
 * (INDEX mọi sàn · DXY · USDJPY=X tham chiếu §5.1).
 */
export function execRuleFor(inst: InstrumentLite): ExecRule | null {
  const { market, type, symbol } = inst;
  if (type === "INDEX") return null;
  switch (market) {
    case "HOSE":
    case "HNX":
    case "UPCOM":
      return RULE_VN;
    case "US":
      return type === "STOCK" || type === "ETF" ? RULE_US : null;
    case "HK":
      return type === "STOCK" || type === "ETF" ? RULE_HK : null;
    case "BOND":
      return type === "BOND" ? RULE_BOND : null;
    case "FOREX":
      return type === "FX" && TRADABLE_FOREX_SYMBOLS.has(symbol) ? RULE_FOREX : null;
    case "COMMODITY":
      return type === "CMDTY" ? RULE_CMDTY : null;
    default:
      return null;
  }
}

/** Instrument có thể SINH TÍN HIỆU + đặt lệnh sandbox? (dùng cho map prompt.) */
export function isTradableSandboxInstrument(inst: InstrumentLite): boolean {
  return execRuleFor(inst) != null;
}

/** Nhãn đơn vị lệnh cho UI + prompt. */
export function execUnitLabel(inst: InstrumentLite): string {
  if (!isForeignMarket(inst.market)) return "cp";
  if (inst.market === "BOND" || inst.market === "COMMODITY") return "đv danh nghĩa 1tr₫";
  if (inst.market === "FOREX") return "đv tiền gốc";
  return "đv (0,01 cp)";
}

// ─────────────────────────────────────────────────────────────────
// USD/VND (VND=X) — 1 tỷ giá, cache 60s
// ─────────────────────────────────────────────────────────────────

let fxCache: { at: number; rate: number | null } = { at: 0, rate: null };

/** Tỷ giá USD/VND mới nhất (VND/USD) từ Bar VND=X (fallback Quote) — cache 60s. */
export async function usdVndRate(): Promise<number | null> {
  if (fxCache.rate != null && Date.now() - fxCache.at < 60_000) return fxCache.rate;
  try {
    const inst = await db.instrument.findFirst({
      where: { isActive: true, symbol: "VND=X" },
      select: { id: true },
    });
    if (!inst) return null;
    const [bar, quote] = await Promise.all([
      db.bar.findFirst({ where: { instrumentId: inst.id }, orderBy: { date: "desc" }, select: { close: true } }),
      db.quote.findFirst({ where: { instrumentId: inst.id }, orderBy: { tradedAt: "desc" }, select: { last: true } }),
    ]);
    // FX_RATE ×10.000 → rate thật = close/10^4
    const raw = bar?.close ?? quote?.last ?? null;
    const rate = raw != null && raw > 0 ? raw / 10_000 : null;
    fxCache = { at: Date.now(), rate };
    return rate;
  } catch {
    return fxCache.rate; // fail-soft: dùng cache cũ nếu có
  }
}

// ─────────────────────────────────────────────────────────────────
// Giá trị VND của 1 đơn vị qty — tài sản GIÁ (cp qtế + forex)
// ─────────────────────────────────────────────────────────────────

/**
 * Giá trị VND của MỘT đơn vị lệnh theo giá DB native + tỷ giá cho trước.
 * Trả null khi không xác định được (thiếu fx cho tài sản USD/HKD).
 *  · US:STOCK/ETF — giá cents USD, 1 đv = 0,01 cp → (price/100)×fx/100
 *  · HK:STOCK/ETF — giá cents HKD, 1 đv = 0,01 cp → (price/100)/7,8×fx/100
 *  · FOREX VND=X — price×10⁴ = VND/USD, 1 đv = 1 USD → price/10⁴ (VND, không cần fx)
 *  · FOREX khác — price×10⁴ = USD/đv gốc, 1 đv = 1 đv gốc → (price/10⁴)×fx
 */
export function foreignPriceUnitValueVND(
  inst: InstrumentLite,
  priceDb: number,
  fxRate: number | null
): number | null {
  if (priceDb <= 0) return null;
  switch (inst.market) {
    case "US":
      return fxRate != null ? (priceDb / 100) * fxRate / 100 : null;
    case "HK":
      return fxRate != null ? (priceDb / 100) / HKD_USD_PEG * fxRate / 100 : null;
    case "FOREX": {
      const rate = priceDb / 10_000;
      if (inst.symbol === "VND=X") return rate; // đã là VND/USD
      return fxRate != null ? rate * fxRate : null;
    }
    default:
      return null;
  }
}

/** Bản bọc async (tự lấy fx, cache) — dùng nơi không có sẵn tỷ giá. */
export async function foreignUnitValueVND(inst: InstrumentLite, priceDb: number): Promise<number | null> {
  if (inst.symbol === "VND=X") return foreignPriceUnitValueVND(inst, priceDb, null);
  const fx = await usdVndRate();
  return foreignPriceUnitValueVND(inst, priceDb, fx);
}

/**
 * Phí VND một lệnh (không thuế ngoài VN — thuế 0,1% chỉ luật VN).
 * Forex: spread 2 pip — cặp tỷ giá 0,0002 USD/đv gốc ×fx; VND=X 2₫/USD.
 */
export function foreignFeeVND(
  inst: InstrumentLite,
  rule: ExecRule,
  qty: number,
  notionalVND: number,
  fxRate: number | null
): number {
  if (inst.market === "FOREX") {
    if (inst.symbol === "VND=X") return Math.round(qty * 2); // 2₫/USD
    return fxRate != null ? Math.round(qty * 0.0002 * fxRate) : 0; // 2 pip
  }
  return Math.round(rule.feeRate * notionalVND);
}

// ─────────────────────────────────────────────────────────────────
// Chỉ số giá trị VND (idx) — tài sản DANH NGHĨA (trái phiếu + hàng hoá)
// ─────────────────────────────────────────────────────────────────

export interface IdxPoint {
  date: string; // ISO YYYY-MM-DD (Bar 15:00 UTC convention)
  idx: number; // base 1.0 tại bar đầu tiên
}

/** Chuỗi bar VND=X (ISO → rate VND/USD) — cache 60s, dùng chung mọi symbol. */
let vndxSeriesCache: { at: number; series: Array<{ date: string; rate: number }> } = { at: 0, series: [] };

async function vndxSeries(): Promise<Array<{ date: string; rate: number }>> {
  if (vndxSeriesCache.series.length > 0 && Date.now() - vndxSeriesCache.at < 60_000) {
    return vndxSeriesCache.series;
  }
  const inst = await db.instrument.findFirst({
    where: { isActive: true, symbol: "VND=X" },
    select: { id: true },
  });
  if (!inst) return vndxSeriesCache.series;
  const bars = await db.bar.findMany({
    where: { instrumentId: inst.id },
    orderBy: { date: "asc" },
    select: { date: true, close: true },
  });
  const series = bars.map((b) => ({
    date: b.date.toISOString().slice(0, 10),
    rate: b.close > 0 ? b.close / 10_000 : 0,
  })).filter((p) => p.rate > 0);
  vndxSeriesCache = { at: Date.now(), series };
  return series;
}

/** idx của một symbol (cache 5 phút — bar chỉ đổi 1 lần/ngày sau sync). */
const idxCache = new Map<string, { at: number; series: IdxPoint[] }>();
const IDX_TTL_MS = 5 * 60_000;

/**
 * Chỉ số giá trị VND của tài sản gốc, base 1.0 tại bar ĐẦU TIÊN của symbol:
 *  · COMMODITY — idx_d = (close_d × fx_d) / (close_0 × fx_0) (spot USD × USD/VND;
 *    hệ số cents ×100 tự triệt tiêu trong tỉ số).
 *  · BOND — lũy kế hằng ngày r_vnd = (1 + (−D·Δy + y_{d−1}/252)) × (1 + r_fx) − 1
 *    (mô hình duration §2.4 + thành phần tỷ giá — trái phiếu là tài sản USD).
 * Ngày thiếu fx → dùng fx gần nhất trước đó (carry-forward, ghi trung thực).
 */
export async function notionalIdxSeries(symbol: string): Promise<IdxPoint[]> {
  const hit = idxCache.get(symbol);
  if (hit && Date.now() - hit.at < IDX_TTL_MS) return hit.series;
  const inst = await db.instrument.findFirst({
    where: { isActive: true, symbol },
    select: { id: true, market: true },
  });
  if (!inst) return [];
  const [bars, fx] = await Promise.all([
    db.bar.findMany({
      where: { instrumentId: inst.id },
      orderBy: { date: "asc" },
      select: { date: true, close: true },
    }),
    vndxSeries(),
  ]);
  const fxByDate = new Map(fx.map((p) => [p.date, p.rate]));
  const series: IdxPoint[] = [];
  let lastFx: number | null = null;
  if (inst.market === "COMMODITY") {
    let base: number | null = null;
    for (const b of bars) {
      const d = b.date.toISOString().slice(0, 10);
      const f: number | null = fxByDate.get(d) ?? lastFx;
      if (f != null) lastFx = f;
      const vnd = b.close * (f ?? 0); // close (cents) × fx — tỉ số tự huỷ hệ số
      if (base == null && vnd > 0) base = vnd;
      if (base != null && vnd > 0) series.push({ date: d, idx: vnd / base });
    }
  } else if (inst.market === "BOND") {
    const D = BOND_DURATION[symbol] ?? 8;
    let idx = 1;
    let prevY: number | null = null;
    let prevFx: number | null = null;
    let started = false;
    for (const b of bars) {
      const d = b.date.toISOString().slice(0, 10);
      const y = b.close / 100; // BOND_PCT → lợi suất thập phân
      const f: number | null = fxByDate.get(d) ?? lastFx;
      if (f != null) lastFx = f;
      if (!started) {
        // bar đầu: neo idx = 1 (không có Δy ngày 0)
        started = true;
        series.push({ date: d, idx });
        prevY = y;
        prevFx = f ?? null;
        continue;
      }
      if (y > 0 && prevY != null) {
        const rUsd = -D * (y - prevY) + prevY / 252; // −D·Δy + carry
        const rFx = f != null && prevFx != null && prevFx > 0 ? f / prevFx - 1 : 0;
        idx = idx * (1 + rUsd) * (1 + rFx);
      }
      series.push({ date: d, idx });
      prevY = y > 0 ? y : prevY;
      prevFx = f ?? prevFx;
    }
  }
  idxCache.set(symbol, { at: Date.now(), series });
  return series;
}

/** idx MỚI NHẤT (để khớp/định giá) — null khi symbol chưa có bar. */
export async function notionalIdxLatest(symbol: string): Promise<number | null> {
  const s = await notionalIdxSeries(symbol);
  return s.length > 0 ? s[s.length - 1].idx : null;
}

/** idx tại ngày ISO cho trước (điểm cuối ≤ date) — null khi chưa có dữ liệu. */
export async function notionalIdxAtDate(symbol: string, dateIso: string): Promise<number | null> {
  const s = await notionalIdxSeries(symbol);
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i].date <= dateIso) return s[i].idx;
  }
  return null;
}

/** Tỷ giá USD/VND tại ngày ISO cho trước (bar VND=X cuối ≤ date) — null khi thiếu. */
export async function usdVndAtDate(dateIso: string): Promise<number | null> {
  try {
    const inst = await db.instrument.findFirst({
      where: { isActive: true, symbol: "VND=X" },
      select: { id: true },
    });
    if (!inst) return null;
    // Bar neo 15:00 UTC (cuối ngày ICT) — so le 12h để lấy bar CỦA ngày đó
    const bar = await db.bar.findFirst({
      where: {
        instrumentId: inst.id,
        date: { lte: new Date(`${dateIso}T23:59:59Z`) },
      },
      orderBy: { date: "desc" },
      select: { close: true },
    });
    return bar && bar.close > 0 ? bar.close / 10_000 : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// Định giá vị thế (đùng cho equity/portfolio/vision/overview)
// ─────────────────────────────────────────────────────────────────

export interface MarkPositionInput {
  quantity: number;
  avgPrice: number;
  avgCostVND: bigint | null;
  openIdxUnits: bigint | null;
  instrument: InstrumentLite;
  /**
   * Giá DB native để đánh giá (tick VN hoặc Quote.last/Bar close tuỳ caller).
   * VN bắt buộc; PRICE dùng cho giá native; NOTIONAL chỉ để hiển thị.
   */
  lastNative: number | null;
}

export interface MarkPositionResult {
  kind: ExecAssetKind;
  /** Giá trị thị trường VND của vị thế. */
  valueVND: number;
  /** Lãi/lỗ chưa thực hiện VND (null khi không đủ dữ liệu tính vốn). */
  unrealisedVND: number | null;
  /** Giá native đang đánh giá (hiển thị). */
  nativePrice: number | null;
  /** Giá trị VND của 1 đơn vị lệnh (tài sản GIÁ phi-VN). */
  unitValueVND: number | null;
  /** Tỷ giá USD/VND đã áp dụng (null = không cần / thiếu). */
  fxRate: number | null;
}

/** Định giá MỘT vị thế — tự phân lớp theo instrument. Fail-soft trả value 0. */
export async function markPositionVND(pos: MarkPositionInput): Promise<MarkPositionResult> {
  const inst = pos.instrument;
  if (!isForeignMarket(inst.market)) {
    // VN: giữ nguyên toán hiện hành (avgPrice VND)
    const last = pos.lastNative;
    const value = last != null && last > 0 ? last * pos.quantity : 0;
    const upl = last != null && last > 0 ? (last - pos.avgPrice) * pos.quantity : null;
    return { kind: "VN_PRICE", valueVND: value, unrealisedVND: upl, nativePrice: last ?? null, unitValueVND: null, fxRate: null };
  }
  if (inst.market === "BOND" || inst.market === "COMMODITY") {
    // NOTIONAL: value = openIdxUnits × idx/10^6 (cost 1tr₫/đv)
    const idx = await notionalIdxLatest(inst.symbol);
    const value = pos.openIdxUnits != null && idx != null
      ? (Number(pos.openIdxUnits) * idx) / 1e6
      : pos.quantity * NOTIONAL_UNIT_VND; // fallback trung thực khi chưa có bar
    const cost = pos.quantity * NOTIONAL_UNIT_VND;
    return {
      kind: "NOTIONAL", valueVND: value, unrealisedVND: value - cost,
      nativePrice: pos.lastNative, unitValueVND: null, fxRate: null,
    };
  }
  // PRICE (cp qtế + forex)
  const fx = await usdVndRate();
  const unit = pos.lastNative != null ? foreignPriceUnitValueVND(inst, pos.lastNative, fx) : null;
  const value = unit != null ? unit * pos.quantity : 0;
  const upl = unit != null && pos.avgCostVND != null
    ? value - Number(pos.avgCostVND) * pos.quantity
    : null;
  return { kind: "PRICE", valueVND: value, unrealisedVND: upl, nativePrice: pos.lastNative, unitValueVND: unit, fxRate: fx };
}

/** Định giá nhiều vị thế 1 lượt (fx/idx cache dùng chung trong process). */
export async function markPositionsVND(list: MarkPositionInput[]): Promise<{ mv: number; upl: number }> {
  let mv = 0;
  let upl = 0;
  for (const p of list) {
    const r = await markPositionVND(p);
    mv += r.valueVND;
    if (r.unrealisedVND != null) upl += r.unrealisedVND;
  }
  return { mv, upl };
}

// ─────────────────────────────────────────────────────────────────
// Vũ trụ giao dịch được (cho khối prompt VŨ TRỤ GIAO DỊCH §5.5)
// ─────────────────────────────────────────────────────────────────

export interface TradableForeignRow {
  symbol: string;
  market: string;
  type: string;
  name: string;
  last: number;
  prevClose: number | null;
  unitKind: string;
}

/**
 * Liệt kê instrument PHI-VN đặt lệnh được + giá close + close phiên trước
 * (đổi ngày %) — nguồn cho khối prompt VŨ TRỤ GIAO DỊCH. Chỉ trả mã có
 * Quote.last > 0 (không giới thiệu mã chưa có dữ liệu — trung thực).
 */
export async function listTradableForeign(): Promise<TradableForeignRow[]> {
  const insts = await db.instrument.findMany({
    where: {
      isActive: true,
      market: { in: ["US", "HK", "BOND", "FOREX", "COMMODITY"] },
      type: { in: ["STOCK", "ETF", "BOND", "FX", "CMDTY"] },
    },
    select: { id: true, symbol: true, market: true, type: true, name: true },
  });
  const tradable = insts.filter((i) => execRuleFor(i) != null);
  if (tradable.length === 0) return [];
  const ids = tradable.map((i) => i.id);
  const [quotes, bars] = await Promise.all([
    db.quote.findMany({
      where: { instrumentId: { in: ids }, last: { gt: 0 } },
      orderBy: { tradedAt: "desc" },
      distinct: ["instrumentId"],
      select: { instrumentId: true, last: true },
    }),
    db.bar.findMany({
      where: { instrumentId: { in: ids } },
      orderBy: { date: "desc" },
      select: { instrumentId: true, date: true, close: true },
      take: ids.length * 3, // 3 bar mới nhất mỗi mã (đủ lấy prevClose)
    }),
  ]);
  const lastById = new Map(quotes.map((q) => [q.instrumentId, q.last]));
  const barsByInst = new Map<string, number[]>();
  for (const b of bars) {
    const arr = barsByInst.get(b.instrumentId) ?? [];
    if (arr.length < 2) arr.push(b.close); // desc — [0]=mới nhất, [1]=trước
    barsByInst.set(b.instrumentId, arr);
  }
  const out: TradableForeignRow[] = [];
  for (const i of tradable) {
    const last = lastById.get(i.id);
    if (last == null || last <= 0) continue;
    const closes = barsByInst.get(i.id) ?? [];
    out.push({
      symbol: i.symbol,
      market: i.market,
      type: i.type,
      name: i.name,
      last,
      prevClose: closes[1] ?? null,
      unitKind: unitKindOf(i.market, i.type),
    });
  }
  return out;
}
