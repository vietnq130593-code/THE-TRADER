import { NextResponse } from "next/server";
import { runScenarioAnalysis } from "@/lib/risk/scenario";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * GET /api/risk/scenario — F-14 (#129-C · AI_ENGINEER_REVIEW_BRAIN v3 §3):
 * FACTOR-BETA MONTE CARLO + KỊCH BẢN STRESS CÓ TÊN cho risk-manager + UI.
 *
 * Wrapper mỏng quanh `runScenarioAnalysis()` (src/lib/risk/scenario.ts):
 * query vị thế OPEN (0 vị thế → rổ proxy top-10 HOSE) → beta OLS 250 phiên
 * chung vs 4 factor {VNINDEX, US10Y, DX-Y.NYB, GC=F} → MC correlated 10.000
 * đường (Cholesky, seed cố định) + 5 kịch bản đặt tên. Thuần thống kê,
 * 0 LLM, 0 ghi DB — trả payload JSON duy nhất:
 *   { ok, report: { asOf, proxyMode, positions, factors, mc, scenarios,
 *                   notes[], durationMs } }
 *
 * KHÔNG ghi RiskQuantSnapshot (E6 — MC bootstrap vô điều kiện của engine
 * vẫn chạy nguyên vẹn; main agent quyết wiring F-14 vào snapshot.detail sau).
 * Fail-soft 500 thân thiện như pattern /api/ml/settle — chu kỳ agent không
 * phụ thuộc route này nên lỗi chỉ ảnh hưởng đúng người gọi.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const report = await runScenarioAnalysis();
    return NextResponse.json({ ok: true, report });
  } catch (err) {
    console.error("[api/risk/scenario] GET failed:", err);
    return NextResponse.json(
      { ok: false, error: "Phân tích kịch bản rủi ro (F-14) thất bại." },
      { status: 500 }
    );
  }
}
