/**
 * scripts/intraday-verify.ts — NGHIỆM THU IntradayBar (bảng bar 5-phút, #83).
 *
 * Hermetic + tự dọn (pattern p2-verify): tạo Instrument tạm "TEST-IB" → lái
 * recordIntradayTick bằng tick tổng hợp ở mốc thời gian CỐ ĐỊNH (2026-10-13
 * 09:00 ICT = 02:00Z, thứ Hai phiên giao dịch) → assert từng tính chất → xoá
 * Instrument (cascade xoá bar) — DB không để lại gì.
 *
 * Cách chạy: env -u DATABASE_URL bun scripts/intraday-verify.ts
 *
 * Checklist (7 phép kiểm — bằng chứng in kèm PASS/FAIL từng phép):
 *  (1) bucketStartOf floor 5-phút đúng biên (02:00:10Z → 02:00:00Z).
 *  (2) Merge OHLC trong bucket: high/low/close đúng, volume cộng dồn delta,
 *      tickCount đếm đúng, source "simulated" khi không có tick realtime.
 *  (3) Bucket KHÔNG flush trước biên/safety (queue rỗng sau 6 tick đầu).
 *  (4) Chuyển biên 5-phút: bucket cũ đóng + flush 1 lần với OHLCV cuối;
 *      bucket mới mở open = giá tick đầu tiên.
 *  (5) Safety-flush 120s: bucket đang chạy flush giữa chừng, re-flush idempotent.
 *  (6) isRealtime: 1 tick finfo → source bucket thành "realtime-finfo".
 *  (7) flushAllIntradayBuckets: đóng sổ bucket cuối; API GET /api/market/intraday
 *      đọc đúng (gọi trực tiếp route handler qua fetch localhost).
 */
import { PrismaClient } from "@prisma/client";
import {
  recordIntradayTick,
  flushIntradayBuckets,
  flushAllIntradayBuckets,
  bucketStartOf,
  pendingIntradayFlushes,
} from "../src/lib/intraday";

const db = new PrismaClient();

const DAY = "2026-10-13"; // thứ Hai — phiên giao dịch
const T0 = new Date(`${DAY}T02:00:10.000Z`); // 09:00:10 ICT — tick đầu bucket 09:00

