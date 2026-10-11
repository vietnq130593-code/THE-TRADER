/**
 * src/lib/ml/tuning.ts — CẤU HÌNH TINH CHỈNH ML (phiên #89 → #94 · Task 3).
 *
 * AppSetting key "ml-tuning" — nơi trader TỰ Ý điều chỉnh:
 *   - MLP v2 (#94): KIẾN TRÚC N-layer (hidden[] + activations[] từng lớp +
 *     lossWeights từng đầu ra [DOWN, FLAT, UP]) + hyper huấn luyện (epochs ·
 *     patience · batchSize · lr · l2 · valFraction · seed).
 *   - RAG BM25: topK · k₁ · b · trọng số recency.
 *
 * Nguyên tắc (theo pattern k-run/k-sandbox #86/#87 — giữ nguyên #89):
 *   - Fail-soft tuyệt đối: key chưa tạo / JSON hỏng / DB lỗi → trả {} →
 *     mọi caller dùng MẶC ĐỊNH CODE — hành vi cũ không đổi một li.
 *   - Đọc tại thời điểm chạy: train route đọc trước mỗi lần huấn luyện,
 *     retrieveForCycle đọc trước mỗi lần truy hồi — không cache dài.
 *   - Một nguồn sự thật cho mặc định: MLP defaults import từ nn.ts
 *     (MLP_ARCH_V2 + MLP_FIT_DEFAULTS), RAG defaults định nghĩa Ở ĐÂY và
 *     rag.ts dùng lại (rag → tuning, không vòng lặp import).
 *   - Migration #94: bản cũ ghi h1/h2 (2 lớp ẩn cố định) → đọc về
 *     hidden = [h1, h2] + activations relu×2 — semantic partial giữ nguyên.
 *   - Ghi luôn AuditLog ML_TUNING_UPDATED / ML_GRU_TOGGLE / ML_BANDIT_RESET
 *     (fail-soft — audit lỗi không chặn thao tác chính).
 */

import { db } from "@/lib/db";
import {
  MLP_ACTIVATIONS,
  MLP_ARCH_V2,
  MLP_FIT_DEFAULTS,
  MLP_MAX_NEURONS,
  type MlpActivation,
} from "@/lib/ml/nn";

export const ML_TUNING_KEY = "ml-tuning";

/* ─────────────────── Types ─────────────────── */

/** Hyperparameters + kiến trúc MLP v2 (#94) — thiếu trường nào dùng mặc định. */
export interface MlpTuning {
  /** Số nơ-rôn TỪNG lớp ẩn (1..5 lớp, mỗi lớp 2..96). Mặc định [24, 12]. */
  hidden: number[];
  /** Activation TỪNG lớp ẩn — cùng độ dài hidden. Mặc định relu toàn bộ. */
  activations: MlpActivation[];
  /** Trọng số loss từng đầu ra [DOWN, FLAT, UP] — nhân class-weight 1/tần suất. Mặc định [1, 1, 1]. */
  lossWeights: [number, number, number];
  /** Số epoch tối đa (early-stop theo valLoss vẫn áp). Mặc định 60. */
  epochs: number;
  /** Patience early-stop. Mặc định 12. */
  patience: number;
  /** Kích thước mini-batch Adam. Mặc định 32. */
  batchSize: number;
  /** Tốc độ học Adam. Mặc định 0,01. */
  lr: number;
  /** L2 weight-decay — áp chỉ lên W, không áp bias. Mặc định 0. */
  l2: number;
  /** Tỷ lệ tập xác thực (block cuối, cut theo thời gian). Mặc định 0,2. */
  valFraction: number;
  /** Seed RNG (init + shuffle) — deterministic. Mặc định 42. */
  seed: number;
}

/** Tham số RAG BM25 — thiếu trường nào dùng mặc định trường đó. */
export interface RagTuning {
  /** Top-K tài liệu tiêm prompt. Mặc định 8. */
  topK: number;
  /** BM25 k₁ (điều hòa tần suất từ). Mặc định 1,5 (Robertsen). */
  k1: number;
  /** BM25 b (chuẩn hoá độ dài tài liệu). Mặc định 0,75. */
  b: number;
  /** Trọng số recency trong xếp hạng hybrid (BM25 còn lại 1 − w). Mặc định 0,3. */
  wRecency: number;
}

export interface MlTuning {
  mlp?: MlpTuning;
  rag?: RagTuning;
  updatedAt?: string;
}

