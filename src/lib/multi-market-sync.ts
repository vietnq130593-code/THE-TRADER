/**
 * src/lib/multi-market-sync.ts — ĐỒNG BỘ ĐA THỊ TRƯỜNG #106
 * (COUNCIL_STEWARDSHIP_BLUEPRINT §2.3 — 4 adapter thật, đo từ sandbox 12/10/2026).
 *
 * Ba adapter "đáng tin" (không key, không quota IP):
 *   1. TREASURY  — CSV lợi suất trái phiếu Chính phủ Mỹ chính thức
 *      (home.treasury.gov daily-treasury-rates.csv) → US5Y/US10Y/US30Y
 *      (market BOND · type BOND · đơn vị BOND_PCT ×100). Lấy 2 năm mỗi lần.
 *   2. FRANKFURTER — api.frankfurter.dev (ECB) → EURUSD=X / USDJPY=X /
 *      AUDUSD=X (market FOREX · type FX · FX_RATE ×10.000) từ 2023-01-01.
 *      CHIỀU TỶ GIÁ giữ đúng quy ước Yahoo: EURUSD=X = 1 EUR = x USD →
 *      frankfurter base USD trả "1 USD = x EUR" nên PHẢI ĐẢO (1/x);
 *      USDJPY=X giữ nguyên (1 USD = x JPY); AUDUSD=X đảo (1/x).
 *   3. ER-API — open.er-api.com/v6/latest/USD → VND=X (chỉ GIÁ MỚI NHẤT —
 *      tích luỹ 1 điểm/ngày từ #106; lịch sử do Yahoo VND=X bù khi quota mở).
 *
 * Adapter thứ 4 là Yahoo query2 (src/lib/intl-eod.ts — hàng hoá + cổ phiếu
 * quốc tế + VND=X + DX-Y.NYB) được orchestrator gọi CUỐI (chậm nhất, quota IP
 * — đã đổi query1→query2 + UA Windows + throttle 2,5s sau khi đo 12/10: query1
 * 429/429, query2 9/9 OK).
 *
 * Tái dùng 100% validator của eod-sync: mỗi adapter dựng chuỗi dạng
 * DchartHistory (t/o/h/l/c/v) rồi gọi toRealBars(symbol, hist, unit) —
 * weekend-skip, cận min/max theo UnitSpec, convention Bar 15:00 UTC, dedupe
 * ngày, volume clamp… giữ MỘT nguồn luật ingest cho toàn hệ thống; neo Quote
 * qua anchorQuoteToRealEod (trần/sàn null cho phi VN).
 *
 * Mọi adapter fail-soft độc lập + DataSourceStatus riêng (mode real/fallback,
 * meta minh bạch mã về được bao nhiêu) — pattern ensureIntlSourceRow của
 * intl-eod.ts: tạo nhãn TRƯỚC, markSource chỉ lo trạng thái.
 */

import { db } from "@/lib/db";
import { markSource } from "@/lib/sources";
import { invalidateFeatureCache, TOPBYADTV_CACHE_PREFIX } from "@/lib/feature-cache";
import {
  UNIT_BOND,
  UNIT_FX,
  toRealBars,
  anchorQuoteToRealEod,
} from "@/lib/eod-sync";
import type { DchartHistory } from "@/lib/eod-sync";
import { syncIntlEod, type IntlSyncOutcome } from "@/lib/intl-eod";

// ─────────────────────────────────────────────────────────────────
// Định nghĩa instrument (single source of truth cho seed + adapter)
// ─────────────────────────────────────────────────────────────────

export interface MultiMarketInstrumentDef {
  symbol: string;
  name: string;
  market: "BOND" | "FOREX" | "COMMODITY";
  type: "BOND" | "FX" | "CMDTY";
  currency: string;
  sector: string;
}

