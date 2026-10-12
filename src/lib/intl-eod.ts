/**
 * src/lib/intl-eod.ts — ĐỒNG BỘ EOD QUỐC TẾ (US/HK) TỪ Yahoo Finance v8 chart
 * (Bước 12 — MARKET_EXPANSION_BLUEPRINT §3.1 adapter `yahoo-intl`, v1.1).
 *
 * Nguồn: GET {YAHOO_BASE}/v8/finance/chart/{symbol}?range=1y&interval=1d&events=div,split
 *        → JSON { chart: { result: [ { timestamp[], indicators: { quote[0].{
 *          open, high, low, close, volume }, adjclose[0].adjclose[] } } ],
 *          error? } } (probe 2026-10-07: HTTP 200 CÓ dữ liệu khi có header
 *          User-Agent — thiếu UA → HTTP 429).
 *        → GIÁ TRẢ VỀ ĐƠN VỊ THÔ NGUỒN: USD/HKD (AAPL 231.4) · index điểm thô
 *          (^HSI ~24.000) — KHÔNG biến đổi ở đây, giao cho toRealBars theo
 *          UnitSpec (§3.2): STOCK/ETF QT → cents ×100 · INDEX QT → điểm ×100
 *          (T12.3).
 *
 * Đặc thù nguồn (v1.1 — vá review 37-PATCH):
 *   - UA header BẮT BUỘC · throttle 1.200ms/request · retry 429/5xx/lỗi mạng
 *     tối đa 3 lần backoff 5s → 15s → 45s (T12.2) · 4xx khác → YahooConfigError
 *     ngay (endpoint đổi hợp đồng — KHÔNG retry mù).
 *   - §B12 v1.1 CHUỘC ADJCLOSE: dùng `indicators.adjclose[0].adjclose[]` làm giá
 *     đóng (đã adjust split/cổ tức — chuỗi đặc trưng không gãy khi tách cổ
 *     phiếu); fallback `close[]` khi adjclose thiếu (hoặc toàn null/lệch độ dài);
 *     cờ adjcloseUsed=true/false báo outcome dùng nguồn nào (T12.6).
 *   - T12.5 NULL-SKIP: Yahoo trả null rải rác trong open/high/low/close/
 *     adjclose/volume (index càng hay gặp) — DỌC SẠCH THEO CHỈ MỰC TRƯỚC khi
 *     vào toRealBars (nó không tự bắt NaN giá): chỉ giữ dòng có timestamp > 0
 *     và o/h/l/c(nguồn đã chọn)/v là số hữu hạn; dòng null bị LOẠI + đếm
 *     nullSkipped minh bạch. T7/CN, ngày tương lai, cận đơn vị, clamp INT4
 *     volume vẫn để toRealBars lo (tái dùng 100% validator eod-sync).
 *
 * Đơn vị & neo Quote: resolveUnitSpec/toRealBars/anchorQuoteToRealEod TÁI DÙNG
 * từ eod-sync.ts (B2 export public) — index/quốc tế trần/sàn = null (T2.3).
 *
 * Dùng bởi: POST /api/market/intl-sync (manual) · market-engine job 06:15 ICT
 * (orchestrator thêm riêng). EOD 1 lần/ngày là đủ (range=1y backfill lần đầu).
 */

import { db } from "@/lib/db";
import { markSource } from "@/lib/sources";
import { invalidateFeatureCache, TOPBYADTV_CACHE_PREFIX } from "@/lib/feature-cache";
import {
  resolveUnitSpec,
  toRealBars,
  anchorQuoteToRealEod,
} from "@/lib/eod-sync";

export const YAHOO_BASE =
  process.env.YAHOO_BASE_URL ?? "https://query2.finance.yahoo.com";

/** Khoảng cách tối thiểu giữa 2 request Yahoo (tôn trọng nguồn công cộng).
 * #106 — nâng 1.200ms → 2.500ms: đo thật 12/10/2026 từ sandbox cho thấy
 * query1 bị 429 chặn hoàn toàn, query2 + UA Windows ổn 9/9 ở nhịp 2,5s
 * (nhịp 1,2s + UA Linux dễ vướng quota IP). */
const REQUEST_INTERVAL_MS = 2_500;

