/**
 * scripts/ml-arch-verify.ts (#94 · Task 3) — nghiệm thu đại tu MLP kiến trúc
 * N-layer (không LLM, không đụng dữ liệu thật — hermetic 100% in-memory):
 *
 *  T1 — MLP.fromJSON nạp được bản JSON CŨ W1..b3 (arch 10-16-8-3 — định dạng
 *       bản serving v8): arch/paramCount/predictProba đúng.
 *  T2 — MLP.fromJSON nạp format MỚI blocks (arch + activations + blocks[]).
 *  T3 — fit() trên dữ liệu giả ~600 mẫu: hidden [8] · tanh · lossWeights
 *       [1, 2, 0,5] · l2 0,001 · valFraction 0,25 → metrics hợp lệ.
 *  T4 — parseMlpArch chấp nhận "16-8-3" (1 lớp ẩn) + "16-24-12-8-3" (3 lớp),
 *       từ chối "16-3" (thiếu lớp ẩn) + "a-b-c" (không phải số).
 *  T5 — sanitizeTuningInput chấp nhận hidden/activations/lossWeights hợp lệ,
 *       từ chối hidden 6 lớp (ngoài 1..5).
 *  T6 — round-trip toJSON → fromJSON: trọng số bằng nhau từng giá trị.
 *
 * Chạy: env -u DATABASE_URL bun scripts/ml-arch-verify.ts
 * (env -u chống shell DATABASE_URL cũ đè .env — bài học #87/#89.)
 */

import { db } from "../src/lib/db";
import { MLP, parseMlpArch } from "../src/lib/ml/nn";
import { sanitizeTuningInput } from "../src/lib/ml/tuning";

const results: string[] = [];

function fail(name: string, detail: string): never {
  results.push(`✗ ${name}: ${detail}`);
  throw new Error(`${name}: ${detail}`);
}

function expectThrow(name: string, fn: () => void, snippet: string): void {
  try {
    fn();
  } catch {
    return; // đúng kỳ vọng — từ chối
  }
  fail(name, `phải throw nhưng không (${snippet})`);
}

/** RNG giả deterministic cho dữ liệu test (không cần chất lượng — chỉ hợp lệ). */
function makeRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

