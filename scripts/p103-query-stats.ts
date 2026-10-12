import { db } from '../src/lib/db';
async function main() {
  const sectors = await db.instrument.groupBy({ by: ['sector'], where: { market: 'HOSE' }, _count: true });
  console.log('HOSE sectors:', sectors.map(s => `${s.sector}:${s._count}`).join(' '));
  // Bar date convention: check a sample of bars for E1VFVN30
  const bars = await db.bar.findMany({ where: { instrument: { symbol: 'E1VFVN30' } }, orderBy: { date: 'desc' }, take: 5, select: { date: true, close: true, volume: true } });
  console.log('E1VFVN30 last 5 bars:', JSON.stringify(bars.map(b => ({ d: b.date.toISOString().slice(0, 10), c: b.close }))));
  // news per day counts
  const news = await db.newsItem.findMany({ select: { publishedAt: true, category: true }, orderBy: { publishedAt: 'asc' } });
  const perDay = new Map<string, number>();
  for (const n of news) { const d = n.publishedAt.toISOString().slice(0, 10); perDay.set(d, (perDay.get(d) ?? 0) + 1); }
  console.log('News per day:', [...perDay.entries()].map(([d, c]) => `${d}:${c}`).join(' '));
}
main().then(() => db.$disconnect());
