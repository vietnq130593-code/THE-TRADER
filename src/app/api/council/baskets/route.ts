import { NextResponse } from "next/server";
import { toPlain } from "@/lib/serialize";
import { basketStatsCached } from "@/lib/council/baskets";

export const dynamic = "force-dynamic";

/**
 * GET /api/council/baskets (#106 §2.4) — thống kê 5 rổ thị trường (30 phiên
 * gần nhất): thành viên · độ phủ · lợi suất 1/5/30 phiên · vol · tốt/xấu
 * nhất. Dùng cho card "Đa rổ thị trường" (module Thị trường) + hội nghị phân
 * bổ (đã đọc nội bộ qua basketStatsCached — cùng cache 60s).
 */
export async function GET() {
  try {
    const stats = await basketStatsCached();
    return NextResponse.json(
      toPlain({
        baskets: stats,
        meta: { cachedTtlSec: 60, generatedAt: new Date().toISOString() },
      })
    );
  } catch (err) {
    console.error("[api/council/baskets GET]", err);
    return NextResponse.json(
      { error: "Không tính được chỉ số rổ — thử lại sau." },
      { status: 500 }
    );
  }
}
