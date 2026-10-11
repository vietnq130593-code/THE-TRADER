import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";
// K4 (#94 — AUTONOMY_BLUEPRINT v1.1 §7.2): AppSetting "k4" — pattern k-run.
import {
  K4_KEY,
  getK4,
  setK4,
  sanitizeK4Limit,
  type K4Stored,
} from "@/lib/k4";

export const dynamic = "force-dynamic";

/**
 * GET /api/k4 — K4 "Ban Điều hành giao việc" (§7.2/§7.3):
 * cấu hình k4 + thống kê nhiệm vụ đã giao + 50 nhiệm vụ gần nhất
 * (createdByAgentId ≠ null) cho bảng "Nhiệm vụ đã giao" của workspace
 * Ban Điều hành.
 *
 * POST body { enabled?, maxOpenTasksPerAgent?, maxTasksPerCycle? }:
 *   - enabled: boolean (bật/tắt kill-switch 2 nhà — tắt KHÔNG huỷ nhiệm vụ
 *     đang treo, chúng vẫn chạy đúng lịch K3);
 *   - maxOpenTasksPerAgent / maxTasksPerCycle: nguyên 1..10.
 * Audit: K4_ENABLED / K4_DISABLED (đổi enabled) · K4_CONFIG_UPDATED (đổi
 * giới hạn). 422 khi giá trị sai kiểu/khoảng.
 */

async function buildState(): Promise<{
  exists: boolean;
  enabled: boolean;
  maxOpenTasksPerAgent: number;
  maxTasksPerCycle: number;
  stats: { assignedTotal: number; assignedPending: number; lastAssignedAt: string | null };
  tasks: unknown[];
}> {
  // exists: key đã từng tạo trong DB (đọc thô — getK4 fail-soft trả mặc định)
  let exists = false;
  try {
    const row = await db.appSetting.findUnique({ where: { key: K4_KEY } });
    exists = row != null;
  } catch (err) {
    console.error("[api/k4] đọc AppSetting thất bại:", err);
  }
  const s = await getK4();

  let assignedTotal = 0;
  let assignedPending = 0;
  let lastAssignedAt: string | null = null;
  let tasks: {
    id: string;
    agentCode: string;
    agentName: string;
    agentGroup: string;
    title: string;
    schedule: string | null;
    priority: string;
    status: string;
    paused: boolean;
    runCount: number;
    lastRunAt: Date | null;
    nextDueAt: Date | null;
    createdByAgentId: string | null;
    createdByName: string | null;
    createdAt: Date;
  }[] = [];
  try {
    // F-K4-04 (FB-4A): stats đếm bằng count() THẬT theo where — findMany
    // take:50 chỉ phục vụ bảng danh sách (trước đây assignedTotal/Pending chốt
    // ở 50 khi >50 nhiệm vụ đã giao). lastAssignedAt vẫn từ rows[0] (orderBy
    // createdAt desc → dòng mới nhất luôn nằm đầu nếu tồn tại).
    const [rows, total, pending] = await Promise.all([
      db.agentTask.findMany({
        where: { createdByAgentId: { not: null } },
        orderBy: { createdAt: "desc" },
        take: 50,
        include: { agent: { select: { code: true, name: true, group: true } } },
      }),
      db.agentTask.count({ where: { createdByAgentId: { not: null } } }),
      db.agentTask.count({
        where: { createdByAgentId: { not: null }, status: "PENDING" },
      }),
    ]);
    assignedTotal = total;
    assignedPending = pending;
    lastAssignedAt = rows.length ? rows[0].createdAt.toISOString() : null;
    // Tên agent giao (Chủ tịch) — join thủ công.
    const creatorIds = [
      ...new Set(rows.map((r) => r.createdByAgentId).filter((v): v is string => v != null)),
    ];
    const creators = creatorIds.length
      ? await db.agent.findMany({
          where: { id: { in: creatorIds } },
          select: { id: true, name: true },
        })
      : [];
    const creatorNameById = new Map(creators.map((c) => [c.id, c.name]));
    tasks = rows.map((r) => ({
      id: r.id,
      agentCode: r.agent.code,
      agentName: r.agent.name,
      agentGroup: r.agent.group,
      title: r.title,
      schedule: r.schedule,
      priority: r.priority,
      status: r.status,
      paused: r.paused,
      runCount: r.runCount,
      lastRunAt: r.lastRunAt,
      nextDueAt: r.nextDueAt,
      createdByAgentId: r.createdByAgentId,
      createdByName: r.createdByAgentId
        ? creatorNameById.get(r.createdByAgentId) ?? null
        : null,
      createdAt: r.createdAt,
    }));
  } catch (err) {
    console.error("[api/k4] đọc nhiệm vụ đã giao thất bại:", err);
  }

  return {
    exists,
    enabled: s.enabled,
    maxOpenTasksPerAgent: s.maxOpenTasksPerAgent,
    maxTasksPerCycle: s.maxTasksPerCycle,
    stats: { assignedTotal, assignedPending, lastAssignedAt },
    tasks,
  };
}

