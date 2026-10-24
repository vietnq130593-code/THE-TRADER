/**
 * src/lib/eod-sync.ts — ĐỒNG BỘ EOD THẬT TỪ VNDIRECT dchart-api (Tier 1 —
 * DATA_SOURCES.md §3.1, public endpoint KHÔNG cần auth).
 *
 * Nguồn: GET https://dchart-api.vndirect.com.vn/dchart/history
 *          ?symbol=VCB&resolution=D&from=<unix-sec>&to=<unix-sec>
 *        → JSON {t[], o[], h[], l[], c[], v[], s:"ok"} (Content-Type
 *          text/plain dù body là JSON — parse thủ công, Gen-1 §3.1)
 *        → GIÁ TRẢ VỀ ĐƠN VỊ NGHÌN VND (VCB 57.3 = 57.300₫) — ×1000 khi ingest.
 *        → t = nửa đêm UTC của ngày giao dịch (đã đối chiếu public.market_data).
 *
 * Golden signature (Gen-1 collectors/vndirect.ts §11 — giữ nguyên chuẩn):
 *   keys ["t","o","h","l","c","v","s"] · s === "ok" · 3 error shapes đã đo:
 *   body rỗng = không có dữ liệu (hợp lệ) · "Not support resolution" = lỗi cấu
 *   hình · 5xx/timeout = retry có backoff.
 *
 * Validate §5 (DATA_SOURCES.md): Q1 bội 100₫ · Q2 dải ±7% không áp cho EOD
 * lịch sử (giá đóng cửa thật có thể vượt dải mô phỏng của ngày khác) · Q3
 * volume ≥ 0 · Q4 upsert idempotent theo @@unique([instrumentId, date]) ·
 * Q6 t UTC → Bar.date 15:00 UTC (convention tick route) · Q7 bỏ T7/CN.
 *
 * Sau khi đồng bộ bar, Quote được NEO LẠI vào EOD thật: refPrice = close phiên
 * trước · OHLC = bar cuối · change/changePct tính từ ref thật · dải trần/sàn
 * ±7% mở theo ref thật · volume = KLGD thật. Intraday tick (nếu bật) chỉ còn
 * vai trò mô phỏng quanh mức thật và luôn gắn nhãn mode="simulated".
 *
 * Dùng bởi: POST /api/market/eod-sync (daily + manual) · prisma/import-real-eod.ts
 * (deep backfill 2013→nay + rebase danh mục) · market-engine scheduler 15:45 ICT.
 */

import { db } from "@/lib/db";
import { reapplyAutoAdjustments } from "@/lib/corporate-events";
import { markSource } from "@/lib/sources";
import { invalidateFeatureCache, TOPBYADTV_CACHE_PREFIX } from "@/lib/feature-cache";
import type { UnitSpec } from "@/lib/types";
import { vnDateIso } from "@/lib/market-session";

export const DCHART_BASE =
  process.env.DCHART_BASE_URL ?? "https://dchart-api.vndirect.com.vn";

/** Giới hạn giá hợp lệ STOCK/ETF VN sau ×1000 (VND) — VN30 adjusted 2013→nay. */
const PRICE_MIN_VND = 500;
const PRICE_MAX_VND = 5_000_000;

/** Khoảng cách tối thiểu giữa 2 request dchart (tôn trọng nguồn công cộng). */
const REQUEST_INTERVAL_MS = 300;

/** Số request tối đa trong 1 chu kỳ sync (B4 — 30 HOSE + 21 HNX + ~10 UPCOM
 *  + 5 ETF + 8 index + dự phòng; quốc tế sync riêng qua intl-eod.ts). */
const MAX_SYMBOLS_PER_SYNC = 150;

/* ══════════ B2 · UNITSPEC — bảng tra đơn vị theo (market × type) §3.2 ══════════
 *
 * SINGLE SOURCE OF TRUTH cho biến đổi giá khi ingest (dchart trả cổ phiếu
 * theo nghìn VND nhưng index theo điểm thô — đo thực tế 2026-10-07 §2.1).
 * KHÔNG có cột đơn vị trong Instrument — mọi module tra về đây:
 *   STOCK/ETF VN  : nghìn VND → ×1000 → round100 → VND nguyên (khớp #33).
 *   INDEX VN/QT   : điểm thô  → ×100  → nguyên   → điểm×100 (VNINDEX 1753,39 → 175.339).
 *   STOCK/ETF QT  : USD/HKD  → ×100  → nguyên   → cents (AAPL 231,4 → 23.140).
 *   BOND (tương lai): % mệnh giá → ×100 → %×100.
 */
const UNIT_VND: UnitSpec = {
  kind: "VND",
  multiplier: 1000,
  roundTo: 100,
  minPrice: PRICE_MIN_VND,
  maxPrice: PRICE_MAX_VND,
  hasPriceBand: true,
  tickUnit: 100,
};
const UNIT_INDEX: UnitSpec = {
  kind: "INDEX_POINT",
  multiplier: 100,
  roundTo: 1,
  minPrice: 100, // 1 điểm
  maxPrice: 10_000_000, // 100.000 điểm×100 — trùm mọi index VN/QT
  hasPriceBand: false, // index KHÔNG có trần/sàn ±7%
  tickUnit: 10, // 0,1 điểm index = 10 đơn vị DB
};
const UNIT_CENTS: UnitSpec = {
  kind: "CENTS",
  multiplier: 100,
  roundTo: 1,
  minPrice: 100, // 1 USD/HKD
  maxPrice: 5_000_000, // 50.000 USD/HKD
  hasPriceBand: false, // quốc tế KHÔNG có trần/sàn ±7% kiểu VN
  tickUnit: 1,
};
export const UNIT_BOND: UnitSpec = {
  kind: "BOND_PCT",
  multiplier: 100,
  roundTo: 1,
  minPrice: 100, // 1% mệnh giá
  maxPrice: 10_000, // 100% mệnh giá
  hasPriceBand: false,
  tickUnit: 1,
};
// #106 COUNCIL_STEWARDSHIP_BLUEPRINT §2.1 — cặp ngoại hối: tỷ giá thô
// (EURUSD 1,0852 · USD/VND 25.886) ×10.000 → Int (10.852 · 258.860.000).
// minPrice 1 = 0,0001 — cận dưới hợp lệ mọi cặp; maxPrice 1 tỷ đơn vị DB
// = 100.000 đồng vị giá thô — trùm USD/VND (Int32 an toàn: ≤ 2,147 tỷ).
export const UNIT_FX: UnitSpec = {
  kind: "FX_RATE",
  multiplier: 10_000,
  roundTo: 1,
  minPrice: 1,
  maxPrice: 1_000_000_000,
  hasPriceBand: false, // forex không có trần/sàn kiểu VN
  tickUnit: 1, // 0,0001 tỷ giá = 1 đơn vị DB
};

