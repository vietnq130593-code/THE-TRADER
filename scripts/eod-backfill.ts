/**
 * scripts/eod-backfill.ts — nạp EOD THẬT từ dchart vào DB dev PGlite (phiên #91).
 * Đơn giản hoá từ prisma/import-real-eod.ts (bỏ phần rebase danh mục demo —
 * DB mới không có positions demo theo triết lý "về 0" #88/#91).
 * Idempotent: deepBackfillEod upsert theo (instrumentId, date).
 * Chạy: env -u DATABASE_URL bun scripts/eod-backfill.ts [fromYear]
 */
import { PrismaClient } from "@prisma/client";
import { deepBackfillEod } from "../src/lib/eod-sync";

const db = new PrismaClient();

async function main() {
  const fromYear = Number(process.argv[2] || "2013");
  console.log(`[eod-backfill] deep backfill từ ${fromYear} (dchart public, idempotent)…`);
  const outcome = await deepBackfillEod({ fromYear });
  console.log(
    `[eod-backfill] XONG: ok=${outcome.symbolsOk?.length ?? 0} mã · empty=${outcome.symbolsEmpty?.length ?? 0} · failed=${outcome.symbolsFailed?.length ?? 0} · bars=${outcome.barsUpserted} · lastTradeDate=${outcome.lastTradeDate ?? "?"}`
  );
  if (outcome.symbolsFailed && outcome.symbolsFailed.length > 0) {
    console.log("[eod-backfill] FAIL chi tiết:", JSON.stringify(outcome.symbolsFailed.slice(0, 10)));
  }
}

main()
  .catch((err) => {
    console.error("[eod-backfill] LỖI:", err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
