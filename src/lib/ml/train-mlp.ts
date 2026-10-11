/**
 * src/lib/ml/train-mlp.ts — BỘ TRAIN + LƯU dl-mlp DÙNG CHUNG (C1 · F2 #99 —
 * ML_AUTOML_BLUEPRINT §4.3/§0.9-F2, trích từ api/ml/train/route.ts).
 *
 * TRƯỚC C1: toàn bộ logic này nằm BÊN TRONG route train — route khác
 * (sweep) không import được route-of-route. Giờ train route (hiện hành,
 * battle-tested #35→#94) và sweep route cùng gọi MỘT nguồn:
 *   - chia sẻ MUTEX in-flight + cooldown (F-612R-06) → train tay khi sweep
 *     đang chạy → 429 xếp hàng, KHÔNG bao giờ 2 hàng trùng (kind, version)
 *     (nghiệm thu §4.7-7);
 *   - cùng nextVersion/saveModel → đánh version max+1 một cửa duy nhất.
 *
 * NGUYÊN TẮC TRÍCH XUẤT (revisit-friendly):PURE REFACTOR cho đường cũ —
 * train route phải giữ NGUYÊN mọi hành vi HTTP (429 cooldown/mutex, settle
 * trước train, skip-guard force=false, GRU gate 400, response shapes).
 * trainDlMlp() chỉ THÊM tham số tuỳ chọn (opts) — không gọi opts thì đúng
 * đường cũ từng dòng (đọc AppSetting ml-tuning, promote theo serving-swap
 * guard A4/B1 như trước).
 *
 * opts (chỉ sweep dùng):
 *   - tuning: cấu hình ứng viên THAY cho readEffectiveMlTuning() (arch +
 *     activations + lossWeights + hyper từng ứng viên — meta vẫn ghi đúng
 *     tuning đã áp dụng như #94).
 *   - promote:false → luôn lưu "archived", BỎ đọc serving-swap guard (trả
 *     promotion:null) — sweep tự làm gated swap sau (cổng 4 điều kiện §4.4).
 *   - extraMeta: shallow-merge vào meta JSON bản lưu (sweepRunId +
 *     sweepIndex — champion board truy vết được mọi ứng viên §2.10).
 */

import { db } from "@/lib/db";
import {
  buildTrainingSet,
  trainingWindowDigest,
  ML_FEATURE_COUNT,
  ML_FEATURE_SET,
  ML_FEATURE_SET_V1,
  ML_HORIZON_DAYS,
  standardize,
  type TrainingSetWithSeries,
  type TrainingWindowMeta,
} from "@/lib/ml/features";
import { MLP, mlpArchString, type MlpActivation, type MlpArch } from "@/lib/ml/nn";
import { readEffectiveMlTuning, type MlpTuning } from "@/lib/ml/tuning";

/* ─────────────────── Mutex + cooldown dùng chung (F-612R-06 → C1/F2) ─────────────────── */

/** Cooldown giữa 2 lần train (giữ nguyên 60s như route trước C1). */
export const TRAIN_COOLDOWN_MS = 60_000;

let lastTrainAt = 0;
/** F-612R-06 — 1 train/sweep chạy tại 1 thời điểm (train route + sweep route). */
let inFlight = false;

export interface TrainCooldownState {
  /** ms kể từ lần train/sweep gần nhất bắt đầu. */
  sinceLastMs: number;
  cooldownMs: number;
  /** null = đã qua cooldown; số = giây phải đợi (route 429 Retry-After). */
  retryAfterSeconds: number | null;
}

/** Đọc trạng thái cooldown HIỆN TẠI (thuần — không đổi state). */
export function trainCooldownState(now: number = Date.now()): TrainCooldownState {
  const sinceLast = now - lastTrainAt;
  return {
    sinceLastMs: sinceLast,
    cooldownMs: TRAIN_COOLDOWN_MS,
    retryAfterSeconds:
      sinceLast < TRAIN_COOLDOWN_MS ? Math.ceil((TRAIN_COOLDOWN_MS - sinceLast) / 1000) : null,
  };
}

