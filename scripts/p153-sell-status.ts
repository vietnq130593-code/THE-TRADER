/**
 * scripts/p153-sell-status.ts — KIỂM ĐỊNH CƠ CHẾ BÁN SAU VÁ TASK 152 (Task 153b)
 *
 * Câu hỏi chủ sở hữu: "Chức năng bán / cơ chế bán giờ đã hoạt động đúng chưa?"
 *
 * Nguyên tắc: KHÔNG TIN LỜI COMMIT — đo lại DB production thật từ mốc deploy
 * vá F-151-1/F-151-2 (07:23 UTC 20/10, commit e66cfbc):
 *   A. Tin hiệu sinh SAU vá: có bind consensusDominant không (tầng b+d sống?)
 *   B. SELL sau vá: gate + dominant + trạng thái + audit auto-decision
 *   C. Vết guard mới trong audit: consensus-direction-mismatch · missing-dominant-snapshot
 *      · SIGNAL_AUTO_REJECTED/PROPOSED sau vá · K1 skip huong-so-dong-khong-khop
 *   D. Lệnh paper SELL sau vá + fill (đường bán production lần đầu?)
 *   E. Sổ hiện tại: vị thế paper + sandbox, cash/equity
 *   F. D-LEDGER chấm lại SELL sau vá
 *
 * Cách chạy: env -u DATABASE_URL bun scripts/p153-sell-status.ts  (từ gốc repo)
 * Read-only: KHÔNG ghi/xoá gì — chỉ SELECT + aggregate.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const FIX_AT = new Date("2026-10-20T07:25:00Z"); // mốc deploy vá (file đổi 07:20-07:23 UTC)

const pct = (r: number | null) => (r == null ? "?" : `${(r * 100).toFixed(1)}%`);

async function main() {
  const out: string[] = [];
  const p = (s = "") => {
    out.push(s);
    console.log(s);
  };

  p("══════ KIỂM ĐỊNH CƠ CHẾ BÁN SAU VÁ TASK 152 — DB PRODUCTION ══════");
  p(`Mốc vá: ${FIX_AT.toISOString()} · Bây giờ: ${new Date().toISOString()}`);
  p("");

  /* ── A. Tín hiệu sinh sau vá — bind dominant sống chưa? ─────────── */
  const since = { createdAt: { gt: FIX_AT } };
  const [postCount, postByDir, postDominant, preDominantBound] = await Promise.all([
    db.signal.count({ where: since }),
    db.signal.groupBy({ where: since, by: ["direction"], _count: true }),
    db.signal.groupBy({ where: since, by: ["consensusDominant"], _count: true }),
    db.signal.count({ where: { createdAt: { lte: FIX_AT }, consensusDominant: { not: null } } }),
  ]);
  p("── A. TÍN HIỆU SAU VÁ (tầng bind consensusDominant) ──");
  p(`Số tín hiệu sinh sau vá: ${postCount}`);
  p(`Theo hướng: ${postByDir.map((d) => `${d.direction}=${d._count}`).join(" · ") || "(chưa có)"}`);
  p(
    `consensusDominant ghi nhận: ${
      postDominant.map((d) => `${d.consensusDominant ?? "null"}=${d._count}`).join(" · ") || "(không tín hiệu nào)"
    }`
  );
  p(`Tín hiệu TRƯỚC vá có dominant (kỳ vọng 0 — cột mới): ${preDominantBound}`);
  p("");

  /* ── B. Chi tiết SELL sau vá ────────────────────────────────────── */
  const sellPosts = await db.signal.findMany({
    where: { direction: "SELL", ...since },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true, createdAt: true, status: true, consensusGate: true,
      consensusDominant: true, consensusRatio: true, instrumentId: true,
    },
  });
  p("── B. SELL SAU VÁ (chi tiết từng tín hiệu) ──");
  if (!sellPosts.length) {
    p("(chưa có tín hiệu SELL nào sinh sau vá — đường bán chưa có dịp chạy production)");
  } else {
    for (const s of sellPosts) {
      const inst = await db.instrument.findUnique({ where: { id: s.instrumentId }, select: { symbol: true } });
      p(
        `${s.createdAt.toISOString().slice(11, 16)}Z ${inst?.symbol ?? "?"} · gate=${s.consensusGate ?? "null"} ` +
          `dominant=${s.consensusDominant ?? "null"} ratio=${pct(s.consensusRatio)} · status=${s.status}`
      );
    }
  }
  p("");

  /* ── C. Vết guard mới trong audit (sau vá) ──────────────────────── */
  const audits = await db.auditLog.findMany({
    where: { createdAt: { gt: FIX_AT } },
    orderBy: { createdAt: "desc" },
    take: 400,
    select: { action: true, entity: true, entityId: true, after: true, createdAt: true },
  });
  const mismatch = audits.filter((a) => (a.after ?? "").includes("consensus-direction-mismatch"));
  const missing = audits.filter((a) => (a.after ?? "").includes("missing-dominant-snapshot"));
  const k1skip = audits.filter((a) => (a.after ?? "").includes("huong-so-dong-khong-khop"));
  const autoApproved = audits.filter((a) => a.action === "SIGNAL_AUTO_APPROVED");
  const autoRejected = audits.filter((a) => a.action === "SIGNAL_AUTO_REJECTED");
  const orderCreated = audits.filter((a) => a.action === "ORDER_CREATED");
  const orderFilled = audits.filter((a) => a.action === "ORDER_FILLED");
  p("── C. AUDIT SAU VÁ (vết các guard + auto-decision) ──");
  p(
    `SIGNAL_AUTO_APPROVED=${autoApproved.length} · SIGNAL_AUTO_REJECTED=${autoRejected.length} · ` +
      `ORDER_CREATED=${orderCreated.length} · ORDER_FILLED=${orderFilled.length}`
  );
  p(`Guard hướng (consensus-direction-mismatch): ${mismatch.length} lần`);
  for (const a of mismatch.slice(0, 5)) p(`   · ${a.createdAt.toISOString().slice(11, 19)}Z ${a.action} → ${a.entityId}`);
  p(`Fail-safe thiếu snapshot (missing-dominant-snapshot): ${missing.length} lần`);
  p(`K1 skip (huong-so-dong-khong-khop-*): ${k1skip.length} lần`);
  for (const a of k1skip.slice(0, 5)) p(`   · ${a.createdAt.toISOString().slice(11, 19)}Z ${a.action} → ${a.after?.slice(0, 120)}`);
  for (const a of autoApproved.slice(0, 5)) {
    let info = "";
    try {
      info = JSON.stringify(JSON.parse(a.after ?? "{}"));
    } catch { info = a.after ?? ""; }
    p(`AUTO_APPROVED: ${a.createdAt.toISOString().slice(11, 19)}Z → ${a.entityId} ${info.slice(0, 160)}`);
  }
  for (const a of autoRejected.slice(0, 5)) {
    let info = "";
    try {
      info = JSON.stringify(JSON.parse(a.after ?? "{}"));
    } catch { info = a.after ?? ""; }
    p(`AUTO_REJECTED: ${a.createdAt.toISOString().slice(11, 19)}Z → ${a.entityId} ${info.slice(0, 160)}`);
  }
  p("");

  /* ── D. Lệnh paper SELL sau vá ──────────────────────────────────── */
  const orders = await db.order.findMany({
    where: { createdAt: { gt: FIX_AT } },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, side: true, status: true, quantity: true, price: true, signalId: true, createdAt: true },
  });
  const sellOrders = orders.filter((o) => o.side === "SELL");
  p("── D. LỆNH PAPER SAU VÁ ──");
  p(`Tổng lệnh: ${orders.length} · SELL: ${sellOrders.length}`);
  for (const o of sellOrders) {
    p(`   · ${o.createdAt.toISOString().slice(11, 19)}Z ${o.side} qty=${o.quantity} price=${o.price} status=${o.status}`);
  }
  p("");

  /* ── E. Sổ hiện tại ─────────────────────────────────────────────── */
  const accounts = await db.brokerAccount.findMany({
    where: { deletedAt: null },
    select: { id: true, accountNumber: true, cashBalance: true, equity: true, status: true },
  });
  p("── E. SỔ HIỆN TẠI ──");
  for (const acc of accounts) {
    const poss = await db.position.findMany({
      where: { brokerAccountId: acc.id, closedAt: null },
      select: { quantity: true, instrumentId: true, avgPrice: true },
    });
    const bal = (n: bigint) => `${Number(n).toLocaleString("vi-VN")}₫`;
    const lines: string[] = [];
    for (const pos of poss) {
      const inst = await db.instrument.findUnique({ where: { id: pos.instrumentId }, select: { symbol: true } });
      lines.push(`${inst?.symbol ?? "?"}=${Number(pos.quantity)}cp@${pos.avgPrice?.toLocaleString("vi-VN")}`);
    }
    p(
      `${acc.accountNumber} (${acc.status}): cash=${bal(acc.cashBalance)} equity=${bal(acc.equity)} ` +
        `· vị thế mở: ${lines.join(" · ") || "(không)"}`
    );
  }
  p("");

  /* ── F. D-LEDGER chấm SELL sau vá ──────────────────────────────── */
  const evals = await db.decisionEvaluation.findMany({
    where: { decidedAt: { gt: FIX_AT }, direction: "SELL" },
    orderBy: { decidedAt: "desc" },
    take: 10,
    select: { markPnlPct: true, verdict: true, executionKind: true, decidedAt: true },
  });
  p("── F. D-LEDGER SELL SAU VÁ ──");
  if (!evals.length) p("(chưa có tín hiệu SELL nào sau vá để chấm)");
  for (const e of evals) {
    p(`   · ${e.decidedAt.toISOString().slice(11, 16)}Z verdict=${e.verdict ?? "?"} markPnl=${e.markPnlPct?.toFixed(2) ?? "?"}% kind=${e.executionKind ?? "?"}`);
  }
  p("");
  p(`Tổng kết: ${postCount} tín hiệu sau vá · ${sellPosts.length} SELL · ${mismatch.length + missing.length} guard bắn · ${sellOrders.length} lệnh SELL đặt`);

  await db.$disconnect();
  await import("node:fs").then((fs) =>
    fs.writeFileSync("/tmp/p153-sell-status-output.txt", out.join("\n"))
  );
}

main().catch(async (e) => {
  console.error("FAIL:", e);
  await db.$disconnect();
  process.exit(1);
});
