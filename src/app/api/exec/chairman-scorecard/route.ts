import { NextResponse } from "next/server";
import { toPlain } from "@/lib/serialize";
import { buildChairmanScorecard } from "@/lib/exec/chairman-scorecard";

export const dynamic = "force-dynamic";

/**
 * GET /api/exec/chairman-scorecard — E-P1-4 (EXECUTION_OPS_BLUEPRINT v1.1
 * §4, triển khai v1.2): ChairmanScorecard — bảng điểm chất lượng TÍN HIỆU
 * Chủ tịch (A1): nhãn 5 phiên sau (target/stop chạm trước, fallback
 * close-5-phiên) → precision/recall/F1/AUC-PR [ML M1] + RMSE target/stop
 * [ML M2] + calibration LOW/MEDIUM/HIGH → winrate + odds [MATH H6].
 * Thuần DB — 0 LLM. Query `?days=N` (30..180, mặc định 90).
 * enoughData=false khi nhãn < 30 [DA D7] — UI trung thực "chưa đủ dữ liệu".
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const daysRaw = Number(url.searchParams.get("days") ?? 90);
    const days =
      Number.isFinite(daysRaw) && daysRaw >= 30 && daysRaw <= 180
        ? Math.round(daysRaw)
        : 90;
    const scorecard = await buildChairmanScorecard(days);
    return NextResponse.json(toPlain(scorecard));
  } catch (err) {
    console.error("[api/exec/chairman-scorecard]", err);
    return NextResponse.json(
      { error: "Không tính được bảng điểm Chủ tịch." },
      { status: 500 }
    );
  }
}
