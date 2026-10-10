/**
 * The Trader — Market Engine (mini-service, port 3003)
 * ═══════════════════════════════════════════════════════════════
 * Realtime engine + scheduler cho Giai đoạn 2 (DATA_SOURCES.md roadmap):
 *
 *   1. WebSocket broadcast (socket.io):
 *      - "quotes"  → payload GET/POST /api/market/tick (S4)
 *      - "news"    → kết quả nạp RSS (S5)
 *      - "eod"     → kết quả đồng bộ EOD THẬT VNDIRECT dchart (mới)
 *      - "intl"    → kết quả đồng bộ EOD quốc tế Yahoo (B12 #38)
 *      - "reprobe" → kết quả watcher re-probe ô ⚪/🟡 hằng tuần (B14 #38)
 *      - "cycle"   → kết quả chu kỳ agent (nếu bật scheduler)
 *   2. Scheduler:
 *      - TICK_MS  (mặc định 10s)     : tick bảng giá mô phỏng quanh ref THẬT
 *      - NEWS_MS  (mặc định 15 phút) : crawler RSS 5 nguồn VN
 *      - EOD_SYNC_AT (mặc định 15:45 ICT, hằng ngày, sau giờ chốt phiên):
 *        POST /api/market/eod-sync — kéo bar EOD thật từ dchart VNDIRECT,
 *        neo Quote về mức đóng cửa thật (chỉ chạy MỘT lần/ngày; chạy thêm một
 *        lần lúc boot khi hôm nay CHƯA sync — P0-5: state đã-sync đọc từ DB,
 *        restart không refetch EOD đã xong hôm đó).
 *      - INTL_SYNC_AT (mặc định 06:15 ICT hằng ngày — B12, sau đóng cửa Mỹ):
 *        POST /api/market/intl-sync (range auto: lần đầu 1y, sau đó 5d).
 *        F-441-01 (#44): backoff nhân đôi 30p→4h sau mỗi lần sync LỖI thật.
 *        F-481-01 (#48): guard in-flight engine-side — POST intl kéo dài 2-3p
 *        nên due-check 60s từng bắn POST chồng mỗi phút; 429 mutex của chính
 *        mình bị đếm là "lần sai" → 1 sự cố Yahoo thật thổi backoff 30→120p.
 *        Kể từ #48: đang chạy → KHÔNG bắn thêm; 429 (mutex/cooldown) → KHÔNG
 *        đếm streak, chỉ đợi route rảnh (~90s) rồi thử lại. Guard tương tự áp
 *        cho eod-sync (route không có mutex) và reprobe.
 *      - REPROBE_AT (mặc định Chủ nhật 04:00 ICT hằng tuần — B14/T1):
 *        POST /api/market/reprobe — probe dchart ứng viên các ô ⚪/🟡; mã
 *        đầu tiên CÓ dữ liệu → tự tạo Instrument + backfill → ô tự sáng.
 *      - SETTLE_AT (mặc định 16:15 ICT hằng ngày — A1 #79, ML_OPS_BLUEPRINT
 *        §3): POST /api/ml/settle — kết toán bandit Thompson Sampling (thuần
 *        thuật toán, 0 LLM). Chỉ chạy khi EOD hôm đó ĐÃ sync (eodSyncDate ==
 *        hôm nay — sau 15:45) và chưa settle ngày này; lỗi → log + thử lại
 *        phút sau (không dồn cục — pattern eodSyncDate).
 *      - ML_TRAIN_AT (mặc định "SUN:04:00" Chủ nhật 04:00 ICT hằng tuần —
 *        A4 #79, cùng cửa sổ reprobe B14 — không thêm cửa sổ vận hành mới):
 *        POST /api/ml/train {"force": false} — route tự skip khi windowHash
 *        không đổi (không có bar mới) nên tuần không dữ liệu là $0.
 *      - AGENT_CYCLE_MINUTES (0=off): chu kỳ phân tích đa agent tự động
 *   3. P0-5 (phiên #57 — DATA_PLATFORM_BLUEPRINT §4.2): schedule STATE vào
 *      DB qua /api/market/engine-state (DataSourceStatus.meta key
 *      "engine-state") — boot đọc lại (đã-sync-ngày + backoff intl không còn
 *      bị quên sau restart — G7), ghi sau mỗi sự kiện eod/intl/reprobe.
 *
 * Frontend kết nối QUA GATEWAY với query XTransformPort=3003:
 *   io("/", { query: { XTransformPort: "3003" } })
 * Service này gọi thẳng http://localhost:3000 (server-to-server).
 */

import { createServer } from "node:http";
import { Server } from "socket.io";

const PORT = 3003;
// Phiên #57 — sandbox: "localhost" phân giải ::1 (refused) — app lắng nghe
// 127.0.0.1; engine kết nối thẳng qua IPv4 loopback
const APP_URL = process.env.APP_URL ?? "http://127.0.0.1:3000";