/** Bảng tra (market:type) → UnitSpec — key thường hoa như enum Prisma. */
export const UNIT_SPECS: Record<string, UnitSpec> = {
  "HOSE:STOCK": UNIT_VND,
  "HNX:STOCK": UNIT_VND,
  "UPCOM:STOCK": UNIT_VND,
  "HOSE:ETF": UNIT_VND,
  "HNX:ETF": UNIT_VND,
  "UPCOM:ETF": UNIT_VND,
  "HOSE:FUND": UNIT_VND,
  "HNX:FUND": UNIT_VND,
  "UPCOM:FUND": UNIT_VND,
  "HOSE:INDEX": UNIT_INDEX,
  "HNX:INDEX": UNIT_INDEX,
  "UPCOM:INDEX": UNIT_INDEX,
  "US:STOCK": UNIT_CENTS,
  "US:ETF": UNIT_CENTS,
  "US:INDEX": UNIT_INDEX,
  "HK:STOCK": UNIT_CENTS,
  "HK:ETF": UNIT_CENTS,
  "HK:INDEX": UNIT_INDEX,
  // BOND mọi sàn — khi có nguồn (finfo/chờ egress)
  "HOSE:BOND": UNIT_BOND,
  "HNX:BOND": UNIT_BOND,
  "UPCOM:BOND": UNIT_BOND,
  // #106 §2.1 — vũ trụ đa thị trường (Treasury CSV / Frankfurter / er-api /
  // Yahoo query2): trái phiếu = % lợi suất ×100; forex = tỷ giá ×10.000;
  // hàng hoá = cents ×100 (tái dùng UNIT_CENTS — GC=F 4.150,5 → 415.050).
  "BOND:BOND": UNIT_BOND,
  "FOREX:FX": UNIT_FX,
  "COMMODITY:CMDTY": UNIT_CENTS,
  "FOREX:INDEX": UNIT_FX, // DXY (DX-Y.NYB) — chỉ số tỷ giá, tính như rate
};

/** Tra UnitSpec theo (market, type) — fallback an toàn về VND (hành vi #33). */
export function resolveUnitSpec(market: string, type: string): UnitSpec {
  return UNIT_SPECS[`${market}:${type}`] ?? UNIT_VND;
}

/** Làm tròn theo bội số roundTo của spec (100 = bội 100₫; 1 = nguyên). */
function roundTo(v: number, step: number): number {
  if (step <= 1) return Math.round(v);
  return Math.round(v / step) * step;
}

export interface RealBarInput {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  value: bigint;
}

export interface DchartHistory {
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
}

export type FetchHistoryResult =
  | { empty: true }
  | { empty: false; bars: DchartHistory };

/** Lỗi cấu hình collector (resolution sai / endpoint đổi) — KHÔNG retry mù. */
export class DchartConfigError extends Error {}

/** Response đổi hình dạng so với golden signature — cần rà soát nguồn. */
export class DchartSchemaError extends Error {}

/** Lỗi mạng/HTTP sau khi retry hết lượt. */
export class DchartNetworkError extends Error {}

let lastRequestAt = 0;

async function throttle(): Promise<void> {
  const wait = REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

/**
 * GET /dchart/history — OHLCV EOD đã adjust. Retry 5xx/timeout 2 lần với
 * backoff 1s → 4s; 4xx khác throw SchemaError ngay (không retry mù).
 */
export async function fetchDchartHistory(p: {
  symbol: string;
  fromUnixSec: number;
  toUnixSec: number;
  timeoutMs?: number;
}): Promise<FetchHistoryResult> {
  const url =
    `${DCHART_BASE}/dchart/history?symbol=${encodeURIComponent(p.symbol)}` +
    `&resolution=D&from=${Math.floor(p.fromUnixSec)}&to=${Math.floor(p.toUnixSec)}`;

  let attempt = 0;
  for (;;) {
    await throttle();
    let res: Response;
    try {
      res = await fetch(url, {
        signal: AbortSignal.timeout(p.timeoutMs ?? 20_000),
        headers: { accept: "text/plain, application/json" },
      });
    } catch (err) {
      if (attempt >= 2) {
        throw new DchartNetworkError(
          `dchart timeout/mạng sau ${attempt + 1} lần thử: ${String(err)}`
        );
      }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      attempt++;
      continue;
    }
    if (res.ok) {
      const text = await res.text();
      if (!text || !text.trim()) return { empty: true }; // mã không có dữ liệu
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(text) as Record<string, unknown>;
      } catch {
        if (/not support resolution/i.test(text)) {
          throw new DchartConfigError(`dchart chối resolution D: ${text.slice(0, 120)}`);
        }
        throw new DchartSchemaError(`dchart 200 nhưng body không phải JSON: ${text.slice(0, 120)}`);
      }
      const { t, o, h, l, c, v, s } = obj as Record<string, unknown>;
      const arrays = { t, o, h, l, c, v };
      for (const [k, val] of Object.entries(arrays)) {
        if (!Array.isArray(val)) {
          throw new DchartSchemaError(`[${p.symbol}] thiếu mảng '${k}' — schema drift`);
        }
      }
      const len = (t as unknown[]).length;
      if (len === 0) return { empty: true };
      for (const [k, val] of Object.entries(arrays)) {
        if ((val as unknown[]).length !== len) {
          throw new DchartSchemaError(`[${p.symbol}] mảng '${k}' lệch độ dài`);
        }
      }
      if (s !== "ok") {
        throw new DchartSchemaError(`[${p.symbol}] s='${String(s)}' ≠ 'ok'`);
      }
      return {
        empty: false,
        bars: {
          t: t as number[],
          o: o as number[],
          h: h as number[],
          l: l as number[],
          c: c as number[],
          v: v as number[],
        },
      };
    }
    if (res.status >= 500 || res.status === 429) {
      if (attempt >= 2) {
        throw new DchartNetworkError(`dchart HTTP ${res.status} sau ${attempt + 1} lần thử`);
      }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      attempt++;
      continue;
    }
    // 4xx khác — khả năng endpoint đã đổi: KHÔNG retry
    const body = await res.text().catch(() => "");
    throw new DchartSchemaError(`dchart HTTP ${res.status} bất thường: ${body.slice(0, 160)}`);
  }
}

function round100(v: number): number {
  return Math.round(v / 100) * 100;
}

