import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";

export const dynamic = "force-dynamic";

/**
 * GET /api/agents/tasks/due?take=10 — K3 #94 (AUTONOMY_BLUEPRINT §6.3):
 * nhiệm vụ due cho engine :3003 đôn đốc mỗi tick 60s.
 *
 *   where: schedule ≠ null (định kỳ) · paused = false · nextDueAt ≤ now
 *   order: nextDueAt asc · take ≤ 20 (mặc định 10)
 * Kèm agentStatus để engine quyết định: RUNNING → defer +5 phút; rảnh →
 * POST /api/agents/[agentId]/run {taskId}.
 *
 * Route tĩnh "tasks" thắng segment động [id] của /api/agents/[id]/* —
 * Next.js ưu tiên segment tĩnh, không xung đột.
 */

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const rawTake = Number(url.searchParams.get("take"));
    const take = Number.isFinite(rawTake) && rawTake >= 1 ? Math.min(20, Math.floor(rawTake)) : 10;

    const tasks = await db.agentTask.findMany({
      where: {
        schedule: { not: null },
        paused: false,
        nextDueAt: { lte: new Date() },
      },
      orderBy: { nextDueAt: "asc" },
      take,
      include: { agent: { select: { id: true, code: true, name: true, status: true } } },
    });

    return NextResponse.json(
      toPlain({
        now: new Date().toISOString(),
        tasks: tasks.map((t) => ({
          taskId: t.id,
          agentId: t.agent.id,
          agentCode: t.agent.code,
          agentName: t.agent.name,
          agentStatus: t.agent.status,
          title: t.title,
          schedule: t.schedule ?? "",
          nextDueAt: t.nextDueAt,
          paused: t.paused,
        })),
      })
    );
  } catch (err) {
    console.error("[api/agents/tasks/due]", err);
    return NextResponse.json(
      { error: "Không đọc được nhiệm vụ due lúc này." },
      { status: 500 }
    );
  }
}
