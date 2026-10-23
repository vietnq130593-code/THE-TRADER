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
 *      - ML_SWEEP_AT (mặc định "SUN:04:15" Chủ nhật 04:15 ICT hằng tuần —
 *        C1 #99 · ML_AUTOML_BLUEPRINT §4.6, SAU A4 retrain 04:00): POST
 *        /api/ml/sweep {"force": false} — đợt sweep AutoML L1 deterministic
 *        16 ứng viên + cổng 4 điều kiện; route tự skip khi windowHash không
 *        đổi; kill-switch AppSetting "ml-sweep".enabled (§1.6) kiểm qua GET
 *        ?configOnly=1 TRƯỚC khi bắn POST; broadcast WS "ml-sweep"; env
 *        ML_SWEEP_DISABLED=1 tắt như A4.
 *      - AGENT_CYCLE_MINUTES (0=off): chu kỳ phân tích đa agent tự động —
 *        MẶC ĐỊNH HẬU PHƯƠNG từ K2 #86: chỉ hiệu lực khi AppSetting "k-run"
 *        CHƯA TỪNG được tạo; key tồn tại (kể cả enabled=false) → AppSetting
 *        thắng tuyệt đối (due-check k2 bên dưới quản, env interval nhường quyền).
 *      - k3TaskDueCheck (tick 60s — K3 #94, AUTONOMY_BLUEPRINT §6.3): đôn đốc
 *        NHIỆM VỤ ĐỊNH KỲ của agents — GET /api/agents/tasks/due lấy tối đa 10
 *        nhiệm vụ due (schedule≠null && !paused && nextDueAt≤now); agent đang
 *        RUNNING → PATCH deferMinutes:5 (hoãn, không chồng run); agent rảnh →
 *        POST /api/agents/[agentId]/run {taskId} (route tự cập nhật AgentTask:
 *        runCount/nextDueAt/failStreak/kill-switch 5 lỗi tự paused). Engine chỉ
 *        đôn đốc — KHÔNG tự viết kết quả; fail-soft tuyệt đối.
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

// F-861-01 (Fixbug #86 Vòng 1 — P1) [verify 04:44]: bun --hot re-evaluate module này mỗi lần
// edit file → scheduler ĐĂNG KÝ TRÙNG (đo thật 2026-10-11T04:29:56Z: 3 lần boot
// trong 1 giây → news bắn ×3 cùng lúc, hydrate state ×3). globalThis sống qua
// reload nên flag dưới phát hiện re-evaluation — cảnh báo ỒNG để operator restart
// (kill + double-fork). AUDIT 137 D7: từ nay scheduler cũ TỰ ĐƯỢC DỌN qua guard
// __traderEngineTimers bên dưới (clearInterval trước khi đăng ký bộ mới) — cảnh
// báo console giữ nguyên để operator vẫn biết module vừa re-evaluate.
//
// FIXBUG #143 (18-10, đo thật + tái hiện sandbox 5 lần): bun --hot CÓ BUG CHẾT
// NGƯỜI với scheduler — khi 1 lần edit file đi qua trạng thái GÃY SYNTAX giữa
// chừng (lưu dở, re-evaluate fail parse → Bun giữ module cũ chạy), lần edit HOÀN
// CHỈNH sau đó re-evaluate module MỚI nhưng Bun GIẾT TOÀN BỘ timer của process:
//   • timer incarnation mới đăng ký cấp module: KHÔNG BAO GIỜ fire
//   • timer incarnation cũ chưa kịp clear: cũng chết
//   • timer đăng ký từ IO callback (request handler): cũng chết
//   • IO (HTTP/socket.io) vẫn chạy → /health vẫn trả lời, WS vẫn connected
// → engine ZOMBIE 8,5h (ticks=0, k2Checks=0, 3 chu kỳ agent lỡ, tick giá đứng
//   im) mà mọi chỉ báo ngoài vẫn XANH. Đo trên engine thật 18-10 09:29-09:32
//   (8 re-evaluate + 2 syntax error trong PM2 log) + tái hiện sạch trong sandbox.
// NGĂN CHẶN GỐC: dev script BỎ --hot (bun thường — PM2 autorestart lo crash,
// PM2 --watch restart sạch mỗi lần edit file). Guard D7 + cảnh báo RELOAD dưới
// giữ lại làm phòng hoả nếu ai re-enable --hot.
const gEngine = globalThis as { __traderEngineEvalAt?: number };
if (gEngine.__traderEngineEvalAt) {
  console.error(
    `[${new Date().toISOString()}] [RELOAD] engine module vừa bị re-evaluate (bun --hot sau edit lúc ${new Date(gEngine.__traderEngineEvalAt).toISOString()}) — CÁC SCHEDULER CŨ VẪN CHẠY, scheduler mới ĐĂNG KÌ TRÙNG. RESTART engine ngay (kill PID + double-fork) để tránh lịch chồng!`
  );
}
gEngine.__traderEngineEvalAt = Date.now();

// AUDIT 137 D7 — bun --hot reload đăng ký scheduler TRÙNG: guard global +
// dọn interval cũ trước khi đăng ký mới (trước đây chỉ console.error nhắc
// operator restart tay — đo thật worklog #86: 3 lần re-evaluate trong 1 giây
// → news bắn ×3, tick ×3, hydrate ×3). Mọi setInterval mới bên dưới push
// handle vào mảng global này; module re-evaluate sẽ clearInterval hết scheduler
// cũ ngay tại đây trước khi đăng ký bộ mới. Socket/io KHÔNG đụng (socket cũ tự
// disconnect theo process — không đổi logic io theo phạm vi audit).
const g = globalThis as { __traderEngineTimers?: NodeJS.Timeout[] };
for (const t of g.__traderEngineTimers ?? []) clearInterval(t);
// Alias non-optional (cùng tham chiếu mảng global) — các push bên dưới không
// phải đánh dấu optional mỗi lần; gán lại global để lần re-evaluate sau dọn.
const engineTimers: NodeJS.Timeout[] = (g.__traderEngineTimers = []);

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
/** C1 (#99 — ML_AUTOML_BLUEPRINT §4.6/F3) — lịch sweep AutoML L1 hằng tuần
 *  "SUN:04:15" ICT (SAU A4 retrain 04:00 — sweep dựa vào serving-swap guard
 *  sống nên phải chạy sau; A4 <5 phút nên guard !mlTrainInFlight đủ thứ tự). */
const ML_SWEEP_AT = process.env.ML_SWEEP_AT ?? "SUN:04:15";
const ML_SWEEP_DISABLED = process.env.ML_SWEEP_DISABLED === "1";
/** W3 (#164 · review #162) — auto-retrain THEO PSI (vá "PSI chỉ cảnh báo,
 *  model đóng băng vô thời hạn nếu không ai bấm train tay"): nhịp due-check
 *  (mặc định 15 phút), chỉ trong khung T2–T6 từ 17:00 ICT (sau mọi job EOD
 *  chiều: settle 16:15 · k1 16:30 · council 16:45 — tránh tranh lock; gate
 *  EOD hôm đó ĐÃ sync vì PSI chỉ đổi khi có bar mới; Chủ nhật nhường cho A4
 *  04:00 + sweep 04:15). Route /api/ml/psi-retrain TỰ đo PSI + 5 guard
 *  (kill-switch AppSetting ml-psi-retrain · cooldown 24h · ngưỡng 0,25 ·
 *  windowHash · mutex train dùng chung) — engine chỉ đôn đốc, KHÔNG quyết định. */
const ML_PSI_RETRAIN_DISABLED = process.env.ML_PSI_RETRAIN_DISABLED === "1";
const ML_PSI_RETRAIN_AT = process.env.ML_PSI_RETRAIN_AT ?? "17:00";
const ML_PSI_RETRAIN_CHECK_MINUTES = (() => {
  const raw = Number(process.env.ML_PSI_RETRAIN_CHECK_MINUTES ?? 15);
  return Number.isFinite(raw) && raw >= 5 ? raw : 15;
})();
/** K1 (#87 — AUTONOMY_BLUEPRINT v1.1 §5.4): giờ ICT kết toán sandbox hằng ngày
 *  (16:30 — SAU settle bandit 16:15 đúng 15 phút để không tranh lock DB; job
 *  4-việc: kênh-2 reward → CashSnapshot → telemetry → audit tổng kết). */
const K1_EQUITY_AT = process.env.K1_EQUITY_AT ?? "16:30";
const K1_EQUITY_DISABLED = process.env.K1_EQUITY_DISABLED === "1";
/** #106/#107 — COUNCIL_STEWARDSHIP_BLUEPRINT v2.0: 1 job Hội đồng còn lại
 *  (2 job E-ALLOC đã tháo #107 — thí nghiệm phân bổ = vẽ rắn thêm chân):
 *  16:45 đánh giá sổ quyết định D-LEDGER (sau k1 16:30 — tránh tranh lock;
 *  t2–t6, gate eodSync hôm đó; định giá phi-VN quy VND theo #107 E-EXEC). */
const COUNCIL_EVAL_AT = process.env.COUNCIL_EVAL_AT ?? "16:45";
const COUNCIL_EVAL_DISABLED = process.env.COUNCIL_EVAL_DISABLED === "1";
// F-02A (#129 — AI_ENGINEER_REVIEW_BRAIN §3 F-02): trích xuất chuỗi vĩ mô VN
//  từ tin RSS 06:35 ICT hằng ngày (SAU intl-sync 06:15, TRƯỚC mở cửa VN 09:00
//  — Pha A LLM có trích dẫn; cooldown 60s + audit MACRO_INGESTED ở route).
const MACRO_VN_AT = process.env.MACRO_VN_AT ?? "06:35";
const MACRO_VN_DISABLED = process.env.MACRO_VN_DISABLED === "1";
// F-03a (#129): snapshot dòng khối ngoại 16:05 ICT hằng ngày (SAU eod-sync
//  15:45 — Quote đã neo close thật → ForeignFlow upsert khớp Bar cùng ngày;
//  Pha B adapter live chờ egress, hiện mô phỏng deterministic persist sẵn có).
const FLOW_SYNC_AT = process.env.FLOW_SYNC_AT ?? "16:05";
const FLOW_SYNC_DISABLED = process.env.FLOW_SYNC_DISABLED === "1";
/** Task 176 (STATE_SPACE_BLUEPRINT Phase 1 — v1.1 pass review Task 172):
 *  POST /api/ml/ss-daily T2–T6 16:50 ICT hằng ngày (SAU settle 16:15 · k1
 *  16:30 · council-eval 16:45 — EOD hôm nay ĐÃ sync; 1 lần/ngày theo settle
 *  tránh multiplicity — F6-v1.1) làm 2 việc: (a) A/B BÓNG driver mới
 *  ml-forecast.holt-ss (A15b — MLE local linear trend + predictive variance)
 *  vs driver cũ holt heuristic, chấm log-score SS-11 trên holdout PIT, ghi
 *  audit SS_AB_LOG, KHÔNG đốt vào Bayes (F5: shadow, không dual-live);
 *  (b) guard ngạc nhiên SS-7 CUSUM e²−1 trên log-giá 10 mã rổ (audit
 *  SS_SURPRISE read-only Phase 1). Kill-switch từng tầng: AppSetting
 *  ml-ss-shadow / ml-ss-surprise (route tự đọc — engine chỉ đôn đốc).
 *  Guard ngày chỉ trong bộ nhớ (pattern psiRetrain — app engine-state chưa
 *  whitelist; restart sau 16:50 chạy bù 1 lần → thêm 1 dòng audit cùng ngày
 *  ICT, metric days (distinct-date) không đổi — vô hại, ghi rõ trung thực). */
const ML_SS_DAILY_DISABLED = process.env.ML_SS_DAILY_DISABLED === "1";
const ML_SS_DAILY_AT = process.env.ML_SS_DAILY_AT ?? "16:50";

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
const K1_EQUITY_MINUTES = parseHhMm(K1_EQUITY_AT) ?? parseHhMm("16:30")!;
// #106/#107 — job hằng ngày của Hội đồng (fail-safe parseHhMm như K1)
const COUNCIL_EVAL_MINUTES = parseHhMm(COUNCIL_EVAL_AT) ?? parseHhMm("16:45")!;
// #129 (F-02A + F-03a) — fail-safe parseHhMm như các slot hằng ngày khác
const MACRO_VN_MINUTES = parseHhMm(MACRO_VN_AT) ?? parseHhMm("06:35")!;
const FLOW_SYNC_MINUTES = parseHhMm(FLOW_SYNC_AT) ?? parseHhMm("16:05")!;
// Task 176 — fail-safe parseHhMm như các slot hằng ngày khác
const ML_SS_DAILY_MINUTES = parseHhMm(ML_SS_DAILY_AT) ?? parseHhMm("16:50")!;

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
// C1 (#99 — F3) — cùng fail-safe 3 lớp cho lịch sweep (không bao giờ null —
// bài học #42: schedule null → TypeError mỗi phút giết event loop engine).
const ML_SWEEP_SCHEDULE: { dow: number; minutes: number } =
  parseWeekly(ML_SWEEP_AT) ?? parseWeekly("SUN:04:15") ?? { dow: 0, minutes: 4 * 60 + 15 };
// W3 (#164) — fail-safe parseHhMm như các slot hằng ngày khác (17:00 ICT).
const ML_PSI_RETRAIN_MINUTES = parseHhMm(ML_PSI_RETRAIN_AT) ?? parseHhMm("17:00")!;
// #107 — job hội nghị phân bổ CN 05:50 đã THÁO cùng E-ALLOC (vẽ rắn thêm chân).

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
  // C1 (#99 — ML_AUTOML_BLUEPRINT §4.6/F3): lịch sweep AutoML L1 CN 04:15 ICT
  // (P0-5: Chủ nhật đã sweep sống sót restart — không chạy lại sau restart cùng ngày)
  lastMlSweepAt: null as string | null,
  lastMlSweepSunday: null as string | null,
  lastMlSweepError: null as string | null,
  sweepRuns: 0,
  // W3 (#164) — auto-retrain theo PSI: nhịp check 15' (throttle nội bộ —
  // KHÔNG cần persist engine-state: route tự guard bằng AuditLog cooldown
  // 24h + AppSetting kill-switch; mất khi restart chỉ khiến 1 lần check sớm)
  lastPsiRetrainCheckAt: null as string | null,
  lastPsiRetrainAt: null as string | null,
  lastPsiRetrainOutcome: null as string | null,
  lastPsiRetrainError: null as string | null,
  psiRetrainRuns: 0,
  // Task 176 — tầng State Space: A/B bóng holt-ss + guard ngạc nhiên CUSUM
  // (guard ngày trong bộ nhớ như psiRetrain — xem comment ML_SS_DAILY_AT)
  lastSsDailyAt: null as string | null,
  lastSsDailyDate: null as string | null,
  lastSsDailyOutcome: null as string | null,
  lastSsDailyError: null as string | null,
  ssDailyRuns: 0,
  // K1 (#87 — §5.4): lịch settle-equity sandbox 16:30 ICT (P0-5 sống sót restart)
  lastK1EquityAt: null as string | null,
  lastK1EquityDate: null as string | null,
  lastK1EquityError: null as string | null,
  k1EquityRuns: 0,
  // #106/#107 — COUNCIL: đánh giá quyết định D-LEDGER 16:45 (P0-5 sống sót
  // restart; 2 job E-ALLOC mark/session đã tháo #107)
  lastCouncilEvalAt: null as string | null,
  lastCouncilEvalDate: null as string | null,
  lastCouncilEvalError: null as string | null,
  councilEvalRuns: 0,
  // #129 (F-02A) — trích xuất vĩ mô VN 06:35 ICT (P0-5 sống sót restart)
  lastMacroVnAt: null as string | null,
  lastMacroVnDate: null as string | null,
  lastMacroVnError: null as string | null,
  macroVnRuns: 0,
  // #129 (F-03a) — snapshot dòng khối ngoại 16:05 ICT (P0-5)
  lastFlowSyncAt: null as string | null,
  lastFlowSyncDate: null as string | null,
  lastFlowSyncError: null as string | null,
  flowSyncRuns: 0,
  lastCycleAt: null as string | null,
  cycles: 0,
  // K2 (#86 — AUTONOMY_BLUEPRINT v1.1 §4.3): due-check chế độ chạy liên tục
  lastK2CheckAt: null as string | null,
  lastK2CycleAt: null as string | null,
  lastK2Error: null as string | null,
  k2Cycles: 0,
  k2KeyExists: false,
  k2Enabled: false,
  k2IntervalMinutes: 0,
  // K3 (#94 — AUTONOMY_BLUEPRINT v1.1 §6.3): due-check nhiệm vụ định kỳ
  lastK3CheckAt: null as string | null,
  lastK3DispatchAt: null as string | null,
  lastK3DeferAt: null as string | null,
  lastK3Error: null as string | null,
  k3Checks: 0,
  k3Dispatched: 0,
  k3Defers: 0,
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
        mlSweepAt: ML_SWEEP_AT,
        mlPsiRetrainAt: ML_PSI_RETRAIN_DISABLED
          ? `${ML_PSI_RETRAIN_AT} ICT (TẮT)`
          : `${ML_PSI_RETRAIN_AT} ICT t2–t6 · check ${ML_PSI_RETRAIN_CHECK_MINUTES}phút`,
        k1EquityAt: K1_EQUITY_AT,
        councilEvalAt: COUNCIL_EVAL_AT,
        macroVnAt: MACRO_VN_AT,
        flowSyncAt: FLOW_SYNC_AT,
        ...stats,
      })
    );
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

