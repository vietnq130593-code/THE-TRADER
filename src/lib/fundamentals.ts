/**
 * src/lib/fundamentals.ts — PIPELINE DỮ LIỆU TÀI CHÍNH CƠ BẢN finfo VNDIRECT
 * (MARKET_EXPANSION_BLUEPRINT.md v1.1 — §3.1 adapter `finfo-fundamentals` +
 * Bước 11, phiên #38 Task 40-FUND).
 *
 * SPEC B11 (full):
 *  - fetchFinfoFinancials(symbol): GET ${FINFO_BASE}/v4/financials?symbol=…&period=quarter
 *    (fallback /v4/financial-statements khi endpoint chính HTTP-lỗi hoặc trả
 *    0 dòng) theo phán đoán hợp lý từ VNDIRECT Open API. Field mapping ROBUST —
 *    nhận nhiều tên trường finfo có thể có (revenue|totalRevenue|doanhThu…,
 *    netProfit|profit|loiNhuan…), chu kỳ `quarter` 1..4 → "Q1".."Q4", chuỗi
 *    period "Q1/2024"|"FY2024"|"2024" + trường year/fiscalYear → năm. Parse
 *    thủ công, validate số (bỏ dòng không ra năm hợp lệ / không có số liệu nào).
 *    Lỗi mạng/DNS/timeout (kể cả DNS private) → throw FinfoNetworkError để
 *    caller chuyển mode pending. Response 200 nhưng body lạ → trả [].
 *  - ingestFundamentals(symbols?): mặc định toàn bộ Instrument VN active
 *    (market HOSE/HNX/UPCOM, type STOCK, cap 150 mã như eod-sync B4) → từng mã
 *    fetch + upsert FinancialFundamental mode "real" theo
 *    @@unique([instrumentId, period, year]) (idempotent). Rate limit 500ms/request
 *    (§3.1). BẤT KỲ lỗi mạng đầu tiên → DỪNG fetch phần còn lại, chuyển CẢ kết
 *    quả về mode "pending", rowsUpserted giữ những gì đã có, lastError ghi rõ
 *    nguyên nhân chặn egress — KHÔNG throw lên caller (pattern src/lib/vndirect.ts
 *    #34: fail mềm + DataSourceStatus trung thực, chu kỳ 23 agents không chết).
 *  - latestFundamentals(instrumentId): bản cơ bản MỚI NHẤT mode "real"
 *    (orderBy year desc, period ưu tiên FY → Q4 → Q3 → Q2 → Q1) — helper cho
 *    valuation block buildValuationBlock() chỉ thêm cột P/E·EPS·BVPS·ROE khi
 *    mode=real có dữ liệu (wiring do orchestrator B11 đảm nhiệm, file này thuần lib).
 *  - DataSourceStatus key "fundamentals" — label "Dữ liệu tài chính cơ bản
 *    (finfo)", mode "real"|"pending", meta { provider, instrumentsTried,
 *    instrumentsUpdated, rowsUpserted, unitHeuristic, note } qua markSource()
 *    (@/lib/sources).
 *
 * TRẠNG THÁI PENDING-EGRESS (probe thực đo 2026-10, BLUEPRINT §2):
 *  finfo.vndirect.com.vn giải DNS về 10.210.100.8 (RFC1918 private) → HTTP 000
 *  từ sandbox, KHÔNG egress được. Pipeline viết đầy đủ THEO SPEC: trong sandbox
 *  mọi lần chạy ingestFundamentals() dừng ở lỗi mạng đầu tiên (~10s timeout),
 *  đánh dấu DataSourceStatus mode "pending" + trả ok=false (kỳ vọng, KHÔNG phải
 *  sự cố hệ thống). Khi deploy máy chủ có egress thật (hoặc VNDIRECT whitelist):
 *  finfo sáng → dữ liệu thật chảy vào FinancialFundamental, KHÔNG cần sửa thêm
 *  dòng nào — cùng pattern vndirect.ts #34 đã vận hành từ phiên #34.
 *
 * TODO verify T11.3 (khi có egress thật — BLUEPRINT Bước 11):
 *  (1) đối chiếu P/E VCB với công bố ± 5%;
 *  (2) chốt đơn vị finfo thực tế — revenue/netProfit có thể về triệu VND hoặc
 *      VND nguyên, xem heuristic normalizeMoney() bên dưới + meta.unitHeuristic
 *      đã ghi vào DataSourceStatus để review;
 *  (3) đối chiếu eps/bvps (VND?) và roe/roa (tỷ lệ thô 0,15 hay phần trăm 15?)
 *      — hiện lưu NGUYÊN giá trị finfo trả, KHÔNG tự suy đổi đơn vị.
 *
 * Dùng bởi (wiring sau): runDataCollector (agent-service-runs.ts — ingest tuần)
 * · buildValuationBlock (agent-context.ts). File này KHÔNG import orch layer —
 * thuần lib để subagent #40 triển khai song song không đụng file lân cận.
 */

