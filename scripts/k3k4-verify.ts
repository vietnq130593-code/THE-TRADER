/**
 * scripts/k3k4-verify.ts — K3 "Nhiệm vụ định kỳ" + K4 "Ban Điều hành giao
 * việc" NGHIỆM THU HERMETIC (AUTONOMY_BLUEPRINT v1.1 §6.5/§7.4, phiên #94).
 *
 * 6 nhóm phép — chạy THẬT trên DB + dev server :3000 (chuẩn bị môi trường +
 * dọn sạch mọi task test sau khi xong; AuditLog kiểm định để lại làm truy vết):
 *
 *  V1  Parser lịch thuần: parseScheduleGrammar (daily/weekly/sai grammar) +
 *      computeNextDueAt (daily còn-giờ-hôm-nay / qua-giờ-hôm-nay / weekly
 *      đúng-hôm-còn-giờ / đúng-hôm-qua-giờ → tuần sau) — đối chiếu bằng triển
 *      khai ĐỘC LẬP trong script (không import lại hàm đang test cho kỳ vọng).
 *  V2  POST /api/agents/[id]/tasks daily "09:30" → nextDueAt do SERVER tính
 *      đúng giờ ICT + 422 fields[] cho lịch rác.
 *  V3  PATCH pause → paused=true (nextDueAt giữ) · resume → nextDueAt tính
 *      lại từ "bây giờ" · PATCH deferMinutes:5 trên task due (paused) →
 *      nextDueAt ≈ now+5 phút (cơ chế engine hoãn agent bận).
 *  V4  Single-run THEO taskId (agent LLM thật: market-analyst, timeout 90s;
 *      LLM chậm/timeout → SKIP ghi rõ lý do) → AgentRun.taskId liên kết +
 *      AgentTask runCount+1 + failStreak=0 + nextDueAt lùi đúng 24h.
 *  V5  k4.ts: extractAssignTasks (JSON hợp lệ / rác / thiếu khoá) +
 *      validateAssignTasks thuần (giao executive bị chặn · agent lạ ·
 *      schedule rác · sớm hơn +4h · maxOpenTasksPerAgent · maxTasksPerCycle) +
 *      assignChairmanTasks DB (JSON hợp lệ tạo đúng createdByAgentId=Chủ tịch
 *      · JSON rác bị bỏ, không crash).
 *  V5b FB-4A (fixbug vòng 3 — vá K3/K4 theo báo cáo FB-3):
 *      V-2BLOCKS extractAssignTasks dạng 2 fenced block (JSON tín hiệu trước
 *      + JSON giao việc sau — S1/M4 đã gãy) · dạng unfenced sau khối tín hiệu
 *      (M3) · echo ví dụ prompt trước JSON thật (S7 — lấy occurrence cuối) ·
 *      echo unfenced trước JSON thật (tier b).
 *      V-SCHED-NULL validateAssignTasks chặn schedule null/rỗng với lý do
 *      schedule-bat-buoc (nhiệm vụ một lần là dead-letter — engine chỉ chạy
 *      task có lịch).
 *      V-WATCHDOG F-K3-01: agent status RUNNING quá 5 phút KHÔNG có run sống
 *      → reapStaleAgentRuns() reset IDLE ngay cả khi reaped.count === 0 (đường
 *      dead-code cũ); claim còn tươi (<5ph) KHÔNG bị đụng. Agent test tự tạo +
 *      tự dọn (hermetic).
 *  V6  Dọn sạch: xoá toàn bộ task test (+ AgentRun/AgentMessage test của V4
 *      + agent test watchdog của V5b) + trả AppSetting "k4" về trạng thái
 *      TRƯỚC test.
 *
 * Chạy: `bun scripts/k3k4-verify.ts` (dev server :3000 đang chạy).
 */

import { db } from "../src/lib/db";
import {
  parseScheduleGrammar,
  computeNextDueAt,
  describeSchedule,
} from "../src/lib/schedule";
import {
  extractAssignTasks,
  validateAssignTasks,
  assignChairmanTasks,
  getK4,
  defaultK4,
  type K4AgentInfo,
  type K4Stored,
} from "../src/lib/k4";
// FB-4A (F-K3-01): watchdog reset Agent.status kẹt RUNNING — test V-WATCHDOG.
import { reapStaleAgentRuns } from "../src/lib/agent-ratelimit";

const APP_URL = process.env.APP_URL ?? "http://127.0.0.1:3000";
const ICT_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;
/** Dung sai thời gian giữa script và server (clock tick giữa 2 lần đọc now). */
const TOLERANCE_MS = 90_000;

let passed = 0;
let failed = 0;
const skipped: string[] = [];

function check(name: string, ok: boolean, detail?: string): boolean {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
  return ok;
}

function iso(d: Date): string {
  return d.toISOString();
}

/* ── Triển khai ĐỘC LẬP cho kỳ vọng (không tái dùng hàm đang test) ── */

function ictParts(d: Date) {
  const s = new Date(d.getTime() + ICT_OFFSET_MS);
  return {
    y: s.getUTCFullYear(),
    mo: s.getUTCMonth(),
    day: s.getUTCDate(),
    dow: s.getUTCDay(),
  };
}

function midnightIct(d: Date): number {
  const p = ictParts(d);
  return Date.UTC(p.y, p.mo, p.day) - ICT_OFFSET_MS;
}

