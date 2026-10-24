/**
 * src/lib/ingest-pipeline.ts — P1-6 (DATA_PLATFORM_BLUEPRINT v1.3 §4.2 + §5):
 * PIPELINE NẠP MỘT CỬA — mọi route nạp đi qua CÙNG một chuỗi hậu kiểm:
 *
 *   fetch → UnitSpec → sanity → upsert → [MODULE NÀY] → WS broadcast
 *                                        │
 *                                        ├─ A9-check thuần (outlier/gap/
 *                                        │  split — scanOutlierBars dùng
 *                                        │  CHUNG với runDataIntegrity)
 *                                        ├─ CorporateEvent scan + auto-adjust
 *                                        │  (P1-1 — VN gap vượt dải)
 *                                        └─ ghi DataSourceStatus meta
 *
 * P0-4 đã chạy hậu kiểm post-hoc (chu kỳ A9) nên bước này CHỈ GOM đường đã
 * kiểm chứng — KHÔNG tái cấu trúc eod-sync/intl-eod (lớp code ổn định
 * #33→#52, review #56: "đụng sớm hơn không có lợi ích tương xứng").
 *
 * S0 REGISTRY CHỦ (kết thúc "hữu danh vô thực" §1.2): INGEST_REGISTRY là
 * bản đồ 10 đường nạp §0.3 — runDataCollector gắn kèm trạng thái sống
 * (DataSourceStatus mode/lastSuccess/lastError) vào IngestSummary mỗi chu
 * kỳ → S0 thực sự LÀ chủ kho & điều phối nạp như roster khai báo.
 *
 * WS broadcast: market-engine gọi các route này qua HTTP rồi broadcast kết
 * quả (kể cả postCheck trong response) qua socket.io — bước "→ WS" của chu
 *ỗi tồn tại sẵn, module không đụng (kỷ luật: engine sở hữu socket).
 *
 * Tick (đường 4/5/10): hậu kiểm là sanity IN-ROUTE (giá > 0 · kẹp dải ±7% ·
 * volume ≥ 0 — Q1/Q2/Q3 §5 DATA_SOURCES) chạy mỗi 10s — KHÔNG nạp bar nên
 * không cần A9-check cửa sổ (tránh query DB mỗi tick).
 *
 * Thuần TypeScript — 0 dependency mới (kỷ luật §6).
 */

import { db } from "@/lib/db";
import { priceBand, scanOutlierBars, type ScanBarInput, type SymbolOutlierScan } from "@/lib/data-quality";
import { scanCorporateEvents, type CorporateEventScanResult } from "@/lib/corporate-events";

/* ═══════════════════════ REGISTRY 10 ĐƯỜNG NẠP (§0.3) ═══════════════════════ */

export interface IngestRouteDef {
  /** Số thứ tự §0.3. */
  no: number;
  /** Tên đường (S0 hiển thị). */
  name: string;
  /** Endpoint/chuỗi thực thi. */
  route: string;
  /** Nguồn → bảng đích. */
  source: string;
  targets: string[];
  /** Lịch vận hành (market-engine). */
  schedule: string;
  /** Lớp phòng thủ hiện có (§0.3 — giữ nguyên, không làm lại). */
  defenses: string;
  /** Hậu kiểm pipeline (P1-6). */
  postCheck: string;
  /** DataSourceStatus key cho trạng thái sống (null = không có row riêng). */
  statusKey: string | null;
}

