import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  macroAssetForecasts,
  trainAllMacroAssets,
  type MacroTrainSummary,
} from "@/lib/ml/macro-forecast";

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
 *        tài sản) RỒI trả forecast + trainSummary. Không cooldown phức tạp —
 *        chỉ MUTEX IN-PROCESS kiểu chuỗi Promise module-level (pattern
 *        AUD-CODE #18 của /api/ml/settle): 2 POST không bao giờ train đè
 *        nhau (nextVersion max+1 + $transaction đã an toàn, mutex chống ép
 *        CPU 8×8 fit song song). GET KHÔNG qua mutex — đường đọc phải luôn
 *        nhẹ nhàng (ảnh chụp giữa đợt train vẫn nhất quán từng dòng vì mỗi
 *        dòng tự khóa theo meta.assetSymbol).
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
      trainSummary = await trainAllMacroAssets();
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
