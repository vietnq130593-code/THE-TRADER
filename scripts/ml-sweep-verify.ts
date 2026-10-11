/**
 * scripts/ml-sweep-verify.ts (C1 #99 · ML_AUTOML_BLUEPRINT §4.7-5) — nghiệm
 * thu SWEEP CONTROLLER deterministic (hermetic 100% in-memory — KHÔNG ghi
 * DB, KHÔNG train, chỉ gọi các hàm THUẦN của src/lib/ml/sweep.ts):
 *
 *  T1  — buildSweepCandidates(16) trả đúng 16 (12 coarse + 4 refine), thứ
 *        tự ổn định qua 2 lần gọi (deterministic — nguyên tắc §2.9).
 *  T2  — mọi ứng viên tôn trọng MLP_ARCH_LIMITS (1..5 lớp × 2..96 nơ-rôn ·
 *        lossWeights 0,1..10 · lr trong phạm vi MLP_TUNING_FIELDS) + hyper
 *        mặc định #94 trừ seed = sweepSeed.
 *  T3  — budget 5 → 5 coarse đầu; budget 1 → 1 (thứ tự cố định coarse trước).
 *  T4  — R3 preset lossWeights [1, 1, 2,5]; R4 lr × 0,5 (0,01 → 0,005).
 *  T5  — computeScore tay: valAcc 0,40 + params 6.000 → phạt 0,0002×10 =
 *        0,002; Brier bằng serving → +0,01 ⇒ 0,408.
 *  T6  — computeScore phạt 0 ở/ngưỡng paramWarnThreshold 5.000; Brier thua
 *        serving → không có thưởng.
 *  T7  — championGateCheck pass (thoả cả 3 điều kiện đo được) → pass, reasons rỗng.
 *  T8  — mỗi điều kiện 1/2/3 fail → reasons nói đúng ĐIỀU KIỆN NÀO (tiếng Việt).
 *  T9  — serving == null: baseline valAcc 1/3 + δ · cap 2 × 5.000 = 10.000 ·
 *        UNIFORM_BRIER_BASELINE 0,667 (F4).
 *  T10 — pairedBootstrapDeltaBrierCI deterministic: cùng deltas + cùng seed →
 *        CI GIỐNG HỆT 2 lần; deltas toàn −0,01 → CI hoàn toàn âm.
 *  T11 — danh sách 16 ứng viên KHÔNG trùng (arch+activations+lossWeights+lr).
 *  T12 — refine từ top-2 GIẢ LẬP (điểm dựng sẵn): R1 = top1 lớp cuối ±8
 *        (clamp 2..96 — kèm nhánh 96→88); R2 = top2 ±1 lớp (append 8 khi
 *        <5 lớp · bớt lớp khi đã 5 lớp).
 *  T13 — R4 fallback lr × 2 khi × 0,5 tụt dưới 0,0005 (0,0006 → 0,0012).
 *  T14 — budget 0/âm → kẹp 1; budget 64 → dãy vẫn 16 (không gian §4.2 tối
 *        đa 12 coarse + 4 refine — budget lớn hơn chỉ ghi nguyên trong
 *        SweepRun.candidates).
 *  T15 — mọi mặc định nằm TRONG phạm vi validate SWEEP_FIELD_RANGES (hồi quy:
 *        seed max cũ 999.999 < mặc định 20261012 → bị kẹp/422).
 *
 * Chạy: env -u DATABASE_URL bun scripts/ml-sweep-verify.ts
 * (env -u chống shell DATABASE_URL cũ đè .env — bài học #87/#89; script
 * thuần hàm nên 0 query DB — db import chỉ để PrismaClient không bị tree-shake
 * khỏi sweep.ts, disconnect ở finally như ml-arch-verify.ts.)
 */

import { db } from "../src/lib/db";
import { MLP_ARCH_LIMITS, MLP_TUNING_DEFAULT, MLP_TUNING_FIELDS } from "../src/lib/ml/tuning";
import {
  SWEEP_CONFIG_DEFAULT,
  SWEEP_FIELD_RANGES,
  UNIFORM_BRIER_BASELINE,
  buildCoarseCandidates,
  buildSweepCandidates,
  championGateCheck,
  computeScore,
  deriveRefineCandidates,
  pairedBootstrapDeltaBrierCI,
  type SweepCandidate,
} from "../src/lib/ml/sweep";