/** Bản đồ 10 đường nạp — single source of truth cho S0 IngestSummary. */
export const INGEST_REGISTRY: IngestRouteDef[] = [
  {
    no: 1,
    name: "EOD dchart",
    route: "POST /api/market/eod-sync",
    source: "dchart VNDIRECT → Bar + neo Quote",
    targets: ["Bar", "Quote"],
    schedule: "15:45 ICT hằng ngày + boot",
    defenses: "UnitSpec · golden-signature · Q1–Q7 sanity · throttle 300ms · retry ×2 · fail-soft markSource",
    postCheck: "A9-check outlier/gap/split + CorporateEvent scan (P1-1) + cross-check finfo (P1-3) + value re-validate",
    statusKey: "eod-history",
  },
  {
    no: 2,
    name: "Backfill sâu",
    route: 'POST /api/market/eod-sync (body {force: "deep"})',
    source: "dchart 2013→nay → Bar",
    targets: ["Bar"],
    schedule: "thủ công (body {force: \"deep\"})",
    defenses: "như #1, chunk 1000, $transaction từng mã + giữ PIT firstSeenAt (F-611B-04/#61)",
    postCheck: "CorporateEvent scan hội tụ sâu (P1-1) — chạy kèm route (P1-6)",
    statusKey: "eod-history",
  },
  {
    no: 3,
    name: "Yahoo US/HK",
    route: "POST /api/market/intl-sync",
    source: "Yahoo v8 chart → Bar",
    targets: ["Bar", "CorporateEvent"],
    schedule: "06:15 ICT (backoff 30'→4h)",
    defenses: "null-skip · adjclose-preferred · circuit breaker ≥3 fail · UA bắt buộc",
    postCheck: "events parse split/div → CorporateEvent (P1-1) + A9-check cấu trúc",
    statusKey: "intl-eod",
  },
  {
    no: 4,
    name: "finfo realtime",
    route: "POST /api/market/tick (mode realtime-vndirect)",
    source: "finfo → Quote (in-place)",
    targets: ["Quote"],
    schedule: "trong tick 10s (throttle ≥30s)",
    defenses: "fallback random-walk quanh EOD thật, mode fallback",
    postCheck: "sanity in-route (Q1/Q2/Q3) — không nạp bar",
    statusKey: "market-quotes",
  },
  {
    no: 5,
    name: "Tick mô phỏng",
    route: "POST /api/market/tick",
    source: "random-walk → Quote",
    targets: ["Quote"],
    schedule: "tick 10s",
    defenses: "mutex chuỗi promise · kẹp dải ±7%",
    postCheck: "sanity in-route (Q1/Q2/Q3) — không nạp bar",
    statusKey: "market-quotes",
  },
  {
    no: 6,
    name: "Tin RSS",
    route: "market-engine job news",
    source: "5 feed VN → NewsItem",
    targets: ["NewsItem"],
    schedule: "15 phút",
    defenses: "parse RSS2/Atom/RDF · dedupe URL · rate-limit 60s",
    postCheck: "đếm ingest trong S0 IngestSummary (0-bar không áp dụng)",
    statusKey: "news",
  },
  {
    no: 7,
    name: "Dòng khối ngoại",
    route: "GET /api/market/flows",
    source: "mô phỏng deterministic → ForeignFlow",
    targets: ["ForeignFlow"],
    schedule: "theo yêu cầu",
    defenses: "khai báo simulated trung thực",
    postCheck: "persist P1-4 (upsert idempotent theo mã×ngày)",
    statusKey: "foreign-flows",
  },
  {
    no: 8,
    name: "finfo cơ bản",
    route: "S0 chu kỳ (Chủ nhật ICT)",
    source: "finfo → FinancialFundamental",
    targets: ["FinancialFundamental"],
    schedule: "Chủ nhật ICT (qua S0)",
    defenses: "pending-egress — lỗi mạng → mode pending, không phá chu kỳ",
    postCheck: "S0 IngestSummary đếm dòng theo period/year",
    statusKey: "fundamentals",
  },
  {
    no: 9,
    name: "Re-probe watcher",
    route: "POST /api/market/reprobe",
    source: "dchart probe → Instrument + backfill",
    targets: ["Instrument", "Bar"],
    schedule: "Chủ nhật 04:00 ICT",
    defenses: "probe-trước-khi-tạo · cooldown 60s",
    postCheck: "A9-check + CorporateEvent scan cho mã mới phát hiện",
    statusKey: null,
  },
  {
    no: 10,
    name: "Paper matching",
    route: "POST /api/market/tick (matching)",
    source: "tick → Order/Trade/Position",
    targets: ["Order", "Trade", "Position"],
    schedule: "mỗi tick 10s",
    defenses: "claim-based atomic fill",
    postCheck: "sanity in-route (khớp giá/fee/tax — không nạp bar)",
    statusKey: "trading",
  },
];

