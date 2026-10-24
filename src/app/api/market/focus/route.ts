import { NextResponse } from "next/server";
import { toPlain } from "@/lib/serialize";
import { loadFocusScreen } from "@/lib/focus-screen";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/market/focus — SCREEN MÃ TRỌNG TÂM T2 (UNIVERSE_TIERING_BLUEPRINT §4).
 *
 * Top-30 ADTV20 toàn sàn (CORE+BROAD, STOCK+ETF) với điều kiện ổn định
 * rank tại T-10 ≤ 40 (hysteresis 2 snapshot, deterministic từ Bar). Phase 1
 * mang tính ĐỀ XUẤT (badge THĂNG-CẤP-T2/GIỮ-T1/XEM-LẠI) — chưa tiêu thụ
 * dữ liệu T2. Cache 10 phút phía lib — không trong chu kỳ agent.
 *
 * Response: FocusResponse (src/lib/types.ts).
 */
export async function GET() {
  try {
    const data = await loadFocusScreen();
    return NextResponse.json(toPlain(data));
  } catch (err) {
    console.error("[api/market/focus]", err);
    return NextResponse.json(
      { error: "Không tính được screen trọng tâm — xem log server." },
      { status: 500 }
    );
  }
}