/** Rổ TRÁI PHIẾU — lợi suất Treasury Mỹ (CSV chính thức, 2 năm lịch sử). */
export const TREASURY_INSTRUMENTS: readonly MultiMarketInstrumentDef[] = [
  {
    symbol: "US5Y",
    name: "Trái phiếu Chính phủ Mỹ 5 năm — lợi suất",
    market: "BOND",
    type: "BOND",
    currency: "USD",
    sector: "Trái phiếu",
  },
  {
    symbol: "US10Y",
    name: "Trái phiếu Chính phủ Mỹ 10 năm — lợi suất",
    market: "BOND",
    type: "BOND",
    currency: "USD",
    sector: "Trái phiếu",
  },
  {
    symbol: "US30Y",
    name: "Trái phiếu Chính phủ Mỹ 30 năm — lợi suất",
    market: "BOND",
    type: "BOND",
    currency: "USD",
    sector: "Trái phiếu",
  },
];

/** Rổ FOREX — 3 cặp chính do Frankfurter sở hữu (lịch sử đầy từ 2023). */
export const FRANKFURTER_INSTRUMENTS: readonly MultiMarketInstrumentDef[] = [
  {
    symbol: "EURUSD=X",
    name: "Euro / Đô la Mỹ (EUR/USD)",
    market: "FOREX",
    type: "FX",
    currency: "USD",
    sector: "Ngoại hối",
  },
  {
    symbol: "USDJPY=X",
    name: "Đô la Mỹ / Yên Nhật (USD/JPY)",
    market: "FOREX",
    type: "FX",
    currency: "JPY",
    sector: "Ngoại hối",
  },
  {
    symbol: "AUDUSD=X",
    name: "Đô Úc / Đô la Mỹ (AUD/USD)",
    market: "FOREX",
    type: "FX",
    currency: "USD",
    sector: "Ngoại hối",
  },
];

/** VND=X — er-api chốt giá hằng ngày (forward-accumulating). */
export const ERAPI_INSTRUMENTS: readonly MultiMarketInstrumentDef[] = [
  {
    symbol: "VND=X",
    name: "Đô la Mỹ / Việt Nam Đồng (USD/VND)",
    market: "FOREX",
    type: "FX",
    currency: "VND",
    sector: "Ngoại hối",
  },
];

/** Rổ HÀNG HOÁ + forex phụ — Yahoo query2 sở hữu (seed script tạo Instrument). */
export const YAHOO_MULTI_INSTRUMENTS: readonly MultiMarketInstrumentDef[] = [
  { symbol: "GC=F", name: "Vàng COMEX (tương lai)", market: "COMMODITY", type: "CMDTY", currency: "USD", sector: "Kim loại quý" },
  { symbol: "SI=F", name: "Bạc COMEX (tương lai)", market: "COMMODITY", type: "CMDTY", currency: "USD", sector: "Kim loại quý" },
  { symbol: "BZ=F", name: "Dầu Brent (tương lai)", market: "COMMODITY", type: "CMDTY", currency: "USD", sector: "Năng lượng" },
  { symbol: "CL=F", name: "Dầu WTI (tương lai)", market: "COMMODITY", type: "CMDTY", currency: "USD", sector: "Năng lượng" },
  { symbol: "HG=F", name: "Đồng COMEX (tương lai)", market: "COMMODITY", type: "CMDTY", currency: "USD", sector: "Kim loại công nghiệp" },
  { symbol: "NG=F", name: "Khí tự nhiên (tương lai)", market: "COMMODITY", type: "CMDTY", currency: "USD", sector: "Năng lượng" },
  { symbol: "DX-Y.NYB", name: "Chỉ số Đô la Mỹ (DXY)", market: "FOREX", type: "FX", currency: "USD", sector: "Ngoại hối" },
];

// ─────────────────────────────────────────────────────────────────
// DataSourceStatus keys (mẫu ensureIntlSourceRow — nhãn tạo TRƯỚC)
// ─────────────────────────────────────────────────────────────────