/* ─────────────────── Mặc định (một nguồn sự thật) ─────────────────── */

export const MLP_TUNING_DEFAULT: MlpTuning = {
  hidden: [...MLP_ARCH_V2.hidden],
  activations: MLP_ARCH_V2.hidden.map(() => "relu" as const),
  lossWeights: [...MLP_FIT_DEFAULTS.lossWeights] as [number, number, number],
  epochs: MLP_FIT_DEFAULTS.maxEpochs,
  patience: MLP_FIT_DEFAULTS.patience,
  batchSize: MLP_FIT_DEFAULTS.batchSize,
  lr: MLP_FIT_DEFAULTS.learningRate,
  l2: MLP_FIT_DEFAULTS.l2,
  valFraction: MLP_FIT_DEFAULTS.valFraction,
  seed: MLP_FIT_DEFAULTS.seed,
};

/** rag.ts dùng lại đúng object này — KHÔNG định nghĩa hằng số riêng nữa. */
export const RAG_TUNING_DEFAULT: RagTuning = {
  topK: 8,
  k1: 1.5,
  b: 0.75,
  wRecency: 0.3,
};

/* ─────────────── Giới hạn kiến trúc MLP (#94 — cho trình chỉnh sửa UI) ─────────────── */

/** Giới hạn trình chỉnh sửa kiến trúc ANN (tab Mạng thần kinh dùng để render). */
export interface MlpArchLimits {
  minLayers: number;
  maxLayers: number;
  minNeurons: number;
  maxNeurons: number;
  activations: MlpActivation[];
  lossWeightMin: number;
  lossWeightMax: number;
  lossWeightStep: number;
  /** Ngưỡng cảnh báo quá tham số hoá (~60k mẫu EOD). */
  paramWarnThreshold: number;
}

export const MLP_ARCH_LIMITS: MlpArchLimits = {
  minLayers: 1,
  maxLayers: 5,
  minNeurons: 2,
  maxNeurons: MLP_MAX_NEURONS, // F-MLP-02 — một nguồn với constructor guard nn.ts
  activations: [...MLP_ACTIVATIONS],
  lossWeightMin: 0.1,
  lossWeightMax: 10,
  lossWeightStep: 0.1,
  paramWarnThreshold: 5000,
};

/* ─────────────────── Phạm vi hợp lệ (validate + UI) ─────────────────── */

export interface TuningFieldSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  integer: boolean;
  unit?: string;
  hint: string;
}

/**
 * Fields MLP v2 (#94): BỎ h1/h2 (chuyển sang trình chỉnh sửa kiến trúc ở tab
 * Mạng thần kinh) — giữ 4 hyper cũ + thêm l2 · valFraction · seed.
 */
export const MLP_TUNING_FIELDS: TuningFieldSpec[] = [
  { key: "epochs", label: "Epoch tối đa", min: 10, max: 200, step: 1, integer: true, hint: "Early-stop theo valLoss vẫn áp dụng trước khi chạm n." },
  { key: "patience", label: "Patience", min: 3, max: 50, step: 1, integer: true, hint: "Số epoch không cải thiện valLoss trước khi dừng sớm." },
  { key: "batchSize", label: "Kích thước batch", min: 8, max: 128, step: 1, integer: true, hint: "Mini-batch của tối ưu Adam." },
  { key: "lr", label: "Tốc độ học (lr)", min: 0.0005, max: 0.1, step: 0.0005, integer: false, hint: "Learning-rate Adam — mặc định 0,01." },
  { key: "l2", label: "L2 weight decay", min: 0, max: 0.01, step: 0.0005, integer: false, hint: "Phạt trọng số chống quá khớp — áp CHỈ lên W, không áp bias. Mặc định 0." },
  { key: "valFraction", label: "Tỷ lệ tập xác thực", min: 0.1, max: 0.4, step: 0.05, integer: false, hint: "Phần dữ liệu CUỐI (theo thời gian) làm val để early-stop — mặc định 0,2." },
  { key: "seed", label: "Seed ngẫu nhiên", min: 0, max: 999999, step: 1, integer: true, hint: "Khởi tạo + xáo trộn deterministic (mulberry32) — cùng seed ra cùng mô hình." },
];