/** UA bắt buộc — Yahoo chối request trần trụi bằng 429 (probe §2 blueprint);
 * #106: đổi sang UA Windows Chrome (đo 12/10: UA Linux dễ dính 429 trên
 * query2, UA Windows chạy thông 9/9). */
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/** Backoff retry 429/5xx/mạng: 5s → 15s → 45s (tối đa 3 lần retry — T12.2). */
const RETRY_BACKOFF_MS = [5_000, 15_000, 45_000];

/** Whitelist range Yahoo cho phép sync (B12 — default "1y" backfill lần đầu). */
export const INTL_RANGES: readonly string[] = [
  "5d",
  "1mo",
  "3mo",
  "6mo",
  "1y",
  "2y",
];
export const DEFAULT_INTL_RANGE = "1y";

/** Số request tối đa trong 1 chu kỳ sync (universe #106 = 14 mã US/HK +
 * 6 hàng hoá + 2 forex Yahoo-phụ ≈ 22 mã — trần 40 giữ room cho watcher). */
const MAX_SYMBOLS_PER_SYNC = 40;

/** DataSourceStatus key riêng cho adapter yahoo-intl (không đè "eod-history"). */
const INTL_SOURCE_KEY = "intl-eod";
const INTL_SOURCE_LABEL = "EOD quốc tế (Yahoo Finance)";

export interface YahooChart {
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
  /** true = c lấy từ adjclose[] (đã adjust split/cổ tức); false = close[]. */
  adjcloseUsed: boolean;
}

export type FetchYahooResult =
  | { empty: true }
  | { empty: false; bars: YahooChart; nullSkipped: number; events: YahooEvent[] };

/** Response đổi hình dạng so với golden signature — cần rà soát nguồn. */
export class YahooConfigError extends Error {}

/** Lỗi mạng/HTTP sau khi retry hết lượt (429/5xx kéo dài, timeout). */
export class YahooNetworkError extends Error {}

let lastRequestAt = 0;

async function throttle(): Promise<void> {
  const wait = REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

function isFin(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Node `chart.result[0]` thô sau JSON.parse — mọi trường unknown (Yahoo là
 * nguồn bên thứ 3, chịu biến thể; chỉ ép kiểu khi đã kiểm tra bằng tay). */
export interface RawYahooChartNode {
  timestamp?: unknown;
  indicators?: {
    quote?: Array<{
      open?: unknown;
      high?: unknown;
      low?: unknown;
      close?: unknown;
      volume?: unknown;
    } | null> | null;
    adjclose?: Array<{ adjclose?: unknown } | null> | null;
  } | null;
  /** P1-1 (#60) — payload `events` Yahoo (đang bị BỎ ĐI): splits[] +
   *  dividends[] — nguồn XÁC ĐỊNH CHÍNH XÁC sự kiện doanh nghiệp US/HK
   *  (không gap-infer như VN — crash −50%/ngày có thật ở Mỹ). */
  events?: {
    splits?: Array<{
      date?: unknown;
      numerator?: unknown;
      denominator?: unknown;
    } | null> | null;
    dividends?: Array<{ date?: unknown; amount?: unknown } | null> | null;
  } | null;
}

/** Sự kiện doanh nghiệp US/HK parse từ payload `events` Yahoo (P1-1). */
export interface YahooEvent {
  /** Ngày hiệu lực (ex-date) — đã đổi về convention Bar 15:00 UTC. */
  date: Date;
  kind: "SPLIT" | "DIVIDEND";
  /** SPLIT: hệ số nhân giá f = denominator/numerator (4:1 → 0,25); DIVIDEND: 0. */
  ratio: number;
  /** SPLIT: numerator/denominator gốc (vd 4/1); DIVIDEND: amount/cổ phiếu. */
  detail: Record<string, number | string>;
}

/** Parse mảng events của Yahoo — bỏ dòng date không phải số, minh bạch. */
export function parseYahooEvents(node: RawYahooChartNode): YahooEvent[] {
  const out: YahooEvent[] = [];
  const splits = node.events?.splits;
  if (Array.isArray(splits)) {
    for (const s of splits) {
      if (!s || typeof s.date !== "number" || s.date <= 0) continue;
      const numerator = typeof s.numerator === "number" && s.numerator > 0 ? s.numerator : null;
      const denominator =
        typeof s.denominator === "number" && s.denominator > 0 ? s.denominator : null;
      const d = new Date(s.date * 1000);
      const date = new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 15, 0, 0)
      );
      const ratio = numerator && denominator ? denominator / numerator : 0;
      out.push({
        date,
        kind: "SPLIT",
        ratio,
        detail: {
          numerator: numerator ?? "?",
          denominator: denominator ?? "?",
          note: `split ${numerator ?? "?"}:${denominator ?? "?"} — f giá = denominator/numerator`,
        },
      });
    }
  }
  const dividends = node.events?.dividends;
  if (Array.isArray(dividends)) {
    for (const d0 of dividends) {
      if (!d0 || typeof d0.date !== "number" || d0.date <= 0) continue;
      const amount = typeof d0.amount === "number" ? d0.amount : null;
      const d = new Date(d0.date * 1000);
      const date = new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 15, 0, 0)
      );
      out.push({
        date,
        kind: "DIVIDEND",
        ratio: 0,
        detail: { amount: amount ?? "?", note: "cổ tức tiền mặt — không đổi hệ số giá" },
      });
    }
  }
  return out;
}

