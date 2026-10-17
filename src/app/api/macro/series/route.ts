import { NextResponse } from "next/server";
import { macroSeriesSnapshot } from "@/lib/macro-vn";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/macro/series — F-02 Pha A + F-16 (#129-D): bảng điều khiển 10
 * chuỗi vĩ mô nội địa VN (CPI/GDP/SBV/tín dụng/M2/PMI/TPCP 10Y/liên ngân
 * hàng/XNK/FDI) cho dashboard — mỗi chuỗi kèm:
 *
 * - value/prevValue/delta   — kỳ mới nhất + Δ so kỳ trước (Q10: chỉ đếm
 *   observation releaseAt ≤ hiện tại, point-in-time chống look-ahead);
 * - mode                    — real | extracted | manual (minh bạch nguồn);
 * - sourceUrl               — URL bài tin chứa con số (N2 chống bịa);
 * - stale                   — Q13: monthly > 45 ngày / quarterly > 120 ngày
 *   không kỳ mới;
 * - nextRelease             — F-16: ước tính kỳ công bố kế tiếp (tham khảo)
 *   + missingKeys[] thay thế khối "CÒN THIẾU" tĩnh trong prompt A20.
 *
 * Lần gọi đầu trong process tự ensureMacroSeries() (idempotent, module flag)
 * → 10 MacroSeries được seed ngay cả khi chưa từng ingest.
 *
 * Fail-soft đúng phong cách codebase: lỗi vẫn trả JSONshape đầy đủ
 * (series: [], missingKeys: []) để UI không vỡ layout.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const snapshot = await macroSeriesSnapshot();
    return NextResponse.json({ ok: true, ...snapshot });
  } catch (err) {
    console.error("[api/macro/series GET]", err);
    return NextResponse.json(
      {
        ok: false,
        error: "Không đọc được bảng chuỗi vĩ mô VN.",
        series: [],
        missingKeys: [],
        lastIngestAt: null,
      },
      { status: 500 }
    );
  }
}
