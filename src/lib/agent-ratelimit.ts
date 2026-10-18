import { db } from "@/lib/db";

/**
 * Rate-limit 60s mỗi agent — DB là nguồn chân lý (PHASE3_BLUEPRINT §4.3),
 * chống spam chi phí LLM khi chạy riêng / chat liên tục.
 */

/** Chu kỳ nguội tối thiểu giữa 2 lần chạy của cùng một agent. */
const AGENT_COOLDOWN_MS = 60_000;

/**
 * Ngưỡng coi một run RUNNING là "kẹt" (process crash/restart giữa chừng,
 * outer catch không chạy). Giữ > 2× timeout LLM (45s) + biên độ retry.
 */
const STALE_RUNNING_MS = 5 * 60_000;

export type AgentRateLimit =
  | { ok: true }
  | { ok: false; retryAfterSeconds: number };

/**
 * [F-K3-01] Watchdog MỘT NGUỒN reset Agent.status RUNNING → IDLE khi CẢ HAI:
 *   - KHÔNG có AgentRun RUNNING nào "sống" của agent, VÀ
 *   - quá 5 phút kể từ lần ghi status gần nhất (Agent.updatedAt — @updatedAt
 *     đổi mỗi lần route claim RUNNING / persistRun trả trạng thái).
 *
 * Gốc bug (FB-3): cả 3 chỗ gọi ghi AgentRun đều tạo row với status CUỐI
 * (COMPLETED/FAILED) — không bao giờ tồn tại dòng AgentRun RUNNING — nên nhánh
 * reset Agent.status cũ (nằm sau `reaped.count > 0`) là dead code. Agent kẹt
 * RUNNING (process crash / bun --hot / next dev reload giữa run, hoặc
 * persistRun lỗi DB bị .catch nuốt) → K3 defer vô hạn + chu kỳ 409 +
 * single-run 400 MÃI MÃI.
 *
 * Ranh giới 5 phút không đụng agent đang chạy THẬT: run đơn tối đa ~2 phút
 * (LLM 45s × retry). Chu kỳ 23 agents claim RUNNING lúc khởi động và trả từng
 * agent khi xong — chu kỳ dài nhất 5 phút (maxDuration route) nên agent đang
 * xếp hàng giữa chu kỳ luôn có updatedAt (mốc claim) tươi hơn 5 phút.
 *
 * AUDIT 137 A4 — maxDuration KHÔNG được enforce khi self-host (pm2 + bun dev):
 * chu kỳ LLM xấu nhất (45s × 4 retry × 8 cuộc gọi tuần tự) VƯỢT 5 phút dễ dàng
 * → watchdog cũ reset agent còn xếp hàng giữa chừng → chu kỳ/single-run mới
 * chạy chồng. Giờ route chu kỳ heartbeat (chạm updatedAt các agent RUNNING)
 * sau mỗi wave + sau từng agent LLM tuần tự — watchdog 5 phút giờ chỉ dọn
 * chu kỳ THẬT SỰ chết im (process crash/restart), không còn giết chu kỳ dài.
 *
 * Trả số agent đã reset. Idempotent — gọi thoải mái mỗi request.
 */
export async function releaseStuckRunningAgents(agentId?: string): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_RUNNING_MS);
  try {
    const res = await db.agent.updateMany({
      where: {
        ...(agentId ? { id: agentId } : {}),
        status: "RUNNING",
        updatedAt: { lt: cutoff },
        runs: { none: { taskStatus: "RUNNING" } },
      },
      data: { status: "IDLE" },
    });
    return res.count;
  } catch {
    return 0; // không chặn luồng chính vì watchdog
  }
}

