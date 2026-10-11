import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";
import { currentModelId, llmStatus } from "@/lib/llm";
import { ROLE_LABELS, GROUP_LABELS, type AgentGroup } from "@/lib/agent-roster";

export const dynamic = "force-dynamic";

/**
 * GET /api/agents — toàn bộ 23 agents (parsed config, pending tasks, last run)
 * + 12 task gần nhất across agents.
 *
 * PHASE3 B2 §4.2: mỗi agent kèm `stats` (runCount, successRate, tokens,
 * cost, lastError, chatCount) + `totals` chi phí AI toàn đội (§5.5).
 * Mở rộng 23 agents: thêm `group`/`groupLabel` (research|control|executive|
 * platform|ml) cho UI xếp nhóm roster.
 */

function groupLabelOf(group: string): string {
  return GROUP_LABELS[group as AgentGroup] ?? group;
}
export async function GET() {
  try {
    const [agents, tasks, pendingCounts, lastRuns, runStats, chatCounts, errorRuns, scheduledTasks] =
      await Promise.all([
        db.agent.findMany({
          orderBy: { createdAt: "asc" },
        }),
        db.agentTask.findMany({
          orderBy: { createdAt: "desc" },
          take: 12,
          include: { agent: { select: { code: true, name: true } } },
        }),
        db.agentTask.groupBy({
          by: ["agentId"],
          where: { status: { in: ["PENDING", "RUNNING"] } },
          _count: { _all: true },
        }),
        db.agentRun.findMany({
          orderBy: { startedAt: "desc" },
          take: 50,
          select: {
            agentId: true,
            taskStatus: true,
            startedAt: true,
            durationMs: true,
            tokensIn: true,
            tokensOut: true,
            costUsd: true,
          },
        }),
        // Stats chạy/chi phí theo agent — group theo (agent, status) để đếm COMPLETED
        db.agentRun.groupBy({
          by: ["agentId", "taskStatus"],
          _count: { _all: true },
          _sum: { tokensIn: true, tokensOut: true, costUsd: true },
        }),
        // Số tin chat 1-1 (broadcast=false) theo agent
        db.agentMessage.groupBy({
          by: ["fromAgentId"],
          where: { broadcast: false },
          _count: { _all: true },
        }),
        // Run lỗi gần nhất mỗi agent (lấy first-per-agent sau khi sort desc)
        db.agentRun.findMany({
          where: { error: { not: null } },
          orderBy: { startedAt: "desc" },
          take: 25,
          select: { agentId: true, error: true },
        }),
        // K3 (#94 — AUTONOMY_BLUEPRINT §6.4): nhiệm vụ định kỳ toàn đội cho
        // khối "Lịch tuần" trong workspace Đội Agent (schedule ≠ null) —
        // phần tử CUỐI của Promise.all (không xô vị trí destructuring cũ).
        db.agentTask.findMany({
          where: { schedule: { not: null } },
          orderBy: [{ nextDueAt: "asc" }],
          take: 100,
          include: { agent: { select: { id: true, code: true, name: true, group: true } } },
        }),
      ]);

    // First (latest) run per agent — lastRuns are already desc by startedAt
    const lastRunByAgent = new Map<string, (typeof lastRuns)[number]>();
    for (const run of lastRuns) {
      if (!lastRunByAgent.has(run.agentId)) lastRunByAgent.set(run.agentId, run);
    }
    const pendingByAgent = new Map(
      pendingCounts.map((c) => [c.agentId, c._count._all])
    );

    // Gộp nhóm (agentId, taskStatus) → stats mỗi agent
    interface Acc {
      runCount: number;
      completed: number;
      tokensIn: number;
      tokensOut: number;
      costUsd: number;
    }
    const accByAgent = new Map<string, Acc>();
    for (const row of runStats) {
      const acc = accByAgent.get(row.agentId) ?? {
        runCount: 0,
        completed: 0,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
      };
      acc.runCount += row._count._all;
      if (row.taskStatus === "COMPLETED") acc.completed += row._count._all;
      acc.tokensIn += row._sum.tokensIn ?? 0;
      acc.tokensOut += row._sum.tokensOut ?? 0;
      acc.costUsd += row._sum.costUsd ?? 0;
      accByAgent.set(row.agentId, acc);
    }
    const chatCountByAgent = new Map(
      chatCounts.map((c) => [c.fromAgentId, c._count._all])
    );
    // Lỗi gần nhất mỗi agent (danh sách đã sort desc — giữ mục đầu tiên)
    const lastErrorByAgent = new Map<string, string>();
    for (const r of errorRuns) {
      if (!lastErrorByAgent.has(r.agentId) && r.error) lastErrorByAgent.set(r.agentId, r.error);
    }

    // #93 — model động (chọn từ UI Đội Agent): đọc 1 lần trước map
    const runtimeModel = await currentModelId();
    const agentsPayload = agents.map((a) => {
      let config: Record<string, unknown> | null = null;
      try {
        config = a.config ? (JSON.parse(a.config) as Record<string, unknown>) : null;
      } catch {
        config = null;
      }
      const lr = lastRunByAgent.get(a.id) ?? null;
      const acc = accByAgent.get(a.id);
      return {
        id: a.id,
        code: a.code,
        name: a.name,
        role: a.role,
        roleLabel: ROLE_LABELS[a.role] ?? a.role,
        group: a.group,
        groupLabel: groupLabelOf(a.group),
        description: a.description,
        model: runtimeModel, // model runtime (provider đang chạy) — DB chỉ lưu mặc định
        status: a.status,
        healthScore: a.healthScore,
        lastRunAt: a.lastRunAt,
        config,
        pendingTaskCount: pendingByAgent.get(a.id) ?? 0,
        lastRun: lr
          ? {
              taskStatus: lr.taskStatus,
              startedAt: lr.startedAt,
              durationMs: lr.durationMs,
              tokensIn: lr.tokensIn,
              tokensOut: lr.tokensOut,
              costUsd: lr.costUsd,
            }
          : null,
        // PHASE3 B2 §4.2 — stats vận hành mỗi agent
        stats: {
          runCount: acc?.runCount ?? 0,
          successRate: acc && acc.runCount > 0 ? acc.completed / acc.runCount : 0,
          totalTokensIn: acc?.tokensIn ?? 0,
          totalTokensOut: acc?.tokensOut ?? 0,
          totalCostUsd: Number((acc?.costUsd ?? 0).toFixed(6)),
          lastError: lastErrorByAgent.get(a.id) ?? null,
          chatCount: chatCountByAgent.get(a.id) ?? 0,
        },
      };
    });

    // Tổng cộng dồn toàn đội (§5.5 — chip chi phí AI)
    const totals = agentsPayload.reduce(
      (t, a) => ({
        runCount: t.runCount + a.stats.runCount,
        totalTokensIn: t.totalTokensIn + a.stats.totalTokensIn,
        totalTokensOut: t.totalTokensOut + a.stats.totalTokensOut,
        totalCostUsd: Number((t.totalCostUsd + a.stats.totalCostUsd).toFixed(6)),
      }),
      { runCount: 0, totalTokensIn: 0, totalTokensOut: 0, totalCostUsd: 0 }
    );

    return NextResponse.json(
      toPlain({
        agents: agentsPayload,
        tasks: tasks.map((t) => ({
          id: t.id,
          agentCode: t.agent.code,
          agentName: t.agent.name,
          title: t.title,
          description: t.description,
          status: t.status,
          priority: t.priority,
          createdAt: t.createdAt,
          // K3 (#94): trường mới additive cho các consumers cũ.
          schedule: t.schedule,
          nextDueAt: t.nextDueAt,
          lastRunAt: t.lastRunAt,
          runCount: t.runCount,
          failStreak: t.failStreak,
          paused: t.paused,
          createdByAgentId: t.createdByAgentId,
          completedAt: t.completedAt,
        })),
        // K3 (#94): "Lịch tuần" — nhiệm vụ định kỳ cả đội theo thứ giờ.
        scheduledTasks: scheduledTasks.map((t) => ({
          id: t.id,
          agentId: t.agent.id,
          agentCode: t.agent.code,
          agentName: t.agent.name,
          group: t.agent.group,
          title: t.title,
          schedule: t.schedule ?? "",
          nextDueAt: t.nextDueAt,
          paused: t.paused,
          runCount: t.runCount,
        })),
        totals,
        // Provider LLM đang chạy (auto: Opencode Zen space-bunny-free khi có key,
        // GLM-4.6 trong sandbox) — UI chip/tooltip dùng nguồn duy nhất này
        llm: await llmStatus(),
      })
    );
  } catch (err) {
    console.error("[api/agents]", err);
    return NextResponse.json(
      { error: "Không tải được dữ liệu agent." },
      { status: 500 }
    );
  }
}