import { db } from "@/lib/db";
import { markSource, type SourceMode } from "@/lib/sources";
import type { FinancialFundamental, Market } from "@prisma/client";

/** Base URL finfo (public financials) — override được qua env cho môi trường proxy. */
export const FINFO_BASE = process.env.FINFO_BASE_URL ?? "https://finfo.vndirect.com.vn";

/** DataSourceStatus key + label tiếng Việt (BLUEPRINT B11). */
export const FUNDAMENTALS_SOURCE_KEY = "fundamentals";
export const FUNDAMENTALS_SOURCE_LABEL = "Dữ liệu tài chính cơ bản (finfo)";

/**
 * "pending" CHƯA có trong union SourceMode của sources.ts (SOURCE_DEFS chưa
 * khai báo key "fundamentals" — orchestrator bổ sung khi wire UI/coverage
 * matrix B14). Cột DataSourceStatus.mode là String nên lưu được nguyên giá
 * trị; ép kiểu cục bộ tại đây, KHÔNG sửa sources.ts (ràng buộc Task 40-FUND).
 */
const PENDING_SOURCE_MODE = "pending" as unknown as SourceMode;

/** Endpoint finfo theo thứ tự thử: chính → fallback (phán đoán Open API). */
const FINFO_ENDPOINTS = ["/v4/financials", "/v4/financial-statements"] as const;

/** Timeout mặc định 1 request finfo (đủ cho DNS-private nộp HTTP 000 rõ ràng). */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Khoảng cách tối thiểu giữa 2 request finfo (BLUEPRINT §3.1 rate limit). */
const FINFO_REQUEST_INTERVAL_MS = 500;

/** Số mã tối đa 1 chu kỳ ingest (khớp MAX_SYMBOLS_PER_SYNC eod-sync B4). */
const MAX_SYMBOLS_PER_INGEST = 150;

/** Giới hạn phòng thủ số dòng cơ bản/mã (≈ 15 năm × 4 quý + FY). */
const MAX_ROWS_PER_SYMBOL = 60;

/** Năm hợp lệ nhỏ nhất (dữ liệu niêm yết VN sâu nhất ~2000). */
const MIN_YEAR = 2000;

/**
 * Ngưỡng heuristic đơn vị tiền (TODO verify T11.3): doanh thu/lợi nhuận QUÝ của
 * công ty niêm yết VN hầu như luôn ≫ 1 tỷ ₫ (1e9 VND) — nên |raw| > 1e9 chắc
 * chắn finfo trả VND NGUYÊN; |raw| ≤ 1e9 coi finfo trả TRIỆU VND → ×1e6.
 */
const MONEY_UNIT_THRESHOLD = 1e9;

/** Ghi chú chuẩn cho mode pending (task 40-FUND — hiển thị trong DataSourceStatus). */
const PENDING_EGRESS_NOTE =
  "finfo chặn egress từ sandbox (DNS private 10.210.100.8) — pipeline pending, tự sáng khi deploy máy chủ có egress";