const TREASURY_SOURCE_KEY = "treasury-eod";
const TREASURY_SOURCE_LABEL = "Lợi suất Treasury Mỹ (home.treasury.gov CSV)";
const FRANKFURTER_SOURCE_KEY = "frankfurter-fx";
const FRANKFURTER_SOURCE_LABEL = "Forex ECB (api.frankfurter.dev)";
const ERAPI_SOURCE_KEY = "erapi-fx";
const ERAPI_SOURCE_LABEL = "Tỷ giá USD/VND hằng ngày (open.er-api.com)";

async function ensureSourceRow(key: string, label: string): Promise<void> {
  await db.dataSourceStatus.upsert({
    where: { key },
    create: { key, label, mode: "fallback" },
    update: { label },
  });
}

// ─────────────────────────────────────────────────────────────────
// Tiện ích chung
// ─────────────────────────────────────────────────────────────────

/** Tra instrument theo symbol (chỉ active) — null nếu chưa seed. */
async function findInstrument(symbol: string) {
  return db.instrument.findFirst({
    where: { symbol, isActive: true },
    select: { id: true, symbol: true, market: true, type: true },
  });
}

/** Upsert chuỗi bar + neo quote cho 1 instrument (dùng toRealBars chung). */
async function upsertBarsAndAnchor(
  inst: { id: string; symbol: string; market: string; type: string },
  hist: DchartHistory,
  unit: "BOND" | "FX"
): Promise<number> {
  const spec = unit === "BOND" ? UNIT_BOND : UNIT_FX;
  const { bars } = toRealBars(inst.symbol, hist, spec);
  if (bars.length === 0) return 0;
  const syncAt = new Date();
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
  await anchorQuoteToRealEod(inst.id, bars, spec);
  return bars.length;
}

interface AdapterOutcome {
  ok: boolean;
  barsUpserted: number;
  symbolsOk: string[];
  error?: string;
  durationMs: number;
}

// ─────────────────────────────────────────────────────────────────
// 1. TREASURY — CSV lợi suất chính thức
// ─────────────────────────────────────────────────────────────────

/** Cột CSV → instrument symbol (header: "5 Yr" | "10 Yr" | "30 Yr"). */
const TREASURY_COLUMN_MAP: Record<string, string> = {
  "5 Yr": "US5Y",
  "10 Yr": "US10Y",
  "30 Yr": "US30Y",
};

function treasuryCsvUrl(year: number): string {
  return (
    `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/` +
    `daily-treasury-rates.csv/${year}/all?type=daily_treasury_yield_curve` +
    `&field_tdr_date_value=${year}&page&_format=csv`
  );
}

/** Parse 1 dòng CSV có nháy kép — trả mảng trường. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

/** Chuỗi lợi suất theo symbol từ 2 năm CSV (mới nhất TRƯỚC trong response). */
async function fetchTreasurySeries(): Promise<Map<string, { t: number; y: number }[]>> {
  const now = new Date();
  const years = [now.getUTCFullYear(), now.getUTCFullYear() - 1];
  const series = new Map<string, { t: number; y: number }[]>();
  for (const year of years) {
    const res = await fetch(treasuryCsvUrl(year), {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`Treasury HTTP ${res.status} (năm ${year})`);
    }
    const text = await res.text();
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) continue;
    const header = parseCsvLine(lines[0]);
    // Cột cần theo vị trí thật trong header
    const cols: Array<{ idx: number; symbol: string }> = [];
    header.forEach((h, idx) => {
      const symbol = TREASURY_COLUMN_MAP[h];
      if (symbol) cols.push({ idx, symbol });
    });
    if (cols.length === 0) {
      throw new Error("Treasury CSV thiếu cột 5 Yr/10 Yr/30 Yr — schema drift");
    }
    for (let i = 1; i < lines.length; i++) {
      const fields = parseCsvLine(lines[i]);
      const dateRaw = fields[0]; // MM/DD/YYYY
      const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dateRaw ?? "");
      if (!m) continue;
      const t = Math.floor(
        Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), 0, 0, 0) / 1000
      );
      for (const col of cols) {
        const v = Number(fields[col.idx]);
        if (!Number.isFinite(v)) continue;
        if (!series.has(col.symbol)) series.set(col.symbol, []);
        series.get(col.symbol)!.push({ t, y: v });
      }
    }
  }
  return series;
}

