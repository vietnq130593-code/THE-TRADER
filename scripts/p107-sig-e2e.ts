import "dotenv/config";
import { db } from "../src/lib/db";
import { createPaperOrderFromSignal } from "../src/lib/signal-execution";

async function main() {
  await db.trade.deleteMany({ where: { order: { note: { contains: "p107-sig" } } } }).catch(() => {});
  await db.decisionEvaluation.deleteMany({ where: { signal: { rationale: "p107-sig-e2e" } } }).catch(() => {});
  await db.order.deleteMany({ where: { note: { contains: "p107-sig" } } }).catch(() => {});
  const sb = await db.brokerAccount.findFirst({ where: { accountType: "sandbox" } });
  const eur = await db.instrument.findFirst({ where: { symbol: "EURUSD=X" } });
  const chairman = await db.agent.findFirst({ where: { code: "portfolio-strategist" } });
  const user = await db.user.findFirst({ where: { isActive: true } });
  if (!sb || !eur || !chairman || !user) {
    console.log("SKIP — thiếu sandbox/EURUSD=X/agent/user");
    await db.$disconnect();
    return;
  }
  const before = { cash: Number(sb.cashBalance), equity: Number(sb.equity) };
  const quote = await db.quote.findFirst({ where: { instrumentId: eur.id }, orderBy: { tradedAt: "desc" } });
  if (!quote || !quote.last) {
    console.log("SKIP — EURUSD=X chưa có quote");
    await db.$disconnect();
    return;
  }
  console.log("EURUSD=X close DB:", quote.last, "= rate", (quote.last / 10000).toFixed(4));

  const sig = await db.signal.create({
    data: {
      instrumentId: eur.id, direction: "BUY", confidence: "HIGH", score: 70,
      rationale: "p107-sig-e2e", agentId: chairman.id, status: "ACTIVE",
      consensusGate: "CONSENSUS", consensusRatio: 0.9, targetPrice: null,
    },
  });
  const res = await createPaperOrderFromSignal(sig.id, { sizing: "sandbox", world: "sandbox", sizePct: 5 });
  const resStr = JSON.stringify(res);
  console.log("createPaperOrderFromSignal ok:", res.ok, "|", resStr.slice(0, 300));
  if (res.ok && (res as { order?: { id: string; quantity: number; price: number } }).order) {
    const o = (res as { order: { id: string; quantity: number; price: number } }).order;
    console.log("order: qty", o.quantity, "price", o.price, "(lot-100:", o.quantity % 100 === 0, ")");
    const tick = await fetch("http://127.0.0.1:3000/api/market/tick", { method: "POST" }).then((r) => r.json()).catch(() => ({}));
    console.log("tick foreignFills:", (tick as { foreignFills?: number }).foreignFills);
    await new Promise((r) => setTimeout(r, 1500));
    const order = await db.order.findUnique({ where: { id: o.id } });
    const pos = await db.position.findUnique({ where: { brokerAccountId_instrumentId: { brokerAccountId: sb.id, instrumentId: eur.id } } });
    let sell: { id: string } | null = null;
    if (!order || !pos) {
      console.log("WARN — không tìm thấy order/position sau tick");
    } else {
    console.log("order status:", order.status, "| position qty:", pos.quantity, "avgPrice:", pos.avgPrice, "avgCostVND:", pos.avgCostVND?.toString());
    const fx = 25934;
    const expectUnit = (quote.last / 10000) * fx;
    console.log("expected avgCostVND ≈", Math.round(expectUnit), "| lệch:", pos.avgCostVND ? Math.abs(Number(pos.avgCostVND) - expectUnit) : "n/a");
    sell = await db.order.create({
      data: { userId: user.id, brokerAccountId: sb.id, instrumentId: eur.id, side: "SELL", type: "LIMIT",
        quantity: pos.quantity, price: Math.round(quote.last * 0.98), status: "PENDING", note: "p107-sig-sell" },
    });
    await fetch("http://127.0.0.1:3000/api/market/tick", { method: "POST" }).then((r) => r.json()).catch(() => ({}));
    await new Promise((r) => setTimeout(r, 1200));
    const pos2 = await db.position.findUnique({ where: { brokerAccountId_instrumentId: { brokerAccountId: sb.id, instrumentId: eur.id } } });
    console.log("after SELL: status:", pos2?.status, "qty:", pos2?.quantity, "realized:", pos2?.realizedPnl?.toString());
    }
    const ids = sell ? [o.id, sell.id] : [o.id];
    await db.trade.deleteMany({ where: { orderId: { in: ids } } });
    await db.auditLog.deleteMany({ where: { entityId: { in: ids } } });
    await db.auditLog.deleteMany({ where: { entity: "Signal", entityId: sig.id } });
    await db.order.deleteMany({ where: { id: { in: ids } } });
    await db.position.deleteMany({ where: { brokerAccountId: sb.id, instrumentId: eur.id } });
    await db.brokerAccount.update({ where: { id: sb.id }, data: { cashBalance: BigInt(before.cash), equity: BigInt(Math.round(before.equity)) } });
    await db.signal.delete({ where: { id: sig.id } });
    console.log("CLEAN — cash restored:", before.cash);
  } else {
    await db.signal.delete({ where: { id: sig.id } }).catch(() => {});
  }
  await db.$disconnect();
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