/** Ghi chú heuristic đơn vị — đưa vào meta DataSourceStatus để review T11.3. */
const UNIT_HEURISTIC_NOTE =
  "revenue/netProfit: |raw| > 1e9 → coi VND nguyên, ≤ 1e9 → coi triệu VND ×1e6 (heuristic, TODO verify T11.3 khi có egress thật)";

/** Thị trường VN mà finfo phục vụ (cổ phiếu thường). */
const VN_MARKETS: Market[] = ["HOSE", "HNX", "UPCOM"];

/* ─────────────────────────── Types & error class ─────────────────────────── */

export interface FinfoFundamentalRow {
  period: string; // "Q1"|"Q2"|"Q3"|"Q4"|"FY"
  year: number;
  revenue: bigint | null; // VND nguyên
  netProfit: bigint | null; // VND nguyên
  eps: number | null; // VND
  bvps: number | null; // VND
  roe: number | null; // tỷ lệ thô 0.15 = 15%
  roa: number | null;
  pe: number | null;
  pb: number | null;
}

export interface FundamentalsIngestResult {
  /** true chỉ khi mode "real" và không lỗi nào — pending trong sandbox → ok=false là KỲ VỌNG, không phải sự cố. */
  ok: boolean;
  /** pending khi finfo không egress được (sandbox) — real khi fetch/upsert thật chạy. */
  mode: "real" | "pending";
  instrumentsTried: number;
  /** Số mã có ít nhất 1 dòng được upsert — > 0 hầu như chỉ khi mode real. */
  instrumentsUpdated: number;
  /** Rows thật chỉ > 0 khi mode real (hoặc partial-real trước khi đứt mạng giữa chừng). */
  rowsUpserted: number;
  lastError: string | null;
  durationMs: number;
}

/** Lỗi mạng/DNS/timeout finfo — caller (ingestFundamentals) bắt → mode "pending". */
export class FinfoNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FinfoNetworkError";
  }
}

/* ─────────────────────────── Helpers parse ─────────────────────────── */

function errText(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return "hết thời gian chờ (timeout)";
    }
    const cause = (err as { cause?: unknown }).cause;
    const causeText = cause instanceof Error ? ` — cause: ${errText(cause)}` : "";
    return `${err.message}${causeText}`;
  }
  return String(err);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Ép unknown → number: chấp nhận number hoặc string số ("1,234.5" → 1234.5). */
function toNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = v.replace(/[\s,]/g, "");
    if (!s || s === "-" || /^(null|undefined|n\/?a|nan)$/i.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Map key lowercase (giữ value đầu tiên) — field mapping robust finfo. */
function normalizeKeys(raw: Record<string, unknown>): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const [k, v] of Object.entries(raw)) {
    const lk = k.trim().toLowerCase();
    if (lk && !map.has(lk)) map.set(lk, v);
  }
  return map;
}

/** Lấy số theo danh sách alias (key đã lowercase). */
function num(keys: Map<string, unknown>, ...aliases: string[]): number | null {
  for (const alias of aliases) {
    const v = keys.get(alias);
    if (v === undefined || v === null || v === "") continue;
    const n = toNum(v);
    if (n !== null) return n;
  }
  return null;
}

