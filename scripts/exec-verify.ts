/**
 * scripts/exec-verify.ts — KIỂM ĐỊNH GÓI P0+P1 EXECUTION_OPS_BLUEPRINT (§5)
 * — phiên #70 (P0): E-P0-1 đơn nguồn phí + guard đơn vị · E-P0-2 ExecutionPlan +
 * guard deadline (tick phiên REV-7) · E-P0-3 ReconciliationReport 6 phép
 * idempotent (kèm order-fee-ledger REV-8 + whitelist REV-12) · E-P0-4
 * CommittedCashView (+PENDING REV-1) · E-P0-5 KPI funnel.
 * — v1.2 (P1): F=E-P1-2 TWAP tách lát (ADTV-20 1% + Order con + afterTick
 * gating) · G=E-P1-3 CashflowForecast (snapshot + OLS + kịch bản + CI) ·
 * H=E-P1-4 ChairmanScorecard (nhãn 5 phiên + precision/F1/AP + calibration) ·
 * I=E-P1-5 bất thường IQR + z-score → RiskAlert INFO · J=E-P1-1 khối phân bổ
 * (parse an toàn + config consumer G5).
 *
 * Nguyên tắc (Fixbug §5 — như p2-verify): mỗi kiểm THỰC ĐO DB THÂT + nguồn
 * file, không tin lời commentaire; cài dữ liệu test tự tạo rồi DỌN SẠCH sau
 * mỗi phần (order/trade/signal/position/cash/checkpoint/RiskAlert/snapshot).
 *
 * Cách chạy: env -u DATABASE_URL bun scripts/exec-verify.ts
 */
import { PrismaClient } from "@prisma/client";
import * as fs from "node:fs";
import {
  FEE_RATE,
  TAX_RATE,
  TWAP_ADTV_TRIGGER_PCT,
  getExecFeeTaxConfig,
  pctToFractionGuarded,
} from "../src/lib/exec/constants";
import {
  buildExecutionPlan,
  buildTwapChildPlan,
  planToNote,
  parseExecutionPlan,
  planDeadlineExceeded,
  planSliceEligible,
  inSessionElapsedTicks,
} from "../src/lib/exec/plan";
import {
  runReconciliation,
  resetReconcileCheckpoint,
  RECONCILE_CHECKPOINT_KEY,
  type ReconciliationReport,
} from "../src/lib/exec/reconciliation";
import { computeCommittedCashView } from "../src/lib/exec/committed";
import { computeExecKpi, quantile } from "../src/lib/exec/kpi";
// ── P1 (v1.2) ──
import { adtv20For, draftTwapSlices, shouldTwap, notionalPctAdtv } from "../src/lib/exec/twap";
import { createPaperOrderFromSignal } from "../src/lib/signal-execution";
import {
  recordCashSnapshot,
  computeCashflowForecast,
} from "../src/lib/exec/forecast";
import {
  buildChairmanScorecard,
  averagePrecision,
} from "../src/lib/exec/chairman-scorecard";
import {
  detectTradeAnomalies,
  raiseAnomalyAlert,
  anomalyScanSummary,
} from "../src/lib/exec/anomaly";
import {
  parseAllocationProposal,
  bumpAllocationParseFail,
  readAllocationParseFail,
  formatAllocationForMessage,
  ALLOCATION_TARGET_POSITIONS,
  ALLOCATION_REBALANCE_THRESHOLD_PCT,
  ALLOCATION_PARSE_FAIL_KEY,
} from "../src/lib/exec/allocation";

const db = new PrismaClient();

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function readSrc(rel: string): string {
  return fs.readFileSync(`src/${rel}`, "utf-8");
}

/* ═══════════════ A · E-P0-1 + E-P0-2 — hợp đồng & đơn nguồn ═══════════════ */

async function verifyContracts() {
  console.log("\n── A · E-P0-1/E-P0-2 hợp đồng: đơn nguồn phí + guard đơn vị + plan ──");

  // A1 — 3 nguồn phí cùng import 1 module, hết hardcode rải rác
  const tickSrc = readSrc("app/api/market/tick/route.ts");
  const sigSrc = readSrc("lib/signal-execution.ts");
  const constSrc = readSrc("lib/exec/constants.ts");
  check(
    "A1a tick route import từ exec/constants (không còn `const FEE_RATE = 0.0015`)",
    !tickSrc.includes("const FEE_RATE = 0.0015") &&
      !tickSrc.includes("const TAX_RATE = 0.001;") &&
      tickSrc.includes('from "@/lib/exec/constants"')
  );
  check(
    "A1b signal-execution hết literal 0.0015 + import đơn nguồn",
    !sigSrc.includes("0.0015 *") && sigSrc.includes('from "@/lib/exec/constants"')
  );
  check(
    "A1c FEE_RATE/TAX_RATE chỉ định nghĩa 1 nơi (exec/constants.ts)",
    constSrc.includes("export const FEE_RATE") && constSrc.includes("export const TAX_RATE") &&
      !tickSrc.includes("export const FEE_RATE") && !sigSrc.includes("export const FEE_RATE")
  );

  // A3 — guard đơn vị percent↔fraction (REV-2 — điều kiện bắt buộc #2)
  check(
    "A3a pctToFractionGuarded(0.15) = 0.0015 (percent → fraction đúng 100×)",
    pctToFractionGuarded(0.15, "feePct") === 0.0015
  );
  let threw = false;
  try {
    pctToFractionGuarded(15, "feePct"); // 15% → 0.15 fraction > biên 0.01 → throw
  } catch {
    threw = true;
  }
  check("A3b guard ném khi fraction vượt biên 0.01 (phát hiện sai đơn vị lệch 100×)", threw);
  threw = false;
  try {
    pctToFractionGuarded(-1, "feePct");
  } catch {
    threw = true;
  }
  check("A3c guard ném khi percent âm/không hợp lệ", threw);
  const cfg = getExecFeeTaxConfig();
  check(
    "A3d getExecFeeTaxConfig đọc roster A11: feeRate 0.0015 · taxRate 0.001 · source=roster",
    cfg.feeRate === 0.0015 && cfg.taxSellRate === 0.001 && cfg.source === "roster",
    `feePct=${cfg.feePct} taxSellPct=${cfg.taxSellPct}`
  );
  check(
    "A3e FEE_RATE/TAX_RATE khớp biểu phí VNDIRECT 0,15%/0,1%",
    FEE_RATE === 0.0015 && TAX_RATE === 0.001
  );

  // A2 — hợp đồng ExecutionPlan (build → note → parse round-trip + deadline)
  const plan = buildExecutionPlan({
    orderId: "test-order-id",
    quantity: 1000,
    price: 25_000,
    sizing: "nav5pct",
    humanNote: "Từ phê duyệt tín hiệu MUA VIC",
  });
  const note = planToNote(plan);
  const parsed = parseExecutionPlan(note);
  check(
    "A2a build → note JSON → parse round-trip đầy đủ trường",
    parsed != null &&
      parsed.kind === "ExecutionPlan" &&
      parsed.style === "SINGLE" &&
      parsed.slices.length === 1 &&
      parsed.slices[0].quantity === 1000 &&
      parsed.deadlineTicks === 1440 &&
      parsed.sizing === "nav5pct" &&
      parsed.humanNote.includes("VIC")
  );
  check(
    "A2b parse note thường (chuỗi cũ) → null; note null → null",
    parseExecutionPlan("Từ phê duyệt tín hiệu MUA VIC") === null &&
      parseExecutionPlan(null) === null &&
      parseExecutionPlan("") === null
  );
  check(
    "A2c plan mặc định: slippage 0.5% từ config A10 + deadline 1440 tick",
    plan.slippageBudgetPct === 0.5 && plan.deadlineTicks === 1440
  );

  // A2d — deadline đếm tick TRONG PHIÊN (REV-7): 2026-10-09 là thứ Sáu
  const fri = (h: number, m = 0) => new Date(`2026-10-09T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+07:00`);
  const ticks = inSessionElapsedTicks(fri(9, 15), fri(15, 30));
  check(
    "A2d 09:15→15:30 thứ 6 = 4h phiên liên tục = 1440 tick (bỏ nghỉ trưa)",
    ticks === 1440,
    `ticks=${ticks}`
  );
  check(
    "A2e 09:15→14:00 = 3,25h = 1170 tick — chưa vượt deadline 1440",
    inSessionElapsedTicks(fri(9, 15), fri(14, 0)) === 1170 &&
      !planDeadlineExceeded({ ...plan, deadlineTicks: 1440 }, fri(9, 15), fri(14, 0))
  );
  check(
    "A2f vượt deadline đúng 15:30 (1440 tick) — guard bật",
    planDeadlineExceeded({ ...plan, deadlineTicks: 1440 }, fri(9, 15), fri(15, 30))
  );
  check(
    "A2g T7→T2 không đếm tick (0 tick phiên) + nghỉ trưa bị bỏ",
    inSessionElapsedTicks(
      new Date("2026-10-10T09:15:00+07:00"),
      new Date("2026-10-12T09:15:00+07:00")
    ) === 0 &&
      inSessionElapsedTicks(fri(11, 0), fri(13, 30)) === 360
  );
}

/* ═══════════════ B · E-P0-3 — ReconciliationReport 6 phép ═══════════════ */

interface BContext {
  userId: string;
  accountId: string;
  instrumentId: string;
  sellInstrumentId: string | null;
  accountCashBefore: bigint;
  checkpointBefore: string | null;
}

async function plantFilledOrderTrade(
  ctx: BContext,
  opts: {
    side: "BUY" | "SELL";
    quantity: number;
    price: number;
    fee: bigint;
    tax: bigint;
    orderFee: bigint;
    withTrade: boolean;
    applyCash: boolean;
    applyPosition: boolean;
    sellFromQty: number;
  }
): Promise<{ orderId: string; cashDelta: bigint }> {
  const now = new Date();
  const notional = BigInt(opts.price * opts.quantity);
  const order = await db.order.create({
    data: {
      userId: ctx.userId,
      brokerAccountId: ctx.accountId,
      instrumentId: opts.side === "SELL" ? ctx.sellInstrumentId! : ctx.instrumentId,
      side: opts.side,
      type: "LIMIT",
      quantity: opts.quantity,
      price: opts.price,
      filledQuantity: opts.withTrade ? opts.quantity : 0,
      avgFillPrice: opts.withTrade ? opts.price : null,
      status: "FILLED",
      fee: opts.orderFee,
      submittedAt: now,
      filledAt: now,
      note: "exec-verify plant",
    },
  });
  if (opts.withTrade) {
    await db.trade.create({
      data: {
        orderId: order.id,
        instrumentId: order.instrumentId,
        side: opts.side,
        quantity: opts.quantity,
        price: opts.price,
        fee: opts.fee,
        tax: opts.tax,
        executedAt: now,
      },
    });
  }
  let cashDelta = BigInt(0);
  if (opts.applyCash) {
    cashDelta =
      opts.side === "BUY"
        ? -(notional + opts.fee)
        : notional - opts.fee - opts.tax;
    await db.brokerAccount.update({
      where: { id: ctx.accountId },
      data: { cashBalance: { decrement: -cashDelta } },
    });
  }
  if (opts.applyPosition) {
    const instrumentId = order.instrumentId;
    const existing = await db.position.findUnique({
      where: { brokerAccountId_instrumentId: { brokerAccountId: ctx.accountId, instrumentId } },
    });
    if (existing) {
      await db.position.update({
        where: { id: existing.id },
        data: { quantity: { increment: opts.side === "BUY" ? opts.quantity : -opts.quantity } },
      });
    } else {
      await db.position.create({
        data: {
          brokerAccountId: ctx.accountId,
          instrumentId,
          quantity: opts.side === "BUY" ? opts.quantity : -opts.quantity,
          avgPrice: opts.price,
          status: "OPEN",
        },
      });
    }
  }
  return { orderId: order.id, cashDelta };
}

