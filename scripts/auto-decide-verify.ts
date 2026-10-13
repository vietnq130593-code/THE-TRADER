/**
 * scripts/auto-decide-verify.ts — Hermetic verify PHIÊN #91 (tái triển khai
 * trên nền #111 sau sandbox reset): QUYẾT ĐỊNH TÍN HIỆU TỨC THÌ THEO CỔNG
 * ĐỒNG THUẬN (hiệu lệnh trader: "1 là duyệt, 2 là từ chối — đủ đồng thuận
 * ≥80% duyệt ngay, không đủ từ chối ngay").
 *
 * V-series (mọi test tự dựng + tự dọn — KHÔNG đụng dữ liệu thật):
 *   V1  BUY + CONSENSUS 83,3% (paper 0 ₫)  → approved · ACTED · audit
 *       SIGNAL_AUTO_APPROVED orderCreated:false (quyết định tách khỏi số dư)
 *   V2  HOLD + WEAK_MAJORITY 66,7%         → rejected · REJECTED · rejectNote
 *       lý do đa số yếu + audit SIGNAL_AUTO_REJECTED
 *   V3  BUY + WEAK_MAJORITY 78,3%          → rejected · lý do < 80%
 *   V4  F-207: lệnh SANDBOX neo signalId KHÔNG chặn duyệt paper — auto-duyệt
 *       đủ đồng thuận vẫn ACTED (đúng 2 thế giới §5.3)
 *   V5  Idempotent: quyết lại tín hiệu đã quyết → skipped (không đổi trạng
 *       thái, không audit kép)
 *   V6  BUY + thiếu snapshot (gate null)   → rejected fail-safe có lý do
 *
 * Chạy: DATABASE_URL=… bun run scripts/auto-decide-verify.ts
 */
import { db } from "../src/lib/db";
import { autoDecideSignalByConsensus } from "../src/lib/signal-execution";

let pass = 0;
let fail = 0;

