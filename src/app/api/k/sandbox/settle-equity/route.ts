import { NextResponse } from "next/server";
import { settleSandboxDay } from "@/lib/k-sandbox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/k/sandbox/settle-equity — K1 job 16:30 ICT (AUTONOMY_BLUEPRINT
 * v1.1 §5.4 + §5.5, triển khai #87).
 *
 * MỘT route BỐN việc (thứ tự §5.5 — chạy SAU settle bandit 16:15 để không
 * tranh lock DB):
 *   (a) settle-exec-reward kênh 2 — position sandbox đã đóng trong phiên →
 *       net realised (đã trừ phí 0,15% + thuế bán) → nhị phân hoá → cộng THÊM
 *       vào posterior Beta BanditArm của agent tạo tín hiệu (Q2: "chiến thắng
 *       thật / thất bại thật"). Dedupe AuditLog K1_SANDBOX_EXEC_REWARD.
 *   (b) settle-equity — CashSnapshot 1 dòng/ngày (source "k1-daily") + prune 365 ngày.
 *   (c) telemetry tổng hợp → dữ liệu cổng L5 AgentLesson + hiển thị trader.
 *   (d) audit K1_SANDBOX_SETTLED tổng kết (kể cả 0 — pattern ML_SETTLE A1).
 *
 * Engine market-engine :3003 gọi đúng lịch K1_EQUITY_AT (mặc định 16:30 ICT,
 * gate EOD-đã-sync + T7/CN + đã-chạy-hôm-nay như settle A1). `?force=1` = test
 * nội bộ §5.7-4: bỏ cổng "hôm nay đã settle" — reward vẫn dedupe per position,
 * snapshot upsert (không bao giờ 2 dòng/ngày → chạy 2 lần idempotent).
 *
 * AUD-CODE #18 (pattern ml/settle): mutex in-process chuỗi Promise — 2 POST
 * đồng thời (scheduler + tay) xếp hàng tuần tự.
 */

let settleMutex: Promise<NextResponse> = Promise.resolve(null as unknown as NextResponse);

async function runSettle(force: boolean): Promise<NextResponse> {
  const started = Date.now();
  try {
    const result = await settleSandboxDay({ force });
    return NextResponse.json({
      ...result,
      durationMs: Date.now() - started,
    });
  } catch (err) {
    console.error("[api/k/sandbox/settle-equity] POST failed:", err);
    return NextResponse.json(
      { ok: false, error: "Kết toán K1 thất bại." },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  const force = new URL(req.url).searchParams.get("force") === "1";
  const run = settleMutex.then(() => runSettle(force)).catch((err) => {
    console.error("[api/k/sandbox/settle-equity:mutex]", err);
    return NextResponse.json({ ok: false, error: "Kết toán K1 thất bại." }, { status: 500 });
  });
  settleMutex = run;
  return run;
}