/** Validate env số — chống setInterval(NaN) dồn cục API (AUD-CODE #20). */
function envMs(name: string, fallback: number, minMs: number): number {
  const raw = Number(process.env[name] ?? fallback);
  return Number.isFinite(raw) && raw >= minMs ? raw : fallback;
}
const TICK_MS = envMs("TICK_MS", 10_000, 1_000);
const NEWS_MS = envMs("NEWS_MS", 15 * 60_000, 30_000);
/** Q3 (#79 — §8 duyệt AGENT_CYCLE_MINUTES=240 = 4 GIỜ). Sửa bug đơn vị ẩn
 *  (phát hiện live khi bật env): dòng cũ `envMs(...) / 60_000` trả MILI-GIÂY
 *  rồi chia như thể env nhập ms → env "240" thành interval 240ms (bắn
 *  /api/agents/run mỗi 240ms — route cooldown chặn phần lớn nhưng vẫn lọt
 *  ~3 chu kỳ chồng nhau 14:41-14:42 UTC 10-10, $0 Zen). Giờ đọc env theo
 *  PHÚT đúng tên biến: số ≥ 1 → phút (interval = phút × 60_000); NaN/0 → TẮT. */
const AGENT_CYCLE_MINUTES = (() => {
  const raw = Number(process.env.AGENT_CYCLE_MINUTES ?? 0);
  return Number.isFinite(raw) && raw >= 1 ? raw : 0;
})();
/** Giờ ICT bắt đầu đồng bộ EOD hằng ngày (15:45 — sau giờ chốt 15:00). */
const EOD_SYNC_AT = process.env.EOD_SYNC_AT ?? "15:45";
const EOD_SYNC_DISABLED = process.env.EOD_SYNC_DISABLED === "1";
/** B12 — giờ ICT sync EOD quốc tế Yahoo hằng ngày (06:15 — sau đóng cửa Mỹ). */
const INTL_SYNC_AT = process.env.INTL_SYNC_AT ?? "06:15";
const INTL_SYNC_DISABLED = process.env.INTL_SYNC_DISABLED === "1";
/** B14 — watcher re-probe ô ⚪/🟡 hằng tuần: "SUN:04:00" (Chủ nhật 04:00 ICT). */
const REPROBE_AT = process.env.REPROBE_AT ?? "SUN:04:00";
const REPROBE_DISABLED = process.env.REPROBE_DISABLED === "1";
/** A1 (#79) — giờ ICT kết toán bandit hằng ngày (16:15 — sau eod-sync 15:45
 *  + biên độ chạy 48s của scheduler 60s; settle cần bar EOD hôm đó đã vào). */
const SETTLE_AT = process.env.SETTLE_AT ?? "16:15";
const SETTLE_DISABLED = process.env.SETTLE_DISABLED === "1";
/** A4 (#79) — lịch retrain ML hằng tuần "SUN:04:00" (cùng cửa sổ reprobe B14). */
const ML_TRAIN_AT = process.env.ML_TRAIN_AT ?? "SUN:04:00";
const ML_TRAIN_DISABLED = process.env.ML_TRAIN_DISABLED === "1";

/** "HH:MM" ICT → phút kể từ nửa đêm ICT (UTC+7). */
function parseHhMm(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}
const EOD_SYNC_MINUTES = parseHhMm(EOD_SYNC_AT) ?? parseHhMm("15:45")!;
const INTL_SYNC_MINUTES = parseHhMm(INTL_SYNC_AT) ?? parseHhMm("06:15")!;
const SETTLE_MINUTES = parseHhMm(SETTLE_AT) ?? parseHhMm("16:15")!;

/** "SUN:HH:MM" (tên ngày 3 chữ) hoặc "0:HH:MM" (0=CN..6=T7) → { dow, minutes } — lịch hằng tuần. */
const DOW_NAMES: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
function parseWeekly(s: string): { dow: number; minutes: number } | null {
  const m = /^(SUN|MON|TUE|WED|THU|FRI|SAT):(\d{1,2}):(\d{2})$/i.exec(s.trim());
  if (m) {
    const h = Number(m[2]);
    const min = Number(m[3]);
    if (h > 23 || min > 59) return null;
    return { dow: DOW_NAMES[m[1].toUpperCase()]!, minutes: h * 60 + min };
  }
  // Hỗ trợ cũ "D:HH:MM" (0=CN..6=T7) cho tương thích env đã set theo dạng số.
  const d = /^(\d):(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!d) return null;
  const dow = Number(d[1]);
  const h = Number(d[2]);
  const min = Number(d[3]);
  if (dow > 6 || h > 23 || min > 59) return null;
  return { dow, minutes: h * 60 + min };
}
// Fail-safe 3 lớp: env → mặc định "SUN:04:00" → hằng cứng — không bao giờ null
// (bug #42: trước đây regex cũ không match "SUN:04:00" → null! → TypeError mỗi
// phút trong reprobeDue → uncaught exception giết event loop của engine).
const REPROBE_SCHEDULE: { dow: number; minutes: number } =
  parseWeekly(REPROBE_AT) ?? parseWeekly("SUN:04:00") ?? { dow: 0, minutes: 4 * 60 };
