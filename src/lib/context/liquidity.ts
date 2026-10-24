/** (Task 144 P2-b) — tách từ src/lib/agent-context.ts (pure move)
 *  Khối A5 Liquidity: buildLiquidityBlock (thanh khoản giao dịch top-10). */

import { db } from "@/lib/db";
import { getForeignFlows } from "@/lib/flows";
import { topByAdtv } from "@/lib/dated-series";
import { latestFeatureSnapshot } from "@/lib/ml/features";

/**
 * Thanh khoản giao dịch top-10 (A5 Liquidity — mở rộng 23 agents):
 * KL/TL20, giá trị giao dịch, chênh lệch bid-ask, dòng khối ngoại.
 */
export async function buildLiquidityBlock(): Promise<string> {
  const [instruments, flows, adtvTop] = await Promise.all([
    db.instrument.findMany({
      // F-1892-01 (fixbug #189): lọc tồn tại Quote ở DB — BROAD không quote
      // (§5.7) khỏi nạp 1.451 hàng chết; hành vi như cũ (downstream lọc null).
      where: { isActive: true, quotes: { some: {} } },
      select: {
        id: true,
        symbol: true,
        sector: true,
        quotes: {
          orderBy: { tradedAt: "desc" },
          take: 1,
          select: {
            last: true,
            volume: true,
            bidPrice: true,
            bidVolume: true,
            askPrice: true,
            askVolume: true,
          },
        },
      },
    }),
    getForeignFlows().catch(() => null),
    // P0-2 (phiên #57): rổ DUY NHẤT topByAdtv — ADTV 45 phiên từ Bar.value
    topByAdtv(10, { market: "HOSE", type: "STOCK" }).catch(() => [] as Awaited<ReturnType<typeof topByAdtv>>),
  ]);

  const quotedById = new Map(
    instruments
      .map((i) => {
        const q = i.quotes[0];
        return q ? { id: i.id, symbol: i.symbol, sector: i.sector, ...q } : null;
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .map((r) => [r.id, r])
  );
  const quoteRows = adtvTop
    .map((t) => {
      const q = quotedById.get(t.id);
      return q ? { ...q, adtv: t.adtv } : null;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const bars = await db.bar.findMany({
    where: { instrumentId: { in: quoteRows.map((t) => t.id) } },
    orderBy: { date: "asc" },
    select: { instrumentId: true, close: true, volume: true },
  });
  const volsBy = new Map<string, number[]>();
  for (const b of bars) {
    const arr = volsBy.get(b.instrumentId) ?? [];
    arr.push(b.volume);
    volsBy.set(b.instrumentId, arr);
  }
  const closesBy = new Map<string, number[]>();
  for (const b of bars) {
    const arr = closesBy.get(b.instrumentId) ?? [];
    arr.push(b.close);
    closesBy.set(b.instrumentId, arr);
  }

  const lines = quoteRows.map((t) => {
    // P0-3: KL/TL20 qua FEATURECONTRACT (cùng số với S2/evidence)
    const snap = latestFeatureSnapshot(closesBy.get(t.id) ?? [], volsBy.get(t.id) ?? []);
    const ratio = snap?.volRatio20 ?? null;
    const spreadPct =
      t.bidPrice && t.askPrice && t.askPrice > 0
        ? ((t.askPrice - t.bidPrice) / t.askPrice) * 100
        : null;
    const adtv = Math.round(t.adtv); // ADTV 45 phiên (VND — Bar.value)
    return [
      `- ${t.symbol} (${t.sector ?? "—"}):`,
      `KL phiên ${t.volume.toLocaleString("vi-VN")} cp`,
      ratio != null ? `KL/TL20 ${ratio.toFixed(2)}×` : "KL/TL20 —",
      `bid/ask ${t.bidPrice?.toLocaleString("vi-VN") ?? "—"}/${t.askPrice?.toLocaleString("vi-VN") ?? "—"}`,
      spreadPct != null ? `chênh ${spreadPct.toFixed(2)}%` : "chênh —",
      adtv > 0 ? `ADTV ~${(adtv / 1_000_000_000).toFixed(1)} tỷ ₫` : "ADTV —",
    ].join(" · ");
  });

  const flowLine = flows
    ? `Dòng khối ngoại phiên gần nhất: ròng ${flows.totalNet >= 0 ? "+" : ""}${(flows.totalNet / 1_000_000_000).toFixed(2)} tỷ ₫ · top mua ${flows.topNet[0]?.symbol ?? "—"} / top bán ${flows.topSell[0]?.symbol ?? "—"}`
    : "Dòng khối ngoại: (nguồn không khả dụng — bỏ metric)";

  return [
    "THANH KHOẢN GIAO DỊCH — TOP 10 THEO ADTV 45 PHIẾN (ADTV = giá trị giao dịch TB từ Bar.value — rổ duy nhất P0-2):",
    ...lines,
    flowLine,
  ].join("\n");
}