/** Đánh dấu "vừa bắt đầu train/sweep" — đặt mốc cooldown. */
export function markTrainAttempt(now: number = Date.now()): void {
  lastTrainAt = now;
}

/** Cho phép retry ngay sau lỗi (giữ nguyên hành vi route cũ: lastTrainAt = 0). */
export function clearTrainCooldown(): void {
  lastTrainAt = 0;
}

/** Thu mutex in-flight — false = đang có train/sweep chạy (→ 429). */
export function tryAcquireTrainLock(): boolean {
  if (inFlight) return false;
  inFlight = true;
  return true;
}

/** Nhả mutex — caller BẮT BUỘC gọi ở mọi đường thoát (finally). */
export function releaseTrainLock(): void {
  inFlight = false;
}

/** Đang có train/sweep chạy? (GET/status hiển thị + route check sớm). */
export function isTrainInFlight(): boolean {
  return inFlight;
}

/* ─────────────────── Meta + metrics (đối tác hợp đồng route/sweep) ─────────────────── */

/**
 * Tỷ lệ TRAIN split theo thời gian — PHẢI khớp VAL_FRACTION=0.2 của nn.ts
 * fit (cut 80/20, val = block cuối): featureHist A3 tính trên ĐÚNG phần
 * 80% đầu mà mô hình đã học (không lẫn val block) — sweep tính Brier val
 * cũng dùng cùng cut này.
 */
export const TRAIN_FRACTION = 0.8;

/** Meta lưu MlModel.meta (JSON string) — TrainingWindowMeta P1-2 + featureHist
 *  A3 (#79) + featureSet B1 (#81). rl-q không có featureHist (chỉ dl-mlp). */
export interface MlModelMeta extends TrainingWindowMeta {
  /** A3 (#79) — histogram đặc trưng RAW của TRAIN split: edges[d] = 9 điểm cắt
   *  quantile 10%..90% tăng dần · train[d] = 10 tỷ lệ bucket (tổng = 1). */
  featureHist?: { edges: number[][]; train: number[][] };
  /** B1 (#81) — nhãn bộ đặc trưng của bản train ("v2-lag16"; bản cũ không có
   *  trường này → đọc về "v1-lag10"). */
  featureSet?: string;
  /** B2/B3 (#81) — verdict cổng bằng chứng gắn với bản lag-16 (ghi bởi
   *  scripts/ml-evidence-gate.ts). */
  gateVerdict?: "PASS" | "FAIL";
  /** B3 (#81) — độ dài cửa sổ chuỗi (chỉ kind dl-gru). */
  window?: number;
  /** #89 → #94 — cấu hình tinh chỉnh THẬT đã train bản này (AppSetting
   *  ml-tuning tại thời điểm train — truy vết mỗi bản dùng arch/hyper nào).
   *  #94: arch N-layer + activations từng lớp + lossWeights từng đầu ra. */
  tuning?: {
    arch: string;
    activations: string[];
    lossWeights: [number, number, number];
    lr: number;
    batchSize: number;
    maxEpochs: number;
    patience: number;
    l2: number;
    valFraction: number;
    seed: number;
  };
  /** C1 (#99 · ML_AUTOML_BLUEPRINT §2.10) — bản do sweep sinh: đợt nào. */
  sweepRunId?: string;
  /** C1 (#99) — vị trí ứng viên trong dãy deterministic của đợt. */
  sweepIndex?: number;
}

/** Metrics dl-mlp trả về FE — khớp DlMlpMetrics trong src/hooks/use-ml.ts. */
export interface TrainedDlMlpMetrics {
  epochs: number;
  samples: number;
  trainAcc: number;
  valAcc: number;
  trainLoss: number;
  valLoss: number;
  horizonDays: number;
  features: number;
  topSymbols: string[];
}

/** #89 → #94 — hyper + kiến trúc MLP THẬT SỰ áp dụng cho lần train này (từ
 *  AppSetting ml-tuning hoặc opts.tuning của sweep, fail-soft → mặc định). */
export interface AppliedMlpTuning {
  arch: string;
  activations: string[];
  lossWeights: [number, number, number];
  lr: number;
  batchSize: number;
  maxEpochs: number;
  patience: number;
  l2: number;
  valFraction: number;
  seed: number;
}

