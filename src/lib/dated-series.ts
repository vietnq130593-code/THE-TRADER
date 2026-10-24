/**
 * src/lib/dated-series.ts — HỢP ĐỒNG CHUỖI DỮ LIỆU THEO NGÀY (P0-1) +
 * RỔ THANH KHOẢN DUY NHẤT `topByAdtv` (P0-2).
 * DATA_PLATFORM_BLUEPRINT v1.1 §3.2 (phiên #57 — triển khai P0).
 *
 * ── P0-1 DatedSeries ──────────────────────────────────────────────────
 * Mọi chuỗi giá/return căn theo NGÀY (bài học fixbug #52-F1/F2): consumer
 * KHÔNG còn tự cắt chuỗi theo index. Ba hàm hợp đồng:
 *   · returnsDated(bars)  — return gắn ngày ISO (F2: ret của CHÍNH mã đó,
 *     mã thiếu bar không làm lệch chuỗi hợp nhất);
 *   · alignByDate(a, b)   — ghép phiên CHUNG theo NGÀY (F1: tương quan chỉ
 *     tính trên ngày tồn tại ở CẢ HAI chuỗi);
 *   · unionDates(list)    — lịch giao dịch hợp nhất (nguồn cho gap-check A9).
 * `commonReturns` là bản two-pointer từ cuối của alignByDate — chuyển từ
 * risk/concentration.ts về đây để mọi tầng dùng chung một định nghĩa.
 *
 * ── P0-2 topByAdtv ────────────────────────────────────────────────────
 * ĐỊNH NGHĨA RỔ DUY NHẤT của hệ thống (thay 4 định nghĩa lệch nhau — gốc
 * bug F6): ADTV = trung bình `Bar.value` (giá trị giao dịch VND = close ×
 * volume) trên 45 PHIÊN EOD gần nhất; fallback close×volume khi cột value
 * null (thực đo 2026-10-08: 215.402/215.402 bar đều có value). ≥ 10 bar
 * mới đủ nền tảng xếp hạng (giữ quy tắc loadTopSeries cũ). Mặc định khoá
 * HOSE-STOCK (B5 §3.4 — train/serving cùng rổ), override qua opts.
 *
 * Thuần TypeScript — 0 dependency mới (kỷ luật §6 blueprint).
 */

import { db } from "@/lib/db";
import type { InstrumentType, Market } from "@prisma/client";
import {
  cacheGetJson,
  cacheSetJson,
  TOPBYADTV_CACHE_PREFIX,
} from "@/lib/feature-cache";

/* ═══════════════════ P0-1 · Kiểu hợp đồng chuỗi theo ngày ═══════════════════ */

/** Thanh EOD tối thiểu — mọi consumer trao đổi qua kiểu này (căn theo NGÀY). */
export interface DatedClose {
  date: Date;
  close: number;
}

/** Thanh đầy đủ (P0-1 · §3.2 `{date, o,h,l,c,v}`). */
export interface DatedBar extends DatedClose {
  open: number;
  high: number;
  low: number;
  volume: number;
  /** Giá trị giao dịch VND = close × volume (Bar.value; BigInt → Number an toàn < 2^53). */
  value: number;
}

/** Chuỗi một mã — bars tăng dần theo date, đã dedupe theo date. */
export interface DatedSeries {
  symbol: string;
  instrumentId: string;
  bars: DatedBar[];
}

/** Một điểm return gắn ngày ISO "2026-10-07" (chuyển từ risk/concentration.ts). */
export interface DatedReturn {
  date: string;
  ret: number;
}

/**
 * Return theo NGÀY của CHÍNH mã đó (fixbug #52-F2 — logic từng nằm inline
 * trong risk/engine.ts): r_t = close_t/close_{t−1} − 1, chỉ phát sinh tại
 * ngày CÓ thanh liên tiếp của cùng mã. Thanh close ≤ 0 bị bỏ (không làm
 * lệch log-return).
 */
export function returnsDated<T extends DatedClose>(bars: T[]): DatedReturn[] {
  const out: DatedReturn[] = [];
  let prev: number | null = null;
  for (const b of bars) {
    if (!(b.close > 0)) continue;
    if (prev != null && prev > 0) {
      out.push({ date: b.date.toISOString().slice(0, 10), ret: b.close / prev - 1 });
    }
    prev = b.close;
  }
  return out;
}

