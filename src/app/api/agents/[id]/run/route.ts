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
import { checkAgentRateLimit } from "@/lib/agent-ratelimit";
import { ROSTER_BY_CODE } from "@/lib/agent-roster";
import { runServiceAgent } from "@/lib/agent-service-runs";
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

/** Persist an agent run + restore agent status + update health (persistRun-style). */
async function persistRun(
  agentId: string,
  success: boolean,
  startedAt: number,
  tokensIn: number,
  tokensOut: number,
  output: string | null,
  error: string | null
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
    },
  });
  await db.agent.update({
    where: { id: agentId },
    data: { status: success ? "IDLE" : "ERROR", lastRunAt: finishedAt },
  });
  await updateAgentHealth(agentId, success, durationMs, run.id); // F-113: loại run vừa tạo khỏi P50
  return { id: run.id, durationMs, costUsd };
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

    // Body {} hoặc { note?: string } — chấp nhận body rỗng
    const body = (await req.json().catch(() => ({}))) as { note?: unknown };
    const note = typeof body.note === "string" ? body.note.trim() : "";
    if (note.length > 500) {
      return NextResponse.json(
        { error: "Ghi chú quá dài (tối đa 500 ký tự)." },
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
      return NextResponse.json(
        { error: "Agent đang chạy một tác vụ khác." },
        { status: 400 }
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
          null
        );
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
          errorMessage
        ).catch(() => null);
        return NextResponse.json(
          { error: `Agent dịch vụ lỗi: ${errorMessage}` },
          { status: 500 }
        );
      }
    }

    // ── LLM agent: prompt theo vai + ghi chú tuỳ chọn của trader ──
    try {
      // Prompt theo vai (block chọn lọc như run route) + ghi chú tuỳ chọn của trader
      const { system, user } = await buildSingleRunPrompt(agent.code);
      const userPrompt = note
        ? `${user}\n\nGHI CHÚ CỦA TRADER:\n${note}`
        : user;

      const { raw, tokensIn, tokensOut } = await callLlmWithRetry(system, userPrompt);

      const parsed = parseAgentOutput(agent.code, raw);
      const { content, reasoning, sentiment } = parsed;

      // F-73A-03: đếm parse-fail drift metric chung với chu kỳ (E-P2-1 sau).
      // Chỉ bump ở đây (parse chính sau LLM) — đường catch dưới chỉ ước lượng
      // token qua buildSingleRunPrompt, không chạy LLM/parse lại → no double-bump.
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
        null
      );

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
        })
      );
    } catch (err) {
      // Lỗi LLM giữa chừng → persistRun FAILED + agent ERROR + audit + 502
      console.error("[api/agents/[id]/run] LLM failed:", err);
      const errorMessage =
        err instanceof Error ? err.message : "Agent không phản hồi được.";
      let tokensInEstimate = 0;
      try {
        const { system, user } = await buildSingleRunPrompt(agent.code);
        tokensInEstimate = estimateTokens(system + user);
      } catch {
        tokensInEstimate = 0;
      }
      const run = await persistRun(
        agent.id,
        false,
        startedAt,
        tokensInEstimate,
        0,
        null,
        errorMessage
      ).catch(() => null);
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