/* ─────────────────── FeatureHist A3 (trích nguyên bản từ route) ─────────────────── */

/** Quantile nội suy tuyến tính (type 7 — R default) trên mảng ĐÃ sort tăng dần. */
function quantileSorted(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const h = (n - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/** A3 (#79) — featureHist từ đặc trưng RAW của TRAIN split (80% đầu theo thời
 *  gian, cùng cut với nn.ts). Bucket j: (edges[j-1], edges[j]] — giá trị bằng
 *  điểm cắt rơi bucket dưới; bucket cuối (edges[8], +∞). Tỷ lệ tổng = 1 đúng. */
export function computeFeatureHist(X: number[][]): { edges: number[][]; train: number[][] } {
  const nTrain = Math.floor(X.length * TRAIN_FRACTION);
  const edges: number[][] = [];
  const train: number[][] = [];
  for (let d = 0; d < ML_FEATURE_COUNT; d++) {
    const vals: number[] = [];
    for (let i = 0; i < nTrain; i++) vals.push(X[i][d]);
    vals.sort((a, b) => a - b);
    const cuts: number[] = [];
    for (let k = 1; k <= 9; k++) cuts.push(quantileSorted(vals, k / 10));
    edges.push(cuts);
    const counts = new Array<number>(10).fill(0);
    for (const v of vals) {
      let bucket = 9;
      for (let k = 0; k < 9; k++) {
        if (v <= cuts[k]) {
          bucket = k;
          break;
        }
      }
      counts[bucket]++;
    }
    train.push(counts.map((c) => (nTrain > 0 ? c / nTrain : 0)));
  }
  return { edges, train };
}

/* ─────────────────── Versioning + lưu (trích nguyên bản từ route) ─────────────────── */

/** Version kế tiếp của một kind (max mọi status + 1). */
export async function nextVersion(kind: string): Promise<number> {
  const agg = await db.mlModel.aggregate({ _max: { version: true }, where: { kind } });
  return (agg._max.version ?? 0) + 1;
}

/** Lưu model mới: archive bản serving cũ + create version mới — MỘT
 *  $transaction (F-612R-06: archive xong create fail trước đây để kind
 *  KHÔNG còn bản serving nào — ensemble âm thầm xuống linreg).
 *  P1-2 (#60): meta = JSON TrainingWindowMeta (window-hash SHA-256 + biên
 *  ngày train) — null giữ cho model không có window (gọi trực tiếp).
 *  A4 (#79) opts.promote=false: bản mới lưu "archived", KHÔNG đụng bản
 *  serving hiện tại (serving-swap guard — where version:-1 không match gì).
 *  Mặc định promote=true = hành vi cũ (rl-q luôn đi đường này). */
export async function saveModel(
  kind: string,
  weights: string,
  featureNorm: string | null,
  metrics: Record<string, unknown>,
  meta: MlModelMeta | null = null,
  opts: { promote?: boolean } = {}
): Promise<number> {
  const promote = opts.promote !== false;
  const version = await nextVersion(kind);
  // F-612R-06 — array-form $transaction: [updateMany(BatchPayload), create(MlModel)]
  // — lấy phần tử THỨ HAI (model mới), phần tử đầu là số dòng archive.
  const [, created] = await db.$transaction([
    db.mlModel.updateMany({
      where: promote ? { kind, status: "serving" } : { kind, status: "serving", version: -1 },
      data: { status: "archived" },
    }),
    db.mlModel.create({
      data: {
        kind,
        version,
        status: promote ? "serving" : "archived",
        weights,
        featureNorm,
        metrics: JSON.stringify(metrics),
        ...(meta ? { meta: JSON.stringify(meta) } : {}),
      },
    }),
  ]);
  return created.version;
}

/* ─────────────────── Guards A4/B1 (trích nguyên bản từ route) ─────────────────── */

/** Kết quả guard hoán đổi serving (A4 #79) — trả ra response.
 *  B1 (#81): thêm reason — promoted=false giờ có 2 đường: valAcc thua
 *  baseline (A4) HOẶC khác featureSet khi cổng B2 chưa PASS (F-B811-01: toast
 *  phải nói đúng LÝ DO THẬT — hiển thị "39,5% < 39,4%" khi 39,5% ≥ 39,4% là
 *  nói sai sự thật). C1: null khi opts.promote=false (sweep bỏ guard). */
export interface DlMlpPromotion {
  promoted: boolean;
  /** valAcc bản serving TRƯỚC khi train (null = chưa có bản serving nào). */
  servingValAcc: number | null;
  newValAcc: number;
  /** Lý do promote/không promote: "first" = chưa có bản trước · "valacc" =
   *  thua baseline · "featureset-gate" = khác bộ đặc trưng, cổng B2 chưa
   *  mở. null khi promoted (lên serving bình thường). */
  reason: "first" | "valacc" | "featureset-gate" | null;
}

/** Verdict cổng B2 (AppSetting "ml-gate" — ghi bởi scripts/ml-evidence-gate.ts).
 *  null khi chưa đo / JSON hỏng — coi như CHƯA mở (mặc định an toàn §4 B2). */
export async function gateVerdictOf(): Promise<{ verdict: "PASS" | "FAIL" | null; measuredAt: string | null }> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: "ml-gate" } });
    if (!row) return { verdict: null, measuredAt: null };
    const parsed = JSON.parse(row.value) as { verdict?: unknown; measuredAt?: unknown };
    const verdict = parsed.verdict === "PASS" || parsed.verdict === "FAIL" ? parsed.verdict : null;
    return {
      verdict,
      measuredAt: typeof parsed.measuredAt === "string" ? parsed.measuredAt : null,
    };
  } catch {
    return { verdict: null, measuredAt: null };
  }
}

