import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  computeNextCycleAt,
  isKRunInterval,
  parseKRun,
  startKRun,
  stopKRun,
  setKRunInterval,
} from "@/lib/k-run";
import type { KRunState } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * GET/POST /api/k/run — K2 "Chế độ chạy liên tục" (AUTONOMY_BLUEPRINT v1.1 §4.2).
 *
 * GET: trạng thái k-run + nextCycleAt (engine due-check 60s + Header refetch
 *      60s). `exists=false` → env AGENT_CYCLE_MINUTES vẫn hiệu lực (hậu phương).
 *
 * POST body {action, intervalMinutes?}:
 *   - "start": nhịp ∈ {60,120,240,480} (mặc định 240) → enabled:true +
 *     startedAt:now (giữ lastCycleAt/cyclesRun cũ) + AuditLog K2_RUN_STARTED.
 *   - "stop":  enabled:false (tạo key nếu chưa có — AppSetting thắng tuyệt
 *     đối, env nhường quyền → chu kỳ dừng hẳn) + AuditLog K2_RUN_STOPPED.
 *   - "interval": đổi nhịp khi đang bật (không đụng enabled/startedAt).
 *
 * Hiệu lực tắt LUÔN từ chu kỳ kế tiếp (không giết giữa dòng — AgentRun không
 * kẹt RUNNING): chu kỳ đang chạy (nếu có) hoàn tất tự nhiên.
 */

async function buildState(): Promise<KRunState> {
  // Fail-soft trong parseKRun/readKRunRow — lỗi DB trả mặc định an toàn.
  let raw: string | null = null;
  try {
    const row = await db.appSetting.findUnique({ where: { key: "k-run" } });
    raw = row?.value ?? null;
  } catch (err) {
    console.error("[api/k/run] đọc AppSetting thất bại:", err);
  }
  const exists = raw != null;
  const s = parseKRun(raw);
  return {
    exists,
    enabled: s.enabled,
    intervalMinutes: s.intervalMinutes,
    startedAt: s.startedAt,
    lastCycleAt: s.lastCycleAt,
    cyclesRun: s.cyclesRun,
    nextCycleAt: exists && s.enabled
      ? new Date(computeNextCycleAt(s)).toISOString()
      : null,
  };
}

export async function GET() {
  return NextResponse.json(await buildState());
}

interface PostBody {
  action?: unknown;
  intervalMinutes?: unknown;
}

export async function POST(req: Request) {
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json(
      { error: "Body JSON không hợp lệ." },
      { status: 400 }
    );
  }

  const action = typeof body.action === "string" ? body.action : "";

  if (action === "start" || action === "interval") {
    // Nhịp: truyền vào → phải ∈ bộ cho phép; bỏ qua → giữ nhịp hiện tại
    // (start không truyền mặc định 240 — trừ khi chưa từng có nhịp).
    const rawInterval = body.intervalMinutes;
    if (rawInterval !== undefined && !isKRunInterval(rawInterval)) {
      return NextResponse.json(
        {
          error:
            "Nhịp không hợp lệ — phải thuộc {60, 120, 240, 480} phút (bảo vệ quota free-tier).",
        },
        { status: 422 }
      );
    }
    // F2 (#86 rà tự nghiệm thu): findUnique unguarded → DB down = 500 thô.
    // Fail-soft về default (parseKRun(null)) — validate vẫn chạy, ghi key
    // bên trong startKRun/setKRunInterval tự fail-soft.
    let currentRaw: string | null = null;
    try {
      currentRaw =
        (await db.appSetting.findUnique({ where: { key: "k-run" } }))?.value ?? null;
    } catch (err) {
      console.error("[api/k/run] đọc AppSetting (POST) thất bại:", err);
    }
    const current = parseKRun(currentRaw);
    const interval = isKRunInterval(rawInterval)
      ? rawInterval
      : current.intervalMinutes;

    if (action === "start") {
      const s = await startKRun(interval);
      await db.auditLog
        .create({
          data: {
            action: "K2_RUN_STARTED",
            entity: "AppSetting",
            entityId: "k-run",
            after: JSON.stringify({ ...s, nextCycleAt: computeNextCycleAt(s) }),
          },
        })
        .catch((err) => console.error("[api/k/run] audit K2_RUN_STARTED:", err));
      return NextResponse.json(await buildState());
    }
    // "interval" — đổi nhịp (chỉ có nghĩa khi đang bật; khi tắt vẫn lưu cho
    // lần bật kế tiếp — ghi rõ trong response để UI không hiểu nhầm)
    const s = await setKRunInterval(interval);
    if (s.enabled) {
      await db.auditLog
        .create({
          data: {
            action: "K2_INTERVAL_CHANGED",
            entity: "AppSetting",
            entityId: "k-run",
            after: JSON.stringify({ intervalMinutes: interval }),
          },
        })
        .catch((err) => console.error("[api/k/run] audit K2_INTERVAL_CHANGED:", err));
    }
    return NextResponse.json(await buildState());
  }

  if (action === "stop") {
    const s = await stopKRun();
    await db.auditLog
      .create({
        data: {
          action: "K2_RUN_STOPPED",
          entity: "AppSetting",
          entityId: "k-run",
          after: JSON.stringify({ ...s, note: "hiệu lực từ chu kỳ kế tiếp" }),
        },
      })
      .catch((err) => console.error("[api/k/run] audit K2_RUN_STOPPED:", err));
    return NextResponse.json(await buildState());
  }

  return NextResponse.json(
    { error: 'action phải là "start", "stop" hoặc "interval".' },
    { status: 422 }
  );
}
