/**
 * prisma/expand-universe-t0.ts — SEED T0 TOÀN SÀN (UNIVERSE_TIERING_BLUEPRINT §3).
 * ═════════════════════════════════════════════════════════════════════
 *
 * Idempotent: mã đã tồn tại (symbol unique) → bỏ qua — chạy lại an toàn,
 * lần 2 tạo 0 instrument mới (nghiệm thu T1.1). Mã ứng viên lấy TỰ ĐỘNG từ
 * finfo listing (§2 — api-finfo resolve OK) rồi PROBE dchart từng mã trước
 * khi tạo (B3 — không tạo instrument chết), kèm lọc hoạt động:
 *   HOSE/HNX/ETF  ≥ 60 bar trong cửa sổ 420 ngày  (~3 tháng có giao dịch)
 *   UPCOM         ≥ 120 bar trong cửa sổ 420 ngày (~nửa năm — bỏ zombie)
 *
 * Tạo Instrument.universeTier = BROAD — KHÔNG Quote (§5.7: không realtime),
 * KHÔNG đụng 104 CORE hiện có. Bar ghi theo pattern deep-backfill: createMany
 * chunk 1.000, PIT firstSeenAt = lastSyncedAt = syncAt.
 *
 * Chạy:  env -u DATABASE_URL bun prisma/expand-universe-t0.ts
 *   (~1.540 probe × 300ms + backfill ≈ 12-15 phút — chạy nền, log ra stdout)
 */
import { PrismaClient } from "@prisma/client";
import { fetchDchartHistory, toRealBars, resolveUnitSpec } from "../src/lib/eod-sync";
import { fetchFinfoListing } from "../src/lib/finfo-listing";

const db = new PrismaClient();

/** Cửa sổ probe/backfill 420 ngày — cùng convention cutoff loadSegmentBaskets (~260 phiên). */
const WINDOW_DAYS = 420;

interface Combo {
  q: string;
  market: "HOSE" | "HNX" | "UPCOM";
  type: "STOCK" | "ETF";
  minBars: number;
}

/** §3.3 — ngưỡng hoạt động (hằng số chỉnh được khi review). */
const COMBOS: Combo[] = [
  { q: "floor:HOSE~status:LISTED~type:STOCK", market: "HOSE", type: "STOCK", minBars: 60 },
  { q: "floor:HOSE~status:LISTED~type:ETF", market: "HOSE", type: "ETF", minBars: 60 },
  { q: "floor:HNX~status:LISTED~type:STOCK", market: "HNX", type: "STOCK", minBars: 60 },
  { q: "floor:HNX~status:LISTED~type:ETF", market: "HNX", type: "ETF", minBars: 60 },
  { q: "floor:UPCOM~status:LISTED~type:STOCK", market: "UPCOM", type: "STOCK", minBars: 120 },
];

