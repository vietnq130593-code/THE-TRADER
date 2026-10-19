/** (Task 144 P2-b) — tách từ src/lib/agent-context.ts (pure move)
 *  Khối tín hiệu đang mở: buildOpenSignalsBlock. */

import { db } from "@/lib/db";

/** Tín hiệu đang mở (status ACTIVE) — PHASE3_BLUEPRINT §4.6 khối "signals mở". */
export async function buildOpenSignalsBlock(): Promise<string> {
  const signals = await db.signal.findMany({
    where: { status: "ACTIVE" },
    orderBy: { createdAt: "desc" },
    take: 8,
    include: { instrument: { select: { symbol: true } } },
  });
  if (!signals.length) return "- (không có tín hiệu đang mở)";
  return signals
    .map((s) => {
      const rationale =
        s.rationale.length > 120 ? `${s.rationale.slice(0, 120).trimEnd()}…` : s.rationale;
      return `- ${s.instrument.symbol} ${s.direction} điểm ${s.score}/100 tin cậy ${s.confidence} — ${rationale}`;
    })
    .join("\n");
}
