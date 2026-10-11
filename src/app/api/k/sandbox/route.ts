import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";
import {
  K1_SNAPSHOT_SOURCE,
  activateSandbox,
  computeSandboxEquity,
  getKSandbox,
  getSandboxAccount,
  resetSandbox,
  setSandboxPaused,
  topupSandbox,
} from "@/lib/k-sandbox";

export const dynamic = "force-dynamic";

/**
 * GET/POST /api/k/sandbox — K1 "Cơ chế thử nghiệm tiền ảo" (AUTONOMY_BLUEPRINT
 * v1.1 §5.2 — faucet & vòng đời tiền).
 *
 * GET: trạng thái đầy đủ cho khối Settings "Cơ chế thử nghiệm": setting
 *      k-sandbox + tài khoản (cash/equity/P&L từ lúc kích hoạt) + chuỗi
 *      CashSnapshot (đồ thị equity mini) + đếm lệnh auto + mốc settle gần nhất.
 *      Sandbox chưa kích hoạt → mọi trường rỗng trung thực (enabled:false).
 *
 * POST body {action, amount?}:
 *   - "activate" {amount ≥ 10tr, bội 100k} → tạo/tái bật + K1_SANDBOX_FUNDED
 *   - "topup"   {amount ≥ 1tr}             → + K1_SANDBOX_TOPUP
 *   - "reset"   (UI xác nhận 2 bước phía client) → xoá sạch + K1_SANDBOX_RESET
 *   - "pause" / "resume"                    → dừng/tiếp tục auto-convert
 *
 * Tách bạch P0: route KHÔNG bao giờ chạm tài khoản paper (mọi thao tác scoped
 * accountType "sandbox" — xem lib/k-sandbox.ts).
 */

async function buildState() {
  const s = await getKSandbox();
  const account = s.enabled ? await getSandboxAccount() : null;

  let accountView: {
    accountNumber: string;
    cash: number;
    equity: number;
    unrealisedPnl: number;
    realisedPnlTotal: number;
    openCount: number;
  } | null = null;
  let pnlSinceActivation: number | null = null;
  let pnlPctSinceActivation: number | null = null;
  let sessionsRun = 0;
  let autoOrderCount = 0;
  let lastSettleAt: string | null = null;
  let snapshots: { cash: number; equity: number; createdAt: string }[] = [];

  if (account) {
    const eq = await computeSandboxEquity(account.id);
    const closedAgg = await db.position
      .aggregate({
        where: { brokerAccountId: account.id, status: "CLOSED" },
        _sum: { realizedPnl: true },
      })
      .catch(() => null);
    accountView = {
      accountNumber: account.accountNumber,
      cash: eq?.cash ?? Number(account.cashBalance),
      equity: eq?.equity ?? Number(account.cashBalance),
      unrealisedPnl: eq?.unrealisedPnl ?? 0,
      realisedPnlTotal: Number(closedAgg?._sum.realizedPnl ?? 0),
      openCount: eq?.openCount ?? 0,
    };
    if (s.initialAmount > 0) {
      pnlSinceActivation = accountView.equity - s.initialAmount;
      pnlPctSinceActivation = (pnlSinceActivation / s.initialAmount) * 100;
    }
    // Chuỗi equity (30 điểm gần nhất — đồ thị mini §5.6) + số phiên đã chạy.
    const snaps = await db.cashSnapshot.findMany({
      where: { brokerAccountId: account.id, source: K1_SNAPSHOT_SOURCE },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: { cash: true, equity: true, createdAt: true },
    });
    sessionsRun = await db.cashSnapshot.count({
      where: { brokerAccountId: account.id, source: K1_SNAPSHOT_SOURCE },
    });
    snapshots = snaps
      .map((x) => ({
        cash: Number(x.cash),
        equity: Number(x.equity),
        createdAt: x.createdAt.toISOString(),
      }))
      .reverse(); // cũ → mới cho đường cong
    autoOrderCount = await db.auditLog.count({
      where: { action: "K1_SANDBOX_AUTO_ORDER", entity: "Signal" },
    });
    const lastSettle = await db.auditLog.findFirst({
      where: { action: "K1_SANDBOX_SETTLED" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    lastSettleAt = lastSettle?.createdAt.toISOString() ?? null;
  }

  return toPlain({
    exists: s.enabled,
    enabled: s.enabled,
    paused: s.paused,
    activatedAt: s.activatedAt,
    initialAmount: s.initialAmount,
    sizePct: s.sizePct,
    maxOrdersPerCycle: s.maxOrdersPerCycle,
    maxBudgetPctPerCycle: s.maxBudgetPctPerCycle,
    account: accountView,
    pnlSinceActivation,
    pnlPctSinceActivation,
    sessionsRun,
    autoOrderCount,
    lastSettleAt,
    snapshots,
  });
}

export async function GET() {
  try {
    return NextResponse.json(await buildState());
  } catch (err) {
    console.error("[api/k/sandbox] GET failed:", err);
    return NextResponse.json({ error: "Không đọc được trạng thái K1." }, { status: 500 });
  }
}

interface PostBody {
  action?: unknown;
  amount?: unknown;
}

export async function POST(req: Request) {
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Body JSON không hợp lệ." }, { status: 400 });
  }
  const action = typeof body.action === "string" ? body.action : "";
  const amount = typeof body.amount === "number" ? body.amount : NaN;

  try {
    if (action === "activate") {
      const res = await activateSandbox(amount);
      if (!res.ok) {
        return NextResponse.json({ error: res.error }, { status: res.status });
      }
      return NextResponse.json(await buildState());
    }
    if (action === "topup") {
      const res = await topupSandbox(amount);
      if (!res.ok) {
        return NextResponse.json({ error: res.error }, { status: res.status });
      }
      return NextResponse.json(await buildState());
    }
    if (action === "reset") {
      const res = await resetSandbox();
      if (!res.ok) {
        return NextResponse.json({ error: res.error }, { status: res.status });
      }
      return NextResponse.json(await buildState());
    }
    if (action === "pause" || action === "resume") {
      const res = await setSandboxPaused(action === "pause");
      if (!res.ok) {
        return NextResponse.json({ error: res.error }, { status: res.status });
      }
      return NextResponse.json(await buildState());
    }
    return NextResponse.json(
      { error: 'action phải là "activate", "topup", "reset", "pause" hoặc "resume".' },
      { status: 422 }
    );
  } catch (err) {
    console.error("[api/k/sandbox] POST failed:", err);
    return NextResponse.json({ error: "Thao tác K1 thất bại." }, { status: 500 });
  }
}