/**
 * Chuyển mảng dchart → RealBarInput đã validate §5, theo UnitSpec của mã
 * (B2 — cổ phiếu ×1000 bội 100 như cũ; index ×100 điểm; KHÔNG áp index
 * logic ×1000 cũ vì sẽ sai 1.000 lần — §2.1 blueprint).
 * Trả về { bars, skipped } — bar vi phạm nặng bị bỏ + đếm (minh bạch).
 */
export function toRealBars(
  symbol: string,
  h: DchartHistory,
  unit: UnitSpec = UNIT_VND
): { bars: RealBarInput[]; skipped: number } {
  const bars: RealBarInput[] = [];
  let skipped = 0;
  const nowMs = Date.now();
  const seenDates = new Set<string>();

  for (let i = 0; i < h.t.length; i++) {
    const tSec = h.t[i];
    if (!Number.isFinite(tSec) || tSec <= 0) {
      skipped++;
      continue;
    }
    const d = new Date(tSec * 1000);
    // Q6/Q7: ngày giao dịch UTC — bỏ T7/CN và ngày tương lai
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) {
      skipped++;
      continue;
    }
    if (d.getTime() > nowMs) {
      skipped++;
      continue;
    }

    // B2 — biến đổi theo UnitSpec của (market,type): VND nghìn×1000 bội 100,
    // index điểm×100 nguyên, cents ×100 nguyên (T2.1/T2.2)
    const open = roundTo(h.o[i] * unit.multiplier, unit.roundTo);
    const high = roundTo(h.h[i] * unit.multiplier, unit.roundTo);
    const low = roundTo(h.l[i] * unit.multiplier, unit.roundTo);
    const close = roundTo(h.c[i] * unit.multiplier, unit.roundTo);
    // Q3 + B4: volume ≥ 0, kẹp cận INT4 — index có volume = tổng KL toàn sàn
    // (VNINDEX ~2,6 tỷ cp) vượt Int32 → clamp 2.147.483.647 (minh bạch, không mất
    // ý nghĩa: volume index chỉ dùng hiển thị, không vào tính toán giá)
    const volume = Math.min(
      2_147_483_647,
      Math.max(0, Math.round(h.v[i] ?? 0))
    );

    if (
      close < unit.minPrice ||
      close > unit.maxPrice ||
      open < unit.minPrice ||
      open > unit.maxPrice
    ) {
      skipped++;
      continue;
    }

    // OHLC sanity: high = max(h,o,c), low = min(l,o,c) khi nguồn lệch nhẹ
    const fixedHigh = Math.max(high, open, close);
    const fixedLow = Math.min(low, open, close);

    // Bar.date = 15:00 UTC của ngày giao dịch (convention tick route EOD rollover)
    const date = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 15, 0, 0)
    );
    const dateKey = date.toISOString().slice(0, 10);
    if (seenDates.has(dateKey)) {
      skipped++; // duplicate trong response — giữ bản cuối (đã push sau)
      continue;
    }
    seenDates.add(dateKey);

    bars.push({
      date,
      open,
      high: fixedHigh,
      low: fixedLow,
      close,
      volume,
      value: BigInt(Math.max(0, volume)) * BigInt(close),
    });
  }
  void symbol;
  return { bars, skipped };
}

/** Neo Quote vào EOD thật từ 2 bar cuối (ref = close bar trước, OHLC = bar cuối).
 * B2 — theo loại: INDEX/quốc tế KHÔNG trần/sàn ±7% (null); spread theo tick của loại
 * (0,1 điểm index = 10 đơn vị DB; VND giữ công thức max(100, 0,1% giá) như #33).
 * Xuất public để intl-eod.ts (B12) TÁI DÙNG cùng neo quote theo UnitSpec. */
export async function anchorQuoteToRealEod(
  instrumentId: string,
  bars: RealBarInput[],
  unit: UnitSpec = UNIT_VND
): Promise<void> {
  if (bars.length === 0) return;
  const last = bars[bars.length - 1];
  const prev = bars.length >= 2 ? bars[bars.length - 2] : null;
  const ref = prev ? prev.close : last.close;

  let ceiling: number | null;
  let floor: number | null;
  if (unit.hasPriceBand) {
    ceiling = round100(Math.min(ref * 1.07, 1_000_000_000));
    floor = Math.max(100, round100(ref * 0.93));
  } else {
    // T2.3 — index/quốc tế không có trần/sàn kiểu VN
    ceiling = null;
    floor = null;
  }
  const change = last.close - ref;
  const changePct = ref > 0 ? Number(((change / ref) * 100).toFixed(2)) : 0;
  const spread =
    unit.kind === "VND"
      ? Math.max(100, round100(last.close * 0.001))
      : Math.max(unit.tickUnit, Math.round(last.close * 0.001));
  // Depth ~1% KLGD phiên chia 2 bên (giá trị hiển thị, đơn vị lô 100 cp)
  const depthLots = Math.max(10, Math.min(500, Math.round(last.volume / 100 / 100)));
  // tradedAt = giờ đóng cửa 15:00 ICT (08:00 UTC) của phiên cuối
  // (quốc tế: giờ đóng cửa khác nhưng neo cùng convention EOD 15:00 UTC —
  //  UintSpec không mang múi giờ; hiển thị theo tradedAt không đổi)
  const tradedAt = new Date(
    Date.UTC(
      last.date.getUTCFullYear(),
      last.date.getUTCMonth(),
      last.date.getUTCDate(),
      8,
      0,
      0
    )
  );

  const existing = await db.quote.findFirst({
    where: { instrumentId },
    select: { id: true },
  });
  const data = {
    open: last.open,
    high: last.high,
    low: last.low,
    last: last.close,
    close: last.close,
    volume: last.volume,
    refPrice: ref,
    ceilingPrice: ceiling,
    floorPrice: floor,
    change,
    changePct,
    bidPrice: floor != null ? Math.max(floor, last.close - spread) : last.close - spread,
    askPrice: ceiling != null ? Math.min(ceiling, last.close + spread) : last.close + spread,
    bidVolume: depthLots * 100,
    askVolume: depthLots * 100,
    tradedAt,
  };
  if (existing) {
    await db.quote.update({ where: { id: existing.id }, data });
  } else {
    await db.quote.create({ data: { instrumentId, ...data } });
  }
}

export interface EodCrossCheck {
  /** Số mã so được (có quote finfo cuối phiên cùng ngày ICT + mode real). */
  compared: number;
  /** Mã lệch close finfo realtime vs dchart EOD > 1% (P1-3 → RiskAlert INFO). */
  mismatches: { symbol: string; finfoClose: number; eodClose: number; diffPct: number }[];
}

