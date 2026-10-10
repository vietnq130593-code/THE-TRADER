import { NextRequest, NextResponse } from "next/server";
import { toPlain } from "@/lib/serialize";
import { createPaperOrderFromSignal } from "@/lib/signal-execution";

export const dynamic = "force-dynamic";

/**
 * POST /api/signals/[id]/convert — convert a BUY/SELL signal into a
 * PENDING limit order on the VNDIRECT account.
 *
 * PHASE3 B2 §4.5: toàn bộ toán tạo lệnh đã gom về
 * src/lib/signal-execution.ts (một nguồn duy nhất) — route này chỉ là
 * wrapper với sizing "budget50m" (giữ nguyên response shape + status code).
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const result = await createPaperOrderFromSignal(id, { sizing: "budget50m" });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json(
      toPlain({
        order: {
          id: result.order.id,
          symbol: result.order.symbol,
          side: result.order.side,
          type: result.order.type,
          quantity: result.order.quantity,
          price: result.order.price,
          status: result.order.status,
          createdAt: result.order.createdAt,
        },
        // E-P1-2 (v1.2): đầy đủ Order con TWAP + quyết định tách (giữ shape cũ
        // `order` = lát đầu để không phá client hiện có).
        orders: result.orders,
        twap: result.twap,
      })
    );
  } catch (err) {
    console.error("[api/signals/convert]", err);
    return NextResponse.json(
      { error: "Không chuyển được tín hiệu thành lệnh. Vui lòng thử lại." },
      { status: 500 }
    );
  }
}
