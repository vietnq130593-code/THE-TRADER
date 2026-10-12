import { NextResponse } from "next/server";
import { toPlain } from "@/lib/serialize";
import { evaluateDecisions } from "@/lib/council/decision-eval";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/council/evaluate (#106 §3.2 — D-LEDGER).
 * Chạy evaluateDecisions() trên toàn bộ tín hiệu ≤ 90 ngày — idempotent
 * (upsert theo signalId). Engine gọi 16:45 ICT t2–t6 sau k1 settle 16:30;
 * route này cho trader chạy tay + nút UI.
 */
export async function POST() {
  try {
    const summary = await evaluateDecisions();
    return NextResponse.json(toPlain(summary));
  } catch (err) {
    console.error("[api/council/evaluate POST]", err);
    return NextResponse.json(
      { error: "Đánh giá quyết định thất bại — xem log server." },
      { status: 500 }
    );
  }
}