export interface CleanedYahooSeries extends YahooChart {
  /** T12.5 — số dòng bị LOẠI vì null/NaN trong timestamp/o/h/l/c/v. */
  nullSkipped: number;
}

/**
 * DỌC SẠCH NULL (T12.5) — lọc theo chỉ mục i: chỉ giữ dòng có timestamp là số
 * > 0 và o/h/l/c(nguồn ĐÃ CHỌN adjclose-hoặc-close)/v là SỐ HỮU HẠN; dòng
 * null/NaN bị LOẠI + đếm nullSkipped (KHÔNG để NaN lọt vào toRealBars — nó
 * không tự bắt NaN giá). Xuất public để script verify feed mảng thủ công
 * (bar null → đếm đúng).
 *
 * Quy tắc chọn nguồn giá đóng (§B12 v1.1): adjclose[] khi là mảng, đúng độ dài
 * timestamp VÀ có ít nhất 1 giá trị hữu hạn — ngược lại fallback close[]. Khi
 * đã chọn adjclose thì dòng adjclose null bị skip (dù close còn giá) — trộn 2
 * hệ giá (adjust/thô) trong cùng chuỗi sẽ sinh bước nhảy giả khi split.
 *
 * Trả null khi không còn dòng nào dùng được (mã không có dữ liệu — hợp lệ);
 * throw YahooConfigError khi cấu trúc response sai hợp đồng (schema drift).
 */
export function cleanYahooSeries(
  node: RawYahooChartNode
): CleanedYahooSeries | null {
  const ts = node.timestamp;
  if (!Array.isArray(ts)) {
    throw new YahooConfigError(
      "chart.result[0] thiếu mảng timestamp — schema drift"
    );
  }
  if (ts.length === 0) return null; // mã không có dữ liệu — hợp lệ
  const q = node.indicators?.quote?.[0];
  if (!q || typeof q !== "object") {
    throw new YahooConfigError("thiếu indicators.quote[0] — schema drift");
  }
  const oArr = Array.isArray(q.open) ? (q.open as unknown[]) : null;
  const hArr = Array.isArray(q.high) ? (q.high as unknown[]) : null;
  const lArr = Array.isArray(q.low) ? (q.low as unknown[]) : null;
  const cArr = Array.isArray(q.close) ? (q.close as unknown[]) : null;
  const vArr = Array.isArray(q.volume) ? (q.volume as unknown[]) : null;
  if (!oArr || !hArr || !lArr || !cArr || !vArr) {
    throw new YahooConfigError(
      "indicators.quote[0] thiếu một trong o/h/l/c/v — schema drift"
    );
  }

  // §B12 v1.1 — chọn nguồn giá đóng: adjclose ưu tiên, fallback close
  const adj = node.indicators?.adjclose?.[0]?.adjclose;
  const adjOk =
    Array.isArray(adj) && adj.length === ts.length && adj.some((x) => isFin(x));
  const closeSrc: unknown[] = adjOk ? (adj as unknown[]) : cArr;
  const adjcloseUsed = adjOk;

  const t: number[] = [];
  const o: number[] = [];
  const h: number[] = [];
  const l: number[] = [];
  const c: number[] = [];
  const v: number[] = [];
  let nullSkipped = 0;

  for (let i = 0; i < ts.length; i++) {
    const tRaw = ts[i];
    const oRaw = oArr[i];
    const hRaw = hArr[i];
    const lRaw = lArr[i];
    const cRaw = closeSrc[i];
    const vRaw = vArr[i];
    if (
      !isFin(tRaw) ||
      tRaw <= 0 ||
      !isFin(oRaw) ||
      !isFin(hRaw) ||
      !isFin(lRaw) ||
      !isFin(cRaw) ||
      !isFin(vRaw)
    ) {
      nullSkipped++;
      continue;
    }
    t.push(tRaw);
    o.push(oRaw);
    h.push(hRaw);
    l.push(lRaw);
    c.push(cRaw);
    v.push(vRaw);
  }

  if (t.length === 0) return null;
  return { t, o, h, l, c, v, adjcloseUsed, nullSkipped };
}

