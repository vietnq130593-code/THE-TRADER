/**
 * src/lib/ml/psi-retrain.ts — W3 (#164 · review #162): AUTO-RETRAIN THEO PSI
 * CÓ GUARD.
 *
 * Điểm yếu W3: A3 PSI chỉ cảnh báo — `retrainRecommended` trong /api/ml/status
 * là cờ hiển thị, lịch A4 Chủ nhật 04:00 chạy 1 lần/tuần → model đóng băng vô
 * thời hạn nếu PSI breach giữa tuần mà không ai bấm train tay (A4).
 *
 * Vá: POST /api/ml/psi-retrain (engine :3003 đôn đốc T2–T6 17:00 ICT sau
 * EOD-sync, mỗi 15 phút) — đo PSI bằng CHÍNH lớp driftForServing của status
 * route (lib drift.ts — một phép đo, một TTL cache) rồi đi qua 5 GUARD trước
 * khi train:
 *
 *   G1 kill-switch  — AppSetting "ml-psi-retrain" {enabled:false} → im hẳn
 *                     (mặc định BẬT khi chưa có key: lý do tồn tại của W3 là
 *                     vá "đóng băng vô thời hạn"; kill-switch để TẮT khi cần).
 *   G2 cooldown 24h — đã từng trigger trong 24h qua (AuditLog ML_PSI_RETRAIN
 *                     gần nhất) → skip. PSI breach thường kéo dài nhiều ngày —
 *                     không đánh dấu thì engine đấm train mỗi 15 phút.
 *   G3 ngưỡng      — maxPsi < PSI_WARN (0,25) → skip "psi-below" (trạng thái
 *                     bình thường, KHÔNG audit — tránh 96 audit rác/ngày).
 *   G4 windowHash  — PSI breach nhưng cửa sổ dữ liệu TRÙNG bản serving/latest
 *                     (không có bar mới) → train lại là deterministic vô
 *                     nghĩa (mirror skip-guard A4) → skip + audit (đáng giám
 *                     sát: drift không thể vá bằng dữ liệu chưa có).
 *   G5 mutex/cooldown train — dùng CHÍNH tryAcquireTrainLock + cooldown 60s
 *                     của lib train-mlp.ts (chia sẻ với train tay + sweep —
 *                     không bao giờ 2 train chạy chồng).
 *
 * Sau cùng bản mới vẫn qua serving-swap guard NỘI TẠI của trainDlMlp (valAcc ≥
 * bản serving mới lên serving — thua thì lưu archived, serving giữ nguyên):
 * auto-retrain không bao giờ làm serving tệ hơn theo thước đo valAcc cùng
 * cửa sổ dữ liệu. Mọi lần ĐÃ train đều audit ML_PSI_RETRAIN (truy vết như
 * ML_TRAIN_AUTO #F-00).
 *
 * Decision logic tách hàm THUẦN (0 DB) để scripts/p164-verify-psi-retrain.ts
 * kiểm định từng guard — route chỉ là lớp IO mỏng.
 */

import { db } from "@/lib/db";
import { PSI_WARN } from "@/lib/ml/psi";

/** Kill-switch + cấu hình — AppSetting key (giữ nguyên shape JSON mở rộng). */
export const PSI_RETRAIN_SETTING_KEY = "ml-psi-retrain";
/** Audit action — mọi lần ĐÃ train (hoặc G4 chặn) đều ghi (F-00: im lặng là
 *  lỗi giám sát; riêng psi-below/disabled/cooldown là trạng thái bình thường
 *  không audit để không dồn cục bảng AuditLog). */
export const PSI_RETRAIN_AUDIT_ACTION = "ML_PSI_RETRAIN";
/** G2 — tần suất trigger tối đa 1 lần/24h (PSI breach kéo dài nhiều ngày). */
export const PSI_RETRAIN_COOLDOWN_HOURS = 24;

/* ─────────────────── Decision thuần (0 DB — script verify được) ─────────────────── */

/** Kết quả cổng G1–G3 (G4 windowHash + G5 mutex nằm ở caller — cần dữ liệu). */
export type PsiRetrainGateOutcome =
  | "disabled"
  | "cooldown"
  | "psi-unavailable"
  | "psi-below"
  | "proceed";