/** featureSet của bản meta JSON — bản train trước B1 không có trường →
 *  "v1-lag10" (10 chiều đầu giữ nguyên công thức — tương thích ngược). */
export function featureSetOf(meta: string | null): string {
  if (!meta) return ML_FEATURE_SET_V1;
  try {
    const m = JSON.parse(meta) as { featureSet?: unknown };
    return typeof m.featureSet === "string" ? m.featureSet : ML_FEATURE_SET_V1;
  } catch {
    return ML_FEATURE_SET_V1;
  }
}

/** Đọc windowHash bản serving + bản MỚI NHẤT (max version, mọi status) của
 *  một kind (meta JSON từ DB). A4 (#79) skip-guard khớp CẢ HAI: (1) bản
 *  serving — spec A4.2 "không có bar mới so bản đang phục vụ"; (2) bản vừa
 *  train gần nhất — nghiệm thu #79: lần gọi thứ hai phải skip KỂ CẢ khi bản
 *  vừa train không được promote (retrain cùng cửa sổ là deterministic — cùng
 *  seed ra cùng kết quả, chỉ phí CPU + dồn version trùng windowHash).
 *  B1 (#81): trả thêm featureSet — skip-guard chỉ khớp khi hash BẰNG VÀ
 *  featureSet BẰNG bộ hiện hành (hash không đổi khi đổi đặc trưng — retrain
 *  lag-16 trên cùng bar với bản lag-16 mới nhất là vô nghĩa, nhưng train
 *  lag-16 lần đầu khi latest còn là lag-10 là CẦN THIẾT cho cổng B2).
 *  null khi chưa có bản / meta hỏng / thiếu hash (model train trước P1-2). */
export async function recentWindowHashesOf(
  kind: string
): Promise<{ serving: string | null; latest: string | null; latestFeatureSet: string }> {
  const read = (meta: string | null): string | null => {
    if (!meta) return null;
    try {
      const m = JSON.parse(meta) as { windowHash?: unknown };
      return typeof m.windowHash === "string" ? m.windowHash : null;
    } catch {
      return null;
    }
  };
  const [serving, latest] = await Promise.all([
    db.mlModel.findFirst({
      where: { kind, status: "serving" },
      orderBy: { version: "desc" },
      select: { meta: true },
    }),
    db.mlModel.findFirst({
      where: { kind },
      orderBy: { version: "desc" },
      select: { meta: true },
    }),
  ]);
  return {
    serving: read(serving?.meta ?? null),
    latest: read(latest?.meta ?? null),
    latestFeatureSet: featureSetOf(latest?.meta ?? null),
  };
}

