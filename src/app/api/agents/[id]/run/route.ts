import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";
import { updateAgentHealth } from "@/lib/health";
import { buildSingleRunPrompt } from "@/lib/agent-context";
import {
  parseAllocationProposal,
  formatAllocationForMessage,
  bumpAllocationParseFail,
} from "@/lib/exec/allocation";
import { checkAgentRateLimit, releaseStuckRunningAgents } from "@/lib/agent-ratelimit";
import { ROSTER_BY_CODE } from "@/lib/agent-roster";
import { runServiceAgent } from "@/lib/agent-service-runs";
// K3 (#94 — AUTONOMY_BLUEPRINT v1.1 §6.2): nhiệm vụ định kỳ — nextDueAt tính
// lại theo parser chung sau mỗi run; kill-switch 5 lỗi liên tiếp → paused.
import { computeNextDueAt } from "@/lib/schedule";
import {
  callLlmWithRetry,
  estimateTokens,
  llmCostUsd,
} from "@/lib/llm";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/agents/[id]/run — chạy riêng 1 agent (PHASE3_BLUEPRINT §4.3,
 * mở rộng 23 agents).
 *
 * Luồng: guard 404/409/400 → rate-limit 60s (DB là nguồn chân lý) →
 *  - agent LLM (6): buildSingleRunPrompt(code) → LLM (Opencode Zen
 *    space-bunny-free khi có key, GLM-4.6 trong sandbox) → parse JSON theo vai
 *  - agent service (17): runServiceAgent(code) — deterministic từ DB,
 *    0 chi phí LLM, ~0.2–1.5s
 * → AgentRun + AgentMessage (broadcast) + health + audit AGENT_RUN_COMPLETED
 * (mode "single"). Lỗi → persistRun FAILED + 502 (pattern run route).
 *
 * K3 (#94 — AUTONOMY_BLUEPRINT §6.2): body thêm {taskId} — chạy agent THEO
 * một nhiệm vụ (engine due-check hoặc nút "Chạy ngay"): nạp AgentTask (thuộc
 * agent này, 404 nếu lệch) · tiêm khối "NHIỆM VỤ ĐỊNH KỲ: title\ndescription"
 * vào user-prompt · AgentRun ghi taskId · kết thúc → cập nhật AgentTask
 * (runCount/failStreak/result/nextDueAt, kill-switch 5 lỗi) — fail-soft.
 */

/** Robustly extract the first JSON object from an LLM response. */
function parseJsonBlock<T extends Record<string, unknown>>(raw: string): Partial<T> | null {
  const text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const brace = candidate.match(/\{[\s\S]*\}/);
  if (!brace) return null;
  try {
    return JSON.parse(brace[0]) as Partial<T>;
  } catch {
    return null;
  }
}

/** Persist an agent run + restore agent status + update health (persistRun-style).
 *  K3 (#94): taskId — liên kết AgentRun với AgentTask định kỳ đã sinh ra run. */
async function persistRun(
  agentId: string,
  success: boolean,
  startedAt: number,
  tokensIn: number,
  tokensOut: number,
  output: string | null,
  error: string | null,
  taskId?: string | null
): Promise<{ id: string; durationMs: number; costUsd: number }> {
  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt;
  const costUsd = llmCostUsd(tokensIn, tokensOut);
  const run = await db.agentRun.create({
    data: {
      agentId,
      taskStatus: success ? "COMPLETED" : "FAILED",
      startedAt: new Date(startedAt),
      finishedAt,
      durationMs,
      tokensIn,
      tokensOut,
      costUsd,
      output,
      error,
      ...(taskId ? { taskId } : {}),
    },
  });
  await db.agent.update({
    where: { id: agentId },
    data: { status: success ? "IDLE" : "ERROR", lastRunAt: finishedAt },
  });
  await updateAgentHealth(agentId, success, durationMs, run.id); // F-113: loại run vừa tạo khỏi P50
  return { id: run.id, durationMs, costUsd };
}

/* ═══ K3 (#94 — AUTONOMY_BLUEPRINT v1.1 §6.2): cập nhật AgentTask sau run ═══ */

/** Dữ liệu tối thiểu của AgentTask cần cho update sau run. */
interface TaskForUpdate {
  id: string;
  title: string;
  schedule: string | null;
  failStreak: number;
  agentName: string;
}

/** Ngưỡng kill-switch: 5 lỗi liên tiếp → tự tạm dừng + RiskAlert (§6.1). */
const K3_FAIL_STREAK_LIMIT = 5;

/** Snippet kết quả nhiệm vụ — output mới nhất, tối đa 4000 ký tự (§6.2). */
function taskResultSnippet(output: string | null): string | null {
  if (!output) return null;
  return output.length > 4000 ? `${output.slice(0, 4000)}…` : output;
}

/**
 * Cập nhật AgentTask khi run liên kết kết thúc (fail-soft TUYỆT ĐỐI — lỗi DB
 * chỉ console.error, KHÔNG chặn AgentRun đã chạy xong):
 *  - COMPLETED: lastRunAt=now · runCount++ · failStreak=0 · result=snippet ≤4000
 *    · nextDueAt=computeNextDueAt(schedule) khi có lịch (slot đã tiêu thụ)
 *    · status: định kỳ GIỮ PENDING (chạy lại theo lịch) / nhiệm vụ tay →
 *    COMPLETED + completedAt (semantics cũ).
 *  - FAILED: failStreak++ · nextDueAt vẫn dịch theo lịch (slot đã tiêu thụ)
 *    · status: định kỳ GIỮ PENDING / nhiệm vụ tay → FAILED
 *    · failStreak ≥ 5 → paused=true + RiskAlert WARNING K3_TASK_AUTOPAUSED
 *    (message tiếng Việt nêu tên agent + nhiệm vụ) + AuditLog K3_TASK_AUTOPAUSED.
 */
async function updateTaskAfterRun(
  task: TaskForUpdate,
  success: boolean,
  output: string | null
): Promise<void> {
  try {
    const now = new Date();
    const nextDueAt = task.schedule
      ? computeNextDueAt(task.schedule, now)
      : null;
    const data: Record<string, unknown> = {
      lastRunAt: now,
      runCount: { increment: 1 },
      failStreak: success ? 0 : { increment: 1 },
      ...(task.schedule ? { nextDueAt } : {}),
      // Nhiệm vụ tay (schedule null): một lần — COMPLETED/FAILED như semantics cũ;
      // định kỳ: GIỮ PENDING để engine due-check tiếp nhịp sau.
      ...(task.schedule
        ? {}
        : {
            status: success ? "COMPLETED" : "FAILED",
            completedAt: success ? now : null,
          }),
    };
    if (success && output) {
      data.result = taskResultSnippet(output);
    }
    // Kill-switch nhiệm vụ (§6.1): 5 lỗi liên tiếp → tự tạm dừng.
    const newStreak = success ? 0 : task.failStreak + 1;
    if (!success && newStreak >= K3_FAIL_STREAK_LIMIT) {
      data.paused = true;
    }
    await db.agentTask.update({ where: { id: task.id }, data });

    if (!success && newStreak >= K3_FAIL_STREAK_LIMIT) {
      await db.riskAlert
        .create({
          data: {
            severity: "WARNING",
            code: "K3_TASK_AUTOPAUSED",
            message: `Nhiệm vụ định kỳ "${task.title}" của agent ${task.agentName} tự tạm dừng sau ${K3_FAIL_STREAK_LIMIT} lần chạy lỗi liên tiếp — kiểm tra lại lịch hoặc nội dung nhiệm vụ rồi bật lại trong tab Nhiệm vụ.`,
            metricKey: "agent_task.fail_streak",
            metricValue: newStreak,
            threshold: K3_FAIL_STREAK_LIMIT,
          },
        })
        .catch((err) => console.error("[api/agents/[id]/run] RiskAlert K3_TASK_AUTOPAUSED:", err));
      await db.auditLog
        .create({
          data: {
            action: "K3_TASK_AUTOPAUSED",
            entity: "AgentTask",
            entityId: task.id,
            after: JSON.stringify({
              title: task.title,
              agentName: task.agentName,
              failStreak: newStreak,
            }),
          },
        })
        .catch((err) => console.error("[api/agents/[id]/run] audit K3_TASK_AUTOPAUSED:", err));
      console.error(
        `[api/agents/[id]/run] K3 kill-switch: nhiệm vụ "${task.title}" (${task.agentName}) tự tạm dừng sau ${newStreak} lỗi liên tiếp`
      );
    }
  } catch (err) {
    // fail-soft — nhiệm vụ có thể đã bị trader xoá giữa chừng (P2025) v.v.
    console.error("[api/agents/[id]/run] updateTaskAfterRun fail-soft:", err);
  }
}

/** Khối prompt nhiệm vụ — tiêm vào user-prompt theo cơ chế context sẵn có.
 *  COSMETIC-1 (FB-4A): nhãn theo loại nhiệm vụ — có lịch là "NHIỆM VỤ ĐỊNH
 *  KỲ", nhiệm vụ tay một lần (schedule null) chỉ "NHIỆM VỤ". */
function buildTaskPromptBlock(
  title: string,
  description: string | null,
  schedule: string | null
): string {
  const lines = [
    `${schedule ? "NHIỆM VỤ ĐỊNH KỲ" : "NHIỆM VỤ"}: ${title}`,
    description ?? "(không có mô tả thêm)",
  ];
  if (schedule) {
    lines.push("(Nhiệm vụ định kỳ — trả lời đúng trọng tâm nhiệm vụ trên.)");
  }
  return lines.join("\n");
}

interface ParsedAgentOutput {
  content: string;
  reasoning: string;
  sentiment: "bullish" | "bearish" | "neutral" | null;
  /** F-73A-03: khối phân bổ đã định dạng (narrative + bảng) khi hợp lệ. */
  allocationText?: string;
  /** F-73A-03: LLM CÓ trả allocation nhưng parse fail — caller bump drift metric. */
  allocationParseFailed?: boolean;
}

/** Parse JSON theo vai (giống run route): analyst {content,reasoning,sentiment}; strategist {summary,recommendation,confidence}. */
function parseAgentOutput(code: string, raw: string): ParsedAgentOutput {
  if (code === "portfolio-strategist") {
    const parsed = parseJsonBlock<{
      summary: unknown;
      recommendation: unknown;
      confidence: unknown;
      allocation: unknown; // F-73A-03: khối phân bổ như run route chu kỳ
    }>(raw);
    // Parse fail → fallback dùng raw text làm content (như run route)
    const summaryContent =
      typeof parsed?.summary === "string" && parsed.summary.trim()
        ? parsed.summary.trim()
        : raw.trim();
    const reasoning =
      typeof parsed?.recommendation === "string" ? parsed.recommendation.trim() : "";
    const confidenceRaw =
      typeof parsed?.confidence === "string" ? parsed.confidence.toUpperCase() : "MEDIUM";
    const sentiment =
      confidenceRaw === "HIGH" ? "bullish" : confidenceRaw === "LOW" ? "neutral" : "neutral";
    // F-73A-03: parse khối allocation như chu kỳ (run route) — không nuốt im lặng.
    let allocationText: string | undefined;
    let allocationParseFailed: boolean | undefined;
    try {
      const alloc = parseAllocationProposal(parsed?.allocation);
      if (alloc != null) {
        allocationText = formatAllocationForMessage(alloc);
      } else if (parsed?.allocation != null) {
        allocationParseFailed = true;
      }
    } catch {
      // fail-soft — không sập single-run
    }
    const content = allocationText ? `${summaryContent}\n\n${allocationText}` : summaryContent;
    return {
      content,
      reasoning,
      sentiment,
      ...(allocationText ? { allocationText } : {}),
      ...(allocationParseFailed ? { allocationParseFailed } : {}),
    };
  }
  const parsed = parseJsonBlock<{
    content: unknown;
    reasoning: unknown;
    sentiment: unknown;
  }>(raw);
  const content =
    typeof parsed?.content === "string" && parsed.content.trim()
      ? parsed.content.trim()
      : raw.trim();
  const reasoning =
    typeof parsed?.reasoning === "string" ? parsed.reasoning.trim() : "";
  const sentimentRaw =
    typeof parsed?.sentiment === "string" ? parsed.sentiment.toLowerCase() : "";
  const sentiment: ParsedAgentOutput["sentiment"] =
    sentimentRaw === "bullish" || sentimentRaw === "bearish" || sentimentRaw === "neutral"
      ? (sentimentRaw as ParsedAgentOutput["sentiment"])
      : null;
  return { content, reasoning, sentiment };
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Body {} hoặc { note?: string, taskId?: string } — chấp nhận body rỗng.
    // K3 (#94): taskId — chạy agent THEO một nhiệm vụ (engine due-check hoặc
    // nút "Chạy ngay" trong tab Nhiệm vụ).
    const body = (await req.json().catch(() => ({}))) as {
      note?: unknown;
      taskId?: unknown;
    };
    const note = typeof body.note === "string" ? body.note.trim() : "";
    if (note.length > 500) {
      return NextResponse.json(
        { error: "Ghi chú quá dài (tối đa 500 ký tự)." },
        { status: 400 }
      );
    }
    if (body.taskId !== undefined && typeof body.taskId !== "string") {
      return NextResponse.json(
        { error: "taskId phải là chuỗi id nhiệm vụ." },
        { status: 400 }
      );
    }

    const agent = await db.agent.findUnique({ where: { id } });
    if (!agent) {
      return NextResponse.json(
        { error: "Không tìm thấy agent." },
        { status: 404 }
      );
    }
    // Execution Manager cần Signal đầu vào — chỉ chạy trong chu kỳ đầy đủ
    if (agent.code === "execution-manager") {
      return NextResponse.json(
        {
          error:
            "Execution Manager chỉ chạy trong chu kỳ orchestrator đầy đủ (vì cần Signal đầu vào).",
        },
        { status: 409 }
      );
    }
    if (agent.status === "RUNNING") {
      // F-K3-01: thử watchdog MỘT NGUỒN (agent-ratelimit.ts) TRƯỚC khi chặn —
      // agent kẹt RUNNING do crash/reload giữa run (không có run sống, quá 5
      // phút từ lúc claim) được reset IDLE rồi chạy tiếp; agent đang chạy THẬT
      // (claim còn tươi) vẫn 400 như cũ.
      const freed = await releaseStuckRunningAgents(agent.id);
      if (freed === 0) {
        return NextResponse.json(
          { error: "Agent đang chạy một tác vụ khác." },
          { status: 400 }
        );
      }
    }

    // ── K3 (#94 §6.2): nạp nhiệm vụ khi có taskId — phải thuộc agent này ──
    const task = body.taskId
      ? await db.agentTask.findUnique({ where: { id: body.taskId } })
      : null;
    if (body.taskId && (!task || task.agentId !== agent.id)) {
      return NextResponse.json(
        { error: "Không tìm thấy nhiệm vụ của agent này." },
        { status: 404 }
      );
    }

    // Rate-limit 60s — DB là nguồn chân lý (PHASE3_BLUEPRINT §4.3)
    // (kiểm tra TRƯỚC khi claim RUNNING — nếu 429 thì không đổi trạng thái)
    const rate = await checkAgentRateLimit(agent.id);
    if (!rate.ok) {
      return NextResponse.json(
        {
          error: `Agent vừa chạy cách đây ${60 - rate.retryAfterSeconds}s. Vui lòng đợi thêm để tránh tốn chi phí LLM.`,
          retryAfterSeconds: rate.retryAfterSeconds,
        },
        {
          status: 429,
          headers: { "Retry-After": String(rate.retryAfterSeconds) },
        }
      );
    }

    // AUD-CODE #4 (TOCTOU single-run): đọc status rồi mới update RUNNING có thể
    // cho 2 request đồng thời cùng pass → chạy kép (2× LLM). Claim atomic:
    // updateMany có điều kiện status != RUNNING — chỉ 1 request thắng.
    const claimed = await db.agent.updateMany({
      where: { id: agent.id, status: { not: "RUNNING" } },
      data: { status: "RUNNING" },
    });
    if (claimed.count === 0) {
      return NextResponse.json(
        { error: "Agent đang chạy một tác vụ khác." },
        { status: 400 }
      );
    }

    // Đánh dấu RUNNING trong lúc chạy lẻ (đã claim atomic ở trên — giữ dòng
    // update này để chắc chắn đã ghi DB trong mọi nhánh)
    await db.agent.update({ where: { id: agent.id }, data: { status: "RUNNING" } });

    const startedAt = Date.now();

    // ── Service agent: chạy deterministic (mở rộng 23 agents — 0 LLM) ──
    const rosterEntry = ROSTER_BY_CODE.get(agent.code);
    if (rosterEntry?.kind === "service") {
      try {
        const result = await runServiceAgent(agent.code);
        const run = await persistRun(
          agent.id,
          true,
          startedAt,
          0,
          0,
          JSON.stringify({ mode: "single", ...result.output }),
          null,
          task?.id
        );
        // K3 (#94 §6.2): cập nhật AgentTask sau run (fail-soft) — service agent
        // cũng đếm runCount/dịch nextDueAt như LLM agent.
        if (task) {
          await updateTaskAfterRun(
            { id: task.id, title: task.title, schedule: task.schedule, failStreak: task.failStreak, agentName: agent.name },
            true,
            result.content
          );
        }
        const message = await db.agentMessage.create({
          data: {
            fromAgentId: agent.id,
            broadcast: true, // tin chạy riêng vẫn vào broadcast feed (§4.3)
            direction: "AGENT",
            content: result.content,
            reasoning: result.reasoning || null,
            sentiment: result.sentiment ?? null,
          },
        });
        await db.auditLog.create({
          data: {
            action: "AGENT_RUN_COMPLETED",
            entity: "Agent",
            entityId: agent.id,
            after: JSON.stringify({
              mode: "single",
              kind: "service",
              tokensIn: 0,
              tokensOut: 0,
              costUsd: 0,
              durationMs: run.durationMs,
              ...(task ? { taskId: task.id } : {}),
            }),
          },
        });
        return NextResponse.json(
          toPlain({
            agent: { id: agent.id, code: agent.code, name: agent.name },
            message: {
              id: message.id,
              content: message.content,
              reasoning: message.reasoning,
              sentiment: message.sentiment,
            },
            run: {
              id: run.id,
              tokensIn: 0,
              tokensOut: 0,
              costUsd: run.costUsd,
              durationMs: run.durationMs,
              taskStatus: "COMPLETED",
            },
            ...(task ? { task: { id: task.id, title: task.title } } : {}),
          })
        );
      } catch (err) {
        console.error("[api/agents/[id]/run] service agent failed:", err);
        const errorMessage =
          err instanceof Error ? err.message : "Dịch vụ agent lỗi.";
        await persistRun(
          agent.id,
          false,
          startedAt,
          0,
          0,
          null,
          errorMessage,
          task?.id
        ).catch(() => null);
        // K3: thất bại cũng cập nhật nhiệm vụ (failStreak++ / kill-switch) — fail-soft.
        if (task) {
          await updateTaskAfterRun(
            { id: task.id, title: task.title, schedule: task.schedule, failStreak: task.failStreak, agentName: agent.name },
            false,
            null
          );
        }
        return NextResponse.json(
          { error: `Agent dịch vụ lỗi: ${errorMessage}` },
          { status: 500 }
        );
      }
    }

    // ── LLM agent: prompt theo vai + ghi chú tuỳ chọn của trader ──
    // F-841-03/#84: giữ tham chiếu prompt THẬT đã gửi ra outer-scope — đường
    // catch dưới ước lượng token từ CHÍNH prompt này, KHÔNG gọi lại
    // buildSingleRunPrompt (sau #83 hàm đó có side-effect ghi RetrievalLog —
    // rebuild trên nhánh fail sẽ đếm kép + ghi usedInPrompt sai sự thật cho
    // block chưa bao giờ tới LLM nào).
    let sentPromptText: string | null = null;
    try {
      // Prompt theo vai (block chọn lọc như run route) + khối nhiệm vụ K3 (nếu
      // chạy theo nhiệm vụ) + ghi chú tuỳ chọn của trader — đúng cơ chế context
      // sẵn có (cùng chỗ tiêm GHI CHÚ, sau buildSingleRunPrompt).
      const { system, user } = await buildSingleRunPrompt(agent.code);
      const parts: string[] = [user];
      if (task) {
        parts.push(buildTaskPromptBlock(task.title, task.description, task.schedule));
      }
      if (note) {
        parts.push(`GHI CHÚ CỦA TRADER:\n${note}`);
      }
      const userPrompt = parts.join("\n\n");
      sentPromptText = `${system}\n\n${userPrompt}`;

      const { raw, tokensIn, tokensOut } = await callLlmWithRetry(system, userPrompt);

      const parsed = parseAgentOutput(agent.code, raw);
      const { content, reasoning, sentiment } = parsed;

      // F-73A-03: đếm parse-fail drift metric chung với chu kỳ (E-P2-1 sau).
      // Chỉ bump ở đây (parse chính sau LLM) — đường catch dưới ước lượng token
      // từ sentPromptText, không chạy LLM/parse/rebuild lại → no double-bump.
      if (parsed.allocationParseFailed) {
        await bumpAllocationParseFail().catch(() => undefined);
      }

      const run = await persistRun(
        agent.id,
        true,
        startedAt,
        tokensIn,
        tokensOut,
        JSON.stringify({ mode: "single", content, reasoning, sentiment }),
        null,
        task?.id
      );

      // K3 (#94 §6.2): cập nhật AgentTask sau run (fail-soft) — runCount+1,
      // failStreak=0, result=snippet, nextDueAt dịch theo lịch.
      if (task) {
        await updateTaskAfterRun(
          { id: task.id, title: task.title, schedule: task.schedule, failStreak: task.failStreak, agentName: agent.name },
          true,
          content
        );
      }

      const message = await db.agentMessage.create({
        data: {
          fromAgentId: agent.id,
          broadcast: true, // tin chạy riêng vẫn vào broadcast feed (§4.3)
          direction: "AGENT",
          content,
          reasoning: reasoning || null,
          sentiment: sentiment ?? null,
        },
      });

      // Audit — AGENT_RUN_COMPLETED mode "single" (§4.3)
      await db.auditLog.create({
        data: {
          action: "AGENT_RUN_COMPLETED",
          entity: "Agent",
          entityId: agent.id,
          after: JSON.stringify({
            mode: "single",
            tokensIn,
            tokensOut,
            costUsd: run.costUsd,
            durationMs: run.durationMs,
            ...(task ? { taskId: task.id } : {}),
          }),
        },
      });

      return NextResponse.json(
        toPlain({
          agent: { id: agent.id, code: agent.code, name: agent.name },
          message: {
            id: message.id,
            content: message.content,
            reasoning: message.reasoning,
            sentiment: message.sentiment,
          },
          run: {
            id: run.id,
            tokensIn,
            tokensOut,
            costUsd: run.costUsd,
            durationMs: run.durationMs,
            taskStatus: "COMPLETED",
          },
          ...(task ? { task: { id: task.id, title: task.title } } : {}),
        })
      );
    } catch (err) {
      // Lỗi LLM giữa chừng → persistRun FAILED + agent ERROR + audit + 502
      console.error("[api/agents/[id]/run] LLM failed:", err);
      const errorMessage =
        err instanceof Error ? err.message : "Agent không phản hồi được.";
      // F-841-03/#84: ước lượng từ prompt THẬT đã gửi (sentPromptText) — không
      // rebuild prompt (tránh RetrievalLog đếm kép + usedInPrompt sai). Prompt
      // chưa kịp build (lỗi trước callLlm) → ước lượng 0, trung thực.
      const tokensInEstimate = sentPromptText ? estimateTokens(sentPromptText) : 0;
      const run = await persistRun(
        agent.id,
        false,
        startedAt,
        tokensInEstimate,
        0,
        null,
        errorMessage,
        task?.id
      ).catch(() => null);
      // K3: thất bại cũng cập nhật nhiệm vụ (failStreak++ / kill-switch 5 lỗi
      // → paused + RiskAlert) — fail-soft tuyệt đối.
      if (task) {
        await updateTaskAfterRun(
          { id: task.id, title: task.title, schedule: task.schedule, failStreak: task.failStreak, agentName: agent.name },
          false,
          null
        );
      }
      await db.auditLog
        .create({
          data: {
            action: "AGENT_RUN_COMPLETED",
            entity: "Agent",
            entityId: agent.id,
            after: JSON.stringify({
              mode: "single",
              failed: true,
              tokensIn: tokensInEstimate,
              tokensOut: 0,
              durationMs: run?.durationMs ?? null,
              error: errorMessage,
            }),
          },
        })
        .catch(() => undefined);
      return NextResponse.json(
        { error: "Agent không phản hồi được lúc này. Vui lòng thử lại sau ít phút." },
        { status: 502 }
      );
    }
  } catch (err) {
    // Absolute last-resort guard — never crash the app
    console.error("[api/agents/[id]/run] unexpected error:", err);
    return NextResponse.json(
      { error: "Không chạy được agent này lúc này. Vui lòng thử lại." },
      { status: 500 }
    );
  }
}
