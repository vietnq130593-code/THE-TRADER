/**
 * scripts/p106-seed-markets.ts — SEED VŨ TRỤ ĐA THỊ TRƯỜNG #106
 * (COUNCIL_STEWARDSHIP_BLUEPRINT §2.2 — idempotent theo symbol unique).
 *
 * Tạo 16 instrument phi cổ phiếu VN:
 *   BOND (3): US5Y · US10Y · US30Y            — Treasury CSV (2 năm lịch sử)
 *   FOREX (5): EURUSD=X · USDJPY=X · AUDUSD=X — Frankfurter (2023→nay)
 *              VND=X                          — er-api (forward) + Yahoo (backfill)
 *              DX-Y.NYB                       — Yahoo query2
 *   COMMODITY (6): GC=F · SI=F · BZ=F · CL=F · HG=F · NG=F — Yahoo query2
 *
 * Cổ phiếu quốc tế US/HK (14 mã) chạy RIÊNG: bun prisma/expand-universe.ts --intl
 * (danh sách đã verify — MARKET_EXPANSION_BLUEPRINT B12).
 *
 * Chạy:
 *   bun scripts/p106-seed-markets.ts            — chỉ seed instrument
 *   bun scripts/p106-seed-markets.ts --sync     — seed + đồng bộ 3 adapter nhanh
 *                                                 (Treasury/Frankfurter/er-api)
 *   bun scripts/p106-seed-markets.ts --sync-full — seed + ĐẦY ĐỦ kèm Yahoo
 *                                                 query2 backfill 1y (~22 mã ×
 *                                                 2,5s throttle + backoff —
 *                                                 có thể mất vài phút)
 */
import { PrismaClient, Market, InstrumentType } from "@prisma/client";
import {
  TREASURY_INSTRUMENTS,
  FRANKFURTER_INSTRUMENTS,
  ERAPI_INSTRUMENTS,
  YAHOO_MULTI_INSTRUMENTS,
  syncMultiMarkets,
} from "../src/lib/multi-market-sync";

const db = new PrismaClient();

async function main() {
  const defs = [
    ...TREASURY_INSTRUMENTS,
    ...FRANKFURTER_INSTRUMENTS,
    ...ERAPI_INSTRUMENTS,
    ...YAHOO_MULTI_INSTRUMENTS,
  ];
  let created = 0;
  let kept = 0;
  for (const d of defs) {
    const existing = await db.instrument.findUnique({ where: { symbol: d.symbol } });
    if (existing) {
      kept++;
      continue;
    }
    await db.instrument.create({
      data: {
        symbol: d.symbol,
        name: d.name,
        market: d.market as Market,
        type: d.type as InstrumentType,
        currency: d.currency,
        sector: d.sector,
        isActive: true,
      },
    });
    created++;
    console.log(`  ✅ TẠO ${d.symbol} — ${d.market}/${d.type} · ${d.name}`);
  }
  console.log(`Seed xong: ${created} tạo · ${kept} đã có (idempotent)`);

  if (process.argv.includes("--sync") || process.argv.includes("--sync-full")) {
    const full = process.argv.includes("--sync-full");
    console.log(
      full
        ? "\n Đồng bộ ĐẦY ĐỦ (Treasury + Frankfurter + er-api + Yahoo query2 backfill)…"
        : "\n Đồng bộ 3 adapter nhanh (bỏ Yahoo)…"
    );
    const outcome = await syncMultiMarkets(
      full ? { yahooRange: "1y" } : { skipYahoo: true }
    );
    console.log(`Tổng thời gian: ${outcome.durationMs}ms`);
    console.log(
      `Treasury: ok=${outcome.treasury.ok} bars=${outcome.treasury.barsUpserted} ${outcome.treasury.symbolsOk.join(",")}`
    );
    console.log(
      `Frankfurter: ok=${outcome.frankfurter.ok} bars=${outcome.frankfurter.barsUpserted} ${outcome.frankfurter.symbolsOk.join(",")}`
    );
    console.log(
      `er-api: ok=${outcome.erapi.ok} bars=${outcome.erapi.barsUpserted} ${outcome.erapi.symbolsOk.join(",")}`
    );
    if (outcome.yahoo) {
      const y = outcome.yahoo;
      console.log(
        `Yahoo: ok=${y.ok} bars=${y.barsUpserted} ok-mã=${y.symbolsOk.length} lỗi-mã=${y.symbolsFailed.length}`
      );
      if (y.symbolsOk.length) console.log(`  mã OK: ${y.symbolsOk.join(", ")}`);
      if (y.symbolsFailed.length)
        console.log(
          `  mã lỗi: ${y.symbolsFailed.map((f) => `${f.symbol} (${f.error.slice(0, 60)})`).join(" · ")}`
        );
    }
  }
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
