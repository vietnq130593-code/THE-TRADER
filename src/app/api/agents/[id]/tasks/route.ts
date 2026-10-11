import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";
// K3 (#94 — AUTONOMY_BLUEPRINT §6.2): parser lịch chung (server tính
// nextDueAt — client KHÔNG gửi, chống lệch múi giờ).
import { computeNextDueAt, parseScheduleGrammar } from "@/lib/schedule";

export const dynamic = "force-dynamic";

/**
 * GET /api/agents/[id]/tasks — danh sách nhiệm vụ của 1 agent (tab Nhiệm vụ
 * K3 #94): đầy đủ trường mới schedule/nextDueAt/lastRunAt/runCount/failStreak/
 * paused/createdByAgentId + tên agent giao (K4).
 *
 * POST — tạo nhiệm vụ (K3 §6.2): body
 *   { title 1..200, description? ≤2000,
 *     schedule? "HH:MM" | "DOW:HH:MM" | null (null = nhiệm vụ tay 1 lần),
 *     priority "low|medium|high" (mặc định medium) }
 * Server tự tính nextDueAt theo ICT (computeNextDueAt) — client không gửi.
 * Schedule sai grammar → 422 { fields: [{field, message}] }.
 * Audit: K3_TASK_CREATED { agentId, schedule, nextDueAt }.
 */

interface FieldError {
  field: string;
  message: string;
}

const PRIORITIES = new Set(["low", "medium", "high"]);

/** Kiểu dòng AgentTask kèm agent (dùng chung GET/POST). */
interface TaskRow {
  id: string;
  agentId: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  schedule: string | null;
  nextDueAt: Date | null;
  lastRunAt: Date | null;
  runCount: number;
  failStreak: number;
  paused: boolean;
  createdByAgentId: string | null;
  createdAt: Date;
  completedAt: Date | null;
  agent: { code: string; name: string };
}

/** Map dòng AgentTask (kèm agent + người giao) → payload UI. */
function mapTask(t: TaskRow, creatorById: Map<string, { code: string; name: string }>) {
  const creator = t.createdByAgentId ? creatorById.get(t.createdByAgentId) : undefined;
  return {
    id: t.id,
    agentId: t.agentId,
    agentCode: t.agent.code,
    agentName: t.agent.name,
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    schedule: t.schedule,
    nextDueAt: t.nextDueAt,
    lastRunAt: t.lastRunAt,
    runCount: t.runCount,
    failStreak: t.failStreak,
    paused: t.paused,
    createdByAgentId: t.createdByAgentId,
    createdByName: creator?.name ?? null,
    createdAt: t.createdAt,
    completedAt: t.completedAt,
  };
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const agent = await db.agent.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!agent) {
      return NextResponse.json({ error: "Không tìm thấy agent." }, { status: 404 });
    }
    const tasks = await db.agentTask.findMany({
      where: { agentId: id },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { agent: { select: { code: true, name: true } } },
    });
    // Tên agent giao việc (K4) — join thủ công qua createdByAgentId.
    const creatorIds = [
      ...new Set(tasks.map((t) => t.createdByAgentId).filter((v): v is string => v != null)),
    ];
    const creators = creatorIds.length
      ? await db.agent.findMany({
          where: { id: { in: creatorIds } },
          select: { id: true, code: true, name: true },
        })
      : [];
    const creatorById = new Map(creators.map((c) => [c.id, c]));
    return NextResponse.json(toPlain({ tasks: tasks.map((t) => mapTask(t, creatorById)) }));
  } catch (err) {
    console.error("[api/agents/[id]/tasks GET]", err);
    return NextResponse.json(
      { error: "Không tải được danh sách nhiệm vụ." },
      { status: 500 }
    );
  }
}

interface PostBody {
  title?: unknown;
  description?: unknown;
  schedule?: unknown;
  priority?: unknown;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    let body: PostBody;
    try {
      body = (await req.json()) as PostBody;
    } catch {
      return NextResponse.json({ error: "Body JSON không hợp lệ." }, { status: 400 });
    }

