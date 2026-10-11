import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";
// K3 (#94 — AUTONOMY_BLUEPRINT §6.2): parser lịch chung.
import { computeNextDueAt, parseScheduleGrammar } from "@/lib/schedule";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/agents/[id]/tasks/[taskId] — K3 #94 (§6.2): sửa / tạm dừng /
 * tiếp tục / đổi lịch / hoãn của MỘT nhiệm vụ.
 *
 * Body (mọi trường optional — chỉ đổi trường được gửi):
 *   { title? 1..200, description? ≤2000, priority? low|medium|high,
 *     schedule? "HH:MM" | "DOW:HH:MM" | null (null = chuyển thành nhiệm vụ tay),
 *     paused? boolean,
 *     deferMinutes? 1..120 — engine K3 hoãn due-check khi agent đang bận
 *     (nextDueAt = max(nextDueAt, now) + deferMinutes; chỉ cho task có lịch) }
 *
 * Ngữ nghĩa lịch:
 *   - schedule đổi (khác giá trị cũ) → nextDueAt tính lại từ now.
 *   - resume (paused true → false, task có lịch) → nextDueAt tính lại từ now.
 *   - pause (false → true) → giữ nguyên nextDueAt (lịch sử), resume sẽ tính mới.
 *   - schedule → null → nextDueAt = null (nhiệm vụ tay).
 *
 * Audit: K3_TASK_PAUSED / K3_TASK_RESUMED (đổi paused) · K3_TASK_UPDATED
 * (đổi trường khác). 404 khi task không thuộc agent. 422 fields[] khi sai.
 *
 * DELETE — xoá nhiệm vụ: 409 khi đang có AgentRun RUNNING của task (không
 * xoá giữa dòng); Audit K3_TASK_DELETED.
 */

interface FieldError {
  field: string;
  message: string;
}

const PRIORITIES = new Set(["low", "medium", "high"]);

