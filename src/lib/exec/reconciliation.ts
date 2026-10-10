/**
 * src/lib/exec/reconciliation.ts — A11 ReconciliationReport (E-P0-3,
 * EXECUTION_OPS_BLUEPRINT v1.1 §3.2/§4) — 6 phép đối chiếu "kỳ vọng"
 * (Great-Expectations-style [DA tr13]) trên window idempotent.
 *
 * Giải G6 (cửa sổ 24h trượt lăn chu kỳ): checkpoint `exec.reconcile` trong
 * AppSetting — window [lastReconciledAt, now) không trùng lặp giữa các lần
 * chạy; cùng 1 Trade KHÔNG BAO GIỜ bị đếm 2 lần.
 *
 * 6 phép (v1.1 — phép 6 theo REV-8 review #69):
 *  1. order-coverage   — mọi Order FILLED trong window có Trade đủ khối lượng
 *  2. fee-recompute    — Trade.fee == round(FEE_RATE × price × qty) từng dòng
 *  3. tax-recompute    — Trade SELL: tax == round(TAX_RATE × price × qty); BUY: 0
 *  4. cash-delta       — delta cash thật == Σ(±notional ∓ fee ∓ tax) của Trade
 *  5. position-delta   — delta khối lượng từng mã == Σ khối lượng theo hướng
 *  6. order-fee-ledger — Order.fee == Σ Trade.fee của cùng order (2 sổ phí
 *                        fill engine ghi: tick route Order + Trade)
 *
 * WHITELIST SEMANTICS phép 4/5 (REV-12 v1.1): phép đối chiếu chỉ đo đúng khi
 * mọi thay đổi cash/position đến từ fill engine. Seed/script/manual write
 * ngoài fill engine sẽ gây MISMATCH **CÓ CHỦ ĐÍCH** (không phải bug của phép
 * đo) — quy trình: reset checkpoint sau khi seed (xoá AppSetting exec.reconcile
 * hoặc gọi resetReconcileCheckpoint()).
 *
 * MISMATCH không "tự lành" (§6.3): ghi RiskAlert EXEC_RECONCILE_MISMATCH,
 * dedupe 24h theo code + chưa ack để không spam mỗi chu kỳ.
 */

import { db } from "@/lib/db";
import { FEE_RATE, TAX_RATE, getExecFeeTaxConfig } from "@/lib/exec/constants";

/** AppSetting key của checkpoint bù trừ. */
export const RECONCILE_CHECKPOINT_KEY = "exec.reconcile";

/** Trạng thái checkpoint lưu trong AppSetting (JSON). */
export interface ReconcileCheckpoint {
  lastReconciledAt: string;
  cash: number;
  positions: Record<string, number>; // instrumentId → quantity (mọi row, CLOSED = 0)
  lastVerdict: "BALANCED" | "MISMATCH" | "DEGRADED";
}

export interface ReconcileExpectation {
  name: string;
  unit: "VND" | "SHARES" | "COUNT";
  expected: number;
  actual: number;
  diff: number;
  ok: boolean;
  details?: Record<string, unknown>;
}

export interface ReconciliationReport {
  window: { fromCheckpoint: string | null; toNow: string };
  baseline: boolean; // true = lần đầu đặt checkpoint, chưa đối chiếu
  tradesCount: number;
  expectations: ReconcileExpectation[];
  verdict: "BALANCED" | "MISMATCH" | "DEGRADED";
  severity: "INFO" | "WARNING";
  feeConfig: { feePct: number; taxSellPct: number; source: string };
  mismatchNote?: string;
}

/** Dung sai làm tròn VND (BigInt Math.round cùng công thức → thường 0). */
const VND_TOLERANCE = 1;