export const RAG_TUNING_FIELDS: TuningFieldSpec[] = [
  { key: "topK", label: "Top-K tài liệu", min: 1, max: 20, step: 1, integer: true, hint: "Số dòng tri thức tiêm prompt mỗi chu kỳ." },
  { key: "k1", label: "BM25 k₁", min: 0.5, max: 3, step: 0.05, integer: false, hint: "Điều hòa bão hoà tần suất từ — mặc định 1,5." },
  { key: "b", label: "BM25 b", min: 0, max: 1, step: 0.05, integer: false, hint: "Chuẩn hoá độ dài tài liệu — mặc định 0,75." },
  { key: "wRecency", label: "Trọng số recency", min: 0, max: 1, step: 0.05, integer: false, hint: "Điểm = (1−w)·BM25 + w·độ-tươi — mặc định 0,3." },
];

const FIELD_INDEX: Record<string, TuningFieldSpec> = Object.fromEntries(
  [...MLP_TUNING_FIELDS, ...RAG_TUNING_FIELDS].map((f) => [f.key, f])
);

/** Kẹp 1 giá trị vào phạm vi hợp lệ của field (integer → round). */
function clampField(v: number, spec: TuningFieldSpec): number {
  const clamped = Math.min(spec.max, Math.max(spec.min, v));
  return spec.integer ? Math.round(clamped) : clamped;
}

/** Kẹp 1 lớp ẩn vào [minNeurons, MLP_MAX_NEURONS] (phòng thủ ghi tay DB). */
function clampNeuron(v: number): number {
  const n = Math.round(v);
  return Math.min(MLP_MAX_NEURONS, Math.max(MLP_ARCH_LIMITS.minNeurons, n));
}

/** Kẹp 1 trọng số loss vào [0,1 · 10]. */
function clampLossWeight(v: number): number {
  return Math.min(MLP_ARCH_LIMITS.lossWeightMax, Math.max(MLP_ARCH_LIMITS.lossWeightMin, v));
}

/**
 * Hoà giải activations về đúng độ dài hidden: thiếu →補 relu, thừa → cắt.
 * lossWeights thiếu số → 1. Dùng cho cả read (phòng thủ) lẫn effective merge.
 */
function reconcileMlpPartial(p: Partial<MlpTuning>): Partial<MlpTuning> {
  const out: Partial<MlpTuning> = { ...p };
  if (out.hidden != null) {
    const acts: MlpActivation[] = [];
    const src = out.activations ?? [];
    for (let i = 0; i < out.hidden.length; i++) {
      const v = src[i];
      acts.push(v === "tanh" || v === "sigmoid" || v === "relu" ? v : "relu");
    }
    out.activations = acts;
  }
  if (out.lossWeights != null && out.lossWeights.length === 3) {
    // đã kẹp khi đọc — giữ nguyên
  } else if (out.hidden != null) {
    out.lossWeights = [1, 1, 1];
  }
  return out;
}

/* ─────────────────── Đọc / ghi (fail-soft) ─────────────────── */

/**
 * Đọc AppSetting "ml-tuning". Trả {} khi chưa có / hỏng / DB lỗi —
 * caller merge với mặc định. Trường đã lưu nhưng ngoài phạm vi → kẹp vào
 * phạm vi (phòng thủ bản ghi tay trong DB).
 * Migration #94: parsed.mlp có h1/h2 mà KHÔNG có hidden → hidden = [h1, h2]
 * (activations relu×2 — đúng hành vi bản cũ); các trường mới thiếu →
 * effective merge bổ sung mặc định (semantic partial như cũ).
 *
 * Logic parse thuần tách ra `parseMlTuningValue` (F-MLP-10 · fixbug FB-4B) —
 * scripts/ml-arch-verify.ts T10 test migration h1/h2 bằng object giả lập,
 * KHÔNG cần đụng DB (giữ script hermetic 100% in-memory).
 */
export async function readMlTuning(): Promise<MlTuning> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: ML_TUNING_KEY } });
    if (!row) return {};
    return parseMlTuningValue(JSON.parse(row.value));
  } catch (err) {
    console.error("[ml/tuning] readMlTuning lỗi (fail-soft → mặc định):", err);
    return {};
  }
}

/**
 * Parse THẦN 1 giá trị AppSetting ml-tuning (đã JSON.parse) → MlTuning chỉ
 * giữ trường hợp lệ (kẹp phạm vi, lọc mảng rác). Throwing khi JSON hỏng là
 * việc của caller (readMlTuning nuốt → {}). Migration #94 h1/h2 → hidden
 * [h1,h2] + activations relu×2 chạy Ở ĐÂY — giá trị cũ ĐƯỢC GIỮ.
 */
