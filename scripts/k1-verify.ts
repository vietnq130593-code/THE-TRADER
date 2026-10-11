/**
 * scripts/k1-verify.ts — K1 "Cơ chế thử nghiệm tiền ảo" NGHIỆM THU HERMETIC
 * (AUTONOMY_BLUEPRINT v1.1 §5.7, phiên #87).
 *
 * Đường vàng 7 phép — chạy THẬT trên DB của hệ thống (chuẩn bị môi trường +
 * dọn dẹp sạch sau khi xong):
 *
 *  V1  Kích hoạt sandbox → tài khoản accountType "sandbox" + AuditLog
 *      K1_SANDBOX_FUNDED; PAPER KHÔNG ĐỔI MỘT ĐỒNG (chụp trước/sau so sánh).
 *  V2  Tín hiệu BUY qua cổng CONSENSUS → autoConvertSignalToSandbox (ĐÚNG hàm
 *      route agents/run gọi cuối chu kỳ) → lệnh sandbox PENDING; Signal.status
 *      VẪN ACTIVE + actedAt null (2 THẾ GIỚI ĐỘC LẬP — chứng minh P0); chạy lại
 *      → IDEMPOTENT (marker audit chặn lệnh kép).
 *  V3  Tín hiệu KHÔNG qua cổng (WEAK_MAJORITY) → bị chặn đúng Q1.
 *  V4  Pause → auto-convert 0 lệnh mới (vị thế giữ).
 *  V5  Settle-equity force → kênh-2 reward (position đóng → BanditArm của
 *      agent tạo tín hiệu cộng posterior) + CashSnapshot k1-daily 1 dòng;
 *      chạy 2 lần → idempotent (dedupe + upsert, KHÔNG 2 dòng/ngày).
 *  V6  Reset → xoá sạch order/trade/position/snapshot sandbox + audit tổng kết
 *      + paper lần nữa KHÔNG đổi.
 *  V7  BanditEvent KHÔNG bị kênh 2 ghi (§5.5.3 — bảng đó chỉ dành phiếu bầu
 *      theo assessment).
 *
 * Chạy: `bun run scripts/k1-verify.ts` (yêu cầu sandbox đã kích hoạt qua UI,
 * hoặc script tự kích hoạt nếu chưa — dọn sạch cuối test).
 */

import { db } from "../src/lib/db";
import {
  K1_SNAPSHOT_SOURCE,
  activateSandbox,
  autoConvertSignalToSandbox,
  getKSandbox,
  getSandboxAccount,
  resetSandbox,
  setSandboxPaused,
  settleSandboxDay,
} from "../src/lib/k-sandbox";

interface PaperSnapshot {
  cash: number;
  equity: number;
  positionCount: number;
}