async function loadCheckpoint(): Promise<ReconcileCheckpoint | null> {
  const row = await db.appSetting.findUnique({ where: { key: RECONCILE_CHECKPOINT_KEY } });
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as ReconcileCheckpoint;
    if (typeof parsed.lastReconciledAt !== "string" || typeof parsed.cash !== "number") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function saveCheckpoint(cp: ReconcileCheckpoint): Promise<void> {
  await db.appSetting.upsert({
    where: { key: RECONCILE_CHECKPOINT_KEY },
    create: { key: RECONCILE_CHECKPOINT_KEY, value: JSON.stringify(cp) },
    update: { value: JSON.stringify(cp) },
  });
}

/** Xoá checkpoint (gọi sau seed/manual write — whitelist semantics REV-12). */
export async function resetReconcileCheckpoint(): Promise<void> {
  await db.appSetting.deleteMany({ where: { key: RECONCILE_CHECKPOINT_KEY } });
}

interface CurrentLedgerState {
  cash: number;
  positions: Map<string, number>;
}

async function loadCurrentLedger(): Promise<CurrentLedgerState> {
  const [account, positionsAll] = await Promise.all([
    db.brokerAccount.findFirst({
      where: { deletedAt: null },
      select: { id: true, cashBalance: true },
    }),
    db.position.findMany({
      select: { brokerAccountId: true, instrumentId: true, quantity: true },
    }),
  ]);
  // F-73R3-02 (fixbug #73): positions neo về tài khoản sống — không trộn vị thế
  // của tài khoản khác/soft-delete vào ledger đối chiếu (cùng họ F-73R2-03;
  // checkpoint lưu theo cùng phạm vi tài khoản này nên idempotent giữ nguyên).
  const positions = account
    ? positionsAll.filter((p) => p.brokerAccountId === account.id)
    : positionsAll;
  return {
    cash: account ? Number(account.cashBalance) : 0,
    positions: new Map(positions.map((p) => [p.instrumentId, p.quantity])),
  };
}

/** RiskAlert EXEC_RECONCILE_MISMATCH — dedupe 24h + chưa ack. */
async function raiseMismatchAlert(report: ReconciliationReport): Promise<void> {
  const since = new Date(Date.now() - 24 * 3_600_000);
  const dup = await db.riskAlert.findFirst({
    where: {
      code: "EXEC_RECONCILE_MISMATCH",
      acknowledgedAt: null,
      createdAt: { gte: since },
    },
    select: { id: true },
  });
  if (dup) return;
  const failed = report.expectations.filter((e) => !e.ok).map((e) => e.name);
  await db.riskAlert.create({
    data: {
      severity: "WARNING",
      code: "EXEC_RECONCILE_MISMATCH",
      message:
        `Bù trừ sổ sách MISMATCH (${failed.join(", ")}) — window ` +
        `${report.window.fromCheckpoint ?? "?"} → ${report.window.toNow}, ` +
        `${report.tradesCount} giao dịch. Không "tự lành" — kiểm tra nguyên nhân ` +
        `(lệch công thức hay write ngoài fill-engine — xem whitelist semantics REV-12).`,
      metricKey: "exec.reconciliation",
      metricValue: failed.length,
      threshold: 0,
    },
  });
}

/**
 * Chạy 6 phép đối chiếu trên window [checkpoint, now).
 * Lần đầu (chưa có checkpoint): đặt baseline, trả report baseline=true.
 * Giá trị trả về là hợp đồng ReconciliationReport §3.2 (AgentRun.output).
 */
export async function runReconciliation(now = new Date()): Promise<ReconciliationReport> {
  const feeConfig = getExecFeeTaxConfig();
  const feeCfgMeta = {
    feePct: feeConfig.feePct,
    taxSellPct: feeConfig.taxSellPct,
    source: feeConfig.source,
  };

  const prev = await loadCheckpoint();
  if (!prev) {
    // Lần đầu — đặt baseline trung thực (không đối chiếu cả lịch sử mù)
    const cur = await loadCurrentLedger();
    await saveCheckpoint({
      lastReconciledAt: now.toISOString(),
      cash: cur.cash,
      positions: Object.fromEntries(cur.positions),
      lastVerdict: "BALANCED",
    });
    return {
      window: { fromCheckpoint: null, toNow: now.toISOString() },
      baseline: true,
      tradesCount: 0,
      expectations: [],
      verdict: "BALANCED",
      severity: "INFO",
      feeConfig: feeCfgMeta,
      mismatchNote:
        "Chưa có checkpoint — đặt baseline lần đầu (cash + positions hiện tại). Đối chiếu bắt đầu từ chu kỳ sau.",
    };
  }

  const from = new Date(prev.lastReconciledAt);
  // Window [from, now): giao dịch đúng mốc `now` (fill engine đồng thời) rơi
  // vào window KẾ TIẾP — không kẽ hở, không đếm trùng.

  // ── Dữ liệu window ──
  const trades = await db.trade.findMany({
    where: { executedAt: { gte: from, lt: now } },
    select: {
      id: true,
      orderId: true,
      instrumentId: true,
      side: true,
      quantity: true,
      price: true,
      fee: true,
      tax: true,
    },
    orderBy: { executedAt: "asc" },
  });

  // Tập order cần xem: (a) order có Trade trong window + (b) order chuyển
  // FILLED trong window (filledAt ∈ [from, now)) — (b) là ca B3 exec-verify:
  // lệnh FILLED KHÔNG có Trade nào phải bị order-coverage BẮT, không được vô
  // hình (trước fix chỉ load qua trade orderIds → khoảng mù đúng chỗ cần soi).
  const orderIds = [...new Set(trades.map((t) => t.orderId))];
  const [ordersWithTrades, filledInWindow] = await Promise.all([
    orderIds.length
      ? db.order.findMany({
          where: { id: { in: orderIds } },
          select: { id: true, quantity: true, filledQuantity: true, status: true, fee: true, side: true },
        })
      : Promise.resolve([]),
    db.order.findMany({
      where: { status: "FILLED", filledAt: { gte: from, lt: now } },
      select: { id: true, quantity: true, filledQuantity: true, status: true, fee: true, side: true },
    }),
  ]);
  const orderMap = new Map<string, (typeof ordersWithTrades)[number]>();
  for (const o of [...ordersWithTrades, ...filledInWindow]) orderMap.set(o.id, o);
  const orders = [...orderMap.values()];

  const cur = await loadCurrentLedger();

  const expectations: ReconcileExpectation[] = [];

  // ── (1) order-coverage: FILLED order phải có Trade đủ khối lượng ──
  {
    const filledOrders = orders.filter((o) => o.status === "FILLED");
    const tradesByOrder = new Map<string, typeof trades>();
    for (const t of trades) {
      const arr = tradesByOrder.get(t.orderId) ?? [];
      arr.push(t);
      tradesByOrder.set(t.orderId, arr);
    }
    const bad: { orderId: string; expected: number; actual: number }[] = [];
    let expectedSum = 0;
    let actualSum = 0;
    for (const o of filledOrders) {
      const qty = (tradesByOrder.get(o.id) ?? []).reduce((s, t) => s + t.quantity, 0);
      expectedSum += o.quantity;
      actualSum += qty;
      if (qty !== o.quantity) {
        bad.push({ orderId: o.id, expected: o.quantity, actual: qty });
      }
    }
    expectations.push({
      name: "order-coverage",
      unit: "SHARES",
      expected: expectedSum,
      actual: actualSum,
      diff: actualSum - expectedSum,
      ok: bad.length === 0,
      ...(bad.length > 0 ? { details: { badOrders: bad.slice(0, 5) } } : {}),
    });
  }

  // ── (2) fee-recompute + (3) tax-recompute: từng dòng Trade ──
  {
    let feeDiffTotal = 0;
    let taxDiffTotal = 0;
    const feeBad: { tradeId: string; expected: number; actual: number }[] = [];
    const taxBad: { tradeId: string; expected: number; actual: number }[] = [];
    for (const t of trades) {
      const notional = t.price * t.quantity;
      const expFee = Math.round(FEE_RATE * notional);
      const expTax = t.side === "SELL" ? Math.round(TAX_RATE * notional) : 0;
      const actFee = Number(t.fee);
      const actTax = Number(t.tax);
      const fd = Math.abs(actFee - expFee);
      const td = Math.abs(actTax - expTax);
      feeDiffTotal += fd;
      taxDiffTotal += td;
      if (fd > VND_TOLERANCE) feeBad.push({ tradeId: t.id, expected: expFee, actual: actFee });
      if (td > VND_TOLERANCE) taxBad.push({ tradeId: t.id, expected: expTax, actual: actTax });
    }
    expectations.push({
      name: "fee-recompute",
      unit: "VND",
      expected: trades.reduce(
        (s, t) => s + Math.round(FEE_RATE * t.price * t.quantity),
        0
      ),
      actual: trades.reduce((s, t) => s + Number(t.fee), 0),
      diff: feeDiffTotal,
      ok: feeBad.length === 0,
      ...(feeBad.length > 0 ? { details: { badTrades: feeBad.slice(0, 5) } } : {}),
    });
    expectations.push({
      name: "tax-recompute",
      unit: "VND",
      expected: trades.reduce(
        (s, t) => s + (t.side === "SELL" ? Math.round(TAX_RATE * t.price * t.quantity) : 0),
        0
      ),
      actual: trades.reduce((s, t) => s + Number(t.tax), 0),
      diff: taxDiffTotal,
      ok: taxBad.length === 0,
      ...(taxBad.length > 0 ? { details: { badTrades: taxBad.slice(0, 5) } } : {}),
    });
  }

  // ── (4) cash-delta (whitelist semantics REV-12) ──
  {
    // Kỳ vọng: BUY −(notional+fee); SELL +(notional−fee−tax)
    const expectedDelta = trades.reduce((s, t) => {
      const notional = t.price * t.quantity;
      const fee = Number(t.fee);
      const tax = Number(t.tax);
      return s + (t.side === "BUY" ? -(notional + fee) : notional - fee - tax);
    }, 0);
    const actualDelta = cur.cash - prev.cash;
    expectations.push({
      name: "cash-delta",
      unit: "VND",
      expected: expectedDelta,
      actual: actualDelta,
      diff: actualDelta - expectedDelta,
      ok: Math.abs(actualDelta - expectedDelta) <= VND_TOLERANCE,
      details: {
        note:
          "Chỉ đúng khi mọi write cash đến từ fill engine — seed/script/manual write " +
          "gây lệch CÓ CHỦ ĐÍCH: reset checkpoint sau seed (REV-12)",
      },
    });
  }

  // ── (5) position-delta: từng mã ──
  {
    const expectedByInstrument = new Map<string, number>();
    for (const t of trades) {
      const delta = t.side === "BUY" ? t.quantity : -t.quantity;
      expectedByInstrument.set(t.instrumentId, (expectedByInstrument.get(t.instrumentId) ?? 0) + delta);
    }
    const universe = new Set<string>([
      ...Object.keys(prev.positions),
      ...expectedByInstrument.keys(),
      ...cur.positions.keys(),
    ]);
    const bad: { instrumentId: string; expected: number; actual: number }[] = [];
    let expectedTotal = 0;
    let actualTotal = 0;
    for (const instrumentId of universe) {
      const expected = expectedByInstrument.get(instrumentId) ?? 0;
      const actual =
        (cur.positions.get(instrumentId) ?? 0) - (prev.positions[instrumentId] ?? 0);
      expectedTotal += expected;
      actualTotal += actual;
      if (actual !== expected) {
        bad.push({ instrumentId, expected, actual });
      }
    }
    expectations.push({
      name: "position-delta",
      unit: "SHARES",
      // F-701-03 (fixbug #71): actual = tổng delta THẬT theo mã (trước đây NaN
      // khi có lệch → JSON.stringify hoá null, mất con số trong output).
      expected: expectedTotal,
      actual: actualTotal,
      diff: bad.reduce((s, b) => s + Math.abs(b.actual - b.expected), 0),
      ok: bad.length === 0,
      ...(bad.length > 0 ? { details: { badInstruments: bad.slice(0, 5) } } : {}),
    });
  }

  // ── (6) order-fee-ledger (REV-8): Order.fee == Σ Trade.fee cùng order ──
  {
    const tradesByOrder = new Map<string, typeof trades>();
    for (const t of trades) {
      const arr = tradesByOrder.get(t.orderId) ?? [];
      arr.push(t);
      tradesByOrder.set(t.orderId, arr);
    }
    const bad: { orderId: string; expected: number; actual: number }[] = [];
    for (const o of orders) {
      // Order.fee được fill engine ghi lại lúc FILLED = fee toàn lệnh;
      // với engine full-fill 1 shot: Order.fee == Trade.fee (duy nhất).
      const tradeFeeSum = (tradesByOrder.get(o.id) ?? []).reduce((s, t) => s + Number(t.fee), 0);
      const orderFee = Number(o.fee);
      if (Math.abs(orderFee - tradeFeeSum) > VND_TOLERANCE) {
        bad.push({ orderId: o.id, expected: tradeFeeSum, actual: orderFee });
      }
    }
    expectations.push({
      name: "order-fee-ledger",
      unit: "VND",
      expected: orders.reduce((s, o) => s + (tradesByOrder.get(o.id) ?? []).reduce((a, t) => a + Number(t.fee), 0), 0),
      actual: orders.reduce((s, o) => s + Number(o.fee), 0),
      diff: bad.reduce((s, b) => s + Math.abs(b.actual - b.expected), 0),
      ok: bad.length === 0,
      ...(bad.length > 0 ? { details: { badOrders: bad.slice(0, 5) } } : {}),
    });
  }

  const failed = expectations.filter((e) => !e.ok);
  const verdict: ReconciliationReport["verdict"] = failed.length > 0 ? "MISMATCH" : "BALANCED";

  const report: ReconciliationReport = {
    window: { fromCheckpoint: prev.lastReconciledAt, toNow: now.toISOString() },
    baseline: false,
    tradesCount: trades.length,
    expectations,
    verdict,
    severity: failed.length > 0 ? "WARNING" : "INFO",
    feeConfig: feeCfgMeta,
    ...(verdict === "MISMATCH"
      ? {
          mismatchNote:
            "Lệch sổ KHÔNG tự lành (§6.3) — đã ghi RiskAlert EXEC_RECONCILE_MISMATCH. " +
            "Nguyên nhân khả dĩ: write ngoài fill-engine (seed/script — xem REV-12) hoặc " +
            "công thức phí/seed dữ liệu cũ ≠ biểu phí hiện tại.",
        }
      : {}),
  };

  if (verdict === "MISMATCH") {
    await raiseMismatchAlert(report);
  }

  // Cập nhật checkpoint = trạng thái HIỆN TẠI (idempotent: window sau bắt đầu
  // từ now — kể cả khi MISMATCH, checkpoint vẫn tiến để không kẹt window cũ;
  // RiskAlert đã giữ bằng chứng).
  await saveCheckpoint({
    lastReconciledAt: now.toISOString(),
    cash: cur.cash,
    positions: Object.fromEntries(cur.positions),
    lastVerdict: verdict,
  });

  return report;
}

/** Tóm tắt 1 câu cho content ServiceRunResult của A11. */
export function reconcileReportSummary(report: ReconciliationReport): string {
  const vnd = (n: number) => Math.round(n).toLocaleString("vi-VN");
  if (report.baseline) {
    return (
      "Bù trừ sổ sách: CHƯA có checkpoint — đã đặt baseline (tiền mặt + vị thế hiện tại). " +
      "6 phép đối chiếu bắt đầu từ chu kỳ sau (E-P0-3)."
    );
  }
  const okCount = report.expectations.filter((e) => e.ok).length;
  const failed = report.expectations.filter((e) => !e.ok).map((e) => e.name);
  const fee = report.expectations.find((e) => e.name === "fee-recompute");
  const tax = report.expectations.find((e) => e.name === "tax-recompute");
  return (
    `Bù trừ sổ sách ${report.window.fromCheckpoint?.slice(0, 16).replace("T", " ")} → ${report.window.toNow
      .slice(0, 16)
      .replace("T", " ")}: ${report.tradesCount} giao dịch · ${okCount}/6 phép ĐẠT` +
    (fee && tax
      ? ` · phí ${vnd(fee.actual)} ₫ · thuế bán ${vnd(tax.actual)} ₫ (biểu phí đơn nguồn ${report.feeConfig.feePct}%/${report.feeConfig.taxSellPct}%)`
      : "") +
    (failed.length > 0
      ? ` → MISMATCH: ${failed.join(", ")} — RiskAlert đã ghi, không tự lành.`
      : " → BALANCED.")
  );
}
