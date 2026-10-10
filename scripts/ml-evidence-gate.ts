/**
 * scripts/ml-evidence-gate.ts — B2 CỔNG BẰNG CHỨNG (ML_OPS_BLUEPRINT §4,
 * phiên #81). QUYẾT ĐỊNH GRU BẰNG SỐ LIỆU, KHÔNG CẢM TÍNH — 3 phép đo trên
 * CHÍNH dữ liệu hệ thống:
 *
 *  1. Autocorrelation lag 1-5 của logret rổ top-20 (bar EOD thật) + CI 95%
 *     qua bootstrap 1.000× (cluster theo mã) — "còn tín hiệu tuần tự không
 *     dùng tới ở tần suất ngày?".
 *  2. Rank-IC (Spearman) của TỪNG đặc trưng (10 cũ + 6 mới) vs nhãn hướng
 *     5 phiên tới + bootstrap CI (cluster theo mã) — "đặc trưng mới có mang
 *     thông tin không?".
 *  3. ΔBrier paired bootstrap (1.000× resample val block): bản v2-lag16 vs
 *     bản serving lag-10 trên CÙNG windowHash — "thêm quá khứ explicit có
 *     cải thiện xác suất không?".
 *
 * QUY TẮC XỬ QUYẾT (ghi cứng AppSetting "ml-gate" + meta bản lag-16):
 *  - PASS → mở B3 (GRU) khi: CI95 ΔBrier hoàn toàn < 0 (v2 thắng có ý nghĩa)
 *    HOẶC ≥ 3/6 đặc trưng mới có |rank-IC| ≥ 0,02 với CI loại trừ 0.
 *  - Trung gian (CI chạm 0) → mặc định an toàn: FAIL.
 *  - PASS qua đường ΔBrier (CI cao < 0) → đồng thời HOÁN ĐỔI serving sang bản
 *    v2-lag16 (§1.5: thắng baseline trên cùng windowHash) trong 1 $transaction
 *    + AuditLog ML_GATE. PASS chỉ qua rank-IC → GRU mở nhưng serving giữ
 *    nguyên (đường train sẽ thăng khi đủ điều kiện promotion guard).
 *
 * Deterministic: bootstrap mulberry32 seed 20261011 — cùng windowHash → cùng
 * verdict (nghiệm thu B2.3). Chạy: `bun run scripts/ml-evidence-gate.ts`.
 */

import { db } from "../src/lib/db";
import {
  buildTrainingSet,
  featureAt,
  rollingFeatures,
  trainingWindowDigest,
  ML_FEATURE_COUNT,
  ML_HORIZON_DAYS,
  ML_WARMUP_BARS,
} from "../src/lib/ml/features";
import { MLP } from "../src/lib/ml/nn";
import { FEATURE_NAMES } from "../src/lib/ml/psi";

const BOOTSTRAP_DRAWS = 1_000;
const BOOTSTRAP_SEED = 20261011;
const RANK_IC_MIN = 0.02; // |IC| ≥ 0,02 mới tính "có ý nghĩa" (B2)
const NEW_FEATURE_DIMS = [10, 11, 12, 13, 14, 15]; // 6 chiều mới B1

/** RNG mulberry32 — giống nn.ts (deterministic). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Percentile (nội suy tuyến tính) trên mảng ĐÃ sort tăng dần. */
function percentileSorted(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const h = (n - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/** CI 95% bootstrap của TRUNG BÌNH các giá trị (cluster resample các phần tử). */
function bootstrapMeanCI(values: number[], rng: () => number): { mean: number; ciLow: number; ciHigh: number } {
  const n = values.length;
  const mean = n > 0 ? values.reduce((s, v) => s + v, 0) / n : NaN;
  if (n < 2) return { mean, ciLow: mean, ciHigh: mean };
  const means: number[] = [];
  for (let b = 0; b < BOOTSTRAP_DRAWS; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += values[Math.floor(rng() * n)];
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  return {
    mean,
    ciLow: percentileSorted(means, 0.025),
    ciHigh: percentileSorted(means, 0.975),
  };
}

/** Pearson corr (không qua thư viện — thuần viết tay). */
function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return NaN;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : NaN;
}

/** Xếp hạng có xử lý đồng hạng (ranks trung bình — Spearman chuẩn). */
function ranksOf(values: number[]): number[] {
  const n = values.length;
  const idx = values.map((v, i) => ({ v, i }));
  idx.sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(n).fill(0);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && idx[j + 1].v === idx[i].v) j++;
    const avg = (i + j) / 2 + 1; // rank 1-based trung bình khối đồng hạng
    for (let k = i; k <= j; k++) ranks[idx[k].i] = avg;
    i = j + 1;
  }
  return ranks;
}

