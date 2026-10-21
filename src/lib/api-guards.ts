import { NextResponse } from "next/server";

/**
 * F-166b-7 (Fixbug #166 → vá #167) — guard same-origin cho POST /api/ml/*.
 *
 * Finding: toàn bộ họ route POST /api/ml/* (train · sweep · psi-retrain ·
 * tuning · l2 · settle · ensemble-learn · macro-forecast) KHÔNG auth —
 * pre-existing từ đầu dự án, môi trường localhost-only nên rủi ro thấp,
 * nhưng vẫn là cửa đổi trạng thái tốn kém (train 26s, xoá/build lại index
 * L2) không có lớp kiểm soát nào.
 *
 * Guard 2 lớp KHÔNG phá ai:
 * 1. `Sec-Fetch-Site: cross-site` (browser hiện đại tự khai báo) → 403.
 * 2. `Origin` có và giải mã được → PHẢI khớp Host/X-Forwarded-Host của yêu
 *    cầu (browser POST luôn gửi Origin — same-origin thì trùng Host) →
 *    lệch → 403. Chặn vector CSRF/trang web lạ biết URL cứ browser-POST
 *    vào cổng train.
 *
 * Ai được đi qua (theo đúng vận hành thật của hệ thống):
 * - engine :3003 (bun postJson — KHÔNG gửi Origin/Sec-Fetch-Site);
 * - curl / script verify / ops (không Origin);
 * - nút bấm FE (browser same-origin — Origin trùng Host);
 * - Origin "null" (opaque origin — iframe preview sandbox): cho qua vì
 *   không thể phân biệt với preview, và không có cookie-auth để CSRF ăn cắp.
 *
 * KHÔNG phải auth thật (không secret/user-session): client không-browser
 * local vẫn gọi được — theo finding đó là biên môi trường localhost-only,
 * ghi trung thực trong worklog #168. Muốn khoá chặt hơn: đặt ML_API_SECRET
 * và đối chiếu header (kế hoạch nâng cấp, chưa bật để không gãy engine).
 */
export function guardSameOrigin(req: Request): NextResponse | null {
  // Lớp 1 — Sec-Fetch-Site (Fetch Metadata, browser hiện đại tự gắn).
  const site = req.headers.get("sec-fetch-site");
  if (site === "cross-site") {
    return forbiddenPost("Sec-Fetch-Site: cross-site");
  }
  // Lớp 2 — Origin so Host.
  const origin = req.headers.get("origin");
  if (origin == null || origin === "null") return null; // không-browser / opaque
  let originHost: string;
  try {
    originHost = new URL(origin).host; // đã lowercase theo URL spec
  } catch {
    return forbiddenPost(`Origin không giải mã được (${origin})`);
  }
  const forwarded = req.headers.get("x-forwarded-host");
  const host = (forwarded ?? req.headers.get("host"))?.split(",")[0]?.trim().toLowerCase();
  if (host == null || originHost !== host) {
    return forbiddenPost(`Origin ${origin} ≠ host ${host ?? "(không có)"}`);
  }
  return null;
}

/** 403 kèm log giám sát (F-00 — chặn nào cũng để lại dấu). */
function forbiddenPost(reason: string): NextResponse {
  console.warn(`[api-guards] F-166b-7 chặn POST cross-origin: ${reason}`);
  return NextResponse.json(
    {
      error:
        "Yêu cầu đổi trạng thái /api/ml/* chỉ nhận từ cùng nguồn (same-origin) — guard F-166b-7.",
      reason,
    },
    { status: 403 }
  );
}