export interface EodSyncOutcome {
  ok: boolean;
  symbolsOk: string[];
  symbolsEmpty: string[];
  symbolsFailed: { symbol: string; error: string }[];
  barsUpserted: number;
  barsSkipped: number;
  lastTradeDate: string | null;
  durationMs: number;
  /** P1-3 — đối chiếu chéo finfo realtime cuối phiên vs dchart EOD cùng ngày. */
  crossCheck?: EodCrossCheck;
  /** P1-3 — re-validate cột value = volume×close sau upsert (bar hỏng trong DB). */
  valueMismatches: { symbol: string; date: string; value: string; expected: string }[];
  error?: string;
}

/* ═════════════════════════════════════════════════════════════════════
 * UNIVERSE_TIERING_BLUEPRINT §5.3 + §6 — T0 TOÀN SÀN (tier BROAD)
 *
 * syncBroadEod: đồng bộ bar-ngày T0 hằng ngày 16:00 ICT (engine), KHÔNG
 * Quote realtime (§5.7 — BROAD không bao giờ vào tick-engine/market-summary).
 *
 * Cơ chế CURSOR XOAY VÒNG (v1.1 — vá sau đo lượt thật 15:12Z 24-10): chọn
 * 350 mã/lượt theo vị trí cursor trên danh sách symbol-asc (wrap-around),
 * cursor tiến lên sau mỗi lượt (AppSetting "eod-broad.cursor") → ~1.000 mã
 * quay hết trong 3 ngày, lookback 12 ngày tự vá mọi khoảng hở. Bản đầu dùng
 * filter "chưa tươi >3 ngày" — đo thật lộ lỗ hổng BỎ ĐÓI: mã đình chỉ (không
 * bao giờ có bar mới) đứng đầu queue symbol-asc mãi mãi, chiếm take-slot,
 * mã hoạt động phía sau không bao giờ tới lượt. Cursor theo VỊ TRÍ không thể
 * bỏ đói ai — mã đình chỉ chỉ tốn đúng 1 slot khi tới phiên của nó.
 *
 * pruneBroadBars (cuối mỗi lượt): xoá bar BROAD cũ hơn cửa sổ 420 ngày —
 * điều kiện sống của ngân sách free tier (~125-140MB cố định thay vì
 * +81MB/năm). KHÔNG BAO GIỜ đụng bar CORE (lọc universeTier BROAD).
 * ═════════════════════════════════════════════════════════════════════ */

/** §5.3 — số mã BROAD mỗi lượt sync: 350 × ~0,3s ≈ 105s + ghi ≈ 130s < 280s
 * timeout engine; ~1.000 mã → xoay hết trong 3 ngày, lookback 12 ngày che
 * dư dả (đã đo lượt thật 15:12Z 24-10: 2 mã 18 bar 2,5s). */
const BROAD_MAX_SYMBOLS_PER_SYNC = 350;
/** §6 — cửa sổ cuộn T0: 420 ngày lịch ≈ 260 phiên GD (đúng cutoff breadth). */
export const BROAD_WINDOW_DAYS = 420;
/** §5.3 — cursor xoay vòng lưu AppSetting "eod-broad.cursor".
 *
 * Vì SAU thay từ filter "stale>3 ngày" sang CURSOR: filter freshness khiến mã
 * đình chỉ (không bao giờ có bar mới) LUÔN nằm đầu queue symbol-asc → nếu
 * nhiều hơn take, mã hoạt động phía sau BỊ BỎ ĐÓI vĩnh viễn (đo lượt thật:
 * ATA đình chỉ chiếm 1 slot mỗi ngày). Cursor xoay theo VỊ TRÍ: mọi mã được
 * tới lượt cứ mỗi ceil(N/take) ngày bất kể đình chỉ — không thể bỏ đói. */
const BROAD_CURSOR_KEY = "eod-broad.cursor";

export interface BroadEodOutcome extends EodSyncOutcome {
  tier: "BROAD";
  /** §6 — số bar T0 bị xoá khỏi cửa sổ cuộn (đếm được, ghi meta nguồn). */
  prunedBars: number;
  /** Số mã BROAD còn lại chưa quay tới (queue phía sau cursor). */
  staleRemaining: number | null;
  /** Vị trí cursor xoay vòng sau lượt (meta debug ops). */
  cursorNext: number | null;
}

/** §6 — xoá bar BROAD ngoài cửa sổ cuộn. Trả về số dòng đã xoá. */
export async function pruneBroadBars(): Promise<number> {
  const cutoff = new Date(Date.now() - BROAD_WINDOW_DAYS * 86_400_000);
  const broadIds = (
    await db.instrument.findMany({
      where: { universeTier: "BROAD" },
      select: { id: true },
    })
  ).map((i) => i.id);
  if (broadIds.length === 0) return 0;
  const res = await db.bar.deleteMany({
    where: { instrumentId: { in: broadIds }, date: { lt: cutoff } },
  });
  return res.count;
}

async function readBroadCursor(): Promise<number> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: BROAD_CURSOR_KEY } });
    const n = row ? Number.parseInt(JSON.parse(row.value), 10) : Number.NaN;
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