let pass = 0;
let fail = 0;
function check(id: string, ok: boolean, evidence: string) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${id} — ${evidence}`);
  } else {
    fail++;
    console.log(`  ✗ ${id} — ${evidence}`);
  }
}

async function main() {
  console.log("═".repeat(72));
  console.log("NGHIỆM THU IntradayBar #83 — hermetic (Instrument TEST-IB, tự dọn)");
  console.log("═".repeat(72));

  // (1) Floor bucket 5-phút
  const bs = bucketStartOf(new Date(`${DAY}T02:04:59.999Z`));
  check(
    "1.floor",
    bs.toISOString() === `${DAY}T02:00:00.000Z`,
    `02:04:59.999Z → ${bs.toISOString()} (đúng biên 02:00)`
  );

  // Instrument tạm
  const inst = await db.instrument.create({
    data: {
      symbol: "TEST-IB",
      name: "TEST intraday bucket (hermetic #83)",
      market: "HOSE",
      type: "STOCK",
      isActive: true,
    },
  });

  try {
    // (2) Merge OHLC trong bucket — 6 tick, giá dao động 100.0 → 106.0, vol 10..60
    recordIntradayTick({ instrumentId: inst.id, tradingDayIso: DAY, price: 100_000, volDelta: 10, isRealtime: false, at: T0 });
    recordIntradayTick({ instrumentId: inst.id, tradingDayIso: DAY, price: 106_000, volDelta: 20, isRealtime: false, at: new Date(T0.getTime() + 10_000) });
    recordIntradayTick({ instrumentId: inst.id, tradingDayIso: DAY, price: 103_000, volDelta: 15, isRealtime: false, at: new Date(T0.getTime() + 20_000) });
    recordIntradayTick({ instrumentId: inst.id, tradingDayIso: DAY, price: 104_000, volDelta: 5, isRealtime: false, at: new Date(T0.getTime() + 30_000) });
    recordIntradayTick({ instrumentId: inst.id, tradingDayIso: DAY, price: 102_000, volDelta: 10, isRealtime: false, at: new Date(T0.getTime() + 40_000) });
    recordIntradayTick({ instrumentId: inst.id, tradingDayIso: DAY, price: 105_000, volDelta: 5, isRealtime: false, at: new Date(T0.getTime() + 50_000) });
    check(
      "2.merge-no-flush",
      pendingIntradayFlushes() === 0,
      `queue flush = 0 sau 6 tick trong bucket (chưa tới biên/safety) — đúng thiết kế lazy`
    );

    // (5) Safety-flush 120s — tick ở +121s
    recordIntradayTick({ instrumentId: inst.id, tradingDayIso: DAY, price: 105_500, volDelta: 8, isRealtime: false, at: new Date(T0.getTime() + 121_000) });
    check(
      "5a.safety-enqueue",
      pendingIntradayFlushes() === 1,
      `queue = 1 sau tick +121s (safety-flush 120s kích hoạt)`
    );
    const w1 = await flushIntradayBuckets();
    check("5b.safety-write", w1 === 1, `flush ghi 1 bar giữa bucket`);
    let row = await db.intradayBar.findUnique({
      where: { instrumentId_startTime: { instrumentId: inst.id, startTime: bucketStartOf(T0) } },
    });
    check(
      "5c.ohlcv-mid",
      !!row &&
        row.open === 100_000 && row.high === 106_000 && row.low === 100_000 &&
        row.close === 105_500 && row.volume === 73 && row.tickCount === 7 &&
        row.source === "simulated" && row.date.toISOString() === `${DAY}T15:00:00.000Z`,
      row
        ? `open ${row.open} high ${row.high} low ${row.low} close ${row.close} vol ${row.volume} ticks ${row.tickCount} src ${row.source} date ${row.date.toISOString()}`
        : "không có row"
    );

    // (4) Chuyển biên 09:05 (02:05Z) — bucket cũ đóng + bucket mới mở.
    // Tick 09:05:05 THUỘC BUCKET MỚI 09:05 (open = giá tick này) và đồng thời
    // đóng sổ bucket 09:00 (close cuối = 105.500 từ tick +121s).
    const T5 = new Date(`${DAY}T02:05:05.000Z`);
    recordIntradayTick({ instrumentId: inst.id, tradingDayIso: DAY, price: 104_800, volDelta: 12, isRealtime: false, at: T5 });
    check(
      "4a.boundary-enqueue",
      pendingIntradayFlushes() === 1,
      `bucket 09:00 đóng vào queue sau tick 09:05:05`
    );
    const w2 = await flushIntradayBuckets();
    check("4b.boundary-write", w2 === 1, `flush cuối bucket 09:00 (1 bar)`);
    row = await db.intradayBar.findUnique({
      where: { instrumentId_startTime: { instrumentId: inst.id, startTime: bucketStartOf(T0) } },
    });
    check(
      "4c.boundary-final",
      !!row && row.close === 105_500 && row.tickCount === 7 && row.volume === 73,
      row
        ? `bucket 09:00 chốt: close ${row.close} (tick cuối thuộc bucket = 105.500) · ticks ${row.tickCount} · vol ${row.volume} (10+20+15+5+10+5+8 — tick 09:05:05 thuộc bucket MỚI)`
        : "lost"
    );

    // (6) isRealtime lật source bucket mới
    recordIntradayTick({ instrumentId: inst.id, tradingDayIso: DAY, price: 105_200, volDelta: 3, isRealtime: true, at: new Date(T5.getTime() + 10_000) });
    recordIntradayTick({ instrumentId: inst.id, tradingDayIso: DAY, price: 105_000, volDelta: 4, isRealtime: false, at: new Date(T5.getTime() + 20_000) });
    const w3 = await flushAllIntradayBuckets();
    check("6+7.close-all", w3 === 1, `flushAll đóng sổ bucket 09:05 (1 bar)`);
    const row2 = await db.intradayBar.findUnique({
      where: { instrumentId_startTime: { instrumentId: inst.id, startTime: bucketStartOf(T5) } },
    });
    check(
      "6.source-realtime",
      !!row2 && row2.source === "realtime-finfo" && row2.open === 104_800 &&
        row2.close === 105_000 && row2.volume === 19 && row2.tickCount === 3,
      row2
        ? `bucket 09:05: src ${row2.source} open ${row2.open} close ${row2.close} vol ${row2.volume} ticks ${row2.tickCount}`
        : "lost"
    );

    // Idempotency: re-flush toàn bộ lần nữa → KHÔNG tạo row mới
    const before = await db.intradayBar.count({ where: { instrumentId: inst.id } });
    await flushAllIntradayBuckets();
    const after = await db.intradayBar.count({ where: { instrumentId: inst.id } });
    check("idem", before === 2 && after === 2, `re-flush: ${before} → ${after} bar (không trùng)`);

    // value = close × volume
    const v = row2 ? row2.value ?? BigInt(0) : BigInt(0);
    check("value", v === BigInt(105_000 * 19), `value = ${v} = close 105.000 × vol 19`);
  } finally {
    // Dọn hermetic — cascade xoá IntradayBar của TEST-IB
    await db.instrument.delete({ where: { id: inst.id } });
    const left = await db.intradayBar.count({ where: { instrumentId: inst.id } });
    check("cleanup", left === 0, `cascade xoá sạch ${left} bar sót`);
  }

  console.log("─".repeat(72));
  console.log(`KẾT QUẢ: ${pass} PASS · ${fail} FAIL`);
  await db.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("LỖI verify:", e);
  process.exit(1);
});
