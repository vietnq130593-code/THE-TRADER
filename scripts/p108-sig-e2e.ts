/**
 * scripts/p108-sig-e2e.ts — E2E #108: đường tín hiệu → cổng B9 → lệnh sandbox
 * dưới chính sách VN-only (v2.2). Thay thế p107-sig-e2e.ts (đa thị trường đã
 * thu hồi). Hermetic — TỰ DỌN sau chạy.
 *
 * Kịch bản:
 *  (1) EURUSD=X BUY CONSENSUS → createPaperOrderFromSignal phải CHẶN
 *      (ok:false · 400 · thông điệp chính sách) — không có lệnh, không đổi cash.
 *  (2) TCB BUY CONSENSUS → lệnh tạo được đúng luật VN (lot-100 · giá băng)
 *      rồi dọn sạch (lệnh PENDING không trừ cash — chỉ xoá).
 */

import "dotenv/config";
import { db } from "../src/lib/db";
import { createPaperOrderFromSignal } from "../src/lib/signal-execution";

async function main() {
  const sb = await db.brokerAccount.findFirst({ where: { accountType: "sandbox" } });
  const chairman = await db.agent.findFirst({ where: { code: "portfolio-strategist" } });
  if (!sb || !chairman) {
    console.log("SKIP — thiếu sandbox/agent");
    await db.$disconnect();
    return;
  }
  const before = { cash: Number(sb.cashBalance), equity: Number(sb.equity) };

  // ── (1) EURUSD=X — tín hiệu forex bị chặn theo chính sách VN-only ──
  const eur = await db.instrument.findFirst({ where: { symbol: "EURUSD=X" } });
  if (!eur) {
    console.log("SKIP — không có EURUSD=X");
  } else {
    const sig = await db.signal.create({
      data: {
        instrumentId: eur.id, direction: "BUY", confidence: "HIGH", score: 70,
        rationale: "p108-sig-e2e", agentId: chairman.id, status: "ACTIVE",
        consensusGate: "CONSENSUS", consensusRatio: 0.9,
      },
    });
    const res = await createPaperOrderFromSignal(sig.id, { sizing: "sandbox", world: "sandbox", sizePct: 5 });
    const orders = await db.order.count({ where: { signalId: sig.id } });
    const status = "status" in res ? res.status : undefined;
    console.log("(1) EURUSD=X BUY →", JSON.stringify(res));
    console.log("    lệnh tạo:", orders, "| ok:", res.ok, "| status:", status);
    const blocked = res.ok === false && res.status === 400 && typeof res.error === "string" && res.error.includes("chính sách");
    console.log(blocked ? "    ✔ CHẶN ĐÚNG CHÍNH SÁCH" : "    ✘ KHÔNG chặn như kỳ vọng!");
    await db.signal.delete({ where: { id: sig.id } }).catch(() => {});
    process.exitCode = blocked && orders === 0 ? process.exitCode : 1;
  }

  // ── (2) TCB — hồi quy CP VN còn tạo lệnh được ──
  const tcb = await db.instrument.findFirst({ where: { symbol: "TCB" } });
  if (!tcb) {
    console.log("SKIP — không có TCB");
  } else {
    const sig = await db.signal.create({
      data: {
        instrumentId: tcb.id, direction: "BUY", confidence: "HIGH", score: 70,
        rationale: "p108-sig-e2e", agentId: chairman.id, status: "ACTIVE",
        consensusGate: "CONSENSUS", consensusRatio: 0.9,
      },
    });
    const res = await createPaperOrderFromSignal(sig.id, { sizing: "sandbox", world: "sandbox", sizePct: 5 });
    const o = (res as { order?: { id: string; quantity: number; price: number } }).order;
    if (res.ok && o) {
      console.log("(2) TCB BUY → ok · qty", o.quantity, "(lot-100:", o.quantity % 100 === 0, ") · price", o.price);
      await db.auditLog.deleteMany({ where: { entityId: o.id } });
      await db.order.deleteMany({ where: { id: o.id } });
    } else {
      console.log("(2) TCB BUY → THẤT BẠI:", JSON.stringify(res).slice(0, 200));
      process.exitCode = 1;
    }
    await db.signal.delete({ where: { id: sig.id } }).catch(() => {});
  }

  // ── Dọn sạch + khẳng định hermetic ──
  const after = await db.brokerAccount.findUnique({ where: { id: sb.id } });
  const cashOk = after != null && Number(after.cashBalance) === before.cash;
  console.log("CLEAN — cash:", Number(after?.cashBalance), "vs trước:", before.cash, cashOk ? "(OK)" : "(LECH!)");
  if (!cashOk) process.exitCode = 1;
  await db.$disconnect();
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