/**
 * Ghép tối đa `maxN` PHIÊN CHUNG theo NGÀY của 2 chuỗi return (đều tăng dần
 * theo ngày) — hai con trỏ từ CUỐI, bỏ phiên lệch (mã đình quyền/thiếu bar).
 * Fixbug #52-F1: ghép theo index sẽ ghép return các NGÀY khác nhau khi 2
 * chuỗi dài khác nhau → tương quan sai định nghĩa.
 */
export function commonReturns(
  a: DatedReturn[],
  b: DatedReturn[],
  maxN: number
): { ra: number[]; rb: number[] } {
  let i = a.length - 1;
  let j = b.length - 1;
  const pa: number[] = [];
  const pb: number[] = [];
  while (i >= 0 && j >= 0 && pa.length < maxN) {
    const da = a[i].date;
    const db = b[j].date;
    if (da === db) {
      pa.push(a[i].ret);
      pb.push(b[j].ret);
      i--;
      j--;
    } else if (da > db) {
      i--;
    } else {
      j--;
    }
  }
  return { ra: pa.reverse(), rb: pb.reverse() };
}

/**
 * Hợp nhất 2 chuỗi theo NGÀY (P0-1 `alignByDate(a,b)`): trả ngày CHUNG
 * (giao) + giá trị 2 chuỗi tại các ngày đó — dùng cho tương quan/so sánh
 * cặp. Chuỗi ngắn hơn 2 phần tử chung → mảng rỗng (caller tự bỏ).
 */
export function alignByDate(
  a: DatedClose[],
  b: DatedClose[]
): { dates: string[]; a: number[]; b: number[] } {
  const byDateA = new Map(a.filter((x) => x.close > 0).map((x) => [x.date.toISOString().slice(0, 10), x.close]));
  const byDateB = new Map(b.filter((x) => x.close > 0).map((x) => [x.date.toISOString().slice(0, 10), x.close]));
  const dates = [...byDateA.keys()].filter((d) => byDateB.has(d)).sort();
  return {
    dates,
    a: dates.map((d) => byDateA.get(d)!),
    b: dates.map((d) => byDateB.get(d)!),
  };
}

/** Lịch giao dịch hợp nhất (union) — ISO dates tăng dần (nguồn gap-check A9). */
export function unionDates(barsLists: DatedClose[][]): string[] {
  const set = new Set<string>();
  for (const list of barsLists) {
    for (const b of list) {
      if (b.close > 0) set.add(b.date.toISOString().slice(0, 10));
    }
  }
  return [...set].sort();
}

/** Map ngày → giá trị từ chuỗi DatedClose (close ≤ 0 bị bỏ). */
export function datedValueMap(bars: DatedClose[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const b of bars) {
    if (b.close > 0) m.set(b.date.toISOString().slice(0, 10), b.close);
  }
  return m;
}

/* ═══════════════════ P0-2 · Rổ topByAdtv duy nhất ═══════════════════ */

/** Cửa sổ ADTV chuẩn (phiên EOD) — §3.2 blueprint v1.1. */
export const ADTV_SESSIONS = 45;
/** Số bar tối thiểu để một mã đủ nền tảng xếp hạng (quy tắc F6 cũ — giữ). */
export const ADTV_MIN_BARS = 10;

/** Một mã trong rổ topByAdtv. */
export interface TopAdtvSymbol {
  id: string;
  symbol: string;
  market: Market;
  type: InstrumentType;
  sector: string | null;
  /** ADTV 45 phiên EOD (VND) — mean(Bar.value). */
  adtv: number;
  /** Số phiên trong cửa sổ xếp hạng. */
  sessions: number;
}

/** Tuỳ chọn rổ — mặc định HOSE-STOCK (B5 §3.4: train/serving cùng rổ). */
export interface TopAdtvOptions {
  market?: Market;
  type?: InstrumentType;
  /** P2-3: bỏ qua cache, tính thẳng từ DB (dùng bởi kiểm định/so đối chiếu). */
  force?: boolean;
}

/** Hệ số chuyển ngày lịch → phiên — cửa sổ NẠP (đảm bảo chứa ≥ 45 phiên
 *  kể cả lễ/T7-CN: 45 phiên ≈ 63 ngày lịch + biên độ ≈ 77 ngày); xếp hạng
 *  chỉ dùng 45 bar CUỐI của từng mã. */