    const agent = await db.agent.findUnique({ where: { id } });
    if (!agent) {
      return NextResponse.json({ error: "Không tìm thấy agent." }, { status: 404 });
    }

    // ── Validate (422 fields[] khi sai) ──
    const fields: FieldError[] = [];
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) fields.push({ field: "title", message: "Tiêu đề bắt buộc." });
    else if (title.length > 200)
      fields.push({ field: "title", message: "Tiêu đề tối đa 200 ký tự." });

    let description: string | null = null;
    if (body.description != null && body.description !== "") {
      if (typeof body.description !== "string") {
        fields.push({ field: "description", message: "Mô tả phải là chuỗi." });
      } else {
        description = body.description.trim() || null;
        if (description && description.length > 2000)
          fields.push({ field: "description", message: "Mô tả tối đa 2000 ký tự." });
      }
    }

    let schedule: string | null = null;
    if (body.schedule != null && body.schedule !== "") {
      if (typeof body.schedule !== "string") {
        fields.push({
          field: "schedule",
          message: 'Lịch phải là chuỗi "HH:MM" hoặc "DOW:HH:MM" (ví dụ MON:09:30).',
        });
      } else {
        const trimmed = body.schedule.trim();
        if (!parseScheduleGrammar(trimmed)) {
          fields.push({
            field: "schedule",
            message:
              'Lịch không hợp lệ — dùng "HH:MM" hằng ngày hoặc "DOW:HH:MM" hằng tuần (DOW ∈ MON..SUN).',
          });
        } else {
          schedule = trimmed;
        }
      }
    }
    // Execution Manager chỉ chạy trong chu kỳ đầy đủ (route single-run 409) —
    // mọi nhiệm vụ cho agent này kẹt: định kỳ kẹt due vĩnh viễn, nhiệm vụ tay
    // một lần cũng 409 ở route run (F-K3-05 FB-4A: chặn CẢ schedule-null,
    // trước đây chỉ chặn `schedule &&` → task một lần dead-letter) → chặn từ gốc.
    if (agent.code === "execution-manager") {
      fields.push({
        field: "schedule",
        message:
          "Execution Manager chỉ chạy trong chu kỳ đầy đủ — không nhận nhiệm vụ (định kỳ lẫn một lần).",
      });
    }

    let priority = "medium";
    if (body.priority != null && body.priority !== "") {
      if (typeof body.priority !== "string" || !PRIORITIES.has(body.priority)) {
        fields.push({
          field: "priority",
          message: "Ưu tiên phải là low | medium | high.",
        });
      } else {
        priority = body.priority;
      }
    }

    if (fields.length > 0) {
      return NextResponse.json(
        { error: "Dữ liệu nhiệm vụ không hợp lệ.", fields },
        { status: 422 }
      );
    }

    // ── Tạo nhiệm vụ — server tính nextDueAt (ICT) ──
    const now = new Date();
    const nextDueAt = schedule ? computeNextDueAt(schedule, now) : null;
    const task = await db.agentTask.create({
      data: {
        agentId: agent.id,
        title,
        description,
        priority,
        status: "PENDING",
        schedule,
        nextDueAt,
        createdByAgentId: null, // null = trader tạo
      },
      include: { agent: { select: { code: true, name: true } } },
    });

    await db.auditLog
      .create({
        data: {
          action: "K3_TASK_CREATED",
          entity: "AgentTask",
          entityId: task.id,
          after: JSON.stringify({
            agentId: agent.id,
            agentCode: agent.code,
            title,
            schedule,
            nextDueAt: nextDueAt?.toISOString() ?? null,
            priority,
          }),
        },
      })
      .catch((err) => console.error("[api/agents/[id]/tasks] audit K3_TASK_CREATED:", err));

    return NextResponse.json(toPlain({ task: mapTask(task, new Map()) }), {
      status: 201,
    });
  } catch (err) {
    console.error("[api/agents/[id]/tasks POST]", err);
    return NextResponse.json(
      { error: "Không tạo được nhiệm vụ lúc này." },
      { status: 500 }
    );
  }
}
