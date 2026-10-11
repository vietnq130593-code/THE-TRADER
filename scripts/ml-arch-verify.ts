/**
 * scripts/ml-arch-verify.ts (#94 · Task 3 → fixbug FB-4B mở rộng T7-T11) —
 * nghiệm thu đại tu MLP kiến trúc N-layer (không LLM, không đụng dữ liệu thật
 * — hermetic 100% in-memory):
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
 *  T7 — OLD-FORMAT-FORWARD (F-MLP-10): fromJSON cũ W1..b3 10-16-8-3 →
 *       predictProba KHỚP forward pass THAM CHIẾU ĐỘC LẬP xây từ chính
 *       W1..b3 (differential từng phần tử 1e-12 — chống transpose: map W
 *       sai hướng sẽ lệch ngay).
 *  T8 — OUTPUT-ORDER (F-MLP-10): dữ liệu controlled x[0] mạnh dương → argmax
 *       predictProba = 0 (pUp); x[0] mạnh âm → argmax = 2 (pDown) — hợp đồng
 *       [pUp, pFlat, pDown] bắt buộc (swap thứ tự sẽ FAIL).
 *  T9 — FROMJSON-GUARDS (F-MLP-10 + F-MLP-02): blocks lệch số khối vs arch →
 *       throw có message; format cũ W1..b3 ≠ 2 lớp ẩn → throw; thiếu W2 →
 *       throw; arch "16-500-3" vượt trần 96 nơ-rôn → constructor guard throw.
 *  T10 — MIGRATION (F-MLP-10): parseMlTuningValue với AppSetting ml-tuning
 *       cũ format #89 {"mlp":{"h1":20,"h2":10,…}} → hidden [20,10] +
 *       activations relu×2, giá trị cũ GIỮ (hàm thuần nhận object giả lập —
 *       0 đụng DB, script giữ hermetic).
 *  T11 — ROUTE-MISMATCH (F-MLP-10): sanitizeTuningInput gửi hidden [24,12,16]
 *       + activations chỉ 2 phần → bị chặn (errors ≠ rỗng — route 422 trước
 *       khi reconcile chạy); hidden gửi một mình hợp lệ (partial semantics).
 *
 * Chạy: env -u DATABASE_URL bun scripts/ml-arch-verify.ts
 * (env -u chống shell DATABASE_URL cũ đè .env — bài học #87/#89.)
 */

import { db } from "../src/lib/db";
import { MLP, MLP_MAX_NEURONS, parseMlpArch } from "../src/lib/ml/nn";
import {
  effectiveMlTuning,
  parseMlTuningValue,
  sanitizeTuningInput,
} from "../src/lib/ml/tuning";

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

