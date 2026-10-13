import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";
// #107 E-EXEC: vị thế phi-VN (chỉ xuất hiện trong sandbox) đánh giá theo luật
// thị trường — quy VND qua USD/VND (cp qtế/forex) hoặc danh nghĩa idx (bond/cmdty).
import { markPositionVND, isForeignMarket } from "@/lib/exec/market-rules";

/** Mask a broker account number for API responses (PII policy, blueprint §6). */
function maskAccount(accountNumber: string): string {
  if (accountNumber.length <= 8) return accountNumber.replace(/.(?=.{2})/g, "•");
  const head = accountNumber.slice(0, 4);
  const tail = accountNumber.slice(-4);
  const masked = "•".repeat(Math.max(0, accountNumber.length - 8));
  return `${head}${masked}${tail}`;
}

export const dynamic = "force-dynamic";

/**
 * GET /api/portfolio
 * Broker account + open positions with live P&L and totals.
 *
 * K1 (#87 — AUTONOMY_BLUEPRINT v1.1 §5.6-Q3): query `?accountType=paper|sandbox`
 * (mặc định paper — hành vi cũ bảo toàn). Bộ lọc tài khoản Giấy/Thử nghiệm trên
 * workspace Danh mục gọi đúng tham số này. P0 quarantine §5.1: đường paper
 * LUÔN loại trừ tài khoản sandbox (accountType not sandbox) — dù query thế nào
 * cũng không bao giờ trộn 2 thế giới tiền.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const accountType = url.searchParams.get("accountType") === "sandbox" ? "sandbox" : "paper";
    const account = await db.brokerAccount.findFirst({
      where:
        accountType === "sandbox"
          ? { accountType: "sandbox", deletedAt: null }
          : { deletedAt: null, accountType: { not: "sandbox" } },
      orderBy: { createdAt: "asc" },
      include: {
        positions: {
          where: { status: "OPEN" },
          include: {
            instrument: {
              include: {
                quotes: { orderBy: { tradedAt: "desc" }, take: 1 },
              },
            },
          },
        },
      },
    });

    if (!account) {
      return NextResponse.json(
        {
          error:
            accountType === "sandbox"
              ? "Chưa kích hoạt tài khoản thử nghiệm (K1)."
              : "Không tìm thấy tài khoản môi giới.",
        },
        { status: 404 }
      );
    }

    // #107 E-EXEC: đánh giá từng vị thế theo luật thị trường — VN giữ nguyên
    // công thức cũ (giá quote VND); phi-VN quy VND (async tuần tự — fx/idx cache).
    interface PortfolioPositionView {
      symbol: string;
      name: string;
      sector: string;
      market: string;
      currency: string;
      quantity: number;
      avgPrice: number;
      last: number;
      refPrice: number | null;
      changePct: number;
      marketValue: number;
      costBasis: number;
      unrealizedPnl: number;
      unrealizedPnlPct: number;
      realizedPnl: bigint;
    }
    const positionViews: PortfolioPositionView[] = [];
    for (const p of account.positions) {
      const q = p.instrument.quotes[0];
      const last = q?.last ?? p.avgPrice;
      const mark = await markPositionVND({
        quantity: p.quantity,
        avgPrice: p.avgPrice,
        avgCostVND: p.avgCostVND,
        openIdxUnits: p.openIdxUnits,
        instrument: p.instrument,
        lastNative: last,
      }).catch(() => null);
      const marketValue = mark?.valueVND ?? p.quantity * last;
      const costBasis = isForeignMarket(p.instrument.market)
        ? p.quantity * Number(p.avgCostVND ?? 0)
        : p.quantity * p.avgPrice;
      const unrealizedPnl = mark?.unrealisedVND ?? marketValue - costBasis;
      positionViews.push({
        symbol: p.instrument.symbol,
        name: p.instrument.name,
        sector: p.instrument.sector ?? "",
        market: p.instrument.market,
        currency: p.instrument.currency ?? "VND",
        quantity: p.quantity,
        avgPrice: p.avgPrice,
        last,
        refPrice: q?.refPrice ?? null,
        changePct: q?.changePct ?? 0,
        marketValue,
        costBasis,
        unrealizedPnl,
        unrealizedPnlPct: costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : 0,
        realizedPnl: p.realizedPnl,
      });
    }
    const positions = positionViews.sort((a, b) => b.marketValue - a.marketValue);

    const totalMarketValue = positions.reduce((s, p) => s + p.marketValue, 0);
    const totalCostBasis = positions.reduce((s, p) => s + p.costBasis, 0);
    const totalUnrealizedPnl = totalMarketValue - totalCostBasis;
    const totalRealizedPnl = positions.reduce((s, p) => s + Number(p.realizedPnl), 0);

    // Day change weighted by current market value
    const dayChangePct =
      totalMarketValue > 0
        ? positions.reduce((s, p) => s + p.marketValue * (p.changePct / 100), 0) /
          totalMarketValue *
          100
        : 0;

    // #110 M4.1.1 — đường cong equity thế giới đang xem: CashSnapshot của ĐÚNG
    // brokerAccount này (90 điểm gần nhất, cũ → mới). Paper sau reset thường
    // 0 điểm → UI tự ẩn curve (trung thực trạng thái §2.5, không vẽ đường rỗng).
    const snapshots = await db.cashSnapshot.findMany({
      where: { brokerAccountId: account.id },
      orderBy: { createdAt: "desc" },
      take: 90,
      select: { createdAt: true, equity: true },
    });
    const equityCurve = snapshots
      .map((s) => ({
        createdAt: s.createdAt.toISOString(),
        equity: Number(s.equity),
      }))
      .reverse();

    // #110 M4.1.1 — Sức mua ước tính (minh bạch công thức — cùng một nguồn logic
    // chip tooltip Header §5.4: buyingPower = cash + positionsMv×RATIO − marginUsed;
    // RATIO 0.5 giả lập ký quỹ 50%, KHÔNG phải hạn mức thật VNDIRECT).
    // F-1115-06 (fixbug #111): chú thích đủ — marginRoom bị kẹp Math.max(0,·):
    // khi marginUsed > mv×RATIO (vượt ký quỹ) phần âm KHÔNG trừ thẳng vào cash
    // (sức mua không đi dưới tiền mặt).
    const MARGIN_ROOM_RATIO = 0.5;
    const cashBalance = Number(account.cashBalance);
    const marginRoom = Math.round(
      totalMarketValue * MARGIN_ROOM_RATIO - Number(account.marginUsed),
    );
    const buyingPower = cashBalance + Math.max(0, marginRoom);

    return NextResponse.json(
      toPlain({
        account: {
          broker: account.broker,
          accountNumber: maskAccount(account.accountNumber),
          accountType: account.accountType,
          cashBalance: account.cashBalance,
          equity: Number(account.cashBalance) + totalMarketValue, // F-102 (audit 19-a): tính lại thay vì snapshot seed
          marginUsed: account.marginUsed,
          currency: account.currency,
          status: account.status,
        },
        positions,
        totals: {
          totalMarketValue,
          totalCostBasis,
          totalUnrealizedPnl,
          totalUnrealizedPnlPct:
            totalCostBasis > 0 ? (totalUnrealizedPnl / totalCostBasis) * 100 : 0,
          totalRealizedPnl,
          totalEquity: Number(account.cashBalance) + totalMarketValue,
          dayChangePct,
        },
        /** #110 M4.1 — UIUX_UPGRADE_BLUEPRINT: curve + sức mua cho tier-1. */
        equityCurve,
        buyingPower,
      })
    );
  } catch (err) {
    console.error("[api/portfolio]", err);
    return NextResponse.json(
      { error: "Không tải được dữ liệu danh mục." },
      { status: 500 }
    );
  }
}
