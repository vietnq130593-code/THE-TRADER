import { NextResponse } from "next/server";
import { synthesizeRelationInsight } from "@/lib/ml/xrel";

export const dynamic = "force-dynamic";
// 1 gọi LLM (kèm retry/backoff #93) + engine quant — đủ 60s.
export const maxDuration = 60;

/**
 * POST /api/market/relations/insight (#103 — M2_RELATION_BLUEPRINT).
 *
 * Tổng hợp NHẬN ĐỊNH quan hệ liên thị trường bằng LLM (nút "Tổng hợp nhận
 * định" trong UI): luôn ép sinh bản mới (force). Không đủ quan hệ đã học →
 * trả narrative trung thực "chưa đủ dữ liệu", KHÔNG cho LLM bịa.
 *
 * F-1091-09 (fixbug api #109): cooldown 30s → 429 + Retry-After (pattern
 * assessment/synthesize #34). Trước đây route KHÔNG guard — double-click nút
 * "Tổng hợp nhận định" = 2 lần gọi LLM chồng nhau (mọi route LLM/đắt khác
 * đều có guard: synthesize 10s · intl-sync/corporate-events 30s · reprobe
 * 60s · ml/train 60s).
 */
const COOLDOWN_MS = 30_000;
let lastInsightAt = 0;

export async function POST() {
  const now = Date.now();
  const sinceLast = now - lastInsightAt;
  if (sinceLast < COOLDOWN_MS) {
    const retryAfterSeconds = Math.ceil((COOLDOWN_MS - sinceLast) / 1000);
    return NextResponse.json(
      {
        error: `Nhận định quan hệ vừa tổng hợp cách đây ${Math.floor(sinceLast / 1000)}s. Vui lòng đợi ${retryAfterSeconds}s rồi thử lại.`,
        retryAfterSeconds,
      },
      {
        status: 429,
        headers: { "Retry-After": String(retryAfterSeconds) },
      }
    );
  }
  lastInsightAt = now;

  try {
    const result = await synthesizeRelationInsight(true);
    if (!result) {
      // Lỗi tổng hợp → cho retry ngay (không giữ cooldown vô ích)
      lastInsightAt = 0;
      return NextResponse.json(
        { error: "Không tổng hợp được nhận định lúc này." },
        { status: 500 }
      );
    }
    return NextResponse.json(result);
  } catch (err) {
    lastInsightAt = 0;
    console.error("[api/market/relations/insight POST]", err);
    return NextResponse.json(
      { error: "Tổng hợp nhận định thất bại — thử lại sau ít phút." },
      { status: 500 }
    );
  }
}
