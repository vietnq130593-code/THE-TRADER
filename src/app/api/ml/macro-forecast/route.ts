import { NextResponse } from "next/server";
import { guardSameOrigin } from "@/lib/api-guards";
import { db } from "@/lib/db";
import {
  macroAssetForecasts,
  trainAllMacroAssets,
  type MacroTrainSummary,
} from "@/lib/ml/macro-forecast";
import { markTrainAttempt, releaseTrainLock, tryAcquireTrainLock } from "@/lib/ml/train-mlp";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * /api/ml/macro-forecast — F-17 (#129-E · AI_ENGINEER_REVIEW_BRAIN v3 §3):
 * serving + huấn luyện MÔ HÌNH DỰ BÁO THỨ HAI cho 8 tài sản vĩ mô
 * (VNINDEX · VN30 · US10Y · US30Y · DX-Y.NYB · VND=X · GC=F · CL=F) —
 * đóng kỳ vọng "trái phiếu" của chủ sở hữu (xem header src/lib/ml/macro-forecast.ts).
 *
 * GET  — macroAssetForecasts(): bảng 8 dòng {direction, p*, confidence,
 *        brier60, baseline 0,667, edge, modelVersion, missingContext} —
 *        tab Mạng thần kinh hiển thị khối riêng.
 * POST — body {"train": true} → trainAllMacroAssets() (8 MLP fail-soft từng
 *        tài sản) RỒI trả forecast + trainSummary. AUDIT 137 B12: train giờ
 *        qua tryAcquireTrainLock DÙNG CHUNG với /api/ml/train + sweep (mutex
 *        in-process kiểu chuỗi Promise module-level chỉ còn chống 2 POST
 *        macro đè nhau — pattern AUD-CODE #18 của /api/ml/settle): hết khả
 *        năng macro train song song với train/sweep (tranh CPU 8×8 fit; kind
 *        khác nên không trùng version, nhưng nextVersion max+1 + create vẫn
 *        là 2 await rời — hàng rào cuối cùng giờ là @@unique([kind, version])
 *        ở DB). Khoá bận → 429 thân thiện. GET KHÔNG qua khoá — đường đọc
 *        luôn nhẹ nhàng (ảnh chụp giữa đợt train vẫn nhất quán từng dòng vì
 *        mỗi dòng tự khóa theo meta.assetSymbol).
 *
 * AuditLog action "MACRO_MLP_TRAINED" entity "MlModel" sau mỗi đợt train
 * (kể cả 0 trained — truy vết "đã chạy", pattern ML_SETTLE): after =
 * {trained: [...], errors: [...]} — fail-soft (audit lỗi không làm hỏng train).
 * Fail-soft 500 thân thiện ở mọi đường outer.
 */

/** AUD-CODE #18 (pattern settle route): mutex in-process — mọi POST chạy tuần tự. */
let macroMutex: Promise<NextResponse> = Promise.resolve(null as unknown as NextResponse);

export async function GET(): Promise<NextResponse> {
  try {
    const forecast = await macroAssetForecasts();
    return NextResponse.json({ ok: true, forecast });
  } catch (err) {
    console.error("[api/ml/macro-forecast] GET failed:", err);
    return NextResponse.json(
      { ok: false, error: "Tải dự báo đa tài sản thất bại. Vui lòng thử lại." },
      { status: 500 }
    );
  }
}

async function runPost(req: Request): Promise<NextResponse> {
  const started = Date.now();
  // Body {train?: boolean} — tolerant (body rỗng/JSON hỏng → không train,
  // chỉ trả forecast như GET nhưng vẫn qua mutex cho đồng nhất nhịp).
  let train = false;
  try {
    const body = (await req.json()) as { train?: unknown } | null;
    if (body && typeof body.train === "boolean") train = body.train;
  } catch {
    // body rỗng — giữ train=false
  }
  try {
    let trainSummary: MacroTrainSummary | null = null;
    if (train) {
      // AUDIT 137 B12 — khoá train DÙNG CHUNG (train/sweep/macro): bận → 429
      // (không đè CPU); nhả khoá ở MỌI đường thoát (finally bên dưới).
      if (!tryAcquireTrainLock()) {
        return NextResponse.json(
          {
            ok: false,
            busy: true,
            error: "Đợt train/sweep khác đang giữ khoá huấn luyện dùng chung — thử lại sau khi nó xong.",
          },
          { status: 429 }
        );
      }
      markTrainAttempt(Date.now());
      try {
        trainSummary = await trainAllMacroAssets();
      } finally {
        releaseTrainLock();
      }
      // Audit sau đợt train — fail-soft (models đã lưu, audit không chặn trả lời)
      try {
        await db.auditLog.create({
          data: {
            action: "MACRO_MLP_TRAINED",
            entity: "MlModel",
            entityId: null,
            after: JSON.stringify({
              trained: trainSummary.trained.map((t) => ({
                symbol: t.symbol,
                modelVersion: t.modelVersion,
                samples: t.samples,
                valAcc: t.valAcc,
                missingContext: t.missingContext,
              })),
              errors: trainSummary.errors.map((e) => ({
                symbol: e.symbol,
                error: e.error,
              })),
              durationMs: trainSummary.durationMs,
            }),
          },
        });
      } catch (auditErr) {
        console.error(
          "[api/ml/macro-forecast] AuditLog MACRO_MLP_TRAINED lỗi (bỏ qua):",
          auditErr
        );
      }
    }
    const forecast = await macroAssetForecasts();
    return NextResponse.json({
      ok: true,
      forecast,
      ...(trainSummary ? { trainSummary } : {}),
      durationMs: Date.now() - started,
    });
  } catch (err) {
    console.error("[api/ml/macro-forecast] POST failed:", err);
    return NextResponse.json(
      { ok: false, error: "Dự báo/huấn luyện đa tài sản thất bại. Vui lòng thử lại." },
      { status: 500 }
    );
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  // F-166b-7 (#167) — POST /api/ml/* chỉ nhận same-origin (guard TRƯỚC mutex
  // — chặn sớm không xếp hàng kẻ lạ).
  const originGuard = guardSameOrigin(req);
  if (originGuard) return originGuard;
  const run = macroMutex
    .then(() => runPost(req))
    .catch((err) => {
      console.error("[api/ml/macro-forecast:mutex]", err);
      return NextResponse.json(
        { ok: false, error: "Dự báo/huấn luyện đa tài sản thất bại. Vui lòng thử lại." },
        { status: 500 }
      );
    });
  macroMutex = run;
  return run;
}