export async function GET() {
  try {
    return NextResponse.json(toPlain(await buildState()));
  } catch (err) {
    console.error("[api/k4 GET]", err);
    return NextResponse.json(
      { error: "Không tải được cấu hình K4 lúc này." },
      { status: 500 }
    );
  }
}

interface PostBody {
  enabled?: unknown;
  maxOpenTasksPerAgent?: unknown;
  maxTasksPerCycle?: unknown;
}

export async function POST(req: Request) {
  try {
    let body: PostBody;
    try {
      body = (await req.json()) as PostBody;
    } catch {
      return NextResponse.json({ error: "Body JSON không hợp lệ." }, { status: 400 });
    }

    const patch: Partial<K4Stored> = {};
    const auditAfter: Record<string, unknown> = {};

    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") {
        return NextResponse.json(
          { error: "enabled phải là boolean (bật/tắt giao việc)." },
          { status: 422 }
        );
      }
      patch.enabled = body.enabled;
      auditAfter.enabled = body.enabled;
    }

    if (body.maxOpenTasksPerAgent !== undefined) {
      const v = sanitizeK4Limit(body.maxOpenTasksPerAgent);
      if (v == null) {
        return NextResponse.json(
          { error: "maxOpenTasksPerAgent phải là số nguyên 1..10." },
          { status: 422 }
        );
      }
      patch.maxOpenTasksPerAgent = v;
      auditAfter.maxOpenTasksPerAgent = v;
    }

    if (body.maxTasksPerCycle !== undefined) {
      const v = sanitizeK4Limit(body.maxTasksPerCycle);
      if (v == null) {
        return NextResponse.json(
          { error: "maxTasksPerCycle phải là số nguyên 1..10." },
          { status: 422 }
        );
      }
      patch.maxTasksPerCycle = v;
      auditAfter.maxTasksPerCycle = v;
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json(
        { error: "Không có trường nào để cập nhật (enabled / maxOpenTasksPerAgent / maxTasksPerCycle)." },
        { status: 422 }
      );
    }

    const before = await getK4();
    const after = await setK4(patch);

    // Audit — fail-soft (lỗi audit không chặn cấu hình):
    // enabled đổi → K4_ENABLED / K4_DISABLED; giới hạn đổi → K4_CONFIG_UPDATED.
    if (patch.enabled !== undefined && patch.enabled !== before.enabled) {
      await db.auditLog
        .create({
          data: {
            action: patch.enabled ? "K4_ENABLED" : "K4_DISABLED",
            entity: "AppSetting",
            entityId: K4_KEY,
            after: JSON.stringify({
              ...auditAfter,
              note: patch.enabled
                ? "Chủ tịch bắt đầu được giao việc từ chu kỳ kế tiếp"
                : "Nhiệm vụ đang treo vẫn chạy đúng lịch K3 (không tự huỷ)",
            }),
          },
        })
        .catch((err) => console.error("[api/k4] audit K4_ENABLED/DISABLED:", err));
    }
    if (
      (patch.maxOpenTasksPerAgent !== undefined &&
        patch.maxOpenTasksPerAgent !== before.maxOpenTasksPerAgent) ||
      (patch.maxTasksPerCycle !== undefined &&
        patch.maxTasksPerCycle !== before.maxTasksPerCycle)
    ) {
      await db.auditLog
        .create({
          data: {
            action: "K4_CONFIG_UPDATED",
            entity: "AppSetting",
            entityId: K4_KEY,
            after: JSON.stringify({
              maxOpenTasksPerAgent: after.maxOpenTasksPerAgent,
              maxTasksPerCycle: after.maxTasksPerCycle,
            }),
          },
        })
        .catch((err) => console.error("[api/k4] audit K4_CONFIG_UPDATED:", err));
    }

    return NextResponse.json(toPlain(await buildState()));
  } catch (err) {
    console.error("[api/k4 POST]", err);
    return NextResponse.json(
      { error: "Không cập nhật được cấu hình K4 lúc này." },
      { status: 500 }
    );
  }
}
