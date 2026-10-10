import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";
import {
  createPaperOrderFromSignal,
  mapSignalRow,
  signalStatusConflictMessage,
} from "@/lib/signal-execution";

export const dynamic = "force-dynamic";

/**
 * POST /api/signals/[id]/decision — trader phê duyệt / từ chối đề xuất
 * (PHASE3_BLUEPRINT §4.5):
 *  - APPROVE → tạo lệnh giấy sizing 5% NAV (một nguồn: signal-execution.ts)
 *              + status ACTED + audit SIGNAL_APPROVED;
 *  - REJECT  → status REJECTED + rejectedAt + rejectNote + audit
 *              SIGNAL_REJECTED (KHÔNG tạo AgentMessage — tránh bịa lời agent).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Body: { action: "APPROVE" | "REJECT", note?: string }
    const body = (await req.json().catch(() => ({}))) as {
      action?: unknown;
      note?: unknown;
    };
    const action = typeof body.action === "string" ? body.action.toUpperCase() : "";
    const note = typeof body.note === "string" ? body.note.trim() : undefined;
    if (action !== "APPROVE" && action !== "REJECT") {
      return NextResponse.json(
        { error: "Hành động không hợp lệ (APPROVE hoặc REJECT)." },
        { status: 400 }
      );
    }
    if (note != null && note.length > 500) {
      return NextResponse.json(
        { error: "Ghi chú quá dài (tối đa 500 ký tự)." },
        { status: 400 }
      );
    }

    const signal = await db.signal.findUnique({
      where: { id },
      include: {
        instrument: { select: { symbol: true, name: true } },
        agent: { select: { code: true, name: true } },
      },
    });
    if (!signal) {
      return NextResponse.json(
        { error: "Không tìm thấy tín hiệu." },
        { status: 404 }
      );
    }

    // Guard vòng đời §4.1: chỉ tín hiệu ACTIVE mới được phê duyệt/từ chối
    if (signal.status !== "ACTIVE") {
      return NextResponse.json(
        { error: signalStatusConflictMessage(signal.status) },
        { status: 409 }
      );
    }

    if (action === "APPROVE") {
      // ── Phê duyệt → lệnh giấy 5% NAV (nav5pct) ─────────────────────
      const result = await createPaperOrderFromSignal(id, { sizing: "nav5pct" });
      if (!result.ok) {
        // Trả đúng status/error của hàm (404/409/400/503/501 — guard của hàm
        // kiểm tra status ACTIVE thay vì chỉ actedAt)
        return NextResponse.json({ error: result.error }, { status: result.status });
      }

      // F-73A-05 (fixbug #73): claim ACTED đã diễn ra atomic trong
      // createPaperOrderFromSignal — KHÔNG ghi đè vô điều kiện ở đây (REJECT đua
      // có thể bị/APPROVE đè nhầm). Chỉ re-read để dựng response.
      const updated = await db.signal.findUnique({
        where: { id },
        include: {
          instrument: { select: { symbol: true, name: true } },
          agent: { select: { code: true, name: true } },
        },
      });
      // Guard nhẹ — signal chắc chắn tồn tại (đã check 404 ở trên), chỉ cho TS.
      if (!updated) {
        return NextResponse.json({ error: "Không tìm thấy tín hiệu." }, { status: 404 });
      }

      await db.auditLog.create({
        data: {
          action: "SIGNAL_APPROVED",
          entity: "Signal",
          entityId: updated.id,
          after: JSON.stringify({
            via: "decision",
            symbol: updated.instrument.symbol,
            direction: updated.direction,
            orderId: result.order.id,
            // E-P1-2: đầy đủ Order con khi TWAP tách lát (mỗi con 1 plan con).
            orderIds: result.orders.map((o) => o.id),
            ...(result.twap
              ? {
                  twap: {
                    style: "TWAP",
                    sliceCount: result.twap.sliceCount,
                    notionalPctAdtv: result.twap.notionalPctAdtv,
                    adtvVnd: result.twap.adtvVnd,
                  },
                }
              : {}),
          }),
        },
      });

      return NextResponse.json(
        toPlain({
          signal: mapSignalRow(updated),
          order: {
            id: result.order.id,
            symbol: result.order.symbol,
            side: result.order.side,
            quantity: result.order.quantity,
            price: result.order.price,
            status: result.order.status,
          },
          // E-P1-2 (v1.2): mọi Order con (TWAP) + mô tả quyết định tách —
          // UI/audit nhìn đủ kế hoạch thực thi, không chỉ lát đầu.
          orders: result.orders,
          twap: result.twap,
        })
      );
    }

    // ── Từ chối → REJECTED (không tạo AgentMessage — tránh bịa lời agent) ──
    // F-73A-05 (fixbug #73): REJECT cũng phải claim có điều kiện — APPROVE đua
    // đã chuyển ACTED + tạo N lệnh thì REJECT KHÔNG được phép đè thành REJECTED
    // (lệnh vẫn sống). updateMany where status=ACTIVE là claim atomic thật.
    const claimedReject = await db.signal.updateMany({
      where: { id, status: "ACTIVE" },
      data: {
        status: "REJECTED",
        rejectedAt: new Date(),
        rejectNote: note && note.length > 0 ? note : null,
      },
    });
    if (claimedReject.count === 0) {
      const cur = await db.signal.findUnique({ where: { id }, select: { status: true } });
      return NextResponse.json(
        { error: signalStatusConflictMessage(cur?.status ?? "UNKNOWN") },
        { status: 409 }
      );
    }
    const rejected = await db.signal.findUnique({
      where: { id },
      include: {
        instrument: { select: { symbol: true, name: true } },
        agent: { select: { code: true, name: true } },
      },
    });
    // Guard nhẹ như APPROVE — signal chắc chắn tồn tại, chỉ cho TS non-null.
    if (!rejected) {
      return NextResponse.json({ error: "Không tìm thấy tín hiệu." }, { status: 404 });
    }

    await db.auditLog.create({
      data: {
        action: "SIGNAL_REJECTED",
        entity: "Signal",
        entityId: rejected.id,
        after: JSON.stringify({
          symbol: rejected.instrument.symbol,
          direction: rejected.direction,
          note: rejected.rejectNote,
        }),
      },
    });

    return NextResponse.json(
      toPlain({
        signal: mapSignalRow(rejected),
        order: null,
      })
    );
  } catch (err) {
    console.error("[api/signals/decision]", err);
    return NextResponse.json(
      { error: "Không xử lý được quyết định tín hiệu. Vui lòng thử lại." },
      { status: 500 }
    );
  }
}
