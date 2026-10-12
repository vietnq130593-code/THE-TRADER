/**
 * scripts/p106-verify.ts — NGHIỆM THU CƠ CHẾ HỘI ĐỒNG #106
 * (COUNCIL_STEWARDSHIP_BLUEPRINT §8 — chạy sau khi sync đa thị trường xong).
 *
 * 1. Seed thí nghiệm HỒI TÍNH (createdBy "seed", startedAt lùi 35 ngày):
 *    markExperimentsDaily() tự chụp snapshot theo chỉ số rổ THẬT trong 25
 *    phiên → finalize → DONE kèm return/maxDD/Sharpe/đóng góp từng rổ.
 *    Trung thực: nhãn "hồi tính" — kết quả tính trên dữ liệu quá khứ thật,
 *    KHÔNG phải thí nghiệm chạy tiến từng ngày.
 * 2. Seed thí nghiệm ĐANG CHẠY (phòng thủ trái phiếu + hàng hoá) — UI + khối
 *    vision có nội dung ngay.
 * 3. In khối C-VISION (buildCouncilVisionBlock) — bằng chứng Hội đồng THẤY
 *    tài khoản + phán quyết + thí nghiệm.
 * 4. Đánh giá sổ quyết định 2 lần (idempotent).
 *
 * Idempotent: xoá thí nghiệm seed cũ theo tên trước khi tạo lại.
 */
import { PrismaClient } from "@prisma/client";
import {
  markExperimentsDaily,
  createExperiment,
  finalizeExperiment,
} from "../src/lib/council/experiments";
import { buildCouncilVisionBlock } from "../src/lib/council/vision";
import { evaluateDecisions } from "../src/lib/council/decision-eval";

const db = new PrismaClient();

const SEED_DONE_NAME = "Khởi động: cân bằng 5 rổ (hồi tính 25 phiên)";
const SEED_RUN_NAME = "Phòng thủ: trái phiếu + hàng hoá";

async function main() {
  console.log("═══ 1. DỌN THÍ NGHIỆM SEED CŨ (idempotent) ═══");
  const del = await db.allocationExperiment.deleteMany({
    where: { name: { in: [SEED_DONE_NAME, SEED_RUN_NAME] } },
  });
  console.log(`  xoá ${del.count} thí nghiệm seed cũ`);

  console.log("═══ 2. TẠO THÍ NGHIỆM HỒI TÍNH (startedAt −35 ngày) ═══");
  const backdated = await db.allocationExperiment.create({
    data: {
      name: SEED_DONE_NAME,
      hypothesis:
        "Phân bổ đều 20% mỗi rổ làm MỐC SO SÁNH cho mọi thí nghiệm sau của Hội đồng",
      weightsJson: JSON.stringify([
        { basket: "VN_EQUITY", weight: 20 },
        { basket: "INTL_EQUITY", weight: 20 },
        { basket: "BOND", weight: 20 },
        { basket: "FOREX", weight: 20 },
        { basket: "COMMODITY", weight: 20 },
      ]),
      capitalVND: BigInt(100_000_000),
      horizonDays: 25,
      startedAt: new Date(Date.now() - 35 * 86_400_000),
      status: "RUNNING",
      createdBy: "seed",
    },
  });
  console.log(`  tạo ${backdated.id} — mark sẽ hồi tính trên dữ liệu rổ THẬT`);

  console.log("═══ 3. MARK (hồi tính snapshot + tự tổng kết khi đủ horizon) ═══");
  const mark1 = await markExperimentsDaily();
  console.log(
    `  mark 1: running=${mark1.running} snapshots=${mark1.snapshotsWritten} finalized=${mark1.finalized.length} skippedNoData=${mark1.skippedNoData}`
  );
  const mark2 = await markExperimentsDaily();
  console.log(
    `  mark 2 (idempotent): snapshots=${mark2.snapshotsWritten} finalized=${mark2.finalized.length}`
  );

  console.log("═══ 4. TẠO THÍ NGHIỆM ĐANG CHẠY (phòng thủ) ═══");
  const running = await createExperiment({
    name: SEED_RUN_NAME,
    hypothesis:
      "Trong môi trường lãi suất cao và cổ phiếu VN đang giảm, thang trái phiếu + vàng/dầu bảo toàn vốn tốt hơn tăng trưởng cổ phiếu",
    weights: [
      { basket: "VN_EQUITY", weight: 15 },
      { basket: "INTL_EQUITY", weight: 15 },
      { basket: "BOND", weight: 35 },
      { basket: "FOREX", weight: 5 },
      { basket: "COMMODITY", weight: 30 },
    ],
    capitalVND: 100_000_000,
    horizonDays: 30,
    createdBy: "seed",
  });
  console.log(
    `  ${running.ok ? `OK ${running.experiment?.name}` : `LỖI ${running.error}`}`
  );

  console.log("═══ 5. KẾT QUẢ THÍ NGHIỆM HỒI TÍNH ═══");
  const done = await db.allocationExperiment.findFirst({
    where: { name: SEED_DONE_NAME },
    include: { snapshots: { orderBy: { date: "asc" }, take: 1 } },
  });
  if (done) {
    if (done.status === "RUNNING") {
      await finalizeExperiment(done.id);
    }
    const fin = await db.allocationExperiment.findUnique({ where: { id: done.id } });
    console.log(
      `  "${fin?.name}" status=${fin?.status} return=${fin?.returnPct}% maxDD=${fin?.maxDrawdownPct}% sharpe=${fin?.sharpe}`
    );
    if (fin?.perBasketJson) {
      for (const b of JSON.parse(fin.perBasketJson) as Array<{
        basket: string;
        weight: number;
        contributionPct: number;
      }>) {
        console.log(
          `    ${b.basket} ${b.weight}% → đóng góp ${b.contributionPct.toFixed(2)}%`
        );
      }
    }
  }

  console.log("═══ 6. SỔ ĐÁNH GIÁ QUYẾT ĐỊNH (2 lần — idempotent) ═══");
  const ev1 = await evaluateDecisions();
  const ev2 = await evaluateDecisions();
  console.log(
    `  lần 1: ${ev1.evaluated} tín hiệu · WIN ${ev1.byVerdict.WIN} · LOSS ${ev1.byVerdict.LOSS} · NEUTRAL ${ev1.byVerdict.NEUTRAL} (${ev1.durationMs}ms)`
  );
  console.log(
    `  lần 2: ${ev2.evaluated} tín hiệu · WIN ${ev2.byVerdict.WIN} · LOSS ${ev2.byVerdict.LOSS} (${ev2.durationMs}ms — idempotent)`
  );

  console.log("═══ 7. KHỐI C-VISION (Hội đồng thấy gì) ═══");
  const vision = await buildCouncilVisionBlock();
  console.log("────────────── BẮT ĐẦU KHỐI ──────────────");
  console.log(vision ?? "(null — lỗi)");
  console.log("────────────── KẾT THÚC KHỐI ──────────────");
  console.log(`  độ dài: ${vision?.length ?? 0} ký tự`);

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