const results: string[] = [];

function fail(name: string, detail: string): never {
  results.push(`✗ ${name}: ${detail}`);
  throw new Error(`${name}: ${detail}`);
}

function near(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}

const LW: [number, number, number] = [1, 1, 1];
const SEED = 20261012;

async function main() {
  const lrSpec = MLP_TUNING_FIELDS.find((f) => f.key === "lr");
  const LR_MIN = lrSpec?.min ?? 0.0005;
  const LR_MAX = lrSpec?.max ?? 0.1;

  /* ── T1 — 16 ứng viên + deterministic ── */
  const listA = buildSweepCandidates(16, LW, SEED);
  const listB = buildSweepCandidates(16, LW, SEED);
  if (listA.length !== 16) fail("T1", `độ dài ${listA.length} ≠ 16`);
  if (listA.filter((c) => c.phase === "coarse").length !== 12) {
    fail("T1", "coarse ≠ 12 ứng viên");
  }
  if (listA.filter((c) => c.phase === "refine").length !== 4) {
    fail("T1", "refine ≠ 4 ứng viên");
  }
  if (JSON.stringify(listA) !== JSON.stringify(listB)) {
    fail("T1", "2 lần gọi cho dãy KHÁC nhau (phải identical từng số)");
  }
  if (listA.map((c) => c.tag).join(",") !== "C1,C2,C3,C4,C5,C6,C7,C8,C9,C10,C11,C12,R1,R2,R3,R4") {
    fail("T1", `thứ tự tag sai: ${listA.map((c) => c.tag).join(",")}`);
  }
  results.push("T1 PASS — 16 ứng viên (12 coarse + 4 refine) · 2 lần gọi IDENTICAL · tag C1..C12,R1..R4 theo đúng thứ tự cố định");

  /* ── T2 — mọi ứng viên tôn trọng MLP_ARCH_LIMITS + hyper mặc định ── */
  for (const c of listA) {
    if (c.hidden.length < MLP_ARCH_LIMITS.minLayers || c.hidden.length > MLP_ARCH_LIMITS.maxLayers) {
      fail("T2", `${c.tag}: ${c.hidden.length} lớp ngoài ${MLP_ARCH_LIMITS.minLayers}..${MLP_ARCH_LIMITS.maxLayers}`);
    }
    for (const h of c.hidden) {
      if (h < MLP_ARCH_LIMITS.minNeurons || h > MLP_ARCH_LIMITS.maxNeurons) {
        fail("T2", `${c.tag}: nơ-rôn ${h} ngoài ${MLP_ARCH_LIMITS.minNeurons}..${MLP_ARCH_LIMITS.maxNeurons}`);
      }
    }
    if (c.activations.length !== c.hidden.length) {
      fail("T2", `${c.tag}: activations ${c.activations.length} ≠ hidden ${c.hidden.length}`);
    }
    for (const a of c.activations) {
      if (!MLP_ARCH_LIMITS.activations.includes(a)) fail("T2", `${c.tag}: activation lạ "${a}"`);
    }
    for (const w of c.lossWeights) {
      if (w < MLP_ARCH_LIMITS.lossWeightMin || w > MLP_ARCH_LIMITS.lossWeightMax) {
        fail("T2", `${c.tag}: lossWeight ${w} ngoài ${MLP_ARCH_LIMITS.lossWeightMin}..${MLP_ARCH_LIMITS.lossWeightMax}`);
      }
    }
    if (c.hyper.lr < LR_MIN || c.hyper.lr > LR_MAX) {
      fail("T2", `${c.tag}: lr ${c.hyper.lr} ngoài [${LR_MIN} – ${LR_MAX}]`);
    }
    if (c.hyper.seed !== SEED) {
      fail("T2", `${c.tag}: seed ${c.hyper.seed} ≠ sweepSeed ${SEED}`);
    }
    if (
      c.hyper.epochs !== MLP_TUNING_DEFAULT.epochs ||
      c.hyper.patience !== MLP_TUNING_DEFAULT.patience ||
      c.hyper.batchSize !== MLP_TUNING_DEFAULT.batchSize ||
      c.hyper.l2 !== MLP_TUNING_DEFAULT.l2 ||
      c.hyper.valFraction !== MLP_TUNING_DEFAULT.valFraction
    ) {
      fail("T2", `${c.tag}: hyper lệch mặc định #94 — ${JSON.stringify(c.hyper)}`);
    }
    // lr: coarse/R1/R2/R3 = mặc định; R4 = ×0,5 (hoặc ×2 fallback — T4/T13 test riêng).
    if (c.tag !== "R4" && c.hyper.lr !== MLP_TUNING_DEFAULT.lr) {
      fail("T2", `${c.tag}: lr ${c.hyper.lr} ≠ mặc định ${MLP_TUNING_DEFAULT.lr} (chỉ R4 được đổi lr)`);
    }
  }
  results.push(
    `T2 PASS — 16/16 ứng viên trong giới hạn (1..5 lớp × 2..${MLP_ARCH_LIMITS.maxNeurons} nơ-rôn · lossWeights 0,1..10 · lr [${LR_MIN} – ${LR_MAX}]) + hyper mặc định #94 (seed = ${SEED})`
  );

  /* ── T3 — budget cắt theo thứ tự cố định ── */
  const five = buildSweepCandidates(5, LW, SEED);
  if (five.length !== 5) fail("T3", `budget 5 → ${five.length} ứng viên`);
  for (let i = 0; i < 5; i++) {
    if (JSON.stringify(five[i]) !== JSON.stringify(listA[i])) {
      fail("T3", `budget 5: ứng viên ${i} ≠ 5 ứng viên đầu của dãy 16`);
    }
  }
  const one = buildSweepCandidates(1, LW, SEED);
  if (one.length !== 1 || one[0]!.tag !== "C1") {
    fail("T3", `budget 1 → ${one.map((c) => c.tag).join(",")}`);
  }
  results.push("T3 PASS — budget 5 → 5 coarse đầu (identical từng số) · budget 1 → C1");

  /* ── T4 — R3 preset UP-heavy + R4 lr × 0,5 ── */
  const r3 = listA.find((c) => c.tag === "R3");
  const r4 = listA.find((c) => c.tag === "R4");
  if (r3 == null || r4 == null) fail("T4", "thiếu R3/R4 trong dãy 16");
  if (r3!.lossWeights.join(",") !== "1,1,2.5") {
    fail("T4", `R3 lossWeights ${r3!.lossWeights.join(",")} ≠ "1,1,2.5"`);
  }
  if (!near(r4!.hyper.lr, MLP_TUNING_DEFAULT.lr * 0.5)) {
    fail("T4", `R4 lr ${r4!.hyper.lr} ≠ ×0,5 của ${MLP_TUNING_DEFAULT.lr}`);
  }
  results.push("T3/T4 PASS — R3 preset [1, 1, 2,5] ✓ · R4 lr 0,005 = 0,01 × 0,5 ✓");

  /* ── T5 — computeScore số dựng tay ── */
  const s5 = computeScore({ valAcc: 0.4, paramCount: 6000, brier: 0.5, servingBrier: 0.5 });
  if (!near(s5, 0.4 - 0.002 + 0.01)) {
    fail("T5", `score ${s5} ≠ 0,40 − 0,002 (phạt 6.000 tham số) + 0,01 (Brier bằng serving) = 0,408`);
  }
  results.push("T5 PASS — score = 0,40 − 0,002 + 0,01 = 0,408 (phạt 0,0002×10 ✓ · thưởng Brier ✓)");

  /* ── T6 — phạt 0 dưới ngưỡng + không thưởng khi Brier thua ── */
  const s6a = computeScore({ valAcc: 0.4, paramCount: MLP_ARCH_LIMITS.paramWarnThreshold, brier: 0.5, servingBrier: 0.5 });
  if (!near(s6a, 0.4 + 0.01)) {
    fail("T6", `ở ngưỡng ${MLP_ARCH_LIMITS.paramWarnThreshold}: score ${s6a} ≠ 0,41 (phạt phải = 0)`);
  }
  const s6b = computeScore({ valAcc: 0.4, paramCount: 4000, brier: 0.5, servingBrier: 0.5 });
  if (!near(s6b, 0.4 + 0.01)) {
    fail("T6", `dưới ngưỡng (4.000): score ${s6b} ≠ 0,41`);
  }
  const s6c = computeScore({ valAcc: 0.4, paramCount: 4000, brier: 0.6, servingBrier: 0.5 });
  if (!near(s6c, 0.4)) {
    fail("T6", `Brier thua (0,6 > 0,5): score ${s6c} ≠ 0,40 (không thưởng)`);
  }
  const s6d = computeScore({ valAcc: 0.4, paramCount: 4000, brier: 0.5, servingBrier: null });
  if (!near(s6d, 0.4)) {
    fail("T6", `serving null: score ${s6d} ≠ 0,40 (bỏ số hạng Brier — F4)`);
  }
  results.push("T6 PASS — phạt 0 ở/ngưỡng 5.000 · Brier thua/không serving → không thưởng");

  /* ── T7 — cổng pass toàn bộ ── */
  const pass = championGateCheck({
    championValAcc: 0.41,
    servingValAcc: 0.39,
    deltaSwap: 0.01,
    deltaBrierCiLow: -0.05,
    deltaBrierCiHigh: -0.01,
    championParamCount: 800,
    servingParamCount: 747,
    maxParamFactor: 2,
  });
  if (!pass.pass || pass.reasons.length !== 0) {
    fail("T7", `phải pass rỗng reasons — nhận pass=${pass.pass} reasons=[${pass.reasons.join("; ")}]`);
  }
  results.push("T7 PASS — cổng pass (0,41 ≥ 0,39+0,01 · CI [−0,05; −0,01] < 0 · 800 ≤ 2×747) → reasons rỗng");

  /* ── T8 — từng điều kiện fail nói đúng điều kiện nào ── */
  const base = {
    championValAcc: 0.41,
    servingValAcc: 0.39,
    deltaSwap: 0.01,
    deltaBrierCiLow: -0.05,
    deltaBrierCiHigh: -0.01,
    championParamCount: 800,
    servingParamCount: 747,
    maxParamFactor: 2,
  };
  const g1 = championGateCheck({ ...base, championValAcc: 0.395 }); // 0,395 < 0,39+0,01
  if (g1.pass || !g1.reasons.some((r) => r.includes("Điều kiện 1"))) {
    fail("T8", `đk1 fail phải nêu "Điều kiện 1" — [${g1.reasons.join("; ")}]`);
  }
  if (g1.reasons.length !== 1) {
    fail("T8", `đk1 fail chỉ 1 lý do — nhận ${g1.reasons.length}`);
  }
  const g2 = championGateCheck({ ...base, deltaBrierCiHigh: 0.01 });
  if (g2.pass || !g2.reasons.some((r) => r.includes("Điều kiện 2"))) {
    fail("T8", `đk2 fail phải nêu "Điều kiện 2" — [${g2.reasons.join("; ")}]`);
  }
  const g3 = championGateCheck({ ...base, championParamCount: 99999 });
  if (g3.pass || !g3.reasons.some((r) => r.includes("Điều kiện 3"))) {
    fail("T8", `đk3 fail phải nêu "Điều kiện 3" — [${g3.reasons.join("; ")}]`);
  }
  results.push("T8 PASS — mỗi điều kiện fail nêu đúng số điều kiện (1/2/3) + đúng 1 lý do riêng");

  /* ── T9 — serving == null defaults (F4) ── */
  if (UNIFORM_BRIER_BASELINE !== 0.667) {
    fail("T9", `UNIFORM_BRIER_BASELINE ${UNIFORM_BRIER_BASELINE} ≠ 0,667`);
  }
  const cleanPass = championGateCheck({
    championValAcc: 0.35, // ≥ 1/3 + 0,01 = 0,34333…
    servingValAcc: null,
    deltaSwap: 0.01,
    deltaBrierCiLow: -0.04,
    deltaBrierCiHigh: -0.01,
    championParamCount: 9500, // ≤ 2 × 5.000 = 10.000
    servingParamCount: null,
    maxParamFactor: 2,
  });
  if (!cleanPass.pass) {
    fail("T9", `DB sạch phải pass với default — [${cleanPass.reasons.join("; ")}]`);
  }
  const cleanFail = championGateCheck({
    championValAcc: 0.34, // < 1/3 + 0,01
    servingValAcc: null,
    deltaSwap: 0.01,
    deltaBrierCiLow: -0.04,
    deltaBrierCiHigh: -0.01,
    championParamCount: 9500,
    servingParamCount: null,
    maxParamFactor: 2,
  });
  if (cleanFail.pass || !cleanFail.reasons.some((r) => r.includes("Điều kiện 1"))) {
    fail("T9", `valAcc 0,34 < 1/3 + δ phải fail đk1 — [${cleanFail.reasons.join("; ")}]`);
  }
  const capFail = championGateCheck({
    championValAcc: 0.35,
    servingValAcc: null,
    deltaSwap: 0.01,
    deltaBrierCiLow: -0.04,
    deltaBrierCiHigh: -0.01,
    championParamCount: 10001, // > 2 × 5.000
    servingParamCount: null,
    maxParamFactor: 2,
  });
  if (capFail.pass || !capFail.reasons.some((r) => r.includes("10.000") || r.includes("10000"))) {
    fail("T9", `cap 2 × 5.000 = 10.000 phải được nêu — [${capFail.reasons.join("; ")}]`);
  }
  results.push("T9 PASS — serving null: baseline 1/3+δ ✓ · cap 2×5.000=10.000 ✓ · UNIFORM_BRIER_BASELINE 0,667 ✓");

  /* ── T10 — paired bootstrap deterministic + CI âm ── */
  const deltas = Array.from({ length: 300 }, (_, i) => (i % 2 === 0 ? -0.012 : -0.008));
  const ci1 = pairedBootstrapDeltaBrierCI(deltas, 1000, SEED);
  const ci2 = pairedBootstrapDeltaBrierCI(deltas, 1000, SEED);
  if (ci1.ciLow !== ci2.ciLow || ci1.ciHigh !== ci2.ciHigh || ci1.mean !== ci2.mean) {
    fail("T10", "cùng deltas + cùng seed → CI phải IDENTICAL từng số");
  }
  if (ci1.ciHigh >= 0) {
    fail("T10", `deltas toàn âm nhưng ciHigh ${ci1.ciHigh} ≥ 0`);
  }
  const ci3 = pairedBootstrapDeltaBrierCI(deltas, 1000, SEED + 1);
  if (ci3.ciLow === ci1.ciLow && ci3.ciHigh === ci1.ciHigh) {
    fail("T10", "đổi seed phải đổi CI (resample khác)");
  }
  results.push(
    `T10 PASS — deterministic (2 lần CI identical [${ci1.ciLow.toFixed(4)}, ${ci1.ciHigh.toFixed(4)}]) · deltas âm → CI âm ✓ · seed khác → CI khác ✓`
  );

  /* ── T11 — không trùng (arch + activations + lossWeights + lr) ── */
  const seen = new Set<string>();
  for (const c of listA) {
    const key = `${c.hidden.join("-")}|${c.activations.join(",")}|${c.lossWeights.join(",")}|${c.hyper.lr}`;
    if (seen.has(key)) {
      fail("T11", `ứng viên trùng dấu ${c.tag}: ${key}`);
    }
    seen.add(key);
  }
  results.push(`T11 PASS — 16 ứng viên đôi một khác nhau (${seen.size} dấu vân arch+act+loss+lr)`);

  /* ── T12 — refine từ top-2 GIẢ LẬP + clamp ── */
  // Điểm dựng: index 3 ([32,16] biến thể B — relu,tanh) đứng nhất; index 2
  // ([32,16] A — relu,relu) đứng nhì; còn lại 0.
  const scores = new Array<number>(12).fill(0);
  scores[3] = 0.5;
  scores[2] = 0.4;
  const mocked = buildSweepCandidates(16, LW, SEED, scores);
  const mR1 = mocked.find((c) => c.tag === "R1");
  const mR2 = mocked.find((c) => c.tag === "R2");
  const mR3 = mocked.find((c) => c.tag === "R3");
  const mR4 = mocked.find((c) => c.tag === "R4");
  if (mR1 == null || mR2 == null || mR3 == null || mR4 == null) {
    fail("T12", "dãy 16 thiếu R1..R4");
  }
  // R1 = top1 ([32,16] relu,tanh) lớp cuối 16+8 = 24 → [32,24], activation giữ.
  if (mR1!.hidden.join(",") !== "32,24" || mR1!.activations.join(",") !== "relu,tanh") {
    fail("T12", `R1 ${mR1!.hidden.join(",")} / ${mR1!.activations.join(",")} ≠ [32,24] / relu,tanh`);
  }
  // R2 = top2 ([32,16] relu,relu) + lớp 8 relu → [32,16,8].
  if (mR2!.hidden.join(",") !== "32,16,8" || mR2!.activations.join(",") !== "relu,relu,relu") {
    fail("T12", `R2 ${mR2!.hidden.join(",")} / ${mR2!.activations.join(",")} ≠ [32,16,8] / relu,relu,relu`);
  }
  // R3 = top1 với preset UP-heavy.
  if (mR3!.hidden.join(",") !== "32,16" || mR3!.lossWeights.join(",") !== "1,1,2.5") {
    fail("T12", `R3 phải là top1 [32,16] + [1,1,2,5] — nhận ${mR3!.hidden.join(",")} / ${mR3!.lossWeights.join(",")}`);
  }
  // R4 = top1 lr × 0,5.
  if (!near(mR4!.hyper.lr, 0.01 * 0.5) || mR4!.hidden.join(",") !== "32,16") {
    fail("T12", `R4 phải là top1 [32,16] lr 0,005 — nhận ${mR4!.hidden.join(",")} lr ${mR4!.hyper.lr}`);
  }
  // Clamp: top1 lớp cuối 96 → +8 vượt trần → −8 = 88.
  const craftTop1: SweepCandidate = {
    index: 0,
    phase: "coarse",
    tag: "X1",
    hidden: [48, 96],
    activations: ["relu", "tanh"],
    lossWeights: [1, 1, 1],
    hyper: { ...MLP_TUNING_DEFAULT, lr: MLP_TUNING_DEFAULT.lr, seed: SEED } as SweepCandidate["hyper"],
  };
  const craftTop2: SweepCandidate = {
    ...craftTop1,
    tag: "X2",
    hidden: [16, 32, 64, 48, 24], // 5 lớp → R2 phải BỚT lớp cuối
    activations: ["relu", "relu", "relu", "relu", "tanh"],
  };
  const crafted = deriveRefineCandidates(craftTop1, craftTop2, LW, SEED, 12);
  if (crafted[0]!.hidden.join(",") !== "48,88") {
    fail("T12", `clamp 96: R1 ${crafted[0]!.hidden.join(",")} ≠ "48,88" (+8 vượt 96 → −8)`);
  }
  if (crafted[1]!.hidden.join(",") !== "16,32,64,48") {
    fail("T12", `5 lớp: R2 ${crafted[1]!.hidden.join(",")} ≠ "16,32,64,48" (bớt lớp cuối)`);
  }
  if (crafted[1]!.activations.join(",") !== "relu,relu,relu,relu") {
    fail("T12", `R2 5 lớp: activations ${crafted[1]!.activations.join(",")} ≠ bỏ tanh cuối`);
  }
  results.push("T12 PASS — refine top-2 giả lập: R1 [32,24] relu,tanh ✓ · R2 [32,16,8] ✓ · R3/R4 từ top1 ✓ · clamp 96→88 ✓ · 5 lớp bớt lớp cuối ✓");

  /* ── T13 — R4 fallback lr × 2 khi × 0,5 tụt dưới 0,0005 ── */
  const tinyLrTop: SweepCandidate = {
    ...craftTop1,
    hyper: { ...craftTop1.hyper, lr: 0.0006 },
  };
  const crafted13 = deriveRefineCandidates(tinyLrTop, craftTop2, LW, SEED, 12);
  if (!near(crafted13[3]!.hyper.lr, 0.0006 * 2)) {
    fail("T13", `lr 0,0006: R4 ${crafted13[3]!.hyper.lr} ≠ fallback ×2 = 0,0012`);
  }
  results.push("T13 PASS — R4 fallback: lr 0,0006 × 0,5 = 0,0003 < 0,0005 → dùng ×2 = 0,0012 ✓");

  /* ── T14 — budget kẹp + trần không gian ── */
  const zero = buildSweepCandidates(0, LW, SEED);
  if (zero.length !== 1) fail("T14", `budget 0 → ${zero.length} (phải kẹp 1)`);
  const neg = buildSweepCandidates(-5, LW, SEED);
  if (neg.length !== 1) fail("T14", `budget −5 → ${neg.length} (phải kẹp 1)`);
  const big = buildSweepCandidates(64, LW, SEED);
  if (big.length !== 16) {
    fail("T14", `budget 64 → ${big.length} (không gian cố định 12 coarse + 4 refine)`);
  }
  // Coarse thuần: 12 ứng viên kernel×variant đúng thứ tự hạt nhân.
  const coarse = buildCoarseCandidates(LW, SEED);
  const kernelSeq = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5];
  const kernels = [
    [24, 12],
    [32, 16],
    [48, 24, 12],
    [16],
    [64, 32, 16, 8],
    [12, 8],
  ];
  kernelSeq.forEach((kIdx, i) => {
    if (coarse[i]!.hidden.join(",") !== kernels[kIdx]!.join(",")) {
      fail("T14", `coarse[${i}] ${coarse[i]!.hidden.join(",")} ≠ kernel ${kernels[kIdx]!.join(",")}`);
    }
    const expectVariant = i % 2 === 0 ? "A" : "B";
    const lastAct = coarse[i]!.activations[coarse[i]!.activations.length - 1]!;
    if (expectVariant === "A" && lastAct !== "relu") {
      fail("T14", `coarse[${i}] biến thể A phải relu toàn bộ — cuối là ${lastAct}`);
    }
    if (expectVariant === "B" && lastAct !== "tanh") {
      fail("T14", `coarse[${i}] biến thể B phải tanh lớp cuối — cuối là ${lastAct}`);
    }
    if (coarse[i]!.activations.slice(0, -1).some((a) => a !== "relu")) {
      fail("T14", `coarse[${i}] các lớp trước cuối phải relu`);
    }
  });
  results.push("T14 PASS — budget 0/−5 kẹp 1 · budget 64 → trần 16 · 12 coarse đúng thứ tự 6 hạt nhân × 2 biến thể (A relu · B tanh lớp cuối)");

  /* ── T15 — mặc định seed nằm TRONG phạm vi validate (hồi quy #99-C1R) ── */
  // Bug đã vá: SWEEP_FIELD_RANGES.seed.max cũ 999_999 < mặc định 20261012 →
  // readSweepConfig kẹp mặc định thành 999999 và FE nhập 20261012 bị 422 —
  // trader không bao giờ lưu được seed mặc định. Phạm vi phải CHỨA mặc định.
  if (SWEEP_CONFIG_DEFAULT.seed < SWEEP_FIELD_RANGES.seed.min || SWEEP_CONFIG_DEFAULT.seed > SWEEP_FIELD_RANGES.seed.max) {
    fail(
      "T15",
      `mặc định seed ${SWEEP_CONFIG_DEFAULT.seed} ngoài phạm vi [${SWEEP_FIELD_RANGES.seed.min} – ${SWEEP_FIELD_RANGES.seed.max}]`
    );
  }
  if (SWEEP_CONFIG_DEFAULT.budgetCandidates < SWEEP_FIELD_RANGES.budgetCandidates.min || SWEEP_CONFIG_DEFAULT.budgetCandidates > SWEEP_FIELD_RANGES.budgetCandidates.max) {
    fail("T15", `mặc định budget ${SWEEP_CONFIG_DEFAULT.budgetCandidates} ngoài phạm vi`);
  }
  if (SWEEP_CONFIG_DEFAULT.deltaSwap < SWEEP_FIELD_RANGES.deltaSwap.min || SWEEP_CONFIG_DEFAULT.deltaSwap > SWEEP_FIELD_RANGES.deltaSwap.max) {
    fail("T15", `mặc định δ ${SWEEP_CONFIG_DEFAULT.deltaSwap} ngoài phạm vi`);
  }
  if (SWEEP_CONFIG_DEFAULT.maxParamFactor < SWEEP_FIELD_RANGES.maxParamFactor.min || SWEEP_CONFIG_DEFAULT.maxParamFactor > SWEEP_FIELD_RANGES.maxParamFactor.max) {
    fail("T15", `mặc định maxParamFactor ${SWEEP_CONFIG_DEFAULT.maxParamFactor} ngoài phạm vi`);
  }
  results.push("T15 PASS — mọi mặc định nằm trong phạm vi validate (seed 20261012 ≤ 999.999.999 ✓ — hồi quy kẹp seed 999.999 cũ)");

  console.log(results.join("\n"));
  console.log(`\nKẾT QUẢ: ${results.length}/${results.length} PASS — hermetic (0 dòng DB, 0 LLM, 0 train)`);
}

main()
  .catch((err) => {
    console.error("VERIFY FAILED:", err instanceof Error ? err.message : err);
    console.error(results.join("\n"));
    process.exitCode = 1;
  })
  .finally(() => {
    void db.$disconnect();
  });
