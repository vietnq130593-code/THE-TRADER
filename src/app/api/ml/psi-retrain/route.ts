import { NextResponse } from "next/server";
import { guardSameOrigin } from "@/lib/api-guards";
import { db } from "@/lib/db";
// W3 (#164) — drift đo qua CHÍNH lớp của status route (lib drift.ts, TTL cache
// dùng chung): auto-retrain quyết định trên cùng phép đo PSI đang hiển thị.
import { driftForServing } from "@/lib/ml/drift";
import {
  buildTrainingSet,
  trainingWindowDigest,
  type TrainingSetWithSeries,
} from "@/lib/ml/features";
// A4 skip-guard windowHash + train + mutex/cooldown — trích dùng chung từ lib
// train-mlp.ts (chia sẻ với train tay + sweep: không bao giờ 2 train chồng).
import {
  clearTrainCooldown,
  markTrainAttempt,
  recentWindowHashesOf,
  releaseTrainLock,
  trainCooldownState,
  trainDlMlp,
  tryAcquireTrainLock,
} from "@/lib/ml/train-mlp";
// F-18 (#131): featureSet của tập build theo ml-tuning đang hiệu lực (đúng
// đường A4 force=false của route train — không tự chế bộ đặc trưng thứ 2).
import { readEffectiveMlTuning } from "@/lib/ml/tuning";
import {
  decidePsiRetrainGate,
  lastPsiRetrainAudit,
  psiRetrainWindowBlocked,
  readPsiRetrainSetting,
  writePsiRetrainAudit,
} from "@/lib/ml/psi-retrain";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const runtime = "nodejs";

/**
 * POST /api/ml/psi-retrain (W3 #164 · review #162 — "PSI chỉ cảnh báo, model
 * đóng băng vô thời hạn nếu không ai bấm train tay").
 *
 * Auto-retrain dl-mlp khi PSI ≥ 0,25 (ngưỡng "dịch-chuyển" A3) — 5 GUARD
 * trước khi train (xem banner lib psi-retrain.ts): kill-switch AppSetting
 * "ml-psi-retrain" · cooldown 24h (AuditLog ML_PSI_RETRAIN) · ngưỡng PSI ·
 * windowHash skip-guard (mirror A4 — không bar mới thì train lại vô nghĩa) ·
 * mutex/cooldown train dùng chung train tay + sweep. Sau cùng serving-swap
 * guard NỘI TẠI trainDlMlp (valAcc < bản serving → archived, KHÔNG đổi
 * serving) — auto-retrain không bao giờ làm serving tệ hơn theo valAcc.
 *
 * Caller: engine :3003 (due-check T2–T6 17:00 ICT sau EOD-sync, nhịp 15
 * phút, guard in-flight). Nút tay trên UI giữ nguyên đường /api/ml/train
 * (force=true) — route này KHÔNG thay nút tay, chỉ vá "không ai theo dõi".
 *
 * Response mọi đường 200 + outcome (engine log, không parse lỗi HTTP):
 *   skip-psi-below | skip-disabled | skip-cooldown | skip-psi-unavailable |
 *   skip-no-new-window | trained-promoted | trained-not-promoted | error.
 * Chỉ 429 (mutex/cooldown train đang bận — thử lại 15' sau) là ngoài 200.
 * Audit ML_PSI_RETRAIN chỉ ghi outcome ĐÁNG GIÁM SÁT (trained* /
 * no-new-window) — psi-below là trạng thái bình thường, không dồn AuditLog.
 */
