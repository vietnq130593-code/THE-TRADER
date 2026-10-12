import { NextResponse } from "next/server";
import { refreshRelations } from "@/lib/ml/xrel";

export const dynamic = "force-dynamic";

/**
 * POST /api/market/relations/refresh (#103 — M2_RELATION_BLUEPRINT).
 *
 * Ép chạy engine quant Lớp 1 (nút "Học lại" trong UI): nạp 750 phiên gần
 * nhất mỗi phân đoạn → tính lead-lag Pearson + xác suất điều kiện → thay
 * toàn bộ bảng MarketRelation. Idempotent, ~0,3–1s.
 */
export async function POST() {
  try {
    const result = await refreshRelations();
    return NextResponse.json({ result });
  } catch (err) {
    console.error("[api/market/relations/refresh POST]", err);
    return NextResponse.json(
      { error: "Chạy lại engine quan hệ thị trường thất bại." },
      { status: 500 }
    );
  }
}
