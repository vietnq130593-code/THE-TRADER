import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";
import { ROLE_LABELS, GROUP_LABELS, type AgentGroup } from "@/lib/agent-roster";
import { mapSignalRow } from "@/lib/signal-execution";
import { currentModelId } from "@/lib/llm";

export const dynamic = "force-dynamic";

/**
 * GET /api/agents/[id] — hồ sơ chi tiết 1 agent (PHASE3_BLUEPRINT §4.2):
 * agent (AgentCard + stats) + 20 runs gần nhất + 12 nhiệm vụ +
 * thread chat 1-1 (asc) + 20 tin broadcast (desc) + 5 tín hiệu ACTIVE.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const agent = await db.agent.findUnique({ where: { id } });
    if (!agent) {
      return NextResponse.json(
        { error: "Không tìm thấy agent." },
        { status: 404 }
      );
    }

    const [runs, tasks, chat, broadcastFeed, signals, runStats, chatCounts, errorRuns] =
      await Promise.all([
        db.agentRun.findMany({
          where: { agentId: id },
          orderBy: { startedAt: "desc" },
          take: 20,
          select: {
            id: true,
            taskStatus: true,
            startedAt: true,
            finishedAt: true,
            durationMs: true,
            tokensIn: true,
            tokensOut: true,
            costUsd: true,
            error: true,
          },
        }),
        db.agentTask.findMany({
          where: { agentId: id },
          orderBy: { createdAt: "desc" },
          take: 12,
          include: { agent: { select: { code: true, name: true } } },
        }),
        // Thread chat 1-1 (broadcast=false) — oldest first cho UI chat
        db.agentMessage.findMany({
          where: { fromAgentId: id, broadcast: false },
          orderBy: { createdAt: "asc" },
          select: { id: true, direction: true, content: true, createdAt: true },
        }),
        // 20 tin broadcast gần nhất của agent (desc)
        db.agentMessage.findMany({
          where: { fromAgentId: id, broadcast: true },
          orderBy: { createdAt: "desc" },
          take: 20,
          include: {
            fromAgent: { select: { code: true, name: true, role: true } },
            toAgent: { select: { code: true, name: true } },
          },
        }),
        // Tín hiệu đang mở của agent (status ACTIVE)
        db.signal.findMany({
          where: { agentId: id, status: "ACTIVE" },
          orderBy: { createdAt: "desc" },
          take: 5,
          include: {
            instrument: { select: { symbol: true, name: true } },
            agent: { select: { code: true, name: true } },
          },
        }),
        // Stats theo (agent, status) — đếm COMPLETED + sum tokens/cost
        db.agentRun.groupBy({
          by: ["taskStatus"],
          where: { agentId: id },
          _count: { _all: true },
          _sum: { tokensIn: true, tokensOut: true, costUsd: true },
        }),
        db.agentMessage.groupBy({
          by: ["fromAgentId"],
          where: { fromAgentId: id, broadcast: false },
          _count: { _all: true },
        }),
        // Run lỗi gần nhất của agent
        db.agentRun.findMany({
          where: { agentId: id, error: { not: null } },
          orderBy: { startedAt: "desc" },
          take: 25,
          select: { error: true },
        }),
      ]);

    // Gộp stats (giống GET /api/agents — cùng công thức)
    let runCount = 0;
    let completed = 0;
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let totalCostUsd = 0;
    for (const row of runStats) {
      runCount += row._count._all;
      if (row.taskStatus === "COMPLETED") completed += row._count._all;
      totalTokensIn += row._sum.tokensIn ?? 0;
      totalTokensOut += row._sum.tokensOut ?? 0;
      totalCostUsd += row._sum.costUsd ?? 0;
    }
    const chatCount = chatCounts[0]?._count._all ?? 0;
    const lastError = errorRuns[0]?.error ?? null;

    let config: Record<string, unknown> | null = null;
    try {
      config = agent.config ? (JSON.parse(agent.config) as Record<string, unknown>) : null;
    } catch {
      config = null;
    }

    const lastRun = runs[0] ?? null;

    return NextResponse.json(
      toPlain({
        agent: {
          id: agent.id,
          code: agent.code,
          name: agent.name,
          role: agent.role,
          roleLabel: ROLE_LABELS[agent.role] ?? agent.role,
          group: agent.group,
          groupLabel: GROUP_LABELS[agent.group as AgentGroup] ?? agent.group,
          description: agent.description,
          model: await currentModelId(), // model runtime động (#93 — chọn từ UI Đội Agent)
          status: agent.status,
          healthScore: agent.healthScore,
          lastRunAt: agent.lastRunAt,
          config,
          pendingTaskCount: tasks.filter((t) => t.status === "PENDING" || t.status === "RUNNING").length,
          lastRun: lastRun
            ? {
                taskStatus: lastRun.taskStatus,
                startedAt: lastRun.startedAt,
                durationMs: lastRun.durationMs,
                tokensIn: lastRun.tokensIn,
                tokensOut: lastRun.tokensOut,
                costUsd: lastRun.costUsd,
              }
            : null,
          stats: {
            runCount,
            successRate: runCount > 0 ? completed / runCount : 0,
            totalTokensIn,
            totalTokensOut,
            totalCostUsd: Number(totalCostUsd.toFixed(6)),
            lastError,
            chatCount,
          },
        },
        runs: runs.map((r) => ({
          id: r.id,
          taskStatus: r.taskStatus,
          startedAt: r.startedAt,
          finishedAt: r.finishedAt,
          durationMs: r.durationMs,
          tokensIn: r.tokensIn,
          tokensOut: r.tokensOut,
          costUsd: r.costUsd,
          error: r.error,
        })),
        tasks: tasks.map((t) => ({
          id: t.id,
          agentCode: t.agent.code,
          agentName: t.agent.name,
          title: t.title,
          description: t.description,
          status: t.status,
          priority: t.priority,
          createdAt: t.createdAt,
        })),
        chat: chat.map((m) => ({
          id: m.id,
          direction: m.direction as "AGENT" | "USER",
          content: m.content,
          createdAt: m.createdAt,
        })),
        broadcastFeed: broadcastFeed.map((m) => ({
          id: m.id,
          fromAgent: m.fromAgent
            ? { code: m.fromAgent.code, name: m.fromAgent.name, role: m.fromAgent.role }
            : null,
          toAgent: m.toAgent ? { code: m.toAgent.code, name: m.toAgent.name } : null,
          broadcast: m.broadcast,
          direction: m.direction as "AGENT" | "USER",
          content: m.content,
          reasoning: m.reasoning,
          sentiment: m.sentiment,
          createdAt: m.createdAt,
        })),
        signals: signals.map(mapSignalRow),
      })
    );
  } catch (err) {
    console.error("[api/agents/[id]]", err);
    return NextResponse.json(
      { error: "Không tải được hồ sơ agent." },
      { status: 500 }
    );
  }
}
