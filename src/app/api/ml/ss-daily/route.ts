import { NextResponse } from "next/server";
import { guardSameOrigin } from "@/lib/api-guards";
// Task 176 — STATE_SPACE_BLUEPRINT Phase 1 (v1.1 pass review Task 172):
// vận hành hằng ngày của tầng State Space sau settle.
// Task 178 — Phase 2: thêm 2 tầng SS-8 (cờ dữ liệu aux residuals) + SS-5 (β
// động TVP) — mỗi tầng kill-switch riêng + fail-soft riêng (quy tắc 5).
import { runSsShadowCycle, runSsSurpriseCheck } from "@/lib/ml/ss/shadow";
import { runSsBetaCycle, runSsDataFlagCycle } from "@/lib/ml/ss/phase2";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const runtime = "nodejs";

/**
 * POST /api/ml/ss-daily (Task 176 · Phase 1 + Task 178 · Phase 2).
 *
 * Một lần/ngày (T2–T6 16:50 ICT, engine :3003 đôn đốc — sau settle 16:15 ·
 * k1 16:30 · council-eval 16:45, EOD hôm nay đã sync) làm 4 việc, mỗi việc
 * kill-switch riêng + fail-soft riêng:
 *
 *   1. A/B BÓNG (SS-1 quy tắc 6 — F5-v1.1): driver mới ml-forecast.holt-ss
 *      (A15b) đối chứng driver cũ ml-forecast.holt-basket (A15) bằng log-score
 *      SS-11 trên holdout PIT-an toàn (tham số đóng băng ở train window);
 *      ghi AuditLog SS_AB_LOG nhưng KHÔNG đốt vào Bayes. Đủ 14 ngày → verdict
 *      SS_AB_VERDICT: thắng mới hoán đổi evidence + tắt driver cũ.
 *
 *   2. GUARD NGẠC NHIÊN (SS-7 — F6-v1.1): local linear trend MLE trên log-giá
 *      10 mã rổ HOSE (căn LỊCH PHIÊN — SS-3 Task 178), chấm CUSUM-of-squares
 *      e²−1 (TIN CHÍNH) + KS phụ Bonferroni + |e|>4 đơn phát. Audit READ-ONLY.
 *
 *   3. CỜ DỮ LIỆU (SS-8 — Task 178 Phase 2): smoother aux residuals trên
 *      log-giá 10 mã (cửa sổ đóng — smoother hợp pháp cho audit) → cờ
 *      OUTLIER (sốc quan sát) / LEVEL_SHIFT (đổi level thật) / TREND_SHIFT.
 *      Ghi AuditLog SS_DATA_FLAG READ-ONLY — KHÔNG đổi tuyển dòng train (F7).
 *
 *   4. β ĐỘNG (SS-5 — Task 178 Phase 2): TVP Kalman từng mã so VNINDEX
 *      (ZSeq thời-đổi, skip-update phiên thiếu) → β_{T|T} + Var(β) + phân tách
 *      thị trường/idiosyncratic + cờ destabilising. Ghi AuditLog SS_BETA —
 *      vào strategist context (hedge ratio dự phòng), chưa nối sizing.
 *
 * Response luôn 200 + outcome từng tầng (engine log — không parse lỗi HTTP):
 *   { shadow: {…}, surprise: {…}, dataFlag: {…}, beta: {…} }
 * Kill-switch: AppSetting ml-ss-shadow / ml-ss-surprise / ml-ss-dataflag /
 * ml-ss-beta (tắt không restart — im lặng cũng được audit SS_CYCLE_SKIP F-177-1).
 */
export async function POST(req: Request) {
  // F-166b-7 (#167) — POST /api/ml/* chỉ nhận same-origin (engine :3003
  // postJson không Origin → đi qua — đúng caller chính của route này).
  const originGuard = guardSameOrigin(req);
  if (originGuard) return originGuard;
  try {
    const shadow = await runSsShadowCycle();
    const surprise = await runSsSurpriseCheck();
    const dataFlag = await runSsDataFlagCycle();
    const beta = await runSsBetaCycle();
    return NextResponse.json({ shadow, surprise, dataFlag, beta });
  } catch (err) {
    // Lớp ngoài cùng fail-soft (4 hàm con đã tự catch — đây chỉ chặn bug lạ)
    return NextResponse.json(
      {
        shadow: { outcome: "error", reason: err instanceof Error ? err.message : String(err) },
        surprise: { outcome: "error", reason: "không chạy (lỗi lớp route)" },
        dataFlag: { outcome: "error", reason: "không chạy (lỗi lớp route)" },
        beta: { outcome: "error", reason: "không chạy (lỗi lớp route)" },
      },
      { status: 200 }
    );
  }
}