export interface PsiRetrainGateInput {
  /** G1 — kill-switch AppSetting (default true khi chưa có key). */
  enabled: boolean;
  /** G2 — mốc (epoch ms) AuditLog ML_PSI_RETRAIN gần nhất; null = chưa từng. */
  lastTriggerAt: number | null;
  /** Thời điểm quyết định (epoch ms). */
  now: number;
  /** PSI max của bản serving; null = drift unavailable (bản cũ/không histogram). */
  maxPsi: number | null;
  /** Ngưỡng kích hoạt — mặc định PSI_WARN 0,25 (chuẩn A3 "dịch-chuyển"). */
  psiWarn?: number;
  /** Cooldown G2 — mặc định 24h. */
  cooldownHours?: number;
}

export interface PsiRetrainGateResult {
  outcome: PsiRetrainGateOutcome;
  /** Giải thích tiếng Việt trả kèm response/audit. */
  reason: string;
  /** Chỉ có khi outcome="cooldown" — ms còn phải đợi tới lúc được trigger. */
  cooldownRemainingMs?: number;
}

/** G1 → G2 → G3 (thứ tự rẻ → đắt: kill-switch, cooldown, PSI). */
export function decidePsiRetrainGate(
  input: PsiRetrainGateInput
): PsiRetrainGateResult {
  if (!input.enabled) {
    return {
      outcome: "disabled",
      reason:
        "kill-switch AppSetting ml-psi-retrain TẮT — auto-retrain theo PSI bị khoá (nút train tay vẫn chạy được)",
    };
  }
  const cooldownHours =
    input.cooldownHours != null && Number.isFinite(input.cooldownHours) && input.cooldownHours > 0
      ? input.cooldownHours
      : PSI_RETRAIN_COOLDOWN_HOURS;
  if (input.lastTriggerAt != null) {
    const elapsed = input.now - input.lastTriggerAt;
    const cooldownMs = cooldownHours * 3_600_000;
    // F-166b-6 (Fixbug #166 — Vòng 1): mốc audit ở TƯƠNG LAI (clock-skew
    // nguồn ghi ≠ nguồn đọc) → elapsed < 0 — vẫn coi như đang cooldown
    // (fail-safe: lệch giờ không được phép bypass 24h).
    if (elapsed < cooldownMs) {
      return {
        outcome: "cooldown",
        reason: `đã trigger auto-retrain cách đây ${(Math.max(0, elapsed) / 3_600_000).toFixed(1)}h — cooldown ${cooldownHours}h (PSI breach kéo dài nhiều ngày, không đấm train mỗi 15 phút)`,
        cooldownRemainingMs: cooldownMs - elapsed,
      };
    }
  }
  if (input.maxPsi == null || !Number.isFinite(input.maxPsi)) {
    return {
      outcome: "psi-unavailable",
      reason:
        "chưa đo được PSI của bản serving (chưa có featureHist / lỗi đo) — không quyết định auto-retrain trên số thiếu",
    };
  }
  // O-1 (Fixbug #166 — Vòng Xác Nhận): psiWarn NaN/Infinity → mặc định
  // PSI_WARN (mirror finite-guard của cooldownHours — không để NaN so sánh
  // luôn false/rồi lọt proceed).
  const psiWarnRaw = input.psiWarn ?? PSI_WARN;
  const psiWarn =
    Number.isFinite(psiWarnRaw) && psiWarnRaw > 0 ? psiWarnRaw : PSI_WARN;
  if (input.maxPsi < psiWarn) {
    return {
      outcome: "psi-below",
      reason: `PSI max ${input.maxPsi.toFixed(4)} < ${psiWarn} — chưa tới ngưỡng dịch-chuyển, không cần train lại`,
    };
  }
  return {
    outcome: "proceed",
    reason: `PSI max ${input.maxPsi.toFixed(4)} ≥ ${psiWarn} (dịch-chuyển) — đủ điều kiện xem xét train lại`,
  };
}