/** Spearman rank correlation của 2 mảng cùng độ dài. */
function spearman(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length < 2) return NaN;
  return pearson(ranksOf(xs), ranksOf(ys));
}

/** Autocorrelation lag L của chuỗi (cặp hợp lệ, bỏ NaN). */
function autocorr(xs: number[], lag: number): number {
  const a: number[] = [];
  const b: number[] = [];
  for (let i = lag; i < xs.length; i++) {
    if (Number.isFinite(xs[i]) && Number.isFinite(xs[i - lag])) {
      a.push(xs[i]);
      b.push(xs[i - lag]);
    }
  }
  return pearson(a, b);
}

interface Report {
  measuredAt: string;
  windowHash: string;
  serving: { version: number; featureSet: string } | null;
  candidate: { version: number; featureSet: string } | null;
  samples: number;
  valSize: number;
  bootstrap: { draws: number; seed: number };
  autocorr: { lag: number; mean: number; ciLow: number; ciHigh: number }[];
  rankIC: {
    dim: number;
    name: string;
    isNew: boolean;
    mean: number;
    ciLow: number;
    ciHigh: number;
  }[];
  deltaBrier: {
    v1: number; // Brier trung bình bản lag-10 trên val
    v2: number; // Brier trung bình bản lag-16 trên val
    mean: number; // Δ = v2 − v1 (âm = v2 thắng)
    ciLow: number;
    ciHigh: number;
  } | null;
  newFeaturesSignificant: number;
  passedVia: "deltabrier" | "rankic" | null;
  verdict: "PASS" | "FAIL";
  swappedServing: boolean;
  notes: string[];
}