async function unplant(
  ctx: BContext,
  planted: { orderId: string; cashDelta: bigint; side: "BUY" | "SELL"; quantity: number; instrumentId: string; appliedPosition: boolean; hadPositionBefore: boolean }
): Promise<void> {
  await db.order.delete({ where: { id: planted.orderId } }).catch(() => undefined); // Trade cascade
  if (planted.cashDelta !== BigInt(0)) {
    await db.brokerAccount.update({
      where: { id: ctx.accountId },
      data: { cashBalance: { decrement: planted.cashDelta } },
    });
  }
  if (planted.appliedPosition) {
    const existing = await db.position.findUnique({
      where: {
        brokerAccountId_instrumentId: {
          brokerAccountId: ctx.accountId,
          instrumentId: planted.instrumentId,
        },
      },
    });
    const delta = planted.side === "BUY" ? -planted.quantity : planted.quantity;
    if (existing) {
      const back = existing.quantity + delta;
      if (back === 0 && !planted.hadPositionBefore) {
        await db.position.delete({ where: { id: existing.id } });
      } else {
        await db.position.update({ where: { id: existing.id }, data: { quantity: back } });
      }
    }
  }
}

function failedNames(r: ReconciliationReport): string[] {
  return r.expectations.filter((e) => !e.ok).map((e) => e.name);
}

async function verifyReconciliation() {
  console.log("\n── B · E-P0-3 ReconciliationReport 6 phép idempotent ──");

  const user = await db.user.findFirst({ where: { isActive: true }, select: { id: true } });
  const account = await db.brokerAccount.findFirst({ where: { deletedAt: null }, select: { id: true, cashBalance: true } });
  const instrument = await db.instrument.findFirst({
    where: { isActive: true, type: "STOCK" },
    select: { id: true, symbol: true },
    orderBy: { symbol: "asc" },
  });
  if (!user || !account || !instrument) {
    check("B0 có user/account/instrument để cài dữ liệu test", false);
    return;
  }
  const ctx: BContext = {
    userId: user.id,
    accountId: account.id,
    instrumentId: instrument.id,
    sellInstrumentId: null,
    accountCashBefore: account.cashBalance,
    checkpointBefore: null,
  };
  const sellPos = await db.position.findFirst({
    where: { brokerAccountId: ctx.accountId, status: "OPEN", quantity: { gte: 200 } },
    select: { instrumentId: true, quantity: true },
  });
  ctx.sellInstrumentId = sellPos?.instrumentId ?? null;

  const cpRow = await db.appSetting.findUnique({ where: { key: RECONCILE_CHECKPOINT_KEY } });
  ctx.checkpointBefore = cpRow?.value ?? null;

  const plantedAlertIds: string[] = [];
  /** Sync — chạy reconciliation 1 lần để checkpoint bám trạng thái HIỆN TẠI.
   *  Sau mỗi unplant, write đảo ngược (ngoài fill-engine) rơi vào window của
   *  sync này → MISMATCH CÓ CHỦ ĐÍCH theo whitelist semantics REV-12 — không
   *  assert kết quả sync, chỉ dùng để re-baseline cho scenario kế tiếp. */
  const sync = () => runReconciliation();
  try {
    // B0 — reset checkpoint → baseline lần đầu
    await resetReconcileCheckpoint();
    const baseline = await runReconciliation();
    check(
      "B0 chưa có checkpoint → baseline=true, không đối chiếu mù cả lịch sử",
      baseline.baseline === true && baseline.verdict === "BALANCED" && baseline.expectations.length === 0
    );

    const Q = 300;
    const P = 20_000;
    const notional = Q * P;
    const correctFee = BigInt(Math.round(FEE_RATE * notional));

    // ── B1 — fee-recompute: BUY, fee sai +1000, còn lại nhất quán ──
    const wrongFee = correctFee + BigInt(1000);
    const b1 = await plantFilledOrderTrade(ctx, {
      side: "BUY", quantity: Q, price: P, fee: wrongFee, tax: BigInt(0),
      orderFee: wrongFee, withTrade: true, applyCash: true, applyPosition: true, sellFromQty: 0,
    });
    const posB1 = await db.position.findUnique({
      where: { brokerAccountId_instrumentId: { brokerAccountId: ctx.accountId, instrumentId: ctx.instrumentId } },
    });
    const r1 = await runReconciliation();
    check(
      "B1 trade fee sai 1 dòng → fee-recompute fail ĐÚNG 1 phép + verdict MISMATCH",
      failedNames(r1).length === 1 && failedNames(r1)[0] === "fee-recompute" && r1.verdict === "MISMATCH",
      `failed=[${failedNames(r1).join(",")}] diff=${r1.expectations.find((e) => e.name === "fee-recompute")?.diff}`
    );

    // B6 — MISMATCH → RiskAlert EXEC_RECONCILE_MISMATCH (từ r1)
    const alert = await db.riskAlert.findFirst({
      where: { code: "EXEC_RECONCILE_MISMATCH", acknowledgedAt: null },
      orderBy: { createdAt: "desc" },
    });
    check(
      "B6 MISMATCH → RiskAlert EXEC_RECONCILE_MISMATCH (không tự lành §6.3)",
      alert != null && alert.message.includes("fee-recompute")
    );
    if (alert) plantedAlertIds.push(alert.id);

    // B5 — idempotent: chạy lại NGAY (plant còn nguyên) → window mới không
    // chứa trade cũ (executedAt < checkpoint) → 0 giao dịch → BALANCED —
    // cùng 1 Trade KHÔNG bao giờ bị đếm 2 lần (giải G6)
    const alertsBefore = await db.riskAlert.count({ where: { code: "EXEC_RECONCILE_MISMATCH" } });
    const r1b = await runReconciliation();
    const alertsAfter = await db.riskAlert.count({ where: { code: "EXEC_RECONCILE_MISMATCH" } });
    check(
      "B5 chạy 2 lần liên tiếp → window không trùng → 0 giao dịch mới → BALANCED (không đếm trùng)",
      r1b.baseline === false && r1b.tradesCount === 0 && r1b.verdict === "BALANCED" && alertsAfter === alertsBefore,
      `trades=${r1b.tradesCount}`
    );
    await unplant(ctx, {
      orderId: b1.orderId, cashDelta: b1.cashDelta, side: "BUY", quantity: Q,
      instrumentId: ctx.instrumentId, appliedPosition: true, hadPositionBefore: posB1 != null && posB1.quantity !== Q,
    });
    await sync(); // hấp thụ reversal — re-baseline cho scenario sau

    // ── B2 — tax-recompute: SELL có vị thế, tax sai +500 ──
    if (ctx.sellInstrumentId && sellPos) {
      const sellQ = 200;
      const sellNotional = sellQ * P;
      const sellFee = BigInt(Math.round(FEE_RATE * sellNotional));
      const wrongTax = BigInt(Math.round(TAX_RATE * sellNotional)) + BigInt(500);
      const b2 = await plantFilledOrderTrade(ctx, {
        side: "SELL", quantity: sellQ, price: P, fee: sellFee, tax: wrongTax,
        orderFee: sellFee, withTrade: true, applyCash: true, applyPosition: true, sellFromQty: sellQ,
      });
      const alerts2Before = await db.riskAlert.count({ where: { code: "EXEC_RECONCILE_MISMATCH" } });
      const r2 = await runReconciliation();
      const alerts2After = await db.riskAlert.count({ where: { code: "EXEC_RECONCILE_MISMATCH" } });
      check(
        "B2 trade SELL thuế sai → tax-recompute fail đúng 1 phép + alert dedupe (không thêm alert mới)",
        failedNames(r2).length === 1 && failedNames(r2)[0] === "tax-recompute" && alerts2After === alerts2Before,
        `failed=[${failedNames(r2).join(",")}] alerts ${alerts2Before}→${alerts2After}`
      );
      await unplant(ctx, {
        orderId: b2.orderId, cashDelta: b2.cashDelta, side: "SELL", quantity: sellQ,
        instrumentId: ctx.sellInstrumentId, appliedPosition: true, hadPositionBefore: true,
      });
      await sync();
    } else {
      check("B2 (cần vị thế OPEN ≥200 cp — bỏ qua khi DB không có)", true, "skipped: không có vị thế thích hợp");
    }

    // ── B3 — order-coverage: Order FILLED KHÔNG có Trade ──
    const b3 = await plantFilledOrderTrade(ctx, {
      side: "BUY", quantity: Q, price: P, fee: BigInt(0), tax: BigInt(0),
      orderFee: BigInt(0), withTrade: false, applyCash: false, applyPosition: false, sellFromQty: 0,
    });
    const r3 = await runReconciliation();
    check(
      "B3 Order FILLED thiếu Trade → order-coverage fail đúng 1 phép",
      failedNames(r3).length === 1 && failedNames(r3)[0] === "order-coverage",
      `failed=[${failedNames(r3).join(",")}]`
    );
    await unplant(ctx, {
      orderId: b3.orderId, cashDelta: BigInt(0), side: "BUY", quantity: Q,
      instrumentId: ctx.instrumentId, appliedPosition: false, hadPositionBefore: false,
    });
    await sync();

    // ── B4 — cash-delta: trade nhất quán nhưng KHÔNG ghi cash (whitelist REV-12) ──
    const b4 = await plantFilledOrderTrade(ctx, {
      side: "BUY", quantity: Q, price: P, fee: correctFee, tax: BigInt(0),
      orderFee: correctFee, withTrade: true, applyCash: false, applyPosition: true, sellFromQty: 0,
    });
    const posB4 = await db.position.findUnique({
      where: { brokerAccountId_instrumentId: { brokerAccountId: ctx.accountId, instrumentId: ctx.instrumentId } },
    });
    const r4 = await runReconciliation();
    check(
      "B4 write cash ngoài fill-engine (không ghi) → cash-delta fail đúng 1 phép — semantics whitelist",
      failedNames(r4).length === 1 && failedNames(r4)[0] === "cash-delta",
      `failed=[${failedNames(r4).join(",")}]`
    );
    await unplant(ctx, {
      orderId: b4.orderId, cashDelta: BigInt(0), side: "BUY", quantity: Q,
      instrumentId: ctx.instrumentId, appliedPosition: true, hadPositionBefore: posB4 != null && posB4.quantity !== Q,
    });
    await sync();

    // ── B7 — order-fee-ledger (REV-8): Order.fee ≠ Σ Trade.fee ──
    const b7 = await plantFilledOrderTrade(ctx, {
      side: "BUY", quantity: Q, price: P, fee: correctFee, tax: BigInt(0),
      orderFee: correctFee + BigInt(999), withTrade: true, applyCash: true, applyPosition: true, sellFromQty: 0,
    });
    const posB7 = await db.position.findUnique({
      where: { brokerAccountId_instrumentId: { brokerAccountId: ctx.accountId, instrumentId: ctx.instrumentId } },
    });
    const r7 = await runReconciliation();
    check(
      "B7 Order.fee ≠ Σ Trade.fee (2 sổ phí) → order-fee-ledger fail đúng 1 phép (REV-8)",
      failedNames(r7).length === 1 && failedNames(r7)[0] === "order-fee-ledger",
      `failed=[${failedNames(r7).join(",")}]`
    );
    await unplant(ctx, {
      orderId: b7.orderId, cashDelta: b7.cashDelta, side: "BUY", quantity: Q,
      instrumentId: ctx.instrumentId, appliedPosition: true, hadPositionBefore: posB7 != null && posB7.quantity !== Q,
    });
    await sync();

    // B8 — sau sync cuối: window rỗng → BALANCED 6/6 phép
    const r8 = await runReconciliation();
    check(
      "B8 dọn hết dữ liệu cài → BALANCED 6/6 phép",
      r8.verdict === "BALANCED" && r8.expectations.length === 6 && r8.expectations.every((e) => e.ok),
      `trades=${r8.tradesCount}`
    );
  } finally {
    // Dọn: alert test + checkpoint về trạng thái gốc
    if (plantedAlertIds.length > 0) {
      await db.riskAlert.deleteMany({ where: { id: { in: plantedAlertIds } } });
    } else {
      await db.riskAlert.deleteMany({
        where: { code: "EXEC_RECONCILE_MISMATCH", createdAt: { gte: new Date(Date.now() - 3_600_000) } },
      });
    }
    if (ctx.checkpointBefore) {
      await db.appSetting.upsert({
        where: { key: RECONCILE_CHECKPOINT_KEY },
        create: { key: RECONCILE_CHECKPOINT_KEY, value: ctx.checkpointBefore },
        update: { value: ctx.checkpointBefore },
      });
    } else {
      await resetReconcileCheckpoint();
    }
    // Kiểm tra tiền mặt nguyên vẹn sau toàn bộ phần B
    const after = await db.brokerAccount.findUnique({
      where: { id: ctx.accountId },
      select: { cashBalance: true },
    });
    check(
      "B9 dọn sạch: tiền mặt account về đúng mức trước khi test",
      after != null && after.cashBalance === ctx.accountCashBefore,
      `${ctx.accountCashBefore} → ${after?.cashBalance}`
    );
  }
}