/* ─────────────────── trainDlMlp (F2 — extracted, + opts cho sweep) ─────────────────── */

/** Tuỳ chọn sweep (C1) — xem header file. */
export interface TrainDlMlpOpts {
  /** Cấu hình THAY readEffectiveMlTuning() — sweep truyền từng ứng viên. */
  tuning?: MlpTuning;
  /** Mặc định true (đường cũ); false = luôn archived + bỏ serving-swap guard. */
  promote?: boolean;
  /** Shallow-merge vào meta JSON bản lưu (sweepRunId + sweepIndex). */
  extraMeta?: Record<string, unknown>;
}

export interface TrainDlMlpResult {
  metrics: TrainedDlMlpMetrics;
  /** null khi opts.promote=false (sweep tự gated swap). */
  promotion: DlMlpPromotion | null;
  appliedTuning: AppliedMlpTuning;
  /** Version bản MlModel vừa tạo (C1 — sweep truy vết + swap). */
  modelVersion: number;
  /** Mạng vừa train (predictProba sẵn sàng — sweep tính Brier val block). */
  model: MLP;
}

/** Hoà giải activations + lossWeights của opts.tuning (phòng thủ ghi tay):
 *  cùng logic reconcile của tuning.ts — pad relu/cắt theo hidden. */
function normalizeCandidateTuning(tuning: MlpTuning): {
  hidden: number[];
  activations: MlpActivation[];
  lossWeights: [number, number, number];
} {
  const acts: MlpActivation[] = [];
  const src = tuning.activations ?? [];
  for (let i = 0; i < tuning.hidden.length; i++) {
    const v = src[i];
    acts.push(v === "tanh" || v === "sigmoid" || v === "relu" ? v : "relu");
  }
  const lw = [1, 1, 1].map((d, i) => tuning.lossWeights?.[i] ?? d) as [number, number, number];
  return { hidden: tuning.hidden, activations: acts, lossWeights: lw };
}

/**
 * Train MLP v2-lag16 (16 → hidden[] N-layer, tham số hoá #89 + kiến trúc
 * N-layer #94) trên top-20 thanh khoản:
 * buildTrainingSet → z-score → fit (Adam, early-stop) → topSymbols theo độ
 * tách pUp−pDown của mô hình trên từng mã → lưu MlModel kind dl-mlp (meta
 * ghi featureSet "v2-lag16" + tuning #89).
 * A3 (#79): meta thêm featureHist (đặc trưng RAW TRAIN split — hợp đồng với
 * PSI). A4 (#79) + B1 (#81) serving-swap guard: valAcc ≥ bản serving VÀ
 * (cùng featureSet HOẶC cổng B2 PASS). `prebuilt` = tập đã build từ
 * skip-guard (F-611-01: digest hash CHÍNH chuỗi đã train — không nạp lại).
 * C1 (#99): opts.tuning = cấu hình ứng viên sweep (thay AppSetting);
 * opts.promote=false → luôn archived + promotion:null (sweep gated-swap sau);
 * opts.extraMeta → shallow-merge meta (sweepRunId + sweepIndex).
 */