/* ═══════════════════════ Chuỗi hậu kiểm chung ═══════════════════════ */

export interface PostIngestCheckResult {
  /** Route vừa nạp (key ghi vào DataSourceStatus meta). */
  route: string;
  ranAt: string;
  /** Số mã đưa vào A9-check cửa sổ 92 ngày. */
  checked: number;
  /** Mã có thanh vi phạm cấu trúc/dải (A9-check thuần — cùng hàm chu kỳ). */
  outlierSymbols: string[];
  /** Mã nghi-vấn split (đã qua CorporateEvent scan — còn lại = chưa điều chỉnh). */
  splitSuspects: string[];
  /** Kết quả CorporateEvent scan (P1-1) — null khi route không chạy (US/HK) HOẶC lỗi. */
  corporateEvents: CorporateEventScanResult | null;
  /** F-611B-06/#61 — lỗi DB trong hậu kiểm (không nuốt im lặng như F-591-02):
   * true ⇒ các số trên KHÔNG phải "sạch" mà là "chưa kiểm được". */
  dbFail: boolean;
  /** Chi tiết lỗi dbFail (tối đa 5 dòng — ghi vào meta cho operator). */
  dbFailNotes: string[];
  durationMs: number;
}

/** Cửa sổ A9-check theo ngày lịch — khớp OUTLIER_CALENDAR_DAYS (92 = 1 quý). */
const POST_CHECK_WINDOW_DAYS = 92;

/**
 * Chuỗi hậu kiểm SAU upsert — gọi từ route eod-sync / intl-sync / reprobe
 * (runtime) với tập instrumentIds vừa nạp. KHÔNG đụng vào fetch/UnitSpec/
 * sanity/upsert (đã ổn định #33→#52) — chỉ gom phần KIỂM SAU:
 *
 *   1. A9-check thuần (scanOutlierBars — CÙNG hàm với chu kỳ A9): outlier
 *      cấu trúc/dải + split-nghi-vấn trên cửa sổ 92 ngày của các mã vừa nạp;
 *   2. CorporateEvent scan (P1-1, mặc định cho route có bar VN): quét gap
 *      vượt dải + tự điều chỉnh khi heuristic mức CAO khớp; scan tự re-run
 *      6 phép A9 khi có adjustment (nghiệm thu P1-1);
 *   3. Ghi kết quả vào DataSourceStatus key "ingest-pipeline" (meta merge
 *      theo route) — S0/coverage/UI đọc được trạng thái hậu kiểm.
 *
 * Fail-soft toàn bộ: lỗi hậu kiểm KHÔNG BAO GIỜ làm hỏng route nạp (bar đã
 * upsert an toàn — idempotent; hậu kiểm chạy lại lần sau).
 */