async function writeBroadCursor(next: number): Promise<void> {
  await db.appSetting.upsert({
    where: { key: BROAD_CURSOR_KEY },
    create: { key: BROAD_CURSOR_KEY, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  });
}

export async function syncBroadEod(opts?: {
  lookbackDays?: number;
}): Promise<BroadEodOutcome> {
  const startedAt = Date.now();
  // lookback 12 ngày mặc định: che chu kỳ quay ~3 ngày/mã + T7/CN/lễ dư dả
  const lookbackDays = Math.max(2, Math.min(90, opts?.lookbackDays ?? 12));
  const toSec = Math.floor(Date.now() / 1000) + 86_400;
  const fromSec = toSec - lookbackDays * 86_400;

  // §5.3 — chọn theo CURSOR XOAY VÒNG trên danh sách symbol-asc: slice từ
  // vị trí cursor, wrap-around đầu danh sách (mã đình chỉ không chặn ai).
  const allBroad = await db.instrument.findMany({
    where: {
      isActive: true,
      market: { in: ["HOSE", "HNX", "UPCOM"] },
      universeTier: "BROAD",
    },
    select: { id: true, symbol: true, market: true, type: true },
    orderBy: { symbol: "asc" },
  });
  const cursor = allBroad.length > 0 ? (await readBroadCursor()) % allBroad.length : 0;
  const rotated = [...allBroad.slice(cursor), ...allBroad.slice(0, cursor)];
  const instruments = rotated.slice(0, BROAD_MAX_SYMBOLS_PER_SYNC);
  const cursorNext =
    allBroad.length > 0 ? (cursor + instruments.length) % allBroad.length : 0;
  if (allBroad.length > 0) {
    await writeBroadCursor(cursorNext).catch((err) => {
      console.error("[eod-broad] ghi cursor lỗi (lượt sau vẫn chạy từ cursor cũ):", err);
    });
  }

  const symbolsOk: string[] = [];
  const symbolsEmpty: string[] = [];
  const symbolsFailed: { symbol: string; error: string }[] = [];
  let barsUpserted = 0;
  let barsSkipped = 0;
  let lastTradeDate: string | null = null;
  const valueMismatches: EodSyncOutcome["valueMismatches"] = [];
  const syncAt = new Date();

  // Perf (đo thật lượt 15:2xZ 24-10): per-bar upsert TUẦN TỰ 2.800 lệnh ×
  // ~100ms WAN ≈ 280s → vượt timeout engine 280s. Đúng pattern tick route
  // (Perf #64 — "chunk 10 giữ pool WAN an toàn, Supabase chấp nhận"):
  // PHA 1 fetch tuần tự (throttle 300ms giữ lịch sự với nguồn) gom kết quả,
  // PHA 2 flush upsert + revalidate SONG SONG theo chunk 10.
  interface FetchedInst {
    inst: { id: string; symbol: string; market: string; type: string };
    bars: NonNullable<ReturnType<typeof toRealBars>["bars"]>;
  }
  const fetched: FetchedInst[] = [];

  for (const inst of instruments) {
    try {
      const res = await fetchDchartHistory({
        symbol: inst.symbol,
        fromUnixSec: fromSec,
        toUnixSec: toSec,
      });
      if (res.empty) {
        symbolsEmpty.push(inst.symbol);
        continue;
      }
      const unit = resolveUnitSpec(inst.market, inst.type);
      const { bars, skipped } = toRealBars(inst.symbol, res.bars, unit);
      barsSkipped += skipped;
      if (bars.length === 0) {
        symbolsEmpty.push(inst.symbol);
        continue;
      }
      fetched.push({ inst, bars });
      barsUpserted += bars.length;
      const d = bars[bars.length - 1].date.toISOString().slice(0, 10);
      if (d > (lastTradeDate ?? "")) lastTradeDate = d;
    } catch (err) {
      symbolsFailed.push({
        symbol: inst.symbol,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // PHA 2 — flush song song chunk 10 (đúng Perf #64: pool WAN an toàn).
  for (let i = 0; i < fetched.length; i += 10) {
    const chunk = fetched.slice(i, i + 10);
    await Promise.all(
      chunk.map(async ({ inst, bars }) => {
        try {
          for (const b of bars) {
            await db.bar.upsert({
              where: { instrumentId_date: { instrumentId: inst.id, date: b.date } },
              create: {
                instrumentId: inst.id,
                date: b.date,
                open: b.open,
                high: b.high,
                low: b.low,
                close: b.close,
                volume: b.volume,
                value: b.value,
                firstSeenAt: syncAt,
                lastSyncedAt: syncAt,
              },
              update: {
                open: b.open,
                high: b.high,
                low: b.low,
                close: b.close,
                volume: b.volume,
                value: b.value,
                lastSyncedAt: syncAt,
              },
            });
          }
          // §5.7 — KHÔNG anchorQuoteToRealEod: BROAD không có Quote, không realtime
          symbolsOk.push(inst.symbol);
        } catch (err) {
          symbolsFailed.push({
            symbol: inst.symbol,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })
    );
  }

  // re-validate value = volume×close — cũng chunk 10 (1 query/mã)
  for (let i = 0; i < fetched.length; i += 10) {
    const chunk = fetched.slice(i, i + 10);
    const results = await Promise.all(
      chunk.map(({ inst, bars }) =>
        revalidateValues(inst.id, inst.symbol, bars[0]!.date).catch(() => [])
      )
    );
    for (const bad of results) {
      if (bad.length > 0) valueMismatches.push(...bad.slice(0, 5));
    }
  }

  // §6 — prune cửa sổ cuộn SAU lượt sync (bar freshest an toàn mới được xoá cũ)
  const prunedBars = await pruneBroadBars().catch((err) => {
    console.error("[eod-broad] prune lỗi (lượt sau tự vá):", err);
    return -1;
  });

  // Queue dư: số mã BROAD chưa quay tới trong lượt này (phía sau cursor)
  const staleRemaining: number | null = allBroad.length - instruments.length;

  const outcome: BroadEodOutcome = {
    // Mã đình chỉ trả rỗng là BÌNH THƯỜNG (không lỗi nguồn): ok chỉ sai khi
    // thất bại thật (network/schema) chiếm đa số — không crying-wolf.
    ok:
      instruments.length === 0 ||
      symbolsFailed.length < instruments.length ||
      symbolsOk.length > 0,
    tier: "BROAD",
    symbolsOk,
    symbolsEmpty,
    symbolsFailed,
    barsUpserted,
    barsSkipped,
    lastTradeDate,
    durationMs: Date.now() - startedAt,
    valueMismatches,
    prunedBars,
    staleRemaining,
    cursorNext,
    // crossCheck bỏ qua trung thực: BROAD không có Quote finfo để đối chiếu
    error:
      symbolsFailed.length >= Math.max(1, instruments.length) && instruments.length > 0
        ? "toàn bộ mã BROAD lượt này thất bại"
        : undefined,
  };

  await markSource("eod-broad", {
    mode: "real",
    success: outcome.ok,
    meta: {
      source: "dchart-api.vndirect.com.vn",
      provider: "VNDIRECT (public EOD — T0 toàn sàn)",
      symbolsOk: symbolsOk.length,
      symbolsEmpty: symbolsEmpty.length,
      symbolsFailed: symbolsFailed.length,
      barsUpserted,
      lastTradeDate,
      lookbackDays,
      prunedBars,
      staleRemaining,
      cursorNext,
      universeBroad: allBroad.length,
      windowDays: BROAD_WINDOW_DAYS,
      note:
        "T0 bar-ngày cửa sổ cuộn 420 ngày · cursor xoay vòng AppSetting eod-broad.cursor (mã đình chỉ không chặn lượt ai) · không Quote/realtime, không vào rổ bằng chứng CORE",
    },
  });

  return outcome;
}

/* ── P1-3 (blueprint v1.3 §5): đối chiếu chéo nguồn sau EOD-sync ──
 *
 * So CLOSE finfo realtime CUỐI PHIÊN (ảnh Quote TRƯỚC khi anchor đè) vs bar
 * dchart EOD CÙNG NGÀY ICT; lệch > 1% → RiskAlert INFO (dedupe 24h theo code
 * DQ_CROSS_SOURCE). CHỈ so khi DataSourceStatus "market-quotes" mode=real
 * (mô phỏng random-walk quanh EOD thì khớp là hiển nhiên — crying wolf).
 *
 * F-611B-01/#61 (P0): TRƯỚC ĐÂY hàm tự đọc Quote SAU vòng lặp upsert — tức
 * SAU khi anchorQuoteToRealEod ĐÃ ĐÈ Quote bằng close dchart → so dchart với
 * chính dchart, diffPct ≡ 0, phép kiểm chết lặng. Giờ: syncEodFromDchart
 * chụp ảnh Quote finfo TRƯỚC vòng anchor rồi TRUYỀN MAP vào đây.
 *
 * Re-validate cột value = volume×close cho toàn bộ bar vừa upsert (bắt bar
 * hỏng tồn sẵn trong DB — toRealBars luôn ghi đúng nên mismatch = DB cũ lỗi).
 */
const CROSS_SOURCE_DIFF_PCT = 1; // % — ngưỡng RiskAlert INFO (blueprint P1-3)
const CROSS_SOURCE_ALERT_CODE = "DQ_CROSS_SOURCE";

/** Ảnh Quote finfo chụp TRƯỚC vòng anchor (F-611B-01) — truyền vào cross-check. */
export interface PreAnchorQuote {
  /** Quote.last — Int NOT NULL theo schema. */
  last: number;
  /** Quote.close — Int? (nullable theo schema). */
  close: number | null;
  tradedAt: Date;
}

export async function crossCheckFinfoVsEod(
  instruments: { id: string; symbol: string }[],
  latestBarBySymbol: Map<string, { close: number; date: Date }>,
  /** Map instrumentId → Quote finfo trước anchor (F-611B-01). */
  preAnchorQuotes: Map<string, PreAnchorQuote>
): Promise<EodCrossCheck> {
  // Chỉ so khi nguồn quote là finfo THẬT (mode real) — đọc 1 lần cho cả lượt
  const quoteSource = await db.dataSourceStatus
    .findUnique({ where: { key: "market-quotes" } })
    .catch(() => null);
  const mismatches: EodCrossCheck["mismatches"] = [];
  if (!quoteSource || quoteSource.mode !== "real") {
    return { compared: 0, mismatches };
  }

  let compared = 0;
  for (const inst of instruments) {
    const bar = latestBarBySymbol.get(inst.symbol);
    if (!bar || !(bar.close > 0)) continue;
    const q = preAnchorQuotes.get(inst.id);
    if (!q) continue;
    // Cùng NGÀY ICT (quote cuối phiên hôm nay vs bar EOD hôm nay)
    if (vnDateIso(q.tradedAt) !== vnDateIso(bar.date)) continue;
    const finfoClose = q.close ?? q.last;
    if (!(finfoClose > 0)) continue;
    compared++;
    const diffPct = Math.abs(finfoClose - bar.close) / bar.close * 100;
    if (diffPct > CROSS_SOURCE_DIFF_PCT) {
      mismatches.push({ symbol: inst.symbol, finfoClose, eodClose: bar.close, diffPct: Number(diffPct.toFixed(2)) });
    }
  }

  if (mismatches.length > 0) {
    // Dedupe 24h — pattern raiseSevereAlerts (data-quality.ts)
    const since24h = new Date(Date.now() - 24 * 3_600_000);
    const dup = await db.riskAlert
      .findFirst({ where: { code: CROSS_SOURCE_ALERT_CODE, createdAt: { gte: since24h } }, select: { id: true } })
      .catch(() => null);
    if (!dup) {
      // F-611B-09/#61 — "lớn nhất" = diffPct MAX (trước đây lấy mismatches[0]
      // theo thứ tự mã — không phải lớn nhất như message khai báo)
      const worst = [...mismatches].sort((a, b) => b.diffPct - a.diffPct)[0];
      await db.riskAlert
        .create({
          data: {
            severity: "INFO",
            code: CROSS_SOURCE_ALERT_CODE,
            message: `[P1-3 đối chiếu chéo] ${mismatches.length} mã lệch close finfo realtime vs dchart EOD > 1% cùng ngày (${mismatches.slice(0, 5).map(m => `${m.symbol} ${m.diffPct}%`).join(" · ")}${mismatches.length > 5 ? "…" : ""}) — lớn nhất ${worst.symbol}: finfo ${worst.finfoClose} vs EOD ${worst.eodClose}. Kiểm tra nguồn trước khi tin số EOD.`,
            metricKey: "data-quality.cross-source",
            metricValue: worst.diffPct,
            threshold: CROSS_SOURCE_DIFF_PCT,
          },
        })
        .catch(() => null); // fail-soft — cross-check không làm hỏng sync
    }
  }
  return { compared, mismatches };
}

/** P1-3 — re-validate value = volume×close cho bar vừa upsert của 1 mã. */
async function revalidateValues(
  instrumentId: string,
  symbol: string,
  windowFrom: Date
): Promise<EodSyncOutcome["valueMismatches"]> {
  const bars = await db.bar
    .findMany({
      where: { instrumentId, date: { gte: windowFrom } },
      select: { date: true, volume: true, close: true, value: true },
    })
    .catch(() => [] as { date: Date; volume: number; close: number; value: bigint | null }[]);
  const out: EodSyncOutcome["valueMismatches"] = [];
  for (const b of bars) {
    const expected = BigInt(Math.max(0, b.volume)) * BigInt(b.close);
    if (b.value !== expected) {
      out.push({
        symbol,
        date: b.date.toISOString().slice(0, 10),
        value: b.value == null ? "null" : b.value.toString(),
        expected: expected.toString(),
      });
    }
  }
  return out;
}

/**
 * Đồng bộ EOD cho toàn bộ instrument đang hoạt động (mặc định lookback 10 ngày
 * — đủ che T7/CN/lễ). Upsert từng bar (Q4 idempotent) + neo Quote + đánh dấu
 * DataSourceStatus key "eod-history" mode "real".
 */
export async function syncEodFromDchart(opts?: {
  lookbackDays?: number;
}): Promise<EodSyncOutcome> {
  const startedAt = Date.now();
  const lookbackDays = Math.max(2, Math.min(3650, opts?.lookbackDays ?? 10));
  const toSec = Math.floor(Date.now() / 1000) + 86_400; // +1 ngày chặn biên
  const fromSec = toSec - lookbackDays * 86_400;

  const instruments = await db.instrument.findMany({
    // UNIVERSE_TIERING §5.1 — mặc định CORE: caller cũ (engine 15:45, route
    // days) giữ hành vi 100%; BROAD đi đường riêng syncBroadEod (§5.3).
    where: { isActive: true, market: { in: ["HOSE", "HNX", "UPCOM"] }, universeTier: "CORE" },
    select: { id: true, symbol: true, market: true, type: true },
    orderBy: { symbol: "asc" },
    take: MAX_SYMBOLS_PER_SYNC,
  });

  const symbolsOk: string[] = [];
  const symbolsEmpty: string[] = [];
  const symbolsFailed: { symbol: string; error: string }[] = [];
  let barsUpserted = 0;
  let barsSkipped = 0;
  let lastTradeDate: string | null = null;
  const valueMismatches: EodSyncOutcome["valueMismatches"] = [];
  // P1-3 — bar cuối mỗi mã (cho cross-check finfo vs EOD sau lượt sync)
  const latestBarBySymbol = new Map<string, { close: number; date: Date }>();
  // P1-2 — đồng hồ sync dùng chung: create đặt firstSeenAt/lastSyncedAt,
  // update CHỈ đụng lastSyncedAt (firstSeenAt = lần đầu thấy — PIT).
  const syncAt = new Date();

  // F-611B-01/#61 (P0) — CHỤP ẢNH Quote finfo TRƯỚC vòng anchor: vòng lặp
  // dưới đây gọi anchorQuoteToRealEod ĐÈ Quote bằng close dchart — nếu
  // cross-check đọc Quote sau đó thì so dchart với chính dchart (diff ≡ 0,
  // phép kiểm P1-3 chết lặng). 1 query findMany thay ~150 findFirst cũ.
  const preAnchorQuotes = new Map<string, PreAnchorQuote>();
  try {
    const quotes = await db.quote.findMany({
      where: { instrumentId: { in: instruments.map((i) => i.id) } },
      select: { instrumentId: true, last: true, close: true, tradedAt: true },
    });
    for (const q of quotes) {
      preAnchorQuotes.set(q.instrumentId, { last: q.last, close: q.close, tradedAt: q.tradedAt });
    }
  } catch (err) {
    // Ảnh trước-anchor là tối ưu — không có thì cross-check so 0 mã trung thực
    console.error("[eod-sync] chụp ảnh Quote trước anchor lỗi (cross-check sẽ so 0 mã):", err);
  }

  for (const inst of instruments) {
    try {
      const res = await fetchDchartHistory({
        symbol: inst.symbol,
        fromUnixSec: fromSec,
        toUnixSec: toSec,
      });
      if (res.empty) {
        symbolsEmpty.push(inst.symbol);
        continue;
      }
      const unit = resolveUnitSpec(inst.market, inst.type);
      const { bars, skipped } = toRealBars(inst.symbol, res.bars, unit);
      barsSkipped += skipped;
      if (bars.length === 0) {
        symbolsEmpty.push(inst.symbol);
        continue;
      }
      for (const b of bars) {
        await db.bar.upsert({
          where: { instrumentId_date: { instrumentId: inst.id, date: b.date } },
          create: {
            instrumentId: inst.id,
            date: b.date,
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            volume: b.volume,
            value: b.value,
            firstSeenAt: syncAt,
            lastSyncedAt: syncAt,
          },
          update: {
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            volume: b.volume,
            value: b.value,
            lastSyncedAt: syncAt,
          },
        });
      }
      barsUpserted += bars.length;
      // P1-3 — re-validate value = volume×close sau upsert (fail-soft)
      const bad = await revalidateValues(inst.id, inst.symbol, bars[0].date);
      if (bad.length > 0) valueMismatches.push(...bad.slice(0, 5));
      await anchorQuoteToRealEod(inst.id, bars, unit);
      symbolsOk.push(inst.symbol);
      const lastBar = bars[bars.length - 1];
      latestBarBySymbol.set(inst.symbol, { close: lastBar.close, date: lastBar.date });
      const d = lastBar.date.toISOString().slice(0, 10);
      if (d > (lastTradeDate ?? "")) lastTradeDate = d;
    } catch (err) {
      symbolsFailed.push({
        symbol: inst.symbol,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // P2-3/#62 — Bar vừa đổi (nến mới/tái ghi) → ADTV 45 phiên đổi theo:
  // xoá cache rổ thanh khoản để chu kỳ sau tính lại từ dữ liệu mới (TTL L2
  // 10 phút chỉ là lưới an toàn phía sau điểm invalidation chủ động này).
  if (barsUpserted > 0) {
    await invalidateFeatureCache(TOPBYADTV_CACHE_PREFIX);
  }

  // P1-3 — đối chiếu chéo SAU lượt upsert, dùng ẢNH QUOTE FINFO THẬT chụp
  // TRƯỚC vòng anchor (F-611B-01/#61 — trước đây hàm tự đọc Quote sau khi
  // anchor đã đè bằng close dchart → diff ≡ 0 vĩnh viễn)
  const crossCheck = await crossCheckFinfoVsEod(
    instruments.map((i) => ({ id: i.id, symbol: i.symbol })),
    latestBarBySymbol,
    preAnchorQuotes
  ).catch(() => ({ compared: 0, mismatches: [] }));

  const outcome: EodSyncOutcome = {
    ok: symbolsOk.length > 0 && symbolsFailed.length < instruments.length,
    symbolsOk,
    symbolsEmpty,
    symbolsFailed,
    barsUpserted,
    barsSkipped,
    lastTradeDate,
    durationMs: Date.now() - startedAt,
    crossCheck,
    valueMismatches,
  };

  await markSource("eod-history", {
    mode: "real",
    success: outcome.ok,
    meta: {
      source: "dchart-api.vndirect.com.vn",
      provider: "VNDIRECT (public EOD)",
      symbolsOk: symbolsOk.length,
      symbolsEmpty: symbolsEmpty.length,
      symbolsFailed: symbolsFailed.length,
      barsUpserted,
      barsSkipped,
      lastTradeDate,
      lookbackDays,
      // P1-3 — kết quả đối chiếu chéo + value re-validate vào meta nguồn
      crossCheck: { compared: crossCheck.compared, mismatched: crossCheck.mismatches.length },
      valueMismatches: valueMismatches.length,
      note:
        "Bar EOD thật (đã adjust) từ dchart VNDIRECT — Tier 1 DATA_SOURCES §3.1 · PIT firstSeenAt/lastSyncedAt (P1-2)",
    },
  });

  return outcome;
}

/**
 * Deep backfill toàn bộ lịch sử (mặc định từ 2013-01-01) — xoá bar synthetic
 * của từng instrument rồi createMany bar thật theo chunk, neo Quote vào EOD
 * cuối. Chỉ chạy qua script prisma/import-real-eod.ts hoặc API force=deep.
 */
export async function deepBackfillEod(opts?: { fromYear?: number }): Promise<EodSyncOutcome> {
  const startedAt = Date.now();
  const fromYear = opts?.fromYear ?? 2013;
  const fromSec = Math.floor(Date.UTC(fromYear, 0, 1) / 1000);
  const toSec = Math.floor(Date.now() / 1000) + 86_400;
  // P1-2 — đồng hồ mốc backfill (toàn chuỗi thấy lần đầu cùng mốc)
  const syncAt = new Date();

  const instruments = await db.instrument.findMany({
    // UNIVERSE_TIERING §5.2 — deep 12 năm CHỈ dành cho CORE: sau khi T0 có
    // ~1.000 BROAD, force=deep không lọc tier sẽ backfill 1,9GB vào free
    // tier 500MB (§9 rủi ro đo sẵn Task 187). BROAD đi seed cửa sổ cuộn.
    where: { isActive: true, market: { in: ["HOSE", "HNX", "UPCOM"] }, universeTier: "CORE" },
    select: { id: true, symbol: true, market: true, type: true },
    orderBy: { symbol: "asc" },
    take: MAX_SYMBOLS_PER_SYNC,
  });

  const symbolsOk: string[] = [];
  const symbolsEmpty: string[] = [];
  const symbolsFailed: { symbol: string; error: string }[] = [];
  let barsUpserted = 0;
  let barsReadjustedTotal = 0; // F-611R-01 — bar tái áp adjustment sau backfill
  let barsSkipped = 0;
  let lastTradeDate: string | null = null;
  const valueMismatches: EodSyncOutcome["valueMismatches"] = [];

  for (const inst of instruments) {
    try {
      const res = await fetchDchartHistory({
        symbol: inst.symbol,
        fromUnixSec: fromSec,
        toUnixSec: toSec,
        timeoutMs: 30_000,
      });
      if (res.empty) {
        symbolsEmpty.push(inst.symbol);
        continue;
      }
      const unit = resolveUnitSpec(inst.market, inst.type);
      const { bars, skipped } = toRealBars(inst.symbol, res.bars, unit);
      barsSkipped += skipped;
      if (bars.length === 0) {
        symbolsEmpty.push(inst.symbol);
        continue;
      }
      // F-611B-04/#61 — deep backfill phải TÔN TRỌNG PIT (spec P1-2: "không
      // đường nạp nào được reset firstSeenAt"): giữ firstSeenAt CŨ của từng
      // bar đã có, bar MỚI mới stamp syncAt (trước đây deleteMany+createMany
      // đặt firstSeenAt=syncAt toàn chuỗi ~215k bar → xoá sạch dòng thời gian
      // "hồi đó dữ liệu thế nào"). Đồng thời delete+create trong MỘT transaction
      // từng mã — crash giữa chừng không còn mất vĩnh viễn lịch sử sâu (eod-sync
      // hằng ngày chỉ khôi phục 10 ngày).
      const existingBars = await db.bar.findMany({
        where: { instrumentId: inst.id },
        select: { date: true, firstSeenAt: true },
      });
      const firstSeenByDate = new Map(
        existingBars.map((b) => [b.date.toISOString(), b.firstSeenAt])
      );
      // Data chunk (build TƯỜNG — dùng bên trong tx qua tx.bar.createMany;
      // PrismaPromise tạo từ db sẽ chạy NGOÀI transaction)
      type BarChunkData = NonNullable<Parameters<typeof db.bar.createMany>[0]>["data"];
      const createChunks: BarChunkData[] = [];
      for (let i = 0; i < bars.length; i += 1000) {
        const chunk = bars.slice(i, i + 1000);
        createChunks.push(
          chunk.map((b) => ({
            instrumentId: inst.id,
            date: b.date,
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            volume: b.volume,
            value: b.value,
            // P1-2 — bar cũ giữ mốc thấy lần ĐẦU, bar mới stamp mốc này
            firstSeenAt: firstSeenByDate.get(b.date.toISOString()) ?? syncAt,
            lastSyncedAt: syncAt,
          }))
        );
      }
      await db.$transaction(
        async (tx) => {
          await tx.bar.deleteMany({ where: { instrumentId: inst.id } });
          for (const data of createChunks) {
            await tx.bar.createMany({ data });
          }
        },
        { timeout: 60_000 } // F-611R-10 — deep history ~3k bar/mã × WAN vượt 5s mặc định
      );
      barsUpserted += bars.length;
      // F-611R-01/#61 (Vòng 2) — TÁI ÁP adjustment đã ghi nhận: delete+create vừa
      // thay bar bằng giá GỐC nguồn; event NGOÀI cửa sổ quét 92 ngày sẽ không
      // bao giờ được scan lại → chuỗi giữ giá gốc vĩnh viễn trong khi row vẫn
      // nói AUTO_ADJUSTED. Tái áp từ chính row (tuần tự cũ→mới, đúng nhân chuỗi).
      const barsReadjusted = await reapplyAutoAdjustments(inst.id).catch((err) => {
        symbolsFailed.push({
          symbol: inst.symbol,
          error: `tái áp corporate adjustment sau backfill: ${err instanceof Error ? err.message : String(err)}`,
        });
        return 0;
      });
      barsReadjustedTotal += barsReadjusted;
      await anchorQuoteToRealEod(inst.id, bars, unit);
      symbolsOk.push(inst.symbol);
      const d = bars[bars.length - 1].date.toISOString().slice(0, 10);
      if (d > (lastTradeDate ?? "")) lastTradeDate = d;
    } catch (err) {
      symbolsFailed.push({
        symbol: inst.symbol,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // P2-3/#62 — deep backfill viết lại toàn bộ chuỗi bar → xoá cache rổ
  if (barsUpserted > 0) {
    await invalidateFeatureCache(TOPBYADTV_CACHE_PREFIX);
  }

  const outcome: EodSyncOutcome = {
    ok: symbolsOk.length > 0,
    symbolsOk,
    symbolsEmpty,
    symbolsFailed,
    barsUpserted,
    barsSkipped,
    lastTradeDate,
    durationMs: Date.now() - startedAt,
    valueMismatches,
  };

  await markSource("eod-history", {
    mode: "real",
    success: outcome.ok,
    meta: {
      source: "dchart-api.vndirect.com.vn",
      provider: "VNDIRECT (public EOD)",
      deepBackfill: true,
      fromYear,
      symbolsOk: symbolsOk.length,
      symbolsEmpty: symbolsEmpty.length,
      symbolsFailed: symbolsFailed.length,
      barsUpserted,
      barsReadjusted: barsReadjustedTotal, // F-611R-01 — tái áp CorporateEvent AUTO_ADJUSTED
      barsSkipped,
      lastTradeDate,
      note: "Deep backfill 2013→nay — bar EOD thật (đã adjust) từ dchart VNDIRECT",
    },
  });

  return outcome;
}
