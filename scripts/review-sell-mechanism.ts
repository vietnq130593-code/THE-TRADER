/**
 * scripts/review-sell-mechanism.ts — REVIEW CƠ CHẾ BÁN (Task 151)
 *
 * Câu hỏi chủ sở hữu: "Điều kiện để các agent thống nhất thực hiện lệnh bán
 * là gì, và cơ chế này có đang hoạt động đúng không?"
 *
 * Kiểm ĐỊNH THỰC ĐO DB THÂT (nguyên tắc Fixbug §5 — không tin lời comment):
 *   A. Tổng quan tín hiệu SELL: số lượng, trạng thái, gate đồng thuận, ratio
 *   B. Cấu hình cổng đồng thuận hiện tại (AppSetting consensus.enforce)
 *   C. Lệnh từ tín hiệu SELL: trạng thái, lý do từ chối, style TWAP/SINGLE
 *   D. Auto-decision trên SELL: audit SIGNAL_AUTO_APPROVED / REJECTED
 *   E. Phiếu bầu các cử tri trong assessment gần nhất (tally UP/DOWN/FLAT)
 *   F. Vòng kín: SELL FILLED → Position giảm/CLOSED → realized P&L → Trade
 *   G. DecisionEvaluation có chấm lại tín hiệu SELL không (D-LEDGER)
 *   H. VETO từng chặn SELL/compliance lần nào (hạ HOLD rationale)
 *
 * Cách chạy: env -u DATABASE_URL bun scripts/review-sell-mechanism.ts
 * Read-only: KHÔNG ghi/xoá gì — chỉ SELECT + aggregate.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

function pct(r: number | null): string {
  return r == null ? "?" : `${(r * 100).toFixed(1).replace(".", ",")}%`;
}

async function main() {
  const out: string[] = [];
  const p = (s: string) => {
    out.push(s);
    console.log(s);
  };

  p("══════════ REVIEW CƠ CHẾ BÁN — THE TRADER ══════════");
  p(`Thời điểm: ${new Date().toISOString()}`);
  p("");

  /* ── A. Tổng quan tín hiệu ─────────────────────────────────────── */
  const [total, byDir, byStatus, sellByStatus, sellByGate] = await Promise.all([
    db.signal.count(),
    db.signal.groupBy({ by: ["direction"], _count: true }),
    db.signal.groupBy({ by: ["status"], _count: true }),
    db.signal.groupBy({ where: { direction: "SELL" }, by: ["status"], _count: true }),
    db.signal.groupBy({ where: { direction: "SELL" }, by: ["consensusGate"], _count: true }),
  ]);
  p("── A. TỔNG QUAN TÍN HIỆU ──");
  p(`Tổng tín hiệu: ${total}`);
  p(
    `Theo hướng: ${byDir.map((d) => `${d.direction}=${d._count}`).join(" · ")}`
  );
  p(`Theo trạng thái: ${byStatus.map((d) => `${d.status}=${d._count}`).join(" · ")}`);
  p(
    `SELL theo trạng thái: ${
      sellByStatus.length ? sellByStatus.map((d) => `${d.status}=${d._count}`).join(" · ") : "(không có)"
    }`
  );
  p(
    `SELL theo gate đồng thuận: ${
      sellByGate.length
        ? sellByGate.map((d) => `${d.consensusGate ?? "null"}=${d._count}`).join(" · ")
        : "(không có)"
    }`
  );
  p("");

  /* ── B. Cấu hình cổng đồng thuận ───────────────────────────────── */
  const consensusRow = await db.appSetting.findUnique({ where: { key: "consensus" } });
  p("── B. CỔNG ĐỒNG THUẬN (AppSetting 'consensus') ──");
  p(consensusRow ? `value = ${consensusRow.value}` : "(chưa có row — mặc định shadow-mode)");
  p("");

  /* ── C. Lệnh từ tín hiệu SELL ──────────────────────────────────── */
  const sellSignals = await db.signal.findMany({
    where: { direction: "SELL" },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: {
      id: true,
      createdAt: true,
      status: true,
      confidence: true,
      score: true,
      consensusGate: true,
      consensusRatio: true,
      rejectNote: true,
      rationale: true,
      actedAt: true,
      instrument: { select: { symbol: true } },
      orders: {
        select: {
          id: true,
          side: true,
          status: true,
          quantity: true,
          price: true,
          filledQuantity: true,
          avgFillPrice: true,
          note: true,
          brokerAccount: { select: { accountType: true } },
        },
      },
    },
  });
  p("── C. CHI TIẾT 30 TÍN HIỆU SELL GẦN NHẤT ──");
  for (const s of sellSignals) {
    p(
      `${s.createdAt.toISOString().slice(0, 16)} · ${s.instrument.symbol} · status=${s.status} · gate=${s.consensusGate ?? "null"} · ratio=${pct(s.consensusRatio)} · score=${s.score}`
    );
    if (s.orders.length) {
      for (const o of s.orders) {
        p(
          `    → lệnh ${o.side} ${o.quantity}cp @${o.price} [${o.brokerAccount.accountType}] status=${o.status} filled=${o.filledQuantity}/${o.quantity} avgFill=${o.avgFillPrice ?? "—"}`
        );
      }
    } else {
      p(`    → (không có lệnh)${s.rejectNote ? ` rejectNote: ${s.rejectNote.slice(0, 160)}` : ""}`);
    }
  }
  p("");

  /* ── D. Auto-decision trên SELL ────────────────────────────────── */
  const autoApprovedSell = await db.auditLog.count({
    where: { action: "SIGNAL_AUTO_APPROVED", entity: "Signal" },
  });
  const autoRejectedSell = await db.auditLog.count({
    where: { action: "SIGNAL_AUTO_REJECTED", entity: "Signal" },
  });
  // Đếm auto-approved thật sự trên SELL: đọc after JSON chứa '"direction":"SELL"'
  const autoSellApproved = await db.auditLog.count({
    where: {
      action: "SIGNAL_AUTO_APPROVED",
      after: { contains: '"direction":"SELL"' },
    },
  });
  const autoSellRejected = await db.auditLog.count({
    where: {
      action: "SIGNAL_AUTO_REJECTED",
      after: { contains: '"direction":"SELL"' },
    },
  });
  p("── D. AUTO-DECISION (#91) ──");
  p(`SIGNAL_AUTO_APPROVED tổng: ${autoApprovedSell} (trong đó SELL: ${autoSellApproved})`);
  p(`SIGNAL_AUTO_REJECTED tổng: ${autoRejectedSell} (trong đó SELL: ${autoSellRejected})`);
  p("");

  /* ── D2. Audit chi tiết tín hiệu SELL duy nhất được auto-duyệt (FPT) ── */
  const sellAutoAudits = await db.auditLog.findMany({
    where: {
      action: { in: ["SIGNAL_AUTO_APPROVED", "SIGNAL_AUTO_REJECTED"] },
      after: { contains: '"direction":"SELL"' },
    },
    orderBy: { createdAt: "desc" },
    take: 6,
    select: { action: true, createdAt: true, after: true },
  });
  p("── D2. AUDIT AUTO-DECISION SELL ──");
  for (const a of sellAutoAudits) {
    p(`${a.createdAt.toISOString().slice(0, 16)} ${a.action}: ${a.after.slice(0, 300)}`);
  }
  p("");

  /* ── D3. Lệnh theo thế giới ── */
  const ordersBySideWorld = await db.order.groupBy({
    by: ["side", "status"],
    _count: true,
    where: {},
  });
  p("── D3. TẤT CẢ LỆNH THEO side/status ──");
  p(ordersBySideWorld.map((d) => `${d.side}/${d.status}=${d._count}`).join(" · "));
  p("");
  const recentAssess = await db.marketAssessment.findMany({
    where: { detail: { contains: '"consensus":{' } },
    orderBy: { createdAt: "desc" },
    take: 3,
    select: { createdAt: true, source: true, detail: true },
  });
  p("── E. SNAPSHOT CỔNG ĐỒNG THUẬN 3 CHU KỲ GẦN NHẤT ──");
  for (const a of recentAssess) {
    try {
      const d = JSON.parse(a.detail) as {
        consensus?: { ratio?: number; gate?: string; present?: number; tally?: { agentName: string; direction: string; weight: number }[]; note?: string };
      };
      const c = d.consensus;
      p(
        `${a.createdAt.toISOString().slice(0, 16)} [${a.source}] gate=${c?.gate} ratio=${pct(c?.ratio ?? null)} present=${c?.present ?? "?"}`
      );
      if (c?.tally) {
        p(`    tally: ${c.tally.map((t) => `${t.agentName}=${t.direction}(${t.weight.toFixed(2)})`).join(" · ")}`);
      }
    } catch {
      p(`${a.createdAt.toISOString().slice(0, 16)} [${a.source}] (parse lỗi)`);
    }
  }
  p("");

  /* ── F. Vòng kín vị thế: SELL FILLED → position/trade ──────────── */
  const sellFilledOrders = await db.order.findMany({
    where: { side: "SELL", status: "FILLED" },
    orderBy: { filledAt: "desc" },
    take: 10,
    select: {
      id: true,
      quantity: true,
      filledQuantity: true,
      avgFillPrice: true,
      filledAt: true,
      fee: true,
      note: true,
      brokerAccount: { select: { accountType: true } },
      instrument: { select: { symbol: true } },
      trades: { select: { id: true, quantity: true, price: true, fee: true, tax: true } },
    },
  });
  p("── F. 10 LỆNH SELL ĐÃ KHỚP GẦN NHẤT ──");
  p(`Tổng lệnh SELL FILLED toàn sổ: ${await db.order.count({ where: { side: "SELL", status: "FILLED" } })}`);
  for (const o of sellFilledOrders) {
    p(
      `${o.filledAt?.toISOString().slice(0, 16)} ${o.instrument.symbol} [${o.brokerAccount.accountType}] ${o.filledQuantity}cp @${o.avgFillPrice} · trade=${o.trades.length} · note=${(o.note ?? "").slice(0, 80)}`
    );
  }
  const openPositions = await db.position.findMany({
    where: { status: "OPEN" },
    select: { quantity: true, realizedPnl: true, instrument: { select: { symbol: true } }, brokerAccount: { select: { accountType: true } } },
  });
  p(
    `Vị thế OPEN hiện tại: ${
      openPositions.length
        ? openPositions.map((x) => `${x.instrument.symbol}[${x.brokerAccount.accountType}]=${x.quantity}cp`).join(" · ")
        : "(không có — sạch sau purge)"
    }`
  );
  p("");

  /* ── G. DecisionEvaluation trên SELL ───────────────────────────── */
  const evalCount = await db.decisionEvaluation.count({
    where: { direction: "SELL" },
  });
  const evals = await db.decisionEvaluation.findMany({
    where: { direction: "SELL" },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      createdAt: true,
      verdict: true,
      direction: true,
      markPnlPct: true,
      executionKind: true,
      cashPnlVND: true,
      world: true,
      instrumentId: true,
    },
  });
  p("── G. D-LEDGER ĐÁNH GIÁ LẠI TÍN HIỆU SELL ──");
  p(`Tổng DecisionEvaluation trên SELL: ${evalCount}`);
  for (const e of evals) {
    p(
      `${e.createdAt.toISOString().slice(0, 16)} verdict=${e.verdict} · markPnlPct=${e.markPnlPct?.toFixed(2) ?? "?"}% · kind=${e.executionKind ?? "—"} · world=${e.world ?? "—"} · cash=${e.cashPnlVND ?? "—"}`
    );
  }
  p("");

  /* ── H. VETO chặn tín hiệu ─────────────────────────────────────── */
  const vetoedDowngraded = await db.signal.count({
    where: { rationale: { contains: "BỊ ỦY BAN KIỂM SOÁT PHỦ QUYẾT" } },
  });
  const vetoedSellCompliance = await db.signal.count({
    where: { rationale: { contains: "BỊ ỦY BAN KIỂM SOÁT PHỦ QUYẾT" }, direction: "SELL" },
  });
  p("── H. VETO ỦY BAN KIỂM SOÁT ──");
  p(`Tín hiệu bị VETO hạ HOLD (tổng): ${vetoedDowngraded}`);
  p(`…trong đó còn giữ hướng SELL sau Exposure-cho-phép: ${vetoedSellCompliance} (nếu >0 → SELL bị hạ bởi compliance/controlUnavailable)`);
  p("");

  p("══════════ HẾT REVIEW (read-only) ══════════");

  await fs_write(out.join("\n"));
}

async function fs_write(text: string): Promise<void> {
  const fs = await import("node:fs");
  fs.writeFileSync("/home/z/my-project/scripts/review-sell-output.txt", text);
}

main()
  .catch((e) => {
    console.error("[review-sell] LỖI:", e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
