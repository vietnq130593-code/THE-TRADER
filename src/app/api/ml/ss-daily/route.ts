import { NextResponse } from "next/server";
import { guardSameOrigin } from "@/lib/api-guards";
// Task 176 — STATE_SPACE_BLUEPRINT Phase 1 (v1.1 pass review Task 172):
// vận hành hằng ngày của tầng State Space sau settle.
import { runSsShadowCycle, runSsSurpriseCheck } from "@/lib/ml/ss/shadow";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const runtime = "nodejs";

/**
 * POST /api/ml/ss-daily (Task 176 · STATE_SPACE_BLUEPRINT Phase 1).
 *
 * Một lần/ngày (T2–T6 16:50 ICT, engine :3003 đôn đốc — sau settle 16:15 ·
 * k1 16:30 · council-eval 16:45, EOD hôm nay đã sync) làm 2 việc, mỗi việc
 * kill-switch riêng + fail-soft riêng:
 *
 *   1. A/B BÓNG (SS-1 quy tắc 6 — F5-v1.1): driver mới ml-forecast.holt-ss
 *      (A15b) đối chứng driver cũ ml-forecast.holt-basket (A15) bằng log-score
 *      SS-11 trên holdout PIT-an toàn (tham số đóng băng ở train window);
 *      ghi AuditLog SS_AB_LOG {driver, horizon, mean, sd, logScore} nhưng
 *      KHÔNG đốt vào Bayes. Đủ 14 ngày → verdict SS_AB_VERDICT: thắng
 *      (log-score trung bình ngày mới > cũ) mới hoán đổi evidence + tắt
 *      driver cũ (AppSetting ml-ss-shadow.mode = "live").
 *
 *   2. GUARD NGẠC NHIÊN (SS-7 — F6-v1.1): local linear trend MLE trên log-giá
 *      10 mã rổ HOSE, chấm CUSUM-of-squares e²−1 (TIN CHÍNH — HOSE đuôi dày
 *      khiến KS reject mạn tính) + KS phụ Bonferroni 0,01/(10 mã × 1 check)
 *      + |e|>4 đơn phát. Ghi AuditLog SS_SURPRISE READ-ONLY — Phase 1 KHÔNG
 *      hành động (4 tuần audit im lặng trước khi nối vào auto-retrain W3).
 *
 * Response luôn 200 + outcome từng tầng (engine log — không parse lỗi HTTP):
 *   { shadow: {outcome: ran|skip-disabled|skip-insufficient-data|error, …},
 *     surprise: {outcome: …, checked, flagged, tier} }
 * Kill-switch: AppSetting ml-ss-shadow / ml-ss-surprise (tắt không restart).
 */
export async function POST(req: Request) {
  // F-166b-7 (#167) — POST /api/ml/* chỉ nhận same-origin (engine :3003
  // postJson không Origin → đi qua — đúng caller chính của route này).
  const originGuard = guardSameOrigin(req);
  if (originGuard) return originGuard;
  try {
    const shadow = await runSsShadowCycle();
    const surprise = await runSsSurpriseCheck();
    return NextResponse.json({ shadow, surprise });
  } catch (err) {
    // Lớp ngoài cùng fail-soft (2 hàm con đã tự catch — đây chỉ chặn bug lạ)
    return NextResponse.json(
      {
        shadow: { outcome: "error", reason: err instanceof Error ? err.message : String(err) },
        surprise: { outcome: "error", reason: "không chạy (lỗi lớp route)" },
      },
      { status: 200 }
    );
  }
}
