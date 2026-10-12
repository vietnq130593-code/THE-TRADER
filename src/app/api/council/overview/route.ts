import { NextRequest, NextResponse } from "next/server";
import { toPlain } from "@/lib/serialize";
import { db } from "@/lib/db";
import { getDecisionLedger } from "@/lib/council/decision-eval";
// #107 E-EXEC: vị thế phi-VN đánh giá theo luật thị trường (quy VND / danh nghĩa idx).
import { markPositionVND, execUnitLabel, isForeignMarket, usdVndRate } from "@/lib/exec/market-rules";
import { unitKindOf } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * GET /api/council/overview (#106 COUNCIL_STEWARDSHIP_BLUEPRINT §6 · hiệu
 * chỉnh v2.0 #107 — bỏ (3) thí nghiệm phân bổ E-ALLOC).
 *
 * Một cửa cho module "Hội đồng": (1) tài khoản sandbox K1 — equity/cash/
 * P&L từ lúc kích hoạt + đường cong CashSnapshot k1-daily + vị thế đang mở
 * MỌI THỊ TRƯỜNG với lãi/lỗ chưa thực hiện (quy VND; USD kèm tỷ giá quy đổi);
 * (2) sổ đánh giá quyết định D-LEDGER (rows + stats).
 *
 * Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD — lọc sổ quyết định theo decidedAt
 * theo NGÀY ICT +07:00 (pattern #101/#105).
 */

function ictDayStart(date: string): Date {
  return new Date(`${date}T00:00:00+07:00`);
}

function ictDayEnd(date: string): Date {
  return new Date(`${date}T23:59:59.999+07:00`);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const fromRaw = sp.get("from");
    const toRaw = sp.get("to");
    if ((fromRaw && !DATE_RE.test(fromRaw)) || (toRaw && !DATE_RE.test(toRaw))) {
      return NextResponse.json(
        { error: "from/to phải là ngày YYYY-MM-DD (ngày ICT +07:00)." },
        { status: 422 }
      );
    }
    if (fromRaw && toRaw && toRaw < fromRaw) {
      return NextResponse.json(
        { error: "to phải ≥ from." },
        { status: 422 }
      );
    }
    const from = fromRaw ? ictDayStart(fromRaw) : undefined;
    const to = toRaw ? ictDayEnd(toRaw) : undefined;

    // ── (1) Tài khoản sandbox K1 + đường cong + vị thế ──
    const [account, kSetting] = await Promise.all([
      db.brokerAccount.findFirst({
        where: { accountType: "sandbox", deletedAt: null },
      }),
      db.appSetting.findUnique({ where: { key: "k-sandbox" } }),
    ]);
    let accountView: Record<string, unknown> = { configured: false };
    if (account) {
      const setting = (() => {
        try {
          return kSetting?.value ? JSON.parse(kSetting.value) : null;
        } catch {
          return null;
        }
      })();
      const initial = typeof setting?.initialAmount === "number" ? setting.initialAmount : null;
      const snaps = await db.cashSnapshot.findMany({
        where: { brokerAccountId: account.id, source: "k1-daily" },
        orderBy: { createdAt: "desc" },
        take: 60,
        select: { equity: true, createdAt: true },
      });
      const positions = await db.position.findMany({
        where: { status: "OPEN", brokerAccountId: account.id },
        include: {
          instrument: {
            select: { id: true, symbol: true, market: true, type: true, currency: true },
          },
        },
      });
      const fx = await usdVndRate().catch(() => null);
      const positionViews = [];
      for (const p of positions) {
        const lastBar = await db.bar.findFirst({
          where: { instrumentId: p.instrument.id },
          orderBy: { date: "desc" },
          select: { close: true },
        });
        const last = lastBar?.close ?? null;
        // #107 E-EXEC: đánh giá theo luật thị trường — VN giữ công thức cũ,
        // phi-VN quy VND (PRICE) / danh nghĩa idx (NOTIONAL).
        const mark = await markPositionVND({
          quantity: p.quantity,
          avgPrice: p.avgPrice,
          avgCostVND: p.avgCostVND,
          openIdxUnits: p.openIdxUnits,
          instrument: p.instrument,
          lastNative: last ?? p.avgPrice,
        }).catch(() => null);
        const isForeign = isForeignMarket(p.instrument.market);
        positionViews.push({
          symbol: p.instrument.symbol,
          market: p.instrument.market,
          currency: p.instrument.currency ?? "VND",
          unitKind: unitKindOf(p.instrument.market, p.instrument.type),
          unitLabel: execUnitLabel(p.instrument),
          quantity: p.quantity,
          avgPrice: p.avgPrice,
          lastPrice: last,
          unrealizedPnl: mark?.unrealisedVND ?? (last != null ? (last - p.avgPrice) * p.quantity : null),
          marketValue: mark?.valueVND ?? (last != null ? last * p.quantity : null),
          fxRate: isForeign ? mark?.fxRate ?? fx : null,
        });
      }
      const equity = Number(account.equity);
      const cash = Number(account.cashBalance);
      const pnl = initial != null ? equity - initial : null;
      // biến động ngày: snapshot k1-daily cuối vs kế cuối
      const eq = snaps.map((s) => Number(s.equity)).reverse();
      const dayChange =
        eq.length >= 2 ? eq[eq.length - 1] - eq[eq.length - 2] : null;
      accountView = {
        configured: true,
        equity,
        cash,
        initial,
        activatedAt: setting?.activatedAt ?? null,
        pnlSinceActivation: pnl,
        pnlPctSinceActivation:
          pnl != null && initial ? (pnl / initial) * 100 : null,
        dayChange,
        equityCurve: snaps
          .map((s) => ({ createdAt: s.createdAt.toISOString(), equity: Number(s.equity) }))
          .reverse(),
        positions: positionViews,
      };
    }

    // ── (2) Sổ đánh giá quyết định ──
    const decisions = await getDecisionLedger(from, to, 60);

    return NextResponse.json(
      toPlain({
        account: accountView,
        decisions,
        meta: {
          range: { from: fromRaw ?? null, to: toRaw ?? null },
          evaluatedAt: new Date().toISOString(),
        },
      })
    );
  } catch (err) {
    console.error("[api/council/overview GET]", err);
    return NextResponse.json(
      { error: "Không tải được tổng quan Hội đồng — thử lại sau." },
      { status: 500 }
    );
  }
}