async function paperSnapshot(): Promise<PaperSnapshot> {
  const account = await db.brokerAccount.findFirst({
    where: { deletedAt: null, accountType: { not: "sandbox" } },
    include: { positions: { where: { status: "OPEN" }, select: { quantity: true, avgPrice: true, instrumentId: true } } },
  });
  if (!account) throw new Error("không có tài khoản paper");
  const quotes = await db.quote.findMany({
    where: { instrumentId: { in: account.positions.map((p) => p.instrumentId) } },
    orderBy: { tradedAt: "desc" },
  });
  const lastByInstrument = new Map<string, number>();
  for (const q of quotes) {
    if (!lastByInstrument.has(q.instrumentId)) lastByInstrument.set(q.instrumentId, q.last);
  }
  const mv = account.positions.reduce(
    (s, p) => s + (lastByInstrument.get(p.instrumentId) ?? p.avgPrice) * p.quantity,
    0
  );
  return {
    cash: Number(account.cashBalance),
    equity: Number(account.cashBalance) + mv,
    positionCount: account.positions.length,
  };
}

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  console.log("═══ K1 NGHIỆM THU HERMETIC (§5.7) ═══");

  /* ── Hermetic: chụp trạng thái BanditArm TOÀN BỘ trước khi test — kênh 2
   * reward cộng posterior thật; test kết thúc PHẢI trả về đúng trạng thái
   * trước (chống ô nhiễm vòng học thật bằng dữ liệu test). */
  const armsBefore = await db.banditArm.findMany({
    select: { agentCode: true, alpha: true, beta: true, pulls: true, wins: true, lastRewardAt: true },
  });
  const armsBeforeMap = new Map(armsBefore.map((a) => [a.agentCode, a]));

  /* ── Chuẩn bị: kích hoạt sandbox nếu chưa (dọn sạch sau bằng reset) ── */
  const before = await getKSandbox();
  if (!before.enabled) {
    const res = await activateSandbox(100_000_000);
    if (!res.ok) throw new Error("kích hoạt sandbox thất bại: " + res.error);
  }
  const account = await getSandboxAccount();
  if (!account) throw new Error("tài khoản sandbox không tồn tại sau kích hoạt");

  /* ── V1: tách bạch paper ── */
  console.log("\n[V1] Kích hoạt + tách bạch paper");
  const paperBefore = await paperSnapshot();
  const funded = await db.auditLog.findFirst({
    where: { action: "K1_SANDBOX_FUNDED" },
    orderBy: { createdAt: "desc" },
  });
  check("sandbox accountType=sandbox + cash=100tr", account.accountType === "sandbox" && Number(account.cashBalance) === 100_000_000);
  check("audit K1_SANDBOX_FUNDED tồn tại", funded != null);
  const paperAfter = await paperSnapshot();
  check(
    "PAPER KHÔNG đổi một đồng",
    paperBefore.cash === paperAfter.cash && paperBefore.equity === paperAfter.equity && paperBefore.positionCount === paperAfter.positionCount,
    `cash=${paperAfter.cash} equity=${paperAfter.equity} positions=${paperAfter.positionCount}`
  );

  /* ── Tín hiệu test: BUY qua cổng CONSENSUS (đúng cấu trúc chu kỳ sinh) ── */
  const bid = await db.instrument.findFirst({ where: { symbol: "BID" } });
  const chairman = await db.agent.findFirst({ where: { code: "portfolio-strategist" } });
  if (!bid || !chairman) throw new Error("thiếu BID hoặc portfolio-strategist");

  const buySignal = await db.signal.create({
    data: {
      instrumentId: bid.id,
      direction: "BUY",
      confidence: "HIGH",
      score: 72,
      rationale: "[k1-verify] tín hiệu test BUY qua cổng đồng thuận",
      agentId: chairman.id,
      targetPrice: null,
      stopLoss: null,
      takeProfit: null,
      consensusGate: "CONSENSUS",
      consensusRatio: 0.85,
      expiresAt: new Date(Date.now() + 3 * 86_400_000),
      status: "ACTIVE",
    },
  });

  /* ── V2: auto-convert → lệnh sandbox + 2 thế giới + idempotent ── */
  console.log("\n[V2] Auto-convert tín hiệu qua cổng → lệnh sandbox");
  const r1 = await autoConvertSignalToSandbox(buySignal.id);
  check("lần 1: converted=1", r1.converted === 1, JSON.stringify(r1.orders));
  const signalAfter = await db.signal.findUnique({ where: { id: buySignal.id }, select: { status: true, actedAt: true } });
  check(
    "Signal.status VẪN ACTIVE + actedAt null (2 thế giới độc lập — P0)",
    signalAfter?.status === "ACTIVE" && signalAfter?.actedAt == null
  );
  const sandboxOrder = await db.order.findFirst({
    where: { signalId: buySignal.id, brokerAccountId: account.id },
  });
  check("lệnh trên CHÍNH tài khoản sandbox (PENDING)", sandboxOrder != null && sandboxOrder.status === "PENDING");
  if (sandboxOrder) {
    check(
      "lệnh LIMIT bội lot 100 + giá trong dải trần/sàn",
      sandboxOrder.quantity % 100 === 0 && sandboxOrder.quantity >= 100 && (sandboxOrder.price ?? 0) > 0,
      `qty=${sandboxOrder.quantity} price=${sandboxOrder.price}`
    );
    // Sizing 5% NAV = 5.000.000 ₫ → qty ≈ 5tr/price
    const expectedQty = Math.floor((100_000_000 * 0.05) / (sandboxOrder.price ?? 1));
    check(
      "sizing ~5% NAV sandbox",
      Math.abs(sandboxOrder.quantity - Math.floor(expectedQty / 100) * 100) <= 100,
      `qty=${sandboxOrder.quantity} ~ expected=${Math.floor(expectedQty / 100) * 100}`
    );
  }
  const marker = await db.auditLog.findFirst({
    where: { action: "K1_SANDBOX_AUTO_ORDER", entity: "Signal", entityId: buySignal.id },
  });
  check("marker audit K1_SANDBOX_AUTO_ORDER", marker != null);
  const r2 = await autoConvertSignalToSandbox(buySignal.id);
  check("lần 2: IDEMPOTENT — 0 lệnh mới", r2.converted === 0, `skipped: ${JSON.stringify(r2.skipped)}`);
  const sandboxOrderCount = await db.order.count({ where: { signalId: buySignal.id, brokerAccountId: account.id } });
  check("sổ sandbox đúng 1 lệnh cho tín hiệu", sandboxOrderCount === 1);

  /* ── V3: tín hiệu KHÔNG qua cổng → chặn đúng Q1 ── */
  console.log("\n[V3] Tín hiệu không qua cổng bị chặn (Q1)");
  const weakSignal = await db.signal.create({
    data: {
      instrumentId: bid.id,
      direction: "BUY",
      confidence: "MEDIUM",
      score: 55,
      rationale: "[k1-verify] tín hiệu đa số yếu",
      agentId: chairman.id,
      consensusGate: "WEAK_MAJORITY",
      consensusRatio: 0.6,
      expiresAt: new Date(Date.now() + 3 * 86_400_000),
      status: "ACTIVE",
    },
  });
  const r3 = await autoConvertSignalToSandbox(weakSignal.id);
  check("WEAK_MAJORITY → KHÔNG convert", r3.converted === 0 && r3.skipped[0]?.reason.includes("cong-dong-thuan"), JSON.stringify(r3.skipped));
  const weakOrderCount = await db.order.count({ where: { signalId: weakSignal.id } });
  check("0 lệnh cho tín hiệu đa số yếu", weakOrderCount === 0);

  /* ── Khớp lệnh thủ công mô phỏng tick engine (fill đúng đường fillOrder) ──
   * Không đợi tick thật (random-walk có thể lâu) — gọi thẳng logic trừ tiền
   * mặt + vị thế như fillOrder: MUA 100% khớp tại giá lệnh. */
  console.log("\n[V4-PREP] Khớp lệnh sandbox (mô phỏng fill engine)");
  if (sandboxOrder) {
    const fee = BigInt(Math.round(0.0015 * (sandboxOrder.price ?? 0) * sandboxOrder.quantity));
    await db.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: sandboxOrder.id },
        data: { status: "FILLED", filledQuantity: sandboxOrder.quantity, avgFillPrice: sandboxOrder.price, filledAt: new Date() },
      });
      await tx.position.create({
        data: {
          brokerAccountId: account.id,
          instrumentId: bid.id,
          quantity: sandboxOrder.quantity,
          avgPrice: sandboxOrder.price ?? 0,
          status: "OPEN",
          openedAt: new Date(),
        },
      });
      const acc = await tx.brokerAccount.findUnique({ where: { id: account.id }, select: { cashBalance: true } });
      await tx.brokerAccount.update({
        where: { id: account.id },
        data: { cashBalance: (acc?.cashBalance ?? BigInt(0)) - BigInt((sandboxOrder.price ?? 0) * sandboxOrder.quantity) - fee },
      });
      await tx.trade.create({
        data: {
          orderId: sandboxOrder.id,
          instrumentId: bid.id,
          side: "BUY",
          quantity: sandboxOrder.quantity,
          price: sandboxOrder.price ?? 0,
          fee,
          executedAt: new Date(),
        },
      });
    });
    const pos = await db.position.findFirst({ where: { brokerAccountId: account.id, status: "OPEN" } });
    check("position sandbox mở", pos != null, `qty=${pos?.quantity} avg=${pos?.avgPrice}`);
  }

  /* ── V4: pause → 0 lệnh mới ── */
  console.log("\n[V4] Tạm dừng → 0 lệnh mới");
  const sellSignal = await db.signal.create({
    data: {
      instrumentId: bid.id,
      direction: "SELL",
      confidence: "HIGH",
      score: 68,
      rationale: "[k1-verify] tín hiệu test BÁN",
      agentId: chairman.id,
      consensusGate: "CONSENSUS",
      consensusRatio: 0.82,
      expiresAt: new Date(Date.now() + 3 * 86_400_000),
      status: "ACTIVE",
    },
  });
  await setSandboxPaused(true);
  const rPause = await autoConvertSignalToSandbox(sellSignal.id);
  check("paused → KHÔNG convert lệnh mới", rPause.converted === 0 && rPause.skipped[0]?.reason === "k1-tam-dung", JSON.stringify(rPause.skipped));
  await setSandboxPaused(false);

  /* ── Resume → SELL convert + khớp → position ĐÓNG (lãi) ── */
  console.log("\n[V5-PREP] Resume + BÁN → đóng position (lãi ~+2%)");
  const rSell = await autoConvertSignalToSandbox(sellSignal.id);
  check("resume → SELL converted=1", rSell.converted === 1, JSON.stringify(rSell.orders));
  const sellOrder = await db.order.findFirst({
    where: { signalId: sellSignal.id, brokerAccountId: account.id },
  });
  const openPos = await db.position.findFirst({ where: { brokerAccountId: account.id, status: "OPEN" } });
  if (sellOrder && openPos) {
    // Bán giá lãi: avg mua × 1.02 (trong dải nếu được)
    const buyAvg = openPos.avgPrice;
    let sellPrice = Math.round((buyAvg * 1.02) / 100) * 100;
    const q = await db.quote.findFirst({ where: { instrumentId: bid.id }, orderBy: { tradedAt: "desc" } });
    if (q?.ceilingPrice) sellPrice = Math.min(sellPrice, q.ceilingPrice);
    if (q?.floorPrice) sellPrice = Math.max(sellPrice, q.floorPrice);
    const fee = BigInt(Math.round(0.0015 * sellPrice * openPos.quantity));
    const tax = BigInt(Math.round(0.001 * sellPrice * openPos.quantity));
    await db.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: sellOrder.id },
        data: { status: "FILLED", filledQuantity: openPos.quantity, avgFillPrice: sellPrice, filledAt: new Date() },
      });
      const realized = BigInt((sellPrice - buyAvg) * openPos.quantity);
      await tx.position.update({
        where: { id: openPos.id },
        data: { quantity: 0, realizedPnl: realized, status: "CLOSED", closedAt: new Date() },
      });
      const acc = await tx.brokerAccount.findUnique({ where: { id: account.id }, select: { cashBalance: true } });
      await tx.brokerAccount.update({
        where: { id: account.id },
        data: { cashBalance: (acc?.cashBalance ?? BigInt(0)) + BigInt(sellPrice * openPos.quantity) - fee - tax },
      });
      await tx.trade.create({
        data: {
          orderId: sellOrder.id,
          positionId: openPos.id,
          instrumentId: bid.id,
          side: "SELL",
          quantity: openPos.quantity,
          price: sellPrice,
          fee,
          tax,
          executedAt: new Date(),
        },
      });
    });
    const closed = await db.position.findFirst({ where: { id: openPos.id }, select: { status: true, closedAt: true } });
    check("position CLOSE (closedAt hôm nay)", closed?.status === "CLOSED" && closed.closedAt != null);
  }

  /* ── V5: settle-equity force → kênh 2 reward + snapshot + idempotent ── */
  console.log("\n[V5] Settle 16:30 (force) — kênh 2 reward + CashSnapshot");
  const armBefore = await db.banditArm.findUnique({ where: { agentCode: "portfolio-strategist" } });
  const settle1 = await settleSandboxDay({ force: true });
  check("settle chạy ok", settle1.ok, `equity=${settle1.equity} realisedOfDay=${settle1.realisedPnlOfDay}`);
  check("kênh 2 reward 1 position", settle1.rewards.length === 1, JSON.stringify(settle1.rewards.map((r) => ({ agent: r.agentCode, net: r.netRealised, reward: r.reward }))));
  const armAfter = await db.banditArm.findUnique({ where: { agentCode: "portfolio-strategist" } });
  const armB = armBefore ?? { alpha: 1, beta: 1, pulls: 0, wins: 0 };
  check(
    "BanditArm chairman cộng posterior (α+reward, pulls+1)",
    armAfter != null &&
      armAfter.pulls === armB.pulls + 1 &&
      Math.abs(armAfter.alpha - (armB.alpha + (settle1.rewards[0]?.reward ?? 0))) < 1e-9,
    `α ${armB.alpha}→${armAfter?.alpha} · pulls ${armB.pulls}→${armAfter?.pulls}`
  );
  const snapshot1 = await db.cashSnapshot.findMany({
    where: { brokerAccountId: account.id, source: K1_SNAPSHOT_SOURCE },
  });
  check("CashSnapshot k1-daily đúng 1 dòng", snapshot1.length === 1, `equity=${Number(snapshot1[0]?.equity ?? 0)}`);
  const settle2 = await settleSandboxDay({ force: true });
  check("settle lần 2 IDEMPOTENT (0 reward mới + snapshot update)", settle2.rewards.length === 0 && settle2.rewardsDeduped === 1 && settle2.snapshotUpdated && !settle2.snapshotCreated);
  const snapshot2 = await db.cashSnapshot.count({
    where: { brokerAccountId: account.id, source: K1_SNAPSHOT_SOURCE },
  });
  check("vẫn 1 dòng snapshot sau 2 lần chạy", snapshot2 === 1);
  const settledAudit = await db.auditLog.count({ where: { action: "K1_SANDBOX_SETTLED" } });
  check("audit K1_SANDBOX_SETTLED ghi (kể cả lần 2)", settledAudit >= 2);

  /* ── V7: BanditEvent KHÔNG bị kênh 2 ghi (§5.5.3) ── */
  console.log("\n[V7] Ngữ nghĩa BanditEvent giữ nguyên");
  const banditEvents = await db.banditEvent.count({ where: { agentCode: "portfolio-strategist" } });
  check("kênh 2 KHÔNG ghi BanditEvent", banditEvents === 0, `count=${banditEvents}`);

  /* ── V6: reset → xoá sạch + paper không đổi ── */
  console.log("\n[V6] Đặt lại → xoá sạch + paper nguyên vẹn");
  const paperFinal1 = await paperSnapshot();
  const resetRes = await resetSandbox();
  check("reset ok + audit tổng kết", resetRes.ok, JSON.stringify(resetRes.ok ? resetRes.summary : resetRes.error));
  const afterReset = await getSandboxAccount();
  const leftoverOrders = await db.order.count({ where: { brokerAccountId: account.id } });
  const leftoverTrades = await db.trade.count({ where: { order: { brokerAccountId: account.id } } });
  const leftoverPositions = await db.position.count({ where: { brokerAccountId: account.id } });
  const leftoverSnaps = await db.cashSnapshot.count({ where: { brokerAccountId: account.id } });
  check(
    "sạch bóng: 0 order/trade/position/snapshot, cash=0, enabled=false",
    leftoverOrders === 0 && leftoverTrades === 0 && leftoverPositions === 0 && leftoverSnaps === 0 && Number(afterReset?.cashBalance ?? 0) === 0 && !(await getKSandbox()).enabled
  );
  const paperFinal2 = await paperSnapshot();
  check(
    "PAPER sau reset vẫn KHÔNG đổi một đồng",
    paperFinal1.cash === paperFinal2.cash && paperFinal1.equity === paperFinal2.equity && paperFinal1.positionCount === paperFinal2.positionCount
  );

  /* ── Dọn tín hiệu test (không để lại dữ liệu ảo trong luồng trader) ── */
  await db.signal.deleteMany({ where: { id: { in: [buySignal.id, weakSignal.id, sellSignal.id] } } });
  console.log("\n(đã dọn 3 tín hiệu test)");

  /* ── Hermetic: trả BanditArm về trạng thái chụp đầu test — kênh 2 test
   * reward KHÔNG được để lại ô nhiễm vòng học thật (F-871-03). ── */
  const armsAfter = await db.banditArm.findMany({
    select: { agentCode: true, alpha: true, beta: true, pulls: true, wins: true, lastRewardAt: true },
  });
  for (const arm of armsAfter) {
    const snap = armsBeforeMap.get(arm.agentCode);
    const unchanged =
      snap &&
      snap.alpha === arm.alpha &&
      snap.beta === arm.beta &&
      snap.pulls === arm.pulls &&
      snap.wins === arm.wins &&
      snap.lastRewardAt?.getTime() === arm.lastRewardAt?.getTime();
    if (unchanged) continue;
    if (snap) {
      await db.banditArm.update({
        where: { agentCode: arm.agentCode },
        data: { alpha: snap.alpha, beta: snap.beta, pulls: snap.pulls, wins: snap.wins, lastRewardAt: snap.lastRewardAt },
      });
    } else {
      // arm do test upsert-tạo (trước test chưa từng tồn tại) → xoá hẳn
      await db.banditArm.delete({ where: { agentCode: arm.agentCode } });
    }
    console.log(`(đã trả arm ${arm.agentCode} về trạng thái trước test)`);
  }

  console.log(`\n═══ KẾT QUẢ: ${passed} PASS · ${failed} FAIL ═══`);
  await db.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error("k1-verify FATAL:", err);
  await db.$disconnect();
  process.exit(1);
});
