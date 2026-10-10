import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { settlePendingRewards } from "@/lib/ml/bandit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/ml/settle — A1 (ML_OPS_BLUEPRINT v1.1 §3, duyệt phiên #79 Q1):
 * KẾT TOÁN BANDIT THEO LỊCH, tách khỏi chu kỳ agent (đắt, LLM) và nút train
 * (thủ công). Wrapper mỏng quanh `settlePendingRewards()` (src/lib/ml/bandit.ts
 * — KHÔNG sửa logic): thuật toán thuần quét Bar + Vote, 0 LLM, ~1-2s, $0.
 *
 * Engine market-engine :3003 gọi route này mỗi ngày sau 16:15 ICT (env
 * SETTLE_AT — chỉ khi EOD hôm đó đã sync: `eodSyncDate == hôm nay`) — settle
 * đúng cơ chế idempotent qua `settledKeys` của bandit nên restart engine
 * giữa chừng KHÔNG double-settle. Nút bấm/chu kỳ agent vẫn dùng đường cũ.
 *
 * AUD-CODE #18 (pattern tick route): mutex in-process kiểu chuỗi Promise
 * module-level — 2 settle đồng thời (scheduler 16:15 + thủ công) có thể quét
 * cùng assessment rồi upsert BanditEvent đè nhau; giờ mọi POST được xếp hàng
 * tuần tự.
 *
 * AuditLog kind "ML_SETTLE" (action là String — 0 migrate): ghi {settled,
 * votes, note} sau mỗi lần chạy (kể cả 0/0 — truy vết "đã chạy đúng hạn",
 * pattern audit NEWS_INGESTED chỉ ghi không xoá).
 */

interface SettleRun {
  settled: number;
  votes: number;
  details?: { agentCode: string; agentName: string; reward: number; assessmentId: string }[];
}

/** AUD-CODE #18: mutex in-process — mọi POST /api/ml/settle chạy tuần tự. */
let settleMutex: Promise<NextResponse> = Promise.resolve(null as unknown as NextResponse);

async function runSettle(): Promise<NextResponse> {
  const started = Date.now();
  try {
    const result: SettleRun = await settlePendingRewards();
    const durationMs = Date.now() - started;
    // Audit mọi lần chạy — kể cả settled=0 (chưa đủ 5 phiên là trung thực,
    // khác với "không chạy"): truy vết lịch A1 đọc thẳng AuditLog.
    try {
      await db.auditLog.create({
        data: {
          action: "ML_SETTLE",
          entity: "BanditEvent",
          entityId: null,
          after: JSON.stringify({
            settled: result.settled,
            votes: result.votes,
            note:
              result.settled > 0
                ? `kết toán ${result.settled} assessment · ${result.votes} phiếu (A1)`
                : "không có phiếu đủ 5 phiên để kết toán (A1 — chạy đúng lịch)",
          }),
        },
      });
    } catch (auditErr) {
      // Fail-soft: audit fail không làm hỏng settle (đã ghi BanditEvent)
      console.error("[api/ml/settle] AuditLog ML_SETTLE lỗi (bỏ qua):", auditErr);
    }
    return NextResponse.json({ ok: true, ...result, durationMs });
  } catch (err) {
    console.error("[api/ml/settle] POST failed:", err);
    return NextResponse.json(
      { ok: false, error: "Kết toán bandit thất bại.", settled: 0, votes: 0 },
      { status: 500 }
    );
  }
}

export async function POST(): Promise<NextResponse> {
  const run = settleMutex.then(runSettle).catch((err) => {
    console.error("[api/ml/settle:mutex]", err);
    return NextResponse.json(
      { ok: false, error: "Kết toán bandit thất bại." },
      { status: 500 }
    );
  });
  settleMutex = run;
  return run;
}
