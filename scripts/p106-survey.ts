import { db } from "@/lib/db";

async function main() {
  const byMarketType = await db.instrument.groupBy({
    by: ["market", "type"],
    _count: { _all: true },
    where: { isActive: true },
    orderBy: { market: "asc" },
  });
  console.log("== INSTRUMENTS (active) by market/type ==");
  for (const row of byMarketType) console.log(`${row.market}/${row.type}: ${row._count._all}`);

  const ushk = await db.instrument.findMany({
    where: { market: { in: ["US", "HK"] } },
    select: { symbol: true, name: true, market: true, type: true, currency: true, sector: true },
    orderBy: { symbol: "asc" },
  });
  console.log(`\n== US/HK instruments (${ushk.length}) ==`);
  for (const i of ushk) console.log(`${i.symbol} ${i.market} ${i.type} ${i.currency ?? "?"} ${i.sector ?? "?"} ${i.name}`);

  const barCount = await db.bar.count();
  const intlBars = await db.bar.count({ where: { instrument: { market: { in: ["US", "HK"] } } } });
  console.log(`\nTotal bars: ${barCount} · intl bars: ${intlBars}`);

  const accounts = await db.brokerAccount.findMany({
    select: { id: true, accountNumber: true, accountType: true, cashBalance: true, equity: true, status: true, createdAt: true },
  });
  console.log(`\n== BROKER ACCOUNTS (${accounts.length}) ==`);
  for (const a of accounts)
    console.log(`${a.accountNumber} type=${a.accountType} status=${a.status} cash=${a.cashBalance.toString()} equity=${a.equity.toString()} id=${a.id}`);

  const positions = await db.position.findMany({
    include: { instrument: { select: { symbol: true, market: true } } },
  });
  console.log(`\n== POSITIONS (${positions.length}) ==`);
  for (const p of positions)
    console.log(`${p.instrument.symbol} qty=${p.quantity} avg=${p.avgPrice.toString()} status=${p.status} acc=${p.brokerAccountId.slice(-6)}`);

  const signals = await db.signal.count();
  const orders = await db.order.count();
  const trades = await db.trade.count();
  console.log(`\nSignals: ${signals} · Orders: ${orders} · Trades: ${trades}`);

  const settings = await db.appSetting.findMany({
    where: { key: { in: ["k-sandbox", "k-run", "k4", "llm-model"] } },
    select: { key: true, value: true },
  });
  for (const s of settings) console.log(`\nAppSetting ${s.key}: ${s.value?.slice(0, 220)}`);

  const msgCount = await db.agentMessage.count();
  const assess = await db.marketAssessment.count();
  const runs = await db.agentRun.count();
  console.log(`\nAgentMessages: ${msgCount} · MarketAssessments: ${assess} · AgentRuns: ${runs}`);

  const tasks = await db.agentTask.count();
  console.log(`AgentTasks: ${tasks}`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
