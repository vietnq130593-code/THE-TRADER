/** (Task 144 P2-a) — tách từ src/app/api/agents/run/route.ts (pure move)
 *  Cổng cooldown chu kỳ + sơ đồ đợt 24 agents + pre-cycle (reap → load →
 *  guards → expire signals → k-run mark → k4 → claim RUNNING). */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { AgentStatus } from "@prisma/client";
import { reapStaleAgentRuns } from "@/lib/agent-ratelimit";
import { expireDueSignals } from "@/lib/signal-execution";
// K2 (#86 — AUTONOMY_BLUEPRINT v1.1 §4.1): ghi mốc chu kỳ cho due-check engine.
import { markKRunCycle } from "@/lib/k-run";
// K4 (#94 — AUTONOMY_BLUEPRINT v1.1 §7): Ban Điều hành giao việc — Chủ tịch
// xuất JSON assignTasks trong chu kỳ (chỉ khi k4.enabled), validate fail-soft.
import { getK4, type K4Stored } from "@/lib/k4";
import { AGENT_ROSTER } from "@/lib/agent-roster";

/** F-203 (audit 19-b): rate-limit chu kỳ — chống spam chi phí LLM không giới hạn. */
const CYCLE_COOLDOWN_MS = 60_000;
let lastCycleStartedAt = 0;

// ── Sơ đồ đợt (tất cả code đều nằm trong AGENT_ROSTER 24 agents) ──
// Đợt A chia 3 nhịp con (§3.3 — #57): WAVE_A_BEAT1 ∥ → A9 → S1 (đọc verdict)
export const WAVE_A_CODES = ["data-collector", "notification-officer", "feature-store", "data-integrity"] as const;
export const WAVE_B_SERVICE_CODES = [
  "ml-forecast", "backtest", "learning-rag", "rl-gym",
  "rl-policy", "dl-trainer", "rl-trainer", "model-registry",
] as const;
export const WAVE_B_LLM_CODES = ["market-analyst", "fair-value", "news-sentiment", "liquidity", "macro-economist"] as const;
export const WAVE_C_LLM_CODES = ["risk-manager"] as const;
export const WAVE_C_SERVICE_CODES = ["exposure", "compliance"] as const;
export const CHAIRMAN_CODE = "portfolio-strategist";
export const WAVE_E_SERVICE_CODES = ["settlement", "cash-management"] as const;
export const EXECUTOR_CODE = "execution-manager";
export const ALL_CODES = AGENT_ROSTER.map((a) => a.code);

/** Một dòng Agent của chu kỳ (select tường minh ở pre-cycle). */
export interface CycleAgentRow {
  id: string;
  code: string;
  config: string;
  healthScore: number;
  status: AgentStatus;
}

/**
 * F-203 + F-1091-02 (fixbug api #109 — P1): check cooldown RỒI claim ĐỒNG BỘ
 * ngay sau check. Pattern cũ (check → 2+ await reap/findMany → set ở dưới)
 * để cửa sổ TOCTOU: engine tick + click tay cùng lúc đều qua check rồi chạy
 * chu kép (2× chi phí LLM + trùng Signal/AgentMessage/AgentRun). Không còn
 * await nào giữa check và claim → yêu cầu concurrent thứ 2 dính 429 ngay.
 * Thất bại validate sớm / lỗi DB TRƯỚC khi chu kỳ thật sự chạy → caller TRẢ
 * LẠI mốc cũ qua restoreCycleCooldown (giữ nguyên nghĩa AUD-CODE #10: fail
 * sớm không bắt user chờ 60s).
 */
export type CycleCooldownGate =
  | { allowed: false; sinceLastSeconds: number; retryAfterSeconds: number }
  | { allowed: true; prevCycleStartedAt: number };

export function checkAndClaimCycleCooldown(): CycleCooldownGate {
  const now = Date.now();
  const sinceLast = now - lastCycleStartedAt;
  if (sinceLast < CYCLE_COOLDOWN_MS) {
    return {
      allowed: false,
      sinceLastSeconds: Math.floor(sinceLast / 1000),
      retryAfterSeconds: Math.ceil((CYCLE_COOLDOWN_MS - sinceLast) / 1000),
    };
  }
  const prevCycleStartedAt = lastCycleStartedAt;
  lastCycleStartedAt = now;
  return { allowed: true, prevCycleStartedAt };
}

/** AUD-CODE #10 / F-1091-02: trả lại mốc cũ khi fail sớm ở pre-cycle. */
export function restoreCycleCooldown(prevCycleStartedAt: number): void {
  lastCycleStartedAt = prevCycleStartedAt;
}

export type PrepareCycleResult =
  | { ok: false; response: NextResponse }
  | { ok: true; agents: CycleAgentRow[]; byCode: Map<string, CycleAgentRow>; k4: K4Stored };

/**
 * F-1091-03 (fixbug api #109): đoạn pre-cycle (reap/findMany/updateMany)
 * trước đây nằm NGOÀI try/catch — lỗi DB lúc này cho 500 non-JSON mặc định
 * của Next.js, lệch shape { error } JSON mọi route khác trả. Giờ gói trong
 * prepareCycle: mọi đường fail trả về { ok: false, response } JSON đúng shape
 * (agents/byCode/k4 trả về qua PrepareCycleResult cho thân chu kỳ dùng tiếp).
 */