/** G4 — windowHash có TRÙNG bản serving HOẶC bản vừa train gần nhất (cùng
 *  featureSet) không. Trùng → train lại deterministic vô nghĩa (mirror
 *  skip-guard A4 route train; hash không đổi khi đổi đặc trưng nên so kèm
 *  featureSet cho latest). */
export function psiRetrainWindowBlocked(input: {
  windowHash: string;
  servingHash: string | null;
  latestHash: string | null;
  latestFeatureSet: string;
  currentFeatureSet: string;
}): { blocked: boolean; matched: "serving" | "latest" | null } {
  if (input.servingHash != null && input.servingHash === input.windowHash) {
    return { blocked: true, matched: "serving" };
  }
  if (
    input.latestHash != null &&
    input.latestHash === input.windowHash &&
    input.latestFeatureSet === input.currentFeatureSet
  ) {
    return { blocked: true, matched: "latest" };
  }
  return { blocked: false, matched: null };
}

/* ─────────────────── DB helpers (fail-soft tuyệt đối) ─────────────────── */

/** G1 — đọc kill-switch. Thiếu key / JSON hỏng / shape sai → mặc định BẬT
 *  (true): W3 tồn tại để vá "đóng băng vô thời hạn" — chỉ tắt khi chủ sở hữu
 *  chủ đích ghi {enabled:false}. Lỗi DB → ném để route trả 500 (engine thử
 *  lại 15' sau) — không tự ý đổi trạng thái cơ chế. */
export async function readPsiRetrainSetting(): Promise<{ enabled: boolean }> {
  const row = await db.appSetting.findUnique({
    where: { key: PSI_RETRAIN_SETTING_KEY },
  });
  if (!row) return { enabled: true };
  try {
    const parsed = JSON.parse(row.value) as { enabled?: unknown };
    return { enabled: parsed.enabled !== false };
  } catch {
    return { enabled: true }; // JSON hỏng → không coi là TẮT (an toàn theo ý nghĩa mặc định)
  }
}

/** G2 — AuditLog ML_PSI_RETRAIN gần nhất (mọi outcome đã audit). Trả null khi
 *  chưa từng / lỗi đọc. Chỉ các outcome SAU cổng PSI mới được audit (xem
 *  writePsiRetrainAudit) nên mốc này đúng nghĩa "lần trigger gần nhất". */
export async function lastPsiRetrainAudit(): Promise<{
  at: Date;
  outcome: string;
} | null> {
  try {
    const row = await db.auditLog.findFirst({
      where: { action: PSI_RETRAIN_AUDIT_ACTION },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, after: true },
    });
    if (!row) return null;
    let outcome = "unknown";
    try {
      const a = JSON.parse(row.after ?? "{}") as { outcome?: unknown };
      if (typeof a.outcome === "string") outcome = a.outcome;
    } catch {
      // after hỏng → vẫn dùng mốc thời gian cho cooldown (thận trọng)
    }
    return { at: row.createdAt, outcome };
  } catch (err) {
    // F-166b-2 (Fixbug #166 — Vòng 1, nguyên tắc F-00: im lặng là lỗi giám
    // sát): lỗi đọc AuditLog cooldown phải hiện trong log. Vẫn return null →
    // G2 fail-open như chủ đích (tầng dưới G4 windowHash + audit lại tự hãm).
    console.error(
      "[ml/psi-retrain] đọc AuditLog cooldown lỗi (fail-open):",
      err
    );
    return null;
  }
}

/** Ghi audit (fail-soft: lỗi audit không chặn luồng train — pattern route
 *  train ML_TRAIN_AUTO). Chỉ gọi cho outcome ĐÁNG GIÁM SÁT: trained-promoted
 *  · trained-not-promoted · no-new-window (skip-psi-below/disabled/cooldown
 *  là trạng thái bình thường — không dồn cục AuditLog). */
export async function writePsiRetrainAudit(
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        action: PSI_RETRAIN_AUDIT_ACTION,
        entity: "MlModel",
        entityId: null,
        after: JSON.stringify(payload),
      },
    });
  } catch (err) {
    console.error("[ml/psi-retrain] audit ML_PSI_RETRAIN lỗi (bỏ qua):", err);
  }
}