/* ═══════════════ C · E-P0-4 — CommittedCashView (+PENDING REV-1) ═══════════════ */

async function verifyCommitted() {
  console.log("\n── C · E-P0-4 CommittedCashView (ACTIVE + PENDING REV-1) ──");

  const account = await db.brokerAccount.findFirst({
    where: { deletedAt: null },
    select: { id: true, cashBalance: true, equity: true, marginUsed: true },
  });
  const instrument = await db.instrument.findFirst({
    where: { isActive: true, type: "STOCK" },
    select: { id: true },
    orderBy: { symbol: "asc" },
  });
  const agent = await db.agent.findFirst({ select: { id: true }, orderBy: { code: "asc" } });
  if (!account || !instrument || !agent) {
    check("C0 có account/instrument/agent để cài test", false);
    return;
  }
  const equity = Number(account.cashBalance) + 100_000_000; // equity đầu vào mô phỏng
  const input = {
    cash: Number(account.cashBalance),
    equity,
    marginUsed: Number(account.marginUsed),
    buyingPowerFactor: 0.5,
    marginRoomMinVnd: 500_000_000,
  };

  const base = await computeCommittedCashView(input);
  const plantedSignalIds: string[] = [];
  const plantedOrderIds: string[] = [];
  const user = await db.user.findFirst({ where: { isActive: true }, select: { id: true } });
  if (!user) {
    check("C0 có user active", false);
    return;
  }
  try {
    // C1 — 2 tín hiệu ACTIVE BUY → committedBuy tăng đúng 2 × equity × 5%
    for (let i = 0; i < 2; i++) {
      const s = await db.signal.create({
        data: {
          instrumentId: instrument.id,
          direction: "BUY",
          confidence: "MEDIUM",
          score: 70,
          rationale: "exec-verify committed test",
          agentId: agent.id,
          status: "ACTIVE",
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      plantedSignalIds.push(s.id);
    }
    const withTwo = await computeCommittedCashView(input);
    const expected2 = 2 * equity * 0.05;
    check(
      "C1 2 tín hiệu ACTIVE → committedBuy tăng đúng 2 × nav5pct (≈5% NAV mỗi tín hiệu)",
      Math.abs(withTwo.committedBuyNotional - base.committedBuyNotional - expected2) < 1 &&
        withTwo.activeSignals === base.activeSignals + 2,
      `Δ=${Math.round(withTwo.committedBuyNotional - base.committedBuyNotional)} ≈ ${Math.round(expected2)}`
    );

    // C1b — tín hiệu EXPIRED → rời tập cam kết
    await db.signal.updateMany({
      where: { id: { in: plantedSignalIds } },
      data: { status: "EXPIRED" },
    });
    const afterExpire = await computeCommittedCashView(input);
    check(
      "C1b tín hiệu EXPIRED → committed giảm lại đúng mức ban đầu",
      Math.abs(afterExpire.committedBuyNotional - base.committedBuyNotional) < 1
    );

    // C2/C3 — REV-1: APPROVE thay tín hiệu bằng lệnh PENDING → không tụt mù
    // Giá đặt WAY-UNDER-MARKET (10% giá hiện tại) để fill engine thật KHÔNG
    // thể khớp trong lúc script chạy (BUY khớp khi last ≤ giá đặt).
    const quote = await db.quote.findFirst({
      where: { instrumentId: instrument.id },
      orderBy: { tradedAt: "desc" },
      select: { last: true },
    });
    const lastPx = quote?.last ?? 20_000;
    const price = Math.max(100, Math.round((lastPx * 0.1) / 100) * 100);
    await db.signal.updateMany({
      where: { id: { in: [plantedSignalIds[0]] } },
      data: { status: "ACTIVE" },
    });
    const beforeApprove = await computeCommittedCashView(input);
    // Giả lập APPROVE: tín hiệu → ACTED + lệnh PENDING notional ≈ equity×5%
    const qty = Math.max(100, Math.floor((equity * 0.05) / price / 100) * 100);
    await db.signal.update({
      where: { id: plantedSignalIds[0] },
      data: { status: "ACTED", actedAt: new Date() },
    });
    const order = await db.order.create({
      data: {
        userId: user.id,
        brokerAccountId: account.id,
        signalId: plantedSignalIds[0],
        instrumentId: instrument.id,
        side: "BUY",
        type: "LIMIT",
        quantity: qty,
        price,
        fee: BigInt(Math.round(FEE_RATE * price * qty)),
        status: "PENDING",
        note: "exec-verify committed pending test",
      },
    });
    plantedOrderIds.push(order.id);
    const afterApprove = await computeCommittedCashView(input);
    // Tín hiệu rời tập (−nav5pct) nhưng lệnh PENDING vào (+qty×price×(1+fee))
    // → chênh lệch chỉ do làm tròn lot 100 + phí ≈ nhỏ
    const lotRounding = 100 * price * (1 + FEE_RATE);
    const delta = afterApprove.committedBuyNotional - beforeApprove.committedBuyNotional;
    check(
      "C2 REV-1: APPROVE → tín hiệu rời ACTIVE nhưng lệnh PENDING vào tập cam kết — không tụt mù",
      Math.abs(delta) <= lotRounding && afterApprove.pendingOrders === base.pendingOrders + 1,
      `Δ=${Math.round(delta)} (dung sai làm tròn lot+phí ${Math.round(lotRounding)})`
    );
    check(
      "C3 committedBuyingPower = buyingPower − committedBuy (nhất quán công thức)",
      Math.abs(afterApprove.committedBuyingPower - (afterApprove.buyingPower - afterApprove.committedBuyNotional)) < 1
    );

    // C4 — lệnh khớp một phần: filledQuantity trừ đúng phần đã khớp
    await db.order.update({
      where: { id: order.id },
      data: { status: "PARTIALLY_FILLED", filledQuantity: 100, avgFillPrice: price },
    });
    const afterPartial = await computeCommittedCashView(input);
    const remainingNotional = (qty - 100) * price * (1 + FEE_RATE);
    check(
      "C4 PARTIALLY_FILLED → cam kết còn lại = (quantity − filled) × price (đúng phần chưa khớp)",
      Math.abs(
        afterPartial.committedBuyNotional - (afterApprove.committedBuyNotional - 100 * price * (1 + FEE_RATE))
      ) < 1,
      `remaining ≈ ${Math.round(remainingNotional)}`
    );
  } finally {
    await db.order.deleteMany({ where: { id: { in: plantedOrderIds } } });
    await db.signal.deleteMany({ where: { id: { in: plantedSignalIds } } });
  }
}

/* ═══════════════ D · E-P0-5 — KPI funnel ═══════════════ */

async function verifyKpi() {
  console.log("\n── D · E-P0-5 KPI funnel nhóm executive ──");

  const instrument = await db.instrument.findFirst({
    where: { isActive: true, type: "STOCK" },
    select: { id: true },
    orderBy: { symbol: "asc" },
  });
  const user = await db.user.findFirst({ where: { isActive: true }, select: { id: true } });
  const account = await db.brokerAccount.findFirst({ where: { deletedAt: null }, select: { id: true } });
  if (!instrument || !user || !account) {
    check("D0 có dữ liệu nền để test KPI", false);
    return;
  }

  const before = await computeExecKpi(30);

  const signalIds: string[] = [];
  const orderIds: string[] = [];
  try {
    // Cài: 2 ACTED + 1 EXPIRED + 1 ACTIVE (đều BUY) + 1 lệnh FILLED + 1 PENDING
    const mk = async (status: "ACTED" | "EXPIRED" | "ACTIVE", actedAt: Date | null) =>
      db.signal.create({
        data: {
          instrumentId: instrument.id,
          direction: "BUY",
          confidence: "MEDIUM",
          score: 60,
          rationale: "exec-verify kpi test",
          status,
          actedAt,
          expiresAt: status === "ACTIVE" ? new Date(Date.now() + 86_400_000) : new Date(),
        },
      });
    signalIds.push((await mk("ACTED", new Date())).id);
    signalIds.push((await mk("ACTED", new Date())).id);
    signalIds.push((await mk("EXPIRED", null)).id);
    signalIds.push((await mk("ACTIVE", null)).id);

    const filledOrder = await db.order.create({
      data: {
        userId: user.id,
        brokerAccountId: account.id,
        signalId: signalIds[0],
        instrumentId: instrument.id,
        side: "BUY",
        type: "LIMIT",
        quantity: 200,
        price: 20_000,
        filledQuantity: 200,
        avgFillPrice: 20_000,
        status: "FILLED",
        fee: BigInt(Math.round(FEE_RATE * 20_000 * 200)),
        filledAt: new Date(),
        note: "exec-verify kpi filled",
      },
    });
    orderIds.push(filledOrder.id);
    const pendingOrder = await db.order.create({
      data: {
        userId: user.id,
        brokerAccountId: account.id,
        instrumentId: instrument.id,
        side: "BUY",
        type: "LIMIT",
        quantity: 100,
        price: 100, // way-under-market — fill engine thật không thể khớp trong lúc test
        status: "PENDING",
        note: "exec-verify kpi pending",
      },
    });
    orderIds.push(pendingOrder.id);

    const after = await computeExecKpi(30);

    // D1 — "tính đúng bằng tay": so DELTA với công thức tay
    // F-701-02 (fixbug #71): funnel neo cohort phê duyệt — chỉ lệnh gắn tín hiệu
    // ACTED của window vào funnel (lệnh filled có signalId → +1); lệnh pending
    // KHÔNG có signalId → +1 ordersOutOfFunnel, KHÔNG vào funnel.
    const expSignals = before.funnel.signals + 4;
    const expApproved = before.funnel.approved + 2;
    const expOrders = before.funnel.ordersCreated + 1;
    const expFilled = before.funnel.ordersFilled + 1;
    const expOutOfFunnel = before.funnel.ordersOutOfFunnel + 1;
    check(
      "D1a funnel đúng bằng tay: +4 tín hiệu · +2 duyệt · +1 lệnh (cohort) · +1 khớp",
      after.funnel.signals === expSignals &&
        after.funnel.approved === expApproved &&
        after.funnel.ordersCreated === expOrders &&
        after.funnel.ordersFilled === expFilled &&
        after.funnel.ordersOutOfFunnel === expOutOfFunnel,
      `${after.funnel.signals}/${expSignals} · ${after.funnel.approved}/${expApproved} · ${after.funnel.ordersCreated}/${expOrders} · ${after.funnel.ordersFilled}/${expFilled} · ngoàiPhễu ${after.funnel.ordersOutOfFunnel}/${expOutOfFunnel}`
    );
    check(
      "D1b approvePct đúng công thức approved/signals",
      after.approvePct === Math.round((expApproved / expSignals) * 1000) / 10,
      `${after.approvePct}%`
    );
    check(
      "D1c churnPct đúng công thức expired/signals",
      after.churnPct === Math.round(((before.funnel.expired + 1) / expSignals) * 1000) / 10,
      `expired ${before.funnel.expired}+1 / ${expSignals} = ${after.churnPct}%`
    );
    const prevFilled = before.funnel.ordersFilled;
    const prevAov = before.aovVnd ?? 0;
    const expAov = Math.round((prevAov * prevFilled + 4_000_000) / (prevFilled + 1));
    check(
      "D1d AOV đúng bằng tay (bình quân có trọng số lệnh mới 4tr ₫)",
      after.aovVnd != null && Math.abs(after.aovVnd - expAov) < 2,
      `aov=${after.aovVnd} ≈ ${expAov}`
    );
    check(
      "D1e slippage có thêm mẫu (khớp đúng giá đặt → 0% lệch)",
      after.slippage != null && after.slippage.n >= (before.slippage?.n ?? 0) + 1
    );

    // D2 — không KPI âm
    check(
      "D2 mọi số funnel ≥ 0 và phần trăm ∈ [0,100] hoặc null",
      after.funnel.signals >= 0 &&
        after.funnel.approved >= 0 &&
        after.funnel.ordersCreated >= 0 &&
        after.funnel.ordersFilled >= 0 &&
        after.funnel.ordersOutOfFunnel >= 0 &&
        after.funnel.holdCount >= 0 &&
        after.rejected >= 0 &&
        (after.approvePct == null || (after.approvePct >= 0 && after.approvePct <= 100)) &&
        (after.fillPct == null || (after.fillPct >= 0 && after.fillPct <= 100)) &&
        (after.churnPct == null || (after.churnPct >= 0 && after.churnPct <= 100))
    );
  } finally {
    await db.order.deleteMany({ where: { id: { in: orderIds } } });
    await db.signal.deleteMany({ where: { id: { in: signalIds } } });
  }

  // D3 — quantile tuyến tính kiểu Pandas
  check(
    "D3 quantile([1,2,3,4], 0.5)=2,5 · 0.25=1,75 (nội suy tuyến tính)",
    quantile([1, 2, 3, 4], 0.5) === 2.5 && quantile([1, 2, 3, 4], 0.25) === 1.75
  );
}

/* ═══════════════ E · An toàn bất khả xâm phạm (§6.1/§6.2) ═══════════════ */

async function verifySafety() {
  console.log("\n── E · An toàn: chu kỳ không tự đặt lệnh · plan chỉ sau APPROVE ──");

  // E1 — chạy reconciliation + committed KHÔNG tạo Order nào
  const countBefore = await db.order.count();
  await runReconciliation();
  await computeCommittedCashView({
    cash: 1_000_000_000,
    equity: 2_000_000_000,
    marginUsed: 0,
    buyingPowerFactor: 0.5,
    marginRoomMinVnd: 500_000_000,
  });
  const countAfter = await db.order.count();
  check(
    "E1 runReconciliation + computeCommittedCashView không tạo Order (chu kỳ vô hại)",
    countAfter === countBefore,
    `${countBefore} → ${countAfter}`
  );

  // E1b — nguồn chu kỳ agents/run KHÔNG chứa order.create (bất khả xâm phạm §6.1)
  const runRoute = readSrc("app/api/agents/run/route.ts");
  check(
    "E1b agents/run route không có db.order.create (chu kỳ không tự đặt lệnh)",
    !runRoute.includes("order.create")
  );

  // E2 — buildExecutionPlan/buildTwapChildPlan chỉ được gọi từ đường đã duyệt
  // (signal-execution) — E-P1-2 thêm builder TWAP, cùng nguyên tắc P0.
  const planCallers: string[] = [];
  const twapCallers: string[] = [];
  for (const rel of [
    "lib/signal-execution.ts",
    "app/api/market/tick/route.ts",
    "app/api/agents/run/route.ts",
    "lib/agent-service-runs.ts",
    "lib/exec/reconciliation.ts",
    "lib/exec/committed.ts",
    "lib/exec/twap.ts",
    "lib/exec/forecast.ts",
    "lib/exec/anomaly.ts",
    "lib/exec/chairman-scorecard.ts",
    "lib/exec/allocation.ts",
  ]) {
    if (readSrc(rel).includes("buildExecutionPlan(")) planCallers.push(rel);
    if (readSrc(rel).includes("buildTwapChildPlan(")) twapCallers.push(rel);
  }
  check(
    "E2 buildExecutionPlan + buildTwapChildPlan chỉ gọi trong signal-execution.ts (SAU APPROVE/convert) — không nơi khác",
    planCallers.length === 1 &&
      planCallers[0] === "lib/signal-execution.ts" &&
      twapCallers.length === 1 &&
      twapCallers[0] === "lib/signal-execution.ts",
    `plan=[${planCallers.join(",")}] twap=[${twapCallers.join(",")}]`
  );

  // E3 — đổi biểu phí 1 chỗ: chỉ exec/constants.ts định nghĩa + mọi nơi import
  const tickSrc = readSrc("app/api/market/tick/route.ts");
  const reconSrc = readSrc("lib/exec/reconciliation.ts");
  const committedSrc = readSrc("lib/exec/committed.ts");
  check(
    "E3 fill engine + reconciliation + committed cùng import FEE_RATE/TAX_RATE đơn nguồn",
    tickSrc.includes('from "@/lib/exec/constants"') &&
      reconSrc.includes('from "@/lib/exec/constants"') &&
      committedSrc.includes('from "@/lib/exec/constants"')
  );

  // E4 (E-P1-2) — tick route có guard afterTick (E-P1-2b fill theo lịch lát)
  check(
    "E4 tick route guard lượt lát TWAP (planSliceEligible) + đếm twapWaiting",
    tickSrc.includes("planSliceEligible") && tickSrc.includes("twapWaiting")
  );
}

/* ═══════════════ F · E-P1-2 — TWAP tách lát thật (2a sinh Order con + 2b lịch afterTick) ═══════════════ */

async function verifyTwap() {
  console.log("\n── F · E-P1-2 TWAP: ngưỡng ADTV · tách lát · plan con · fill gating ──");

  // F1 — chia lát thuần (số học, không DB)
  const slices = draftTwapSlices(1000, 3);
  check(
    "F1a draftTwapSlices(1000, 3) → 3 lát [400, 300, 300] Σ=1000 · lot 100 · afterTick [0, 480, 960]",
    slices != null &&
      slices.length === 3 &&
      slices[0].quantity === 400 &&
      slices[1].quantity === 300 &&
      slices[2].quantity === 300 &&
      slices.reduce((s, c) => s + c.quantity, 0) === 1000 &&
      slices.every((c) => c.quantity % 100 === 0) &&
      slices[0].afterTick === 0 &&
      slices[1].afterTick === 480 &&
      slices[2].afterTick === 960,
    slices ? slices.map((s) => `${s.quantity}@${s.afterTick}`).join(" ") : "null"
  );
  check(
    "F1b quantity 250 < 3×100 lot → KHÔNG tách (null — đi SINGLE)",
    draftTwapSlices(250, 3) === null
  );
  check(
    "F1c sliceCount 1 → null (TWAP cần ≥ 2 lát)",
    draftTwapSlices(1000, 1) === null
  );

  // F2 — ngưỡng kích hoạt 1% ADTV-20
  check(
    "F2a shouldTwap: notional 500tr > 1%×ADTV 20 tỷ (200tr) → true; 100tr → false",
    shouldTwap(500_000_000, 20_000_000_000) === true &&
      shouldTwap(100_000_000, 20_000_000_000) === false
  );
  check(
    "F2b ADTV=0 (chưa đủ bar) → false — không tách mù",
    shouldTwap(500_000_000, 0) === false
  );
  check(
    "F2c notionalPctAdtv(500tr, 20 tỷ) = 2,5% (2 số lẻ)",
    notionalPctAdtv(500_000_000, 20_000_000_000) === 2.5
  );

  // F2d — plan con TWAP round-trip + eligibility (E-P1-2b)
  const childPlan = buildTwapChildPlan({
    orderId: "test-twap-order",
    seq: 2,
    quantity: 300,
    price: 20_000,
    afterTick: 480,
    sizing: "nav5pct",
    humanNote: "Từ phê duyệt tín hiệu MUA EVT1",
    twap: { totalSlices: 3, signalId: "sig-1", notionalPctAdtv: 2.5, adtvVnd: 20_000_000_000 },
  });
  const parsedChild = parseExecutionPlan(planToNote(childPlan));
  const created = new Date("2026-10-09T09:15:00+07:00");
  check(
    "F2d plan con TWAP note round-trip: style TWAP · seq 2/3 · afterTick 480 · meta adtv",
    parsedChild != null &&
      parsedChild.style === "TWAP" &&
      parsedChild.twap?.totalSlices === 3 &&
      parsedChild.twap?.notionalPctAdtv === 2.5 &&
      parsedChild.slices[0].afterTick === 480
  );
  check(
    "F2e eligibility: lát afterTick=480 chưa tới lượt lúc 09:15+45ph (270 tick < 480) → KHÔNG khớp; lát 1 (afterTick 0) luôn khớp được",
    planSliceEligible(childPlan, created, new Date("2026-10-09T10:00:00+07:00")) === false &&
      planSliceEligible(
        { ...childPlan, slices: [{ ...childPlan.slices[0], afterTick: 0 }] },
        created,
        created
      ) === true
  );
  check(
    "F2f eligibility bật đúng lúc đủ 480 tick phiên (09:15 → 09:15+80 phút)",
    planSliceEligible(childPlan, created, new Date("2026-10-09T10:35:00+07:00")) === true
  );

  // ── F3 — E2E hermetic: plant instrument + bar ADTV nhỏ + APPROVE → 3 Order con ──
  // F-73R3-04: testStart mốc TRƯỚC mọi query — không còn khe fill prod giữa
  // fetch account và testStart (fill trong khe bị bỏ qua detection).
  const testStart = new Date();
  const user = await db.user.findFirst({ where: { isActive: true }, select: { id: true } });
  const account = await db.brokerAccount.findFirst({
    where: { deletedAt: null },
    select: { id: true, cashBalance: true, equity: true },
  });
  if (!user || !account) {
    check("F3 có user/account để cài E2E TWAP", false);
    return;
  }
  // F-73A-04 (fixbug #73): snapshot cash/equity TRƯỚC test — fill engine chạy nền
  // (tick 10s) có thể khớp lát 1 giữa lúc tạo lệnh và lúc dọn; finally HOÀN về
  // đúng mức trước test (cleanup cũ KHÔNG hoàn cash → lệch vĩnh viễn nếu trúng).
  const cashBefore = account.cashBalance;
  const equityBefore = account.equity;
  const instrumentId: string[] = [];
  let signal: { id: string } | null = null;
  try {
    const inst = await db.instrument.create({
      data: {
        symbol: "EVT1",
        name: "exec-verify TWAP test",
        market: "HOSE",
        type: "STOCK",
        sector: "test",
        isActive: true,
      },
    });
    instrumentId.push(inst.id);
    // Quote giá hiện tại 20_000 (F-202 dải ±7%: 18_600–21_400).
    await db.quote.create({
      data: {
        instrumentId: inst.id,
        open: 20_000,
        high: 20_000,
        low: 20_000,
        last: 20_000,
        volume: 1000,
        refPrice: 20_000,
        ceilingPrice: 21_400,
        floorPrice: 18_600,
        tradedAt: new Date(),
      },
    });
    // 20 bar EOD "thấp thanh khoản" — value 1 triệu ₫/phiên → ADTV-20 = 1tr.
    // Lệnh nav5pct (≥ 2tr notional) chắc chắn > 1% ADTV → TWAP bật.
    const barNow = Date.now();
    for (let i = 1; i <= 20; i++) {
      const d = new Date(barNow - i * 86_400_000);
      await db.bar.create({
        data: {
          instrumentId: inst.id,
          date: d,
          open: 20_000,
          high: 20_000,
          low: 20_000,
          close: 20_000,
          volume: 50,
          value: BigInt(1_000_000),
        },
      }).catch(() => undefined); // ngày trùng (T7/CN modelled) thì bỏ qua
    }
    // ADTV đo lại đúng 1tr (không phụ thuộc ngày lễ bỏ sót).
    const adtv = await adtv20For(inst.id);
    check(
      "F3a adtv20For đo từ 20 bar plant = 1.000.000 ₫/phiên",
      Math.abs(adtv.adtvVnd - 1_000_000) < 1 && adtv.sessions > 0,
      `adtv=${Math.round(adtv.adtvVnd)} sessions=${adtv.sessions}`
    );

    // Equity tính ĐÚNG cách createPaperOrderFromSignal (F-102) để biết trước qty.
    const positions = await db.position.findMany({
      where: { brokerAccountId: account.id, status: "OPEN" },
      include: {
        instrument: {
          select: { quotes: { orderBy: { tradedAt: "desc" }, take: 1, select: { last: true } } },
        },
      },
    });
    const equity =
      Number(account.cashBalance) +
      positions.reduce((s, p) => s + (p.instrument.quotes[0]?.last ?? 0) * p.quantity, 0);
    const expQty = Math.max(100, Math.floor(((equity * 0.05) / 20_000 / 100)) * 100);

    signal = await db.signal.create({
      data: {
        instrumentId: inst.id,
        direction: "BUY",
        confidence: "MEDIUM",
        score: 70,
        rationale: "exec-verify twap e2e",
        status: "ACTIVE",
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    const result = await createPaperOrderFromSignal(signal.id, { sizing: "nav5pct" });
    check(
      "F3b APPROVE lệnh lớn → ok + twap != null (style TWAP, 3 lát, %ADTV > ngưỡng đơn nguồn)",
      result.ok && result.twap != null && result.twap.sliceCount === 3 && result.twap.triggerPct === TWAP_ADTV_TRIGGER_PCT,
      result.ok ? `twap=${result.twap?.sliceCount} lát · ${result.twap?.notionalPctAdtv}% ADTV` : result.error
    );
    if (result.ok) {
      check(
        "F3c sinh đúng 3 Order con PENDING · Σ quantity == quantity gốc",
        result.orders.length === 3 &&
          result.orders.reduce((s, o) => s + o.quantity, 0) === expQty &&
          result.orders.every((o) => o.status === "PENDING"),
        `Σ=${result.orders.reduce((s, o) => s + o.quantity, 0)} ≈ ${expQty}`
      );
      // Mọi Order con có plan TWAP parse được + afterTick đúng lịch rải.
      const orderRows = await db.order.findMany({
        where: { signalId: signal.id },
        orderBy: { createdAt: "asc" },
      });
      const plans = orderRows.map((o) => parseExecutionPlan(o.note));
      check(
        "F3d mọi Order con note là plan TWAP · seq 1→3 · afterTick [0, 480, 960]",
        plans.length === 3 &&
          plans.every((p) => p != null && p.style === "TWAP") &&
          plans[0]!.slices[0].seq === 1 &&
          plans[1]!.slices[0].seq === 2 &&
          plans[2]!.slices[0].seq === 3 &&
          plans[1]!.slices[0].afterTick === 480 &&
          plans[2]!.slices[0].afterTick === 960
      );
      // Fee từng con = FEE_RATE × price × qty con (đơn nguồn E-P0-1).
      const feeOk = orderRows.every(
        (o) => Number(o.fee) === Math.round(FEE_RATE * 20_000 * o.quantity)
      );
      check(
        "F3e fee từng Order con = FEE_RATE × 20.000 × qty con (Σ = phí toàn lệnh)",
        feeOk &&
          orderRows.reduce((s, o) => s + Number(o.fee), 0) ===
            Math.round(FEE_RATE * 20_000 * orderRows.reduce((s, o) => s + o.quantity, 0))
      );
      // Audit ORDER_CREATED ghi children + twap meta.
      const audit = await db.auditLog.findFirst({
        where: { action: "ORDER_CREATED", entity: "Order", entityId: orderRows[0].id },
        orderBy: { createdAt: "desc" },
      });
      let auditOk = false;
      try {
        const after = JSON.parse(audit?.after ?? "{}") as {
          children?: unknown[];
          style?: string;
          twap?: { totalSlices?: number };
        };
        auditOk =
          audit != null &&
          after.style === "TWAP" &&
          Array.isArray(after.children) &&
          after.children.length === 3 &&
          after.twap?.totalSlices === 3;
      } catch {
        auditOk = false;
      }
      check("F3f audit ORDER_CREATED ghi style TWAP + children 3 dòng + twap meta", auditOk);
      // Tín hiệu chuyển ACTED đúng 1 lần cho cả kế hoạch.
      const sigAfter = await db.signal.findUnique({ where: { id: signal.id }, select: { status: true, actedAt: true } });
      check(
        "F3g tín hiệu chuyển ACTED đúng 1 lần (claim atomic cho cả N con)",
        sigAfter?.status === "ACTED" && sigAfter.actedAt != null
      );
    }
  } finally {
    // F-73A-04: dọn hermetic ĐẦY ĐỦ — làm cả khi throw giữa chừng (cleanup cũ nằm
    // trong try bỏ sót). Xoá order (trade cascade) + MỌI audit theo entityId của
    // lệnh test (ORDER_CREATED/FILLED/EXPIRED...) + tín hiệu + hoàn cash/equity
    // về mức trước test nếu tick đã khớp lát nào đó trong window.
    const testOrders = signal
      ? await db.order
          .findMany({ where: { signalId: signal.id }, select: { id: true } })
          .catch(() => [])
      : [];
    if (testOrders.length > 0) {
      await db.auditLog
        .deleteMany({
          where: { entity: "Order", entityId: { in: testOrders.map((o) => o.id) } },
        })
        .catch(() => undefined);
      await db.order
        .deleteMany({ where: { signalId: signal!.id } })
        .catch(() => undefined);
    }
    if (signal) {
      await db.signal.delete({ where: { id: signal.id } }).catch(() => undefined);
    }
    const accNow = await db.brokerAccount
      .findUnique({ where: { id: account.id }, select: { cashBalance: true, equity: true } })
      .catch(() => null);
    if (accNow && (accNow.cashBalance !== cashBefore || accNow.equity !== equityBefore)) {
      // F-73R2-02: chỉ hoàn khi KHÔNG có lệnh PROD nào khớp trong window test —
      // fill prod đồng thời bị hoàn nhầm sẽ làm sổ lệch (reconciliation bắt được,
      // nhưng cứ để đúng nguồn). Có fill ngoài test → bỏ hoàn + cảnh báo.
      const testOrderIds = testOrders.map((o) => o.id);
      const foreignFills = await db.order
        .findMany({
          where: {
            status: "FILLED",
            filledAt: { gte: testStart, lt: new Date() },
            ...(testOrderIds.length > 0 ? { id: { notIn: testOrderIds } } : {}),
          },
          select: { id: true },
        })
        .catch(() => []);
      if (foreignFills.length === 0) {
        await db.brokerAccount
          .update({
            where: { id: account.id },
            data: { cashBalance: cashBefore, equity: equityBefore },
          })
          .catch(() => undefined);
      } else {
        console.warn(
          `[exec-verify:F3] bỏ hoàn cash — ${foreignFills.length} lệnh PROD khớp trong window test (fill thật giữ nguyên)`
        );
      }
    }
    if (instrumentId.length > 0) {
      // Xoá audit ORDER_CREATED của lệnh test (after JSON chứa symbol EVT1 —
      // hermetic: không để lại audit mồ côi tham chiếu lệnh đã dọn).
      await db.auditLog
        .deleteMany({
          where: {
            action: "ORDER_CREATED",
            after: { contains: '"EVT1"' },
          } as never,
        })
        .catch(() => undefined);
      await db.bar.deleteMany({ where: { instrumentId: { in: instrumentId } } });
      await db.instrument.delete({ where: { id: instrumentId[0] } }); // quote cascade
    }
  }
}

/* ═══════════════ G · E-P1-3 — CashflowForecast (snapshot + baseline + kịch bản) ═══════════════ */

async function verifyForecast() {
  console.log("\n── G · E-P1-3 CashflowForecast: snapshot · xu hướng · kịch bản · CI ──");

  const user = await db.user.findFirst({ where: { isActive: true }, select: { id: true } });
  if (!user) {
    check("G0 có user active", false);
    return;
  }
  // Tài khoản TEST soft-delete NGAY (deletedAt set) — mọi query prod lọc
  // deletedAt: null nên không thấy; forecast query trực tiếp theo id.
  const account = await db.brokerAccount.create({
    data: {
      userId: user.id,
      accountNumber: "EXEC-VERIFY-G",
      cashBalance: BigInt(1_000_000_000),
      equity: BigInt(1_000_000_000),
      deletedAt: new Date(),
    },
  });
  const plantedSnapshotIds: string[] = [];
  try {
    // G1 — recordCashSnapshot ghi + prune cũ hơn 90 ngày.
    const old = await db.cashSnapshot.create({
      data: {
        brokerAccountId: account.id,
        cash: BigInt(500_000_000),
        equity: BigInt(500_000_000),
        source: "seed",
        createdAt: new Date(Date.now() - 100 * 86_400_000),
      },
    });
    plantedSnapshotIds.push(old.id);
    await recordCashSnapshot({
      brokerAccountId: account.id,
      cash: 1_000_000_000,
      equity: 1_000_000_000,
    });
    const oldGone = await db.cashSnapshot.findUnique({ where: { id: old.id } });
    const freshCount = await db.cashSnapshot.count({ where: { brokerAccountId: account.id } });
    check(
      "G1 recordCashSnapshot ghi snapshot mới + prune cũ hơn 90 ngày",
      oldGone == null && freshCount === 1,
      `sau prune còn ${freshCount}`
    );
    // Dọn snapshot G1 — chuỗi G2 phải THUẦN tuyến tính 10 điểm (không lẫn
    // điểm flat của G1 phá slope).
    await db.cashSnapshot.deleteMany({ where: { brokerAccountId: account.id } });

    // G2 — chuỗi tuyến tính hoàn hảo 10 điểm (slope 50tr/ngày trong 10 ngày).
    // Dùng MỘC nowMs chung cho mọi điểm (Date.now() gọi riêng mỗi vòng lệch vài
    // ms → xs không còn nguyên → slope lệch ~30 ₫/ngày như chạy trước).
    const nowMs = Date.now();
    for (let i = 0; i < 10; i++) {
      const row = await db.cashSnapshot.create({
        data: {
          brokerAccountId: account.id,
          cash: BigInt(1_000_000_000 + i * 50_000_000),
          equity: BigInt(1_000_000_000 + i * 50_000_000),
          source: "seed",
          createdAt: new Date(nowMs - (10 - i) * 86_400_000),
        },
      });
      plantedSnapshotIds.push(row.id);
    }
    const f = await computeCashflowForecast(
      {
        cash: 1_450_000_000, // điểm cuối chuỗi (i=9)
        committedBuyNotional: 200_000_000,
        committedSellInflow: 100_000_000,
        horizonHours: 24, // 1 ngày → trend delta = slope nguyên vẹn
      },
      account.id
    );
    check(
      "G2a OLS xu hướng tuyến tính hoàn hảo → 50.000.000 ₫/ngày",
      f.trendVndPerDay === 50_000_000,
      `trend=${f.trendVndPerDay}`
    );
    const none = f.scenarios.find((s) => s.name === "none")!;
    const half = f.scenarios.find((s) => s.name === "half")!;
    const all = f.scenarios.find((s) => s.name === "allApprove")!;
    check(
      "G2b kịch bản none = cash + trend×1 ngày (không duyệt thêm)",
      none.cashAtHorizon === 1_450_000_000 + 50_000_000
    );
    // netCommitment = 200tr − 100tr = 100tr; half trừ 50% (50tr), all trừ hết.
    check(
      "G2c kịch bản half = none − 50% cam kết ròng (minh bạch — không phải xác suất)",
      half.cashAtHorizon === 1_500_000_000 - 50_000_000 &&
        all.cashAtHorizon === 1_500_000_000 - 100_000_000
    );
    check(
      "G2d chuỗi hoàn hảo → phần dư 0 → CI95 suy biến [point, point] (không phóng đại)",
      f.residualQuantiles != null &&
        f.residualQuantiles.p2_5 === 0 &&
        f.residualQuantiles.p97_5 === 0 &&
        none.ci95 != null &&
        none.ci95.low === none.cashAtHorizon &&
        none.ci95.high === none.cashAtHorizon
    );
    check(
      "G3 n=10 < 30 → enoughData=false [DA D7] + note khai báo half minh bạch",
      f.enoughData === false && f.note.includes("minh bạch") && f.history.n === 10
    );
    check(
      "G4 label ước tính nội bộ giữ nguyên câuclaimer (§6.4/§6.7)",
      f.label.includes("ước tính nội bộ") && f.label.includes("không phải hạn mức thật")
    );

    // G5 — F-73B-01 regression (fixbug #73): chuỗi > 500 → phải lấy 500 MỚI NHẤT.
    // Plant 500 snapshot phẳng 1tỷ trải [T-100d, T-2d] + 1 snapshot 2tỷ ở T-1h:
    //  - code đúng (orderBy desc + reverse): history.to ≈ T-1h, slope dương (jump
    //    ở snapshot mới nhất được tính vào xu hướng);
    //  - code cũ sai (orderBy asc + take): lấy 500 CŨ NHẤT → to ≈ T-2d, chuỗi
    //    phẳng → slope 0 — trend/CI đóng băng trên dữ liệu cũ mãi mãi.
    await db.cashSnapshot.deleteMany({ where: { brokerAccountId: account.id } });
    const tRef = Date.now();
    const g5Rows = Array.from({ length: 500 }, (_, i) => ({
      brokerAccountId: account.id,
      cash: BigInt(1_000_000_000),
      equity: BigInt(1_000_000_000),
      source: "seed",
      createdAt: new Date(tRef - (100 - i * (98 / 500)) * 86_400_000),
    }));
    g5Rows.push({
      brokerAccountId: account.id,
      cash: BigInt(2_000_000_000),
      equity: BigInt(2_000_000_000),
      source: "seed",
      createdAt: new Date(tRef - 3_600_000),
    });
    await db.cashSnapshot.createMany({ data: g5Rows });
    const f5 = await computeCashflowForecast(
      { cash: 2_000_000_000, committedBuyNotional: 0, committedSellInflow: 0 },
      account.id
    );
    const newestMs = tRef - 3_600_000;
    check(
      "G5 chuỗi 501 > take 500 → dùng 500 MỚI NHẤT (to ≈ snapshot mới nhất — không đóng băng trend)",
      f5.history.n === 500 &&
        f5.history.to != null &&
        Math.abs(new Date(f5.history.to).getTime() - newestMs) < 3_600_000,
      `n=${f5.history.n} to=${f5.history.to}`
    );
    check(
      "G5b jump 2tỷ ở snapshot mới nhất được tính vào xu hướng (slope > 0 — code cũ đóng băng cho 0)",
      f5.trendVndPerDay != null && f5.trendVndPerDay > 10_000,
      `trend=${f5.trendVndPerDay}`
    );
  } finally {
    await db.cashSnapshot.deleteMany({ where: { brokerAccountId: account.id } });
    await db.brokerAccount.delete({ where: { id: account.id } });
  }
}

/* ═══════════════ H · E-P1-4 — ChairmanScorecard (nhãn 5 phiên + metrics) ═══════════════ */

async function verifyChairmanScorecard() {
  console.log("\n── H · E-P1-4 ChairmanScorecard: nhãn 5 phiên · precision/F1/AP · calibration ──");

  // H1 — averagePrecision thuần (tính tay).
  const ap1 = averagePrecision([
    { score: 80, relevant: true },
    { score: 70, relevant: false },
    { score: 60, relevant: true },
  ]);
  check(
    "H1a AP([T,F,T] theo rank) = 1/2×1 + 1/2×2/3 ≈ 0,8333 (tính tay)",
    ap1 != null && Math.abs(ap1 - 5 / 6) < 1e-9,
    `ap=${ap1}`
  );
  const apTie = averagePrecision([
    { score: 50, relevant: true },
    { score: 50, relevant: false },
  ]);
  check(
    "H1b nhóm đồng điểm gộp: AP([T,F] cùng score) = 0,5 (precision sau nhóm)",
    apTie != null && Math.abs(apTie - 0.5) < 1e-9,
    `ap=${apTie}`
  );
  check("H1c AP với 0 relevant → null (không chia 0)", averagePrecision([{ score: 1, relevant: false }]) === null);

  // ── H2 — plant dữ liệu chấm nhãn hermetic ──
  const chairman = await db.agent.findFirst({ where: { code: "portfolio-strategist" }, select: { id: true } });
  if (!chairman) {
    check("H2 có agent Chủ tịch trong DB", false);
    return;
  }
  const instId: string[] = [];
  const signalIds: string[] = [];
  const DAY = 86_400_000;
  // D0 = hôm qua (bar entry), D1..D5 = 5 phiên tương lai (hôm nay về sau — đủ chấm).
  const d0 = new Date(Date.now() - 6 * DAY);
  try {
    const inst = await db.instrument.create({
      data: { symbol: "EVS2", name: "exec-verify scorecard test", market: "HOSE", type: "STOCK", isActive: true },
    });
    instId.push(inst.id);
    // Bar D0 close 100 (giá sinh). 5 bar tương lai TĂNG (high chạm 112 — tín hiệu 1 target 105 WIN;
    // tín hiệu 2 SELL target 95 stop 105 → LOSS vì giá tăng).
    const mkBar = (date: Date, high: number, low: number, close: number) =>
      db.bar.create({
        data: { instrumentId: inst.id, date, open: close, high, low, close, volume: 100, value: BigInt(1_000_000) },
      });
    const mkBar2 = (instrumentId: string, date: Date, high: number, low: number, close: number) =>
      db.bar.create({
        data: { instrumentId, date, open: close, high, low, close, volume: 100, value: BigInt(1_000_000) },
      });
    await mkBar(d0, 101, 99, 100);
    for (let i = 1; i <= 5; i++) {
      // Chuỗi TĂNG: high lên dần 103→107, low 101→105 (không chạm stop 95).
      await mkBar(new Date(d0.getTime() + i * DAY), 102 + i, 100 + i, 101 + i);
    }
    // Instrument thứ 2 chuỗi GIẢM — cho tín hiệu BUY MEDIUM thua (fallback close5).
    const instDown = await db.instrument.create({
      data: { symbol: "EVS2B", name: "exec-verify scorecard down", market: "HOSE", type: "STOCK", isActive: true },
    });
    instId.push(instDown.id);
    await mkBar2(instDown.id, d0, 101, 99, 100);
    for (let i = 1; i <= 5; i++) {
      // Chuỗi GIẢM: close 97→93, low xuống 96→92 (entry 100).
      await mkBar2(instDown.id, new Date(d0.getTime() + i * DAY), 99, 97 - i, 98 - i);
    }
    const mkSignal = (opts: {
      instrumentId: string;
      direction: "BUY" | "SELL";
      target: number | null;
      stop: number | null;
      confidence: "LOW" | "MEDIUM" | "HIGH";
      score: number;
      createdAt: Date;
    }) =>
      db.signal.create({
        data: {
          instrumentId: opts.instrumentId,
          direction: opts.direction,
          confidence: opts.confidence,
          score: opts.score,
          rationale: "exec-verify scorecard",
          agentId: chairman.id,
          targetPrice: opts.target,
          stopLoss: opts.stop,
          status: "EXPIRED", // đã qua — không ảnh hưởng tập ACTIVE prod
          createdAt: opts.createdAt,
          expiresAt: opts.createdAt,
        },
      });
    // 5 tín hiệu tại cuối D0 (sau bar close) — score KHÁC NHAU để test AP rank:
    //  1) EVS2  BUY  HIGH   target 105 stop 95 → WIN (high D3=105 chạm target trước)
    //  2) EVS2  SELL LOW    target 95 stop 105 → LOSS (high D3=105 chạm stop trước)
    //  3) EVS2  BUY  MEDIUM KHÔNG target/stop → fallback close5=106 > entry 100 → WIN
    //  4) EVS2B BUY  MEDIUM KHÔNG target/stop → fallback close5=93 < entry 100 → LOSS
    //  5) EVS2  SELL LOW    target 50 stop 200 (XA — không chạm) → fallback
    //     close5=106 ≥ entry 100 → LOSS [H5: fallthrough semantics + ruleCounts]
    const t0 = new Date(d0.getTime() + 12 * 3_600_000);
    signalIds.push((await mkSignal({ instrumentId: inst.id, direction: "BUY", target: 105, stop: 95, confidence: "HIGH", score: 90, createdAt: t0 })).id);
    signalIds.push((await mkSignal({ instrumentId: inst.id, direction: "SELL", target: 95, stop: 105, confidence: "LOW", score: 50, createdAt: t0 })).id);
    signalIds.push((await mkSignal({ instrumentId: inst.id, direction: "BUY", target: null, stop: null, confidence: "MEDIUM", score: 70, createdAt: t0 })).id);
    signalIds.push((await mkSignal({ instrumentId: instDown.id, direction: "BUY", target: null, stop: null, confidence: "MEDIUM", score: 80, createdAt: t0 })).id);
    signalIds.push((await mkSignal({ instrumentId: inst.id, direction: "SELL", target: 50, stop: 200, confidence: "LOW", score: 60, createdAt: t0 })).id);

    // Cohort filter theo signalIds — hermetic (không trộn tín hiệu prod window).
    const sc = await buildChairmanScorecard(90, { signalIds });
    // Nhãn: s1 BUY WIN (TP) · s2 SELL LOSS (actual up → FN) · s3 BUY WIN (TP) ·
    // s4 BUY LOSS (actual down → FP) · s5 SELL LOSS qua fallback close5 (FN) →
    // TP=2, FP=1, FN=2, TN=0.
    check(
      "H2a nhãn đúng luật target/stop + fallback (kể cả fallthrough s5): TP=2 · FP=1 · FN=2 · TN=0",
      sc.confusion.tp === 2 && sc.confusion.fp === 1 && sc.confusion.fn === 2 && sc.confusion.tn === 0,
      `tp=${sc.confusion.tp} fp=${sc.confusion.fp} fn=${sc.confusion.fn} tn=${sc.confusion.tn}`
    );
    check(
      "H2b precision = 2/3 · recall = 2/4 = 1/2 · F1 = 4/7 ≈ 57,14%",
      sc.precision != null && Math.abs(sc.precision - 2 / 3) < 1e-4 &&
        sc.recall != null && Math.abs(sc.recall - 0.5) < 1e-4 &&
        sc.f1 != null && Math.abs(sc.f1 - 4 / 7) < 1e-4,
      `p=${sc.precision} r=${sc.recall} f1=${sc.f1}`
    );
    // AP rank score [90 T, 80 F, 70 T, 60 T, 50 T] = (1 + 2/3 + 3/4 + 4/5)/4 = 193/240 ≈ 0,8042.
    check(
      "H2b2 AUC-PR (AP theo rank score) = (1 + ⅔ + ¾ + ⅘)/4 = 193/240 ≈ 0,8042",
      sc.aucPr != null && Math.abs(sc.aucPr - 193 / 240) < 1e-3,
      `ap=${sc.aucPr}`
    );
    // RMSE target (BUY có target): s1 target 105 vs high5 107 → |−2| → 2;
    // stop s1 95 vs low5 101 (min của low 101..105) → |−6| → 6.
    check(
      "H2c RMSE mục tiêu = 2 · RMSE cắt lỗ = 6 (VND) [ML M2]",
      sc.targetRmse === 2 && sc.stopRmse === 6,
      `target=${sc.targetRmse} stop=${sc.stopRmse}`
    );
    // Calibration: HIGH 1/1 WIN (odds null 0/∞ minh bạch) · LOW 0/2 (s2 + s5
    // đều LOSS — odds null) · MEDIUM 1/2 → winrate 0,5 → odds = 1 (exercises p/(1−p)).
    const high = sc.calibration.find((c) => c.confidence === "HIGH")!;
    const low = sc.calibration.find((c) => c.confidence === "LOW")!;
    const med = sc.calibration.find((c) => c.confidence === "MEDIUM")!;
    check(
      "H2d calibration: HIGH 1/1 (odds null) · LOW 0/2 · MEDIUM 1/2 → odds = 1",
      high.n === 1 && high.wins === 1 && high.odds == null &&
        low.n === 2 && low.wins === 0 &&
        med.n === 2 && med.wins === 1 && med.winrate === 0.5 && med.odds === 1,
      `H=${high.wins}/${high.n} L=${low.wins}/${low.n} M=${med.wins}/${med.n} odds=${med.odds}`
    );
    check(
      "H3 labeled 5 < 30 → enoughData=false [DA D7] + pendingLabels=0",
      sc.labeled === 5 && sc.enoughData === false && sc.pendingLabels === 0
    );
    check(
      "H5 ruleCounts minh bạch: target/stop 2 · close-5 3 · pending 0 — tín hiệu CÓ target/stop nhưng không chạm trong 5 phiên → fallback close-5 (F-73B-06)",
      sc.ruleCounts.targetStop === 2 && sc.ruleCounts.close5 === 3 && sc.ruleCounts.pending === 0,
      `targetStop=${sc.ruleCounts.targetStop} close5=${sc.ruleCounts.close5} pending=${sc.ruleCounts.pending}`
    );
    check(
      "H4 hợp đồng v1/kind + note khai báo luật nhãn",
      sc.v === 1 && sc.kind === "ChairmanScorecard" && sc.note.includes("5 phiên")
    );
  } finally {
    await db.signal.deleteMany({ where: { id: { in: signalIds } } });
    if (instId.length > 0) {
      await db.bar.deleteMany({ where: { instrumentId: { in: instId } } });
      await db.instrument.deleteMany({ where: { id: { in: instId } } });
    }
  }
}

/* ═══════════════ I · E-P1-5 — Bất thường giao dịch (IQR + z-score) ═══════════════ */

async function verifyAnomaly() {
  console.log("\n── I · E-P1-5 Bất thường: z-score fill ±2σ · IQR slippage · RiskAlert INFO ──");

  const user = await db.user.findFirst({ where: { isActive: true }, select: { id: true } });
  const account = await db.brokerAccount.findFirst({ where: { deletedAt: null }, select: { id: true } });
  if (!user || !account) {
    check("I0 có user/account để cài test", false);
    return;
  }
  const instId: string[] = [];
  const orderIds: string[] = [];
  let alertId: string | null = null;
  const DAY = 86_400_000;
  const from = new Date(Date.now() - 3_600_000);
  const to = new Date(Date.now() + 3_600_000);
  // F-73B-15 (fixbug #73): plant executedAt/filledAt ở TƯƠNG LAI (+30ph — vẫn
  // trong [from, to] của scan) → reconciliation window [checkpoint, now) không
  // bao giờ thấy trade test → I-section hermetic cả khi chu kỳ A11 chạy song song.
  const futureMs = Date.now() + 30 * 60_000;
  try {
    const inst = await db.instrument.create({
      data: { symbol: "EVA3", name: "exec-verify anomaly test", market: "HOSE", type: "STOCK", isActive: true },
    });
    instId.push(inst.id);
    // 20 bar close dao động 99/101 quanh 100 (σ=1 ≠ 0 — z của giá khớp 130 = +30σ)
    // TRƯỚC window. (Close đồng nhất tuyệt đối → σ=0 → phép z tự bỏ qua trung thực.)
    for (let i = 1; i <= 20; i++) {
      await db.bar.create({
        data: {
          instrumentId: inst.id,
          date: new Date(Date.now() - (i + 1) * DAY),
          open: 100,
          high: 102,
          low: 98,
          close: i % 2 === 0 ? 101 : 99,
          volume: 100,
          value: BigInt(1_000_000),
        },
      });
    }
    // (a) Trade "bất thường" giá 130 (z ≈ +30σ).
    // F-73B-15: fee đúng nguồn đơn FEE_RATE (bản cũ literal 195 = lệch 10× —
    // nếu A11 chạy trùng window sẽ gây fee-recompute MISMATCH giả).
    const zFee = Math.round(FEE_RATE * 130 * 100);
    const zOrder = await db.order.create({
      data: {
        userId: user.id,
        brokerAccountId: account.id,
        instrumentId: inst.id,
        side: "BUY",
        type: "LIMIT",
        quantity: 100,
        price: 130,
        filledQuantity: 100,
        avgFillPrice: 130,
        status: "FILLED",
        fee: BigInt(zFee),
        filledAt: new Date(futureMs),
        note: "exec-verify anomaly z",
      },
    });
    orderIds.push(zOrder.id);
    const zTrade = await db.trade.create({
      data: {
        orderId: zOrder.id,
        instrumentId: inst.id,
        side: "BUY",
        quantity: 100,
        price: 130,
        fee: BigInt(zFee),
        tax: BigInt(0),
        executedAt: new Date(futureMs),
      },
    });
    // (b) 5 lệnh FILLED slippage [0, 0, 1, 2, 10]% (kèm lệnh z 0% = 6 mẫu:
    // Q1=0 · Q3=1,75 · IQR=1,75 > 0 → rào trên 4,375% — chỉ 10% là outlier).
    // F-73B-02 regression guard: lệnh FILLED price=0 (dòng bẩn) cắm GIỮA chuỗi
    // mẫu — code zip + query price>0 đúng thì vô hình; code cũ 2-mảng-song-song
    // lệch idx → outlier 10% gán nhầm lệnh khác + bỏ sót lệnh thật — I2 bắt qua refId.
    let tenPctOrderId = "";
    for (let i = 0; i < 5; i++) {
      const price = 20_000;
      const avg = [20_000, 20_000, 20_200, 20_400, 22_000][i];
      const o = await db.order.create({
        data: {
          userId: user.id,
          brokerAccountId: account.id,
          instrumentId: inst.id,
          side: "BUY",
          type: "LIMIT",
          quantity: 100,
          price,
          filledQuantity: 100,
          avgFillPrice: avg,
          status: "FILLED",
          fee: BigInt(Math.round(FEE_RATE * price * 100)),
          filledAt: new Date(futureMs),
          note: "exec-verify anomaly iqr",
        },
      });
      orderIds.push(o.id);
      if (i === 4) tenPctOrderId = o.id;
      if (i === 1) {
        const zero = await db.order.create({
          data: {
            userId: user.id,
            brokerAccountId: account.id,
            instrumentId: inst.id,
            side: "BUY",
            type: "LIMIT",
            quantity: 100,
            price: 0,
            filledQuantity: 100,
            avgFillPrice: 20_000,
            status: "FILLED",
            fee: BigInt(0),
            filledAt: new Date(futureMs),
            note: "exec-verify anomaly zero-price",
          },
        });
        orderIds.push(zero.id);
      }
    }

    const scan = await detectTradeAnomalies(from, to);
    const zHits = scan.anomalies.filter((a) => a.kind === "zscore-fill");
    const iqrHits = scan.anomalies.filter((a) => a.kind === "iqr-slippage");
    check(
      "I1 z-score fill: trade giá 130 vs mean20=100 σ=1 → z=+30 > 2 bắt được (refId = Trade id)",
      zHits.length === 1 && zHits[0].refId === zTrade.id && zHits[0].value > 2,
      `z=${zHits[0]?.value}`
    );
    check(
      "I2 IQR slippage: 6 mẫu [0,0,0,1,2,10]% → chỉ outlier 10% vượt rào ~4,4% — refId ĐÚNG lệnh 22.000 dù có lệnh price=0 cắm giữa (F-73B-02)",
      iqrHits.length === 1 &&
        Math.abs(iqrHits[0].value - 10) < 0.01 &&
        iqrHits[0].refId === tenPctOrderId,
      `slip=${iqrHits[0]?.value}% ref=${iqrHits[0]?.refId === tenPctOrderId ? "đúng" : "SAI"}`
    );
    check(
      "I2b anomaly IQR hiện MÃ cổ phiếu thật (F-73B-03 — hết 'N cp')",
      iqrHits.length === 1 && iqrHits[0].symbol === "EVA3",
      `symbol=${iqrHits[0]?.symbol}`
    );

    // I3 — RiskAlert INFO + dedupe 24h.
    // F-73R2-01: snapshot id alert EXEC_TRADE_ANOMALY unacked SẴN CÓ — nếu prod
    // vừa bắn alert thật thì dedupe là hành vi ĐÚNG (created=0), và finally
    // KHÔNG được xoá alert prod (chỉ xoá alert do test tự tạo).
    // F-73R3-01: chỉ đếm alert unacked trong 24h qua (đúng cửa sổ dedupe của
    // raiseAnomalyAlert) — alert prod cũ hơn 24h không chặn dedupe, không được
    // tính vào pre-existing (nếu tính → I3 false-fail).
    const preExistingAlertIds = new Set(
      (
        await db.riskAlert.findMany({
          where: {
            code: "EXEC_TRADE_ANOMALY",
            acknowledgedAt: null,
            createdAt: { gte: new Date(Date.now() - 24 * 3_600_000) },
          },
          select: { id: true },
        })
      ).map((a) => a.id)
    );
    const created1 = await raiseAnomalyAlert(scan);
    const alert = await db.riskAlert.findFirst({
      where: { code: "EXEC_TRADE_ANOMALY", acknowledgedAt: null },
      orderBy: { createdAt: "desc" },
    });
    alertId = alert != null && !preExistingAlertIds.has(alert.id) ? alert.id : null;
    const created2 = await raiseAnomalyAlert(scan);
    check(
      "I3 RiskAlert EXEC_TRADE_ANOMALY severity INFO (nhẹ — không ack-bắt-buộc) + dedupe 24h",
      preExistingAlertIds.size === 0
        ? created1 === 1 && alert != null && alert.severity === "INFO" && created2 === 0
        : created1 === 0 && created2 === 0 // prod đã có alert 24h — dedupe đúng, không false-fail
    );
    // I4 — summary 1 câu trung thực.
    check(
      "I4 anomalyScanSummary liệt kê đủ 2 loại + ghi RiskAlert INFO",
      anomalyScanSummary(scan).includes("z-score fill: 1") &&
        anomalyScanSummary(scan).includes("IQR slippage: 1")
    );
  } finally {
    await db.order.deleteMany({ where: { id: { in: orderIds } } }); // trade cascade
    if (alertId != null) await db.riskAlert.delete({ where: { id: alertId } }).catch(() => undefined);
    if (instId.length > 0) {
      await db.bar.deleteMany({ where: { instrumentId: { in: instId } } });
      await db.instrument.delete({ where: { id: instId[0] } });
    }
  }
}

/* ═══════════════ J · E-P1-1 — Khối đề xuất phân bổ (parse an toàn + config) ═══════════════ */

async function verifyAllocation() {
  console.log("\n── J · E-P1-1 Phân bổ: parse an toàn · parse-fail drift · config consumer ──");

  // J1 — parse hợp lệ.
  const valid = parseAllocationProposal({
    narrative: "Giữ nguyên cấu trúc, tăng nhẹ VIC.",
    rows: [
      { symbol: "vic", currentPct: 12.5, targetPct: 15, action: "BUY" },
      { symbol: "VCB", currentPct: 10, targetPct: 10, action: "HOLD" },
      { symbol: "FPT", currentPct: 8, targetPct: 5, action: "sell" },
      { symbol: "RÁC", currentPct: "x", targetPct: 1, action: "GIỮ" },
    ],
  });
  check(
    "J1a parse chuẩn hoá: symbol uppercase · BUY→MUA · HOLD→GIỮ · sell→BÁN · dòng rác bị loại",
    valid != null &&
      valid.rows.length === 3 &&
      valid.rows[0].symbol === "VIC" &&
      valid.rows[0].action === "MUA" &&
      valid.rows[1].action === "GIỮ" &&
      valid.rows[2].action === "BÁN"
  );
  // J1b — cắt về targetPositions dòng.
  const many = parseAllocationProposal({
    rows: Array.from({ length: 12 }, (_, i) => ({
      symbol: `S${i}`,
      currentPct: 1,
      targetPct: 1,
      action: "GIỮ",
    })),
  });
  check(
    "J1b quá 8 dòng → cắt đúng ALLOCATION_TARGET_POSITIONS",
    many != null && many.rows.length === ALLOCATION_TARGET_POSITIONS
  );

  // J2 — sai format → null (không throw).
  check(
    "J2a sai format (rows không mảng / symbol thiếu / pct NaN) → null",
    parseAllocationProposal({ rows: "không phải mảng" }) === null &&
      parseAllocationProposal({ rows: [{ currentPct: 1, targetPct: 1 }] }) === null &&
      parseAllocationProposal({ rows: [{ symbol: "VCB", currentPct: NaN, targetPct: 1 }] }) === null &&
      parseAllocationProposal(null) === null
  );

  // J3 — parse-fail counter (drift metric E-P2-1).
  const before = await readAllocationParseFail();
  await bumpAllocationParseFail();
  const after = await readAllocationParseFail();
  check(
    "J3 bumpAllocationParseFail tăng counter AppSetting (drift metric E-P2-1)",
    after === before + 1,
    `${before} → ${after}`
  );

  // J4 — config roster A1 có consumer thật (G5 đóng) + prompt yêu cầu allocation.
  const ctxSrc = readSrc("lib/agent-context.ts");
  const rosterSrc = readSrc("lib/agent-roster.ts");
  const runRoute = readSrc("app/api/agents/run/route.ts");
  check(
    "J4a ALLOCATION_TARGET_POSITIONS=8 + REBALANCE=5 đọc từ roster A1 (0 consumer → có)",
    ALLOCATION_TARGET_POSITIONS === 8 &&
      ALLOCATION_REBALANCE_THRESHOLD_PCT === 5 &&
      rosterSrc.includes("targetPositions: 8") &&
      ctxSrc.includes("ALLOCATION_TARGET_POSITIONS}")
  );
  check(
    "J4b system prompt Chủ tịch yêu cầu khối allocation + block tỷ trọng trong user prompt",
    ctxSrc.includes("ĐỀ XUẤT PHÂN BỔ DANH MỤC") &&
      ctxSrc.includes("buildPortfolioWeightsBlock") &&
      runRoute.includes("buildPortfolioWeightsBlock()") &&
      runRoute.includes("parseAllocationProposal")
  );
  check(
    "J4c parse-fail được đếm trong run route (bump khi allocation hỏng format)",
    runRoute.includes("bumpAllocationParseFail")
  );

  // J5 — format message hiển thị narrative + bảng (§7.4 mặc định).
  const text = formatAllocationForMessage(
    parseAllocationProposal({
      narrative: "Tăng VIC, giữ VCB.",
      rows: [{ symbol: "VIC", currentPct: 12.5, targetPct: 15, action: "MUA" }],
    })!
  );
  check(
    "J5 formatAllocationForMessage: narrative + bảng tỷ trọng + nhãn tham mưu không tự sinh lệnh",
    text.includes("VIC: 12,5% → 15,0% (MUA)") &&
      text.includes("Tăng VIC, giữ VCB.") &&
      text.includes("không tự sinh lệnh")
  );

  // Dọn counter để không đếm phi test trong drift thật.
  await db.appSetting.deleteMany({ where: { key: ALLOCATION_PARSE_FAIL_KEY } });
}

/* ═══════════════ Chạy toàn bộ ═══════════════ */

async function main() {
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║  exec-verify — EXECUTION_OPS_BLUEPRINT · P0+P1 (phiên #72) ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  await verifyContracts();
  await verifyReconciliation();
  await verifyCommitted();
  await verifyKpi();
  await verifySafety();
  await verifyTwap();
  await verifyForecast();
  await verifyChairmanScorecard();
  await verifyAnomaly();
  await verifyAllocation();
  console.log(`\n→ KẾT QUẢ: ${pass} pass · ${fail} fail`);
  if (fail > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("exec-verify crash:", err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