interface YahooChartEnvelope {
  result?: unknown;
  error?: unknown;
}

/**
 * GET /v8/finance/chart/{symbol} — OHLCV EOD + adjclose (đã adjust split/cổ
 * tức). Retry 429/5xx/lỗi mạng tối đa 3 lần backoff 5s → 15s → 45s (mỗi lần
 * retry log rõ — T12.2); 4xx khác throw YahooConfigError ngay (không retry mù).
 * Body rỗng / `chart.error` present / result rỗng / lọc null xong 0 dòng →
 * `{ empty: true }` (mã không có dữ liệu — hợp lệ, không phải lỗi).
 */
export async function fetchYahooChart(p: {
  symbol: string;
  range: string;
  timeoutMs?: number;
}): Promise<FetchYahooResult> {
  const url =
    `${YAHOO_BASE}/v8/finance/chart/${encodeURIComponent(p.symbol)}` +
    `?range=${encodeURIComponent(p.range)}&interval=1d&events=div,split`;

  let attempt = 0; // 0 = lần đầu · 1..3 = retry (backoff RETRY_BACKOFF_MS)
  for (;;) {
    await throttle();
    let res: Response;
    try {
      res = await fetch(url, {
        signal: AbortSignal.timeout(p.timeoutMs ?? 20_000),
        headers: {
          // UA BẮT BUỘC — thiếu User-Agent Yahoo trả 429 (probe §2)
          "user-agent": USER_AGENT,
          accept: "application/json,text/plain,*/*",
        },
      });
    } catch (err) {
      if (attempt >= RETRY_BACKOFF_MS.length) {
        throw new YahooNetworkError(
          `[${p.symbol}] Yahoo timeout/mạng sau ${attempt + 1} lần thử: ${String(err)}`
        );
      }
      const wait = RETRY_BACKOFF_MS[attempt];
      console.warn(
        `[intl-eod] ${p.symbol} lỗi mạng — retry ${attempt + 1}/${RETRY_BACKOFF_MS.length} sau ${wait}ms (T12.2)`
      );
      await new Promise((r) => setTimeout(r, wait));
      attempt++;
      continue;
    }

    if (res.ok) {
      const text = await res.text();
      if (!text || !text.trim()) return { empty: true }; // mã không có dữ liệu
      let body: { chart?: YahooChartEnvelope };
      try {
        body = JSON.parse(text) as { chart?: YahooChartEnvelope };
      } catch {
        throw new YahooConfigError(
          `[${p.symbol}] Yahoo 200 nhưng body không phải JSON: ${text.slice(0, 120)}`
        );
      }
      const chart = body.chart;
      if (!chart || typeof chart !== "object") {
        throw new YahooConfigError(`[${p.symbol}] thiếu node chart — schema drift`);
      }
      // chart.error present → mã delisted/không tồn tại — hợp lệ, không lỗi
      if (chart.error) return { empty: true };
      const result = chart.result;
      if (!Array.isArray(result) || result.length === 0) return { empty: true };
      const node = result[0];
      if (!node || typeof node !== "object") return { empty: true };
      const cleaned = cleanYahooSeries(node as RawYahooChartNode);
      if (!cleaned) return { empty: true };
      // P1-1 — parse payload events (split/div) TRƯỚC KHI bị bỏ đi
      const events = parseYahooEvents(node as RawYahooChartNode);
      const { nullSkipped, ...bars } = cleaned;
      return { empty: false, bars, nullSkipped, events };
    }

    if (res.status === 429 || res.status >= 500) {
      if (attempt >= RETRY_BACKOFF_MS.length) {
        throw new YahooNetworkError(
          `[${p.symbol}] Yahoo HTTP ${res.status} sau ${attempt + 1} lần thử`
        );
      }
      const wait = RETRY_BACKOFF_MS[attempt];
      console.warn(
        `[intl-eod] ${p.symbol} HTTP ${res.status} — retry ${attempt + 1}/${RETRY_BACKOFF_MS.length} sau ${wait}ms (T12.2)`
      );
      await new Promise((r) => setTimeout(r, wait));
      attempt++;
      continue;
    }

    // 4xx khác — khả năng endpoint đã đổi hợp đồng: KHÔNG retry
    const errText = await res.text().catch(() => "");
    throw new YahooConfigError(
      `[${p.symbol}] Yahoo HTTP ${res.status} bất thường: ${errText.slice(0, 160)}`
    );
  }
}

