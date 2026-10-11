/**
 * src/lib/ml/tuning.ts — CẤU HÌNH TINH CHỈNH ML (phiên #89).
 *
 * AppSetting key "ml-tuning" — nơi trader TỰ Ý điều chỉnh hyperparameters
 * MLP (kích thước lớp ẩn, epoch, patience, batch, lr) và tham số RAG BM25
 * (topK, k₁, b, trọng số recency) qua tab "Tinh chỉnh" của module Học máy.
 *
 * Nguyên tắc (theo pattern k-run/k-sandbox #86/#87):
 *   - Fail-soft tuyệt đối: key chưa tạo / JSON hỏng / DB lỗi → trả {} →
 *     mọi caller dùng MẶC ĐỊNH CODE — hành vi trước #89 không đổi một li.
 *   - Đọc tại thời điểm chạy: train route đọc trước mỗi lần huấn luyện,
 *     retrieveForCycle đọc trước mỗi lần truy hồi — không cache dài.
 *   - Một nguồn sự thật cho mặc định: MLP defaults import từ nn.ts
 *     (MLP_ARCH_V2 + MLP_FIT_DEFAULTS), RAG defaults định nghĩa Ở ĐÂY và
 *     rag.ts dùng lại (rag → tuning, không vòng lặp import).
 *   - Ghi luôn AuditLog ML_TUNING_UPDATED / ML_GRU_TOGGLE / ML_BANDIT_RESET
 *     (fail-soft — audit lỗi không chặn thao tác chính).
 */

import { db } from "@/lib/db";
import { MLP_ARCH_V2, MLP_FIT_DEFAULTS } from "@/lib/ml/nn";

export const ML_TUNING_KEY = "ml-tuning";

/* ─────────────────── Types ─────────────────── */

/** Hyperparameters MLP — thiếu trường nào dùng mặc định trường đó. */
export interface MlpTuning {
  /** Nơ-rôn lớp ẩn 1 (ReLU). Mặc định 24 — MLP_ARCH_V2.h1. */
  h1: number;
  /** Nơ-rôn lớp ẩn 2 (ReLU). Mặc định 12 — MLP_ARCH_V2.h2. */
  h2: number;
  /** Số epoch tối đa (early-stop theo valLoss vẫn áp). Mặc định 60. */
  epochs: number;
  /** Patience early-stop. Mặc định 12. */
  patience: number;
  /** Kích thước mini-batch Adam. Mặc định 32. */
  batchSize: number;
  /** Tốc độ học Adam. Mặc định 0,01. */
  lr: number;
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
  h1: MLP_ARCH_V2.h1,
  h2: MLP_ARCH_V2.h2,
  epochs: MLP_FIT_DEFAULTS.maxEpochs,
  patience: MLP_FIT_DEFAULTS.patience,
  batchSize: MLP_FIT_DEFAULTS.batchSize,
  lr: MLP_FIT_DEFAULTS.learningRate,
};

