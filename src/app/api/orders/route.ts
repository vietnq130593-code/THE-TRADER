import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";
// #96 — hint "lệnh đang chờ gì": matching engine chỉ chạy trong tick, tick
// chỉ chạy trong phiên khi MARKET_STRICT_SESSION=true → lệnh PENDING cuối
// tuần "đứng yên" là ĐÚNG — nhưng trader cần BIẾT nó đang chờ mở phiên nào.
import {
  isTradingSession,
  sessionPhase,
  SESSION_PHASE_LABEL,
  nextTradingSessionOpen,
} from "@/lib/market-session";

export const dynamic = "force-dynamic";

/**
 * GET /api/orders — recent 20 orders (+ trades for the "Giao dịch" tab).
 *
 * K1 (#87 — AUTONOMY_BLUEPRINT v1.1 §5.6-Q3): query `?accountType=paper|sandbox`
 * (mặc định paper — hành vi cũ bảo toàn). Lọc theo brokerAccountId của đúng
 * thế giới tiền — sổ lệnh sandbox do agents tự giữ hiển thị riêng tab Danh mục
 * khi trader chọn "Thử nghiệm".
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Ngày bắt đầu ICT (00:00 +07:00) của chuỗi "YYYY-MM-DD". */
function ictDayStart(date: string): Date {
  return new Date(`${date}T00:00:00+07:00`);
}

/** Ngày kết thúc ICT (cuối ngày +07:00) của chuỗi "YYYY-MM-DD". */
function ictDayEnd(date: string): Date {
  return new Date(`${date}T23:59:59.999+07:00`);
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const accountType = url.searchParams.get("accountType") === "sandbox" ? "sandbox" : "paper";
    // #105 — khoảng thời gian toàn cục: from/to ngày ICT "YYYY-MM-DD".
    // Hợp lệ → lọc lệnh theo createdAt · giao dịch theo executedAt trong khoảng
    // (take nới 20 → 100 vì khoảng dài nhiều bản ghi hơn).
    const fromParam = url.searchParams.get("from");
    const toRaw = url.searchParams.get("to");
    const hasRange = Boolean(
      fromParam &&
        toRaw &&
        DATE_RE.test(fromParam) &&
        DATE_RE.test(toRaw) &&
        fromParam <= toRaw,
    );
    const rangeFilter = hasRange
      ? {
          gte: ictDayStart(fromParam!),
          lte: ictDayEnd(toRaw!),
        }
      : undefined;
    const account = await db.brokerAccount.findFirst({
      where:
        accountType === "sandbox"
          ? { accountType: "sandbox", deletedAt: null }
          : { deletedAt: null, accountType: { not: "sandbox" } },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    // Chưa kích hoạt sandbox → trả rỗng trung thực (không 404 — tab Danh mục
    // hiển thị empty state đúng ngữ nghĩa "chưa có lệnh").
    const accountFilter = account ? { brokerAccountId: account.id } : { brokerAccountId: "__none__" };

    const [orders, trades] = await Promise.all([
      db.order.findMany({
        where: hasRange
          ? { ...accountFilter, createdAt: rangeFilter }
          : accountFilter,
        orderBy: { createdAt: "desc" },
        take: hasRange ? 100 : 20,
        include: { instrument: { select: { symbol: true, name: true } } },
      }),
      db.trade.findMany({
        where: hasRange
          ? { order: accountFilter, executedAt: rangeFilter }
          : { order: accountFilter },
        orderBy: { executedAt: "desc" },
        take: hasRange ? 100 : 20,
        include: { instrument: { select: { symbol: true, name: true } } },
      }),
    ]);

    // #96 — bối cảnh phiên cho hint lệnh chờ (server tính một nguồn, client hiển thị):
    // strictSession=true → matching nghỉ ngoài phiên (hint "xét khớp khi mở phiên …");
    // simulator 24/7 → hint nói đúng "khớp theo tick mô phỏng".
    const now = new Date();
    const nextOpen = nextTradingSessionOpen(now);
    const session = {
      strictSession: process.env.MARKET_STRICT_SESSION === "true",
      inSession: isTradingSession(now),
      phase: sessionPhase(now),
      phaseLabel: SESSION_PHASE_LABEL[sessionPhase(now)],
      nextOpenAt: nextOpen.at.toISOString(),
      nextOpenLabel: nextOpen.whenLabel,
    };

    return NextResponse.json(
      toPlain({
        session,
        orders: orders.map((o) => ({
          id: o.id,
          symbol: o.instrument.symbol,
          name: o.instrument.name,
          side: o.side,
          type: o.type,
          quantity: o.quantity,
          price: o.price,
          filledQuantity: o.filledQuantity,
          avgFillPrice: o.avgFillPrice,
          status: o.status,
          fee: o.fee,
          note: o.note,
          createdAt: o.createdAt,
          submittedAt: o.submittedAt,
          filledAt: o.filledAt,
        })),
        trades: trades.map((t) => ({
          id: t.id,
          symbol: t.instrument.symbol,
          name: t.instrument.name,
          side: t.side,
          quantity: t.quantity,
          price: t.price,
          value: t.quantity * t.price,
          fee: t.fee,
          tax: t.tax,
          executedAt: t.executedAt,
        })),
      })
    );
  } catch (err) {
    console.error("[api/orders]", err);
    return NextResponse.json(
      { error: "Không tải được dữ liệu lệnh." },
      { status: 500 }
    );
  }
}