export interface IntlSyncOutcome {
  ok: boolean;
  range: string;
  symbolsOk: string[];
  symbolsEmpty: string[];
  symbolsFailed: { symbol: string; error: string }[];
  barsUpserted: number;
  barsSkipped: number;
  /** T12.5 — tổng dòng bị LOẠI vì null/NaN ở adapter (đếm minh bạch). */
  nullSkipped: number;
  /** §B12 v1.1 — các mã dùng chuỗi adjclose (đã adjust) làm giá đóng. */
  adjcloseUsed: string[];
  /** P1-1 — số CorporateEvent US/HK parse từ payload events Yahoo. */
  eventsPersisted: number;
  lastTradeDate: string | null;
  durationMs: number;
  error?: string;
}

/**
 * Đảm bảo dòng DataSourceStatus key "intl-eod" tồn tại với nhãn tiếng Việt
 * đúng B12. SOURCE_DEFS thuộc sources.ts (orchestrator quản — subagent này
 * không được sửa), mà markSource lấy label từ SOURCE_DEFS nên phải tạo nhãn
 * trước; markSource sau đó chỉ lo phần trạng thái (mode/lastSuccess/meta).
 */
async function ensureIntlSourceRow(): Promise<void> {
  await db.dataSourceStatus.upsert({
    where: { key: INTL_SOURCE_KEY },
    create: { key: INTL_SOURCE_KEY, label: INTL_SOURCE_LABEL, mode: "fallback" },
    update: { label: INTL_SOURCE_LABEL },
  });
}

/**
 * Đồng bộ EOD quốc tế cho toàn bộ instrument US/HK đang hoạt động (mặc định
 * range "1y" — backfill lần đầu; các ngày sau dùng "5d" là đủ). Mỗi mã:
 * fetchYahooChart (adjclose ưu tiên) → toRealBars theo UnitSpec (cents ×100 /
 * index điểm ×100) → upsert Bar idempotent @@unique([instrumentId, date]) →
 * neo Quote (index/quốc tế KHÔNG trần/sàn). Lỗi 1 mã không làm hỏng cả lượt
 * (try/catch từng mã, gom symbolsFailed) — đối xứng syncEodFromDchart.
 *
 * Circuit-breaker nhẹ: ≥3 mã LIÊN TIẾP lỗi (429 kéo dài/endpoint chết) → ngừng
 * sớm để giữ ngân sách maxDuration 300s của route, phần mã còn lại được ghi
 * rõ "bỏ qua" trong symbolsFailed (không âm thầm nuốt).
 */