export async function prepareCycle(): Promise<PrepareCycleResult> {
  try {
    // AUD-CODE #5 + #3: watchdog dọn run/agent kẹt RUNNING (> 5 phút) TRƯỚC khi
    // load — agent kẹt do crash cũ không được phép chặn chu kỳ vĩnh viễn
    await reapStaleAgentRuns();

    // ── Load toàn bộ 24 agents ───────────────────────────────
    const agents: CycleAgentRow[] = await db.agent.findMany({
      where: { code: { in: ALL_CODES } },
      select: { id: true, code: true, config: true, healthScore: true, status: true },
    });
    const byCode = new Map<string, CycleAgentRow>(agents.map((a) => [a.code, a]));
    const missing = ALL_CODES.filter((c) => !byCode.get(c));
    if (missing.length > 0) {
      // AUD-CODE #10: KHÔNG set cooldown khi fail sớm ở bước validate —
      // user không phải chờ 60s vô ích vì lỗi cấu hình (thiếu agent)
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: `Thiếu agent trong hệ thống: ${missing.join(", ")}. Chạy "bun prisma/expand-agents.ts" để đồng bộ roster 24 agents.`,
          },
          { status: 404 }
        ),
      };
    }

    // AUD-CODE #3: guard chồng lấn — chu kỳ không đè lên single-run đang chạy
    // (status đã load SAU khi watchdog dọn nên không có giả âm/ giả dương)
    const runningAgents = agents.filter((a) => a.status === "RUNNING");
    if (runningAgents.length > 0) {
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: `Có ${runningAgents.length} agent đang chạy lẻ (${runningAgents
              .map((a) => a.code)
              .slice(0, 3)
              .join(", ")}…). Chờ hoàn tất hoặc thử lại sau — tránh chạy chồng lẫn tốn 2× chi phí LLM.`,
            retryAfterSeconds: 60,
          },
          { status: 409, headers: { "Retry-After": "60" } }
        ),
      };
    }

    // AUD-CODE #1 (P1): sweep tín hiệu hết hạn trước mỗi chu kỳ — prompt Chủ tịch
    // và notification-officer chỉ thấy tín hiệu còn hạn
    await expireDueSignals();

    // (cooldown đã claim đồng bộ ngay sau check — F-1091-02)

    // K2 (#86 — AUTONOMY_BLUEPRINT v1.1 §4.1): k-run tồn tại → ghi mốc chu kỳ MỖI
    // lần chạy (kể cả tay) làm gốc nextCycleAt của engine. AWAIT (không void):
    // đóng window ~100ms giữa lúc response về client và DB ghi xong — nếu engine
    // tick 60s trúng window đó sẽ đọc lastCycleAt cũ → nextCycleAt quá khứ → bắn
    // chu kỳ kép (chặn được bởi cooldown 60s nhưng vẫn 1 POST thừa). markKRunCycle
    // fail-soft tuyệt đối bên trong (lỗi DB chỉ console.error); key chưa từng
    // tạo → no-op — env AGENT_CYCLE_MINUTES fallback nguyên vẹn.
    await markKRunCycle();

    // K4 (#94 — AUTONOMY_BLUEPRINT §7.1): đọc cấu hình k4 MỘT LẦN đầu chu kỳ —
    // enabled → tiêm khối GIAO VIỆC vào prompt Chủ tịch (sau RAG block) + parse
    // assignTasks sau khi Chủ tịch chạy xong. getK4 fail-soft (mặc định tắt).
    const k4 = await getK4();

    // Mark every agent RUNNING while the cycle executes
    // AUDIT 137 A8 — khe TOCTOU giữa guard 409 (đọc status lúc findMany) và
    // claim RUNNING: 3 await xen giữa (expireDueSignals/markKRunCycle/getK4)
    // cho phép single-run claim agent X IDLE → updateMany VÔ ĐIỀU KIỆN dưới
    // đây đè RUNNING và chạy X kép (2 AgentRun + 2 tin broadcast). Claim có
    // điều kiện status != RUNNING + đối chiếu count → phát hiện đua thật.
    const claimed = await db.agent.updateMany({
      where: { id: { in: agents.map((a) => a.id) }, status: { not: "RUNNING" } },
      data: { status: "RUNNING" },
    });
    if (claimed.count !== agents.length) {
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: "Có agent vừa được lệnh chạy riêng claim giữa lúc chu kỳ khởi động — hủy chu kỳ này để tránh chạy chồng, thử lại sau.",
            retryAfterSeconds: 60,
          },
          { status: 409, headers: { "Retry-After": "60" } }
        ),
      };
    }

    return { ok: true, agents, byCode, k4 };
  } catch (err) {
    console.error("[api/agents/run:pre-cycle]", err);
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Không khởi động được chu kỳ agent — xem log server." },
        { status: 500 }
      ),
    };
  }
}