export function parseMlTuningValue(parsed: unknown): MlTuning {
  const p = (parsed ?? {}) as Partial<MlTuning> & {
    mlp?: Partial<MlpTuning> & { h1?: unknown; h2?: unknown };
  };
  const out: MlTuning = {};
  const m = (p.mlp ?? {}) as Partial<MlpTuning> & { h1?: unknown; h2?: unknown };
  const mlp: Partial<MlpTuning> = {};
  for (const key of ["epochs", "patience", "batchSize", "lr", "l2", "valFraction", "seed"] as const) {
    const v = m[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      mlp[key] = clampField(v, FIELD_INDEX[key]);
    }
  }
  if (Array.isArray(m.hidden)) {
    // hidden đã là mảng (#94) — lọc số hợp lệ + kẹp từng lớp + 1..5 lớp.
    const hidden = m.hidden
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
      .map(clampNeuron)
      .slice(0, MLP_ARCH_LIMITS.maxLayers);
    if (hidden.length >= MLP_ARCH_LIMITS.minLayers) mlp.hidden = hidden;
  } else if (typeof m.h1 === "number" || typeof m.h2 === "number") {
    // Migration #89 → #94: h1/h2 (2 lớp ẩn cố định) → hidden 2 lớp.
    const h1 = typeof m.h1 === "number" && Number.isFinite(m.h1) ? clampNeuron(m.h1) : MLP_TUNING_DEFAULT.hidden[0];
    const h2 = typeof m.h2 === "number" && Number.isFinite(m.h2) ? clampNeuron(m.h2) : MLP_TUNING_DEFAULT.hidden[1];
    mlp.hidden = [h1, h2];
  }
  if (Array.isArray(m.activations)) {
    const acts = m.activations.filter(
      (v): v is MlpActivation => v === "relu" || v === "tanh" || v === "sigmoid"
    );
    if (acts.length >= 1) mlp.activations = acts.slice(0, MLP_ARCH_LIMITS.maxLayers);
  }
  if (Array.isArray(m.lossWeights) && m.lossWeights.length === 3) {
    const [a, b, c] = m.lossWeights;
    if ([a, b, c].every((v) => typeof v === "number" && Number.isFinite(v))) {
      mlp.lossWeights = [clampLossWeight(a), clampLossWeight(b), clampLossWeight(c)];
    }
  }
  const reconciled = reconcileMlpPartial(mlp);
  if (Object.keys(reconciled).length > 0) out.mlp = reconciled as MlpTuning;
  const r = (p.rag ?? {}) as Partial<RagTuning>;
  const rag: Partial<RagTuning> = {};
  for (const key of ["topK", "k1", "b", "wRecency"] as const) {
    const v = r[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      rag[key] = clampField(v, FIELD_INDEX[key]);
    }
  }
  if (Object.keys(rag).length > 0) out.rag = rag as RagTuning;
  if (typeof p.updatedAt === "string") out.updatedAt = p.updatedAt;
  return out;
}

/** Merge đã lưu + mặc định — giá trị HIỆU LỰC mà train/rag sẽ dùng. */
export function effectiveMlTuning(saved: MlTuning): { mlp: MlpTuning; rag: RagTuning } {
  const merged = { ...MLP_TUNING_DEFAULT, ...saved.mlp };
  // Hoà giải activations đúng độ dài hidden cuối cùng (pad relu / cắt).
  const acts: MlpActivation[] = [];
  const src = merged.activations ?? [];
  for (let i = 0; i < merged.hidden.length; i++) {
    const v = src[i];
    acts.push(v === "tanh" || v === "sigmoid" || v === "relu" ? v : "relu");
  }
  merged.activations = acts;
  merged.lossWeights = [1, 1, 1].map((d, i) => merged.lossWeights?.[i] ?? d) as [
    number,
    number,
    number,
  ];
  return {
    mlp: merged,
    rag: { ...RAG_TUNING_DEFAULT, ...saved.rag },
  };
}

/** Đọc + merge một lần — dùng trong train route / retrieveForCycle / architecture. */
export async function readEffectiveMlTuning(): Promise<{ mlp: MlpTuning; rag: RagTuning }> {
  return effectiveMlTuning(await readMlTuning());
}