function text(keys: Map<string, unknown>, ...aliases: string[]): string | null {
  for (const alias of aliases) {
    const v = keys.get(alias);
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

/**
 * HEURISTIC ĐƠN VỊ TIỀN (TODO verify T11.3 — xem header file):
 *  |raw| > 1e9  → finfo trả VND NGUYÊN → giữ nguyên (BigInt).
 *  |raw| ≤ 1e9  → finfo trả TRIỆU VND   → × 1e6.
 * Rủi ro chấp nhận: doanh thu quý < 1 tỷ ₫ (công ty siêu nhỏ UPCOM) sẽ bị hiểu
 * nhầm là "triệu VND" — cực hiếm trên sàn niêm yết, và đã ghi rõ trong
 * meta.unitHeuristic DataSourceStatus để đối chiếu khi có egress thật.
 */
function normalizeMoney(raw: number): bigint {
  const negative = raw < 0;
  const magnitude = Math.abs(raw);
  const base = BigInt(Math.round(magnitude));
  const vnd = magnitude > MONEY_UNIT_THRESHOLD ? base : base * BigInt(1_000_000);
  return negative ? -vnd : vnd;
}

/** Float hợp lệ cho tỷ lệ/eps: bỏ NaN/Infinity, chặn độ lớn phi lý (phòng parse rác). */
function saneFloat(v: number | null): number | null {
  if (v === null || !Number.isFinite(v) || Math.abs(v) > 1e12) return null;
  return v;
}

/** Thứ tự ưu tiên kỳ khi chọn "mới nhất": FY > Q4 > Q3 > Q2 > Q1. */
function periodRank(period: string): number {
  switch (period) {
    case "FY":
      return 5;
    case "Q4":
      return 4;
    case "Q3":
      return 3;
    case "Q2":
      return 2;
    case "Q1":
      return 1;
    default:
      return 0;
  }
}

const QUARTER_KEYS = ["quarter", "quy"];
const YEAR_KEYS = ["year", "fiscalyear", "fiscal_year"];
const PERIOD_KEYS = ["period", "reportperiod", "report_period", "kybaocao"];

/**
 * Trích (period, year) từ 1 dòng finfo — chấp nhận nhiều hình thức:
 *  quarter: 1..4 (0/null = cả năm) · period: "Q1/2024"|"Q1 2024"|"Q1"|"1".."4"|
 *  "FY2024"|"2024" · year/fiscalYear: 2000..năm sau.
 * Trả null khi không suy ra được năm hợp lệ (dòng bị bỏ).
 */
function parsePeriodYear(
  keys: Map<string, unknown>
): { period: string; year: number } | null {
  const maxYear = new Date().getUTCFullYear() + 1;
  let quarter: number | null = null;
  let year: number | null = null;

  // (a) trường quarter số 1..4 (0 = FY)
  for (const qk of QUARTER_KEYS) {
    const v = keys.get(qk);
    if (v === undefined || v === null || v === "") continue;
    const n = toNum(v);
    if (n === null) continue;
    const q = Math.round(n);
    if ((q >= 1 && q <= 4) || q === 0) {
      quarter = q;
      break;
    }
  }

  // (b) trường year/fiscalYear
  for (const yk of YEAR_KEYS) {
    const v = keys.get(yk);
    if (v === undefined || v === null || v === "") continue;
    const n = toNum(v);
    if (n !== null && Number.isInteger(n) && n >= MIN_YEAR && n <= maxYear) {
      year = n;
      break;
    }
  }

  // (c) chuỗi period/reportPeriod
  const periodStr = text(keys, ...PERIOD_KEYS);
  if (periodStr) {
    let m = /^q\s*([1-4])\s*(?:[/\-–]\s*(\d{4}))?$/i.exec(periodStr);
    if (m) {
      quarter = Number(m[1]);
      if (m[2]) year = year ?? Number(m[2]);
    } else {
      m = /^([1-4])$/.exec(periodStr);
      if (m) {
        quarter = Number(m[1]);
      } else {
        m = /^(?:fy|full\s*year)?\s*(\d{4})$/i.exec(periodStr);
        if (m) {
          if (quarter === null) quarter = 0; // chỉ có năm → coi là cả năm
          year = year ?? Number(m[1]);
        }
      }
    }
  }

  if (year === null) return null;
  if (quarter === null) quarter = 0;
  return { period: quarter === 0 ? "FY" : `Q${quarter}`, year };
}

/** Alias trường finfo (key lowercase) — mapping robust theo spec B11. */
const REVENUE_KEYS = ["revenue", "totalrevenue", "netrevenue", "grossrevenue", "doanhthu", "total_revenue", "doanh_thu"];
const NETPROFIT_KEYS = [
  "netprofit",
  "profit",
  "netincome",
  "posttaxprofit",
  "profitaftertax",
  "loinhuan",
  "net_profit",
  "loi_nhuan",
];
const EPS_KEYS = ["eps", "basiceps", "basic_eps"];
const BVPS_KEYS = ["bvps", "bookvaluepershare", "equitypershare", "book_value_per_share"];
const ROE_KEYS = ["roe", "returnonequity"];
const ROA_KEYS = ["roa", "returnonassets"];
const PE_KEYS = ["pe", "peratio", "p/e"];
const PB_KEYS = ["pb", "pbratio", "p/b"];
const SYMBOL_KEYS = ["code", "symbol", "ticker", "compcodes", "symbolcode"];

/**
 * Parse 1 dòng finfo → FinfoFundamentalRow. Trả null khi: không có (period,
 * year) hợp lệ · dòng thuộc mã khác với mã yêu cầu (finfo echo sai) · không có
 * bất kỳ số liệu tài chính nào. Đơn vị: revenue/netProfit qua heuristic
 * normalizeMoney (TODO T11.3); eps/bvps/roe/roa/pe/pb lưu NGUYÊN giá trị finfo
 * trả — KHÔNG tự suy đổi (đối chiếu khi egress thật).
 */
function parseFinfoRow(
  raw: Record<string, unknown>,
  expectedSymbol: string
): FinfoFundamentalRow | null {
  const keys = normalizeKeys(raw);

  // dòng thuộc mã khác → bỏ (phòng finfo trả lẫn sang mã khác)
  const rowSymbol = text(keys, ...SYMBOL_KEYS);
  if (rowSymbol && rowSymbol.toUpperCase() !== expectedSymbol) return null;

  const py = parsePeriodYear(keys);
  if (!py) return null;

  const revenue = num(keys, ...REVENUE_KEYS);
  const netProfit = num(keys, ...NETPROFIT_KEYS);
  const eps = num(keys, ...EPS_KEYS);
  const bvps = num(keys, ...BVPS_KEYS);
  const roe = num(keys, ...ROE_KEYS);
  const roa = num(keys, ...ROA_KEYS);
  const pe = num(keys, ...PE_KEYS);
  const pb = num(keys, ...PB_KEYS);
  if (
    revenue === null &&
    netProfit === null &&
    eps === null &&
    bvps === null &&
    roe === null &&
    roa === null &&
    pe === null &&
    pb === null
  ) {
    return null; // dòng không có số liệu tài chính nào dùng được
  }

  return {
    period: py.period,
    year: py.year,
    revenue: revenue === null ? null : normalizeMoney(revenue),
    netProfit: netProfit === null ? null : normalizeMoney(netProfit),
    eps: saneFloat(eps),
    bvps: saneFloat(bvps),
    roe: saneFloat(roe),
    roa: saneFloat(roa),
    pe: saneFloat(pe),
    pb: saneFloat(pb),
  };
}

/** Trích mảng dòng từ envelope finfo ({data:[…]} | {items:[…]} | mảng trần). */
function extractRows(json: unknown): Record<string, unknown>[] {
  if (Array.isArray(json)) return json as Record<string, unknown>[];
  if (json && typeof json === "object") {
    const obj = json as { data?: unknown; items?: unknown; rows?: unknown; results?: unknown };
    for (const key of ["data", "items", "rows", "results"] as const) {
      if (Array.isArray(obj[key])) return obj[key] as Record<string, unknown>[];
    }
  }
  return [];
}

/**
 * Dedupe + MERGE theo (period, year): dòng sau BỔ SUNG/ghi đè trường non-null
 * của dòng trước (finfo có thể tách income/balance/ratio thành nhiều dòng cùng
 * kỳ) + sắp xếp cũ→mới + cap phòng thủ.
 */
function finalizeRows(rows: FinfoFundamentalRow[]): FinfoFundamentalRow[] {
  const byKey = new Map<string, FinfoFundamentalRow>();
  for (const r of rows) {
    const key = `${r.period}/${r.year}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...r });
      continue;
    }
    byKey.set(key, {
      period: r.period,
      year: r.year,
      revenue: r.revenue ?? prev.revenue,
      netProfit: r.netProfit ?? prev.netProfit,
      eps: r.eps ?? prev.eps,
      bvps: r.bvps ?? prev.bvps,
      roe: r.roe ?? prev.roe,
      roa: r.roa ?? prev.roa,
      pe: r.pe ?? prev.pe,
      pb: r.pb ?? prev.pb,
    });
  }
  const sorted = [...byKey.values()].sort(
    (a, b) => a.year - b.year || periodRank(a.period) - periodRank(b.period)
  );
  return sorted.slice(-MAX_ROWS_PER_SYMBOL);
}

/* ─────────────────────────── HTTP layer ─────────────────────────── */

/** GET JSON + timeout — mọi exception (fetch/body) để caller quyết định network-error. */
async function fetchJson(
  url: string,
  timeoutMs: number
): Promise<{ status: number; ok: boolean; json: unknown }> {
  const res = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, ok: res.ok, json };
}

/**
 * Lấy danh sách dòng báo cáo tài chính cơ bản của 1 mã từ finfo.
 *
 * Thử lần lượt /v4/financials → /v4/financial-statements (chỉ thử endpoint kế
 * khi endpoint trước có HTTP response nhưng lỗi cấu hình/trả 0 dòng). Lỗi mạng/
 * DNS/timeout (kể cả DNS private 10.210.100.8 trong sandbox) → throw
 * FinfoNetworkError NGAY (không thử tiếp — mạng hỏng thì hết chuyện). Response
 * 200 nhưng body lạ (không parse được dòng nào) → trả [] — caller xử lý như
 * "mã không có dữ liệu", không phải lỗi mạng.
 */
export async function fetchFinfoFinancials(
  symbol: string,
  opts?: { timeoutMs?: number }
): Promise<FinfoFundamentalRow[]> {
  const sym = String(symbol ?? "").trim().toUpperCase();
  if (!sym) return [];
  const timeoutMs = Math.max(1_000, Math.min(60_000, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS));

  for (let i = 0; i < FINFO_ENDPOINTS.length; i++) {
    const endpoint = FINFO_ENDPOINTS[i];
    if (i > 0) await sleep(FINFO_REQUEST_INTERVAL_MS); // tôn trọng rate limit kể cả nhánh fallback
    const url =
      `${FINFO_BASE}${endpoint}?symbol=${encodeURIComponent(sym)}` +
      `&period=quarter`; // phán đoán hợp lý theo spec finfo: quý + năm gộp trong 1 response
    let res: { status: number; ok: boolean; json: unknown };
    try {
      res = await fetchJson(url, timeoutMs);
    } catch (err) {
      // Lỗi mạng/DNS/timeout — signature FinfoNetworkError để caller vào mode pending.
      throw new FinfoNetworkError(
        `Không kết nối được ${FINFO_BASE}${endpoint}: ${errText(err)}`
      );
    }
    if (!res.ok) continue; // HTTP lỗi endpoint → thử endpoint fallback
    const parsed = extractRows(res.json)
      .map((row) => parseFinfoRow(row, sym))
      .filter((r): r is FinfoFundamentalRow => r !== null);
    if (parsed.length > 0) return finalizeRows(parsed);
    // 200 nhưng 0 dòng dùng được → thử endpoint kế; hết endpoint → [] (body lạ)
  }
  return [];
}

/* ─────────────────────────── Ingest pipeline ─────────────────────────── */

/**
 * Đảm bảo DataSourceStatus "fundamentals" có nhãn tiếng Việt đúng spec B11.
 * markSource() lấy label từ SOURCE_DEFS (chưa có key "fundamentals" — rơi về
 * label = key). Update CÓ ĐIỀU KIỆN: chỉ đè khi dòng còn nhãn fallback, để
 * không xung đột khi orchestrator bổ sung SOURCE_DEFS ở bước wiring UI sau.
 */
async function ensureFundamentalsLabel(): Promise<void> {
  await db.dataSourceStatus.updateMany({
    where: { key: FUNDAMENTALS_SOURCE_KEY, label: FUNDAMENTALS_SOURCE_KEY },
    data: { label: FUNDAMENTALS_SOURCE_LABEL },
  });
}

/**
 * Ingest dữ liệu tài chính cơ bản finfo → FinancialFundamental (mode "real").
 *
 * - `symbols` truyền vào: chỉ resolve đúng các mã đó (báo cáo mã thiếu trong
 *   lastError); bỏ qua: toàn bộ Instrument VN active (HOSE/HNX/UPCOM, STOCK),
 *   cap 150 mã theo symbol asc.
 * - Mỗi mã: fetchFinfoFinancials → upsert từng dòng theo @@unique
 *   (instrumentId, period, year), rate limit 500ms/request.
 * - BẤT KỲ lỗi mạng đầu tiên → dừng toàn bộ phần còn lại, mode → "pending",
 *   giữ rowsUpserted đã có, lastError ghi rõ chặn egress (task 40-FUND).
 * - Lỗi non-network từng mã (parse/DB) → ghi lastError, VẪN TIẾP mã kế.
 * - Cuối cùng markSource("fundamentals", …) + đảm bảo label tiếng Việt —
 *   bản thân markSource cũng được try/catch: hàm này KHÔNG BAO GIỜ throw
 *   lên caller (chu kỳ 23 agents phải sống sót khi finfo chết — T11.1).
 */
export async function ingestFundamentals(
  symbols?: string[]
): Promise<FundamentalsIngestResult> {
  const startedAt = Date.now();

  // ── Chọn danh sách instrument ──
  const requested = (symbols ?? [])
    .map((s) => String(s ?? "").trim().toUpperCase())
    .filter(Boolean);
  const explicit = [...new Set(requested)];
  const instruments = explicit.length
    ? await db.instrument.findMany({
        where: { symbol: { in: explicit } },
        select: { id: true, symbol: true },
        orderBy: { symbol: "asc" },
      })
    : await db.instrument.findMany({
        // UNIVERSE_TIERING §5.6 — cơ bản chỉ nạp cho CORE (T1); BROAD đợi
        // Phase 2 và có nguồn riêng (api-finfo đã verify resolve — §2).
        where: { isActive: true, market: { in: VN_MARKETS }, type: "STOCK", universeTier: "CORE" },
        select: { id: true, symbol: true },
        orderBy: { symbol: "asc" },
        take: MAX_SYMBOLS_PER_INGEST,
      });

  const missing = explicit.filter(
    (s) => !instruments.some((inst) => inst.symbol === s)
  );

  let mode: "real" | "pending" = "real";
  let instrumentsTried = 0;
  let rowsUpserted = 0;
  const instrumentsUpdated = new Set<string>();
  let lastError: string | null =
    missing.length > 0
      ? `không tìm thấy Instrument cho mã: ${missing.join(", ")} (bỏ qua các mã này)`
      : null;

  for (const inst of instruments) {
    try {
      if (instrumentsTried > 0) await sleep(FINFO_REQUEST_INTERVAL_MS);
      instrumentsTried++;
      const rows = await fetchFinfoFinancials(inst.symbol);
      for (const r of rows) {
        await db.financialFundamental.upsert({
          where: {
            instrumentId_period_year: {
              instrumentId: inst.id,
              period: r.period,
              year: r.year,
            },
          },
          create: {
            instrumentId: inst.id,
            period: r.period,
            year: r.year,
            revenue: r.revenue,
            netProfit: r.netProfit,
            eps: r.eps,
            bvps: r.bvps,
            roe: r.roe,
            roa: r.roa,
            pe: r.pe,
            pb: r.pb,
            source: "finfo",
            mode: "real",
          },
          update: {
            revenue: r.revenue,
            netProfit: r.netProfit,
            eps: r.eps,
            bvps: r.bvps,
            roe: r.roe,
            roa: r.roa,
            pe: r.pe,
            pb: r.pb,
            mode: "real",
          },
        });
        rowsUpserted++;
      }
      if (rows.length > 0) instrumentsUpdated.add(inst.id);
    } catch (err) {
      if (err instanceof FinfoNetworkError) {
        // Pattern pending-egress #34: lỗi mạng đầu tiên → dừng hẳn phần còn lại,
        // cả kết quả chuyển mode "pending", KHÔNG throw lên caller.
        mode = "pending";
        lastError = `${PENDING_EGRESS_NOTE}. Chi tiết: ${err.message}`;
        break;
      }
      // Lỗi non-network (parse/DB) của 1 mã — ghi nhận rồi thử mã kế tiếp.
      lastError = `mã ${inst.symbol}: ${errText(err)}`;
    }
  }

  if (instruments.length === 0 && lastError === null) {
    mode = "pending";
    lastError = "không có Instrument VN active nào (HOSE/HNX/UPCOM · STOCK) trong DB — pipeline pending";
  }

  // ── Đánh dấu DataSourceStatus (fail mềm — không bao giờ throw) ──
  let markError: string | null = null;
  try {
    await markSource(FUNDAMENTALS_SOURCE_KEY, {
      mode: mode === "real" ? "real" : PENDING_SOURCE_MODE,
      success: mode === "real" && lastError === null,
      lastError,
      meta: {
        provider: "finfo VNDIRECT",
        endpoint: "/v4/financials (fallback /v4/financial-statements)",
        instrumentsTried,
        instrumentsTotal: instruments.length,
        instrumentsUpdated: instrumentsUpdated.size,
        rowsUpserted,
        unitHeuristic: UNIT_HEURISTIC_NOTE,
        note:
          mode === "pending"
            ? PENDING_EGRESS_NOTE
            : "finfo fundamentals thật (VND nguyên sau heuristic — TODO verify T11.3)",
      },
    });
    await ensureFundamentalsLabel();
  } catch (err) {
    markError = `markSource thất bại: ${errText(err)}`;
  }

  const finalError = lastError ?? markError;
  return {
    ok: mode === "real" && finalError === null,
    mode,
    instrumentsTried,
    instrumentsUpdated: instrumentsUpdated.size,
    rowsUpserted,
    lastError: finalError,
    durationMs: Date.now() - startedAt,
  };
}

/* ─────────────────────────── Helper cho valuation block ─────────────────────────── */

/**
 * Bản cơ bản MỚI NHẤT (mode "real") của 1 instrument — để buildValuationBlock()
 * (B11 wiring) chỉ thêm cột P/E·EPS·BVPS·ROE khi có dữ liệu thật. Ưu tiên năm
 * lớn nhất; trong cùng năm: FY → Q4 → Q3 → Q2 → Q1. Trả null khi chưa có dòng
 * real nào (sandbox pending-egress — valuation block khai báo giới hạn như hiện tại).
 */
export async function latestFundamentals(
  instrumentId: string
): Promise<FinancialFundamental | null> {
  const rows = await db.financialFundamental.findMany({
    where: { instrumentId, mode: "real" },
    orderBy: [{ year: "desc" }],
  });
  if (rows.length === 0) return null;
  const latestYear = rows[0].year;
  const sameYear = rows.filter((r) => r.year === latestYear);
  sameYear.sort((a, b) => periodRank(b.period) - periodRank(a.period));
  return sameYear[0] ?? null;
}
