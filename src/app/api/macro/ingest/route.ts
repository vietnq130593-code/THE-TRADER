import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { extractMacroFromNews, MACRO_VN_SOURCE_KEY } from "@/lib/macro-vn";
import { markSource } from "@/lib/sources";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * POST /api/macro/ingest — F-02 Pha A (#129-D): CHẠY LƯỢT TRÍCH XUẤT chuỗi
 * vĩ mô VN từ tin tức (1 lời gọi LLM/ingest — xem extractMacroFromNews trong
 * src/lib/macro-vn.ts). Wrapper mỏng: cooldown → extract → audit → response.
 *
 * - Cooldown in-process 60s → 429 kèm Retry-After (pattern route train
 *   F-612R-06/#61 + synthesize #34) — CLAIM ĐỒNG BỘ ngay sau check
 *   (F-1091-02/#109) để 2 POST đồng thời không cùng đốt 2 lần chi phí LLM.
 * - AuditLog action "MACRO_INGESTED" entity "MacroObservation" sau {scanned,
 *   extracted, rejected, revised} — ghi KỂ CẢ khi 0 số trích được (trung thực
 *   "đã chạy đúng hạn", pattern ML_SETTLE/NEWS_INGESTED); audit fail không
 *   làm hỏng ingest (fail-soft).
 * - markSource("macro-vn") thực hiện BÊN TRONG extractMacroFromNews (mode
 *   extracted|pending, success/fail) — route chỉ mark thêm ở nhánh exception
 *   ngoài (DB chết giữa chừng) để DataSourceStatus không kẹt lastSuccessAt cũ.
 *
 * LLM fail-soft: extractMacroFromNews KHÔNG throw khi LLM/parse lỗi — trả
 * 200 {ok: true, llmError: "…", extracted: 0} và GIỮ nguyên cursor để lượt
 * sau retry cùng lô tin; tin đã quét thành công thì cursor tiến (không đốt
 * token lần hai).
 */
const COOLDOWN_MS = 60_000;
let lastIngestAt = 0; // in-process (engine :3003 gọi 1 lần/ngày — dư dả)

export async function POST(): Promise<NextResponse> {
  const now = Date.now();
  const sinceLast = now - lastIngestAt;
  if (sinceLast < COOLDOWN_MS) {
    const retryAfterSeconds = Math.ceil((COOLDOWN_MS - sinceLast) / 1000);
    return NextResponse.json(
      {
        error: `Lượt trích xuất vĩ mô vừa chạy cách đây ${Math.floor(sinceLast / 1000)}s. Vui lòng đợi ${retryAfterSeconds}s rồi thử lại.`,
        retryAfterSeconds,
      },
      {
        status: 429,
        headers: { "Retry-After": String(retryAfterSeconds) },
      }
    );
  }
  // CLAIM cooldown đồng bộ — không còn await nào giữa check và claim (F-1091-02)
  lastIngestAt = now;

  try {
    const result = await extractMacroFromNews();

    // Audit mọi lượt chạy — kể cả extracted=0 (LLM đã quét và trả lời "không
    // có số" là kết quả hợp lệ; khác với "không chạy"). llmError cũng ghi để
    // truy vết chuỗi lỗi chu kỳ.
    try {
      await db.auditLog.create({
        data: {
          action: "MACRO_INGESTED",
          entity: "MacroObservation",
          entityId: null,
          after: JSON.stringify({
            scanned: result.scanned,
            extracted: result.extracted,
            rejected: result.rejected,
            revised: result.revised,
            ...(result.llmError ? { llmError: result.llmError } : {}),
            lastIngestAt: result.lastIngestAt,
          }),
        },
      });
    } catch (auditErr) {
      // Fail-soft: audit fail không làm hỏng ingest (observation đã ghi DB)
      console.error("[api/macro/ingest] AuditLog MACRO_INGESTED lỗi (bỏ qua):", auditErr);
    }

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    // Exception ngoài (DB chết giữa chừng...) — markSource fail-soft để
    // DataSourceStatus phản ánh lỗi thay vì kẹt lastSuccessAt cũ.
    console.error("[api/macro/ingest POST]", err);
    await markSource(MACRO_VN_SOURCE_KEY, {
      success: false,
      lastError: err instanceof Error ? err.message : String(err),
    }).catch(() => undefined);
    return NextResponse.json(
      {
        ok: false,
        error: "Lượt trích xuất vĩ mô thất bại. Vui lòng thử lại.",
        scanned: 0,
        extracted: 0,
        rejected: 0,
        revised: 0,
        reasons: [],
      },
      { status: 500 }
    );
  }
}