interface PatchBody {
  title?: unknown;
  description?: unknown;
  priority?: unknown;
  schedule?: unknown;
  paused?: unknown;
  deferMinutes?: unknown;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; taskId: string }> }
) {
  try {
    const { id, taskId } = await params;
    let body: PatchBody;
    try {
      body = (await req.json()) as PatchBody;
    } catch {
      return NextResponse.json({ error: "Body JSON không hợp lệ." }, { status: 400 });
    }

    const task = await db.agentTask.findUnique({
      where: { id: taskId },
      include: { agent: { select: { code: true, name: true } } },
    });
    if (!task || task.agentId !== id) {
      return NextResponse.json(
        { error: "Không tìm thấy nhiệm vụ của agent này." },
        { status: 404 }
      );
    }

    // ── Validate từng trường được gửi ──
    const fields: FieldError[] = [];
    const data: Record<string, unknown> = {};
    const changed: string[] = [];

    if (body.title !== undefined) {
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (!title) fields.push({ field: "title", message: "Tiêu đề không được để trống." });
      else if (title.length > 200)
        fields.push({ field: "title", message: "Tiêu đề tối đa 200 ký tự." });
      else if (title !== task.title) {
        data.title = title;
        changed.push("title");
      }
    }

    if (body.description !== undefined) {
      if (body.description === null || body.description === "") {
        if (task.description != null) {
          data.description = null;
          changed.push("description");
        }
      } else if (typeof body.description !== "string") {
        fields.push({ field: "description", message: "Mô tả phải là chuỗi." });
      } else {
        const description = body.description.trim() || null;
        if (description && description.length > 2000)
          fields.push({ field: "description", message: "Mô tả tối đa 2000 ký tự." });
        else if (description !== task.description) {
          data.description = description;
          changed.push("description");
        }
      }
    }

    if (body.priority !== undefined) {
      if (typeof body.priority !== "string" || !PRIORITIES.has(body.priority)) {
        fields.push({ field: "priority", message: "Ưu tiên phải là low | medium | high." });
      } else if (body.priority !== task.priority) {
        data.priority = body.priority;
        changed.push("priority");
      }
    }

    let newSchedule: string | null | undefined;
    if (body.schedule !== undefined) {
      if (body.schedule === null || body.schedule === "") {
        newSchedule = null;
      } else if (typeof body.schedule !== "string") {
        fields.push({
          field: "schedule",
          message: 'Lịch phải là chuỗi "HH:MM" hoặc "DOW:HH:MM", hoặc null.',
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
          newSchedule = trimmed;
        }
      }
    }

    let newPaused: boolean | undefined;
    if (body.paused !== undefined) {
      if (typeof body.paused !== "boolean") {
        fields.push({ field: "paused", message: "paused phải là boolean." });
      } else if (body.paused !== task.paused) {
        newPaused = body.paused;
      }
    }

    let deferMinutes: number | undefined;
    if (body.deferMinutes !== undefined) {
      const v = Number(body.deferMinutes);
      if (!Number.isFinite(v) || !Number.isInteger(v) || v < 1 || v > 120) {
        fields.push({ field: "deferMinutes", message: "deferMinutes phải là số nguyên 1..120." });
      } else if (!task.schedule) {
        fields.push({
          field: "deferMinutes",
          message: "Chỉ hoãn được nhiệm vụ có lịch (định kỳ).",
        });
      } else {
        deferMinutes = v;
      }
    }

    if (fields.length > 0) {
      return NextResponse.json(
        { error: "Dữ liệu cập nhật không hợp lệ.", fields },
        { status: 422 }
      );
    }

    const nothingToDo =
      changed.length === 0 &&
      newSchedule === undefined &&
      newPaused === undefined &&
      deferMinutes === undefined;
    if (nothingToDo) {
      return NextResponse.json(
        { error: "Không có trường nào để cập nhật." },
        { status: 422 }
      );
    }

    // ── Tính nextDueAt theo ngữ nghĩa lịch ──
    const now = new Date();
    if (newSchedule !== undefined) {
      data.schedule = newSchedule;
      changed.push("schedule");
      data.nextDueAt = newSchedule ? computeNextDueAt(newSchedule, now) : null;
    }
    // Resume từ paused → nextDueAt tính lại từ now (task có lịch).
    if (newPaused === false && task.schedule && newSchedule === undefined) {
      data.nextDueAt = computeNextDueAt(task.schedule, now);
    }
    // Engine defer: đẩy due ra xa (max(nextDueAt, now) + phút) — KHÔNG đụng khác.
    if (deferMinutes !== undefined) {
      const base = task.nextDueAt && task.nextDueAt > now ? task.nextDueAt : now;
      data.nextDueAt = new Date(base.getTime() + deferMinutes * 60_000);
    }
    if (newPaused !== undefined) {
      data.paused = newPaused;
    }

    const updated = await db.agentTask.update({
      where: { id: task.id },
      data,
      include: { agent: { select: { code: true, name: true } } },
    });

    // ── Audit (fail-soft — không chặn PATCH) ──
    const auditBase = {
      entity: "AgentTask",
      entityId: task.id,
    };
    if (newPaused === true) {
      await db.auditLog
        .create({
          data: {
            ...auditBase,
            action: "K3_TASK_PAUSED",
            after: JSON.stringify({ agentCode: task.agent.code, title: task.title }),
          },
        })
        .catch((err) => console.error("[api/tasks PATCH] audit K3_TASK_PAUSED:", err));
    } else if (newPaused === false) {
      await db.auditLog
        .create({
          data: {
            ...auditBase,
            action: "K3_TASK_RESUMED",
            after: JSON.stringify({
              agentCode: task.agent.code,
              title: task.title,
              nextDueAt: updated.nextDueAt?.toISOString() ?? null,
            }),
          },
        })
        .catch((err) => console.error("[api/tasks PATCH] audit K3_TASK_RESUMED:", err));
    }
    if (changed.length > 0) {
      await db.auditLog
        .create({
          data: {
            ...auditBase,
            action: "K3_TASK_UPDATED",
            after: JSON.stringify({
              agentCode: task.agent.code,
              title: updated.title,
              changed,
              schedule: updated.schedule,
              nextDueAt: updated.nextDueAt?.toISOString() ?? null,
            }),
          },
        })
        .catch((err) => console.error("[api/tasks PATCH] audit K3_TASK_UPDATED:", err));
    }

    const creator =
      updated.createdByAgentId != null
        ? await db.agent
            .findUnique({
              where: { id: updated.createdByAgentId },
              select: { code: true, name: true },
            })
            .catch(() => null)
        : null;

    return NextResponse.json(
      toPlain({
        task: {
          id: updated.id,
          agentId: updated.agentId,
          agentCode: updated.agent.code,
          agentName: updated.agent.name,
          title: updated.title,
          description: updated.description,
          status: updated.status,
          priority: updated.priority,
          schedule: updated.schedule,
          nextDueAt: updated.nextDueAt,
          lastRunAt: updated.lastRunAt,
          runCount: updated.runCount,
          failStreak: updated.failStreak,
          paused: updated.paused,
          createdByAgentId: updated.createdByAgentId,
          createdByName: creator?.name ?? null,
          createdAt: updated.createdAt,
          completedAt: updated.completedAt,
        },
      })
    );
  } catch (err) {
    console.error("[api/agents/[id]/tasks/[taskId] PATCH]", err);
    return NextResponse.json(
      { error: "Không cập nhật được nhiệm vụ lúc này." },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; taskId: string }> }
) {
  try {
    const { id, taskId } = await params;
    const task = await db.agentTask.findUnique({
      where: { id: taskId },
      include: { agent: { select: { code: true, name: true } } },
    });
    if (!task || task.agentId !== id) {
      return NextResponse.json(
        { error: "Không tìm thấy nhiệm vụ của agent này." },
        { status: 404 }
      );
    }
    // 409 khi nhiệm vụ đang có AgentRun RUNNING — không xoá giữa dòng.
    const running = await db.agentRun.findFirst({
      where: { taskId, taskStatus: "RUNNING" },
      select: { id: true },
    });
    if (running) {
      return NextResponse.json(
        {
          error:
            "Nhiệm vụ đang được chạy (AgentRun RUNNING) — chờ hoàn tất rồi xoá để không mất lịch sử giữa dòng.",
        },
        { status: 409 }
      );
    }
    await db.agentTask.delete({ where: { id: task.id } });
    await db.auditLog
      .create({
        data: {
          action: "K3_TASK_DELETED",
          entity: "AgentTask",
          entityId: task.id,
          before: JSON.stringify({
            agentCode: task.agent.code,
            title: task.title,
            schedule: task.schedule,
            runCount: task.runCount,
            createdByAgentId: task.createdByAgentId,
          }),
        },
      })
      .catch((err) => console.error("[api/tasks DELETE] audit K3_TASK_DELETED:", err));
    return NextResponse.json(toPlain({ ok: true, id: task.id }));
  } catch (err) {
    console.error("[api/agents/[id]/tasks/[taskId] DELETE]", err);
    return NextResponse.json(
      { error: "Không xoá được nhiệm vụ lúc này." },
      { status: 500 }
    );
  }
}