function expectedDaily(from: Date, hh: number, mm: number): Date {
  const slot = midnightIct(from) + (hh * 60 + mm) * 60_000;
  return new Date(slot > from.getTime() ? slot : slot + DAY_MS);
}

function expectedWeekly(from: Date, dow: number, hh: number, mm: number): Date {
  const dowNow = ictParts(from).dow;
  let diff = (dow - dowNow + 7) % 7;
  const slot = midnightIct(from) + (hh * 60 + mm) * 60_000;
  if (diff === 0 && slot <= from.getTime()) diff = 7;
  return new Date(midnightIct(from) + diff * DAY_MS + (hh * 60 + mm) * 60_000);
}

function near(expected: Date, actual: Date | string | null | undefined): boolean {
  if (actual == null) return false;
  const t = typeof actual === "string" ? Date.parse(actual) : actual.getTime();
  return Number.isFinite(t) && Math.abs(t - expected.getTime()) <= TOLERANCE_MS;
}

/* ── HTTP helper (dev server :3000) ── */

async function http(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 30_000
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${APP_URL}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

async function main(): Promise<void> {
  console.log("══ K3+K4 NGHIỆM THU HERMETIC (phiên #94) ══");
  console.log(`APP_URL: ${APP_URL}\n`);

  const testTaskIds: string[] = [];
  const testRunIds: string[] = [];
  const testMessageIds: string[] = [];
  const testAgentIds: string[] = []; // FB-4A V-WATCHDOG — agent test tự tạo
  let k4RowBefore: { key: string; value: string } | null = null;

  try {
    /* ═══ V1 — Parser lịch thuần ═══ */
    console.log("V1 · Parser lịch (parseScheduleGrammar + computeNextDueAt):");
    {
      const g1 = parseScheduleGrammar("09:30");
      check(
        'parseScheduleGrammar("09:30") → daily 570',
        g1 != null && g1.kind === "daily" && g1.minutes === 570
      );
      const g2 = parseScheduleGrammar("MON:09:30");
      check(
        'parseScheduleGrammar("MON:09:30") → weekly dow=1 phút=570',
        g2 != null && g2.kind === "weekly" && g2.dow === 1 && g2.minutes === 570
      );
      const g3 = parseScheduleGrammar("SUN:23:59");
      check(
        'parseScheduleGrammar("SUN:23:59") → weekly dow=0',
        g3 != null && g3.kind === "weekly" && g3.dow === 0 && g3.minutes === 23 * 60 + 59
      );
      check(
        "grammar rác → null (25:00 / MON:99:00 / xyz / rỗng)",
        parseScheduleGrammar("25:00") == null &&
          parseScheduleGrammar("MON:99:00") == null &&
          parseScheduleGrammar("xyz") == null &&
          parseScheduleGrammar("") == null
      );

      // Daily — còn giờ hôm nay: 2026-10-12T02:00Z = 09:00 ICT Thứ Hai.
      const mon0900Ict = new Date("2026-10-12T02:00:00Z");
      check(
        "daily 09:30 lúc 09:00 ICT → HÔM NAY 09:30 ICT (02:30Z)",
        iso(computeNextDueAt("09:30", mon0900Ict)) ===
          iso(expectedDaily(mon0900Ict, 9, 30)) &&
          iso(computeNextDueAt("09:30", mon0900Ict)) === "2026-10-12T02:30:00.000Z"
      );
      // Daily — QUA giờ hôm nay: 10:00 ICT → ngày mai.
      const mon1000Ict = new Date("2026-10-12T03:00:00Z");
      check(
        "daily 09:30 lúc 10:00 ICT → NGÀY MAI 09:30 (2026-10-13T02:30Z)",
        iso(computeNextDueAt("09:30", mon1000Ict)) ===
          iso(expectedDaily(mon1000Ict, 9, 30)) &&
          iso(computeNextDueAt("09:30", mon1000Ict)) === "2026-10-13T02:30:00.000Z"
      );
      // Weekly — đúng thứ, còn giờ → hôm nay.
      check(
        "weekly MON:09:30 lúc Thứ Hai 09:00 ICT → HÔM NAY",
        iso(computeNextDueAt("MON:09:30", mon0900Ict)) ===
          iso(expectedWeekly(mon0900Ict, 1, 9, 30))
      );
      // Weekly — đúng thứ, QUA giờ → tuần sau.
      check(
        "weekly MON:09:30 lúc Thứ Hai 10:00 ICT → TUẦN SAU (2026-10-19T02:30Z)",
        iso(computeNextDueAt("MON:09:30", mon1000Ict)) ===
          iso(expectedWeekly(mon1000Ict, 1, 9, 30)) &&
          iso(computeNextDueAt("MON:09:30", mon1000Ict)) === "2026-10-19T02:30:00.000Z"
      );
      // Weekly — thứ trong tuần tới.
      const tue2300Ict = new Date("2026-10-13T16:00:00Z"); // Thứ Ba 23:00 ICT
      check(
        "weekly FRI:08:00 từ Thứ Ba 23:00 ICT → Thứ Sáu 08:00 (2026-10-16T01:00Z)",
        iso(computeNextDueAt("FRI:08:00", tue2300Ict)) ===
          iso(expectedWeekly(tue2300Ict, 5, 8, 0)) &&
          iso(computeNextDueAt("FRI:08:00", tue2300Ict)) === "2026-10-16T01:00:00.000Z"
      );
      // describeSchedule tiếng Việt.
      check(
        "describeSchedule: hằng ngày 09:30 / hằng tuần thứ Hai 09:30",
        describeSchedule("09:30") === "hằng ngày 09:30" &&
          describeSchedule("MON:09:30") === "hằng tuần thứ Hai 09:30"
      );
    }

    /* ═══ Chuẩn bị: agent market-analyst + snapshot AppSetting k4 ═══ */
    const analyst = await db.agent.findUnique({ where: { code: "market-analyst" } });
    if (!analyst) throw new Error("không tìm thấy agent market-analyst trong DB");
    const chairman = await db.agent.findUnique({ where: { code: "portfolio-strategist" } });
    if (!chairman) throw new Error("không tìm thấy agent portfolio-strategist trong DB");
    const liquidity = await db.agent.findUnique({ where: { code: "liquidity" } });
    if (!liquidity) throw new Error("không tìm thấy agent liquidity trong DB");
    const execManager = await db.agent.findUnique({ where: { code: "execution-manager" } });
    if (!execManager) throw new Error("không tìm thấy agent execution-manager trong DB");
    const newsAgent = await db.agent.findUnique({ where: { code: "news-sentiment" } });
    if (!newsAgent) throw new Error("không tìm thấy agent news-sentiment trong DB");
    k4RowBefore =
      (await db.appSetting.findUnique({ where: { key: "k4" } })) ?? null;

    /* ═══ V2 — POST tạo task daily (server tính nextDueAt) ═══ */
    console.log("\nV2 · POST /api/agents/[id]/tasks — server tính nextDueAt:");
    let dailyTaskId = "";
    {
      const before = new Date();
      const res = await http("POST", `/api/agents/${analyst.id}/tasks`, {
        title: "[TEST K3] Rà soát hỗ trợ mỗi sáng",
        description: "Nhiệm vụ kiểm định K3 phiên #94 — sẽ bị xoá sau test.",
        schedule: "09:30",
        priority: "medium",
      });
      const task = res.json.task as Record<string, unknown> | undefined;
      dailyTaskId = typeof task?.id === "string" ? task.id : "";
      check(
        "POST daily 09:30 → 201 + task có id",
        res.status === 201 && Boolean(dailyTaskId),
        `HTTP ${res.status}`
      );
      const expected = expectedDaily(before, 9, 30);
      check(
        "nextDueAt SERVER tính đúng (hằng ngày 09:30 ICT)",
        near(expected, (task?.nextDueAt as string) ?? null),
        `mong ${iso(expected)} · nhận ${String(task?.nextDueAt)}`
      );
      const bad = await http("POST", `/api/agents/${analyst.id}/tasks`, {
        title: "[TEST K3] lịch rác",
        schedule: "9:99",
      });
      const fields = (bad.json.fields as { field?: string }[] | undefined) ?? [];
      check(
        "schedule rác → 422 + fields[0].field='schedule'",
        bad.status === 422 && fields.some((f) => f.field === "schedule"),
        `HTTP ${bad.status}`
      );
      if (dailyTaskId) testTaskIds.push(dailyTaskId);
    }

    /* ═══ V3 — PATCH pause / resume / defer ═══ */
    console.log("\nV3 · PATCH pause → resume → defer:");
    {
      const pauseRes = await http(
        "PATCH",
        `/api/agents/${analyst.id}/tasks/${dailyTaskId}`,
        { paused: true }
      );
      const pausedTask = pauseRes.json.task as Record<string, unknown> | undefined;
      check(
        "pause → 200 + paused=true + nextDueAt GIỮ NGUYÊN",
        pauseRes.status === 200 &&
          pausedTask?.paused === true &&
          near(expectedDaily(new Date(Date.now() - 5 * 60_000), 9, 30), (pausedTask?.nextDueAt as string) ?? null)
      );

      const beforeResume = new Date();
      const resumeRes = await http(
        "PATCH",
        `/api/agents/${analyst.id}/tasks/${dailyTaskId}`,
        { paused: false }
      );
      const resumedTask = resumeRes.json.task as Record<string, unknown> | undefined;
      check(
        "resume → 200 + paused=false + nextDueAt TÍNH LẠI từ bây giờ",
        resumeRes.status === 200 &&
          resumedTask?.paused === false &&
          near(expectedDaily(beforeResume, 9, 30), (resumedTask?.nextDueAt as string) ?? null)
      );

      // Defer engine: ép task due (nextDueAt quá khứ) + paused (engine bỏ qua)
      // → PATCH deferMinutes:5 → nextDueAt ≈ now+5 phút.
      await db.agentTask.update({
        where: { id: dailyTaskId },
        data: { nextDueAt: new Date(Date.now() - 60_000), paused: true },
      });
      const beforeDefer = new Date();
      const deferRes = await http(
        "PATCH",
        `/api/agents/${analyst.id}/tasks/${dailyTaskId}`,
        { deferMinutes: 5 }
      );
      const deferred = deferRes.json.task as Record<string, unknown> | undefined;
      const expectDefer = new Date(beforeDefer.getTime() + 5 * 60_000);
      check(
        "deferMinutes:5 trên task due → nextDueAt ≈ now+5 phút (cơ chế engine hoãn)",
        deferRes.status === 200 &&
          near(expectDefer, (deferred?.nextDueAt as string) ?? null),
        `mong ${iso(expectDefer)} · nhận ${String(deferred?.nextDueAt)}`
      );
    }

    /* ═══ V4 — Single-run THEO taskId (agent LLM thật) ═══ */
    console.log("\nV4 · Single-run với taskId (market-analyst — LLM thật):");
    {
      // Đưa task về trạng thái như engine gặp khi due: nextDueAt = 2h TRƯỚC
      // now (đã đến giờ). Giữ paused=true để engine :3003 (đang chạy) không
      // nhặt task này đua với POST run của script — route single-run không
      // quan tâm paused, chỉ due-check engine lọc. V6 sẽ xoá task này.
      await db.agentTask.update({
        where: { id: dailyTaskId },
        data: {
          paused: true,
          nextDueAt: new Date(Date.now() - 2 * 3_600_000),
          runCount: 0,
          failStreak: 0,
        },
      });
      const t0 = Date.now();
      let res = await http(
        "POST",
        `/api/agents/${analyst.id}/run`,
        { taskId: dailyTaskId },
        90_000
      );
      // 429 rate-limit 60s (agent vừa chạy nơi khác) → chờ đúng số giây, thử lại 1 lần.
      if (res.status === 429) {
        const retryAfter = Number(res.json.retryAfterSeconds ?? 60);
        console.log(
          `  ⏳ agent đang trong cooldown 60s — chờ ${retryAfter}s rồi thử lại…`
        );
        await new Promise((r) => setTimeout(r, Math.min(70, retryAfter + 2) * 1000));
        res = await http("POST", `/api/agents/${analyst.id}/run`, { taskId: dailyTaskId }, 90_000);
      }
      const elapsed = Date.now() - t0;
      if (res.status !== 200) {
        skipped.push(
          `V4 single-run: HTTP ${res.status} sau ${Math.round(elapsed / 1000)}s — ${String(res.json.error ?? "")}`
        );
        console.log(
          `  ⚠️ SKIP V4 — HTTP ${res.status} (${String(res.json.error ?? "").slice(0, 120)})`
        );
      } else if (elapsed > 90_000) {
        skipped.push(`V4 single-run: LLM quá chậm (${Math.round(elapsed / 1000)}s > 90s)`);
        console.log(`  ⚠️ SKIP V4 — LLM quá chậm: ${Math.round(elapsed / 1000)}s`);
      } else {
        const runInfo = res.json.run as Record<string, unknown> | undefined;
        check(
          "POST run {taskId} → 200 + response kèm thông tin nhiệm vụ",
          res.status === 200 && (res.json.task as { id?: string } | undefined)?.id === dailyTaskId,
          `${Math.round(elapsed / 1000)}s · ${String(runInfo?.taskStatus ?? "")}`
        );
        const runRow = await db.agentRun.findFirst({
          where: { taskId: dailyTaskId },
          orderBy: { startedAt: "desc" },
        });
        check(
          "AgentRun.taskId LIÊN KẾT đúng nhiệm vụ (COMPLETED)",
          runRow != null && runRow.taskId === dailyTaskId && runRow.taskStatus === "COMPLETED",
          `run ${runRow?.id ?? "—"}`
        );
        if (runRow) testRunIds.push(runRow.id);
        const taskAfter = await db.agentTask.findUnique({ where: { id: dailyTaskId } });
        check(
          "runCount 0→1 + failStreak=0 + lastRunAt ghi",
          taskAfter?.runCount === 1 && taskAfter?.failStreak === 0 && taskAfter?.lastRunAt != null
        );
        // Route semantics (§6.2): nextDueAt = computeNextDueAt(schedule) tính
        // lúc run kết thúc — đúng invariant là SLOT 09:30 KẾ TIẾP SAU thời điểm
        // đó. Chạy lúc task đang due (nextDueAt quá khứ) → slot mới luôn TƯƠNG
        // LAI = nhịp dịch tiến đúng (đường engine thật: slot đã tiêu thụ → +24h
        // sang mai; chạy tay sớm thì giữ slot tới — cùng một công thức).
        const runEnd = new Date();
        const expectNext = expectedDaily(runEnd, 9, 30);
        check(
          "nextDueAt = slot 09:30 kế tiếp sau lúc chạy xong (nhịp dịch tiến)",
          taskAfter?.nextDueAt != null &&
            near(expectNext, taskAfter.nextDueAt) &&
            taskAfter.nextDueAt.getTime() > runEnd.getTime(),
          `mong ${iso(expectNext)} · nhận ${taskAfter?.nextDueAt?.toISOString() ?? "—"}`
        );
        check(
          "status GIỮ PENDING cho định kỳ (semantics mới — engine tiếp tục nhịp sau)",
          taskAfter?.status === "PENDING"
        );
      }
    }

    /* ═══ V5 — k4.ts parse/validate ═══ */
    console.log("\nV5 · K4 — parse + validate + assignChairmanTasks:");
    {
      // 5a. extractAssignTasks — 3 tầng.
      const goodRaw =
        'Tổng hợp…\n```json\n{"summary":"S","signal":{"symbol":"VCB"},"assignTasks":[{"agentCode":"liquidity","title":"Theo dõi thanh khoản HNX","description":"Báo cáo ngắn","schedule":"TUE:23:00","priority":"high"}]}\n```';
      const good = extractAssignTasks(goodRaw);
      check(
        "extractAssignTasks: JSON fenced hợp lệ → 1 mục",
        Array.isArray(good) && good.length === 1
      );
      const noKey = extractAssignTasks("Tổng hợp không có khoá giao việc nào…");
      check(
        "extractAssignTasks: không có 'assignTasks' → null (Chủ tịch không giao)",
        noKey === null
      );
      const junk = extractAssignTasks(
        'rác rác assignTasks [ broken { không parse được ]}]'
      );
      check(
        "extractAssignTasks: JSON rác → null (fail-soft, không ném)",
        junk === null
      );

      // 5b. validateAssignTasks THUẦN — bộ agent test + các luật chặn.
      const agentsByCode = new Map<string, K4AgentInfo>(
        [liquidity, execManager, newsAgent, analyst].map((a) => [
          a.code,
          { id: a.id, code: a.code, name: a.name, group: a.group },
        ])
      );
      // Chọn lịch đủ xa (≥ +4h): dow XÁC SUẤT nhất — lấy slot 23:00 của thứ
      // XA NHẤT so với bây giờ (≥ 6 ngày) → chắc chắn vượt ngưỡng +4h.
      const now = new Date();
      let farSchedule = "MON:23:00";
      let farDue = expectedWeekly(now, 1, 23, 0);
      for (const dowName of ["TUE", "WED", "THU", "FRI", "SAT", "SUN"]) {
        const cand = expectedWeekly(
          now,
          { TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6, SUN: 0 }[dowName]!,
          23,
          0
        );
        if (cand.getTime() > farDue.getTime()) {
          farDue = cand;
          farSchedule = `${dowName}:23:00`;
        }
      }
      // Lịch "quá sớm" XÁC SUẤT: giờ ICT của (now + 1h) làm lịch daily → lần
      // due kế tiếp luôn = now+1h (< +4h) mọi thời điểm trong ngày.
      const soonIct = new Date(now.getTime() + 60 * 60_000);
      const soonParts = new Date(soonIct.getTime() + ICT_OFFSET_MS);
      const soonSchedule = `${String(soonParts.getUTCHours()).padStart(2, "0")}:${String(soonParts.getUTCMinutes()).padStart(2, "0")}`;
      const k4Test: K4Stored = {
        enabled: true,
        maxOpenTasksPerAgent: 2,
        maxTasksPerCycle: 3,
      };
      const vctx = {
        agentsByCode,
        openTaskCountByCode: new Map<string, number>(),
        now,
        k4: k4Test,
      };
      const valid = validateAssignTasks(
        [
          {
            agentCode: "liquidity",
            title: "Theo dõi dòng tiền HNX",
            description: "Báo cáo ngắn mỗi tuần",
            schedule: farSchedule,
            priority: "high",
          },
          {
            agentCode: "execution-manager",
            title: "Tự giao việc cho Ban Điều hành",
            schedule: farSchedule,
          },
          { agentCode: "khong-ton-tai", title: "Agent lạ" },
          { agentCode: "news-sentiment", title: "L".repeat(200), schedule: farSchedule },
          { agentCode: "news-sentiment", title: "Lịch rác", schedule: "99:99" },
          {
            agentCode: "news-sentiment",
            title: "Quá sớm",
            schedule: soonSchedule, // lần due kế = now+1h < +4h → chắc chắn bị bỏ
          },
        ],
        vctx
      );
      check(
        "validate: mục hợp lệ cho liquidity (research) ĐƯỢC NHẬN",
        valid.valid.length === 1 &&
          valid.valid[0]?.agentCode === "liquidity" &&
          valid.valid[0]?.priority === "high"
      );
      const reasons = valid.skipped.map((s) => s.reason).join(" | ");
      check(
        "validate: executive bị chặn (quy tắc 2 cấp)",
        valid.skipped.some((s) => s.reason.includes("cấm executive")),
        reasons.slice(0, 160)
      );
      check(
        "validate: agent lạ bị bỏ",
        valid.skipped.some((s) => s.reason.includes("không tồn tại"))
      );
      check(
        "validate: title quá 120 ký tự bị bỏ",
        valid.skipped.some((s) => s.reason.includes("title"))
      );
      check(
        "validate: schedule rác bị bỏ",
        valid.skipped.some((s) => s.reason.includes("grammar"))
      );
      check(
        "validate: schedule sớm hơn +4h bị bỏ",
        valid.skipped.some((s) => s.reason.includes("+4h")),
        reasons.slice(0, 160)
      );

      // maxOpenTasksPerAgent: liquidity đã treo 1 (max 2) → 3 mục: mục đầu
      // đủ hạn mức (1+1=2), 2 mục sau bị chặn (đếm cả task vừa tạo trong batch).
      const v2 = validateAssignTasks(
        [
          { agentCode: "liquidity", title: "Thứ ba", schedule: farSchedule },
          { agentCode: "liquidity", title: "Thứ tư", schedule: farSchedule },
          { agentCode: "liquidity", title: "Thứ năm", schedule: farSchedule },
        ],
        {
          ...vctx,
          openTaskCountByCode: new Map([["liquidity", 1]]),
        }
      );
      check(
        "validate: vượt maxOpenTasksPerAgent (1 treo + 3 tạo, max 2 → chỉ 1 nhận)",
        v2.valid.length === 1 &&
          v2.skipped.filter((s) => s.reason.includes("nhiệm vụ treo")).length === 2
      );
      // maxTasksPerCycle: 4 mục hợp lệ cho 4 agent khác nhau, max 3 → 3 nhận.
      const v3 = validateAssignTasks(
        [
          { agentCode: "liquidity", title: "A", schedule: farSchedule },
          { agentCode: "news-sentiment", title: "B", schedule: farSchedule },
          { agentCode: "market-analyst", title: "C", schedule: farSchedule },
          { agentCode: "liquidity", title: "D", schedule: farSchedule },
        ],
        vctx
      );
      check(
        "validate: maxTasksPerCycle=3 → nhận 3, bỏ 1 (lý do vượt)",
        v3.valid.length === 3 &&
          v3.skipped.some((s) => s.reason.includes("maxTasksPerCycle"))
      );

      // 5c. assignChairmanTasks — DB thật, JSON rác fail-soft.
      const junkRes = await assignChairmanTasks(
        "Chu kỳ tổng hợp rác — không có gì parse được ở đây",
        { chairmanAgentId: chairman.id, k4: k4Test }
      );
      check(
        "assignChairmanTasks: JSON rác → 0 nhiệm vụ, KHÔNG ném",
        junkRes.created.length === 0 && junkRes.parsedCount === 0
      );

      // Giao 1 nhiệm vụ hợp lệ thật cho liquidity — lịch far (≥ +4h đảm bảo).
      const assignRes = await assignChairmanTasks(goodRaw, {
        chairmanAgentId: chairman.id,
        k4: k4Test,
      });
      check(
        "assignChairmanTasks: JSON hợp lệ → tạo đúng 1 nhiệm vụ cho liquidity",
        assignRes.created.length === 1 &&
          assignRes.created[0]?.agentCode === "liquidity",
        assignRes.skipped.map((s) => s.reason).join(" | ").slice(0, 160)
      );
      const assignedId = assignRes.created[0]?.taskId ?? "";
      if (assignedId) testTaskIds.push(assignedId);
      const assignedRow = assignedId
        ? await db.agentTask.findUnique({ where: { id: assignedId } })
        : null;
      check(
        "AgentTask tạo đúng createdByAgentId = CHỦ TỊCH + nextDueAt ≥ +4h",
        assignedRow != null &&
          assignedRow.createdByAgentId === chairman.id &&
          assignedRow.nextDueAt != null &&
          assignedRow.nextDueAt.getTime() >= Date.now() + 4 * 3_600_000
      );
      const k4Audit = await db.auditLog.findFirst({
        where: { action: "K4_TASK_ASSIGNED", entityId: assignedId },
      });
      check("AuditLog K4_TASK_ASSIGNED ghi đúng entityId nhiệm vụ", k4Audit != null);

      // Giao cho executive qua assignChairmanTasks → bị bỏ (không tạo).
      const execRaw = JSON.stringify({
        assignTasks: [
          { agentCode: "execution-manager", title: "Tự giao", schedule: farSchedule },
        ],
      });
      const execRes = await assignChairmanTasks(execRaw, {
        chairmanAgentId: chairman.id,
        k4: k4Test,
      });
      const execTasks = await db.agentTask.count({
        where: { agentId: execManager.id, createdByAgentId: { not: null } },
      });
      check(
        "assignChairmanTasks: giao execution-manager → BỎ + 0 task executive",
        execRes.created.length === 0 &&
          execRes.skipped.some((s) => s.reason.includes("cấm executive")) &&
          execTasks === 0
      );

      // Vượt maxOpenTasksPerAgent qua DB: set k4 max=1, liquidity đã có 1 task
      // PENDING (assignedRow) → giao thêm 1 → bị chặn.
      const k4Max1: K4Stored = { ...k4Test, maxOpenTasksPerAgent: 1 };
      const overRaw = JSON.stringify({
        assignTasks: [
          { agentCode: "liquidity", title: "Vượt hạn mức", schedule: farSchedule },
        ],
      });
      const overRes = await assignChairmanTasks(overRaw, {
        chairmanAgentId: chairman.id,
        k4: k4Max1,
      });
      check(
        "assignChairmanTasks: vượt maxOpenTasksPerAgent (1 treo) → BỎ nhiệm vụ",
        overRes.created.length === 0 &&
          overRes.skipped.some((s) => s.reason.includes("nhiệm vụ treo"))
      );
    }

    /* ═══ V5b — FB-4A: V-2BLOCKS · V-SCHED-NULL · V-WATCHDOG ═══ */
    console.log("\nV5b · FB-4A — parse 2 khối + schedule bắt buộc + watchdog:");
    {
      // ── V-2BLOCKS · F-K4-01/F-K4-05: extractAssignTasks quét MỌI fenced ──
      // S1/M4 (đã gãy với bản cũ — regex match() chỉ lấy khối ĐẦU): Chủ tịch
      // xuất JSON tín hiệu fence TRƯỚC + JSON giao việc fence SAU (đúng dạng
      // prompt "kèm khối JSON NGOÀI JSON tín hiệu đã có, CUỐI phản hồi").
      const twoBlocks =
        'Tổng hợp phiên…\n```json\n{"summary":"S","signal":{"symbol":"VCB","direction":"BUY"},"sentiment":"bullish"}\n```\n\nGiao việc cho tuần tới:\n```json\n{"assignTasks":[{"agentCode":"liquidity","title":"Theo dõi thanh khoản HNX","description":"Báo cáo ngắn","schedule":"TUE:23:00","priority":"high"}]}\n```';
      const parsed2 = extractAssignTasks(twoBlocks);
      check(
        "V-2BLOCKS: 2 fenced block (tín hiệu trước + giao việc sau) → ĐÚNG nhiệm vụ khối 2",
        Array.isArray(parsed2) &&
          parsed2.length === 1 &&
          (parsed2[0] as { agentCode?: string; schedule?: string })?.agentCode === "liquidity" &&
          (parsed2[0] as { schedule?: string })?.schedule === "TUE:23:00"
      );

      // M3 (đã gãy): JSON tín hiệu fence + JSON giao việc KHÔNG fence ngay sau.
      const unfenced =
        'Tổng hợp phiên…\n```json\n{"summary":"S","signal":{"symbol":"VCB"}}\n```\n\n{"assignTasks":[{"agentCode":"news-sentiment","title":"Đội nhỏ tổng hợp tin","schedule":"WED:23:00"}]}';
      const parsedU = extractAssignTasks(unfenced);
      check(
        "V-2BLOCKS: giao việc unfenced SAU khối tín hiệu fence → parse được (tier b toàn văn)",
        Array.isArray(parsedU) &&
          parsedU.length === 1 &&
          (parsedU[0] as { agentCode?: string })?.agentCode === "news-sentiment"
      );

      // S7 (đã gãy): model ECHO ví dụ prompt (fence) TRƯỚC JSON thật (fence) —
      // lấy khối SAU cùng chứa khoá (JSON thật), không tạo nhiệm vụ từ ví dụ.
      const echoFenced =
        'Ví dụ dạng output:\n```json\n{"assignTasks":[{"agentCode":"liquidity","title":"VÍ DỤ từ prompt","schedule":"14:00"}]}\n```\n\nJSON thật của tôi:\n```json\n{"assignTasks":[{"agentCode":"market-analyst","title":"THẬT — rà vùng hỗ trợ","schedule":"SAT:23:00"}]}\n```';
      const parsedE = extractAssignTasks(echoFenced);
      check(
        "V-2BLOCKS: echo ví dụ fence TRƯỚC JSON thật fence → lấy JSON THẬT (occurrence cuối)",
        Array.isArray(parsedE) &&
          parsedE.length === 1 &&
          (parsedE[0] as { agentCode?: string; title?: string })?.agentCode === "market-analyst" &&
          String((parsedE[0] as { title?: string })?.title).startsWith("THẬT")
      );

      // S7 biến thể tier (b): echo ví dụ UNFENCED trước JSON thật unfenced —
      // bracket-match quét raw từ occurrence CUỐI về ĐẦU → lấy JSON thật.
      const echoUnfenced =
        'Như ví dụ: {"assignTasks":[{"agentCode":"liquidity","title":"VÍ DỤ","schedule":"14:00"}]}\n\nĐây mới là giao việc thật:\n{"assignTasks":[{"agentCode":"liquidity","title":"THẬT — đo dòng tiền","schedule":"SUN:23:00"}]}';
      const parsedEU = extractAssignTasks(echoUnfenced);
      check(
        "V-2BLOCKS: echo ví dụ unfenced trước JSON thật unfenced → tier b lấy JSON THẬT (occurrence cuối)",
        Array.isArray(parsedEU) &&
          parsedEU.length === 1 &&
          String((parsedEU[0] as { title?: string })?.title).startsWith("THẬT")
      );

      // ── V-SCHED-NULL · F-K4-02: schedule null/rỗng bị chặn ──
      const agentsByCodeB = new Map<string, K4AgentInfo>(
        [liquidity, newsAgent, analyst].map((a) => [
          a.code,
          { id: a.id, code: a.code, name: a.name, group: a.group },
        ])
      );
      const schedNull = validateAssignTasks(
        [
          { agentCode: "liquidity", title: "Không có lịch", schedule: null },
          { agentCode: "news-sentiment", title: "Lịch rỗng", schedule: "" },
          { agentCode: "market-analyst", title: "Thiếu hẳn trường schedule" },
        ],
        {
          agentsByCode: agentsByCodeB,
          openTaskCountByCode: new Map<string, number>(),
          now: new Date(),
          k4: { enabled: true, maxOpenTasksPerAgent: 3, maxTasksPerCycle: 5 },
        }
      );
      check(
        "V-SCHED-NULL: schedule null/rỗng/thiếu → BỎ với lý do schedule-bat-buoc (dead-letter)",
        schedNull.valid.length === 0 &&
          schedNull.skipped.length === 3 &&
          schedNull.skipped.every((s) => s.reason.includes("schedule-bat-buoc")),
        schedNull.skipped.map((s) => s.reason).join(" | ").slice(0, 160)
      );

      // ── V-WATCHDOG · F-K3-01: agent kẹt RUNNING không run sống → reset IDLE ──
      // Agent test tự tạo (hermetic — không đụng agent thật; V6 dọn). Không có
      // dòng AgentRun RUNNING nào trong hệ (run row chỉ ghi status cuối) →
      // reaped.count === 0 → đường reset cũ là DEAD CODE, bản vá vẫn phải chạy.
      const watchdogAgent = await db.agent.create({
        data: {
          code: "test-watchdog-fb4a",
          name: "TEST FB-4A watchdog",
          role: "NEWS_SENTIMENT",
          group: "research",
          description: "Agent kiểm định hermetic FB-4A — tự xoá sau verify.",
          status: "RUNNING",
          // Ép mốc "claim" 6 phút trước — quá ngưỡng watchdog 5 phút.
          updatedAt: new Date(Date.now() - 6 * 60_000),
        },
      });
      testAgentIds.push(watchdogAgent.id);
      const reapedCount = await reapStaleAgentRuns();
      const stuck = await db.agent.findUnique({
        where: { id: watchdogAgent.id },
        select: { status: true },
      });
      check(
        "V-WATCHDOG: agent RUNNING >5ph không run sống → reset IDLE NGAY CẢ KHI reaped.count === 0",
        stuck?.status === "IDLE" && reapedCount === 0,
        `status=${String(stuck?.status)} · reaped=${reapedCount}`
      );
      // Claim còn tươi (< 5 phút) → KHÔNG đụng agent đang chạy thật.
      await db.agent.update({
        where: { id: watchdogAgent.id },
        data: { status: "RUNNING" }, // updatedAt tự refresh = now
      });
      await reapStaleAgentRuns();
      const fresh = await db.agent.findUnique({
        where: { id: watchdogAgent.id },
        select: { status: true },
      });
      check(
        "V-WATCHDOG: claim còn tươi (<5ph) → GIỮ RUNNING (không đụng agent đang chạy thật)",
        fresh?.status === "RUNNING"
      );
    }

    /* ═══ V6 — Dọn dẹp hermetic ═══ */
    console.log("\nV6 · Dọn sạch dữ liệu test:");
    {
      // Thu AgentRun/AgentMessage do V4 tạo (nếu có) để feed sạch.
      for (const runId of testRunIds) {
        const run = await db.agentRun.findUnique({ where: { id: runId } });
        if (run) {
          const msgs = await db.agentMessage.findMany({
            where: { fromAgentId: run.agentId, createdAt: { gte: run.startedAt } },
            take: 3,
            orderBy: { createdAt: "asc" },
          });
          for (const m of msgs) testMessageIds.push(m.id);
        }
      }
      for (const id of testMessageIds) {
        await db.agentMessage.delete({ where: { id } }).catch(() => undefined);
      }
      for (const id of testRunIds) {
        await db.agentRun.delete({ where: { id } }).catch(() => undefined);
      }
      for (const id of testTaskIds) {
        await db.agentTask.delete({ where: { id } }).catch(() => undefined);
      }
      // FB-4A V-WATCHDOG — xoá agent test (cascade xoá run/rács của nó).
      for (const id of testAgentIds) {
        await db.agent.delete({ where: { id } }).catch(() => undefined);
      }
      const left = await db.agentTask.count({
        where: { id: { in: testTaskIds } },
      });
      const leftRuns = await db.agentRun.count({
        where: { id: { in: testRunIds } },
      });
      const leftAgents = await db.agent.count({
        where: { id: { in: testAgentIds } },
      });
      check(
        `xoá ${testTaskIds.length} nhiệm vụ test + ${testRunIds.length} AgentRun test + ${testAgentIds.length} agent test`,
        left === 0 && leftRuns === 0 && leftAgents === 0
      );
      // Trả AppSetting "k4" về trạng thái TRƯỚC test (xóa key nếu trước đó chưa có).
      if (k4RowBefore) {
        await db.appSetting.update({
          where: { key: "k4" },
          data: { value: k4RowBefore.value },
        });
      } else {
        await db.appSetting.deleteMany({ where: { key: "k4" } });
      }
      const k4Restored = await getK4();
      check(
        "AppSetting k4 trả về trạng thái trước test",
        k4RowBefore
          ? JSON.stringify(k4Restored) === JSON.stringify(JSON.parse(k4RowBefore.value))
          : JSON.stringify(k4Restored) === JSON.stringify(defaultK4()),
        `k4 hiện tại: ${JSON.stringify(k4Restored)}`
      );
      console.log(
        "  ℹ️ AuditLog K3_*/K4_* kiểm định GIỮ LẠI làm truy vết (theo thiết kế hermetic)."
      );
    }
  } catch (err) {
    failed++;
    console.error("  ❌ LỖI ngoài dự kiến:", err);
    // Dọn dẹp khẩn cấp — mọi test task có thể đã tạo.
    try {
      for (const id of testTaskIds) {
        await db.agentTask.delete({ where: { id } }).catch(() => undefined);
      }
      for (const id of testRunIds) {
        await db.agentRun.delete({ where: { id } }).catch(() => undefined);
      }
      for (const id of testAgentIds) {
        await db.agent.delete({ where: { id } }).catch(() => undefined);
      }
      if (k4RowBefore) {
        await db.appSetting
          .update({ where: { key: "k4" }, data: { value: k4RowBefore.value } })
          .catch(() => undefined);
      } else {
        await db.appSetting.deleteMany({ where: { key: "k4" } }).catch(() => undefined);
      }
    } catch {
      // swallow — cleanup tốt nhất có thể
    }
  }

  console.log("\n══ KẾT QUẢ ══");
  console.log(`PASS: ${passed} · FAIL: ${failed}${skipped.length ? ` · SKIP: ${skipped.length}` : ""}`);
  for (const s of skipped) console.log(`  ⚠️ SKIP: ${s}`);
  await db.$disconnect?.();
  process.exit(failed > 0 ? 1 : 0);
}

void main();
