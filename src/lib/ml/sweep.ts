/**
 * src/lib/ml/sweep.ts — C1 (#99 · ML_AUTOML_BLUEPRINT §4) — L1 DETERMINISTIC
 * SWEEP CONTROLLER ("NAS-Lite" có kỷ luật).
 *
 * MỘT controller chạy đợt (sweep run) chọn N ứng viên kiến trúc+hyper từ
 * không gian editor #94 theo DÃY DETERMINISTIC CÓ SEED (nguyên tắc §2.9:
 * cùng seed + cùng windowHash → cùng danh sách ứng viên, cùng thứ tự, cùng
 * kết quả — không Math.random, không Date.now trong sinh ứng viên), train
 * tuần tự từng ứng viên qua đúng đường trainDlMlp (F2 — cùng mutex/đánh
 * version với train route), chấm score công khai, và CHỈ đề xuất champion
 * cho serving-swap khi qua CỔNG 4 ĐIỀU KIỆN (§4.4):
 *   (1) valAcc_champ ≥ valAcc_serving + δ (serving null → baseline 1/3);
 *   (2) ΔBrier paired bootstrap CI95 hoàn toàn < 0 (serving null → baseline
 *       uniform 0,667 — F4);
 *   (3) paramCount_champ ≤ max(maxParamFactor × paramCount_serving,
 *       ⌊nTrain / MIN_SAMPLES_PER_PARAM⌋) — cap hiệu chỉnh theo MẨU DỮ LIỆU
 *       (F-19 #133): dữ liệu lớn đủ chứng minh cho mô hình lớn; dữ liệu nhỏ
 *       vẫn bị kẹp bởi cap hệ số (serving null → cap maxParamFactor ×
 *       paramWarnThreshold — F4);
 *   (4) skip-guard windowHash như A4 — áp LUÔN cho mọi đợt (F8, xử TRƯỚC
 *       khi tạo hàng SweepRun — không có bar mới = không có gì mới để tìm).
 *   AUDIT 137 B4: điều kiện 1+2 đo trên HOLDOUT WALK-FORWARD — block mẫu
 *       cuối SAU val early-stop, KHÔNG tham gia chọn champion — hết “chọn
 *       theo val rồi báo lại chính val đó” (winner's curse) và hết so chéo
 *       cửa sổ train cũ của serving.
 *
 * KHÔNG PHẢI (§4.1): RL controller · train song song vô hạn · tự đổi serving
 * ngoài cổng · thêm dependency. Champion board công khai toàn bộ (§2.10):
 * mọi ứng viên (kể cả thua) lưu hàng MlModel meta sweepRunId/sweepIndex +
 * logJson đầy đủ trên SweepRun.
 *
 * AppSetting "ml-sweep": {enabled, budgetCandidates, seed, deltaSwap,
 * maxParamFactor, lastRunAt} — kill-switch từng đợt (§1.6) cho đường ENGINE
 * (nút "Chạy đợt ngay" POST vẫn chạy bất kể enabled — deterministic không
 * thể "câu" kết quả, mọi champion vẫn phải qua cổng).
 */

import { db } from "@/lib/db";
import {
  buildTrainingSet,
  trainingWindowDigest,
  ML_FEATURE_SET,
  type TrainingSetWithSeries,
} from "@/lib/ml/features";
import { MLP, type MlpActivation } from "@/lib/ml/nn";
import {
  MLP_ARCH_LIMITS,
  MLP_TUNING_DEFAULT,
  MLP_TUNING_FIELDS,
  readEffectiveMlTuning,
  readMlTuning,
  writeMlTuning,
  parseMlTuningValue,
  type MlTuning,
  type MlpTuning,
} from "@/lib/ml/tuning";
import {
  markTrainAttempt,
  releaseTrainLock,
  trainDlMlp,
  TRAIN_FRACTION,
  tryAcquireTrainLock,
} from "@/lib/ml/train-mlp";

/* ─────────────────── Cấu hình (AppSetting "ml-sweep" — fail-soft) ─────────────────── */

export const SWEEP_SETTING_KEY = "ml-sweep";

export interface SweepConfig {
  /** Kill-switch đường ENGINE (§1.6) — nút tay vẫn chạy. */
  enabled: boolean;
  /** F-18 (#131): champion qua cổng 4 điều kiện & swap serving → TỰ ĐỒNG GHI
   *  kiến trúc + hyper của champion xuống AppSetting ml-tuning (tab Mạng
   *  thần kinh phản ánh ngay; lần train kế tiếp dùng đúng cấu hình).
   *  Kill-switch tắt → chỉ swap serving weights, giữ thiết lập trader. */
  autoPromoteTuning: boolean;
  /** Số ứng viên/đợt (coarse 12 trước, refine 4 sau) — clamp 1..64. */
  budgetCandidates: number;
  /** Seed dãy ứng viên — deterministic (hiện dãy cố định, seed lưu cho mở rộng). */
  seed: number;
  /** δ swap điều kiện 1 (điểm valAcc champion phải vượt serving). */
  deltaSwap: number;
  /** Hệ số cap tham số điều kiện 3 (chống "thắng vì to" khi dữ liệu nhỏ —
   *  F-19 #133: cap thực = max(hệ số này × serving, nTrain ÷ 15)). */
  maxParamFactor: number;
  /** Mốc đợt sweep gần nhất chạy xong (ISO) — hiển thị UI. */
  lastRunAt: string | null;
  updatedAt?: string;
}

export const SWEEP_CONFIG_DEFAULT: SweepConfig = {
  enabled: true,
  autoPromoteTuning: true,
  budgetCandidates: 16,
  seed: 20261012,
  deltaSwap: 0.01,
  maxParamFactor: 2,
  lastRunAt: null,
};

/** Phạm vi hợp lệ các trường số (FE hiển thị hint + route validate 422). */
export const SWEEP_FIELD_RANGES = {
  budgetCandidates: { min: 1, max: 64, integer: true },
  seed: { min: 0, max: 999_999_999, integer: true },
  deltaSwap: { min: 0, max: 0.1, integer: false },
  maxParamFactor: { min: 1, max: 10, integer: false },
} as const;

function clampSweepInt(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(v)));
}

function clampSweepNum(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Đọc AppSetting ml-sweep — fail-soft tuyệt đối (key thiếu/JSON hỏng/DB lỗi
 *  → mặc định code); trường ngoài phạm vi → kẹp phòng thủ (ghi tay DB). */
export async function readSweepConfig(): Promise<SweepConfig> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: SWEEP_SETTING_KEY } });
    if (!row) {
      // F-00 (#129 — mục 4 "khởi tạo setting"): lần chạy đầu tự upsert
      // AppSetting ml-sweep (enabled) — UI tuning tab + kill-switch engine
      // hiển thị TRẠNG THÁI THẬT thay vì default ngầm. Idempotent (upsert).
      await db.appSetting
        .upsert({
          where: { key: SWEEP_SETTING_KEY },
          create: {
            key: SWEEP_SETTING_KEY,
            value: JSON.stringify({ ...SWEEP_CONFIG_DEFAULT, updatedAt: new Date().toISOString() }),
          },
          update: {},
        })
        .catch(() => undefined);
      return { ...SWEEP_CONFIG_DEFAULT };
    }
    const parsed = JSON.parse(row.value) as Partial<SweepConfig>;
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : SWEEP_CONFIG_DEFAULT.enabled,
      autoPromoteTuning:
        typeof parsed.autoPromoteTuning === "boolean"
          ? parsed.autoPromoteTuning
          : SWEEP_CONFIG_DEFAULT.autoPromoteTuning,
      budgetCandidates:
        typeof parsed.budgetCandidates === "number" && Number.isFinite(parsed.budgetCandidates)
          ? clampSweepInt(parsed.budgetCandidates, 1, 64)
          : SWEEP_CONFIG_DEFAULT.budgetCandidates,
      seed:
        typeof parsed.seed === "number" && Number.isFinite(parsed.seed)
          ? clampSweepInt(parsed.seed, 0, 999_999_999)
          : SWEEP_CONFIG_DEFAULT.seed,
      deltaSwap:
        typeof parsed.deltaSwap === "number" && Number.isFinite(parsed.deltaSwap)
          ? clampSweepNum(parsed.deltaSwap, 0, 0.1)
          : SWEEP_CONFIG_DEFAULT.deltaSwap,
      maxParamFactor:
        typeof parsed.maxParamFactor === "number" && Number.isFinite(parsed.maxParamFactor)
          ? clampSweepNum(parsed.maxParamFactor, 1, 10)
          : SWEEP_CONFIG_DEFAULT.maxParamFactor,
      lastRunAt: typeof parsed.lastRunAt === "string" ? parsed.lastRunAt : null,
      ...(typeof parsed.updatedAt === "string" ? { updatedAt: parsed.updatedAt } : {}),
    };
  } catch (err) {
    console.error("[ml/sweep] readSweepConfig lỗi (fail-soft → mặc định):", err);
    return { ...SWEEP_CONFIG_DEFAULT };
  }
}