// A4 (#79) — cùng fail-safe 3 lớp cho lịch retrain (đặt SAU DOW_NAMES/parseWeekly
// như REPROBE_SCHEDULE — parseWeekly truy cập DOW_NAMES const, đặt trước sẽ TDZ).
const ML_TRAIN_SCHEDULE: { dow: number; minutes: number } =
  parseWeekly(ML_TRAIN_AT) ?? parseWeekly("SUN:04:00") ?? { dow: 0, minutes: 4 * 60 };

function ictNow(): { date: string; minutes: number; dow: number } {
  const now = new Date(Date.now() + 7 * 3_600_000); // ICT = UTC+7
  return {
    date: now.toISOString().slice(0, 10),
    minutes: now.getUTCHours() * 60 + now.getUTCMinutes(),
    dow: now.getUTCDay(),
  };
}

const stats = {
  startedAt: new Date().toISOString(),
  lastTickAt: null as string | null,
  lastTickError: null as string | null,
  ticks: 0,
  lastNewsAt: null as string | null,
  lastNewsError: null as string | null,
  newsRuns: 0,
  lastEodSyncAt: null as string | null,
  lastEodSyncDate: null as string | null,
  lastEodSyncError: null as string | null,
  eodSyncRuns: 0,
  lastIntlSyncAt: null as string | null,
  lastIntlSyncDate: null as string | null,
  lastIntlSyncError: null as string | null,
  intlSyncRuns: 0,
  lastReprobeAt: null as string | null,
  lastReprobeSunday: null as string | null,
  lastReprobeError: null as string | null,
  reprobeRuns: 0,
  // A1/A4 (#79) — lịch settle + retrain (P0-5: ngày đã chạy sống sót restart)
  lastSettleAt: null as string | null,
  lastSettleDate: null as string | null,
  lastSettleError: null as string | null,
  settleRuns: 0,
  lastMlTrainAt: null as string | null,
  lastMlTrainSunday: null as string | null,
  lastMlTrainError: null as string | null,
  mlTrainRuns: 0,
  lastCycleAt: null as string | null,
  cycles: 0,
  clients: 0,
};

const http = createServer((req, res) => {
  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "market-engine",
        port: PORT,
        eodSyncAt: EOD_SYNC_AT,
        intlSyncAt: INTL_SYNC_AT,
        reprobeAt: REPROBE_AT,
        settleAt: SETTLE_AT,
        mlTrainAt: ML_TRAIN_AT,
        ...stats,
      })
    );
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