async function main() {
  const rng = mulberry32(BOOTSTRAP_SEED);
  const notes: string[] = [];

  /* ── Tìm bản serving + bản ứng viên lag-16 ── */
  const serving = await db.mlModel.findFirst({
    where: { kind: "dl-mlp", status: "serving" },
    orderBy: { version: "desc" },
  });
  const metaOf = (row: { meta: string | null }): { windowHash?: string; featureSet?: string } => {
    try {
      return JSON.parse(row.meta ?? "{}") as { windowHash?: string; featureSet?: string };
    } catch {
      return {};
    }
  };
  const servingMeta = serving ? metaOf(serving) : {};
  const servingSet = servingMeta.featureSet ?? "v1-lag10";

  /* ── Build tập train TRƯỚC (chuỗi bar hiện tại quyết định cửa so sánh) ── */
  const set = await buildTrainingSet(20);
  if (set.X.length < 600) {
    console.error(`LỖI: chỉ có ${set.X.length} mẫu — không đủ đo cổng.`);
    process.exit(1);
  }
  const windowMeta = trainingWindowDigest(set.series, { samples: set.X.length });

  // Ứng viên = bản MỚI NHẤT featureSet v2-lag16 (mọi status — thường archived).
  const allLag16 = await db.mlModel.findMany({
    where: { kind: "dl-mlp" },
    orderBy: { version: "desc" },
  });
  const candidate = allLag16.find((r) => (metaOf(r).featureSet ?? "v1-lag10") === "v2-lag16") ?? null;

  if (!serving) {
    console.error("LỖI: chưa có bản dl-mlp serving — train trước khi chạy cổng.");
    process.exit(1);
  }
  if (!candidate) {
    console.error(
      "LỖI: chưa có bản v2-lag16 (featureSet \"v2-lag16\") — POST /api/ml/train {target:\"dl-mlp\"} trước, rồi chạy lại script này."
    );
    process.exit(1);
  }

  const candidateMeta = metaOf(candidate);
  if (candidateMeta.windowHash !== windowMeta.windowHash) {
    console.error(
      `LỖI: windowHash bản lag-16 (${(candidateMeta.windowHash ?? "?").slice(0, 12)}…) ≠ dữ liệu hiện tại (${windowMeta.windowHash.slice(0, 12)}…).\n` +
        "Bar mới đã vào (eod-sync) — train lại bản v2-lag16 trên cửa sổ hiện tại rồi chạy lại cổng."
    );
    process.exit(1);
  }

  /* ── Chọn baseline lag-10 để đối chiếu "cùng windowHash" ──
   * Thứ tự ưu tiên (đảm bảo so sánh apples-to-apples đúng ý B2):
   * 1. Bản lag-10 MỚI NHẤT có windowHash == cửa sổ hiện tại (twin cùng dữ liệu —
   *    vD v12 nếu serving v8 còn train trên cửa sổ cũ sau eod-sync).
   * 2. Bản serving lag-10 (khi hash trùng — đường chuẩn).
   * 3. Bản serving lag-10 hash CŨ → vẫn đo nhưng ghi chú trung thực: ΔBrier
   *    là out-of-window cho baseline (bản serving đang phục vụ thực tế như
   *    vậy — đánh giá đúng điều kiện serving).
   * 4. Serving đã là v2-lag16 (re-đo thẩm định) → bản lag-10 gần nhất bất kỳ. */
  const lag10Rows = allLag16.filter(
    (r) => (metaOf(r).featureSet ?? "v1-lag10") === "v1-lag10" && r.id !== serving.id
  );
  let baseline: typeof serving | null =
    lag10Rows.find((r) => metaOf(r).windowHash === windowMeta.windowHash) ?? null;
  if (baseline && servingSet === "v1-lag10" && servingMeta.windowHash === windowMeta.windowHash) {
    baseline = serving; // serving còn tươi → đường chuẩn (ưu tiên)
  } else if (!baseline && servingSet === "v1-lag10") {
    baseline = serving;
    notes.push(
      `cảnh báo: serving v${serving.version} train trên cửa sổ CŨ (${(servingMeta.windowHash ?? "?").slice(0, 12)}…) — ΔBrier đo trên val block hiện tại là out-of-window cho baseline (đúng điều kiện serving thực tế).`
    );
  } else if (!baseline && servingSet === "v2-lag16") {
    baseline = lag10Rows[0] ?? null;
    if (baseline) {
      notes.push(`serving đã là v2-lag16 — so với bản lag-10 gần nhất (v${baseline.version}) để thẩm định.`);
    }
  }
  if (!baseline) {
    console.error("LỖI: không tìm thấy bản lag-10 nào để làm baseline so sánh.");
    process.exit(1);
  }
  const baselineMeta = metaOf(baseline);
  if (baselineMeta.windowHash === windowMeta.windowHash) {
    notes.push(
      `ΔBrier so bản lag-10 v${baseline.version} CÙNG windowHash ${windowMeta.windowHash.slice(0, 12)}… — "cùng dữ liệu, khác bộ đặc trưng".`
    );
    if (baseline.id !== serving.id) {
      notes.push(
        `baseline là bản archived v${baseline.version} (twin cùng cửa sổ) — serving v${serving.version} train trên cửa sổ cũ nên không dùng làm baseline ΔBrier.`
      );
    }
  }

  /* ── Phép đo 1: autocorrelation lag 1-5 (per-symbol, cluster bootstrap) ── */
  const autocorrByLag = new Map<number, number[]>();
  for (let lag = 1; lag <= 5; lag++) autocorrByLag.set(lag, []);
  for (const s of set.series) {
    const rets: number[] = [];
    for (let i = 1; i < s.closes.length; i++) {
      rets.push(Math.log(s.closes[i] / s.closes[i - 1]));
    }
    for (let lag = 1; lag <= 5; lag++) {
      const v = autocorr(rets, lag);
      if (Number.isFinite(v)) autocorrByLag.get(lag)!.push(v);
    }
  }
  const autocorrReport = [...autocorrByLag.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([lag, vals]) => {
      const ci = bootstrapMeanCI(vals, rng);
      return { lag, mean: Number(ci.mean.toFixed(4)), ciLow: Number(ci.ciLow.toFixed(4)), ciHigh: Number(ci.ciHigh.toFixed(4)) };
    });

  /* ── Phép đo 2: rank-IC từng đặc trưng (per-symbol, cluster bootstrap) ── */
  const icByDim: number[][] = Array.from({ length: ML_FEATURE_COUNT }, () => []);
  for (const s of set.series) {
    if (s.closes.length < ML_WARMUP_BARS + ML_HORIZON_DAYS) continue;
    const roll = rollingFeatures(s.closes, s.volumes);
    const feats: number[][] = [];
    const labels: number[] = [];
    for (let t = ML_WARMUP_BARS - 1; t < s.closes.length - ML_HORIZON_DAYS; t++) {
      const x = featureAt(roll, t);
      if (x == null) continue;
      const future = t + ML_HORIZON_DAYS;
      const ret = s.closes[future] / s.closes[t] - 1;
      const label = ret > 0.005 ? 2 : ret < -0.005 ? 0 : 1;
      feats.push(x);
      labels.push(label);
    }
    if (feats.length < 30) continue; // quá ít mẫu của mã — bỏ (nguyên tắc §1.4)
    for (let d = 0; d < ML_FEATURE_COUNT; d++) {
      const ic = spearman(
        feats.map((f) => f[d]),
        labels
      );
      if (Number.isFinite(ic)) icByDim[d].push(ic);
    }
  }
  const rankICReport = icByDim.map((vals, d) => {
    const ci = bootstrapMeanCI(vals, rng);
    return {
      dim: d,
      name: FEATURE_NAMES[d] ?? `f${d}`,
      isNew: NEW_FEATURE_DIMS.includes(d),
      mean: Number(ci.mean.toFixed(4)),
      ciLow: Number(ci.ciLow.toFixed(4)),
      ciHigh: Number(ci.ciHigh.toFixed(4)),
    };
  });

  /* ── Phép đo 3: ΔBrier paired bootstrap trên val block ── */
  const mlpV1 = MLP.fromJSON(baseline.weights);
  const mlpV2 = MLP.fromJSON(candidate.weights);
  const n = set.X.length;
  const nTrain = Math.floor(n * 0.8); // CÙNG cut 80/20 thời gian như fit()
  const valIdx: number[] = [];
  for (let i = nTrain; i < n; i++) valIdx.push(i);

  const brierV1: number[] = [];
  const brierV2: number[] = [];
  for (const i of valIdx) {
    const y = set.y[i];
    const p1 = mlpV1.predictProba(set.X[i]); // [pUp, pFlat, pDown]
    const p2 = mlpV2.predictProba(set.X[i]);
    const oh = [y === 2 ? 1 : 0, y === 1 ? 1 : 0, y === 0 ? 1 : 0];
    let b1 = 0;
    let b2 = 0;
    for (let c = 0; c < 3; c++) {
      b1 += (p1[c] - oh[c]) ** 2;
      b2 += (p2[c] - oh[c]) ** 2;
    }
    brierV1.push(b1);
    brierV2.push(b2);
  }
  const v1Mean = brierV1.reduce((s, v) => s + v, 0) / brierV1.length;
  const v2Mean = brierV2.reduce((s, v) => s + v, 0) / brierV2.length;
  const deltas = brierV2.map((b, i) => b - brierV1[i]); // Δ_i paired từng MẪU
  // Paired bootstrap: resample CHỈ MỘT tập index rồi lấy mean của CẢ HAI phía
  // cùng index (resample theo MẪU ghép cặp — nghiệm thu B2.2, không resample độc lập)
  const bootMeans: number[] = [];
  const nv = valIdx.length;
  for (let b = 0; b < BOOTSTRAP_DRAWS; b++) {
    let s = 0;
    for (let i = 0; i < nv; i++) s += deltas[Math.floor(rng() * nv)];
    bootMeans.push(s / nv);
  }
  bootMeans.sort((a, b) => a - b);
  const dbMean = deltas.reduce((s, v) => s + v, 0) / nv;
  const deltaBrier = {
    v1: Number(v1Mean.toFixed(4)),
    v2: Number(v2Mean.toFixed(4)),
    mean: Number(dbMean.toFixed(4)),
    ciLow: Number(percentileSorted(bootMeans, 0.025).toFixed(4)),
    ciHigh: Number(percentileSorted(bootMeans, 0.975).toFixed(4)),
  };

  /* ── Verdict theo quy tắc B2 ── */
  const passDeltaBrier = deltaBrier.ciHigh < 0; // CI hoàn toàn < 0 → v2 thắng
  const significantNew = rankICReport.filter(
    (r) => r.isNew && Math.abs(r.mean) >= RANK_IC_MIN && (r.ciLow > 0 || r.ciHigh < 0)
  );
  const passRankIC = significantNew.length >= 3;
  const verdict: "PASS" | "FAIL" = passDeltaBrier || passRankIC ? "PASS" : "FAIL";
  const passedVia = passDeltaBrier ? "deltabrier" : passRankIC ? "rankic" : null;

  /* ── Hoán đổi serving khi PASS qua ΔBrier (§1.5 thắng baseline cùng hash) ── */
  let swappedServing = false;
  if (verdict === "PASS" && passDeltaBrier && candidate.id !== serving.id) {
    const [, updated] = await db.$transaction([
      db.mlModel.updateMany({
        where: { kind: "dl-mlp", status: "serving" },
        data: { status: "archived" },
      }),
      db.mlModel.update({
        where: { id: candidate.id },
        data: { status: "serving" },
      }),
    ]);
    swappedServing = updated.status === "serving";
    await db.auditLog.create({
      data: {
        action: "ML_GATE",
        entity: "MlModel",
        entityId: candidate.id,
        before: JSON.stringify({ servingVersion: serving.version, servingFeatureSet: servingSet }),
        after: JSON.stringify({
          promotedVersion: candidate.version,
          featureSet: "v2-lag16",
          deltaBrier,
          verdict,
          passedVia,
          at: new Date().toISOString(),
        }),
      },
    });
    notes.push(
      `PASS qua ΔBrier — serving hoán đổi sang bản v${candidate.version} (v2-lag16) trong 1 $transaction + audit ML_GATE.`
    );
  }

  /* ── Ghi AppSetting "ml-gate" + meta.gateVerdict bản ứng viên ── */
  const measuredAt = new Date().toISOString();
  const gateValue = JSON.stringify({
    verdict,
    measuredAt,
    windowHash: windowMeta.windowHash,
    deltaBrier,
    newFeaturesSignificant: significantNew.length,
    passedVia,
    swappedServing,
    candidateVersion: candidate.version,
    servingVersion: serving.version,
    samples: n,
    valSize: nv,
    bootstrap: { draws: BOOTSTRAP_DRAWS, seed: BOOTSTRAP_SEED },
    rankIC: rankICReport,
    autocorr: autocorrReport,
    notes,
  });
  await db.appSetting.upsert({
    where: { key: "ml-gate" },
    create: { key: "ml-gate", value: gateValue },
    update: { value: gateValue },
  });
  // meta.gateVerdict trên bản ứng viên (re-run không đổi kết quả cùng hash —
  // verdict mới ghi đè cùng giá trị)
  try {
    const candMeta = JSON.parse(candidate.meta ?? "{}") as Record<string, unknown>;
    candMeta.gateVerdict = verdict;
    await db.mlModel.update({
      where: { id: candidate.id },
      data: { meta: JSON.stringify(candMeta) },
    });
  } catch (metaErr) {
    notes.push(`cảnh báo: không ghi được meta.gateVerdict (${metaErr instanceof Error ? metaErr.message : String(metaErr)})`);
  }

  const report: Report = {
    measuredAt,
    windowHash: windowMeta.windowHash,
    serving: { version: serving.version, featureSet: servingSet },
    candidate: { version: candidate.version, featureSet: "v2-lag16" },
    samples: n,
    valSize: nv,
    bootstrap: { draws: BOOTSTRAP_DRAWS, seed: BOOTSTRAP_SEED },
    autocorr: autocorrReport,
    rankIC: rankICReport,
    deltaBrier,
    newFeaturesSignificant: significantNew.length,
    passedVia,
    verdict,
    swappedServing,
    notes,
  };
  console.log(JSON.stringify(report, null, 2));
  console.error(
    `\nVERDICT: ${verdict}${passedVia ? ` (qua ${passedVia})` : ""} — ΔBrier CI [${deltaBrier.ciLow}, ${deltaBrier.ciHigh}] · ${significantNew.length}/6 đặc trưng mới có ý nghĩa`
  );
  await db.$disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error("LỖI:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
