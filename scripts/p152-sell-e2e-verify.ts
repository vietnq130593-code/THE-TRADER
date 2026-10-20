/**
 * scripts/p152-sell-e2e-verify.ts — E2E ĐƯỜNG BÁN (Task 152 · F-151-1/-2/-3)
 *
 * Mục đích: chứng minh cơ chế BÁN chạy HẾT ĐƯỜNG RAY trong môi trường kiểm
 * soát — synth tín hiệu đồng thuận khớp hướng → auto-duyệt #91 → lệnh giấy
 * LIMIT → fill engine khớp (F-206) → Position/realized P&L/thuế/phí/Trade/
 * AuditLog — cùng lúc hồi quy GUARD MỚI F-151-1 (hướng số đông) và F-151-2
 * (stop/take cho SELL).
 *
 * CÁCH LY (KHÔNG đụng DB production): chạy trong SCHEMA Postgres scratch
 * `p152e2e` trên cùng DB Supabase — bảng riêng, dữ liệu riêng, xoá sạch sau
 * chạy. Guard đầu main() từ chối chạy nếu DATABASE_URL thiếu "p152e2e".
 *
 * Điều phối (bash — xem worklog Task 152):
 *   1. CREATE SCHEMA IF NOT EXISTS "p152e2e";            (prisma db execute)
 *   2. DATABASE_URL="<url>?schema=p152e2e" bunx prisma db push --skip-generate
 *   3. DATABASE_URL="<url>?schema=p152e2e" bun scripts/p152-sell-e2e-verify.ts
 *   4. DROP SCHEMA IF EXISTS "p152e2e" CASCADE;          (prisma db execute)
 *
 * LƯU Ý raw SQL `trader."BrokerAccount" ... FOR UPDATE` (AUDIT 137 C9) trong
 * fill engine hardcode schema trader — khi chạy ở schema scratch nó select
 * id không tồn tại bên production (không khoá dòng nào, không ghi gì) → vô
 * hại, chỉ mất hiệu lực row-lock trong môi trường verify đơn luồng.
 */

import { db } from "../src/lib/db";
import { autoDecideSignalByConsensus, createPaperOrderFromSignal } from "../src/lib/signal-execution";
import { persistSignalAndExecution } from "../src/lib/agents-run/persist";
import { autoConvertSignalToSandbox } from "../src/lib/k-sandbox";
import { EXECUTOR_CODE, CHAIRMAN_CODE } from "../src/lib/agents-run/prepare";
import { POST as tickPost } from "../src/app/api/market/tick/route";
import type { MarketSnapshot } from "../src/lib/agent-context";
import type { ControlVerdicts, CycleRunState } from "../src/lib/agents-run/agent-loop";
import type { MarketAssessmentView } from "../src/lib/types";

/* ─────────────────── Kỳ vọng tài chính (tính tay để đối chiếu) ───────────────────
 * Giá TCB last=30.000 · ref=30.000 · sàn 27.900 · trần 32.100 (±7%).
 * Paper: cash 100.000.000 + vị thế TCB 700 cp @ 28.000.
 *   equity = 100M + 700×30.000 = 121M → nav5pct: rawQty = ⌊121M×5%/30.000⌋ = 201
 *   → lot 200 → cap theo vị thế 700 → qty 200 · price = max(29.700, 0,99×30.000)
 *   = 29.700 (LIMIT, kẹp dải) → SINGLE (scratch không có Bar → ADTV 0).
 * Fill 200 cp @ 29.700: fee = round(0,15%×29.700×200) = 8.910 ·
 *   tax = round(0,1%×29.700×200) = 5.940 · cash = 100M + 5.940.000 − 14.850
 *   = 105.925.150 · realized = (29.700−28.000)×200 = +340.000 · còn 500 cp.
 * ────────────────────────────────────────────────────────────────── */

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✘"} ${name} — ${detail}`);
}