const io = new Server(http, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

io.on("connection", (socket) => {
  stats.clients = io.engine.clientsCount;
  socket.emit("welcome", { ok: true, service: "market-engine", ts: Date.now() });
  socket.on("disconnect", () => {
    stats.clients = io.engine.clientsCount;
  });
});

function log(scope: string, msg: string) {
  console.log(`[${new Date().toISOString()}] [${scope}] ${msg}`);
}

/* ═══ P0-5 (phiên #57): schedule STATE → DB qua /api/market/engine-state ═══ */

/** State engine cần sống sót restart (G7 §0.5 blueprint): ngày đã sync +
 *  backoff intl. Lưu trong DataSourceStatus.meta key "engine-state". */
interface EngineState {
  eodSyncDate?: string | null;
  intlSyncDate?: string | null;
  reprobeSunday?: string | null;
  intlFailStreak?: number;
  lastIntlFailAt?: number | null;
  lastEodSyncAt?: string | null;
  lastIntlSyncAt?: string | null;
  lastReprobeAt?: string | null;
  // A1/A4 (#79) — ngày đã settle/retrain + mốc chạy gần nhất (P0-5)
  lastSettleDate?: string | null;
  lastSettleAt?: string | null;
  lastMlTrainSunday?: string | null;
  lastMlTrainAt?: string | null;
}

/** Boot: đọc state từ DB → đổ vào stats + biến backoff (restart không quên). */
async function hydrateEngineState(): Promise<void> {
  try {
    const res = await fetch(`${APP_URL}/api/market/engine-state`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      log("state", `không đọc được engine-state (HTTP ${res.status}) — giữ state rỗng`);
      return;
    }
    const data = (await res.json()) as { state?: EngineState | null };
    const s = data?.state;
    if (!s) {
      log("state", "chưa có engine-state trong DB — bắt đầu state mới (P0-5)");
      return;
    }
    if (typeof s.eodSyncDate === "string") stats.lastEodSyncDate = s.eodSyncDate;
    if (typeof s.intlSyncDate === "string") stats.lastIntlSyncDate = s.intlSyncDate;
    if (typeof s.reprobeSunday === "string") stats.lastReprobeSunday = s.reprobeSunday;
    if (typeof s.lastEodSyncAt === "string") stats.lastEodSyncAt = s.lastEodSyncAt;
    if (typeof s.lastIntlSyncAt === "string") stats.lastIntlSyncAt = s.lastIntlSyncAt;
    if (typeof s.lastReprobeAt === "string") stats.lastReprobeAt = s.lastReprobeAt;
    // A1/A4 (#79) — phục hồi lịch settle/retrain (restart giữa chừng không
    // double-settle: settlePendingRewards idempotent, nhưng tránh cả lần gọi
    // thừa; retrain Chủ nhật không chạy lại sau restart cùng ngày).
    if (typeof s.lastSettleDate === "string") stats.lastSettleDate = s.lastSettleDate;
    if (typeof s.lastSettleAt === "string") stats.lastSettleAt = s.lastSettleAt;
    if (typeof s.lastMlTrainSunday === "string") stats.lastMlTrainSunday = s.lastMlTrainSunday;
    if (typeof s.lastMlTrainAt === "string") stats.lastMlTrainAt = s.lastMlTrainAt;
    if (typeof s.intlFailStreak === "number") intlFailStreak = s.intlFailStreak;
    if (typeof s.lastIntlFailAt === "number") lastIntlFailAt = s.lastIntlFailAt;
    log(
      "state",
      `phục hồi state từ DB (P0-5): eod=${stats.lastEodSyncDate ?? "—"} · intl=${stats.lastIntlSyncDate ?? "—"} · reprobe=${stats.lastReprobeSunday ?? "—"} · settle=${stats.lastSettleDate ?? "—"} · ml-train=${stats.lastMlTrainSunday ?? "—"} · intlFailStreak=${intlFailStreak}`
    );
  } catch (err) {
    // App chưa sẵn sàng lúc boot engine — giữ state rỗng, sự kiện sync đầu
    // tiên sẽ tự ghi state mới (fail-soft, không chặn boot)
    log("state", `hydrate bỏ qua (app chưa sẵn sàng?): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Ghi state hiện tại vào DB — gọi sau mỗi sự kiện eod/intl/reprobe (thay đổi
 *  ngày đã-sync / backoff). Thất bại chỉ log — không ảnh hưởng chu kỳ sync. */
async function persistEngineState(): Promise<void> {
  try {
    await fetch(`${APP_URL}/api/market/engine-state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        eodSyncDate: stats.lastEodSyncDate,
        intlSyncDate: stats.lastIntlSyncDate,
        reprobeSunday: stats.lastReprobeSunday,
        intlFailStreak,
        lastIntlFailAt,
        lastEodSyncAt: stats.lastEodSyncAt,
        lastIntlSyncAt: stats.lastIntlSyncAt,
        lastReprobeAt: stats.lastReprobeAt,
        lastSettleDate: stats.lastSettleDate,
        lastSettleAt: stats.lastSettleAt,
        lastMlTrainSunday: stats.lastMlTrainSunday,
        lastMlTrainAt: stats.lastMlTrainAt,
      } satisfies EngineState),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    log("state", `không lưu được engine-state: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** F-481-01 — lỗi HTTP giữ status để caller phân biệt 429 (route bận:
 * mutex/cooldown — không phải lỗi nguồn dữ liệu) với 502/500 thật. */
class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "HttpError";
  }
}

async function postJson(
  path: string,
  body?: unknown,
  opts?: { timeoutMs?: number }
): Promise<Record<string, unknown>> {
  const res = await fetch(`${APP_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(opts?.timeoutMs ?? 120_000),
  });
  const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const error = typeof parsed.error === "string" ? parsed.error : `HTTP ${res.status}`;
    throw new HttpError(error, res.status);
  }
  return parsed;
}

/** AUD-CODE #20: mutex in-process — tick mới chờ tick cũ xong (chống lost-update). */
let tickChain: Promise<void> = Promise.resolve();
function enqueueTick(): Promise<void> {
  const run = tickChain.then(tickAndBroadcast).catch(() => undefined);
  tickChain = run;
  return run;
}

async function tickAndBroadcast(): Promise<void> {
  try {
    const data = await postJson("/api/market/tick");
    stats.lastTickAt = new Date().toISOString();
    stats.ticks++;
    stats.lastTickError = null;
    io.emit("quotes", data);
  } catch (err) {
    stats.lastTickError = err instanceof Error ? err.message : String(err);
    log("tick", `LỖI: ${stats.lastTickError}`);
  }
}

async function ingestNewsAndBroadcast(): Promise<void> {
  try {
    const data = await postJson("/api/news");
    stats.lastNewsAt = new Date().toISOString();
    stats.newsRuns++;
    stats.lastNewsError = null;
    io.emit("news", data);
    log("news", `nạp xong: +${data.added ?? 0} tin (${data.mode ?? "?"})`);
  } catch (err) {
    // 429 rate-limit là bình thường khi scheduler dồn lịch — không báo động
    stats.lastNewsError = err instanceof Error ? err.message : String(err);
    log("news", `bỏ qua: ${stats.lastNewsError}`);
  }
}