async function main() {
  const rng = makeRng(20261011);
  const mk = (n: number): number[] => Array.from({ length: n }, () => Number((rng() * 0.2 - 0.1).toFixed(6)));

  /* ── T1 — fromJSON định dạng CŨ W1..b3 (bản serving v8 10-16-8-3) ── */
  const oldJson = JSON.stringify({
    arch: "10-16-8-3",
    W1: mk(160), b1: mk(16),
    W2: mk(128), b2: mk(8),
    W3: mk(24), b3: mk(3),
    norm: { mean: mk(10), std: mk(10) },
  });
  let mOld: MLP;
  try {
    mOld = MLP.fromJSON(oldJson);
  } catch (err) {
    fail("T1", `fromJSON cũ throw: ${err instanceof Error ? err.message : err}`);
  }
  if (mOld.archString !== "10-16-8-3") fail("T1", `archString=${mOld.archString}`);
  if (mOld.paramCount !== 339) fail("T1", `paramCount=${mOld.paramCount} ≠ 339 (160+16+128+8+24+3)`);
  const pOld = mOld.predictProba(mk(10));
  const sumOld = pOld[0] + pOld[1] + pOld[2];
  if (Math.abs(sumOld - 1) > 1e-9) fail("T1", `softmax tổng=${sumOld} ≠ 1`);
  if (mOld.activations.join(",") !== "relu,relu") {
    fail("T1", `activations bản cũ phải relu×2, nhận ${mOld.activations.join(",")}`);
  }
  results.push("T1 PASS — fromJSON CŨ 10-16-8-3: arch ✓ · 339 tham số ✓ · softmax Σ=1 ✓ · relu×2 ✓");

  /* ── T2 — fromJSON định dạng MỚI blocks ── */
  const mSrc = new MLP({ in: 16, hidden: [24, 12, 8], out: 3 }, ["relu", "tanh", "sigmoid"]);
  const newJson = mSrc.toJSON();
  const rawNew = JSON.parse(newJson) as { blocks?: unknown; activations?: unknown };
  if (!Array.isArray(rawNew.blocks) || rawNew.blocks.length !== 4) {
    fail("T2", `toJSON blocks=${(rawNew.blocks as unknown[])?.length} ≠ 4 (3 ẩn + ra)`);
  }
  let mNew: MLP;
  try {
    mNew = MLP.fromJSON(newJson);
  } catch (err) {
    fail("T2", `fromJSON mới throw: ${err instanceof Error ? err.message : err}`);
  }
  if (mNew.archString !== "16-24-12-8-3") fail("T2", `archString=${mNew.archString}`);
  if (mNew.activations.join(",") !== "relu,tanh,sigmoid") {
    fail("T2", `activations=${mNew.activations.join(",")}`);
  }
  if (mNew.paramCount !== mSrc.paramCount) fail("T2", `paramCount ${mNew.paramCount} ≠ ${mSrc.paramCount}`);
  results.push(
    `T2 PASS — fromJSON MỚI blocks: 16-24-12-8-3 ✓ · activations relu,tanh,sigmoid ✓ · ${mNew.paramCount} tham số ✓`
  );

  /* ── T3 — fit dữ liệu giả ~600 mẫu (hidden [8] · tanh · lossWeights · l2 · valFraction) ── */
  const X = Array.from({ length: 600 }, () => Array.from({ length: 16 }, () => rng() * 4 - 2));
  const y = X.map((row, i) => {
    const s = row.slice(0, 4).reduce((a, b) => a + b, 0);
    return s > 1.5 ? 2 : s < -1.5 ? 0 : i % 3 === 0 ? 1 : s > 0 ? 1 : 0;
  });
  const mFit = new MLP({ in: 16, hidden: [8], out: 3 }, ["tanh"]);
  const fit = mFit.fit(X, y, {
    lossWeights: [1, 2, 0.5],
    l2: 0.001,
    valFraction: 0.25,
    maxEpochs: 40,
    patience: 10,
    seed: 42,
  });
  if (fit.samples !== 600) fail("T3", `samples=${fit.samples} ≠ 600`);
  if (fit.epochs < 1 || fit.epochs > 40) fail("T3", `epochs=${fit.epochs} ngoài [1..40]`);
  for (const [k, v] of Object.entries({ trainAcc: fit.trainAcc, valAcc: fit.valAcc })) {
    if (!Number.isFinite(v) || v < 0 || v > 1) fail("T3", `${k}=${v} ngoài [0..1]`);
  }
  if (!Number.isFinite(fit.trainLoss) || !Number.isFinite(fit.valLoss) || fit.valLoss <= 0) {
    fail("T3", `loss không hợp lệ: train=${fit.trainLoss} val=${fit.valLoss}`);
  }
  // Deterministic: cùng seed → cùng metrics.
  const mFit2 = new MLP({ in: 16, hidden: [8], out: 3 }, ["tanh"]);
  const fit2 = mFit2.fit(X, y, {
    lossWeights: [1, 2, 0.5],
    l2: 0.001,
    valFraction: 0.25,
    maxEpochs: 40,
    patience: 10,
    seed: 42,
  });
  if (JSON.stringify(fit) !== JSON.stringify(fit2)) fail("T3", "không deterministic với cùng seed 42");
  results.push(
    `T3 PASS — fit 600 mẫu hidden [8] tanh · lossWeights [1,2,0,5] · l2 0,001 · val 0,25: epochs ${fit.epochs} · trainAcc ${(fit.trainAcc * 100).toFixed(1).replace(".", ",")}% · valAcc ${(fit.valAcc * 100).toFixed(1).replace(".", ",")}% · deterministic ✓`
  );

  /* ── T4 — parseMlpArch ── */
  const one = parseMlpArch("16-8-3");
  if (one.hidden.length !== 1 || one.hidden[0] !== 8 || one.in !== 16 || one.out !== 3) {
    fail("T4", `"16-8-3" parse sai: ${JSON.stringify(one)}`);
  }
  const three = parseMlpArch("16-24-12-8-3");
  if (three.hidden.join(",") !== "24,12,8") fail("T4", `"16-24-12-8-3" hidden=${three.hidden.join(",")}`);
  const legacy = parseMlpArch("16-24-12-3");
  if (legacy.hidden.join(",") !== "24,12") fail("T4", `chuỗi cũ "16-24-12-3" hidden=${legacy.hidden.join(",")}`);
  expectThrow("T4", () => parseMlpArch("16-3"), '"16-3" phải bị từ chối');
  expectThrow("T4", () => parseMlpArch("a-b-c"), '"a-b-c" phải bị từ chối');
  expectThrow("T4", () => parseMlpArch("16-8-8-8-8-8-8-3"), "8 phần (6 lớp ẩn) phải bị từ chối");
  results.push('T4 PASS — parseMlpArch: "16-8-3" ✓ · "16-24-12-8-3" ✓ · cũ "16-24-12-3" ✓ · từ chối "16-3"/"a-b-c"/6-lớp-ẩn ✓');

  /* ── T5 — sanitizeTuningInput ── */
  const ok = sanitizeTuningInput({
    mlp: { hidden: [20, 10], activations: ["relu", "tanh"], lossWeights: [1, 2, 0.5], l2: 0.001, seed: 7 },
  });
  if (ok.errors.length > 0) fail("T5", `input hợp lệ bị lỗi: ${ok.errors.join("; ")}`);
  if (ok.mlp?.hidden?.join(",") !== "20,10") fail("T5", `hidden=${ok.mlp?.hidden?.join(",")}`);
  if (ok.mlp?.activations?.join(",") !== "relu,tanh") fail("T5", `activations=${ok.mlp?.activations?.join(",")}`);
  if (ok.mlp?.lossWeights?.join(",") !== "1,2,0.5") fail("T5", `lossWeights=${ok.mlp?.lossWeights?.join(",")}`);
  const bad6 = sanitizeTuningInput({ mlp: { hidden: [8, 8, 8, 8, 8, 8] } });
  if (bad6.errors.length === 0 || bad6.mlp != null) fail("T5", "hidden 6 lớp phải bị từ chối");
  const badAct = sanitizeTuningInput({ mlp: { hidden: [8], activations: ["gelu"] } });
  if (badAct.errors.length === 0) fail("T5", "activation lạ phải bị từ chối");
  const badLw = sanitizeTuningInput({ mlp: { lossWeights: [1, 2] } });
  if (badLw.errors.length === 0) fail("T5", "lossWeights 2 phần phải bị từ chối");
  const mismatch = sanitizeTuningInput({ mlp: { hidden: [8, 8], activations: ["relu"] } });
  if (mismatch.errors.length === 0) fail("T5", "activations lệch độ dài hidden phải bị từ chối");
  results.push(
    "T5 PASS — sanitizeTuningInput: hợp lệ ✓ · 6 lớp bị chặn ✓ · activation lạ chặn ✓ · lossWeights≠3 chặn ✓ · lệch độ dài chặn ✓"
  );

  /* ── T6 — round-trip toJSON → fromJSON ── */
  const roundJson = mFit.toJSON();
  const mRound = MLP.fromJSON(roundJson);
  const pa = mFit.predictProba(X[0]);
  const pb = mRound.predictProba(X[0]);
  if (!pa.every((v, i) => Math.abs(v - pb[i]) < 1e-12)) {
    fail("T6", `predictProba lệch: ${pa.join(",")} vs ${pb.join(",")}`);
  }
  const pa2 = mFit.predictProba(X[599]);
  const pb2 = mRound.predictProba(X[599]);
  if (!pa2.every((v, i) => Math.abs(v - pb2[i]) < 1e-12)) {
    fail("T6", `predictProba (mẫu cuối) lệch: ${pa2.join(",")} vs ${pb2.join(",")}`);
  }
  if (mRound.paramCount !== mFit.paramCount) fail("T6", `paramCount ${mRound.paramCount} ≠ ${mFit.paramCount}`);
  if (mRound.activations.join(",") !== mFit.activations.join(",")) fail("T6", "activations lệch sau round-trip");
  results.push("T6 PASS — round-trip toJSON → fromJSON: predictProba bằng nhau 1e-12 ✓ · arch/activations ✓");

  console.log(results.join("\n"));
  console.log(`\nKẾT QUẢ: ${results.length}/${results.length} PASS — hermetic (0 dòng DB, 0 LLM)`);
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
