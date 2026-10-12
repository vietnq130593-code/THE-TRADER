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
 */
export async function POST() {
  try {
    const result = await synthesizeRelationInsight(true);
    if (!result) {
      return NextResponse.json(
        { error: "Không tổng hợp được nhận định lúc này." },
        { status: 500 }
      );
    }
    return NextResponse.json(result);
  } catch (err) {
    console.error("[api/market/relations/insight POST]", err);
    return NextResponse.json(
      { error: "Tổng hợp nhận định thất bại — thử lại sau ít phút." },
      { status: 500 }
    );
  }
}