async function main() {
  // Guard an toàn tuyệt đối: chỉ chạy trên schema scratch.
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("p152e2e")) {
    console.error("FATAL: DATABASE_URL phải trỏ schema scratch p152e2e — từ chối chạy (bảo vệ production).");
    console.error(`DATABASE_URL hiện tại: ${url.slice(0, 40)}…`);
    process.exit(1);
  }

  console.log("════ P152 · E2E ĐƯỜNG BÁN (schema scratch p152e2e) ════");

  /* ══ SEED ═════════════════════════════════════════════════════════ */
  const user = await db.user.create({
    data: { email: "p152@trader.local", name: "P152 Verify", passwordHash: "p152-no-login", isActive: true },
  });
  const chairman = await db.agent.create({
    data: { code: CHAIRMAN_CODE, name: "Chủ tịch P152", role: "PORTFOLIO_STRATEGIST", description: "p152" },
  });
  const executor = await db.agent.create({
    data: { code: EXECUTOR_CODE, name: "Executor P152", role: "EXECUTION_MANAGER", description: "p152" },
  });
  const now = new Date();
  const mkQuote = (last: number) => ({
    open: last, high: last, low: last, last, volume: 1_000_000,
    refPrice: last, floorPrice: Math.round(last * 0.93 / 100) * 100,
    ceilingPrice: Math.round(last * 1.07 / 100) * 100,
    bidPrice: last - 100, askPrice: last + 100, bidVolume: 5000, askVolume: 5000,
    tradedAt: now,
  });
  const tcb = await db.instrument.create({
    data: { symbol: "TCB", name: "Techcombank P152", market: "HOSE", type: "STOCK", currency: "VND", isActive: true, quotes: { create: mkQuote(30_000) } },
    include: { quotes: { orderBy: { tradedAt: "desc" }, take: 1 } },
  });
  const fpt = await db.instrument.create({
    data: { symbol: "FPT", name: "FPT Corp P152", market: "HOSE", type: "STOCK", currency: "VND", isActive: true, quotes: { create: mkQuote(50_000) } },
  });
  await db.appSetting.create({
    data: { key: "consensus", value: JSON.stringify({ enforce: true, autoEnableAfter: 10 }) },
  });
  await db.appSetting.create({
    data: {
      key: "k-sandbox",
      value: JSON.stringify({ enabled: true, paused: false, activatedAt: now.toISOString(), initialAmount: 50_000_000, sizePct: 5, maxOrdersPerCycle: 5, maxBudgetPctPerCycle: 10 }),
    },
  });
  const paper = await db.brokerAccount.create({
    data: { userId: user.id, accountNumber: "P152-PAPER", accountType: "basic", cashBalance: 100_000_000, equity: 121_000_000 },
  });
  const sandbox = await db.brokerAccount.create({
    data: { userId: user.id, accountNumber: "SANDBOX-K1", accountType: "sandbox", cashBalance: 50_000_000, equity: 71_000_000 },
  });
  await db.position.create({
    data: { brokerAccountId: paper.id, instrumentId: tcb.id, quantity: 700, avgPrice: 28_000, status: "OPEN" },
  });
  await db.position.create({
    data: { brokerAccountId: sandbox.id, instrumentId: tcb.id, quantity: 700, avgPrice: 28_000, status: "OPEN" },
  });
  console.log("SEED xong: user/agents/TCB/FPT/2 tài khoản/2 vị thế/AppSettings.");

  /* ══ PHASE A — persistSignalAndExecution: F-151-2 + bind dominant ══ */
  const state = {
    byCode: new Map([
      [EXECUTOR_CODE, { id: executor.id, code: EXECUTOR_CODE, config: "{}", healthScore: 100, status: "IDLE" as const }],
      [CHAIRMAN_CODE, { id: chairman.id, code: CHAIRMAN_CODE, config: "{}", healthScore: 100, status: "IDLE" as const }],
    ]),
    analyses: new Map(),
    createdMessages: [],
    failures: [],
  } as unknown as CycleRunState;
  const veto = { vetoExposure: false, vetoCompliance: false, vetoBlocked: false, controlMissing: [], controlUnavailable: false } as ControlVerdicts;
  const market = { instrumentIdBySymbol: new Map([["TCB", tcb.id], ["FPT", fpt.id]]) } as unknown as MarketSnapshot;
  const bayesView = {
    consensus: { gate: "CONSENSUS", ratio: 0.85, dominant: "DOWN", gateLabel: "ĐỒNG THUẬN (≥ 80%)", tally: [], present: 7, shadow: false, wouldBlock: false, note: "p152" },
  } as unknown as MarketAssessmentView;
  const strategist = {
    summary: "p152", recommendation: "BÁN TCB", confidence: "HIGH" as const,
    signal: {
      symbol: "TCB", direction: "SELL" as const, confidence: "HIGH" as const, score: 72,
      rationale: "p152 E2E — đồng thuận DOWN 85%", targetPrice: 29_700, stopLoss: 31_500, takeProfit: 28_500,
    },
    allocation: null,
  };

  const execWave = await persistSignalAndExecution(state, strategist, state.byCode.get(CHAIRMAN_CODE)!, market, ["p152 digest"], veto, bayesView);
  const sigA = execWave.createdSignal
    ? await db.signal.findUnique({ where: { id: execWave.createdSignal.id } })
    : null;
  check(
    "A1 · persist bind consensusDominant=DOWN (F-151-1)",
    sigA?.consensusDominant === "DOWN",
    `dominant=${sigA?.consensusDominant ?? "?"} · gate=${sigA?.consensusGate ?? "?"} · ratio=${sigA?.consensusRatio ?? "?"}`
  );
  check(
    "A2 · SELL lưu stopLoss/takeProfit (F-151-2)",
    sigA?.stopLoss === 31_500 && sigA?.takeProfit === 28_500,
    `stop=${sigA?.stopLoss ?? "?"} · take=${sigA?.takeProfit ?? "?"} · target=${sigA?.targetPrice ?? "?"}`
  );
  check("A3 · tín hiệu ACTIVE chờ auto-decision", sigA?.status === "ACTIVE", `status=${sigA?.status}`);

  /* ══ PHASE B — auto-decision #91 duyệt SELL khớp hướng → lệnh giấy ══ */
  const decision = await autoDecideSignalByConsensus(sigA!.id);
  check(
    "B1 · auto-decision DUYỆT (SELL + CONSENSUS + DOWN)",
    decision.decision === "approved",
    `decision=${decision.decision} · note=${decision.note.slice(0, 110)}`
  );
  const ordersA = await db.order.findMany({ where: { signalId: sigA!.id }, orderBy: { createdAt: "asc" } });
  const totalQty = ordersA.reduce((s, o) => s + o.quantity, 0);
  const firstOrder = ordersA[0];
  check(
    "B2 · lệnh SELL LIMIT qty 200 @ 29.700 (nav5pct · cap vị thế · kẹp dải)",
    ordersA.length >= 1 && firstOrder.side === "SELL" && firstOrder.type === "LIMIT" && totalQty === 200 && firstOrder.price === 29_700 && firstOrder.status === "PENDING",
    `orders=${ordersA.length} · side=${firstOrder?.side} · qty=${totalQty} · price=${firstOrder?.price} · status=${firstOrder?.status}`
  );
  check(
    "B3 · lệnh thuộc tài khoản PAPER (không sandbox)",
    ordersA.every((o) => o.brokerAccountId === paper.id),
    `brokerAccountId khớp paper: ${ordersA.every((o) => o.brokerAccountId === paper.id)}`
  );
  const auditApproved = await db.auditLog.findFirst({ where: { action: "SIGNAL_AUTO_APPROVED", entityId: sigA!.id } });
  check(
    "B4 · audit SIGNAL_AUTO_APPROVED orderCreated:true",
    auditApproved != null && (JSON.parse(auditApproved.after as string) as { orderCreated?: boolean }).orderCreated === true,
    (auditApproved?.after ?? "").slice(0, 90)
  );
  const sigAAfter = await db.signal.findUnique({ where: { id: sigA!.id } });
  check("B5 · tín hiệu đóng ACTED (không treo ACTIVE)", sigAAfter?.status === "ACTED", `status=${sigAAfter?.status}`);

  /* ══ PHASE C — FILL ENGINE E2E (F-151-3): tick → khớp → sổ ══ */
  let filled = false;
  let lastTickJson = "";
  for (let i = 1; i <= 12 && !filled; i++) {
    const res = await tickPost();
    lastTickJson = JSON.stringify(await res.json());
    const o = await db.order.findFirst({ where: { id: firstOrder.id } });
    filled = o?.status === "FILLED";
  }
  const orderFilled = await db.order.findUnique({ where: { id: firstOrder.id } });
  check(
    "C1 · fill engine khớp lệnh SELL (last ≥ 29.700)",
    orderFilled?.status === "FILLED" && orderFilled.filledQuantity === 200 && orderFilled.avgFillPrice === 29_700,
    `status=${orderFilled?.status} · filled=${orderFilled?.filledQuantity} · avg=${orderFilled?.avgFillPrice} · lastTick=${lastTickJson.slice(0, 80)}`
  );
  const trade = await db.trade.findFirst({ where: { orderId: firstOrder.id } });
  const expFee = Math.round(0.0015 * 29_700 * 200);
  const expTax = Math.round(0.001 * 29_700 * 200);
  check(
    "C2 · Trade: fee 0,15% (8.910) + thuế bán 0,1% (5.940)",
    trade != null && Number(trade.fee) === expFee && Number(trade.tax) === expTax && trade.side === "SELL" && trade.quantity === 200 && trade.price === 29_700,
    `fee=${Number(trade?.fee ?? -1)} (kỳ vọng ${expFee}) · tax=${Number(trade?.tax ?? -1)} (kỳ vọng ${expTax})`
  );
  const posAfter = await db.position.findUnique({ where: { brokerAccountId_instrumentId: { brokerAccountId: paper.id, instrumentId: tcb.id } } });
  check(
    "C3 · Position giảm 700→500 + realizedPnl +340.000",
    posAfter?.quantity === 500 && Number(posAfter?.realizedPnl) === 340_000 && posAfter?.status === "OPEN",
    `qty=${posAfter?.quantity} · realized=${Number(posAfter?.realizedPnl ?? -1)} (kỳ vọng +340.000)`
  );
  const paperAfter = await db.brokerAccount.findUnique({ where: { id: paper.id } });
  check(
    "C4 · cash = 105.925.150 (notional − phí − thuế)",
    Number(paperAfter?.cashBalance) === 105_925_150,
    `cash=${Number(paperAfter?.cashBalance)} (kỳ vọng 105.925.150)`
  );
  const fillAudit = await db.auditLog.findFirst({ where: { action: "ORDER_FILLED", entityId: firstOrder.id } });
  check("C5 · audit ORDER_FILLED", fillAudit != null, (fillAudit?.after ?? "").slice(0, 90));
  check(
    "C6 · equity recompute = cash + 500×last (~121M)",
    paperAfter != null && Number(paperAfter.equity) > 120_000_000 && Number(paperAfter.equity) < 122_000_000,
    `equity=${Number(paperAfter?.equity ?? -1)}`
  );

  /* ══ PHASE D — GUARD F-151-1: hướng lệch → TỪ CHỐI ══ */
  const mkSignal = async (direction: "BUY" | "SELL", instrumentId: string, dominant: string | null) =>
    db.signal.create({
      data: {
        instrumentId, direction, confidence: "HIGH", score: 70, rationale: "p152-guard",
        agentId: chairman.id, status: "ACTIVE",
        consensusGate: "CONSENSUS", consensusRatio: 0.85,
        ...(dominant != null ? { consensusDominant: dominant } : {}),
        targetPrice: direction === "SELL" ? 29_700 : 30_300,
      },
    });

  // D1: SELL khi hội đồng đồng thuận ĐI NGANG (kẽ F-151-1 gốc — phải bị chặn)
  const d1 = await mkSignal("SELL", tcb.id, "FLAT");
  const dec1 = await autoDecideSignalByConsensus(d1.id);
  const d1Row = await db.signal.findUnique({ where: { id: d1.id } });
  check(
    "D1 · SELL + dominant FLAT → TỪ CHỐI (đóng kẽ F-151-1)",
    dec1.decision === "rejected" && d1Row?.status === "REJECTED" && (d1Row?.rejectNote ?? "").includes("đi ngang"),
    `decision=${dec1.decision} · status=${d1Row?.status} · note=${(d1Row?.rejectNote ?? "").slice(0, 120)}`
  );
  const auditD1 = await db.auditLog.findFirst({ where: { action: "SIGNAL_AUTO_REJECTED", entityId: d1.id } });
  check(
    "D1b · audit reason=consensus-direction-mismatch",
    auditD1 != null && (JSON.parse(auditD1.after as string) as { reason?: string }).reason === "consensus-direction-mismatch",
    (auditD1?.after ?? "").slice(0, 100)
  );

  // D2: BUY khi số đông DOWN (ngược hướng — đối xứng cũng phải chặn)
  const d2 = await mkSignal("BUY", tcb.id, "DOWN");
  const dec2 = await autoDecideSignalByConsensus(d2.id);
  const d2Row = await db.signal.findUnique({ where: { id: d2.id } });
  check(
    "D2 · BUY + dominant DOWN → TỪ CHỐI (guard đối xứng)",
    dec2.decision === "rejected" && d2Row?.status === "REJECTED",
    `decision=${dec2.decision} · note=${(d2Row?.rejectNote ?? "").slice(0, 100)}`
  );

  // D3: thiếu snapshot dominant (tín hiệu cũ trước fix) → fail-safe từ chối
  const d3 = await mkSignal("SELL", tcb.id, null);
  const dec3 = await autoDecideSignalByConsensus(d3.id);
  const d3Row = await db.signal.findUnique({ where: { id: d3.id } });
  const auditD3 = await db.auditLog.findFirst({ where: { action: "SIGNAL_AUTO_REJECTED", entityId: d3.id } });
  check(
    "D3 · SELL + dominant NULL → TỪ CHỐI fail-safe",
    dec3.decision === "rejected" &&
      d3Row?.status === "REJECTED" &&
      auditD3 != null && (JSON.parse(auditD3.after as string) as { reason?: string }).reason === "missing-dominant-snapshot",
    `decision=${dec3.decision} · reason=${(JSON.parse(auditD3?.after ?? "{}") as { reason?: string }).reason ?? "?"}`
  );

  // D4: SELL khớp hướng nhưng KHÔNG có vị thế (FPT) → duyệt + lệnh bị guard P3 chặn
  const d4 = await mkSignal("SELL", fpt.id, "DOWN");
  const dec4 = await autoDecideSignalByConsensus(d4.id);
  const auditD4 = await db.auditLog.findFirst({ where: { action: "SIGNAL_AUTO_APPROVED", entityId: d4.id } });
  const d4Orders = await db.order.count({ where: { signalId: d4.id } });
  check(
    "D4 · SELL FPT (đủ hướng, không vị thế) → duyệt + orderCreated:false (guard P3)",
    dec4.decision === "approved" &&
      auditD4 != null && (JSON.parse(auditD4.after as string) as { orderCreated?: boolean }).orderCreated === false &&
      d4Orders === 0,
    `decision=${dec4.decision} · orders=${d4Orders} · orderError=${((JSON.parse(auditD4?.after ?? "{}") as { orderError?: string }).orderError ?? "").slice(0, 80)}`
  );

  /* ══ PHASE E — K1 sandbox auto-convert tôn trọng hướng ══ */
  // E1: dominant FLAT → skip có lý do
  const e1 = await mkSignal("SELL", tcb.id, "FLAT");
  const e1Res = await autoConvertSignalToSandbox(e1.id);
  check(
    "E1 · K1 auto-convert BỎ QUA khi hướng lệch",
    e1Res.converted === 0 && e1Res.skipped.some((s) => s.reason.startsWith("huong-so-dong-khong-khop")),
    `skipped=${JSON.stringify(e1Res.skipped)}`
  );
  // E2: dominant DOWN → convert thành lệnh sandbox (không claim Signal)
  const e2 = await mkSignal("SELL", tcb.id, "DOWN");
  const e2Res = await autoConvertSignalToSandbox(e2.id);
  const e2Orders = await db.order.findMany({ where: { signalId: e2.id } });
  const e2Row = await db.signal.findUnique({ where: { id: e2.id } });
  const sandboxQty = e2Orders.reduce((s, o) => s + o.quantity, 0);
  // Kỳ vọng giá ĐỘNG theo quote hiện tại (Phase C đã làm giá trôi): engine tính
  // price = max(target 29.700, round100(0,99×last)) kẹp dải sàn/trần.
  const qNow = await db.quote.findFirst({ where: { instrumentId: tcb.id }, orderBy: { tradedAt: "desc" } });
  const expPrice = Math.max(
    Math.min(Math.max(29_700, Math.round(((qNow?.last ?? 30_000) * 0.99) / 100) * 100), qNow?.ceilingPrice ?? 32_100),
    qNow?.floorPrice ?? 27_900
  );
  check(
    "E2 · K1 auto-convert SELL khớp hướng → lệnh sandbox qty 100 (giá theo luật 0,99×last)",
    e2Res.converted === 1 && e2Orders.length >= 1 && sandboxQty === 100 && e2Orders[0].price === expPrice && e2Orders.every((o) => o.brokerAccountId === sandbox.id),
    `converted=${e2Res.converted} · qty=${sandboxQty} · price=${e2Orders[0]?.price} (kỳ vọng ${expPrice} · last=${qNow?.last}) · đúng tài khoản sandbox=${e2Orders.every((o) => o.brokerAccountId === sandbox.id)}`
  );
  check(
    "E3 · K1 KHÔNG claim Signal (2 thế giới độc lập — còn ACTIVE)",
    e2Row?.status === "ACTIVE",
    `status=${e2Row?.status}`
  );

  /* ══ PHASE F — guard đường MANUAL (trader bấm tay) ══ */
  const f1 = await mkSignal("SELL", tcb.id, "FLAT");
  const fRes = await createPaperOrderFromSignal(f1.id, { sizing: "nav5pct" });
  check(
    "F1 · convert TAY bị chặn 409 khi hướng lệch (đủ tầng phòng thủ)",
    fRes.ok === false && fRes.status === 409 && fRes.error.includes("chặn hướng"),
    `ok=${fRes.ok} · status=${"status" in fRes ? fRes.status : "?"} · error=${("error" in fRes ? fRes.error : "").slice(0, 120)}`
  );

  /* ══ TỔNG KẾT ══ */
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log("");
  console.log(`════ KẾT QUẢ: ${pass}/${results.length} PASS · ${fail} FAIL ════`);
  if (fail > 0) {
    console.log("Các check FAIL:");
    for (const r of results.filter((x) => !x.ok)) console.log(`  ✘ ${r.name} — ${r.detail}`);
    process.exitCode = 1;
  }
  await db.$disconnect();
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