/** Ghi AppSetting "ml-tuning" (đã qua validate). False = lỗi DB. */
export async function writeMlTuning(t: MlTuning): Promise<boolean> {
  try {
    const value = JSON.stringify({ ...t, updatedAt: new Date().toISOString() });
    await db.appSetting.upsert({
      where: { key: ML_TUNING_KEY },
      create: { key: ML_TUNING_KEY, value },
      update: { value },
    });
    return true;
  } catch (err) {
    console.error("[ml/tuning] writeMlTuning lỗi:", err);
    return false;
  }
}

/* ─────────────────── Validate input POST ─────────────────── */

export interface TuningSanitizeResult {
  /** Section có trường hợp lệ → trả về CHỈ những trường đó. */
  mlp?: Partial<MlpTuning>;
  rag?: Partial<RagTuning>;
  /** Mỗi dòng 1 lỗi "field: lý do" — 422 khi không rỗng. */
  errors: string[];
}

function isActivation(v: unknown): v is MlpActivation {
  return v === "relu" || v === "tanh" || v === "sigmoid";
}

/**
 * Validate payload POST {mlp?: {…}, rag?: {…}} — chỉ trường ĐƯỢC CUNG CẤP
 * mới được kiểm (semantic partial: gửi {lr: 0,005} giữ nguyên hidden đã lưu).
 * NaN / ngoài phạm vi / khoá lạ → lỗi 422 (không kẹp im lặng — trader phải
 * biết giá trị gửi chưa được chấp nhận). #94: mlp.hidden (mảng 1..5 lớp, mỗi
 * lớp nguyên 2..96) · mlp.activations (mảng relu|tanh|sigmoid, cùng độ dài
 * hidden khi gửi kèm) · mlp.lossWeights (mảng đúng 3 số 0,1..10).
 */
