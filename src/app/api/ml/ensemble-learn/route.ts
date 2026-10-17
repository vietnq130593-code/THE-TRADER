import { NextResponse } from "next/server";
import { trainEnsembleWeights } from "@/lib/ml/ensemble-learn";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * POST /api/ml/ensemble-learn — F-07 (#129 — AI_ENGINEER_REVIEW_BRAIN §3 F-07).
 *
 * Meta-learner trọng số ensemble từ D-LEDGER: học logistic softmax 3 lớp trên
 * vector giọng nói các phiếu ml-forecast ĐÃ settle (BanditEvent.meta voice +
 * realizedDir — bắt đầu tích luỹ từ #129). Kết quả lưu AppSetting
 * "ml-ensemble-weights":
 *   • < 60 phiếu → cold-start KHÔNG ghi (giữ fixed 0,7/0,3);
 *   • học xong mà valBrier không thắng fixed quá deadband → ghi
 *     source="rejected" + whyRejected (ensemble vẫn dùng fixed);
 *   • thắng → source="learned" — mlForecastEnsemble tự đổi trọng số chu kỳ kế.
 *
 * Engine gọi SAU sweep Chủ nhật (đặc tả F-07 mục 4 "sau sweep 5 phút" —
 * thực thi ngay sau đợt sweep v3 trong cùng slot); tay gọi cũng an toàn
 * (idempotent, 0 LLM, ~1s). Kill-switch: xoá AppSetting ml-ensemble-weights
 * → ensemble fallback fixed TỨC THÌ.
 */
export async function POST() {
  try {
    const result = await trainEnsembleWeights();
    return NextResponse.json({
      ok: result.ok,
      outcome: result.outcome,
      nVotes: result.nVotes,
      setting: result.setting,
      note: result.note,
    });
  } catch (err) {
    console.error("[api/ml/ensemble-learn] POST lỗi:", err);
    return NextResponse.json(
      { ok: false, error: "Học trọng số ensemble thất bại (lỗi ngoài dự kiến)." },
      { status: 500 }
    );
  }
}