/** Ghi AppSetting ml-sweep (upsert kèm updatedAt trong JSON) — false = lỗi DB.
 *  Route config-update và runner (lastRunAt) đều qua đây — một cửa. */
export async function writeSweepConfig(config: SweepConfig): Promise<boolean> {
  try {
    const value = JSON.stringify({ ...config, updatedAt: new Date().toISOString() });
    await db.appSetting.upsert({
      where: { key: SWEEP_SETTING_KEY },
      create: { key: SWEEP_SETTING_KEY, value },
      update: { value },
    });
    return true;
  } catch (err) {
    console.error("[ml/sweep] writeSweepConfig lỗi:", err);
    return false;
  }
}

/** Kết quả validate payload config từ FE (giữ trường hợp lệ + lỗi 422). */
export interface SweepConfigSanitizeResult {
  config?: Partial<SweepConfig>;
  errors: string[];
}

/** Validate body {action:"config", config:{…}} — chỉ trường ĐƯỢC CUNG CẤP
 *  mới được kiểm (semantic partial như sanitizeTuningInput); sai phạm vi →
 *  lỗi 422 (không kẹp im lặng — trader phải biết giá trị bị từ chối). */
export function sanitizeSweepConfigInput(input: unknown): SweepConfigSanitizeResult {
  const errors: string[] = [];
  const out: SweepConfigSanitizeResult = { errors };
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    errors.push("config: phải là object {trường: giá trị}");
    return out;
  }
  const raw = input as Record<string, unknown>;
  const clean: Partial<SweepConfig> = {};
  for (const key of ["budgetCandidates", "seed", "deltaSwap", "maxParamFactor"] as const) {
    if (!(key in raw)) continue;
    const v = raw[key];
    const range = SWEEP_FIELD_RANGES[key];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      errors.push(`config.${key}: phải là số`);
      continue;
    }
    if (range.integer && !Number.isInteger(v)) {
      errors.push(`config.${key}: phải là số nguyên`);
      continue;
    }
    if (v < range.min || v > range.max) {
      errors.push(`config.${key}: ngoài phạm vi [${range.min} – ${range.max}]`);
      continue;
    }
    (clean as Record<string, number>)[key] = v;
  }
  if ("enabled" in raw) {
    if (typeof raw.enabled !== "boolean") {
      errors.push("config.enabled: phải là boolean (true | false)");
    } else {
      clean.enabled = raw.enabled;
    }
  }
  // F-18 (#131): kill-switch đồng bộ champion → ml-tuning (boolean).
  if ("autoPromoteTuning" in raw) {
    if (typeof raw.autoPromoteTuning !== "boolean") {
      errors.push("config.autoPromoteTuning: phải là boolean (true | false)");
    } else {
      clean.autoPromoteTuning = raw.autoPromoteTuning;
    }
  }
  for (const key of Object.keys(raw)) {
    if (
      ![
        "enabled",
        "autoPromoteTuning",
        "budgetCandidates",
        "seed",
        "deltaSwap",
        "maxParamFactor",
      ].includes(key)
    ) {
      errors.push(`config.${key}: khoá không hỗ trợ`);
    }
  }
  if (Object.keys(clean).length > 0) out.config = clean;
  return out;
}

/* ─────────────────── Sinh ứng viên deterministic (§4.2) ─────────────────── */

/** Pha của ứng viên trong dãy cố định. */
export type SweepPhase = "coarse" | "refine";

/** Hyper từng ứng viên — mặc định MLP_TUNING_DEFAULT trừ seed = sweepSeed.
 *  F-01 (#129): featureSet của ứng viên ("v2-lag16" | "v3-macro") — quyết
 *  định chiều vào arch (16/24) và tập train tương ứng. */
export interface SweepHyper {
  epochs: number;
  patience: number;
  batchSize: number;
  lr: number;
  l2: number;
  valFraction: number;
  seed: number;
  featureSet: string;
}

/** Một ứng viên sweep — thuần dữ liệu, deterministic từ (budget, weights, seed). */
export interface SweepCandidate {
  /** Vị trí trong dãy cố định (0-based) — thứ tự không đổi giữa các đợt. */
  index: number;
  phase: SweepPhase;
  /** Nhãn hiển thị champion board: C1..C12 (coarse) · R1..R4 (refine). */
  tag: string;
  hidden: number[];
  activations: MlpActivation[];
  lossWeights: [number, number, number];
  hyper: SweepHyper;
}

/** Lưới hạt nhân coarse (§4.2) — 6 topo tiêu biểu. */
const COARSE_KERNELS: readonly number[][] = [
  [24, 12],
  [32, 16],
  [48, 24, 12],
  [16],
  [64, 32, 16, 8],
  [12, 8],
];

/** Chuỗi arch canonical "in-hidden…-out" từ hidden — F-01 (#129): in do
 *  featureSet quyết định (v2-lag16 = 16 · v3-macro = 24). */
function archStringOf(hidden: readonly number[], inDims = 16): string {
  return `${inDims}-${hidden.join("-")}-3`;
}

/** lr phạm vi hợp lệ (một nguồn — MLP_TUNING_FIELDS #94). */
const LR_SPEC = MLP_TUNING_FIELDS.find((f) => f.key === "lr");
const LR_MIN = LR_SPEC?.min ?? 0.0005;
const LR_MAX = LR_SPEC?.max ?? 0.1;

/** Kẹp lossWeights vào [0,1 · 10] (phòng thủ giá trị truyền vào). */
function clampLossWeights(w: readonly [number, number, number]): [number, number, number] {
  return w.map((v) =>
    clampSweepNum(v, MLP_ARCH_LIMITS.lossWeightMin, MLP_ARCH_LIMITS.lossWeightMax)
  ) as [number, number, number];
}

/** Hyper mặc định của đợt — MLP_TUNING_DEFAULT nhưng seed = sweepSeed (§4.2:
 *  seed sweep riêng, mọi ứng viên cùng seed → cùng điều kiện so sánh).
 *  F-01 (#129): featureSet mặc định v2-lag16 (tương thích dãy cũ). */
function sweepHyperDefaults(sweepSeed: number, featureSet: string): SweepHyper {
  return {
    epochs: MLP_TUNING_DEFAULT.epochs,
    patience: MLP_TUNING_DEFAULT.patience,
    batchSize: MLP_TUNING_DEFAULT.batchSize,
    lr: MLP_TUNING_DEFAULT.lr,
    l2: MLP_TUNING_DEFAULT.l2,
    valFraction: MLP_TUNING_DEFAULT.valFraction,
    seed: sweepSeed,
    featureSet,
  };
}

/**
 * 12 ứng viên coarse (§4.2): 6 hạt nhân arch × 2 biến thể activation —
 * A = relu toàn bộ · B = relu trừ LỚP ẨN CUỐI = tanh. lossWeights = bản
 * trader đang đặt trong AppSetting ml-tuning ("ý người" giữ ở coarse —
 * Q3 §9). Hyper = mặc định #94 trừ seed = sweepSeed. KHÔNG Math.random,
 * KHÔNG Date.now — cùng đầu vào → cùng danh sách từng ứng viên.
 * F-01 (#129): featureSet quyết định chiều vào arch (16/24).
 */
export function buildCoarseCandidates(
  traderLossWeights: readonly [number, number, number],
  sweepSeed: number,
  featureSet: string = ML_FEATURE_SET
): SweepCandidate[] {
  const lw = clampLossWeights(traderLossWeights);
  const hyper = sweepHyperDefaults(sweepSeed, featureSet);
  const out: SweepCandidate[] = [];
  let index = 0;
  for (const kernel of COARSE_KERNELS) {
    for (const variant of ["A", "B"] as const) {
      const activations: MlpActivation[] = kernel.map((_, i) =>
        variant === "B" && i === kernel.length - 1 ? "tanh" : "relu"
      );
      index += 1;
      out.push({
        index: index - 1,
        phase: "coarse",
        tag: `C${index}`,
        hidden: [...kernel],
        activations,
        lossWeights: [...lw] as [number, number, number],
        hyper: { ...hyper },
      });
    }
  }
  return out;
}