async function main() {
  const startedAt = Date.now();
  const toSec = Math.floor(Date.now() / 1000) + 86_400; // +1 ngày chặn biên (đúng eod-sync)
  const fromSec = toSec - WINDOW_DAYS * 86_400;
  const syncAt = new Date();

  const existing = new Set(
    (await db.instrument.findMany({ select: { symbol: true } })).map((i) => i.symbol)
  );
  console.log(`[t0-seed] ${existing.size} instrument đã có — bỏ qua idempotent`);

  interface Cand {
    symbol: string;
    market: Combo["market"];
    type: Combo["type"];
    name: string;
    listingDate: Date | null;
    minBars: number;
  }
  const candidates: Cand[] = [];
  const seen = new Set<string>(); // khử trùng lặp mã xuất hiện ở >1 query finfo
  for (const c of COMBOS) {
    const rows = await fetchFinfoListing(c.q);
    let kept = 0;
    for (const r of rows) {
      if (!r.code || existing.has(r.code) || seen.has(r.code)) continue;
      seen.add(r.code);
      const name = (r.shortName || r.companyName || `${r.code} (${c.market})`).slice(0, 180);
      const listingDate =
        r.listedDate && /^\d{4}-\d{2}-\d{2}/.test(r.listedDate)
          ? new Date(`${r.listedDate.slice(0, 10)}T00:00:00.000Z`)
          : null;
      candidates.push({
        symbol: r.code,
        market: c.market,
        type: c.type,
        name,
        listingDate,
        minBars: c.minBars,
      });
      kept++;
    }
    console.log(`[t0-seed] finfo '${c.q}': ${rows.length} dòng · ${kept} ứng viên mới`);
  }
  console.log(`[t0-seed] TỔNG ứng viên: ${candidates.length} — bắt đầu probe dchart…`);

  let created = 0;
  let barsWritten = 0;
  let emptyCount = 0;
  let belowThreshold = 0;
  let failed = 0;
  let i = 0;
  for (const cand of candidates) {
    i++;
    try {
      const res = await fetchDchartHistory({ symbol: cand.symbol, fromUnixSec: fromSec, toUnixSec: toSec });
      if (res.empty) {
        emptyCount++;
        continue;
      }
      const unit = resolveUnitSpec(cand.market, cand.type);
      const { bars } = toRealBars(cand.symbol, res.bars, unit);
      if (bars.length < cand.minBars) {
        belowThreshold++;
        continue;
      }
      const instrument = await db.instrument.create({
        data: {
          symbol: cand.symbol,
          name: cand.name,
          market: cand.market,
          type: cand.type,
          currency: "VND",
          listingDate: cand.listingDate,
          isActive: true,
          universeTier: "BROAD",
        },
      });
      // createMany chunk 1.000 — đúng pattern deep backfill (đơn symbol ≤ ~290 bar → 1 chunk)
      for (let k = 0; k < bars.length; k += 1000) {
        await db.bar.createMany({
          data: bars.slice(k, k + 1000).map((b) => ({
            instrumentId: instrument.id,
            date: b.date,
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            volume: b.volume,
            value: b.value,
            firstSeenAt: syncAt,
            lastSyncedAt: syncAt,
          })),
        });
      }
      created++;
      barsWritten += bars.length;
      if (i % 100 === 0 || i === candidates.length) {
        console.log(
          `  … ${i}/${candidates.length} · tạo ${created} mã · ${barsWritten.toLocaleString("vi-VN")} bar · rỗng ${emptyCount} · dưới ngưỡng ${belowThreshold}`
        );
      }
    } catch (err) {
      failed++;
      console.error(`  [t0-seed] ${cand.symbol} lỗi:`, err instanceof Error ? err.message : err);
    }
  }

  console.log("════════ T0 SEED XONG ════════");
  console.log(`ứng viên      : ${candidates.length}`);
  console.log(`đã tồn tại    : ${existing.size} (CORE — bỏ qua)`);
  console.log(`tạo mới BROAD : ${created}`);
  console.log(`bar ghi       : ${barsWritten.toLocaleString("vi-VN")}`);
  console.log(`rỗng dchart   : ${emptyCount}`);
  console.log(`dưới ngưỡng   : ${belowThreshold}`);
  console.log(`lỗi           : ${failed}`);
  console.log(`thời gian     : ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);

  // B3 tự lành: quét dọn BROAD 0-bar (script từng bị giết giữa create instrument
  // và createMany bar) — instrument chết không được phép ở lại DB.
  const dead = await db.instrument.findMany({
    where: { universeTier: "BROAD", bars: { none: {} } },
    select: { id: true, symbol: true },
  });
  if (dead.length > 0) {
    const deadIds = dead.map((d) => d.id);
    await db.instrument.deleteMany({ where: { id: { in: deadIds } } });
    console.log(`[t0-seed] dọn ${dead.length} instrument BROAD 0-bar: ${dead.map((d) => d.symbol).slice(0, 10).join(", ")}${dead.length > 10 ? "…" : ""}`);
  } else {
    console.log(`[t0-seed] không có BROAD 0-bar (sạch)`);
  }
}

main()
  .catch((e) => {
    console.error("FATAL:", e);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
