import { NextRequest, NextResponse } from "next/server";
import { toPlain } from "@/lib/serialize";
import { db } from "@/lib/db";
import { getDecisionLedger } from "@/lib/council/decision-eval";
// #107 E-EXEC: vị thế phi-VN đánh giá theo luật thị trường (quy VND / danh nghĩa idx).
import { markPositionVND, execUnitLabel, isForeignMarket, usdVndRate } from "@/lib/exec/market-rules";
import { unitKindOf } from "@/lib/format";
// F-1112-01 (fixbug #111 — P1): equity live-mark cùng nguồn với /api/k/sandbox.
import { computeSandboxEquity } from "@/lib/k-sandbox";
// F-1091-01c (fixbug api #109): đưa isValidIctDay/ictDayStart/ictDayEnd về
// nguồn chia sẻ src/lib/api-dates.ts. Nâng cấp so với fix F-1081-01: thêm
// round-trip UTC — bắt thêm "2026-02-30" (JS roll-over sang 03-02, không
// NaN → fix cũ cho qua → lọc sai khoảng im lặng — cùng lớp F-63C-09).
import { isValidIctDay, ictDayStart, ictDayEnd } from "@/lib/api-dates";

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

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const fromRaw = sp.get("from");
    const toRaw = sp.get("to");
    if ((fromRaw && !isValidIctDay(fromRaw)) || (toRaw && !isValidIctDay(toRaw))) {
      return NextResponse.json(
        { error: "from/to phải là ngày YYYY-MM-DD hợp lệ (ngày ICT +07:00)." },
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
      // F-1112-01 (fixbug #111 — P1): P&L "từ lúc kích hoạt" phải CÙNG công thức
      // với /api/k/sandbox (K1 sở hữu tài khoản sandbox): equity live-mark qua
      // computeSandboxEquity (cash + vị thế đánh giá giá mới nhất) và trừ
      // topupTotal (#88 — nạp thêm là tiền VÀO, không phải lãi). Trước fix dùng
      // cột DB account.equity (chỉ cập nhật lúc khớp lệnh) + không trừ topup →
      // 2 màn hình trả 2 số mâu thuẫn cùng lúc cho cùng tài khoản (council
      // −4.905₫ vs sandbox +25.095₫).
      // F-1114-02 (fixbug #111): fallback khi engine equity lỗi — khớp k/sandbox
      // (cashBalance) thay vì cột DB equity, 2 route fail-soft cùng giá trị.
      const eqLive = await computeSandboxEquity(account.id).catch(() => null);
      const equity = eqLive?.equity ?? Number(account.cashBalance);
      const cash = eqLive?.cash ?? Number(account.cashBalance);
      // #88 — tổng nạp thêm từ lúc kích hoạt (pattern k/sandbox route).
      const since = setting?.activatedAt ? new Date(setting.activatedAt) : null;
      const topupAudits = await db.auditLog
        .findMany({
          where: {
            action: "K1_SANDBOX_TOPUP",
            entity: "BrokerAccount",
            entityId: account.id,
            ...(since ? { createdAt: { gte: since } } : {}),
          },
          select: { after: true },
        })
        .catch(() => [] as { after: string | null }[]);
      let topupTotal = 0;
      for (const a of topupAudits) {
        try {
          topupTotal += Number((JSON.parse(a.after ?? "{}") as { amount?: unknown }).amount) || 0;
        } catch {
          // malformed audit — bỏ qua (fail-soft)
        }
      }
      const netInvested = initial != null ? initial + topupTotal : null;
      const pnl = netInvested != null && netInvested > 0 ? equity - netInvested : null;
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
          pnl != null && netInvested ? (pnl / netInvested) * 100 : null,
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