export function sanitizeTuningInput(input: unknown): TuningSanitizeResult {
  const errors: string[] = [];
  const out: TuningSanitizeResult = { errors };
  if (input == null || typeof input !== "object") return out;
  const body = input as Record<string, unknown>;

  /* ── Section MLP: scalar fields + 3 trường mảng ── */
  if (body.mlp != null) {
    if (typeof body.mlp !== "object" || Array.isArray(body.mlp)) {
      errors.push("mlp: phải là object {trường: giá trị}");
    } else {
      const raw = body.mlp as Record<string, unknown>;
      const clean: Partial<MlpTuning> = {};
      for (const [key, value] of Object.entries(raw)) {
        if (key === "hidden" || key === "activations" || key === "lossWeights") continue;
        const spec = FIELD_INDEX[key];
        if (spec == null || !MLP_TUNING_FIELDS.some((f) => f.key === key)) {
          errors.push(`mlp.${key}: khoá không hỗ trợ${key === "h1" || key === "h2" ? " (đã chuyển sang trình chỉnh sửa kiến trúc — tab Mạng thần kinh)" : ""}`);
          continue;
        }
        if (typeof value !== "number" || !Number.isFinite(value)) {
          errors.push(`mlp.${key}: phải là số`);
          continue;
        }
        if (spec.integer && !Number.isInteger(value)) {
          errors.push(`mlp.${key}: phải là số nguyên`);
          continue;
        }
        if (value < spec.min || value > spec.max) {
          errors.push(`mlp.${key}: ngoài phạm vi [${spec.min} – ${spec.max}]`);
          continue;
        }
        (clean as Record<string, number>)[key] = value;
      }
      // hidden — mảng 1..5 số nguyên 2..96
      if ("hidden" in raw) {
        const h = raw.hidden;
        if (!Array.isArray(h)) {
          errors.push("mlp.hidden: phải là mảng số nguyên (số nơ-rôn từng lớp ẩn)");
        } else if (h.length < MLP_ARCH_LIMITS.minLayers || h.length > MLP_ARCH_LIMITS.maxLayers) {
          errors.push(
            `mlp.hidden: số lớp ẩn phải ${MLP_ARCH_LIMITS.minLayers}..${MLP_ARCH_LIMITS.maxLayers} (nhận ${h.length})`
          );
        } else if (h.some((v) => typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v))) {
          errors.push("mlp.hidden: mỗi lớp phải là số nguyên nơ-rôn");
        } else if (h.some((v) => v < MLP_ARCH_LIMITS.minNeurons || v > MLP_ARCH_LIMITS.maxNeurons)) {
          errors.push(
            `mlp.hidden: nơ-rôn mỗi lớp ngoài phạm vi [${MLP_ARCH_LIMITS.minNeurons} – ${MLP_ARCH_LIMITS.maxNeurons}]`
          );
        } else {
          clean.hidden = h as number[];
        }
      }
      // activations — mảng relu|tanh|sigmoid
      if ("activations" in raw) {
        const a = raw.activations;
        if (!Array.isArray(a)) {
          errors.push("mlp.activations: phải là mảng (relu | tanh | sigmoid)");
        } else if (a.some((v) => !isActivation(v))) {
          errors.push("mlp.activations: chỉ nhận relu | tanh | sigmoid");
        } else if (a.length < MLP_ARCH_LIMITS.minLayers || a.length > MLP_ARCH_LIMITS.maxLayers) {
          errors.push(
            `mlp.activations: số activation phải ${MLP_ARCH_LIMITS.minLayers}..${MLP_ARCH_LIMITS.maxLayers} (nhận ${a.length})`
          );
        } else {
          clean.activations = a as MlpActivation[];
        }
      }
      // lossWeights — đúng 3 số 0,1..10 (thứ tự class [DOWN, FLAT, UP])
      if ("lossWeights" in raw) {
        const w = raw.lossWeights;
        if (!Array.isArray(w)) {
          errors.push("mlp.lossWeights: phải là mảng 3 số (trọng số loss từng đầu ra)");
        } else if (w.length !== 3) {
          errors.push(`mlp.lossWeights: phải đúng 3 số [Giảm, Đi ngang, Tăng] (nhận ${w.length})`);
        } else if (w.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
          errors.push("mlp.lossWeights: mỗi trọng số phải là số");
        } else if (w.some((v) => v < MLP_ARCH_LIMITS.lossWeightMin || v > MLP_ARCH_LIMITS.lossWeightMax)) {
          errors.push(
            `mlp.lossWeights: trọng số ngoài phạm vi [${MLP_ARCH_LIMITS.lossWeightMin} – ${MLP_ARCH_LIMITS.lossWeightMax}]`
          );
        } else {
          clean.lossWeights = w as [number, number, number];
        }
      }
      // Gửi kèm cả hidden + activations → phải cùng độ dài.
      if (clean.hidden != null && clean.activations != null && clean.hidden.length !== clean.activations.length) {
        errors.push(
          `mlp.activations: phải cùng độ dài với mlp.hidden (${clean.hidden.length} lớp — nhận ${clean.activations.length} activation)`
        );
      }
      if (Object.keys(clean).length > 0) out.mlp = clean;
    }
  }

  /* ── Section RAG: scalar fields (giữ nguyên #89) ── */
  if (body.rag != null) {
    if (typeof body.rag !== "object" || Array.isArray(body.rag)) {
      errors.push("rag: phải là object {trường: số}");
    } else {
      const clean: Record<string, number> = {};
      for (const [key, value] of Object.entries(body.rag as Record<string, unknown>)) {
        const spec = FIELD_INDEX[key];
        if (spec == null || !RAG_TUNING_FIELDS.some((f) => f.key === key)) {
          errors.push(`rag.${key}: khoá không hỗ trợ`);
          continue;
        }
        if (typeof value !== "number" || !Number.isFinite(value)) {
          errors.push(`rag.${key}: phải là số`);
          continue;
        }
        if (spec.integer && !Number.isInteger(value)) {
          errors.push(`rag.${key}: phải là số nguyên`);
          continue;
        }
        if (value < spec.min || value > spec.max) {
          errors.push(`rag.${key}: ngoài phạm vi [${spec.min} – ${spec.max}]`);
          continue;
        }
        clean[key] = value;
      }
      if (Object.keys(clean).length > 0) out.rag = clean as Partial<RagTuning>;
    }
  }
  return out;
}

/* ─────────────────── Audit (fail-soft) ─────────────────── */

/** Ghi AuditLog cho mọi thao tác tinh chỉnh — lỗi audit không chặn chính. */
export async function logMlAudit(
  action: string,
  entity: string,
  entityId: string | null,
  after: unknown
): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        action,
        entity,
        ...(entityId ? { entityId } : {}),
        after: JSON.stringify(after),
      },
    });
  } catch (err) {
    console.error(`[ml/tuning] audit ${action} lỗi (bỏ qua):`, err);
  }
}