const io = new Server(http, {
  // D6 (Task 144 · P3): CORS cấu hình hoá qua ENGINE_CORS_ORIGIN.
  // Mặc định "*" vì trong sandbox client chỉ tới engine qua gateway Caddy
  // (cùng origin) hoặc nội bộ — không expose trực tiếp. TRƯỚC KHI mở public:
  // đặt ENGINE_CORS_ORIGIN=https://<domain-thật> (xem docs/SECURITY.md §6).
  cors: {
    origin: process.env.ENGINE_CORS_ORIGIN ?? "*",
    methods: ["GET", "POST"],
  },
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
  // C1 (#99 — ML_AUTOML_BLUEPRINT §4.6/F3): Chủ nhật đã sweep + mốc gần nhất
  // (P0-5 — restart giữa chừng không chạy lại sweep cùng Chủ nhật)
  lastMlSweepSunday?: string | null;
  lastMlSweepAt?: string | null;
  // K1 (#87) — ngày đã settle-equity sandbox + mốc gần nhất (P0-5)
  lastK1EquityDate?: string | null;
  lastK1EquityAt?: string | null;
  // #106/#107 — COUNCIL: ngày đã đánh giá quyết định (P0-5; 2 job E-ALLOC tháo #107)
  lastCouncilEvalDate?: string | null;
  lastCouncilEvalAt?: string | null;
  // #129 (F-02A + F-03a) — P0-5 sống sót restart
  lastMacroVnDate?: string | null;
  lastMacroVnAt?: string | null;
  lastFlowSyncDate?: string | null;
  lastFlowSyncAt?: string | null;
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
    // C1 (#99 — F3) — phục hồi lịch sweep (restart giữa chừng không double-sweep:
    // route có mutex 429 nhưng tránh cả lần gọi thừa; skip-guard windowHash
    // ở route cũng chặn thêm — 2 lớp như A4).
    if (typeof s.lastMlSweepSunday === "string") stats.lastMlSweepSunday = s.lastMlSweepSunday;
    if (typeof s.lastMlSweepAt === "string") stats.lastMlSweepAt = s.lastMlSweepAt;
    // K1 (#87) — phục hồi lịch settle sandbox (restart giữa chừng không double:
    // route idempotent qua CashSnapshot 1-dòng/ngày + dedupe reward per position,
    // nhưng tránh cả lần gọi thừa)
    if (typeof s.lastK1EquityDate === "string") stats.lastK1EquityDate = s.lastK1EquityDate;
    if (typeof s.lastK1EquityAt === "string") stats.lastK1EquityAt = s.lastK1EquityAt;
    // #106/#107 — COUNCIL: phục hồi lịch đánh giá quyết định (restart giữa chừng
    // route mark/evaluate idempotent nhưng tránh cả lần gọi thừa)
    if (typeof s.lastCouncilEvalDate === "string") stats.lastCouncilEvalDate = s.lastCouncilEvalDate;
    if (typeof s.lastCouncilEvalAt === "string") stats.lastCouncilEvalAt = s.lastCouncilEvalAt;
    // #129 (F-02A + F-03a) — phục hồi lịch vĩ mô/flow (P0-5)
    if (typeof s.lastMacroVnDate === "string") stats.lastMacroVnDate = s.lastMacroVnDate;
    if (typeof s.lastMacroVnAt === "string") stats.lastMacroVnAt = s.lastMacroVnAt;
    if (typeof s.lastFlowSyncDate === "string") stats.lastFlowSyncDate = s.lastFlowSyncDate;
    if (typeof s.lastFlowSyncAt === "string") stats.lastFlowSyncAt = s.lastFlowSyncAt;
    if (typeof s.intlFailStreak === "number") intlFailStreak = s.intlFailStreak;
    if (typeof s.lastIntlFailAt === "number") lastIntlFailAt = s.lastIntlFailAt;
    log(
      "state",
      `phục hồi state từ DB (P0-5): eod=${stats.lastEodSyncDate ?? "—"} · intl=${stats.lastIntlSyncDate ?? "—"} · reprobe=${stats.lastReprobeSunday ?? "—"} · settle=${stats.lastSettleDate ?? "—"} · ml-train=${stats.lastMlTrainSunday ?? "—"} · ml-sweep=${stats.lastMlSweepSunday ?? "—"} · intlFailStreak=${intlFailStreak}`
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
        // C1 (#99 — F3) — Chủ nhật đã sweep sống sót restart (P0-5)
        lastMlSweepSunday: stats.lastMlSweepSunday,
        lastMlSweepAt: stats.lastMlSweepAt,
        lastK1EquityDate: stats.lastK1EquityDate,
        lastK1EquityAt: stats.lastK1EquityAt,
        // #106/#107 — COUNCIL: lịch đánh giá quyết định sống sót restart (P0-5)
        lastCouncilEvalDate: stats.lastCouncilEvalDate,
        lastCouncilEvalAt: stats.lastCouncilEvalAt,
        // #129 (F-02A + F-03a) — P0-5
        lastMacroVnDate: stats.lastMacroVnDate,
        lastMacroVnAt: stats.lastMacroVnAt,
        lastFlowSyncDate: stats.lastFlowSyncDate,
        lastFlowSyncAt: stats.lastFlowSyncAt,
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
  // K2 (#86 — AUTONOMY_BLUEPRINT v1.1 §4.3): AppSetting "k-run" tồn tại →
  // AppSetting thắng TUYỆT ĐỐI — env interval nhường quyền cho due-check k2
  // (kể cả enabled=false: "tắt" nghĩa là dừng hẳn, không phải rơi về nhịp env).
  // Flag do k2CheckAndRun() cập nhật mỗi tick 60s — race ≤ 60s giữa lúc tạo
  // key và lần check kế bị cooldown 60s + guard 409 của route chặn thực tế.
  if (kRunKeyExists) {
    log("cycle", "env interval nhường quyền cho k-run (AppSetting thắng tuyệt đối) — bỏ qua");
    return;
  }
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

/** K2 (#86 — AUTONOMY_BLUEPRINT v1.1 §4.3): due-check chế độ chạy liên tục.
 *
 * Mỗi tick 60s: GET /api/k/run (timeout 10s — 1 request/phút, nhẹ hơn tick giá
 * 10s/lần) → cập nhật flag kRunKeyExists (env interval đọc flag này để nhường
 * quyền) → nếu enabled và đã qua nextCycleAt → POST /api/agents/run (timeout
 * 280s < maxDuration route 300s). Route TỰ cập nhật k-run.lastCycleAt+
 * cyclesRun sau MỖI chu kỳ (kể cả tay) → nextCycleAt tự dịch chuyển.
 *
 * Guard in-flight (pattern F-481-01): chu kỳ k2 đang chạy → tick 60s không
 * bắn thêm. Thất bại POST (429 cooldown / 409 single-run / app chậm) → KHÔNG
 * dịch nextCycleAt (route chỉ ghi mốc khi chu kỳ thật sự bắt đầu) → tick sau
 * tự thử lại — fail-soft, không dồn cục. */
let kRunKeyExists = false;
let k2CycleInFlight = false;
const K2_CYCLE_POST_TIMEOUT_MS = 280_000;
const K2_GET_TIMEOUT_MS = 10_000;
async function k2CheckAndRun(): Promise<void> {
  // 1) Đọc state k-run (GET — route fail-soft trả mặc định exists:false)
  interface K2State {
    exists: boolean;
    enabled: boolean;
    intervalMinutes: number;
    nextCycleAt: string | null;
  }
  let state: K2State | null = null;
  try {
    const res = await fetch(`${APP_URL}/api/k/run`, {
      signal: AbortSignal.timeout(K2_GET_TIMEOUT_MS),
    });
    if (res.ok) {
      state = (await res.json()) as K2State;
    } else {
      log("k2", `đọc /api/k/run HTTP ${res.status} — giữ state tick trước`);
    }
  } catch (err) {
    log("k2", `đọc /api/k/run lỗi (${err instanceof Error ? err.message : String(err)}) — giữ state tick trước`);
  }
  stats.lastK2CheckAt = new Date().toISOString();
  if (!state || typeof state.exists !== "boolean") return;

  // 2) Flag nhường quyền env — cập nhật MỖI tick (kể cả disabled)
  kRunKeyExists = state.exists;
  stats.k2KeyExists = state.exists;
  stats.k2Enabled = state.enabled;
  stats.k2IntervalMinutes = state.intervalMinutes ?? 0;

  if (!state.exists || !state.enabled) return;
  if (k2CycleInFlight) return;

  // 3) Due-check theo nextCycleAt server tính (max(lastCycleAt, startedAt)+nhịp)
  const dueMs = state.nextCycleAt ? Date.parse(state.nextCycleAt) : NaN;
  if (!Number.isFinite(dueMs)) return; // route gặp sự cố format — bỏ qua an toàn
  if (Date.now() < dueMs) return;

  // 4) Chạy chu kỳ — route tự ghi lastCycleAt (mọi đường: tay/k2)
  k2CycleInFlight = true;
  try {
    const data = await postJson("/api/agents/run", undefined, {
      timeoutMs: K2_CYCLE_POST_TIMEOUT_MS,
    });
    stats.lastK2CycleAt = new Date().toISOString();
    stats.k2Cycles++;
    stats.lastK2Error = null;
    io.emit("cycle", data);
    log("k2", `chu kỳ k2 hoàn tất (${data.durationMs ?? "?"}ms) — nextCycleAt dịch theo lastCycleAt mới`);
  } catch (err) {
    stats.lastK2Error = err instanceof Error ? err.message : String(err);
    log("k2", `bỏ qua (thử lại tick 60s sau): ${stats.lastK2Error}`);
  } finally {
    k2CycleInFlight = false;
  }
}

/** K3 (#94 — AUTONOMY_BLUEPRINT v1.1 §6.3): due-check NHIỆM VỤ ĐỊNH KỲ.
 *
 * Mỗi tick 60s (pattern k2CheckAndRun): GET /api/agents/tasks/due (timeout
 * 10s — tối đa 10 nhiệm vụ: schedule≠null && !paused && nextDueAt ≤ now).
 * Với mỗi nhiệm vụ due:
 *   - agent đang RUNNING (hoặc đang trong chu kỳ 23 — chu kỳ đánh dấu toàn
 *     bộ agents RUNNING) → PATCH deferMinutes:5 (nextDueAt += 5 phút kể từ
 *     mốc lớn hơn) — KHÔNG chồng run (§6.3);
 *   - agent rảnh → POST /api/agents/[agentId]/run {taskId} (timeout 110s <
 *     maxDuration route 120s). Route TỰ cập nhật AgentTask khi run kết thúc
 *     (runCount++, nextDueAt dịch theo lịch, failStreak, kill-switch 5 lỗi
 *     tự paused) — engine chỉ đôn đốc, KHÔNG tự viết kết quả.
 *
 * Guard in-flight THEO NHIỆM VỤ (F-481-01 pattern): run LLM 10-60s trong
 * khi nextDueAt chỉ dịch lúc run KẾT THÚC → tick 60s kế không bắn POST kép
 * cho cùng nhiệm vụ; các nhiệm vụ due khác vẫn chạy song song (mỗi agent có
 * claim riêng + rate-limit 60s ở route). Lỗi POST (429 cooldown / 400 agent
 * bận / 502 LLM) → KHÔNG dịch nextDueAt → tick sau tự thử lại (fail-soft,
 * không dồn cục; failStreak do route đếm trên AgentRun thật). */
interface K3DueTask {
  taskId: string;
  agentId: string;
  agentCode: string;
  agentName: string;
  agentStatus: string;
  title: string;
  schedule: string;
  nextDueAt: string | null;
}
const k3InFlight = new Set<string>();
const K3_GET_TIMEOUT_MS = 10_000;
// F-K3-07 (FB-4A): mặc định 130s > maxDuration 120s của route run — engine
// không tự cắt sớm request còn đang chạy hợp lệ (env override vẫn tôn trọng).
const K3_RUN_POST_TIMEOUT_MS =
  Number(process.env.K3_RUN_POST_TIMEOUT_MS) > 0
    ? Number(process.env.K3_RUN_POST_TIMEOUT_MS)
    : 130_000;
const K3_DEFER_PATCH_TIMEOUT_MS = 15_000;
const K3_DEFER_MINUTES = 5;
async function k3DeferBusyTask(t: K3DueTask): Promise<void> {
  try {
    const res = await fetch(
      `${APP_URL}/api/agents/${t.agentId}/tasks/${t.taskId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deferMinutes: K3_DEFER_MINUTES }),
        signal: AbortSignal.timeout(K3_DEFER_PATCH_TIMEOUT_MS),
      }
    );
    if (res.ok) {
      stats.k3Defers++;
      stats.lastK3DeferAt = new Date().toISOString();
      log(
        "k3",
        `hoãn "${t.title}" (${t.agentCode}) +${K3_DEFER_MINUTES} phút — agent đang bận (${t.agentStatus})`
      );
    } else {
      log("k3", `hoãn "${t.title}" (${t.agentCode}) HTTP ${res.status} — tick sau thử lại`);
    }
  } catch (err) {
    log("k3", `hoãn "${t.title}" (${t.agentCode}) lỗi: ${err instanceof Error ? err.message : String(err)}`);
  }
}
async function k3DispatchTask(t: K3DueTask): Promise<void> {
  k3InFlight.add(t.taskId);
  try {
    const data = await postJson(`/api/agents/${t.agentId}/run`, { taskId: t.taskId }, {
      timeoutMs: K3_RUN_POST_TIMEOUT_MS,
    });
    stats.k3Dispatched++;
    stats.lastK3DispatchAt = new Date().toISOString();
    const durationMs = (data as { run?: { durationMs?: number } }).run?.durationMs;
    log(
      "k3",
      `nhiệm vụ "${t.title}" (${t.agentCode}) hoàn tất${durationMs != null ? ` — ${durationMs}ms` : ""}`
    );
  } catch (err) {
    // 429 cooldown / 400 agent bận / 502 LLM — route sẽ đếm failStreak trên
    // AgentRun THẬT; lỗi bắn-đi không dịch nextDueAt → tick sau thử lại.
    log("k3", `nhiệm vụ "${t.title}" (${t.agentCode}) bỏ qua (thử lại tick sau): ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    k3InFlight.delete(t.taskId);
  }
}
async function k3TaskDueCheck(): Promise<void> {
  stats.k3Checks++;
  stats.lastK3CheckAt = new Date().toISOString();
  let tasks: K3DueTask[] = [];
  try {
    const res = await fetch(`${APP_URL}/api/agents/tasks/due?take=10`, {
      signal: AbortSignal.timeout(K3_GET_TIMEOUT_MS),
    });
    if (res.ok) {
      const data = (await res.json()) as { tasks?: K3DueTask[] };
      if (Array.isArray(data.tasks)) tasks = data.tasks;
    } else {
      stats.lastK3Error = `HTTP ${res.status} từ /api/agents/tasks/due`;
      log("k3", `đọc nhiệm vụ due: ${stats.lastK3Error} — giữ nguyên tick trước`);
      return;
    }
  } catch (err) {
    stats.lastK3Error = err instanceof Error ? err.message : String(err);
    log("k3", `đọc nhiệm vụ due lỗi (${stats.lastK3Error}) — tick sau thử lại`);
    return;
  }
  if (tasks.length === 0) return;
  for (const t of tasks) {
    if (typeof t.taskId !== "string" || typeof t.agentId !== "string") continue;
    // F-K3-03 (FB-4A): in-flight TRƯỚC defer — run do CHÍNH engine vừa bắn
    // đang chạy thì KHÔNG hoãn (trước đây defer-check đứng trước khiến engine
    // tự hoãn task nó đang chạy: agent được trả RUNNING sau khi POST bắt đầu).
    if (k3InFlight.has(t.taskId)) continue; // run chưa xong — không bắn kép
    if (t.agentStatus === "RUNNING") {
      void k3DeferBusyTask(t);
      continue;
    }
    void k3DispatchTask(t);
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

/** C1 (#99 — ML_AUTOML_BLUEPRINT §4.6/F3) — sweep AutoML L1 Chủ nhật 04:15
 *  ICT (SAU A4 04:00): POST /api/ml/sweep {"force": false} — route tự skip
 *  khi windowHash không đổi (skip-guard như A4, điều kiện 4 cổng §4.4) nên
 *  tuần không dữ liệu là $0. Timeout 20 phút (đúng trần budget 19 phút của
 *  runner + biên — sweep 16 ứng viên ~4 phút nhưng từng ứng viên có thể
 *  chậm tới 60s+). F-481-01 pattern: guard in-flight sweep + !mlTrainInFlight
 *  (due-check) — due-check 60s không bắn POST chồng khi đợt đang chạy; route
 *  có thêm mutex 429 dùng chung với train (F2) làm lớp 2.
 *  Kill-switch §1.6 (F3): TRƯỚC khi bắn POST, GET ?configOnly=1 đọc
 *  AppSetting ml-sweep.enabled — TẮT → đánh dấu Chủ nhật (im hẳn, không
 *  hỏi lại mỗi phút; nút "Chạy đợt ngay" trên UI vẫn chạy được — POST route
 *  không kiểm enabled). GET lỗi → KHÔNG đánh dấu (thử lại phút sau).
 *  Thất bại POST → KHÔNG đánh dấu Chủ nhật — phút sau thử lại. Broadcast
 *  WS "ml-sweep" sau khi xong (FE invalidate ["ml-sweep"] + ["ml-status"]). */
let sweepInFlight = false;
const ML_SWEEP_POST_TIMEOUT_MS = 20 * 60_000;
const ML_SWEEP_CONFIG_GET_TIMEOUT_MS = 10_000;
async function mlSweepAndBroadcast(): Promise<void> {
  sweepInFlight = true;
  try {
    // Kill-switch §1.6 — đường ENGINE kiểm enabled (nút tay thì không).
    let enabled = true;
    try {
      const res = await fetch(`${APP_URL}/api/ml/sweep?configOnly=1`, {
        signal: AbortSignal.timeout(ML_SWEEP_CONFIG_GET_TIMEOUT_MS),
      });
      if (res.ok) {
        const data = (await res.json()) as { config?: { enabled?: unknown } };
        if (typeof data.config?.enabled === "boolean") enabled = data.config.enabled;
      }
    } catch (err) {
      // GET lỗi → cứ bắn POST (route tự fail-soft) — không tự ý tắt đợt.
      log("ml-sweep", `đọc kill-switch config lỗi (tiếp tục POST): ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!enabled) {
      const ict = ictNow();
      stats.lastMlSweepAt = new Date().toISOString();
      stats.lastMlSweepSunday = ict.date; // im hẳn tuần này (không hỏi lại mỗi phút)
      log("ml-sweep", "TẮT qua AppSetting ml-sweep.enabled (kill-switch §1.6) — bỏ qua tuần này (nút tay trên UI vẫn chạy được)");
      return;
    }
    const data = await postJson("/api/ml/sweep", { force: false }, {
      timeoutMs: ML_SWEEP_POST_TIMEOUT_MS,
    });
    stats.lastMlSweepAt = new Date().toISOString();
    stats.sweepRuns++;
    stats.lastMlSweepError = null;
    const ict = ictNow();
    stats.lastMlSweepSunday = ict.date;
    io.emit("ml-sweep", data);
    const champion = (data as { champion?: { tag?: string; arch?: string } }).champion;
    log(
      "ml-sweep",
      `sweep C1 xong (${data.skipped === true ? `skip — ${data.reason ?? "windowHash không đổi"}` : `${data.evaluated ?? "?"}/${data.candidates ?? "?"} ứng viên · champion ${champion?.tag ?? "—"} ${champion?.arch ?? ""}`}) · ${(data.durationMs ?? "?")}ms${data.swapped === true ? " · SWAP serving" : ""}`
    );
    // F-01 (#129): sweep THỨ HAI cho featureSet v3-macro (24 chiều — 8 chiều
    // vĩ mô) — sau đợt v2 xong hẳn (không chồng mutex route). Đấu fair cùng
    // cổng championGate + paired-bootstrap; skip-guard theo featureSet riêng.
    try {
      const v3 = await postJson("/api/ml/sweep", { force: false, featureSet: "v3-macro" }, {
        timeoutMs: ML_SWEEP_POST_TIMEOUT_MS,
      });
      log(
        "ml-sweep",
        `sweep v3-macro xong (${v3.skipped === true ? `skip — ${v3.reason ?? "windowHash không đổi"}` : `${v3.evaluated ?? "?"}/${v3.candidates ?? "?"} ứng viên · champion ${(v3 as { champion?: { tag?: string } }).champion?.tag ?? "—"}`}) · ${(v3.durationMs ?? "?")}ms${v3.swapped === true ? " · SWAP serving (v3!)" : ""}`
      );
    } catch (err) {
      log("ml-sweep", `sweep v3-macro bỏ qua (fail-soft): ${err instanceof Error ? err.message : String(err)}`);
    }
    // F-07 (#129): meta-learner trọng số ensemble — train sau sweep (đặc tả
    // "gắn vào job sweep Chủ nhật"); cold-start < 60 phiếu → giữ fixed 0,7/0,3.
    try {
      const learned = await postJson("/api/ml/ensemble-learn", undefined, {
        timeoutMs: 120_000,
      });
      log(
        "ml-learn",
        `ensemble-learn F-07: ${String(learned.outcome ?? "?")} — ${String(learned.note ?? "")}`
      );
    } catch (err) {
      log("ml-learn", `ensemble-learn bỏ qua (fail-soft): ${err instanceof Error ? err.message : String(err)}`);
    }
  } catch (err) {
    stats.lastMlSweepError = err instanceof Error ? err.message : String(err);
    log("ml-sweep", `LỖI (thử lại phút sau): ${stats.lastMlSweepError}`);
  } finally {
    sweepInFlight = false;
    // P0-5 — Chủ nhật đã sweep sống sót restart
    void persistEngineState();
  }
}

/** K1 (#87 — AUTONOMY_BLUEPRINT v1.1 §5.4/§5.5): kết toán sandbox 16:30 ICT.
 *  POST /api/k/sandbox/settle-equity → broadcast "k1-settle". Thuần thuật toán
 *  0 LLM: kênh-2 reward (posterior Beta BanditArm — Q2 trộn) + CashSnapshot
 *  + telemetry + audit. F-481-01 pattern: guard in-flight. Thất bại → KHÔNG
 *  đánh dấu ngày — phút sau thử lại (không dồn cục). Route tự idempotent nên
 *  chạy nhắc lại vô hại ($0). */
let k1EquityInFlight = false;
const K1_EQUITY_POST_TIMEOUT_MS = 60_000;
async function k1EquityAndBroadcast(): Promise<void> {
  k1EquityInFlight = true;
  try {
    const data = await postJson("/api/k/sandbox/settle-equity", undefined, {
      timeoutMs: K1_EQUITY_POST_TIMEOUT_MS,
    });
    stats.lastK1EquityAt = new Date().toISOString();
    stats.k1EquityRuns++;
    stats.lastK1EquityError = null;
    const ict = ictNow();
    stats.lastK1EquityDate = ict.date;
    io.emit("k1-settle", data);
    const rewards = Array.isArray((data as { rewards?: unknown[] }).rewards)
      ? (data as { rewards: unknown[] }).rewards.length
      : 0;
    log(
      "k1",
      `settle sandbox xong: ${data.skipped ?? ""} · reward ${rewards} position · equity ${(data as { equity?: number }).equity ?? "?"}`
    );
  } catch (err) {
    stats.lastK1EquityError = err instanceof Error ? err.message : String(err);
    log("k1", `LỖI (thử lại phút sau): ${stats.lastK1EquityError}`);
  } finally {
    k1EquityInFlight = false;
    // P0-5 — ngày đã settle sandbox sống sót restart
    void persistEngineState();
  }
}

/** #129 (F-02A) — trích xuất chuỗi vĩ mô VN từ RSS 06:35 ICT: POST
 *  /api/macro/ingest (1 lời gọi LLM có trích dẫn — cooldown 60s route;
 *  audit MACRO_INGESTED + markSource macro-vn). Fail-soft: LLM 502 → KHÔNG
 *  đánh dấu ngày, 30 phút sau (nhịp slot lướt qua do-check 60s sẽ không
 *  retry trong ngày — chấp nhận: job ngày mai tự bù, cursor không tiến khi
 *  lỗi nên KHÔNG mất tin). */
let macroVnInFlight = false;
const MACRO_VN_POST_TIMEOUT_MS = 180_000;
async function macroVnAndBroadcast(): Promise<void> {
  macroVnInFlight = true;
  try {
    const data = await postJson("/api/macro/ingest", undefined, {
      timeoutMs: MACRO_VN_POST_TIMEOUT_MS,
    });
    stats.lastMacroVnAt = new Date().toISOString();
    stats.macroVnRuns++;
    stats.lastMacroVnError = null;
    stats.lastMacroVnDate = ictNow().date;
    io.emit("macro-vn", data);
    log(
      "macro-vn",
      `F-02A trích xuất vĩ mô xong: quét ${data.scanned ?? "?"} tin · trích ${data.extracted ?? 0} quan sát · loại ${data.rejected ?? 0}`
    );
  } catch (err) {
    stats.lastMacroVnError = err instanceof Error ? err.message : String(err);
    log("macro-vn", `LỖI: ${stats.lastMacroVnError}`);
  } finally {
    macroVnInFlight = false;
    void persistEngineState();
  }
}

/** #129 (F-03a) — snapshot dòng khối ngoại 16:05 ICT: GET /api/market/flows
 *  (getForeignFlows tự persist ForeignFlow upsert (mã, ngày) — sau eod-sync
 *  15:45 Quote neo close thật → số liệu khớp Bar cùng ngày; fail-soft). */
let flowSyncInFlight = false;
const FLOW_SYNC_GET_TIMEOUT_MS = 120_000;
async function flowSyncAndBroadcast(): Promise<void> {
  flowSyncInFlight = true;
  try {
    const res = await fetch(`${APP_URL}/api/market/flows`, {
      signal: AbortSignal.timeout(FLOW_SYNC_GET_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as Record<string, unknown>;
    stats.lastFlowSyncAt = new Date().toISOString();
    stats.flowSyncRuns++;
    stats.lastFlowSyncError = null;
    stats.lastFlowSyncDate = ictNow().date;
    io.emit("flow-sync", data);
    log(
      "flow-sync",
      `F-03a snapshot khối ngoại xong: mode ${String(data.mode ?? "?")} · tổng ròng ${String(data.totalNet ?? "?")}`
    );
  } catch (err) {
    stats.lastFlowSyncError = err instanceof Error ? err.message : String(err);
    log("flow-sync", `LỖI: ${stats.lastFlowSyncError}`);
  } finally {
    flowSyncInFlight = false;
    void persistEngineState();
  }
}

function macroVnDue(): boolean {
  if (MACRO_VN_DISABLED) return false;
  if (macroVnInFlight) return false;
  const ict = ictNow();
  return (
    ict.minutes >= MACRO_VN_MINUTES &&
    stats.lastMacroVnDate !== ict.date &&
    stats.lastIntlSyncDate === ict.date
  );
}

function flowSyncDue(): boolean {
  if (FLOW_SYNC_DISABLED) return false;
  if (flowSyncInFlight) return false;
  const ict = ictNow();
  return (
    ict.minutes >= FLOW_SYNC_MINUTES &&
    stats.lastFlowSyncDate !== ict.date &&
    stats.lastEodSyncDate === ict.date
  );
}

/** Kiểm tra hằng phút: đã qua 15:45 ICT hôm nay và chưa sync ngày này → sync.
 * F-481-01: sync cũ chưa xong (~40s) → không bắn thêm. */
function eodSyncDue(): boolean {
  if (EOD_SYNC_DISABLED) return false;
  if (eodSyncInFlight) return false;
  const ict = ictNow();
  return ict.minutes >= EOD_SYNC_MINUTES && stats.lastEodSyncDate !== ict.date;
}

/** #106 — COUNCIL đánh giá sổ quyết định D-LEDGER 16:45 ICT t2–t6 (sau k1
 *  16:30 — tránh tranh lock). Route idempotent (upsert signalId). */
let councilEvalInFlight = false;
async function councilEvalAndBroadcast(): Promise<void> {
  councilEvalInFlight = true;
  try {
    const data = await postJson("/api/council/evaluate", undefined, {
      timeoutMs: 60_000,
    });
    stats.lastCouncilEvalAt = new Date().toISOString();
    stats.councilEvalRuns++;
    stats.lastCouncilEvalError = null;
    stats.lastCouncilEvalDate = ictNow().date;
    io.emit("council-eval", data);
    log(
      "council",
      `đánh giá quyết định xong: ${data.evaluated ?? 0} tín hiệu · WIN ${
        (data.byVerdict as { WIN?: number } | undefined)?.WIN ?? 0
      } · LOSS ${(data.byVerdict as { LOSS?: number } | undefined)?.LOSS ?? 0}`
    );
  } catch (err) {
    stats.lastCouncilEvalError = err instanceof Error ? err.message : String(err);
    log("council", `LỖI evaluate (thử lại phút sau): ${stats.lastCouncilEvalError}`);
  } finally {
    councilEvalInFlight = false;
    void persistEngineState();
  }
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
 *  (y hệt pattern reprobeDue: parseWeekly "SUN:04:00" · guard in-flight).
 *  F-00 (#129 — mục 2 "Catch-up lúc boot"): due-check mở từ "hôm nay là CN"
 *  thành "Chủ nhật GẦN NHẤT trong 24h qua" — engine chết qua đêm Chủ nhật →
 *  thứ Hai sáng chạy bù 1 lần (không phát sinh 2 lần nhờ cờ Chủ nhật đã
 *  đánh dấu + skip-guard windowHash của route; audit ML_TRAIN_AUTO để lại
 *  dấu vết cho ml-cycle-health). Quá 24h → không cưu (tuần sau chạy lại). */
function lastSundaySlot(): { date: string; minutesElapsed: number } | null {
  const ict = ictNow();
  const sched = ML_TRAIN_SCHEDULE;
  // phút ICT từ nửa đêm thứ Hai của TUẦN chứa (hoặc đứng trước) hôm nay
  const dayOffset = (ict.dow - sched.dow + 7) % 7; // 0 hôm nay là CN … 6 T7
  const slotMinutesTotal = (ict.minutes + dayOffset * 1440) - sched.minutes;
  if (slotMinutesTotal < 0) return null; // slot tuần này chưa tới
  const slotDate = new Date(Date.now() + 7 * 3_600_000 - slotMinutesTotal * 60_000);
  return {
    date: slotDate.toISOString().slice(0, 10),
    minutesElapsed: slotMinutesTotal,
  };
}
function mlTrainDue(): boolean {
  if (ML_TRAIN_DISABLED || !ML_TRAIN_SCHEDULE) return false;
  if (mlTrainInFlight) return false;
  const slot = lastSundaySlot();
  if (slot == null) return false;
  if (slot.minutesElapsed > 24 * 60) return false; // F-00: catch-up chỉ trong 24h
  return stats.lastMlTrainSunday !== slot.date;
}

/** C1 (#99 — ML_AUTOML_BLUEPRINT §4.6/F3) — Chủ nhật, đã qua 04:15 ICT, chưa
 *  sweep Chủ nhật này → chạy đợt sweep AutoML L1. Clone đúng pattern A4:
 *  guard in-flight sweep + KHÔNG chồng A4 (!mlTrainInFlight — sweep chạy
 *  SAU A4 cùng sáng, A4 04:00 <5 phút nên 04:15 đủ sóng thoải). */
function mlSweepDue(): boolean {
  if (ML_SWEEP_DISABLED || !ML_SWEEP_SCHEDULE) return false;
  if (sweepInFlight) return false;
  if (mlTrainInFlight) return false; // không bao giờ đè lên retrain A4
  // F-00 (#129): catch-up 24h như A4 — tính theo lịch sweep (SUN:04:15).
  const ict = ictNow();
  const dayOffset = (ict.dow - ML_SWEEP_SCHEDULE.dow + 7) % 7;
  const slotMinutesTotal = (ict.minutes + dayOffset * 1440) - ML_SWEEP_SCHEDULE.minutes;
  if (slotMinutesTotal < 0 || slotMinutesTotal > 24 * 60) return false;
  const slotDate = new Date(Date.now() + 7 * 3_600_000 - slotMinutesTotal * 60_000);
  return stats.lastMlSweepSunday !== slotDate.toISOString().slice(0, 10);
}

/** W3 (#164 · review #162) — auto-retrain theo PSI: POST /api/ml/psi-retrain.
 *  Route TỰ đo PSI (cùng lớp lib drift.ts như status) + 5 guard (kill-switch
 *  AppSetting ml-psi-retrain · cooldown 24h AuditLog ML_PSI_RETRAIN · ngưỡng
 *  PSI 0,25 · windowHash skip-guard mirror A4 · mutex/cooldown train dùng
 *  chung train tay + sweep) rồi mới trainDlMlp (serving-swap guard nội tại —
 *  bản mới thua valAcc thì archived, serving giữ nguyên). Engine chỉ đôn đốc
 *  như K2/K3 — KHÔNG tự quyết định. Timeout 280s như A4 (train 30-60s).
 *  Log + broadcast WS "ml-psi-retrain" CHỈ khi outcome KHÔNG phải skip
 *  bình thường (psi-below/cooldown/disabled/psi-unavailable — F-166b-1
 *  Fixbug #166 + F-166c-1 Vòng Xác Nhận: phủ định whitelist để mọi outcome
 *  lạ/không biết (error · "?" · tương lai) luôn ĐƯỢC log — không nuốt im
 *  lặng theo F-00; FE invalidate ml-status khi có hành động thật). Thất
 *  bại POST → KHÔNG đánh
 *  dấu gì, nhịp check sau thử lại (fail-soft, pattern settle). */
let psiRetrainInFlight = false;
const ML_PSI_RETRAIN_POST_TIMEOUT_MS = 280_000;
async function psiRetrainAndBroadcast(): Promise<void> {
  psiRetrainInFlight = true;
  try {
    const data = await postJson("/api/ml/psi-retrain", undefined, {
      timeoutMs: ML_PSI_RETRAIN_POST_TIMEOUT_MS,
    });
    stats.lastPsiRetrainAt = new Date().toISOString();
    stats.psiRetrainRuns++;
    stats.lastPsiRetrainError = null;
    const outcome = typeof data.outcome === "string" ? data.outcome : "?";
    stats.lastPsiRetrainOutcome = outcome;
    // F-166b-1 + F-166c-1 (Fixbug #166 — Vòng 1 + Vòng Xác Nhận): im lặng
    // CHỈ với các skip bình thường lặp mỗi 15' (tránh ~28 dòng rác/ngày);
    // mọi outcome KHÁC (skip-no-new-window · trained-* · error · "?" ·
    // chuỗi lạ tương lai) đều log + broadcast — không nuốt im lặng (F-00).
    // Route trả HTTP 200 + outcome:"error" khi trainDlMlp fail → phải thấy.
    const isNormalSkip =
      outcome === "skip-psi-below" ||
      outcome === "skip-cooldown" ||
      outcome === "skip-disabled" ||
      outcome === "skip-psi-unavailable";
    if (outcome === "error") {
      // F-166c-1: HTTP 200 nhưng train fail — đánh dấu lỗi cho /health
      // (trước đây đặt null rồi bỏ qua → giám sát mù).
      stats.lastPsiRetrainError = String(
        data.reason ?? "train PSI lỗi (route không kèm lý do)"
      );
    }
    if (!isNormalSkip) {
      io.emit("ml-psi-retrain", data);
      log(
        "ml-psi",
        `auto-retrain PSI W3: ${outcome} — ${String(data.reason ?? "")}`
      );
    }
  } catch (err) {
    // F-166b-4 (Fixbug #166 — Vòng 1): HTTP 429 = mutex/cooldown train đang
    // bận (train tay/sweep đụng nhau lúc 17:00) — tranh chấp bình thường,
    // KHÔNG phải lỗi nguồn: log "nhường", không đánh dấu lastPsiRetrainError.
    if (err instanceof HttpError && err.status === 429) {
      log("ml-psi", `nhường — train khác giữ mutex/cooldown: ${err.message}`);
    } else {
      stats.lastPsiRetrainError = err instanceof Error ? err.message : String(err);
      log("ml-psi", `LỖI (thử lại nhịp sau): ${stats.lastPsiRetrainError}`);
    }
  } finally {
    psiRetrainInFlight = false;
  }
}

/** Throttle nội bộ 15' — module-level (mất khi restart chỉ khiến 1 lần check
 *  sớm, vô hại: route tự guard bằng AuditLog cooldown + AppSetting). */
let psiRetrainLastCheckMs = 0;
/** W3 (#164) — due: t2–t6 (CN nhường A4/sweep · T7 không EOD mới) · ≥ 17:00
 *  ICT (sau settle 16:15 · k1 16:30 · council 16:45 — tránh tranh lock) ·
 *  EOD hôm nay ĐÃ sync (PSI chỉ đổi khi có bar mới) · nhịp check 15'. */
function psiRetrainDue(): boolean {
  if (ML_PSI_RETRAIN_DISABLED) return false;
  if (psiRetrainInFlight) return false;
  if (Date.now() - psiRetrainLastCheckMs < ML_PSI_RETRAIN_CHECK_MINUTES * 60_000) {
    return false;
  }
  const ict = ictNow();
  if (ict.dow === 0 || ict.dow === 6) return false; // CN=0 · T7=6
  return (
    ict.minutes >= ML_PSI_RETRAIN_MINUTES &&
    stats.lastEodSyncDate === ict.date
  );
}

/* ── Task 176 (STATE_SPACE_BLUEPRINT Phase 1) — vận hành SS hằng ngày ── */

/** In-flight guard + timeout POST riêng (fit 10 mã × MLE multi-start nhẹ,
 *  nhưng để trần 120s phòng DB chậm giờ settle). */
let ssDailyInFlight = false;
const SS_DAILY_POST_TIMEOUT_MS = 120_000;

/** Task 176 — due: t2–t6 · ≥ 16:50 ICT (sau settle 16:15 · k1 16:30 ·
 *  council-eval 16:45 — tránh tranh lock) · EOD hôm nay ĐÃ sync · chưa chạy
 *  ngày này (guard trong bộ nhớ — xem comment ML_SS_DAILY_AT trung thực). */
function ssDailyDue(): boolean {
  if (ML_SS_DAILY_DISABLED) return false;
  if (ssDailyInFlight) return false;
  const ict = ictNow();
  if (ict.dow === 0 || ict.dow === 6) return false; // CN=0 · T7=6
  return (
    ict.minutes >= ML_SS_DAILY_MINUTES &&
    stats.lastEodSyncDate === ict.date &&
    stats.lastSsDailyDate !== ict.date
  );
}

/** POST /api/ml/ss-daily — route tự kill-switch từng tầng (ml-ss-shadow /
 *  ml-ss-surprise / ml-ss-dataflag / ml-ss-beta — Task 178 Phase 2 thêm 2
 *  tầng) + fail-soft; engine chỉ đôn đốc (pattern psiRetrain). */
async function ssDailyAndBroadcast(): Promise<void> {
  ssDailyInFlight = true;
  try {
    const data = await postJson("/api/ml/ss-daily", undefined, {
      timeoutMs: SS_DAILY_POST_TIMEOUT_MS,
    });
    stats.lastSsDailyAt = new Date().toISOString();
    stats.ssDailyRuns++;
    stats.lastSsDailyError = null;
    const ict = ictNow();
    stats.lastSsDailyDate = ict.date;
    const shadow = (data as { shadow?: { outcome?: unknown; reason?: unknown; daysElapsed?: unknown } }).shadow;
    const surprise = (data as { surprise?: { outcome?: unknown; flagged?: unknown; checked?: unknown; tier?: unknown; reason?: unknown } }).surprise;
    // Task 178 · Phase 2 — 2 tầng mới (additive parse: FE/route cũ không có vẫn "?")
    const dataFlag = (data as { dataFlag?: { outcome?: unknown; outliers?: unknown; levelShifts?: unknown; checked?: unknown; reason?: unknown } }).dataFlag;
    const beta = (data as { beta?: { outcome?: unknown; destabilising?: unknown; checked?: unknown; reason?: unknown } }).beta;
    stats.lastSsDailyOutcome = `shadow:${String(shadow?.outcome ?? "?")} · surprise:${String(surprise?.outcome ?? "?")} · dataflag:${String(dataFlag?.outcome ?? "?")} · beta:${String(beta?.outcome ?? "?")}`;
    // Log 1 dòng/ngày (không rác như nhịp 15' của psi — SS chỉ chạy 1 lần).
    const shadowOut = String(shadow?.outcome ?? "?");
    const surpriseOut = String(surprise?.outcome ?? "?");
    const dataFlagOut = String(dataFlag?.outcome ?? "?");
    const betaOut = String(beta?.outcome ?? "?");
    log(
      "ss-daily",
      `State Space hằng ngày: shadow ${shadowOut}${shadowOut === "ran" && typeof shadow?.daysElapsed === "number" ? ` (ngày ${String(shadow.daysElapsed)}/14)` : ""}${shadow?.reason ? ` — ${String(shadow.reason)}` : ""} · surprise ${surpriseOut}${surpriseOut === "ran" ? ` (${String(surprise?.flagged ?? "?")}/${String(surprise?.checked ?? "?")} mã sốc, tier ${String(surprise?.tier ?? "?")})` : ""}${surprise?.reason ? ` — ${String(surprise.reason)}` : ""} · dataflag ${dataFlagOut}${dataFlagOut === "ran" ? ` (${String(dataFlag?.outliers ?? "?")} outlier · ${String(dataFlag?.levelShifts ?? "?")} level-shift/${String(dataFlag?.checked ?? "?")} mã)` : ""}${dataFlag?.reason ? ` — ${String(dataFlag.reason)}` : ""} · beta ${betaOut}${betaOut === "ran" ? ` (${String(beta?.checked ?? "?")} mã, ${String(beta?.destabilising ?? "?")} destabilising)` : ""}${beta?.reason ? ` — ${String(beta.reason)}` : ""}`
    );
    io.emit("ml-ss-daily", data);
  } catch (err) {
    stats.lastSsDailyError = err instanceof Error ? err.message : String(err);
    log("ss-daily", `LỖI: ${stats.lastSsDailyError}`);
  } finally {
    ssDailyInFlight = false;
  }
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

/** K1 (#87) — đã qua 16:30 ICT · EOD hôm nay ĐÃ sync · chưa settle sandbox ngày
 *  này → kết toán. T7/CN chặn như settle A1 (F-801-01 — không có EOD mới →
 *  equity snapshot cuối tuần vô nghĩa; job Thứ 2 quét bù position đóng Thứ 6
 *  lỡ hẹn vì window theo closedAt thực). */
function k1EquityDue(): boolean {
  if (K1_EQUITY_DISABLED) return false;
  if (k1EquityInFlight) return false;
  const ict = ictNow();
  if (ict.dow === 0 || ict.dow === 6) return false; // CN=0 · T7=6
  return (
    ict.minutes >= K1_EQUITY_MINUTES &&
    stats.lastEodSyncDate === ict.date &&
    stats.lastK1EquityDate !== ict.date
  );
}

/** #106 — COUNCIL evaluate: đã qua 16:45 ICT t2–t6 · EOD hôm nay ĐÃ sync ·
 *  chưa đánh giá ngày này → chạy D-LEDGER (sau k1 16:30 — tránh tranh lock). */
function councilEvalDue(): boolean {
  if (COUNCIL_EVAL_DISABLED) return false;
  if (councilEvalInFlight) return false;
  const ict = ictNow();
  if (ict.dow === 0 || ict.dow === 6) return false;
  return (
    ict.minutes >= COUNCIL_EVAL_MINUTES &&
    stats.lastEodSyncDate === ict.date &&
    stats.lastCouncilEvalDate !== ict.date
  );
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

http.on("error", (err) => {
  // FIXBUG #143 — listen fail phải LOUD: trước đây EADDRINUSE không có handler
  // → stderr im lặng (đo sandbox: không error event reachable từ callback, lỗi
  // bị Bun nuốt) → không ai biết scheduler đã đăng ký nhưng server chưa từng
  // lắng nghe. Log ỒNG để operator thấy ngay qua PM2 log.
  log(
    "boot",
    `LỖI HTTP server cổng ${PORT}: ${err instanceof Error ? err.message : String(err)} — scheduler đã đăng ký cấp module nhưng server CHƯA lắng nghe (cổng bị tiến trình khác giữ?) — kiểm tra pm2`
  );
});

/** FIXBUG #143 — log lịch boot (dùng chung cold boot + chẩn đoán). */
function logBootSchedule(): void {
  log(
    "boot",
    `lịch: tick ${(TICK_MS / 1000).toFixed(0)}s · news ${(NEWS_MS / 60_000).toFixed(0)}phút · eod-sync ${EOD_SYNC_AT} ICT${EOD_SYNC_DISABLED ? " (TẮT)" : ""} · intl-sync ${INTL_SYNC_AT} ICT${INTL_SYNC_DISABLED ? " (TẮT)" : ""} · reprobe ${REPROBE_AT} ICT${REPROBE_DISABLED ? " (TẮT)" : ""} · settle ${SETTLE_AT} ICT${SETTLE_DISABLED ? " (TẮT)" : ""} · ml-train ${ML_TRAIN_AT} ICT${ML_TRAIN_DISABLED ? " (TẮT)" : ""} · ml-sweep ${ML_SWEEP_AT} ICT${ML_SWEEP_DISABLED ? " (TẮT)" : ""} · ml-psi-retrain ${ML_PSI_RETRAIN_AT} ICT t2–t6${ML_PSI_RETRAIN_DISABLED ? " (TẮT)" : ` (check ${ML_PSI_RETRAIN_CHECK_MINUTES}phút)`} · k1-equity ${K1_EQUITY_AT} ICT${K1_EQUITY_DISABLED ? " (TẮT)" : ""} · council-eval ${COUNCIL_EVAL_AT} ICT${COUNCIL_EVAL_DISABLED ? " (TẮT)" : ""} · ss-daily ${ML_SS_DAILY_AT} ICT t2–t6${ML_SS_DAILY_DISABLED ? " (TẮT)" : ""} · macro-vn ${MACRO_VN_AT} ICT${MACRO_VN_DISABLED ? " (TẮT)" : ""} · flow-sync ${FLOW_SYNC_AT} ICT${FLOW_SYNC_DISABLED ? " (TẮT)" : ""} · agent-cycle ${
      AGENT_CYCLE_MINUTES > 0 ? `${AGENT_CYCLE_MINUTES.toFixed(0)}phút` : "TẮT"
    } (hậu phương K2) · k2 due-check 60s (AppSetting "k-run") · k3 task due-check 60s (nhiệm vụ định kỳ AgentTask)`
  );
}

/** P0-5 (phiên #57): hydrate state từ DB TRƯỚC khi chạy boot-sync — restart
 * không quên "hôm nay đã sync EOD" (nghiệm thu: kill engine → restart →
 * KHÔNG refetch EOD đã xong hôm đó) và không quên backoff intl.
 * FIXBUG #143 — tách ra hàm riêng: hydrate chạy ở CẤP MODULE, không phụ thuộc
 * http.listen callback (callback không chạy khi listen fail âm thầm). */
function bootHydrateAndSync(): void {
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
}

/* ═══ FIXBUG #143 — ĐĂNG KÝ SCHEDULER Ở CẤP MODULE ═══
 * Trước đây toàn bộ setInterval nằm trong callback http.listen — mọi phụ thuộc
 * vào việc listen THÀNH CÔNG. Đo thật (zombie 8,5h 18-10) + sandbox: khi cổng
 * bị incarnation trước giữ, listen fail ÂM THẦM (không error event) → callback
 * không chạy → 0 scheduler. Giờ đăng ký ngay cấp module — scheduler sống độc
 * lập với trạng thái listen; callback chỉ còn việc LOG. */
enqueueTick();
void ingestNewsAndBroadcast();
// AUDIT 137 D7 — mọi interval đăng ký qua mảng global để re-evaluate dọn được
engineTimers.push(setInterval(enqueueTick, TICK_MS));
engineTimers.push(setInterval(ingestNewsAndBroadcast, NEWS_MS));
// Try/catch quanh cả khối due-check: một due-check hỏng (bug cấu hình,
// null schedule…) không được phép giết event loop của cả engine — bug #42
// đã làm engine chết lặng ~2h vì TypeError không được bắt trong callback này.
// AUDIT 137 D7 — interval due-check 60s cũng vào mảng global (guard hot-reload)
const dueCheckTimer = setInterval(() => {
  try {
    if (eodSyncDue()) void syncEodAndBroadcast();
    if (intlSyncDue()) void syncIntlAndBroadcast();
    if (reprobeDue()) void reprobeAndBroadcast();
    // A1/A4 (#79) — lịch settle 16:15 ICT hằng ngày + retrain CN 04:00 ICT
    // (due-check mới nhất trong try/catch chung — lỗi 1 lịch không giết cả khối)
    if (settleDue()) void settleAndBroadcast();
    if (mlTrainDue()) void mlTrainAndBroadcast();
    // C1 (#99 — ML_AUTOML_BLUEPRINT §4.6/F3): sweep AutoML L1 CN 04:15 ICT
    // (sau A4 04:00 — cùng try/catch chung, lỗi 1 lịch không giết cả khối)
    if (mlSweepDue()) void mlSweepAndBroadcast();
    // W3 (#164) — auto-retrain theo PSI (t2–t6 ≥ 17:00 ICT sau EOD-sync, nhịp
    // check 15'): cập nhật mốc throttle NGAY khi bắn (in-flight guard chống
    // POST chồng; route tự guard bằng AuditLog cooldown + AppSetting).
    if (psiRetrainDue()) {
      psiRetrainLastCheckMs = Date.now();
      stats.lastPsiRetrainCheckAt = new Date().toISOString();
      void psiRetrainAndBroadcast();
    }
    // Task 176 (STATE_SPACE_BLUEPRINT Phase 1) — vận hành SS hằng ngày sau
    // council-eval 16:45 (cùng try/catch chung, lỗi 1 lịch không giết khối).
    if (ssDailyDue()) void ssDailyAndBroadcast();
    // K1 (#87 — AUTONOMY_BLUEPRINT v1.1 §5.4): settle sandbox 16:30 ICT (sau
    // settle bandit 16:15 — cùng try/catch chung, lỗi 1 lịch không giết khối)
    if (k1EquityDue()) void k1EquityAndBroadcast();
    // #129 (F-02A + F-03a) — macro VN 06:35 (gate intl đã sync) + flow 16:05
    // (gate eod đã sync) — cùng try/catch chung, lỗi 1 lịch không giết khối.
    if (macroVnDue()) void macroVnAndBroadcast();
    if (flowSyncDue()) void flowSyncAndBroadcast();
    // #106 — COUNCIL_STEWARDSHIP_BLUEPRINT §6: mark thí nghiệm 16:35 → đánh giá
    // quyết định 16:45 → hội nghị phân bổ LLM CN 05:50 (cùng try/catch chung)
    if (councilEvalDue()) void councilEvalAndBroadcast();
    // K2 (#86 — AUTONOMY_BLUEPRINT v1.1 §4.3): due-check chạy liên tục —
    // async + .catch bổ sung theo nguyên tắc vàng Fixbug #2 (timer callback
    // không được phép ném uncaught exception giết event loop).
    void k2CheckAndRun().catch((err) => {
      log("k2", `LỖI k2CheckAndRun: ${err instanceof Error ? err.message : String(err)}`);
    });
    // K3 (#94 — AUTONOMY_BLUEPRINT v1.1 §6.3): due-check nhiệm vụ định kỳ —
    // cùng try/catch chung + .catch riêng (lỗi 1 lịch không giết cả khối;
    // engine chỉ đôn đốc, kết quả do route ghi trên AgentTask).
    void k3TaskDueCheck().catch((err) => {
      log("k3", `LỖI k3TaskDueCheck: ${err instanceof Error ? err.message : String(err)}`);
    });
  } catch (err) {
    log("sched", `LỖI scheduler 60s: ${err instanceof Error ? err.message : String(err)}`);
  }
}, 60_000);
engineTimers.push(dueCheckTimer);
if (AGENT_CYCLE_MINUTES > 0) {
  engineTimers.push(
    setInterval(runAgentCycleAndBroadcast, AGENT_CYCLE_MINUTES * 60_000)
  );
}

// FIXBUG #143 — hydrate + boot-sync CŨNG cấp module (không nằm trong listen
// callback nữa — xem bootHydrateAndSync).
bootHydrateAndSync();

// FIXBUG #143 — callback chỉ còn LOG; scheduler đã sống từ cấp module trên.
http.listen(PORT, () => {
  log("boot", `market-engine lắng nghe cổng ${PORT} → app ${APP_URL} — scheduler đã đăng ký cấp module (fixbug #143)`);
  logBootSchedule();
});

process.on("SIGINT", () => {
  log("boot", "tắt market-engine…");
  io.close();
  http.close();
  process.exit(0);
});