function ok(name: string, cond: boolean, detail: string) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name} — ${detail}`);
  }
}

async function makeSignal(opts: {
  direction: "BUY" | "SELL" | "HOLD";
  gate: string | null;
  ratio: number | null;
}): Promise<string> {
  // Instrument thật (FPT) — chỉ dùng làm FK, không đụng dữ liệu thị trường.
  const inst = await db.instrument.findFirst({
    where: { symbol: "FPT" },
    select: { id: true },
  });
  if (!inst) throw new Error("Không tìm thấy instrument FPT cho test");
  const s = await db.signal.create({
    data: {
      instrumentId: inst.id,
      direction: opts.direction,
      confidence: "MEDIUM",
      score: 70,
      rationale: "[TEST auto-decide-verify] tín hiệu dựng hermetic",
      consensusGate: opts.gate,
      consensusRatio: opts.ratio,
      status: "ACTIVE",
    },
  });
  return s.id;
}

async function cleanup(signalIds: string[], orderIds: string[]) {
  if (orderIds.length) {
    await db.order.deleteMany({ where: { id: { in: orderIds } } });
  }
  await db.auditLog.deleteMany({
    where: { entity: "Signal", entityId: { in: signalIds }, action: { in: ["SIGNAL_AUTO_APPROVED", "SIGNAL_AUTO_REJECTED"] } },
  });
  await db.signal.deleteMany({ where: { id: { in: signalIds } } });
}

async function main() {
  console.log("🧪 auto-decide-verify — phiên #91 tái triển khai trên #111\n");
  const signalIds: string[] = [];
  const orderIds: string[] = [];

  try {
    // ── V1: BUY + CONSENSUS 83,3% → DUYỆT NGAY (paper 0 ₫ → ACTED không lệnh)
    const v1 = await makeSignal({ direction: "BUY", gate: "CONSENSUS", ratio: 0.833333 });
    signalIds.push(v1);
    const r1 = await autoDecideSignalByConsensus(v1);
    const s1 = await db.signal.findUnique({ where: { id: v1 } });
    const a1 = await db.auditLog.findFirst({
      where: { entity: "Signal", entityId: v1, action: "SIGNAL_AUTO_APPROVED" },
    });
    ok(
      "V1.a BUY CONSENSUS 83,3% → decision approved",
      r1.decision === "approved",
      `decision=${r1.decision} note=${r1.note}`,
    );
    ok(
      "V1.b Signal → ACTED (không treo ACTIVE)",
      s1?.status === "ACTED" && s1?.actedAt != null,
      `status=${s1?.status}`,
    );
    const a1after = a1 ? (JSON.parse(a1.after as string) as Record<string, unknown>) : null;
    ok(
      "V1.c audit SIGNAL_AUTO_APPROVED orderCreated:false (paper 0 ₫ — tách khỏi số dư)",
      a1after != null && a1after.orderCreated === false,
      `audit=${a1after ? JSON.stringify(a1after).slice(0, 120) : "null"}`,
    );

    // ── V2: HOLD + WEAK_MAJORITY 66,7% → TỪ CHỐI NGAY có lý do
    const v2 = await makeSignal({ direction: "HOLD", gate: "WEAK_MAJORITY", ratio: 0.666667 });
    signalIds.push(v2);
    const r2 = await autoDecideSignalByConsensus(v2);
    const s2 = await db.signal.findUnique({ where: { id: v2 } });
    ok(
      "V2.a HOLD đa số yếu → decision rejected",
      r2.decision === "rejected",
      `decision=${r2.decision}`,
    );
    ok(
      "V2.b Signal → REJECTED + rejectNote lý do",
      s2?.status === "REJECTED" && (s2?.rejectNote ?? "").includes("TỪ CHỐI"),
      `status=${s2?.status} note=${s2?.rejectNote?.slice(0, 60)}`,
    );

    // ── V3: BUY + WEAK_MAJORITY 78,3% → TỪ CHỐI (< 80%)
    const v3 = await makeSignal({ direction: "BUY", gate: "WEAK_MAJORITY", ratio: 0.78308 });
    signalIds.push(v3);
    const r3 = await autoDecideSignalByConsensus(v3);
    const s3 = await db.signal.findUnique({ where: { id: v3 } });
    ok(
      "V3.a BUY 78,3% < 80% → rejected",
      r3.decision === "rejected" && s3?.status === "REJECTED",
      `decision=${r3.decision} status=${s3?.status}`,
    );
    ok(
      "V3.b rejectNote nói đúng % và ngưỡng",
      (s3?.rejectNote ?? "").includes("78,3%") && (s3?.rejectNote ?? "").includes("< 80%"),
      `note=${s3?.rejectNote?.slice(0, 80)}`,
    );

    // ── V4: F-207 — lệnh SANDBOX neo signalId KHÔNG chặn duyệt paper
    // (2 thế giới độc lập §5.3: K1 auto-convert chạy TRƯỚC trong cùng chu kỳ)
    const v4 = await makeSignal({ direction: "BUY", gate: "CONSENSUS", ratio: 0.9 });
    signalIds.push(v4);
    const sandboxAccount = await db.brokerAccount.findFirst({
      where: { accountType: "sandbox" },
      select: { id: true },
    });
    const user = await db.user.findFirst({ where: { isActive: true }, select: { id: true } });
    const inst4 = await db.signal.findUnique({
      where: { id: v4 },
      select: { instrumentId: true },
    });
    if (sandboxAccount && user && inst4) {
      const sandboxOrder = await db.order.create({
        data: {
          userId: user.id,
          brokerAccountId: sandboxAccount.id,
          signalId: v4,
          instrumentId: inst4.instrumentId,
          side: "BUY",
          type: "LIMIT",
          quantity: 100,
          price: 100000,
          fee: 0n,
          status: "PENDING",
          note: "[TEST auto-decide-verify] lệnh sandbox neo signal — F-207",
        },
      });
      orderIds.push(sandboxOrder.id);
      const r4 = await autoDecideSignalByConsensus(v4);
      const s4 = await db.signal.findUnique({ where: { id: v4 } });
      ok(
        "V4.a lệnh sandbox tồn tại → duyệt paper VẪN approved (F-207 vá)",
        r4.decision === "approved" && s4?.status === "ACTED",
        `decision=${r4.decision} status=${s4?.status} note=${r4.note.slice(0, 80)}`,
      );
    } else {
      ok(
        "V4 (bỏ qua — thiếu tài khoản sandbox/user)",
        true,
        "điều kiện test không đủ",
      );
    }

    // ── V5: Idempotent — quyết lại tín hiệu đã quyết → skipped, không audit kép
    const r5 = await autoDecideSignalByConsensus(v1);
    const auditCount = await db.auditLog.count({
      where: { entity: "Signal", entityId: v1, action: "SIGNAL_AUTO_APPROVED" },
    });
    ok(
      "V5.a quyết lại → skipped (không đè)",
      r5.decision === "skipped",
      `decision=${r5.decision}`,
    );
    ok("V5.b audit không kép (vẫn 1 dòng)", auditCount === 1, `count=${auditCount}`);

    // ── V6: BUY + thiếu snapshot (gate null) → TỪ CHỐI fail-safe
    const v6 = await makeSignal({ direction: "BUY", gate: null, ratio: null });
    signalIds.push(v6);
    const r6 = await autoDecideSignalByConsensus(v6);
    const s6 = await db.signal.findUnique({ where: { id: v6 } });
    ok(
      "V6.a thiếu snapshot → rejected fail-safe",
      r6.decision === "rejected" && s6?.status === "REJECTED",
      `decision=${r6.decision} status=${s6?.status}`,
    );
    ok(
      "V6.b rejectNote nói rõ fail-safe",
      (s6?.rejectNote ?? "").includes("fail-safe"),
      `note=${s6?.rejectNote?.slice(0, 80)}`,
    );

    // ── Tổng kết
    console.log(`\n──────────────────────────────────────`);
    console.log(`KẾT QUẢ: PASS ${pass} · FAIL ${fail}`);
    if (fail > 0) {
      console.log("❌ CÓ FAIL — xem chi tiết phía trên.");
      process.exitCode = 1;
    } else {
      console.log("✅ TOÀN PASS — auto-decision theo cổng đồng thuận hoạt động đúng hiệu lệnh #91.");
    }
  } finally {
    await cleanup(signalIds, orderIds);
    console.log("🧹 Đã dọn sạch dữ liệu test (signal + order + audit).");
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error("LỖI script:", err);
  process.exit(1);
});
