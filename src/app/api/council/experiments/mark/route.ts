import { NextResponse } from "next/server";
import { toPlain } from "@/lib/serialize";
import { markExperimentsDaily } from "@/lib/council/experiments";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/council/experiments/mark (#106 §5.2).
 * Đánh giá mark-to-market mọi thí nghiệm RUNNING theo chỉ số rổ (constant-mix)
 * — idempotent (unique(experimentId, date), chỉ chèn ngày còn thiếu). Engine
 * gọi 16:35 ICT t2–t6; route cho chạy tay + nút UI.
 */
export async function POST() {
  try {
    const outcome = await markExperimentsDaily();
    return NextResponse.json(toPlain(outcome));
  } catch (err) {
    console.error("[api/council/experiments/mark POST]", err);
    return NextResponse.json(
      { error: "Đánh giá thí nghiệm thất bại — xem log server." },
      { status: 500 }
    );
  }
}
