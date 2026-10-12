import { NextRequest, NextResponse } from "next/server";
import { toPlain } from "@/lib/serialize";
import { db } from "@/lib/db";
import { getDecisionLedger } from "@/lib/council/decision-eval";

export const dynamic = "force-dynamic";

/**
 * GET /api/council/overview (#106 COUNCIL_STEWARDSHIP_BLUEPRINT §6).
 *
 * Một cửa cho module "Hội đồng": (1) tài khoản sandbox K1 — equity/cash/
 * P&L từ lúc kích hoạt + đường cong CashSnapshot k1-daily + vị thế đang mở
 * với lãi/lỗ chưa thực hiện; (2) sổ đánh giá quyết định D-LEDGER (rows +
 * stats); (3) thí nghiệm phân bổ (đang chạy + đã đóng, kèm snapshot cho
 * sparkline và kết quả + bài học).
 *
 * Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD — lọc sổ quyết định theo decidedAt
 * và thí nghiệm theo startedAt theo NGÀY ICT +07:00 (pattern #101/#105).
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
        include: { instrument: { select: { id: true, symbol: true } } },
      });
      const positionViews = await Promise.all(
        positions.map(async (p) => {
          const lastBar = await db.bar.findFirst({
            where: { instrumentId: p.instrument.id },
            orderBy: { date: "desc" },
            select: { close: true },
          });
          const last = lastBar?.close ?? null;
          return {
            symbol: p.instrument.symbol,
            quantity: p.quantity,
            avgPrice: p.avgPrice,
            lastPrice: last,
            unrealizedPnl: last != null ? (last - p.avgPrice) * p.quantity : null,
          };
        })
      );
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

    // ── (3) Thí nghiệm phân bổ ──
    const expWhere = {
      startedAt: {
        ...(from ? { gte: from } : {}),
        ...(to ? { lte: to } : {}),
      },
    };
    const [runningExps, doneExps] = await Promise.all([
      db.allocationExperiment.findMany({
        where: { status: "RUNNING", ...expWhere },
        orderBy: { startedAt: "desc" },
        take: 10,
        include: { snapshots: { orderBy: { date: "asc" } } },
      }),
      db.allocationExperiment.findMany({
        where: { status: { in: ["DONE", "STOPPED"] }, ...expWhere },
        orderBy: { endedAt: "desc" },
        take: 10,
        include: { snapshots: { orderBy: { date: "asc" } } },
      }),
    ]);
    const toExperimentView = (e: (typeof runningExps)[number]) => ({
      id: e.id,
      name: e.name,
      hypothesis: e.hypothesis,
      weights: (() => {
        try {
          return JSON.parse(e.weightsJson);
        } catch {
          return [];
        }
      })(),
      capitalVND: Number(e.capitalVND),
      horizonDays: e.horizonDays,
      startedAt: e.startedAt.toISOString(),
      status: e.status,
      createdBy: e.createdBy,
      endedAt: e.endedAt?.toISOString() ?? null,
      daysRun: e.snapshots.length,
      latest: e.snapshots.length
        ? {
            date: e.snapshots[e.snapshots.length - 1].date.toISOString(),
            equityVND: Number(e.snapshots[e.snapshots.length - 1].equityVND),
            returnPct: e.snapshots[e.snapshots.length - 1].returnPct,
          }
        : null,
      snapshots: e.snapshots.slice(-90).map((s) => ({
        date: s.date.toISOString(),
        returnPct: s.returnPct,
      })),
      result:
        e.status === "DONE" || e.status === "STOPPED"
          ? {
              finalEquityVND: e.finalEquityVND != null ? Number(e.finalEquityVND) : null,
              returnPct: e.returnPct,
              maxDrawdownPct: e.maxDrawdownPct,
              sharpe: e.sharpe,
              perBasket: (() => {
                try {
                  return e.perBasketJson ? JSON.parse(e.perBasketJson) : null;
                } catch {
                  return null;
                }
              })(),
              lesson: e.lesson,
            }
          : null,
    });

    return NextResponse.json(
      toPlain({
        account: accountView,
        decisions,
        experiments: {
          running: runningExps.map(toExperimentView),
          closed: doneExps.map(toExperimentView),
        },
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