export async function runPostIngestChecks(p: {
  route: string;
  instrumentIds?: string[];
  /** Chạy CorporateEvent scan (mặc định true — chỉ tắt cho US/HK thuần). */
  includeCorporateScan?: boolean;
}): Promise<PostIngestCheckResult> {
  const startedAt = Date.now();
  const dbFailNotes: string[] = [];

  // Tập mã kiểm: truyền vào thì dùng, không thì toàn bộ VN active.
  // F-611B-06/#61 — lỗi DB ghi cờ dbFail (KHÔNG nuốt im lặng: trước đây
  // `.catch(() => [])` cho «instruments rỗng» → checked:0/outlierSymbols:[]
  // trông như "sạch" trong khi thực ra chưa kiểm được gì — đúng mẫu F-591-02).
  let instruments: { id: string; symbol: string; market: string; type: string }[] = [];
  try {
    instruments = await db.instrument.findMany({
      // UNIVERSE_TIERING §5.5 — A9/corporate scan chỉ quét CORE: BROAD không
      // nuôi tín hiệu/ML Phase 1, quét 1.000 mã mỗi 15:45 chỉ tốn ngân sách.
      where: p.instrumentIds
        ? { id: { in: p.instrumentIds } }
        : { isActive: true, market: { in: ["HOSE", "HNX", "UPCOM"] }, universeTier: "CORE" },
      select: { id: true, symbol: true, market: true, type: true },
    });
  } catch (err) {
    dbFailNotes.push(
      `instrument query: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const cutoff = new Date(Date.now() - POST_CHECK_WINDOW_DAYS * 86_400_000);
  const outlierSymbols: string[] = [];
  const splitSuspects: string[] = [];

  for (const inst of instruments) {
    let bars: ScanBarInput[];
    try {
      bars = await db.bar.findMany({
        where: { instrumentId: inst.id, date: { gte: cutoff } },
        orderBy: { date: "asc" },
        select: {
          date: true, open: true, high: true, low: true, close: true,
          volume: true, value: true,
        },
      });
    } catch (err) {
      dbFailNotes.push(
        `bars ${inst.symbol}: ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }
    if (bars.length < 2) continue;
    const scan: SymbolOutlierScan = scanOutlierBars(inst.market, inst.type, bars);
    // F-611B-05/#61 — Hampel chỉ tính cho mã CÓ dải giá (VN) — đúng vũ trụ
    // của A9 (chu kỳ A9 outlier chỉ quét VN; US/HK có ngày ±10% THẬT — đếm
    // Hampel US/HK là crying wolf mà A9 không bao giờ báo, phá cam kết
    // "CÙNG một định nghĩa" giữa route-runtime và chu kỳ A9).
    const hasBand = priceBand(inst.market, inst.type) != null;
    if (scan.structural > 0 || scan.bandViolations > 0 || (hasBand && scan.hampelIssue)) {
      outlierSymbols.push(inst.symbol);
    }
    if (scan.splitSuspect) splitSuspects.push(inst.symbol);
  }

  // CorporateEvent scan (P1-1) — chỉ khi route nạp bar VN.
  // F-611B-06/#61 — lỗi scan ghi cờ (không trả null im lặng — null giờ
  // nghĩa là "route không chạy" hoặc "lỗi — xem dbFailNotes").
  let corporateEvents: CorporateEventScanResult | null = null;
  if (p.includeCorporateScan !== false) {
    try {
      corporateEvents = await scanCorporateEvents({
        instrumentIds: p.instrumentIds,
      });
      if (corporateEvents.failures.length > 0) {
        dbFailNotes.push(
          `corporate scan: ${corporateEvents.failures.length} mã lỗi (${corporateEvents.failures[0].symbol}: ${corporateEvents.failures[0].error})`
        );
      }
    } catch (err) {
      console.error("[ingest-pipeline] corporateEvents scan lỗi:", err);
      dbFailNotes.push(
        `corporate scan throw: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const result: PostIngestCheckResult = {
    route: p.route,
    ranAt: new Date().toISOString(),
    checked: instruments.length,
    outlierSymbols,
    splitSuspects,
    corporateEvents: corporateEvents
      ? {
          ...corporateEvents,
          // candidates có thể dài — giữ 10 mã đầu cho meta gọn
          candidates: corporateEvents.candidates.slice(0, 10),
        }
      : null,
    dbFail: dbFailNotes.length > 0,
    dbFailNotes: dbFailNotes.slice(0, 5),
    durationMs: Date.now() - startedAt,
  };

  // Ghi DataSourceStatus "ingest-pipeline" — meta merge theo route (giữ
  // trạng thái MỚI NHẤT từng route — F-611B-09/#61: comment cũ nói "lịch sử
  // 5 route" là sai, đã sửa cách diễn đạt). Row KHÔNG phải nguồn thị trường
  // → A9 source check đọc theo whitelist 7 nguồn, bỏ qua row này (như
  // "engine-state"). Ghi kèm dbFail để operator phân biệt "sạch" vs "mù".
  const recordErr = await recordPostCheck(p.route, result).catch((err) => {
    dbFailNotes.push(`recordPostCheck: ${err instanceof Error ? err.message : String(err)}`);
    return err;
  });
  if (recordErr) result.dbFail = true;

  return result;
}

/** Ghi meta hậu kiểm vào DataSourceStatus key "ingest-pipeline". */
async function recordPostCheck(route: string, result: PostIngestCheckResult): Promise<void> {
  const row = await db.dataSourceStatus.findUnique({ where: { key: "ingest-pipeline" } });
  let meta: Record<string, unknown> = {};
  if (row?.meta) {
    try {
      meta = JSON.parse(row.meta) as Record<string, unknown>;
    } catch {
      meta = {};
    }
  }
  meta[route] = {
    ranAt: result.ranAt,
    checked: result.checked,
    outliers: result.outlierSymbols.length,
    splitSuspects: result.splitSuspects.length,
    adjusted: result.corporateEvents?.adjusted.length ?? 0,
    // F-611B-06/#61 — cờ trung thực: false = sạch, true = CHƯA KIỂM ĐƯỢC
    dbFail: result.dbFail,
    ...(result.dbFailNotes.length > 0 ? { dbFailNotes: result.dbFailNotes } : {}),
    durationMs: result.durationMs,
  };
  meta.updatedAt = result.ranAt;
  await db.dataSourceStatus.upsert({
    where: { key: "ingest-pipeline" },
    create: {
      key: "ingest-pipeline",
      label: "Hậu kiểm pipeline nạp (P1-6 — không phải nguồn dữ liệu)",
      mode: "real",
      lastSuccessAt: new Date(),
      meta: JSON.stringify(meta),
    },
    update: {
      mode: "real",
      lastSuccessAt: new Date(),
      meta: JSON.stringify(meta),
    },
  });
}

/* ═══════════════════════ S0 registry sống ═══════════════════════ */

export interface IngestRouteStatus extends IngestRouteDef {
  /** Trạng thái sống từ DataSourceStatus (null = chưa có row). */
  status: { mode: string; lastSuccessAt: string | null; lastError: string | null } | null;
}

/**
 * Registry 10 đường + trạng thái sống (merge DataSourceStatus) — S0 gọi mỗi
 * chu kỳ đưa vào IngestSummary (P1-6: "S0 mới thực sự thành chủ registry").
 */
export async function liveIngestRegistry(): Promise<IngestRouteStatus[]> {
  // F-612R-08/#61 (Vòng 2) — KHÔNG nuốt lỗi DB: S0 đọc trạng thái nguồn là
  // CHÍNH XỨC SỞ NGHIỆM VỤ — lỗi phải ném lên để S0 ghi nhận (trước đây
  // .catch(() => []) → S0 broadcast "10 đường — 0 nguồn real/live" + không
  // thấy nguồn nào lỗi — im lặng sai lệch).
  const rows = await db.dataSourceStatus.findMany();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return INGEST_REGISTRY.map((def) => {
    const row = def.statusKey ? byKey.get(def.statusKey) : null;
    return {
      ...def,
      status: row
        ? {
            mode: row.mode,
            lastSuccessAt: row.lastSuccessAt ? row.lastSuccessAt.toISOString() : null,
            lastError: row.lastError ? row.lastError.slice(0, 100) : null,
          }
        : null,
    };
  });
}