/**
 * 4 ứng viên refine (§4.2/Q3) quanh top-2 coarse:
 *   R1 = top1, lớp cuối ±8 nơ-rôn (+8 trừ khi vượt 96 → −8; clamp 2..96);
 *   R2 = top2, THÊM 1 lớp 8 nơ-rôn (relu) nếu <5 lớp, ngược lại BỚT lớp cuối
 *        (nếu >1 lớp) — giữ activation tương ứng từng lớp còn lại;
 *   R3 = top1, lossWeights preset UP-heavy [1, 1, 2,5] (Q3 §9);
 *   R4 = top1, lr × 0,5 (nếu kết quả < 0,0005 thì × 2 — clamp phạm vi lr).
 * Thuần deterministic từ (top1, top2, weights, seed).
 */
export function deriveRefineCandidates(
  top1: SweepCandidate,
  top2: SweepCandidate,
  traderLossWeights: readonly [number, number, number],
  sweepSeed: number,
  startIndex = 12
): SweepCandidate[] {
  const lw = clampLossWeights(traderLossWeights);
  const upHeavy = clampLossWeights([1, 1, 2.5]);

  // R1 — top1 ±8 nơ-rôn lớp cuối (chọn +8 trừ khi vượt trần 96).
  const r1Hidden = [...top1.hidden];
  const last = r1Hidden[r1Hidden.length - 1] ?? 12;
  let next = last + 8;
  if (next > MLP_ARCH_LIMITS.maxNeurons) next = last - 8;
  r1Hidden[r1Hidden.length - 1] = clampSweepInt(
    next,
    MLP_ARCH_LIMITS.minNeurons,
    MLP_ARCH_LIMITS.maxNeurons
  );

  // R2 — top2 mở/rút 1 lớp (relu cho lớp mới appended).
  let r2Hidden: number[];
  let r2Acts: MlpActivation[];
  if (top2.hidden.length < MLP_ARCH_LIMITS.maxLayers) {
    r2Hidden = [...top2.hidden, 8];
    r2Acts = [...top2.activations, "relu"];
  } else if (top2.hidden.length > 1) {
    r2Hidden = top2.hidden.slice(0, -1);
    r2Acts = top2.activations.slice(0, -1);
  } else {
    r2Hidden = [...top2.hidden];
    r2Acts = [...top2.activations];
  }

  // R4 — top1 lr × 0,5 (fallback × 2 khi < LR_MIN), clamp phạm vi.
  let r4Lr = top1.hyper.lr * 0.5;
  if (r4Lr < LR_MIN) r4Lr = top1.hyper.lr * 2;
  r4Lr = clampSweepNum(r4Lr, LR_MIN, LR_MAX);

  return [
    {
      index: startIndex,
      phase: "refine",
      tag: "R1",
      hidden: r1Hidden,
      activations: [...top1.activations],
      lossWeights: [...lw] as [number, number, number],
      hyper: { ...top1.hyper },
    },
    {
      index: startIndex + 1,
      phase: "refine",
      tag: "R2",
      hidden: r2Hidden,
      activations: r2Acts,
      lossWeights: [...lw] as [number, number, number],
      hyper: { ...top2.hyper },
    },
    {
      index: startIndex + 2,
      phase: "refine",
      tag: "R3",
      hidden: [...top1.hidden],
      activations: [...top1.activations],
      lossWeights: upHeavy,
      hyper: { ...top1.hyper },
    },
    {
      index: startIndex + 3,
      phase: "refine",
      tag: "R4",
      hidden: [...top1.hidden],
      activations: [...top1.activations],
      lossWeights: [...lw] as [number, number, number],
      hyper: { ...top1.hyper, lr: r4Lr },
    },
  ];
}

/**
 * Dãy ứng viên đầy đủ theo budget (§4.2): budget ≤ 12 → chỉ coarse đầu;
 * budget > 12 → coarse 12 + refine từ top-2 (điểm coarse THẬT do runner
 * truyền qua coarseScores theo index; không truyền → mọi score 0 → ties →
 * lower index → C1/C1... chuẩn C1/C2 làm top-2 — deterministic cho
 * preview/verify). Thứ tự CỐ ĐỊNH: coarse trước, refine sau. Budget > 16
 * vẫn chỉ có 16 ứng viên trong dãy (không gian §4.2 = 12 + 4) — budget ghi
 * nguyên trong SweepRun.candidates để trung thực "đã xin".
 */
export function buildSweepCandidates(
  budget: number,
  traderLossWeights: readonly [number, number, number],
  sweepSeed: number,
  coarseScores?: readonly (number | undefined)[]
): SweepCandidate[] {
  const b = clampSweepInt(budget, 1, 64);
  const coarse = buildCoarseCandidates(traderLossWeights, sweepSeed);
  if (b <= coarse.length) return coarse.slice(0, b);
  const ranked = coarse
    .map((c, i) => ({ c, score: coarseScores?.[i] ?? 0 }))
    .sort((a, b2) => b2.score - a.score || a.c.index - b2.c.index);
  const top1 = ranked[0]?.c ?? coarse[0]!;
  const top2 = ranked[1]?.c ?? top1;
  const refine = deriveRefineCandidates(top1, top2, traderLossWeights, sweepSeed, coarse.length);
  return [...coarse, ...refine].slice(0, b);
}

/* ─────────────────── Evaluator thuần (§4.3 — hermetic cho verify) ─────────────────── */

/**
 * score = valAcc − 0,0002 × max(0, paramCount − paramWarnThreshold)/100
 *         + 0,01 × I[servingBrier != null && brier ≤ servingBrier]
 * (F5 — mốc 5.000 = MLP_ARCH_LIMITS.paramWarnThreshold, một nguồn; F6 —
 * Brier tự tính trên val block, so Brier serving trên CÙNG block).
 */
export function computeScore(params: {
  valAcc: number;
  paramCount: number;
  brier: number;
  servingBrier: number | null;
}): number {
  const penalty =
    (0.0002 * Math.max(0, params.paramCount - MLP_ARCH_LIMITS.paramWarnThreshold)) / 100;
  const brierBonus =
    params.servingBrier != null && params.brier <= params.servingBrier ? 0.01 : 0;
  return params.valAcc - penalty + brierBonus;
}

/** Brier baseline khi DB sạch (F4 §4.4-2): uniform p=1/3 → ≈ 2/3. */
export const UNIFORM_BRIER_BASELINE = 0.667;

/** RNG mulberry32 — giống nn.ts/gate script (deterministic). */
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

/**
 * ΔBrier paired bootstrap CI 95% (§4.4-2 — cùng method cổng B2 gate
 * script): resample CHỈ MỘT tập index rồi lấy mean của CẢ HAI phía cùng
 * index (ghép cặp theo MẪU). deltas[i] = Brier_champ[i] − Brier_serving[i]
 * (âm = champion tốt hơn). Deterministic: cùng deltas + cùng seed → CI
 * GIỐNG HỆT từng số.
 */