const ADTV_CALENDAR_DAYS = Math.ceil(ADTV_SESSIONS * 1.7);

/**
 * RỔ THANH KHOẢN DUY NHẤT — top-N mã theo ADTV 45 phiên EOD từ `Bar.value`
 * (P0-2): ổn định giữa 2 chu kỳ (không xoay theo quote volume từng tick —
 * gốc bug F6), cùng định nghĩa cho loadTopSeries · topLiquid ·
 * buildMarketBlock/buildValuationBlock/buildLiquidityBlock · latestFeatures
 * · readiness A9. ≥ 10 bar mới vào bảng xếp hạng.
 *
 * P2-3 (phiên #62): kết quả cache 2 lớp (L1 process TTL 90s + L2 bảng
 * Postgres FeatureValue TTL 10 phút) — giảm ~7-8 lần gọi/chu kỳ × ~106ms ≈
 * 750-850ms xuống < 200ms; eod-sync/corporate-events đổi Bar →
 * invalidateFeatureCache ("topByAdtv:") chủ động. `opts.force` tính thẳng
 * (kiểm định) và KHÔNG ghi lại cache (fixbug #63 F-63A-03 — đường đối chiếu
 * không tự vá/che khác biệt cache vs DB). Cache hit trả JSON parse — sai số 0
 * với tính tay (Number roundtrip JSON an toàn).
 */
export async function topByAdtv(
  n: number,
  opts: TopAdtvOptions = {}
): Promise<TopAdtvSymbol[]> {
  const market = opts.market ?? "HOSE";
  const type = opts.type ?? "STOCK";

  const cacheKey = `${TOPBYADTV_CACHE_PREFIX}${market}:${type}:${n}`;
  if (!opts.force) {
    const cached = await cacheGetJson(cacheKey);
    if (cached != null) {
      try {
        return JSON.parse(cached) as TopAdtvSymbol[];
      } catch {
        // Payload hỏng (không thể xảy ra với upsert cùng tiến trình) → recompute
      }
    }
  }

  const instruments = await db.instrument.findMany({
    where: { isActive: true, market, type, universeTier: "CORE" }, // UNIVERSE_TIERING §5 — xếp hạng chỉ trên CORE, BROAD không đụng rổ
    select: { id: true, symbol: true, market: true, type: true, sector: true },
  });
  if (instruments.length === 0) return [];

  const cutoff = new Date(Date.now() - ADTV_CALENDAR_DAYS * 86_400_000);
  // F-612R-02/#61 (Vòng 2): KHÔNG nuốt lỗi DB ở đây — để lỗi NÉM lên cho
  // caller xử lý trung thực (A9 giờ guard() → SEVERE; trước đây `.catch(() => [])`
  // cho rỗ [] → phép readiness A9 "0/0 mã" = PASS GIẢ khi đúng query rổ bị lỗi
  // — chồng hụng của F-591-02 mà #59 chưa phủ tới đường topByAdtv).
  const bars = await db.bar.findMany({
    where: { instrumentId: { in: instruments.map((i) => i.id) }, date: { gte: cutoff } },
    orderBy: [{ instrumentId: "asc" }, { date: "asc" }],
    select: { instrumentId: true, close: true, volume: true, value: true },
  });
  // Fixbug #59 F-591-01: đúng hợp đồng "ADTV 45 PHIẦN" — mean của 45 bar
  // CUỐI mỗi mã (trước đây mean toàn cửa sổ 77 ngày ≈ 53 phiên — đo thực
  // 08-10 làm rổ lệch vị trí 10: PNJ thay VCB, và mâu thuẫn tail-45 của
  // phép kiểm split trong data-quality.ts).
  const windowById = new Map<string, number[]>();
  for (const b of bars) {
    if (!(b.close > 0)) continue;
    // value = close × volume (VND); fallback tính lại khi cột null — cùng đơn vị
    const value = b.value != null ? Number(b.value) : b.close * b.volume;
    if (!(value > 0)) continue;
    const arr = windowById.get(b.instrumentId) ?? [];
    arr.push(value);
    windowById.set(b.instrumentId, arr);
  }
  const ranked = instruments
    .map((i) => {
      const vals = windowById.get(i.id);
      if (!vals || vals.length < ADTV_MIN_BARS) return null;
      const tail = vals.slice(-ADTV_SESSIONS); // 45 phiên EOD gần nhất
      return {
        id: i.id,
        symbol: i.symbol,
        market: i.market,
        type: i.type,
        sector: i.sector,
        adtv: tail.reduce((s, v) => s + v, 0) / tail.length,
        sessions: tail.length,
      };
    })
    .filter((r): r is TopAdtvSymbol => r !== null)
    .sort((a, b) => b.adtv - a.adtv)
    .slice(0, n);
  // P2-3 — cache kết quả (payload thuần primitive, JSON an toàn).
  // F-63A-03/#63: force KHÔNG ghi lại cache — giữ ngữ nghĩa "tính thẳng để
  // ĐỐI CHIẾU": nếu force ghi đè, lần đọc sau nhận kết quả đối chiếu (che mất
  // khác biệt cache-vs-DB mà đường kiểm định sinh ra để bắt).
  if (!opts.force) {
    await cacheSetJson(cacheKey, JSON.stringify(ranked));
  }
  return ranked;
}

