import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";
import { mapSignalRow, expireDueSignals } from "@/lib/signal-execution";
// F-1091-01 (fixbug api #109): validate ngày chia sẻ — regex-only cũ cho
// "2026-13-01" vượt DATE_RE → Invalid Date → Prisma 500 (verify live).
import { isValidIctDay, ictDayStart, ictDayEnd } from "@/lib/api-dates";

export const dynamic = "force-dynamic";

/**
 * GET /api/signals — recent trading signals with instrument + agent info.
 * PHASE3 B2 §4.1: map thêm status / rejectedAt / rejectNote.
 */

export async function GET(req: Request) {
  try {
    // #105 — khoảng thời gian toàn cục: from/to ngày ICT "YYYY-MM-DD".
    // Hợp lệ → lọc createdAt trong khoảng (take nới 12 → 60 vì khoảng dài
    // có thể nhiều tín hiệu hơn mặc định). Không có/không hợp lệ → hành vi cũ.
    const sp = new URL(req.url).searchParams;
    const fromParam = sp.get("from");
    const toRaw = sp.get("to");
    const hasRange = Boolean(
      fromParam &&
        toRaw &&
        isValidIctDay(fromParam) &&
        isValidIctDay(toRaw) &&
        fromParam <= toRaw,
    );

    // P1 AUD-CODE #1: sweep tín hiệu hết hạn trước khi trả — UI/prompt luôn thấy
    // đúng trạng thái vòng đời (ACTIVE chỉ còn tín hiệu còn hạn)
    await expireDueSignals();

    const signals = await db.signal.findMany({
      where: hasRange
        ? {
            createdAt: {
              gte: ictDayStart(fromParam!),
              lte: ictDayEnd(toRaw!),
            },
          }
        : undefined,
      orderBy: { createdAt: "desc" },
      take: hasRange ? 60 : 12,
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