export async function trainDlMlp(
  prebuilt?: TrainingSetWithSeries,
  opts?: TrainDlMlpOpts
): Promise<TrainDlMlpResult> {
  const set = prebuilt ?? (await buildTrainingSet(20));
  if (set.X.length < 600) {
    throw new Error(`chỉ có ${set.X.length} mẫu huấn luyện (cần ≥ 600) — kiểm tra dữ liệu EOD`);
  }
  if (set.X.length > 0 && set.X[0].length !== ML_FEATURE_COUNT) {
    throw new Error(
      `tập train ${set.X[0].length} chiều ≠ ML_FEATURE_COUNT ${ML_FEATURE_COUNT} (featureSet lệch)`
    );
  }
  // P1-2 — digest cửa sổ train TRÊN CHÍNH chuỗi dữ liệu vừa dùng (tái lập PIT).
  // F-611-01/#61: buildTrainingSet giờ TRẢ KÈM series nó đã nạp — digest hash
  // trên chuỗi ĐÓ (trước đây loadTopSeries LẦN THỨ HAI độc lập: bar đổi giữa 2
  // lượt nạp → window-hash mô tả sai cửa sổ đã train — phá đúng cái PIT P1-2
  // xây ra). B1 (#81): hash trên bar — KHÔNG đổi khi đổi bộ đặc trưng.
  const windowMeta = trainingWindowDigest(set.series, { samples: set.X.length });
  // A3 (#79) — histogram đặc trưng RAW của TRAIN split (đồng bộ meta PSI)
  const featureHist = computeFeatureHist(set.X);
  const { mean, std, Xstd } = standardize(set.X);
  // #89 → #94 — arch + activations + hyper từ AppSetting ml-tuning (fail-soft:
  // không có key → đúng MLP_ARCH_V2 16-24-12-3 relu×2 + lr 0,01/batch 32/60
  // epoch/patience 12/lossWeights [1,1,1]/l2 0/val 0,2/seed 42 — hành vi
  // trước #94 giữ nguyên từng số). C1 (#99): sweep ghi đè bằng opts.tuning
  // (từng ứng viên) — meta vẫn ghi đúng cấu hình ĐÃ DÙNG. Chiều in LUÔN =
  // ML_FEATURE_COUNT (tuyến đặc trưng cố định).
  const effectiveMlp = opts?.tuning ?? (await readEffectiveMlTuning()).mlp;
  const candidate = normalizeCandidateTuning(effectiveMlp);
  const arch: MlpArch = {
    in: ML_FEATURE_COUNT,
    hidden: candidate.hidden,
    out: 3,
  };
  const appliedTuning: AppliedMlpTuning = {
    arch: mlpArchString(arch),
    activations: candidate.activations,
    lossWeights: candidate.lossWeights,
    lr: effectiveMlp.lr,
    batchSize: effectiveMlp.batchSize,
    maxEpochs: effectiveMlp.epochs,
    patience: effectiveMlp.patience,
    l2: effectiveMlp.l2,
    valFraction: effectiveMlp.valFraction,
    seed: effectiveMlp.seed,
  };
  // F-MLP-05 (fixbug FB-4B): truyền seed vào constructor để seed điều khiển
  // CẢ khởi tạo trọng số lẫn shuffle (đúng hint "Khởi tạo + xáo trộn
  // deterministic"). Mặc định 42 = RNG_SEED constructor → hành vi cũ giữ
  // nguyên tuyệt đối khi trader chưa đổi seed.
  const mlp = new MLP(arch, candidate.activations, effectiveMlp.seed);
  const fit = mlp.fit(Xstd, set.y, {
    learningRate: effectiveMlp.lr,
    batchSize: effectiveMlp.batchSize,
    maxEpochs: effectiveMlp.epochs,
    patience: effectiveMlp.patience,
    lossWeights: candidate.lossWeights,
    l2: effectiveMlp.l2,
    valFraction: effectiveMlp.valFraction,
    seed: effectiveMlp.seed,
  });
  mlp.setNorm({ mean, std });

  // topSymbols: mã nào dự báo tách bạch nhất (mean |pUp − pDown| trên mẫu của mã)
  const preds = mlp.predictBatch(set.X);
  const bySymbol = new Map<string, { sum: number; n: number }>();
  set.symbols.forEach((sym, i) => {
    const agg = bySymbol.get(sym) ?? { sum: 0, n: 0 };
    agg.sum += Math.abs(preds[i][0] - preds[i][2]);
    agg.n++;
    bySymbol.set(sym, agg);
  });
  const topSymbols = [...bySymbol.entries()]
    .map(([symbol, a]) => ({ symbol, sep: a.sum / a.n }))
    .sort((a, b) => b.sep - a.sep)
    .slice(0, 8)
    .map((r) => r.symbol);

  const metrics: TrainedDlMlpMetrics = {
    epochs: fit.epochs,
    samples: fit.samples,
    trainAcc: fit.trainAcc,
    valAcc: fit.valAcc,
    trainLoss: fit.trainLoss,
    valLoss: fit.valLoss,
    horizonDays: ML_HORIZON_DAYS,
    features: ML_FEATURE_COUNT,
    topSymbols,
  };

  // C1 (#99) — đường sweep (promote=false): lưu archived, KHÔNG đọc serving
  // swap guard (tiết kiệm 1 query/ứng viên; sweep tự so cả 4 điều kiện §4.4
  // trên chính val block — cạnh tranh công bằng từng mẫu).
  if (opts?.promote === false) {
    const modelVersion = await saveModel(
      "dl-mlp",
      mlp.toJSON(),
      JSON.stringify({ mean, std }),
      { ...metrics },
      {
        ...windowMeta,
        featureHist,
        featureSet: ML_FEATURE_SET,
        tuning: appliedTuning,
        ...(opts.extraMeta ?? {}),
      },
      { promote: false }
    );
    return { metrics, promotion: null, appliedTuning, modelVersion, model: mlp };
  }

  // A4 (#79) serving-swap guard: đọc valAcc bản serving HIỆN TẠI (trước khi
  // saveModel thay đổi status) — mới ≥ cũ (hoặc chưa có bản nào) → promote
  // như cũ; mới < cũ → lưu "archived", bản cũ giữ serving (§1.5: mô hình dưới
  // ngưỡng không lên serving).
  // B1 (#81): bản mới khác featureSet bản serving (lag16 vs lag10) chỉ lên
  // serving khi CỔNG B2 PASS — "serving vẫn là v8 cho tới khi cổng B2 xử
  // quyết" (scripts/ml-evidence-gate.ts swap trực tiếp khi ΔBrier có ý nghĩa).
  const servingRow = await db.mlModel.findFirst({
    where: { kind: "dl-mlp", status: "serving" },
    orderBy: { version: "desc" },
    select: { metrics: true, meta: true },
  });
  let servingValAcc: number | null = null;
  if (servingRow?.metrics) {
    try {
      const m = JSON.parse(servingRow.metrics) as { valAcc?: unknown };
      if (typeof m.valAcc === "number" && Number.isFinite(m.valAcc)) servingValAcc = m.valAcc;
    } catch {
      // metrics hỏng → coi như chưa có mốc so
    }
  }
  const servingFeatureSet = featureSetOf(servingRow?.meta ?? null);
  const gate = await gateVerdictOf();
  // AUD-97-F1 (#99 · ML_AUTOML_BLUEPRINT §3-C0 bước c): chưa có bản serving
  // nào → ràng buộc featureSet KHÔNG áp. Trước đây sameSet luôn false ở DB sạch
  // (featureSetOf(null) = "v1-lag10" ≠ "v2-lag16") + gate chưa đo → promoted
  // vĩnh viễn false, mâu thuẫn doc comment "Không có bản serving trước đó →
  // promote" của route. 1 nhánh — bản ĐẦU TIÊN luôn lên serving.
  const sameSet = servingRow == null || servingFeatureSet === ML_FEATURE_SET;
  const beatsValAcc = servingValAcc == null || fit.valAcc >= servingValAcc;
  const promoted = beatsValAcc && (sameSet || gate.verdict === "PASS");
  // F-B811-01 (#81 Fixbug-B) — lý do THẬT cho toast/FE (không đoán từ số):
  const reason: DlMlpPromotion["reason"] = promoted
    ? null
    : servingValAcc == null
      ? "first"
      : !beatsValAcc
        ? "valacc"
        : "featureset-gate";
  const modelVersion = await saveModel(
    "dl-mlp",
    mlp.toJSON(),
    JSON.stringify({ mean, std }),
    { ...metrics },
    { ...windowMeta, featureHist, featureSet: ML_FEATURE_SET, tuning: appliedTuning },
    { promote: promoted }
  );
  return {
    metrics,
    promotion: { promoted, servingValAcc, newValAcc: fit.valAcc, reason },
    appliedTuning,
    modelVersion,
    model: mlp,
  };
}