export function pairedBootstrapDeltaBrierCI(
  deltas: readonly number[],
  draws: number,
  seed: number
): { mean: number; ciLow: number; ciHigh: number } {
  const n = deltas.length;
  if (n === 0) return { mean: NaN, ciLow: NaN, ciHigh: NaN };
  const mean = deltas.reduce((s, v) => s + v, 0) / n;
  if (n < 2 || draws < 1) return { mean, ciLow: mean, ciHigh: mean };
  const rng = mulberry32(seed);
  const means: number[] = [];
  for (let b = 0; b < draws; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += deltas[Math.floor(rng() * n)];
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  return {
    mean,
    ciLow: percentileSorted(means, 0.025),
    ciHigh: percentileSorted(means, 0.975),
  };
}

/** Tham số cổng 4 điều kiện (§4.4) — thuần, verify script test riêng từng đường. */
export interface ChampionGateParams {
  championValAcc: number;
  /** null = DB sạch → baseline 1/3 (F4). AUDIT 137 B4: championValAcc +
   *  servingValAcc đo trên CÙNG gateIdx (holdout walk-forward khi có dữ
   *  liệu — đồng cửa sổ, post-selection). */
  servingValAcc: number | null;
  deltaSwap: number;
  /** CI 95% của ΔBrier paired bootstrap (champ − serving). */
  deltaBrierCiLow: number;
  deltaBrierCiHigh: number;
  championParamCount: number;
  /** null = DB sạch → cap maxParamFactor × paramWarnThreshold (F4). */
  servingParamCount: number | null;
  maxParamFactor: number;
  /** F-19 (#133): số mẫu TRAIN của đợt — cơ sở cap theo dữ liệu (0 → bỏ
   *  nhánh sample-cap, giữ nguyên hành vi cap hệ số cũ). */
  nTrain: number;
}

export interface ChampionGateResult {
  pass: boolean;
  /** Rỗng khi pass; mỗi dòng 1 điều kiện fail (tiếng Việt, nói rõ điều kiện nào). */
  reasons: string[];
}

/**
 * Cổng quyết định champion (§4.4) — 3 điều kiện đo được ở đây; điều kiện 4
 * (skip-guard windowHash như A4) đã xử TRƯỚC khi tạo hàng SweepRun (F8)
 * nên mặc nhiên thoả khi hàm này được gọi. serving == null → baseline 1/3 ·
 * Brier uniform 0,667 (đưa vào qua CI deltas) · cap maxParamFactor ×
 * 5.000 = 10.000 mặc định (F4 — nhánh DB sạch, sau C0 serving luôn tồn tại).
 */

/** F-100A-3 (#100-A Fixbug): số tiếng Việt trong thông điệp cổng — phẩy thập
 *  phân · chấm nhóm nghìn (UI hiển thị swapReason nguyên văn; trước đây trộn
 *  dấu chấm thập phân kiểu Anh "42.3%"/"[0.0000, 0.0000]" giữa câu tiếng Việt). */
function fmtVi(n: number, digits = 0): string {
  return n.toLocaleString("vi-VN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Hệ số (2 hoặc 2,5) — in nguyên phần đã có, thay dấu thập phân theo kiểu VN. */
function fmtViFactor(n: number): string {
  return String(n).replace(".", ",");
}

/**
 * F-19 (#133) — MIN_SAMPLES_PER_PARAM: quy tắc thống kê cổ điển (10–20 mẫu
 * cho mỗi tham số) — lấy đầu bảo thủ 15. nTrain 48.000 mẫu → cap 3.200
 * tham số: mô hình 24-48-24-12-3 (2.715 tham số, valAcc +3,5 điểm %, ΔBrier
 * CI95 < 0) được phép áp dụng vì DỮ LIỆU đủ lớn chứng minh cho nó. Chỉ khi
 * mẫu ít (nTrain 5.000 → cap 333) cap mới kẹp chặt — đúng lúc mô hình to
 * có nguy cơ học vẹt val block (winner's curse). 
 * Cap thực tế = max(cap hệ số, cap mẫu) — hai lính gác độc lập, tha cái
 * được dữ liệu chứng minh, chặn cái dữ liệu không nuôi nổi.
 */
export const MIN_SAMPLES_PER_PARAM = 15;

export function championGateCheck(p: ChampionGateParams): ChampionGateResult {
  const reasons: string[] = [];
  const baselineValAcc = p.servingValAcc ?? 1 / 3;
  if (!(p.championValAcc >= baselineValAcc + p.deltaSwap)) {
    reasons.push(
      `Điều kiện 1 — valAcc champion ${fmtVi(p.championValAcc * 100, 1)}% chưa vượt baseline ${fmtVi(baselineValAcc * 100, 1)}% + δ ${fmtVi(p.deltaSwap * 100, 1)} điểm %`
    );
  }
  if (!(p.deltaBrierCiHigh < 0)) {
    reasons.push(
      `Điều kiện 2 — ΔBrier CI 95% [${fmtVi(p.deltaBrierCiLow, 4)}; ${fmtVi(p.deltaBrierCiHigh, 4)}] không hoàn toàn < 0 (champion chưa thắng có ý nghĩa thống kê)`
    );
  }
  // F-19 (#133): cap hiệu chỉnh theo dữ liệu — max(cap hệ số cũ, nTrain/15).
  const factorCap = p.maxParamFactor * (p.servingParamCount ?? MLP_ARCH_LIMITS.paramWarnThreshold);
  const sampleCap = p.nTrain > 0 ? Math.floor(p.nTrain / MIN_SAMPLES_PER_PARAM) : 0;
  const paramCap = Math.max(factorCap, sampleCap);
  if (!(p.championParamCount <= paramCap)) {
    const capExplain =
      sampleCap > factorCap
        ? `nTrain ${fmtVi(p.nTrain)} ÷ ${MIN_SAMPLES_PER_PARAM} mẫu/tham số`
        : `${fmtViFactor(p.maxParamFactor)} × ${fmtVi(p.servingParamCount ?? MLP_ARCH_LIMITS.paramWarnThreshold)}`;
    reasons.push(
      `Điều kiện 3 — ${fmtVi(p.championParamCount)} tham số vượt cap ${fmtVi(paramCap)} (=${capExplain}) — chống "thắng vì to" khi dữ liệu không đủ mẫu nuôi mô hình`
    );
  }
  return { pass: reasons.length === 0, reasons };
}

/* ─────────────────── F-18 (#131): Champion → ml-tuning auto-promote ─────────────────── */

/** Kết quả đồng bộ champion → AppSetting ml-tuning. */
export interface ChampionTuningSyncResult {
  synced: boolean;
  note: string;
}

/**
 * F-18 (#131) — GHI kiến trúc + hyper của champion (đã qua cổng 4 điều kiện
 * & swap serving) xuống AppSetting "ml-tuning":
 *   - mlp: hidden + activations + lossWeights + FULL hyper (epochs ·
 *     patience · batchSize · lr · l2 · valFraction · seed) + featureSet
 *     (v3-macro nếu champion 24 chiều) — lần train KẾ TIẾP (nút tay tab
 *     Mạng thần kinh + đường engine Chủ nhật) dựng ĐÚNG arch champion thay
 *     vì quay về cấu hình cũ.
 *   - nasSync marker {at, runId, tag, arch, modelVersion} — /api/ml/
 *     architecture đọc ra draft.source để tab Mạng thần kinh hiển thị banner
 *     "thiết lập này do NAS đồng bộ lúc…"; trader LƯU TAY section mlp →
 *     tuning route XOÁ marker (người đè NAS, nguồn gốc trung thực).
 *   - GIỮ NGUYÊN section rag (đồng bộ chỉ đụng phần mlp — "một việc một việc").
 *
 * Kỷ luật: giá trị viết xuống đi qua ROUND-TRIP parseMlTuningValue — giá trị
 * phải sống sót đúng đường đọc (kẹp phạm vi, lọc rác) y như mọi lần lưu tay;
 * audit ML_SWEEP_SYNC_TUNING before/after (fail-soft — lỗi audit không chặn
 * chính). Fail-soft tuyệt đối: lỗi DB → {synced:false, note} — swap serving
 * weights (đã commit) KHÔNG bị rollback.
 */
export async function syncChampionTuningToSetting(params: {
  runId: string;
  /** hidden[] của champion (SweepCandidate.hidden — đã trong giới hạn arch). */
  hidden: readonly number[];
  activations: readonly MlpActivation[];
  lossWeights: readonly [number, number, number];
  hyper: SweepHyper;
  tag: string;
  arch: string;
  modelVersion: number;
}): Promise<ChampionTuningSyncResult> {
  const saved = await readMlTuning();
  const next: MlTuning = {
    ...saved,
    mlp: {
      hidden: [...params.hidden],
      activations: [...params.activations],
      lossWeights: [...params.lossWeights] as [number, number, number],
      epochs: params.hyper.epochs,
      patience: params.hyper.patience,
      batchSize: params.hyper.batchSize,
      lr: params.hyper.lr,
      l2: params.hyper.l2,
      valFraction: params.hyper.valFraction,
      seed: params.hyper.seed,
      featureSet: params.hyper.featureSet === "v3-macro" ? "v3-macro" : "v2-lag16",
    },
    nasSync: {
      at: new Date().toISOString(),
      runId: params.runId,
      tag: params.tag,
      arch: params.arch,
      modelVersion: params.modelVersion,
    },
  };
  // Round-trip guard: cấu hình champion phải sống sót qua đúng đường parse
  // của mọi lần đọc sau này (một cửa — không ghi giá trị sẽ bị kẹp/đổi ý
  // nghĩa). So SÂU toàn bộ mlp (arch + hyper + featureSet) từng số —
  // fixbug T3c p131-verify: trước đây chỉ so hidden/activations, seed sweep
  // 20 triệu bị kẹp im lặng về 999.999 → lần train kế tiếp KHÔNG tái hiện
  // được champion (khác seed = khác khởi tạo).
  try {
    const reparsed = parseMlTuningValue(JSON.parse(JSON.stringify(next)));
    const m = reparsed.mlp;
    const hyperMatch =
      m != null &&
      m.epochs === params.hyper.epochs &&
      m.patience === params.hyper.patience &&
      m.batchSize === params.hyper.batchSize &&
      m.lr === params.hyper.lr &&
      m.l2 === params.hyper.l2 &&
      m.valFraction === params.hyper.valFraction &&
      m.seed === params.hyper.seed &&
      m.featureSet === (params.hyper.featureSet === "v3-macro" ? "v3-macro" : "v2-lag16");
    const archMatch =
      m != null &&
      m.hidden != null &&
      m.hidden.length === params.hidden.length &&
      m.hidden.every((h, i) => h === params.hidden[i]) &&
      m.activations != null &&
      m.activations.length === params.activations.length &&
      m.activations.every((a, i) => a === params.activations[i]) &&
      m.lossWeights != null &&
      m.lossWeights.every((w, i) => w === params.lossWeights[i]);
    if (!hyperMatch || !archMatch || reparsed.nasSync == null) {
      return {
        synced: false,
        note: "round-trip parse không giữ nguyên cấu hình champion (giá trị bị kẹp phạm vi?) — bỏ đồng bộ (an toàn)",
      };
    }
  } catch (err) {
    return {
      synced: false,
      note: `round-trip parse lỗi: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const ok = await writeMlTuning(next);
  if (!ok) {
    return { synced: false, note: "Không ghi được AppSetting ml-tuning (lỗi DB)" };
  }
  try {
    await db.auditLog.create({
      data: {
        action: "ML_SWEEP_SYNC_TUNING",
        entity: "AppSetting",
        entityId: null,
        before: JSON.stringify({
          mlp: saved.mlp ?? null,
          ragPreserved: saved.rag != null,
          nasSyncBefore: saved.nasSync ?? null,
        }),
        after: JSON.stringify({
          mlp: next.mlp,
          nasSync: next.nasSync,
          note: "F-18 — champion qua cổng 4 điều kiện & swap serving → đồng bộ thiết lập tab Mạng thần kinh",
        }),
      },
    });
  } catch (auditErr) {
    console.error("l/sweep] audit ML_SWEEP_SYNC_TUNING lỗi (bỏ qua):", auditErr);
  }
  return {
    synced: true,
    note: `đã ghi arch ${params.arch} + hyper (lr ${params.hyper.lr}, ${params.hyper.epochs} epoch, batch ${params.hyper.batchSize}, seed ${params.hyper.seed}, bộ ${params.hyper.featureSet}) xuống tab Mạng thần kinh`,
  };
}

/* ─────────────────── Runner (§4.3 → §4.6) ─────────────────── */

/** Số draw bootstrap mặc định của cổng (cùng B2). */
export const SWEEP_BOOTSTRAP_DRAWS = 1_000;

/** Trần thời gian 1 đợt (§4.6 — dừng an toàn giữa chừng, KHÔNG rollback gì;
 *  thấp hơn timeout 20 phút của engine để route kịp ghi hàng "failed"). */
export const SWEEP_TIME_BUDGET_MS = 19 * 60_000;

/** 1 dòng champion board (logJson) — mọi ứng viên kể cả thua (§2.10). */
export interface SweepRunLogEntry {
  i: number;
  tag?: string;
  arch: string;
  activations: string[];
  lossWeights: [number, number, number];
  valAcc?: number;
  valLoss?: number;
  brier?: number;
  params?: number;
  score?: number;
  ms?: number;
  error?: string;
}

/** championJson — kết quả + phán quyết cổng 4 điều kiện của đợt. */
export interface SweepChampionInfo {
  index: number;
  tag: string;
  arch: string;
  activations: string[];
  lossWeights: [number, number, number];
  hyper: SweepHyper;
  valAcc: number;
  valLoss: number;
  brier: number;
  paramCount: number;
  score: number;
  swapProposed: boolean;
  swapReason: string;
  modelVersion: number;
  /** CI ΔBrier paired bootstrap (champ − serving) đã đo cho cổng. */
  deltaBrier?: { mean: number; ciLow: number; ciHigh: number };
  /** AUDIT 137 B4 — số đo walk-forward trên block holdout cuối (SAU val
   *  early-stop, không tham gia chọn champion): điều kiện 1+2 của cổng chấm
   *  ở đây — đồng cửa sổ champion vs serving, trung thực post-selection.
   *  null = dữ liệu tối thiểu, holdout tắt (cổng dùng val selection). */
  holdout?: {
    size: number;
    dateFrom: string | null;
    dateTo: string | null;
    championAcc: number;
    championBrier: number | null;
    servingAcc: number | null;
    servingBrier: number | null;
  } | null;
  /** Ghi chú trung thực về valAcc phía trên (số post-selection — early-stop
   *  + chọn champion trên cùng val block; chỉ mang tính tham khảo). */
  selectionNote?: string;
  /** Trạng thái serving TRƯỚC đợt (null object = DB sạch). */
  serving?: { valAcc: number | null; paramCount: number | null; version: number | null } | null;
  /** F-18 (#131): kết quả đồng bộ champion → AppSetting ml-tuning (chỉ khi
   *  swap thành công; null khi không swap). */
  tuningSync?: { synced: boolean; note: string } | null;
}

/** Kết quả 1 đợt sweep (route trả FE + engine broadcast "ml-sweep"). */
export interface SweepRunSummary {
  ok: boolean;
  /** true = mutex dùng chung đang bị giữ (route → 429). */
  busy?: boolean;
  /** true = skip-guard chặn (điều kiện 4 — KHÔNG tạo hàng SweepRun). */
  skipped?: boolean;
  reason?: string;
  runId?: string;
  status?: "done" | "failed";
  windowHash?: string;
  candidates?: number;
  evaluated?: number;
  seed?: number;
  champion?: SweepChampionInfo | null;
  swapped?: boolean;
  durationMs?: number;
  log?: SweepRunLogEntry[];
}

/** Brier per-sample (method gate script :343-358): p = predictProba trả
 *  [pUp, pFlat, pDown]; oh từ y; sum 3 class (p[c] − oh[c])². */
function perSampleBrier(model: MLP, x: number[], y: number): number {
  const p = model.predictProba(x);
  const oh = [y === 2 ? 1 : 0, y === 1 ? 1 : 0, y === 0 ? 1 : 0];
  let b = 0;
  for (let c = 0; c < 3; c++) b += (p[c] - oh[c]) ** 2;
  return b;
}

/** Kết quả đánh giá 1 ứng viên trong runner (model giữ lại cho ΔBrier). */
interface CandidateEval {
  cand: SweepCandidate;
  entry: SweepRunLogEntry;
  model: MLP | null;
  perSampleBrier: number[] | null;
  modelVersion: number | null;
  score: number;
}

/**
 * Chạy MỘT đợt sweep (§4.3-§4.5) — các bước đánh số trong thân hàm.
 * Fail-soft: lỗi TỪNG ứng viên → log entry error, đợt vẫn tiếp; lỗi CHẸN
 * (DB/build set hỏng) → SweepRun status "failed", giữ logJson ứng viên đã
 * xong, nhả mutex, trả summary (không rethrow). Wall-clock quá
 * SWEEP_TIME_BUDGET_MS → phần còn lại log "budget thời gian" + status
 * "failed" (§4.6 — dừng an toàn, không rollback).
 */
export async function runSweepOnce(opts: {
  force: boolean;
  budgetOverride?: number;
  /** F-01 (#129): "v3-macro" → ứng viên 24 chiều (8 chiều vĩ mô — đấu
   *  sweep fair với serving hiện tại qua cùng val block); mặc định v2-lag16. */
  featureSet?: string;
}): Promise<SweepRunSummary> {
  const config = await readSweepConfig();
  const budget = clampSweepInt(opts.budgetOverride ?? config.budgetCandidates, 1, 64);
  // F-18 (#131): featureSet của đợt — ưu tiên giá trị opts tường minh (nút
  // tay / route body); MẶC ĐỊNH theo ml-tuning đang hiệu lực: NAS đã đồng bộ
  // v3-macro → các đợt sau (kể cả engine Chủ nhật 04:15) tìm tiếp trong
  // không gian 24 chiều — vòng lặp NAS khép kín, không tự quay về 16 chiều.
  // Tuning đọc 1 LẦN đầu đợt (lossWeights coarse + featureSet dùng chung —
  // snapshot thống nhất toàn đợt như §2.9 deterministic).
  const tuning = await readEffectiveMlTuning();
  const featureSet =
    opts.featureSet === "v3-macro" || opts.featureSet === "v2-lag16"
      ? opts.featureSet
      : tuning.mlp.featureSet === "v3-macro"
        ? "v3-macro"
        : "v2-lag16";
  const inDims = featureSet === "v3-macro" ? 24 : 16;

  // (1) Mutex dùng chung với train route (F2) — busy → route trả 429.
  if (!tryAcquireTrainLock()) {
    return { ok: false, busy: true, reason: "Train/sweep khác đang giữ mutex dùng chung" };
  }
  const started = Date.now();
  // Đặt mốc cooldown dùng chung: train tay trong lúc sweep chạy → 429 mutex
  // (không bao giờ 2 hàng trùng (kind, version) — nghiệm thu §4.7-7/F2).
  markTrainAttempt(started);

  const log: SweepRunLogEntry[] = [];
  let runId: string | null = null;

  try {
    // (2) buildTrainingSet MỘT lần cho cả đợt + digest PIT (F-611-01 — hash
    //     trên chính chuỗi dùng train). Skip-guard A4-style (điều kiện 4/F8):
    //     !force + đợt "done" gần nhất cùng windowHash VÀ featureSet → trả
    //     skip KHÔNG tạo hàng (tuần không có bar mới = $0).
    //     F-01 (#129): featureSet v3-macro → tập 24 chiều (8 chiều vĩ mô căn
    //     chỉnh PIT qua loadMacroContexts — cùng seed, cùng cut 80/20).
    const set = await buildTrainingSet(20, {
      featureSet: featureSet === "v3-macro" ? "v3-macro" : "v2-lag16",
    });
    const windowMeta = trainingWindowDigest(set.series, { samples: set.X.length });
    if (!opts.force) {
      const lastDone = await db.sweepRun.findFirst({
        where: { status: "done" },
        orderBy: { startedAt: "desc" },
      });
      if (
        lastDone &&
        lastDone.windowHash === windowMeta.windowHash &&
        lastDone.featureSet === featureSet
      ) {
        return {
          ok: true,
          skipped: true,
          reason:
            "windowHash unchanged — đợt sweep gần nhất đã chạy trên cùng cửa sổ dữ liệu (không có bar mới)",
          windowHash: windowMeta.windowHash,
          durationMs: Date.now() - started,
        };
      }
    }

    // (3) Tạo hàng SweepRun status "running" (candidates = budget hiệu lực).
    const run = await db.sweepRun.create({
      data: {
        windowHash: windowMeta.windowHash,
        featureSet,
        candidates: budget,
        evaluated: 0,
        seed: config.seed,
        status: "running",
      },
    });
    runId = run.id;

    // (4) Serving hiện tại (có thể null — F4): valAcc + mô hình (Brier val
    //     block) + paramCount. weights hỏng → coi như không có mô hình
    //     serving (fail-soft — cổng vẫn chạy với baseline).
    const servingRow = await db.mlModel.findFirst({
      where: { kind: "dl-mlp", status: "serving" },
      orderBy: { version: "desc" },
      select: { version: true, metrics: true, weights: true },
    });
    let servingValAcc: number | null = null;
    if (servingRow?.metrics) {
      try {
        const m = JSON.parse(servingRow.metrics) as { valAcc?: unknown };
        if (typeof m.valAcc === "number" && Number.isFinite(m.valAcc)) servingValAcc = m.valAcc;
      } catch {
        // metrics hỏng → baseline mặc định
      }
    }
    let servingModel: MLP | null = null;
    try {
      servingModel = servingRow ? MLP.fromJSON(servingRow.weights) : null;
    } catch (err) {
      console.error("[ml/sweep] MLP.fromJSON(serving) lỗi (coi như không có serving):", err);
      servingModel = null;
    }
    const servingParamCount = servingModel?.paramCount ?? null;

    // AUDIT 137 B4 — WALK-FORWARD HOLDOUT cho cổng champion: cắt H mẫu CUỐI
    // (mới nhất theo thời gian — buildTrainingSet sort theo ngày) ra khỏi vũ
    // trụ chọn-lựa. Ứng viên chỉ train + early-stop + chấm score trên
    // m = n−H mẫu đầu (setTrain); block H mẫu cuối CHỈ phục vụ điều kiện 1+2
    // của cổng (champion vs serving đo CÙNG cửa sổ, SAU-selection). Trước
    // đây valAcc champion được CHỌN trên val rồi BÁO lại chính val đó
    // (winner's curse ~budget ứng viên, mỗi ứng viên early-stop theo val) —
    // số cổng lạc quan hệ thống; servingValAcc cũ lại đo trên cửa sổ train
    // khác (so chéo). H = 5% cửa sổ kẹp [120; 1500]; dữ liệu tối thiểu
    // (n−H < 650 mẫu để trainDlMlp còn ≥ 600) → H co về 0 = holdout tắt,
    // cổng lùi về val block như cũ (selectionNote ghi rõ trung thực).
    const n = set.X.length;
    let holdoutCount = Math.min(1500, Math.max(120, Math.floor(n * 0.05)));
    if (n - holdoutCount < 650) holdoutCount = Math.max(0, n - 650);
    const m = n - holdoutCount;
    // Cắt ĐỒNG BỘ mọi mảng theo mẫu (X · y · symbols · dates · rich) —
    // trainDlMlp tính topSymbols bằng set.symbols.forEach trên preds của
    // set.X: thiếu cặp nào lệch độ dài ở đó (nghiệm thu mini-sweep: TypeError
    // "reading '0'" ở preds[i] undefined — fail-soft giữ 0 hàng MlModel).
    const setTrain: TrainingSetWithSeries =
      holdoutCount > 0
        ? {
            ...set,
            X: set.X.slice(0, m),
            y: set.y.slice(0, m),
            symbols: set.symbols.slice(0, m),
            dates: set.dates.slice(0, m),
            ...(set.rich != null ? { rich: set.rich.slice(0, m) } : {}),
          }
        : set;
    const holdoutIdx: number[] = [];
    for (let i = m; i < n; i++) holdoutIdx.push(i);

    // Val block SELECT — cùng cut 80/20 thời gian như fit() (F6: Brier tự
    // tính đúng method gate script, khớp early-stop val block) — trên vũ trụ
    // chọn-lựa m mẫu (không gồm holdout).
    const nTrainSel = Math.floor(setTrain.X.length * TRAIN_FRACTION);
    const valIdx: number[] = [];
    for (let i = nTrainSel; i < setTrain.X.length; i++) valIdx.push(i);
    const servingPerSample =
      servingModel != null
        ? valIdx.map((i) => perSampleBrier(servingModel as MLP, setTrain.X[i]!, setTrain.y[i]!))
        : null;
    const servingBrierMean =
      servingPerSample != null && servingPerSample.length > 0
        ? servingPerSample.reduce((s, v) => s + v, 0) / servingPerSample.length
        : null;

    // (5) Sinh + train tuần tự từng ứng viên (coarse trước — top-2 THẬT mới
    //     sinh refine). Wall-clock: quá trần → phần còn lại log "budget thời
    //     gian" (không train tiếp), đợt ghi status "failed" (§4.6).
    //     F-18 (#131): tuning đọc MỘT LẦN đầu đợt (featureSet + lossWeights
    //     coarse dùng chung — thấy ở phần khai báo trên mutex).
    const traderLossWeights = tuning.mlp.lossWeights;
    const coarse = buildCoarseCandidates(traderLossWeights, config.seed, featureSet);
    const coarseCount = Math.min(budget, coarse.length);
    const evals: CandidateEval[] = [];

    const trainCandidate = async (cand: SweepCandidate): Promise<CandidateEval> => {
      const t0 = Date.now();
      const candidateTuning: MlpTuning = {
        hidden: [...cand.hidden],
        activations: [...cand.activations],
        lossWeights: [...cand.lossWeights] as [number, number, number],
        epochs: cand.hyper.epochs,
        patience: cand.hyper.patience,
        batchSize: cand.hyper.batchSize,
        lr: cand.hyper.lr,
        l2: cand.hyper.l2,
        valFraction: cand.hyper.valFraction,
        seed: cand.hyper.seed,
      };
      try {
        // AUDIT 137 B4 — ứng viên train trên setTrain (vũ trụ chọn-lựa m mẫu,
        // KHÔNG gồm holdout cuối) — holdout chỉ dành cho phép đo cổng.
        const res = await trainDlMlp(setTrain, {
          tuning: candidateTuning,
          promote: false, // §4.3 — sweep KHÔNG đụng serving trong lúc chạy
          extraMeta: {
            sweepRunId: run.id,
            sweepIndex: cand.index,
            ...(holdoutCount > 0 ? { gateHoldout: { size: holdoutCount } } : {}),
          },
        });
        const ms = Date.now() - t0;
        const perSample = valIdx.map((i) => perSampleBrier(res.model, setTrain.X[i]!, setTrain.y[i]!));
        const brier = perSample.reduce((s, v) => s + v, 0) / Math.max(1, perSample.length);
        const paramCount = res.model.paramCount;
        const score = computeScore({
          valAcc: res.metrics.valAcc,
          paramCount,
          brier,
          servingBrier: servingBrierMean,
        });
        return {
          cand,
          model: res.model,
          perSampleBrier: perSample,
          modelVersion: res.modelVersion,
          score,
          entry: {
            i: cand.index,
            tag: cand.tag,
            arch: res.appliedTuning.arch,
            activations: [...res.appliedTuning.activations],
            lossWeights: [...res.appliedTuning.lossWeights] as [number, number, number],
            valAcc: res.metrics.valAcc,
            valLoss: res.metrics.valLoss,
            brier: Number(brier.toFixed(4)),
            params: paramCount,
            score: Number(score.toFixed(4)),
            ms,
          },
        };
      } catch (err) {
        console.error(`[ml/sweep] ứng viên ${cand.tag} (i=${cand.index}) lỗi (fail-soft):`, err);
        return {
          cand,
          model: null,
          perSampleBrier: null,
          modelVersion: null,
          score: -Infinity,
          entry: {
            i: cand.index,
            tag: cand.tag,
            arch: archStringOf(cand.hidden, inDims),
            activations: [...cand.activations],
            lossWeights: [...cand.lossWeights] as [number, number, number],
            ms: Date.now() - t0,
            error: err instanceof Error ? err.message : String(err),
          },
        };
      }
    };

    let timedOut = false;
    for (let i = 0; i < coarseCount; i++) {
      if (Date.now() - started > SWEEP_TIME_BUDGET_MS) {
        timedOut = true;
        const c = coarse[i]!;
        log.push({
          i: c.index,
          tag: c.tag,
          arch: archStringOf(c.hidden, inDims),
          activations: [...c.activations],
          lossWeights: [...c.lossWeights] as [number, number, number],
          error: "budget thời gian",
        });
        continue;
      }
      const ev = await trainCandidate(coarse[i]!);
      evals.push(ev);
      log.push(ev.entry);
    }

    // Refine — chỉ khi budget > 12 và chưa chạm trần thời gian; top-2 coarse
    // THẬT theo score (ties → lower index); chỉ 1 coarse sống → top2 = top1.
    if (budget > coarse.length && !timedOut) {
      const ranked = [...evals].sort((a, b) => b.score - a.score || a.cand.index - b.cand.index);
      const top1 = ranked[0];
      const top2 = ranked[1] ?? ranked[0];
      if (top1 && top2) {
        const refine = deriveRefineCandidates(
          top1.cand,
          top2.cand,
          traderLossWeights,
          config.seed,
          coarse.length
        );
        const refineCount = Math.min(refine.length, budget - coarse.length);
        for (let k = 0; k < refineCount; k++) {
          const cand = refine[k]!;
          if (Date.now() - started > SWEEP_TIME_BUDGET_MS) {
            timedOut = true;
            log.push({
              i: cand.index,
              tag: cand.tag,
              arch: archStringOf(cand.hidden, inDims),
              activations: [...cand.activations],
              lossWeights: [...cand.lossWeights] as [number, number, number],
              error: "budget thời gian",
            });
            continue;
          }
          const ev = await trainCandidate(cand);
          evals.push(ev);
          log.push(ev.entry);
        }
      } else {
        // Toàn bộ coarse lỗi (dữ liệu hỏng?) — log slot refine trung thực.
        for (let k = 0; k < Math.min(4, budget - coarse.length); k++) {
          log.push({
            i: coarse.length + k,
            tag: `R${k + 1}`,
            arch: "—",
            activations: [],
            lossWeights: [1, 1, 1],
            error: "không có ứng viên coarse thành công để refine",
          });
        }
      }
    }

    log.sort((a, b) => a.i - b.i);
    const evaluated = log.filter((e) => e.error == null).length;

    // (6)+(7) Champion = score cao nhất trong ứng viên KHÔNG lỗi (ties →
    //        lower index — deterministic); không ứng viên sống nào → null.
    //        Cổng 4 điều kiện: CI ΔBrier paired bootstrap champ−serving trên
    //        cùng val block (serving null → baseline 0,667 hằng — F4).
    const alive = evals.filter((e) => e.entry.error == null && e.model != null);
    const championEval =
      alive.length > 0 ? alive.reduce((best, e) => (e.score > best.score ? e : best)) : null;

    let champion: SweepChampionInfo | null = null;
    let swapped = false;
    /** F-18 (#131): kết quả đồng bộ champion → ml-tuning (chỉ set khi swap). */
    let tuningSync: { synced: boolean; note: string } | null = null;

    if (championEval) {
      const ce = championEval;
      // AUDIT 137 B4 — cổng đo trên gateIdx: holdout walk-forward khi có dữ
      // liệu (block cuối SAU val early-stop, không tham gia chọn champion),
      // val block cũ khi holdout tắt (dữ liệu tối thiểu). serving null →
      // baseline uniform (F4). Điều kiện 1+2 từ đây: đồng cửa sổ champion vs
      // serving, post-selection — hết winner's curse và hết so chéo cửa sổ
      // train cũ của serving (servingValAcc biến metrics cũ giờ chỉ hiển thị).
      const gateIdx = holdoutCount > 0 ? holdoutIdx : valIdx;
      const champGatePer =
        ce.model != null
          ? gateIdx.map((i) => perSampleBrier(ce.model as MLP, set.X[i]!, set.y[i]!))
          : [];
      const servingGatePer =
        servingModel != null
          ? gateIdx.map((i) => perSampleBrier(servingModel as MLP, set.X[i]!, set.y[i]!))
          : null;
      const deltas = gateIdx.map(
        (_, i) =>
          champGatePer[i]! - (servingGatePer != null ? servingGatePer[i]! : UNIFORM_BRIER_BASELINE)
      );
      const ci = pairedBootstrapDeltaBrierCI(deltas, SWEEP_BOOTSTRAP_DRAWS, config.seed);
      // Accuracy trên gateIdx — cùng semantics argmax-class như evalSplit
      // nn.ts (predictProba [pUp,pFlat,pDown] ↔ label [2,1,0]).
      const accOnGateIdx = (model: MLP | null): number | null => {
        if (model == null || gateIdx.length === 0) return null;
        let ok = 0;
        for (const i of gateIdx) {
          const p = model.predictProba(set.X[i]!);
          let k = 0;
          if (p[1] > p[k]) k = 1;
          if (p[2] > p[k]) k = 2;
          if (2 - k === set.y[i]) ok++;
        }
        return ok / gateIdx.length;
      };
      const championGateAcc = accOnGateIdx(ce.model) ?? 0;
      const servingGateAcc = accOnGateIdx(servingModel);
      const champGateBrierMean =
        champGatePer.length > 0
          ? champGatePer.reduce((s, v) => s + v, 0) / champGatePer.length
          : null;
      const servingGateBrierMean =
        servingGatePer != null && servingGatePer.length > 0
          ? servingGatePer.reduce((s, v) => s + v, 0) / servingGatePer.length
          : null;
      const holdoutInfo =
        holdoutCount > 0
          ? {
              size: holdoutCount,
              dateFrom: set.dates[m] ?? null,
              dateTo: set.dates[n - 1] ?? null,
              championAcc: Number(championGateAcc.toFixed(4)),
              championBrier:
                champGateBrierMean != null ? Number(champGateBrierMean.toFixed(4)) : null,
              servingAcc: servingGateAcc != null ? Number(servingGateAcc.toFixed(4)) : null,
              servingBrier:
                servingGateBrierMean != null ? Number(servingGateBrierMean.toFixed(4)) : null,
            }
          : null;
      const gate = championGateCheck({
        championValAcc: championGateAcc,
        servingValAcc: servingGateAcc,
        deltaSwap: config.deltaSwap,
        deltaBrierCiLow: ci.ciLow,
        deltaBrierCiHigh: ci.ciHigh,
        championParamCount: ce.entry.params ?? 0,
        servingParamCount,
        maxParamFactor: config.maxParamFactor,
        // F-19 (#133): cap theo dữ liệu — chính vũ trụ chọn-lựa ứng viên đã
        // train (mẫu, trừ holdout; valFraction riêng từng ứng viên — B4).
        nTrain: Math.floor(
          m * (1 - Math.min(0.5, Math.max(0.05, ce.cand.hyper.valFraction)))
        ),
      });

      // (8) Cổng PASS → SWAP trong MỘT $transaction (updateMany serving →
      //     archived + update hàng champion → serving) + AuditLog
      //     ML_SWEEP_SWAP trước/sau. Champion row do trainDlMlp lưu
      //     "archived" — truy lại theo (kind, version) vừa tạo.
      let swapProposed = false;
      let swapReason: string;
      let championModelVersion = ce.modelVersion ?? 0;
      if (gate.pass) {
        const championRow = await db.mlModel.findFirst({
          where: { kind: "dl-mlp", version: ce.modelVersion ?? -1 },
          select: { id: true, version: true },
        });
        if (championRow) {
          await db.$transaction([
            db.mlModel.updateMany({
              where: { kind: "dl-mlp", status: "serving" },
              data: { status: "archived" },
            }),
            db.mlModel.update({
              where: { id: championRow.id },
              data: { status: "serving" },
            }),
          ]);
          swapped = true;
          swapProposed = true;
          swapReason = "passed 4-condition gate";
          championModelVersion = championRow.version;
          try {
            await db.auditLog.create({
              data: {
                action: "ML_SWEEP_SWAP",
                entity: "MlModel",
                entityId: championRow.id,
                before: JSON.stringify({
                  servingVersion: servingRow?.version ?? null,
                  servingValAcc,
                  servingParamCount,
                  windowHash: windowMeta.windowHash,
                }),
                after: JSON.stringify({
                  promotedVersion: championRow.version,
                  sweepRunId: run.id,
                  championIndex: ce.cand.index,
                  arch: ce.entry.arch,
                  valAcc: ce.entry.valAcc,
                  brier: ce.entry.brier,
                  score: ce.entry.score,
                  deltaBrier: { mean: ci.mean, ciLow: ci.ciLow, ciHigh: ci.ciHigh },
                  // AUDIT 137 B4 — số cổng (holdout walk-forward, đồng cửa sổ).
                  holdout: holdoutInfo,
                  at: new Date().toISOString(),
                }),
              },
            });
          } catch (auditErr) {
            console.error("[ml/sweep] audit ML_SWEEP_SWAP lỗi (bỏ qua):", auditErr);
          }
          // F-18 (#131): swap serving xong → ĐỒNG BỘ thiết lập champion xuống
          // AppSetting ml-tuning (tab Mạng thần kinh + lần train kế tiếp dùng
          // đúng arch champion). Kill-switch autoPromoteTuning đọc FRESH —
          // trader có thể vừa đổi giữa chừng đợt. Fail-soft: đồng bộ lỗi
          // KHÔNG rollback swap (serving weights vẫn đúng champion).
          try {
            const freshCfg = await readSweepConfig();
            if (freshCfg.autoPromoteTuning) {
              tuningSync = await syncChampionTuningToSetting({
                runId: run.id,
                hidden: ce.cand.hidden,
                activations: ce.cand.activations,
                lossWeights: ce.entry.lossWeights as [number, number, number],
                hyper: ce.cand.hyper,
                tag: ce.cand.tag,
                arch: ce.entry.arch,
                modelVersion: championRow.version,
              });
            } else {
              tuningSync = {
                synced: false,
                note: "autoPromoteTuning đang TẮT (kill-switch ml-sweep) — chỉ hoán đổi serving, giữ thiết lập tab Mạng thần kinh",
              };
            }
          } catch (syncErr) {
            console.error("[ml/sweep] đồng bộ champion → ml-tuning lỗi (fail-soft):", syncErr);
            tuningSync = {
              synced: false,
              note: `đồng bộ lỗi: ${syncErr instanceof Error ? syncErr.message : String(syncErr)}`,
            };
          }
        } else {
          swapReason =
            "qua cổng 4 điều kiện nhưng không tìm thấy hàng MlModel champion (dữ liệu đổi giữa chừng?) — không swap";
        }
      } else {
        // Không qua cổng — champion nằm lại bảng, nhãn lý do THẬT (§4.4).
        swapReason = gate.reasons.join("; ");
      }

      champion = {
        index: ce.cand.index,
        tag: ce.cand.tag,
        arch: ce.entry.arch,
        activations: [...ce.entry.activations],
        lossWeights: [...ce.entry.lossWeights] as [number, number, number],
        hyper: { ...ce.cand.hyper },
        valAcc: ce.entry.valAcc ?? 0,
        valLoss: ce.entry.valLoss ?? 0,
        brier: ce.entry.brier ?? 0,
        paramCount: ce.entry.params ?? 0,
        score: ce.entry.score ?? 0,
        swapProposed,
        swapReason,
        modelVersion: championModelVersion,
        deltaBrier: {
          mean: Number(ci.mean.toFixed(4)),
          ciLow: Number(ci.ciLow.toFixed(4)),
          ciHigh: Number(ci.ciHigh.toFixed(4)),
        },
        // AUDIT 137 B4 — số cổng walk-forward + ghi chú trung thực về valAcc
        // selection (post-selection, thiên lệch lên — không dùng cho cổng).
        ...(holdoutInfo != null ? { holdout: holdoutInfo } : {}),
        selectionNote:
          holdoutInfo != null
            ? "valAcc/brier phía trên là số SELECTION (early-stop + chọn champion trên cùng val block — post-selection, thiên lệch lên); điều kiện 1+2 của cổng đo trên holdout walk-forward (xem holdout)"
            : "dữ liệu tối thiểu — holdout tắt, số cổng đo trên val selection (post-selection)",
        serving: {
          valAcc: servingValAcc,
          paramCount: servingParamCount,
          version: servingRow?.version ?? null,
        },
        ...(tuningSync != null ? { tuningSync } : {}),
      };
    }

    // (9) Đóng hàng SweepRun + AppSetting ml-sweep.lastRunAt (đọc lại fresh
    //     tránh đè config trader đổi giữa chừng đợt) + trả summary.
    const status: "done" | "failed" = timedOut ? "failed" : "done";
    await db.sweepRun.update({
      where: { id: run.id },
      data: {
        status,
        evaluated,
        logJson: JSON.stringify(log),
        championJson: champion ? JSON.stringify(champion) : null,
        finishedAt: new Date(),
      },
    });
    try {
      const fresh = await readSweepConfig();
      await writeSweepConfig({ ...fresh, lastRunAt: new Date().toISOString() });
    } catch (err) {
      console.error("[ml/sweep] cập nhật lastRunAt lỗi (bỏ qua):", err);
    }

    console.log(
      `[ml/sweep] đợt ${run.id} xong: ${evaluated}/${budget} ứng viên · champion ${
        champion ? `${champion.tag} ${champion.arch} (score ${champion.score})` : "—"
      } · ${swapped ? "SWAP serving" : "giữ serving"}${
        tuningSync ? ` · đồng bộ ml-tuning: ${tuningSync.synced ? "OK" : "KHÔNG"}` : ""
      } · ${Date.now() - started}ms`
    );

    return {
      ok: true,
      runId: run.id,
      status,
      windowHash: windowMeta.windowHash,
      candidates: budget,
      evaluated,
      seed: config.seed,
      champion,
      swapped,
      durationMs: Date.now() - started,
      log,
    };
  } catch (fatalErr) {
    // Lỗi CHẸN (DB hỏng giữa chừng…) — đánh dấu "failed" giữ log đã xong,
    // KHÔNG rethrow (route 500 thân thiện); mutex nhả ở finally bên dưới.
    const msg = fatalErr instanceof Error ? fatalErr.message : String(fatalErr);
    console.error("[ml/sweep] LỖI chặn đợt (fail-soft — giữ log ứng viên đã xong):", fatalErr);
    if (runId) {
      try {
        await db.sweepRun.update({
          where: { id: runId },
          data: {
            status: "failed",
            evaluated: log.filter((e) => e.error == null).length,
            logJson: JSON.stringify(log),
            finishedAt: new Date(),
          },
        });
      } catch (markErr) {
        console.error("[ml/sweep] đánh dấu SweepRun failed lỗi (bỏ qua):", markErr);
      }
    }
    return {
      ok: false,
      status: "failed",
      reason: msg,
      runId: runId ?? undefined,
      durationMs: Date.now() - started,
      log,
    };
  } finally {
    releaseTrainLock();
  }
}