export async function POST(req: Request) {
  // F-166b-7 (#167) — POST /api/ml/* chỉ nhận same-origin (engine :3003
  // postJson không Origin → đi qua — đúng caller chính của route này).
  const originGuard = guardSameOrigin(req);
  if (originGuard) return originGuard;
  const started = Date.now();
  let trainLockHeld = false;
  try {
    // G1 — kill-switch (lỗi DB → 500, engine retry; không tự đổi trạng thái).
    const { enabled } = await readPsiRetrainSetting();
    // G2 — cooldown 24h từ AuditLog gần nhất.
    const lastAudit = await lastPsiRetrainAudit();
    // Bản serving dl-mlp — đầu vào của phép đo PSI.
    const dlRow = await db.mlModel.findFirst({
      where: { kind: "dl-mlp", status: "serving" },
      orderBy: { version: "desc" },
      select: { version: true, trainedAt: true, meta: true },
    });
    if (!dlRow) {
      return NextResponse.json({
        ok: true,
        outcome: "skip-psi-unavailable",
        reason: "chưa có bản dl-mlp serving — không có gì để đo PSI/auto-retrain",
      });
    }
    // Cùng phép đo + TTL cache 15s với GET /api/ml/status (lib drift.ts).
    const drift = await driftForServing(dlRow);
    const maxPsi =
      drift.available === true && Number.isFinite(drift.maxPsi)
        ? drift.maxPsi
        : null;
    const maxDim = drift.available === true ? drift.maxDim : null;

    // G1 → G2 → G3 (decision thuần — scripts/p164 kiểm định từng guard).
    const gate = decidePsiRetrainGate({
      enabled,
      lastTriggerAt: lastAudit?.at.getTime() ?? null,
      now: Date.now(),
      maxPsi,
    });
    if (gate.outcome !== "proceed") {
      return NextResponse.json({
        ok: true,
        outcome: `skip-${gate.outcome}`,
        reason: gate.reason,
        ...(gate.cooldownRemainingMs != null
          ? { cooldownRemainingMs: gate.cooldownRemainingMs }
          : {}),
        maxPsi,
        servingVersion: dlRow.version,
      });
    }

    // G5a — cooldown 60s + mutex train (CHIA SẺ với train tay + sweep):
    // bận → 429, engine due-check 15' sau tự thử lại.
    const now = Date.now();
    const cooldown = trainCooldownState(now);
    if (cooldown.retryAfterSeconds != null) {
      return NextResponse.json(
        {
          error: `Train vừa chạy cách đây ${Math.floor(cooldown.sinceLastMs / 1000)}s (cooldown dùng chung train tay/sweep) — đợi ${cooldown.retryAfterSeconds}s.`,
          retryAfterSeconds: cooldown.retryAfterSeconds,
        },
        {
          status: 429,
          headers: { "Retry-After": String(cooldown.retryAfterSeconds) },
        }
      );
    }
    if (!tryAcquireTrainLock()) {
      return NextResponse.json(
        {
          error:
            "Train đang chạy (mutex dùng chung train tay/sweep) — auto-retrain PSI nhường, thử lại nhịp check sau.",
        },
        { status: 429, headers: { "Retry-After": "30" } }
      );
    }
    trainLockHeld = true;

    // G4 — windowHash skip-guard (mirror A4 force=false): build tập THEO
    // featureSet hiệu lực (ml-tuning), so hash với serving + latest cùng
    // featureSet. Trùng → PSI breach nhưng KHÔNG có bar mới → train lại
    // deterministic vô nghĩa → skip + audit (drift không vá được bằng dữ
    // liệu chưa có — Chủ nhật A4 sẽ train khi có bar mới).
    const effective = await readEffectiveMlTuning();
    const set: TrainingSetWithSeries = await buildTrainingSet(20, {
      featureSet: effective.mlp.featureSet === "v3-macro" ? "v3-macro" : undefined,
    });
    // F-166b-3 (#167): v3-macro → 8 chiều MacroContext tại ngày lấy mẫu góp
    // vào windowHash (CHÍNH map buildTrainingSet đã dùng) — macro restated
    // đổi hash → G4 hết skip oan "no-new-window" khi chỉ vĩ mô đổi.
    const windowMeta = trainingWindowDigest(set.series, {
      samples: set.X.length,
      macroByDate: set.macroByDate ?? null,
      sampleDates: set.dates,
    });
    const recent = await recentWindowHashesOf("dl-mlp");
    const currentFeatureSet =
      effective.mlp.featureSet === "v3-macro" ? "v3-macro" : "v2-lag16";
    const window = psiRetrainWindowBlocked({
      windowHash: windowMeta.windowHash,
      servingHash: recent.serving,
      latestHash: recent.latest,
      latestFeatureSet: recent.latestFeatureSet,
      currentFeatureSet,
    });
    if (window.blocked) {
      await writePsiRetrainAudit({
        outcome: "no-new-window",
        maxPsi,
        maxDim,
        servingVersion: dlRow.version,
        windowHash: windowMeta.windowHash,
        matched: window.matched,
        note: `PSI ${maxPsi?.toFixed(4)} ≥ 0,25 nhưng windowHash trùng bản ${window.matched} (không có bar mới) — train lại deterministic vô nghĩa, nhường cho A4 Chủ nhật khi có dữ liệu mới`,
        durationMs: Date.now() - started,
      });
      return NextResponse.json({
        ok: true,
        outcome: "skip-no-new-window",
        reason: `PSI breach nhưng windowHash trùng bản ${window.matched} — không có bar mới, train lại vô nghĩa`,
        maxPsi,
        maxDim,
        windowHash: windowMeta.windowHash,
        matched: window.matched,
        servingVersion: dlRow.version,
      });
    }

    // Đủ 5 guard → train (markTrainAttempt sau mọi guard để skip không cắm
    // cờ cooldown 60s — pattern route train: 429/400 sớm không mark).
    markTrainAttempt(now);
    try {
      const { metrics, promotion, modelVersion } = await trainDlMlp(set);
      const outcome = promotion?.promoted
        ? "trained-promoted"
        : "trained-not-promoted";
      await writePsiRetrainAudit({
        outcome,
        maxPsi,
        maxDim,
        servingVersion: dlRow.version,
        windowHash: windowMeta.windowHash,
        newVersion: modelVersion,
        promoted: promotion?.promoted ?? false,
        promotionReason: promotion?.reason ?? null,
        valAcc: metrics.valAcc,
        servingValAcc: promotion?.servingValAcc ?? null,
        samples: metrics.samples,
        durationMs: Date.now() - started,
        note: promotion?.promoted
          ? `PSI ${maxPsi?.toFixed(4)} (${maxDim ?? "?"}) — auto-retrain v${modelVersion} lên serving, valAcc ${(metrics.valAcc * 100).toFixed(1)}%`
          : `PSI ${maxPsi?.toFixed(4)} — bản mới v${modelVersion} valAcc ${(metrics.valAcc * 100).toFixed(1)}% ${
              promotion?.servingValAcc != null
                ? `< serving ${(promotion.servingValAcc * 100).toFixed(1)}%`
                : ""
            } → archived, serving giữ nguyên (guard §1.5)`,
      });
      return NextResponse.json({
        ok: true,
        outcome,
        maxPsi,
        maxDim,
        servingVersion: dlRow.version,
        windowHash: windowMeta.windowHash,
        newVersion: modelVersion,
        promoted: promotion?.promoted ?? false,
        promotionReason: promotion?.reason ?? null,
        valAcc: metrics.valAcc,
        servingValAcc: promotion?.servingValAcc ?? null,
        durationMs: Date.now() - started,
      });
    } catch (err) {
      // Train lỗi → KHÔNG audit (không cắm cooldown 24h — engine retry 15'
      // sau khi dữ liệu/CPU kịp; pattern settle "không đánh dấu ngày").
      clearTrainCooldown();
      console.error("[api/ml/psi-retrain] trainDlMlp failed:", err);
      return NextResponse.json({
        ok: false,
        outcome: "error",
        reason: err instanceof Error ? err.message : String(err),
        maxPsi,
        servingVersion: dlRow.version,
        durationMs: Date.now() - started,
      });
    }
  } catch (err) {
    // Lỗi hệ thống (DB/đo PSI) → 500: engine log "LỖI" và thử lại nhịp sau —
    // không nuốt thành skip (im lặng là lỗi giám sát F-00).
    console.error("[api/ml/psi-retrain] POST failed:", err);
    return NextResponse.json(
      {
        ok: false,
        outcome: "error",
        reason: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  } finally {
    if (trainLockHeld) releaseTrainLock();
  }
}