/** Như expectThrow nhưng còn bắt lỗi phải CÓ message chứa đoạn mong muốn. */
function expectThrowMsg(
  name: string,
  fn: () => void,
  snippet: string,
  msgIncludes: string
): void {
  try {
    fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes(msgIncludes)) {
      fail(name, `message "${msg}" thiếu "${msgIncludes}" (${snippet})`);
    }
    return; // đúng kỳ vọng — từ chối kèm message rõ
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

  /* ── T7 — OLD-FORMAT-FORWARD (F-MLP-10): fromJSON cũ W1..b3 10-16-8-3 khớp
     forward pass THAM CHIẾU ĐỘC LẬP xây từ chính W1..b3 (W [H×IN] row-major,
     off = j*from, relu 2 lớp ẩn + softmax, norm z-score) — chống transpose:
     map W sai hướng/đảo行列 sẽ lệch từng phần tử ngay lập tức. ── */
  const std7 = mk(10).map((v) => (v === 0 ? 1 : v));
  const w7 = {
    W1: mk(160), b1: mk(16),
    W2: mk(128), b2: mk(8),
    W3: mk(24), b3: mk(3),
    norm: { mean: mk(10), std: std7 },
  };
  const m7 = MLP.fromJSON(JSON.stringify({ arch: "10-16-8-3", ...w7 }));
  const refForwardOld = (x: number[]): [number, number, number] => {
    const IN = 10, H1 = 16, H2 = 8, OUT = 3;
    const xn = x.map((v, j) => (v - w7.norm.mean[j]) / (w7.norm.std[j] || 1));
    const h1: number[] = [];
    for (let j = 0; j < H1; j++) {
      let s = w7.b1[j];
      for (let k = 0; k < IN; k++) s += w7.W1[j * IN + k] * xn[k];
      h1.push(s > 0 ? s : 0); // relu
    }
    const h2: number[] = [];
    for (let j = 0; j < H2; j++) {
      let s = w7.b2[j];
      for (let k = 0; k < H1; k++) s += w7.W2[j * H1 + k] * h1[k];
      h2.push(s > 0 ? s : 0);
    }
    const z: number[] = [];
    for (let c = 0; c < OUT; c++) {
      let s = w7.b3[c];
      for (let k = 0; k < H2; k++) s += w7.W3[c * H2 + k] * h2[k];
      z.push(s);
    }
    const mx = Math.max(...z);
    const ex = z.map((v) => Math.exp(v - mx));
    const sum = ex.reduce((a, b) => a + b, 0);
    const p = ex.map((v) => v / sum); // p[0]=DOWN · p[1]=FLAT · p[2]=UP
    return [p[2], p[1], p[0]]; // hợp đồng predictProba [pUp, pFlat, pDown]
  };
  let t7Max = 0;
  for (let t = 0; t < 25; t++) {
    const x = mk(10);
    const got = m7.predictProba(x);
    const ref = refForwardOld(x);
    for (let c = 0; c < 3; c++) t7Max = Math.max(t7Max, Math.abs(got[c] - ref[c]));
  }
  if (t7Max >= 1e-12) fail("T7", `predictProba lệch tham chiếu độc lập: maxDiff=${t7Max}`);
  results.push(
    "T7 PASS — fromJSON CŨ W1..b3: predictProba khớp forward THAM CHIẾU ĐỘC LẬP 25 mẫu × 3 class (chống transpose) 1e-12 ✓"
  );

  /* ── T8 — OUTPUT-ORDER (F-MLP-10): hợp đồng [pUp, pFlat, pDown] trên dữ liệu
     controlled — x[0] mạnh dương → argmax 0 (pUp); x[0] mạnh âm → argmax 2
     (pDown). Fit model nhỏ (như review FB-2 D1/D2) rồi đo argmax trực tiếp. ── */
  const n8 = 900;
  const X8: number[][] = [];
  const y8: number[] = [];
  for (let i = 0; i < n8; i++) {
    const row = Array.from({ length: 16 }, () => rng() * 2 - 1);
    row[0] = rng() * 4 - 2; // đặc trưng phán quyết nằm trong x[0]
    X8.push(row);
    y8.push(row[0] > 1.2 ? 2 : row[0] < -1.2 ? 0 : 1);
  }
  const m8 = new MLP({ in: 16, hidden: [16], out: 3 }, ["relu"]);
  m8.fit(X8, y8, { maxEpochs: 60, patience: 15, seed: 3 });
  const zeros16 = Array.from({ length: 16 }, () => 0);
  const pUp8 = m8.predictProba([2, ...zeros16.slice(1)]);
  const pDn8 = m8.predictProba([-2, ...zeros16.slice(1)]);
  if (!(pUp8[0] > pUp8[1] && pUp8[0] > pUp8[2])) {
    fail("T8", `x[0]=+2 phải cho pUp (index 0) max — nhận [${pUp8.map((v) => v.toFixed(4)).join(",")}]`);
  }
  if (!(pDn8[2] > pDn8[1] && pDn8[2] > pDn8[0])) {
    fail("T8", `x[0]=−2 phải cho pDown (index 2) max — nhận [${pDn8.map((v) => v.toFixed(4)).join(",")}]`);
  }
  results.push(
    `T8 PASS — hợp đồng [pUp,pFlat,pDown]: x[0]=+2 → argmax 0 (pUp ${(pUp8[0] * 100).toFixed(1).replace(".", ",")}%) · x[0]=−2 → argmax 2 (pDown ${(pDn8[2] * 100).toFixed(1).replace(".", ",")}%) ✓`
  );

  /* ── T9 — FROMJSON-GUARDS (F-MLP-10 + F-MLP-02): 3 guard của fromJSON +
     constructor trần 96 nơ-rôn — đều throw kèm message tiếng Việt rõ ràng. ── */
  expectThrowMsg(
    "T9",
    () =>
      MLP.fromJSON(
        JSON.stringify({
          arch: "16-24-12-3",
          activations: ["relu", "relu"],
          blocks: [
            { W: mk(384), b: mk(24) },
            { W: mk(36), b: mk(3) },
          ],
        })
      ),
    "blocks 2 khối vs arch 2 lớp ẩn (cần 3)",
    "khối"
  );
  expectThrowMsg(
    "T9",
    () =>
      MLP.fromJSON(
        JSON.stringify({
          arch: "16-24-12-8-3",
          W1: mk(384), b1: mk(24),
          W2: mk(288), b2: mk(12),
          W3: mk(96), b3: mk(8),
        })
      ),
    "cũ W1..b3 nhưng arch 3 lớp ẩn",
    "định dạng cũ"
  );
  expectThrowMsg(
    "T9",
    () =>
      MLP.fromJSON(
        JSON.stringify({ arch: "10-16-8-3", W1: mk(160), b1: mk(16), W3: mk(24), b3: mk(3) })
      ),
    "cũ thiếu W2",
    "thiếu W2"
  );
  expectThrowMsg(
    "T9",
    () => new MLP({ in: 16, hidden: [500], out: 3 }),
    "hidden 500 nơ-rôn vượt trần 96 (F-MLP-02)",
    String(MLP_MAX_NEURONS)
  );
  expectThrowMsg(
    "T9",
    () =>
      MLP.fromJSON(
        JSON.stringify({
          arch: "16-500-3",
          blocks: [
            { W: mk(500 * 16), b: mk(500) },
            { W: mk(3 * 500), b: mk(3) },
          ],
        })
      ),
    "weights JSON rác arch 16-500-3 (F-MLP-02)",
    String(MLP_MAX_NEURONS)
  );
  results.push(
    `T9 PASS — fromJSON guards: blocks lệch số khối throw ✓ · cũ ≠2 lớp ẩn throw ✓ · thiếu W2 throw ✓ · hidden 500 / arch "16-500-3" > ${MLP_MAX_NEURONS} throw (F-MLP-02) ✓`
  );

  /* ── T10 — MIGRATION (F-MLP-10): AppSetting ml-tuning cũ format #89
     {"mlp":{"h1":20,"h2":10,…}} → parseMlTuningValue cho hidden [20,10] +
     activations relu×2 — GIÁ TRỊ CŨ ĐƯỢC GIỮ (không bị mặc định [24,12] đè).
     Hàm thuần nhận object giả lập — 0 đụng DB (script giữ hermetic). ── */
  const legacyTuning = parseMlTuningValue({
    mlp: {
      h1: 20,
      h2: 10,
      epochs: 50,
      patience: 8,
      batchSize: 16,
      lr: 0.005,
      l2: 0.0005,
      valFraction: 0.15,
      seed: 7,
    },
    rag: { topK: 5, k1: 1.2, b: 0.7, wRecency: 0.4 },
    updatedAt: "2025-01-01T00:00:00.000Z",
  });
  if (legacyTuning.mlp?.hidden?.join(",") !== "20,10") {
    fail("T10", `migration h1/h2 → hidden ${legacyTuning.mlp?.hidden?.join(",")} ≠ "20,10"`);
  }
  if (legacyTuning.mlp?.activations?.join(",") !== "relu,relu") {
    fail("T10", `activations ${legacyTuning.mlp?.activations?.join(",")} ≠ "relu,relu"`);
  }
  if (
    legacyTuning.mlp?.epochs !== 50 ||
    legacyTuning.mlp?.lr !== 0.005 ||
    legacyTuning.mlp?.seed !== 7 ||
    legacyTuning.rag?.topK !== 5
  ) {
    fail("T10", `giá trị cũ bị mất sau migration: ${JSON.stringify(legacyTuning)}`);
  }
  const eff10 = effectiveMlTuning(legacyTuning);
  if (eff10.mlp.hidden.join(",") !== "20,10" || eff10.mlp.activations.join(",") !== "relu,relu") {
    fail(
      "T10",
      `effective đè giá trị cũ: hidden=${eff10.mlp.hidden.join(",")} acts=${eff10.mlp.activations.join(",")}`
    );
  }
  results.push(
    "T10 PASS — migration #89 h1/h2: hidden [20,10] ✓ · activations relu×2 ✓ · giá trị cũ giữ (epochs 50 · lr 0,005 · seed 7 · rag topK 5) ✓ · effective không đè ✓"
  );

  /* ── T11 — ROUTE-MISMATCH (F-MLP-10): sanitizeTuningInput gửi hidden
     [24,12,16] + activations chỉ 2 phần → BỊ CHẶN (errors ≠ rỗng với thông
     báo "cùng độ dài" — route trả 422 TRƯỚC khi merge/reconcile chạy, nên
     không bao giờ ghi activations lệch độ dài hidden). Hidden gửi MỘT MÌNH
     (không kèm activations) hợp lệ — partial semantics của sanitize. ── */
  const mm = sanitizeTuningInput({
    mlp: { hidden: [24, 12, 16], activations: ["relu", "tanh"] },
  });
  const mmErr = mm.errors.find((e) => e.includes("cùng độ dài"));
  if (mm.errors.length === 0 || mmErr == null) {
    fail("T11", `hidden 3 lớp + activations 2 phần phải lỗi "cùng độ dài" — nhận errors=[${mm.errors.join("; ")}]`);
  }
  if (mmErr != null && !(mmErr.includes("3 lớp") && mmErr.includes("2 activation"))) {
    fail("T11", `message thiếu số liệu kỳ vọng: "${mmErr}"`);
  }
  const solo = sanitizeTuningInput({ mlp: { hidden: [24, 12, 16] } });
  if (solo.errors.length !== 0) {
    fail("T11", `hidden một mình phải hợp lệ — nhận errors=[${solo.errors.join("; ")}]`);
  }
  if (solo.mlp?.hidden?.join(",") !== "24,12,16") {
    fail("T11", `solo.hidden=${solo.mlp?.hidden?.join(",")} ≠ "24,12,16"`);
  }
  results.push(
    "T11 PASS — route mismatch: hidden 3 lớp + activations 2 phần bị chặn 422 (errors «cùng độ dài») ✓ · hidden một mình hợp lệ (partial) ✓"
  );

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