/** Đồng bộ EOD thật: kéo bar dchart → neo Quote → broadcast "eod".
 * F-481-01: guard in-flight engine-side chặn bắn thêm khi cũ chưa xong.
 * F-611B-02/#61: POST eod-sync giờ mang chuỗi hậu kiểm P1-6 nặng (scan
 * outlier + corporate scan + A9 re-run khi adjust — thực đo #60: 9,7s/vòng,
 * có adjust + full A9 → ~60-90s) trong khi maxDuration route là 300s. Timeout
 * mặc định 120s của postJson SẼ cắt sớm khi tải nặng → abort + do đó eod-sync
 * chạy tiếp server-side → guard in-flight engine đã NHẢ ở lúc abort →
 * due-check 60s sau bắn POST THỨ HAI chồng lên (route từng không mutex).
 * Cả 2 lớp đã vá: timeout 280s < 300s (như INTL_SYNC_POST_TIMEOUT_MS) +
 * route-side mutex 429 (pattern F-441-01). */
let eodSyncInFlight = false;
const EOD_SYNC_POST_TIMEOUT_MS = 280_000;
async function syncEodAndBroadcast(): Promise<void> {
  eodSyncInFlight = true;
  try {
    const data = await postJson("/api/market/eod-sync", { days: 10 }, {
      timeoutMs: EOD_SYNC_POST_TIMEOUT_MS,
    });
    stats.lastEodSyncAt = new Date().toISOString();
    stats.eodSyncRuns++;
    stats.lastEodSyncError = null;
    const ict = ictNow();
    stats.lastEodSyncDate = ict.date;
    io.emit("eod", data);
    log(
      "eod",
      `đồng bộ EOD thật xong: ${data.symbolsOk ? (data.symbolsOk as unknown[]).length : "?"} mã · ${data.barsUpserted ?? 0} bar · phiên cuối ${data.lastTradeDate ?? "?"}`
    );
  } catch (err) {
    stats.lastEodSyncError = err instanceof Error ? err.message : String(err);
    log("eod", `LỖI: ${stats.lastEodSyncError}`);
  } finally {
    eodSyncInFlight = false;
    // P0-5 — state đã-sync-ngày sống sót restart
    void persistEngineState();
  }
}

/** B12 — sync EOD quốc tế Yahoo (06:15 ICT hằng ngày): broadcast "intl".
 *
 * F-441-01 (#44): lần đầu lỗi → KHÔNG retry mỗi phút suốt ngày (tự đấm Yahoo
 * 429, giữ nguồn chết vĩnh viễn). Backoff nhân đôi 30p → 1h → 2h → 4h (cap)
 * kể từ lần thử lỗi gần nhất; thành công → reset streak + đánh dấu ngày.
 * Timeout POST riêng 280s < maxDuration route 300s (sync 14 mã + backoff
 * retry 429 có thể vượt 120s mặc định — cắt sớm đồng nghĩa coi là fail).
 */
const INTL_SYNC_POST_TIMEOUT_MS = 280_000;
const INTL_FAIL_BACKOFF_BASE_MS = 30 * 60_000;
const INTL_FAIL_BACKOFF_CAP_MS = 4 * 60 * 60_000;
let intlFailStreak = 0;
let lastIntlFailAt: number | null = null;
/** F-481-01 (#48): POST intl đang chạy (2-3 phút) → due-check không bắn
 * thêm; 429 từ route (mutex/cooldown) → mở cửa sổ đợi ~90s, KHÔNG đếm streak. */
let intlSyncInFlight = false;
let intlBusyUntil = 0;

async function syncIntlAndBroadcast(): Promise<void> {
  intlSyncInFlight = true;
  try {
    // range auto: lần đầu (chưa có bar) → 1y backfill; sau đó 5d hằng ngày
    const data = await postJson("/api/market/intl-sync", { range: "auto" }, {
      timeoutMs: INTL_SYNC_POST_TIMEOUT_MS,
    });
    stats.lastIntlSyncAt = new Date().toISOString();
    stats.intlSyncRuns++;
    stats.lastIntlSyncError = null;
    const ict = ictNow();
    stats.lastIntlSyncDate = ict.date;
    intlFailStreak = 0; // thành công — reset backoff
    lastIntlFailAt = null;
    io.emit("intl", data);
    const okCount = Array.isArray(data.symbolsOk) ? (data.symbolsOk as unknown[]).length : "?";
    log(
      "intl",
      `sync EOD quốc tế (Yahoo) xong: ${okCount} mã · ${data.barsUpserted ?? 0} bar${data.nullSkipped != null ? ` · ${data.nullSkipped} null-skip` : ""}`
    );
  } catch (err) {
    // F-481-01: 429 = route từ chối vì sync TRƯỚC vẫn chạy (mutex F-441-01)
    // hoặc vừa xong cách đây <30s (cooldown) — không phải lỗi Yahoo. Trước đây
    // từng bị đếm là "lần sai liên tiếp" (mỗi tick 60s trong lúc sync 2-3p lại
    // bắn POST chồng → mutex 429 ×2-3 + 502 thật → streak 3-4 → backoff nhảy
    // 120-240p chỉ sau MỘT sự cố). Giờ: chỉ đợi route rảnh rồi thử lại sạch.
    if (err instanceof HttpError && err.status === 429) {
      intlBusyUntil = Date.now() + 90_000;
      log("intl", `bỏ qua (route đang bận — sync trước vẫn chạy): ${err.message}`);
      return;
    }
    stats.lastIntlSyncError = err instanceof Error ? err.message : String(err);
    intlFailStreak++;
    lastIntlFailAt = Date.now();
    // Yahoo 429 tạm thời là bình thường — backoff (F-441-01), không đấm mỗi phút
    const nextRetryMs = Math.min(
      INTL_FAIL_BACKOFF_CAP_MS,
      INTL_FAIL_BACKOFF_BASE_MS * 2 ** (intlFailStreak - 1)
    );
    log(
      "intl",
      `bỏ qua (lần sai liên tiếp thứ ${intlFailStreak}): ${stats.lastIntlSyncError} — thử lại sau ${Math.round(nextRetryMs / 60_000)} phút`
    );
  } finally {
    intlSyncInFlight = false;
    // P0-5 — backoff intl sống sót restart (streak + lastFailAt)
    void persistEngineState();
  }
}

