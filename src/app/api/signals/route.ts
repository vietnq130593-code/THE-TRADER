import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";
import { mapSignalRow, expireDueSignals } from "@/lib/signal-execution";

export const dynamic = "force-dynamic";

/**
 * GET /api/signals — recent trading signals with instrument + agent info.
 * PHASE3 B2 §4.1: map thêm status / rejectedAt / rejectNote.
 */
export async function GET() {
  try {
    // P1 AUD-CODE #1: sweep tín hiệu hết hạn trước khi trả — UI/prompt luôn thấy
    // đúng trạng thái vòng đời (ACTIVE chỉ còn tín hiệu còn hạn)
    await expireDueSignals();

    const signals = await db.signal.findMany({
      orderBy: { createdAt: "desc" },
      take: 12,
      include: {
        instrument: { select: { symbol: true, name: true } },
        agent: { select: { code: true, name: true } },
      },
    });

    // K1 #88 — cờ "agents đã tự thực thi trong tài khoản thử nghiệm": Order
    // của thế giới sandbox (accountType "sandbox") neo signalId. Truy vết
    // NGUỒN SỰ THẬT là Order sống (reset xoá sạch → badge biến theo) chứ
    // không phải audit marker một-đời (marker cũ vòng trước reset không lọt).
    const ids = signals.map((s) => s.id);
    const executedRows = ids.length
      ? await db.order.findMany({
          where: { signalId: { in: ids }, brokerAccount: { accountType: "sandbox" } },
          select: { signalId: true },
        })
      : [];
    const executedSet = new Set(executedRows.map((o) => o.signalId));

    return NextResponse.json(
      toPlain({
        signals: signals.map((s) => ({
          ...mapSignalRow(s),
          sandboxExecuted: executedSet.has(s.id),
        })),
      })
    );
  } catch (err) {
    console.error("[api/signals]", err);
    return NextResponse.json(
      { error: "Không tải được tín hiệu giao dịch." },
      { status: 500 }
    );
  }
}
