import { NextResponse } from "next/server";
import { toPlain } from "@/lib/serialize";
import { runCouncilAllocationSession } from "@/lib/council/allocation-session";

export const dynamic = "force-dynamic";
// 1 gọi LLM (kèm retry/backoff #93) + tạo thí nghiệm — đủ 60s.
export const maxDuration = 60;

/** Cooldown 60s — hội nghị LLM tốn token, chống spam (pattern intl-sync). */
const COOLDOWN_MS = 60_000;
let lastRunAt = 0;

/**
 * POST /api/council/allocation-session (#106 §5.3 — hội nghị phân bổ đa rổ).
 * Chủ tịch (portfolio-strategist) đọc thống kê 5 rổ + kết quả thí nghiệm
 * trước + khối tầm nhìn tài khoản → tự đề xuất thí nghiệm mới (JSON hợp đồng,
 * parse fail-soft kiểu k4.ts) + viết lại bài học cho thí nghiệm đã đóng.
 * Broadcast kết quả vào "Luồng thảo luận giữa các agents". Engine gọi CN
 * 05:50 ICT; route cho nút "Họp Hội đồng phân bổ" trong UI.
 */
export async function POST() {
  const sinceLast = Date.now() - lastRunAt;
  if (sinceLast < COOLDOWN_MS) {
    const retryAfter = Math.ceil((COOLDOWN_MS - sinceLast) / 1000);
    return NextResponse.json(
      { error: `Hội nghị vừa họp cách đây ${Math.floor(sinceLast / 1000)}s — đợi ${retryAfter}s.`, retryAfter },
      { status: 429, headers: { "Retry-After": String(retryAfter) } }
    );
  }
  lastRunAt = Date.now();
  try {
    const result = await runCouncilAllocationSession();
    return NextResponse.json(toPlain(result));
  } catch (err) {
    console.error("[api/council/allocation-session POST]", err);
    return NextResponse.json(
      { error: "Hội nghị phân bổ thất bại — thử lại sau ít phút." },
      { status: 500 }
    );
  }
}