/** B14 — watcher re-probe ô ⚪/🟡 (Chủ nhật 04:00 ICT): broadcast "reprobe".
 * F-481-01: guard in-flight (route có cooldown 60s nhưng không mutex). */
let reprobeInFlight = false;
async function reprobeAndBroadcast(): Promise<void> {
  reprobeInFlight = true;
  try {
    // F-612R-01/#61 (Vòng 2) — timeout 280s < maxDuration route 300s (18 ứng
    // viên × probe 15s + deep backfill 30s có thể vượt 120s mặc định → abort
    // engine trong khi route vẫn chạy → re-fire chồng lấn; route giờ có mutex
    // 429 nhưng đúng lịch vẫn nên để 1 lần chạy tới cùng)
    const data = await postJson("/api/market/reprobe", {}, { timeoutMs: 280_000 });
    stats.lastReprobeAt = new Date().toISOString();
    stats.reprobeRuns++;
    stats.lastReprobeError = null;
    const ict = ictNow();
    stats.lastReprobeSunday = ict.date;
    io.emit("reprobe", data);
    const created = Array.isArray(data.created) ? (data.created as string[]) : [];
    log(
      "reprobe",
      `watcher re-probe xong: ${data.probed ?? "?"} ứng viên · tạo mới ${created.length}${created.length ? ` (${created.join(", ")})` : ""} · trống ${Array.isArray(data.empty) ? (data.empty as string[]).length : "?"}`
    );
  } catch (err) {
    stats.lastReprobeError = err instanceof Error ? err.message : String(err);
    log("reprobe", `bỏ qua: ${stats.lastReprobeError}`);
  } finally {
    reprobeInFlight = false;
    // P0-5 — tuần đã reprobe sống sót restart
    void persistEngineState();
  }
}

