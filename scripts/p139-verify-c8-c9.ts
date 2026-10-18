/**
 * scripts/p139-verify-c8-c9.ts (Task 139 · F-23 P4) — NGHIỆM THU C8 + C9
 * (audit 137) trên DB SỐNG:
 *
 * C9 — SELECT … FOR UPDATE row-lock tài khoản trong interactive transaction
 *      (cú pháp + hành vi khoá của đường fillOrder mới — tick route:245-253):
 *      (1) mở tx, khoá tài khoản paper;
 *      (2) TỪ MODULE KẾT NỐI THỨ HAI (connection riêng) thử khoá cùng hàng
 *          FOR UPDATE NOWAIT → kỳ vọng bị TỪ CHỐI (LockNotAvailable) chứng
 *          minh hàng đang bị khoá thật (không phải khoá suông);
 *      (3) rollback tx 1 → module 2 khoá lại ĐƯỢC (khoá nhả đúng).
 *
 * C8 — bất biến sổ phí: MỌI Order FILLED có Trade → Order.fee ≡ Σ Trade.fee
 *      (full-fill 1 shot cho 2 số bằng nhau — giữ nguyên sau vá; lệnh
 *      PARTIAL tương lai hằng bất biến này được đường accumulate duy trì).
 *
 * Chạy: env -u DATABASE_URL bun scripts/p139-verify-c8-c9.ts
 */
import { PrismaClient } from "@prisma/client";

async function main(): Promise<void> {
  console.log("════ P139 VERIFY C8 + C9 (audit 137 — live DB) ════");
  const db = new PrismaClient(); // module 1 (tx khoá)
  const db2 = new PrismaClient(); // module 2 (đối chứng khoá — connection riêng)

  /* ── C9: row-lock FOR UPDATE ── */
  const paper = await db.brokerAccount.findFirst({
    where: { accountType: { not: "sandbox" }, deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, accountNumber: true },
  });
  if (!paper) throw new Error("Không tìm thấy tài khoản paper");
  console.log(`[C9] tài khoản paper: ${paper.accountNumber} (${paper.id})`);

  let lockedRejected = false;
  let unlockedAfterRollback = false;
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM trader."BrokerAccount" WHERE id = ${paper.id} FOR UPDATE`;
    console.log("[C9.1] tx1 đã giữ khoá FOR UPDATE.");
    try {
      await db2.$queryRaw`SELECT id FROM trader."BrokerAccount" WHERE id = ${paper.id} FOR UPDATE NOWAIT`;
      console.log("[C9.2] SAI — connection 2 VẪN khoá được hàng (khoá không hoạt động!)");
    } catch (err) {
      lockedRejected = true;
      const code = (err as { code?: string }).code;
      console.log(`[C9.2] connection 2 BỊ TỪ CHỐI đúng kỳ vọng (${code ?? "?"} — LockNotAvailable) ✓`);
    }
    // rollback: throw để $transaction rollback (không ghi gì — tx chỉ SELECT)
    throw new Error("__ROLLBACK_ONLY__");
  }).catch((e) => {
    if ((e as Error).message !== "__ROLLBACK_ONLY__") throw e;
  });
  try {
    await db2.$queryRaw`SELECT id FROM trader."BrokerAccount" WHERE id = ${paper.id} FOR UPDATE NOWAIT`;
    unlockedAfterRollback = true;
    console.log("[C9.3] sau rollback tx1, connection 2 khoá lại ĐƯỢC (khoá nhả đúng) ✓");
  } catch {
    console.log("[C9.3] SAI — hàng vẫn bị khoá sau rollback!");
  }
  const c9Pass = lockedRejected && unlockedAfterRollback;

  /* ── C8: bất biến Order.fee ≡ Σ Trade.fee ── */
  const filledOrders = await db.order.findMany({
    where: { status: "FILLED" },
    select: {
      id: true,
      instrument: { select: { symbol: true } },
      fee: true,
      quantity: true,
      trades: { select: { fee: true, quantity: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  let checked = 0;
  let mismatches = 0;
  const samples: string[] = [];
  for (const o of filledOrders) {
    if (o.trades.length === 0) continue;
    const sumTradeFee = o.trades.reduce((s, t) => s + (t.fee ?? BigInt(0)), BigInt(0));
    checked++;
    if (sumTradeFee !== o.fee) {
      mismatches++;
      if (samples.length < 5) {
        samples.push(`${o.instrument.symbol} order=${o.id} Order.fee=${o.fee} ΣTrade.fee=${sumTradeFee}`);
      }
    }
  }
  console.log(
    `[C8] ${checked} lệnh FILLED có Trade (500 gần nhất): ${mismatches} lệch Order.fee ≠ Σ Trade.fee ${
      mismatches === 0 ? "✓ (bất biến giữ — full-fill 2 số bằng nhau; đường accumulate C8 duy trì cho partial)" : "✗"
    }`
  );
  for (const s of samples) console.log(`      ${s}`);

  console.log(
    `\nKẾT QUẢ: C9 ${c9Pass ? "PASS ✓" : "FAIL ✗"} · C8 ${mismatches === 0 ? "PASS ✓" : "FAIL ✗"}`
  );
  process.exitCode = c9Pass && mismatches === 0 ? 0 : 1;
  await db.$disconnect();
  await db2.$disconnect();
}

main().catch((err) => {
  console.error("LỖI chặn:", err);
  process.exitCode = 1;
});
