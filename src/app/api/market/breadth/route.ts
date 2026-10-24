import { NextResponse } from "next/server";
import { toPlain } from "@/lib/serialize";
import { loadBreadthMarket } from "@/lib/breadth-market";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/market/breadth — breadth TOÀN SÀN T0 (UNIVERSE_TIERING_BLUEPRINT §7).
 *
 * A/D + %trên MA20/50/200 trên toàn bộ STOCK VN có bar (CORE+BROAD ~1.000 mã),
 * theo từng sàn + gộp. On-demand + cache 10 phút phía lib — KHÔNG nằm trong
 * chu kỳ agent 23 agents. Phase 1 hiển thị; bỏ phiếu Bayes để Phase 2 (§7).
 *
 * Response: BreadthResponse (src/lib/types.ts).
 */
export async function GET() {
  try {
    const data = await loadBreadthMarket();
    return NextResponse.json(toPlain(data));
  } catch (err) {
    console.error("[api/market/breadth]", err);
    return NextResponse.json(
      { error: "Không tính được breadth toàn sàn — xem log server." },
      { status: 500 }
    );
  }
}