/**
 * Dọn run kẹt RUNNING (audit AUD-CODE #5): AgentRun RUNNING quá 5 phút →
 * FAILED (lỗi "stale"). Trả về số run đã dọn. Idempotent — gọi thoải mái mỗi
 * request.
 *
 * [F-K3-01] Reset Agent.status kẹt RUNNING được TÁCH khỏi reaped.count: run
 * row của hệ này chỉ ghi status cuối nên nhánh reap gần như luôn 0 dòng —
 * watchdog releaseStuckRunningAgents() vẫn phải chạy (agent kẹt không còn
 * "run sống" để dựa vào). Gọi cả hai, bất kể kết quả từng bước.
 */
export async function reapStaleAgentRuns(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_RUNNING_MS);
  try {
    const reaped = await db.agentRun.updateMany({
      where: { taskStatus: "RUNNING", startedAt: { lt: cutoff } },
      data: { taskStatus: "FAILED", finishedAt: new Date(), error: "Run kẹt RUNNING (watchdog dọn sau 5 phút — process có thể đã restart giữa chừng)." },
    });
    // Agent kẹt trạng thái RUNNING nhưng không còn run sống → trả về IDLE
    // (F-K3-01: chạy BẤT KỂ reaped.count — xem doc releaseStuckRunningAgents).
    await releaseStuckRunningAgents();
    return reaped.count;
  } catch {
    // run reap lỗi vẫn phải thử reset agent — không chặn luồng chính
    await releaseStuckRunningAgents();
    return 0;
  }
}

/**
 * Kiểm tra agent có được phép chạy ngay không:
 * (a) run mới nhất đang RUNNING (và còn "sống" < 5 phút) → chặn;
 * (b) run mới nhất bắt đầu < 60s sau run trước → chặn kèm số giây còn chờ;
 * còn lại → cho phép. Run RUNNING kẹt quá 5 phút tự động được dọn + cho phép.
 *
 * [F-K3-01] Watchdog inline cũ (dọn run RUNNING stale) là dead code vì không
 * dòng AgentRun RUNNING nào tồn tại — nay delegate về MỘT NGUỒN
 * releaseStuckRunningAgents: agent kẹt RUNNING quá 5 phút được reset IDLE
 * ngay đầu hàm (giải 429/400 vĩnh viễn cho chat/single-run của agent đó).
 */
export async function checkAgentRateLimit(agentId: string): Promise<AgentRateLimit> {
  // Watchdog một nguồn — reset agent kẹt (nếu có) trước khi quyết định.
  await releaseStuckRunningAgents(agentId);
  const last = await db.agentRun.findFirst({
    where: { agentId },
    orderBy: { startedAt: "desc" },
    take: 1,
    select: { id: true, taskStatus: true, startedAt: true },
  });
  if (!last) return { ok: true };

  if (last.taskStatus === "RUNNING") {
    const elapsed = Date.now() - last.startedAt.getTime();
    if (elapsed > STALE_RUNNING_MS) {
      // Watchdog inline: run này đã chết âm thầm — dọn rồi cho phép chạy lại
      await db.agentRun
        .updateMany({
          where: { id: last.id, taskStatus: "RUNNING" },
          data: { taskStatus: "FAILED", finishedAt: new Date(), error: "Run kẹt RUNNING (watchdog dọn sau 5 phút)." },
        })
        .catch(() => undefined);
      await db.agent
        .updateMany({
          where: { id: agentId, status: "RUNNING" },
          data: { status: "IDLE" },
        })
        .catch(() => undefined);
      return { ok: true };
    }
    // Đang có tác vụ chạy thật — đề nghị chờ trọn chu kỳ nguội
    const remaining = AGENT_COOLDOWN_MS - elapsed;
    return { ok: false, retryAfterSeconds: remaining > 0 ? Math.ceil(remaining / 1000) : 60 };
  }

  const delta = Date.now() - last.startedAt.getTime();
  if (delta < AGENT_COOLDOWN_MS) {
    return { ok: false, retryAfterSeconds: Math.ceil((AGENT_COOLDOWN_MS - delta) / 1000) };
  }
  return { ok: true };
}