async function runAgentCycleAndBroadcast(): Promise<void> {
  try {
    const data = await postJson("/api/agents/run");
    stats.lastCycleAt = new Date().toISOString();
    stats.cycles++;
    io.emit("cycle", data);
    log("cycle", `chu kỳ agent hoàn tất (${data.durationMs ?? "?"}ms)`);
  } catch (err) {
    log("cycle", `LỖI: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** A1 (#79) — kết toán bandit theo lịch (16:15 ICT hằng ngày, sau eod-sync):
 *  POST /api/ml/settle → broadcast "settle". Thuần thuật toán ~1-2s, 0 LLM.
 *  F-481-01 pattern: guard in-flight chống due-check 60s bắn POST chồng
 *  (route settle có mutex chuỗi Promise nhưng chỉ 1 lần chạy tới cùng).
 *  Thất bại → KHÔNG đánh dấu ngày — phút sau thử lại (không dồn cục). */
let settleInFlight = false;
const SETTLE_POST_TIMEOUT_MS = 60_000;
async function settleAndBroadcast(): Promise<void> {
  settleInFlight = true;
  try {
    const data = await postJson("/api/ml/settle", undefined, {
      timeoutMs: SETTLE_POST_TIMEOUT_MS,
    });
    stats.lastSettleAt = new Date().toISOString();
    stats.settleRuns++;
    stats.lastSettleError = null;
    const ict = ictNow();
    stats.lastSettleDate = ict.date;
    io.emit("settle", data);
    log(
      "settle",
      `kết toán bandit A1 xong: ${data.settled ?? "?"} assessment · ${data.votes ?? "?"} phiếu`
    );
  } catch (err) {
    stats.lastSettleError = err instanceof Error ? err.message : String(err);
    log("settle", `LỖI (thử lại phút sau): ${stats.lastSettleError}`);
  } finally {
    settleInFlight = false;
    // P0-5 — ngày đã settle sống sót restart
    void persistEngineState();
  }
}

/** A4 (#79) — retrain ML Chủ nhật 04:00 ICT: POST /api/ml/train {"force":
 *  false}. Timeout 280s < maxDuration route (train thật 30-60s; route tự
 *  skip khi windowHash không đổi — tuần không dữ liệu là $0). F-481-01
 *  pattern: guard in-flight — train dài 60s+ không bị due-check bắn chồng
 *  (route có mutex + cooldown 429, đúng lịch vẫn 1 lần chạy tới cùng).
 *  Thất bại → KHÔNG đánh dấu Chủ nhật — phút sau thử lại. */
let mlTrainInFlight = false;
const ML_TRAIN_POST_TIMEOUT_MS = 280_000;
async function mlTrainAndBroadcast(): Promise<void> {
  mlTrainInFlight = true;
  try {
    const data = await postJson("/api/ml/train", { force: false }, {
      timeoutMs: ML_TRAIN_POST_TIMEOUT_MS,
    });
    stats.lastMlTrainAt = new Date().toISOString();
    stats.mlTrainRuns++;
    stats.lastMlTrainError = null;
    const ict = ictNow();
    stats.lastMlTrainSunday = ict.date;
    io.emit("ml-train", data);
    const trained = Array.isArray(data.trained) ? (data.trained as string[]).join("+") : "?";
    log(
      "ml-train",
      `retrain A4 xong (${data.skipped === true ? "skip — windowHash không đổi" : `train ${trained}`}) · ${(data.durationMs ?? "?")}ms`
    );
  } catch (err) {
    stats.lastMlTrainError = err instanceof Error ? err.message : String(err);
    log("ml-train", `LỖI (thử lại phút sau): ${stats.lastMlTrainError}`);
  } finally {
    mlTrainInFlight = false;
    // P0-5 — Chủ nhật đã retrain sống sót restart
    void persistEngineState();
  }
}

/** Kiểm tra hằng phút: đã qua 15:45 ICT hôm nay và chưa sync ngày này → sync.
 * F-481-01: sync cũ chưa xong (~40s) → không bắn thêm. */
function eodSyncDue(): boolean {
  if (EOD_SYNC_DISABLED) return false;
  if (eodSyncInFlight) return false;
  const ict = ictNow();
  return ict.minutes >= EOD_SYNC_MINUTES && stats.lastEodSyncDate !== ict.date;
}

/** A1 (#79) — đã qua 16:15 ICT · EOD hôm nay ĐÃ sync (bar đã vào DB trước khi
 *  kết toán) · chưa settle ngày này → kết toán bandit. Gate `lastEodSyncDate
 *  === ict.date` là điều kiện "chỉ settle sau EOD hôm đó" (blueprint A1.2);
 *  settle idempotent qua settledKeys nên chạy nhắc lại vô hại $0.
 *  F-801-01 (Fixbug #80 — Vòng 1): bổ sung guard T7/CN theo nghiệm thu A1(4)
 *  "ngày lễ/T7/CN không chạy" — trước đây settle vẫn chạy cuối tuần vì
 *  eod-sync đánh dấu ngày đã-sync cả T7/CN (đo thật 10-10: settle 14:45 UTC
 *  0/0 phiếu). An toàn để bỏ: settlePendingRewards là FULL-SCAN mọi phiếu
 *  chờ (30 assessment gần nhất) nên phiếu lỡ hẹn Thứ 6 (engine chết cả ngày)
 *  vẫn được Thứ 2 16:15 quét bù. Ngày LỄ: engine không có lịch lễ —
 *  eodSyncDate-gate vẫn cho chạy nhưng settle 0 phiếu mới (idempotent, $0). */
function settleDue(): boolean {
  if (SETTLE_DISABLED) return false;
  if (settleInFlight) return false;
  const ict = ictNow();
  if (ict.dow === 0 || ict.dow === 6) return false; // CN=0 · T7=6
  return (
    ict.minutes >= SETTLE_MINUTES &&
    stats.lastEodSyncDate === ict.date &&
    stats.lastSettleDate !== ict.date
  );
}

/** A4 (#79) — Chủ nhật, đã qua 04:00 ICT, chưa train Chủ nhật này → retrain
 *  (y hệt pattern reprobeDue: parseWeekly "SUN:04:00" · guard in-flight). */
function mlTrainDue(): boolean {
  if (ML_TRAIN_DISABLED || !ML_TRAIN_SCHEDULE) return false;
  if (mlTrainInFlight) return false;
  const ict = ictNow();
  return (
    ict.dow === ML_TRAIN_SCHEDULE.dow &&
    ict.minutes >= ML_TRAIN_SCHEDULE.minutes &&
    stats.lastMlTrainSunday !== ict.date
  );
}

/** B12 — đã qua 06:15 ICT hôm nay và chưa sync ngày này → sync.
 * F-441-01: lần gần nhất LỖI thì phải đủ backoff nhân đôi (30p → cap 4h)
 * mới được thử lại — chống retry mỗi phút suốt ngày (đấm Yahoo 429). */
function intlSyncDue(): boolean {
  if (INTL_SYNC_DISABLED) return false;
  // F-481-01: POST cũ 2-3 phút chưa về → KHÔNG bắn thêm (từng khiến mỗi tick
  // 60s lại bắn POST chồng, mutex 429 bị đếm là "lần sai" → backoff thổi lên).
  if (intlSyncInFlight) return false;
  if (Date.now() < intlBusyUntil) return false;
  const ict = ictNow();
  if (ict.minutes < INTL_SYNC_MINUTES || stats.lastIntlSyncDate === ict.date) {
    return false;
  }
  if (lastIntlFailAt != null) {
    const backoffMs = Math.min(
      INTL_FAIL_BACKOFF_CAP_MS,
      INTL_FAIL_BACKOFF_BASE_MS * 2 ** Math.max(0, intlFailStreak - 1)
    );
    if (Date.now() - lastIntlFailAt < backoffMs) return false;
  }
  return true;
}

/** B14 — Chủ nhật, đã qua 04:00 ICT, chưa chạy tuần này → re-probe.
 * F-481-01: probe cũ chưa xong → không bắn thêm. */
function reprobeDue(): boolean {
  if (REPROBE_DISABLED || !REPROBE_SCHEDULE) return false;
  if (reprobeInFlight) return false;
  const ict = ictNow();
  return (
    ict.dow === REPROBE_SCHEDULE.dow &&
    ict.minutes >= REPROBE_SCHEDULE.minutes &&
    stats.lastReprobeSunday !== ict.date
  );
}

http.listen(PORT, () => {
  log("boot", `market-engine lắng nghe cổng ${PORT} → app ${APP_URL}`);
  log(
    "boot",
    `lịch: tick ${(TICK_MS / 1000).toFixed(0)}s · news ${(NEWS_MS / 60_000).toFixed(0)}phút · eod-sync ${EOD_SYNC_AT} ICT${EOD_SYNC_DISABLED ? " (TẮT)" : ""} · intl-sync ${INTL_SYNC_AT} ICT${INTL_SYNC_DISABLED ? " (TẮT)" : ""} · reprobe ${REPROBE_AT} ICT${REPROBE_DISABLED ? " (TẮT)" : ""} · settle ${SETTLE_AT} ICT${SETTLE_DISABLED ? " (TẮT)" : ""} · ml-train ${ML_TRAIN_AT} ICT${ML_TRAIN_DISABLED ? " (TẮT)" : ""} · agent-cycle ${
      AGENT_CYCLE_MINUTES > 0 ? `${AGENT_CYCLE_MINUTES.toFixed(0)}phút` : "TẮT"
    }`
  );
  // P0-5 (phiên #57): hydrate state từ DB TRƯỚC khi chạy boot-sync — restart
  // không quên "hôm nay đã sync EOD" (nghiệm thu: kill engine → restart →
  // KHÔNG refetch EOD đã xong hôm đó) và không quên backoff intl.
  void hydrateEngineState().then(() => {
    // Chạy ngay một vòng lúc khởi động để client có dữ liệu sớm — boot
    // top-up EOD chỉ khi hôm nay CHƯA sync xong (state từ DB); môi trường
    // mới (chưa có state) vẫn tự đổ dữ liệu thật sớm như cũ.
    if (stats.lastEodSyncDate !== ictNow().date) {
      void syncEodAndBroadcast();
    } else {
      log("boot", "EOD hôm nay đã sync (state P0-5 từ DB) — bỏ refetch lúc boot");
    }
    // B12 — quốc tế: chạy luôn lúc boot nếu hôm nay đến lịch (Yahoo 429 tạm
    // thời thì bỏ qua im lặng — job 06:15 ICT ngày mai tự phục hồi)
    if (intlSyncDue()) void syncIntlAndBroadcast();
  });
  enqueueTick();
  void ingestNewsAndBroadcast();
  setInterval(enqueueTick, TICK_MS);
  setInterval(ingestNewsAndBroadcast, NEWS_MS);
  // Try/catch quanh cả khối due-check: một due-check hỏng (bug cấu hình,
  // null schedule…) không được phép giết event loop của cả engine — bug #42
  // đã làm engine chết lặng ~2h vì TypeError không được bắt trong callback này.
  setInterval(() => {
    try {
      if (eodSyncDue()) void syncEodAndBroadcast();
      if (intlSyncDue()) void syncIntlAndBroadcast();
      if (reprobeDue()) void reprobeAndBroadcast();
      // A1/A4 (#79) — lịch settle 16:15 ICT hằng ngày + retrain CN 04:00 ICT
      // (due-check mới nhất trong try/catch chung — lỗi 1 lịch không giết cả khối)
      if (settleDue()) void settleAndBroadcast();
      if (mlTrainDue()) void mlTrainAndBroadcast();
    } catch (err) {
      log("sched", `LỖI scheduler 60s: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, 60_000);
  if (AGENT_CYCLE_MINUTES > 0) {
    setInterval(runAgentCycleAndBroadcast, AGENT_CYCLE_MINUTES * 60_000);
  }
});

process.on("SIGINT", () => {
  log("boot", "tắt market-engine…");
  io.close();
  http.close();
  process.exit(0);
});