/**
 * Nạp chuỗi DatedSeries đầy đủ của rổ topByAdtv (đã xếp hạng) —
 * `sinceDays` cắt cửa sổ bar theo ngày (rổ proxy CRB ~500 phiên).
 */
export async function loadTopDatedSeries(
  n: number,
  options: TopAdtvOptions & { sinceDays?: number } = {}
): Promise<DatedSeries[]> {
  const ranked = await topByAdtv(n, options);
  if (ranked.length === 0) return [];
  const since =
    options.sinceDays != null && options.sinceDays > 0
      ? new Date(Date.now() - options.sinceDays * 86_400_000)
      : null;
  // F-612R-02/#61 (Vòng 2) — tương tự topByAdtv: lỗi DB ném lên (caller tự
  // guard) — không nuốt thành chuỗi rỗng giả "không có dữ liệu".
  const bars = await db.bar.findMany({
    where: {
      instrumentId: { in: ranked.map((r) => r.id) },
      ...(since ? { date: { gte: since } } : {}),
    },
    orderBy: { date: "asc" },
    select: { instrumentId: true, date: true, open: true, high: true, low: true, close: true, volume: true, value: true },
  });
  const byId = new Map<string, DatedBar[]>();
  const seenDate = new Map<string, Set<string>>();
  for (const b of bars) {
    if (!(b.close > 0)) continue; // bỏ bar hỏng — không làm lệch return
    const iso = b.date.toISOString().slice(0, 10);
    let seen = seenDate.get(b.instrumentId);
    if (!seen) {
      seen = new Set<string>();
      seenDate.set(b.instrumentId, seen);
    }
    if (seen.has(iso)) continue; // dedupe theo ngày (upsert idempotent đã đảm bảo, phòng hộ)
    seen.add(iso);
    const list = byId.get(b.instrumentId) ?? [];
    list.push({
      date: b.date,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
      value: b.value != null ? Number(b.value) : b.close * b.volume,
    });
    byId.set(b.instrumentId, list);
  }
  return ranked.map((r) => ({
    symbol: r.symbol,
    instrumentId: r.id,
    bars: byId.get(r.id) ?? [],
  }));
}

/** Nạp chuỗi DatedSeries một mã (theo instrumentId). */
export async function loadDatedSeries(
  instrumentId: string,
  options: { sinceDays?: number } = {}
): Promise<DatedSeries | null> {
  const instrument = await db.instrument
    .findUnique({
      where: { id: instrumentId },
      select: { symbol: true },
    })
    .catch(() => null);
  if (!instrument) return null;
  const since =
    options.sinceDays != null && options.sinceDays > 0
      ? new Date(Date.now() - options.sinceDays * 86_400_000)
      : null;
  const bars = await db.bar
    .findMany({
      where: { instrumentId, ...(since ? { date: { gte: since } } : {}) },
      orderBy: { date: "asc" },
      select: { instrumentId: true, date: true, open: true, high: true, low: true, close: true, volume: true, value: true },
    })
    .catch(() => []);
  return {
    symbol: instrument.symbol,
    instrumentId,
    bars: bars
      .filter((b) => b.close > 0)
      .map((b) => ({
        date: b.date,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        value: b.value != null ? Number(b.value) : b.close * b.volume,
      })),
  };
}