/** rag.ts dùng lại đúng object này — KHÔNG định nghĩa hằng số riêng nữa. */
export const RAG_TUNING_DEFAULT: RagTuning = {
  topK: 8,
  k1: 1.5,
  b: 0.75,
  wRecency: 0.3,
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

export const MLP_TUNING_FIELDS: TuningFieldSpec[] = [
  { key: "h1", label: "Nơ-rôn lớp ẩn 1", min: 8, max: 64, step: 1, integer: true, hint: "Số nơ-rôn ReLU lớp ẩn đầu — mặc định 24." },
  { key: "h2", label: "Nơ-rôn lớp ẩn 2", min: 4, max: 48, step: 1, integer: true, hint: "Số nơ-rôn ReLU lớp ẩn thứ hai — mặc định 12." },
  { key: "epochs", label: "Epoch tối đa", min: 10, max: 200, step: 1, integer: true, hint: "Early-stop theo valLoss vẫn áp dụng trước khi chạm n." },
  { key: "patience", label: "Patience", min: 3, max: 50, step: 1, integer: true, hint: "Số epoch không cải thiện valLoss trước khi dừng sớm." },
  { key: "batchSize", label: "Kích thước batch", min: 8, max: 128, step: 1, integer: true, hint: "Mini-batch của tối ưu Adam." },
  { key: "lr", label: "Tốc độ học (lr)", min: 0.0005, max: 0.1, step: 0.0005, integer: false, hint: "Learning-rate Adam — mặc định 0,01." },
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

/* ─────────────────── Đọc / ghi (fail-soft) ─────────────────── */

/** Kẹp 1 giá trị vào phạm vi hợp lệ của field (integer → round). */
function clampField(v: number, spec: TuningFieldSpec): number {
  const clamped = Math.min(spec.max, Math.max(spec.min, v));
  return spec.integer ? Math.round(clamped) : clamped;
}

/**
 * Đọc AppSetting "ml-tuning". Trả {} khi chưa có / hỏng / DB lỗi —
 * caller merge với mặc định. Trường đã lưu nhưng ngoài phạm vi → kẹp vào
 * phạm vi (phòng thủ bản ghi tay trong DB).
 */
export async function readMlTuning(): Promise<MlTuning> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: ML_TUNING_KEY } });
    if (!row) return {};
    const parsed = JSON.parse(row.value) as Partial<MlTuning>;
    const out: MlTuning = {};
    const m = (parsed.mlp ?? {}) as Partial<MlpTuning>;
    const mlp: Partial<MlpTuning> = {};
    for (const key of ["h1", "h2", "epochs", "patience", "batchSize", "lr"] as const) {
      const v = m[key];
      if (typeof v === "number" && Number.isFinite(v)) {
        mlp[key] = clampField(v, FIELD_INDEX[key]);
      }
    }
    if (Object.keys(mlp).length > 0) out.mlp = mlp as MlpTuning;
    const r = (parsed.rag ?? {}) as Partial<RagTuning>;
    const rag: Partial<RagTuning> = {};
    for (const key of ["topK", "k1", "b", "wRecency"] as const) {
      const v = r[key];
      if (typeof v === "number" && Number.isFinite(v)) {
        rag[key] = clampField(v, FIELD_INDEX[key]);
      }
    }
    if (Object.keys(rag).length > 0) out.rag = rag as RagTuning;
    if (typeof parsed.updatedAt === "string") out.updatedAt = parsed.updatedAt;
    return out;
  } catch (err) {
    console.error("[ml/tuning] readMlTuning lỗi (fail-soft → mặc định):", err);
    return {};
  }
}

/** Merge đã lưu + mặc định — giá trị HIỆU LỰC mà train/rag sẽ dùng. */
export function effectiveMlTuning(saved: MlTuning): { mlp: MlpTuning; rag: RagTuning } {
  return {
    mlp: { ...MLP_TUNING_DEFAULT, ...saved.mlp },
    rag: { ...RAG_TUNING_DEFAULT, ...saved.rag },
  };
}

/** Đọc + merge một lần — dùng trong train route / retrieveForCycle. */
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

/**
 * Validate payload POST {mlp?: {...}, rag?: {...}} — chỉ trường ĐƯỢC CUNG CẤP
 * mới được kiểm (semantic partial: gửi {h1: 28} giữ nguyên lr đã lưu).
 * NaN / ngoài phạm vi / khoá lạ → lỗi 422 (không kẹp im lặng — trader phải
 * biết giá trị gửi chưa được chấp nhận).
 */
export function sanitizeTuningInput(input: unknown): TuningSanitizeResult {
  const errors: string[] = [];
  const out: TuningSanitizeResult = { errors };
  if (input == null || typeof input !== "object") return out;
  const body = input as Record<string, unknown>;

  const checkSection = (
    section: "mlp" | "rag",
    raw: unknown,
    keys: readonly string[],
    sink: (clean: Record<string, number>) => void
  ): void => {
    if (raw == null) return;
    if (typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`${section}: phải là object {trường: số}`);
      return;
    }
    const clean: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const spec = FIELD_INDEX[key];
      if (spec == null || !keys.includes(key)) {
        errors.push(`${section}.${key}: khoá không hỗ trợ`);
        continue;
      }
      if (typeof value !== "number" || !Number.isFinite(value)) {
        errors.push(`${section}.${key}: phải là số`);
        continue;
      }
      if (spec.integer && !Number.isInteger(value)) {
        errors.push(`${section}.${key}: phải là số nguyên`);
        continue;
      }
      if (value < spec.min || value > spec.max) {
        errors.push(`${section}.${key}: ngoài phạm vi [${spec.min} – ${spec.max}]`);
        continue;
      }
      clean[key] = value;
    }
    if (Object.keys(clean).length > 0) sink(clean);
  };

  checkSection("mlp", body.mlp, MLP_TUNING_FIELDS.map((f) => f.key), (clean) => {
    out.mlp = clean as Partial<MlpTuning>;
  });
  checkSection("rag", body.rag, RAG_TUNING_FIELDS.map((f) => f.key), (clean) => {
    out.rag = clean as Partial<RagTuning>;
  });
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