export async function syncIntlEod(opts?: {
  range?: string;
}): Promise<IntlSyncOutcome> {
  const startedAt = Date.now();
  const range = opts?.range ?? DEFAULT_INTL_RANGE;
  if (!INTL_RANGES.includes(range)) {
    throw new Error(`range "${range}" không hợp lệ (${INTL_RANGES.join(" | ")})`);
  }

  const instruments = await db.instrument.findMany({
    // #106 §2.3 — Yahoo query2 phụ trách: cổ phiếu/chỉ số US-HK + hàng hoá +
    // các cặp forex Yahoo-phụ (VND=X, DX-Y.NYB). Trái phiếu (Treasury CSV) và
    // 3 cặp forex chính (Frankfurter) có adapter riêng — loại khỏi lượt Yahoo
    // để không đốt quota cho mã nguồn không sở hữu (US10Y không phải mã Yahoo).
    where: {
      isActive: true,
      market: { in: ["US", "HK", "FOREX", "COMMODITY"] },
    },
    select: { id: true, symbol: true, market: true, type: true },
    orderBy: { symbol: "asc" },
    take: MAX_SYMBOLS_PER_SYNC,
  });

  // §2.3 — chỉ gọi Yahoo cho mã thực sự thuộc nguồn Yahoo (tránh xoá trạng
  // thái tốt của các mã Frankfurter EURUSD=X/USDJPY=X/AUDUSD=X do miss):
  // các cặp này vẫn đúng định dạng mã Yahoo nhưng adapter Frankfurter là
  // CHỦ (lịch sử đầy) — Yahoo bỏ qua để dành quota.
  const FRANKFURTER_OWNED = new Set(["EURUSD=X", "USDJPY=X", "AUDUSD=X"]);
  const yahooInstruments = instruments.filter(
    (i) => !FRANKFURTER_OWNED.has(i.symbol)
  );

  const symbolsOk: string[] = [];
  const symbolsEmpty: string[] = [];
  const symbolsFailed: { symbol: string; error: string }[] = [];
  const adjcloseUsed: string[] = [];
  let barsUpserted = 0;
  let barsSkipped = 0;
  let nullSkipped = 0;
  let eventsPersisted = 0;
  let lastTradeDate: string | null = null;
  let failStreak = 0;
  // P1-2 — đồng hồ sync dùng chung (firstSeenAt/lastSyncedAt)
  const syncAt = new Date();

  for (const inst of yahooInstruments) {
    if (failStreak >= 3) {
      symbolsFailed.push({
        symbol: inst.symbol,
        error: "circuit-breaker: nguồn lỗi liên tục, bỏ qua ở lượt này",
      });
      continue;
    }
    try {
      const res = await fetchYahooChart({ symbol: inst.symbol, range });
      if (res.empty) {
        symbolsEmpty.push(inst.symbol);
        failStreak = 0;
        continue;
      }
      nullSkipped += res.nullSkipped;
      if (res.bars.adjcloseUsed) adjcloseUsed.push(inst.symbol);

      // P1-1 — persist sự kiện doanh nghiệp từ payload events Yahoo
      // (nguồn XÁC ĐỊNH CHÍNH XÁC — không heuristic gap-infer như VN).
      // Chuỗi giá đang dùng adjclose → ĐÃ adjust sẵn; fallback raw close
      // → detail cảnh báo "chuỗi chưa adjust" để người đọc biết.
      //
      // F-611B-08/#61 — (a) status trung thực theo adjclose: chuỗi raw-close
      // chưa adjust → SUSPECTED (đúng ngữ nghĩa "ghi nhận, chưa xử lý"), chỉ
      // adjclose mới AUTO_ADJUSTED (trước đây DIVIDEND + raw-fallback đều ghi
      // AUTO_ADJUSTED — nhãn sai); (b) row REVERSED (quyết định NGƯỜI) không
      // bị update đè detail đảo ngược mỗi lần sync lại (trước đây update
      // branch chạy hằng ngày, clobber reversedAt/barsRestored).
      for (const ev of res.events) {
        // F-611R-06/#61 (Vòng 2) — KHÔNG `.catch(() => null)` ở guard REVERSED:
        // DB lỗi → null → nhảy qua check → upsert đè detail row REVERSED (mất
        // reversedAt/barsRestored). Để lỗi NÉM — per-instrument catch của sync
        // bắt vào symbolsFailed (trung thực).
        const existingEvent = await db.corporateEvent.findUnique({
          where: {
            instrumentId_date_kind: {
              instrumentId: inst.id,
              date: ev.date,
              kind: ev.kind,
            },
          },
        });
        if (existingEvent?.status === "REVERSED") {
          continue; // người đã đảo ngược — giữ nguyên row, không đè chi tiết
        }
        await db.corporateEvent
          .upsert({
            where: {
              instrumentId_date_kind: {
                instrumentId: inst.id,
                date: ev.date,
                kind: ev.kind,
              },
            },
            create: {
              instrumentId: inst.id,
              date: ev.date,
              kind: ev.kind,
              ratio: ev.ratio,
              status: res.bars.adjcloseUsed ? "AUTO_ADJUSTED" : "SUSPECTED",
              source: "yahoo-events",
              detail: JSON.stringify({
                ...ev.detail,
                adjustedBy: res.bars.adjcloseUsed ? "yahoo-adjclose" : "raw-close-fallback",
                note: res.bars.adjcloseUsed
                  ? `${ev.detail.note} · chuỗi giá đã adjust bởi adjclose Yahoo`
                  : `${ev.detail.note} · CẢNH BÁO: chuỗi đang dùng close thô (adjclose thiếu) — gap split có thể còn nguyên trong giá`,
              }),
            },
            update: {
              ratio: ev.ratio,
              ...(existingEvent?.status === "SUSPECTED" && res.bars.adjcloseUsed
                ? { status: "AUTO_ADJUSTED" as const } // raw → adjclose: chuỗi giờ ĐÃ adjust — khôi phục nhãn đúng
                : {}),
              source: "yahoo-events",
              detail: JSON.stringify({
                ...ev.detail,
                adjustedBy: res.bars.adjcloseUsed ? "yahoo-adjclose" : "raw-close-fallback",
              }),
            },
          })
          .then(() => {
            eventsPersisted++;
          })
          .catch(() => undefined); // fail-soft — event row không chặn sync
      }

      const unit = resolveUnitSpec(inst.market, inst.type);
      const { bars, skipped } = toRealBars(inst.symbol, res.bars, unit);
      barsSkipped += skipped;
      if (bars.length === 0) {
        symbolsEmpty.push(inst.symbol);
        failStreak = 0;
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
            // P1-2 — PIT: create đặt cả 2 mốc, update chỉ lastSyncedAt
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
      await anchorQuoteToRealEod(inst.id, bars, unit);
      symbolsOk.push(inst.symbol);
      failStreak = 0;
      const d = bars[bars.length - 1].date.toISOString().slice(0, 10);
      if (d > (lastTradeDate ?? "")) lastTradeDate = d;
    } catch (err) {
      symbolsFailed.push({
        symbol: inst.symbol,
        error: err instanceof Error ? err.message : String(err),
      });
      failStreak++;
    }
  }

  // P2-3/#62 — bar US/HK vừa upsert (key cache có chứa market nên xoá cả
  // tiền tố — rẻ, 1 query deleteMany duy nhất) để rổ US/HK nếu được gọi
  // không phục vụ bản cũ 10 phút
  if (barsUpserted > 0) {
    await invalidateFeatureCache(TOPBYADTV_CACHE_PREFIX);
  }

  const outcome: IntlSyncOutcome = {
    // Universe chưa seed (0 instrument) → vẫn ok=true với 0 mã (route
    // sẽ kèm note hướng dẫn chạy expand-universe --intl trước)
    ok:
      yahooInstruments.length === 0 ||
      (symbolsOk.length > 0 && symbolsFailed.length < yahooInstruments.length),
    range,
    symbolsOk,
    symbolsEmpty,
    symbolsFailed,
    barsUpserted,
    barsSkipped,
    nullSkipped,
    adjcloseUsed,
    eventsPersisted,
    lastTradeDate,
    durationMs: Date.now() - startedAt,
  };

  await ensureIntlSourceRow();
  await markSource(INTL_SOURCE_KEY, {
    // "stale" không phải SourceMode hợp lệ của sources.ts — "fallback" chính
    // là chế độ "phục vụ cache + đánh dấu stale" (staleOf coi fallback = stale)
    mode: outcome.ok ? "real" : "fallback",
    success: outcome.ok,
    lastError: outcome.ok
      ? null
      : `sync quốc tế: ${symbolsFailed.length}/${yahooInstruments.length} mã lỗi`,
    meta: {
      source: YAHOO_BASE,
      provider: "Yahoo Finance (v8 chart public)",
      range,
      symbolsOk: symbolsOk.length,
      symbolsEmpty: symbolsEmpty.length,
      symbolsFailed: symbolsFailed.length,
      barsUpserted,
      barsSkipped,
      nullSkipped,
      adjcloseUsed: adjcloseUsed.length,
      eventsPersisted,
      lastTradeDate,
      note: "Bar EOD quốc tế — adjclose ưu tiên (adjust split/cổ tức), cents ×100 / index điểm ×100 (§3.2) · PIT P1-2 · events parse P1-1",
    },
  });

  return outcome;
}