export async function syncTreasuryEod(): Promise<AdapterOutcome> {
  const startedAt = Date.now();
  const symbolsOk: string[] = [];
  let barsUpserted = 0;
  try {
    const series = await fetchTreasurySeries();
    for (const def of TREASURY_INSTRUMENTS) {
      const inst = await findInstrument(def.symbol);
      if (!inst) continue; // chưa seed — trung thực bỏ qua
      const rows = series.get(def.symbol) ?? [];
      if (rows.length === 0) continue;
      const hist: DchartHistory = {
        t: rows.map((r) => r.t),
        o: rows.map((r) => r.y),
        h: rows.map((r) => r.y),
        l: rows.map((r) => r.y),
        c: rows.map((r) => r.y),
        v: rows.map(() => 0),
      };
      barsUpserted += await upsertBarsAndAnchor(inst, hist, "BOND");
      symbolsOk.push(def.symbol);
    }
    await ensureSourceRow(TREASURY_SOURCE_KEY, TREASURY_SOURCE_LABEL);
    await markSource(TREASURY_SOURCE_KEY, {
      mode: "real",
      success: symbolsOk.length > 0,
      lastError: symbolsOk.length > 0 ? null : "Treasury: universe chưa seed (0 instrument BOND)",
      meta: {
        provider: "US Department of the Treasury — daily treasury yield curve CSV",
        symbolsOk: symbolsOk.length,
        barsUpserted,
        years: [new Date().getUTCFullYear(), new Date().getUTCFullYear() - 1],
        note: "Bar lợi suất %×100 (BOND_PCT) — US5Y/US10Y/US30Y · PIT firstSeenAt/lastSyncedAt",
      },
    });
    return {
      ok: true,
      barsUpserted,
      symbolsOk,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    await ensureSourceRow(TREASURY_SOURCE_KEY, TREASURY_SOURCE_LABEL);
    await markSource(TREASURY_SOURCE_KEY, {
      mode: "fallback",
      success: false,
      lastError: err instanceof Error ? err.message : String(err),
    }).catch(() => undefined);
    return {
      ok: false,
      barsUpserted,
      symbolsOk,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// 2. FRANKFURTER — forex majors (ECB)
// ─────────────────────────────────────────────────────────────────

const FRANKFURTER_FROM = "2023-01-01";

/** Cặp frankfurter → cách đổi chiều về quy ước Yahoo {symbol}=X. */
const FRANKFURTER_PAIRS: Array<{
  symbol: string;
  currency: "EUR" | "JPY" | "AUD";
  invert: boolean;
}> = [
  { symbol: "EURUSD=X", currency: "EUR", invert: true }, // 1 USD = x EUR → EURUSD = 1/x
  { symbol: "USDJPY=X", currency: "JPY", invert: false }, // 1 USD = x JPY giữ nguyên
  { symbol: "AUDUSD=X", currency: "AUD", invert: true },
];

interface FrankfurterResponse {
  rates?: Record<string, Record<string, number>>;
}

export async function syncFrankfurterFx(): Promise<AdapterOutcome> {
  const startedAt = Date.now();
  const symbolsOk: string[] = [];
  let barsUpserted = 0;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const url =
      `https://api.frankfurter.dev/v1/${FRANKFURTER_FROM}..${today}` +
      `?base=USD&symbols=EUR,JPY,AUD`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Frankfurter HTTP ${res.status}`);
    const body = (await res.json()) as FrankfurterResponse;
    const rates = body.rates ?? {};
    const dates = Object.keys(rates).sort();
    if (dates.length === 0) throw new Error("Frankfurter trả 0 ngày rates");
    for (const pair of FRANKFURTER_PAIRS) {
      const inst = await findInstrument(pair.symbol);
      if (!inst) continue;
      const t: number[] = [];
      const c: number[] = [];
      for (const d of dates) {
        const v = rates[d]?.[pair.currency];
        if (!Number.isFinite(v) || v <= 0) continue;
        const rate = pair.invert ? 1 / v : v;
        const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
        if (!day) continue;
        t.push(Math.floor(Date.UTC(+day[1], +day[2] - 1, +day[3]) / 1000));
        c.push(rate);
      }
      if (t.length === 0) continue;
      const hist: DchartHistory = {
        t,
        o: c.slice(),
        h: c.slice(),
        l: c.slice(),
        c: c.slice(),
        v: t.map(() => 0),
      };
      barsUpserted += await upsertBarsAndAnchor(inst, hist, "FX");
      symbolsOk.push(pair.symbol);
    }
    await ensureSourceRow(FRANKFURTER_SOURCE_KEY, FRANKFURTER_SOURCE_LABEL);
    await markSource(FRANKFURTER_SOURCE_KEY, {
      mode: "real",
      success: symbolsOk.length > 0,
      lastError: symbolsOk.length > 0 ? null : "Frankfurter: universe chưa seed (0 instrument FOREX)",
      meta: {
        provider: "Frankfurter (ECB reference rates) — api.frankfurter.dev",
        from: FRANKFURTER_FROM,
        days: dates.length,
        symbolsOk: symbolsOk.length,
        barsUpserted,
        note: "Tỷ giá ×10.000 (FX_RATE) · chiều quy ước Yahoo (EURUSD/AUDUSD đảo từ base USD)",
      },
    });
    return {
      ok: true,
      barsUpserted,
      symbolsOk,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    await ensureSourceRow(FRANKFURTER_SOURCE_KEY, FRANKFURTER_SOURCE_LABEL);
    await markSource(FRANKFURTER_SOURCE_KEY, {
      mode: "fallback",
      success: false,
      lastError: err instanceof Error ? err.message : String(err),
    }).catch(() => undefined);
    return {
      ok: false,
      barsUpserted,
      symbolsOk,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// 3. ER-API — USD/VND snapshot hằng ngày (forward-accumulating)
// ─────────────────────────────────────────────────────────────────

interface ErApiResponse {
  result?: string;
  time_last_update_unix?: number;
  rates?: Record<string, number>;
}

export async function syncErApiVnd(): Promise<AdapterOutcome> {
  const startedAt = Date.now();
  const symbolsOk: string[] = [];
  let barsUpserted = 0;
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD", {
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`er-api HTTP ${res.status}`);
    const body = (await res.json()) as ErApiResponse;
    const vnd = body.rates?.VND;
    if (typeof vnd !== "number" || !Number.isFinite(vnd) || vnd <= 0) {
      throw new Error("er-api thiếu rates.VND");
    }
    const inst = await findInstrument("VND=X");
    if (inst) {
      // Neo bar vào NGÀY GIAO DỊCH UTC ĐÃ HOÀN TẤT gần nhất (convention Bar
      // 15:00 UTC): rate er-api cập nhật ~00:02 UTC và giữ nguyên cả ngày;
      // khi engine chạy 06:15 ICT (= 23:15 UTC hôm trước) thì 15:00 UTC của
      // ngày ICT hiện tại còn là TƯƠNG LAI — validator toRealBars sẽ skip bar
      // tương lai. Neo về "ngày 15:00 UTC cuối cùng đã qua" và đi lùi tới
      // THỨ 2–THỨ 6 (đo thật lần 1: bars=0 do neo ngày tương lai; lần 2: neo
      // trúng Chủ nhật bị weekend-skip — thứ Hai phải lùi về thứ Sáu).
      const now = new Date();
      let daySrc = new Date(now.getTime());
      if (now.getUTCHours() < 15) {
        daySrc = new Date(now.getTime() - 24 * 3_600_000);
      }
      while (daySrc.getUTCDay() === 0 || daySrc.getUTCDay() === 6) {
        daySrc = new Date(daySrc.getTime() - 24 * 3_600_000);
      }
      const day = new Date(
        Date.UTC(daySrc.getUTCFullYear(), daySrc.getUTCMonth(), daySrc.getUTCDate(), 15, 0, 0)
      );
      const t = Math.floor(day.getTime() / 1000);
      const hist: DchartHistory = {
        t: [t],
        o: [vnd],
        h: [vnd],
        l: [vnd],
        c: [vnd],
        v: [0],
      };
      barsUpserted += await upsertBarsAndAnchor(inst, hist, "FX");
      symbolsOk.push("VND=X");
    }
    await ensureSourceRow(ERAPI_SOURCE_KEY, ERAPI_SOURCE_LABEL);
    await markSource(ERAPI_SOURCE_KEY, {
      mode: "real",
      success: symbolsOk.length > 0,
      lastError: symbolsOk.length > 0 ? null : "er-api: VND=X chưa seed",
      meta: {
        provider: "open.er-api.com (exchangerate-api free) — latest USD rates",
        vnd,
        updatedAt: body.time_last_update_unix
          ? new Date(body.time_last_update_unix * 1000).toISOString()
          : null,
        barsUpserted,
        note: "CHỈ GIÁ MỚI NHẤT mỗi ngày (forward-accumulating từ #106) — lịch sử VND=X do Yahoo bù khi quota mở",
      },
    });
    return {
      ok: true,
      barsUpserted,
      symbolsOk,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    await ensureSourceRow(ERAPI_SOURCE_KEY, ERAPI_SOURCE_LABEL);
    await markSource(ERAPI_SOURCE_KEY, {
      mode: "fallback",
      success: false,
      lastError: err instanceof Error ? err.message : String(err),
    }).catch(() => undefined);
    return {
      ok: false,
      barsUpserted,
      symbolsOk,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// ORCHESTRATOR — POST /api/market/intl-sync (engine 06:15 ICT)
// ─────────────────────────────────────────────────────────────────

export interface MultiMarketSyncOutcome {
  treasury: AdapterOutcome;
  frankfurter: AdapterOutcome;
  erapi: AdapterOutcome;
  yahoo: IntlSyncOutcome | null;
  durationMs: number;
}

/**
 * Chạy 3 adapter nhanh (Treasury/Frankfurter/er-api) rồi Yahoo query2 (chậm,
 * quota IP — cuối cùng để hỏng cũng không ảnh hưởng 3 rổ kia). Mỗi adapter
 * fail-soft độc lập. Bar mới → xoá cache topByAdtv (rổ US/HK phục vụ đúng).
 */
export async function syncMultiMarkets(opts?: {
  yahooRange?: string;
  skipYahoo?: boolean;
}): Promise<MultiMarketSyncOutcome> {
  const startedAt = Date.now();
  const treasury = await syncTreasuryEod();
  const frankfurter = await syncFrankfurterFx();
  const erapi = await syncErApiVnd();
  let yahoo: IntlSyncOutcome | null = null;
  if (!opts?.skipYahoo) {
    yahoo = await syncIntlEod({ range: opts?.yahooRange }).catch((err) => ({
      ok: false,
      range: opts?.yahooRange ?? "1y",
      symbolsOk: [],
      symbolsEmpty: [],
      symbolsFailed: [],
      barsUpserted: 0,
      barsSkipped: 0,
      nullSkipped: 0,
      adjcloseUsed: [],
      eventsPersisted: 0,
      lastTradeDate: null,
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
  if (treasury.barsUpserted + frankfurter.barsUpserted + erapi.barsUpserted > 0) {
    await invalidateFeatureCache(TOPBYADTV_CACHE_PREFIX).catch(() => undefined);
  }
  return {
    treasury,
    frankfurter,
    erapi,
    yahoo,
    durationMs: Date.now() - startedAt,
  };
}
