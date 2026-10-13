import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { scoreNews } from "@/lib/quant/sentiment";
import { CORPUS_NEWS } from "@/lib/ml/rag";
// F-1091-01 (fixbug api #109): validate ngày chia sẻ — regex-only cũ cho
// "2026-13-01" vượt DATE_RE → ictDayStart Invalid → Prisma 500 thay vì 422
// hợp đồng documented ở header (verify live). isValidIctDay bắt cả
// roll-over "2026-02-30" (F-63C-09) — vẫn 422 fields[] đúng hợp đồng.
import { isValidIctDay, ictDayStart, ictDayEnd } from "@/lib/api-dates";

export const dynamic = "force-dynamic";

/**
 * GET /api/news/archive?from=YYYY-MM-DD&to=YYYY-MM-DD&take=30&offset=0 (#101)
 *
 * Kho tin tức thị trường lọc theo ngày (ranh giới ngày theo ICT +07:00 —
 * khớp múi giờ trader & mốc publishedAt của RSS VN) + CHỈ BÁO LÀM GIÀU TRI
 * THỨC AGENTS trên từng tin:
 *   · inA4Window  — nằm trong 10 tin mới nhất News & Sentiment đọc mỗi chu kỳ
 *                   (agent-context.ts buildNewsBlock → latestNewsForContext(10))
 *   · inRagCorpus — nằm trong corpus CORPUS_NEWS=200 tin mới nhất RAG BM25
 *                   (ml/rag.ts — truy hồi cho prompt 5 agent nghiên cứu + Chủ tịch)
 *   · lexiconScore— điểm quant (quant/sentiment.ts scoreNews) ∈ [−1, 1]
 * Đường thứ 4 (bandit) học theo NGUỒN không theo từng tin → chỉ legend UI.
 *
 * Mặc định: 7 ngày gần nhất theo ICT. Validate fail → 422 {error, fields[]}.
 * Trả thêm bounds min/max publishedAt toàn kho (min/max cho date input) và
 * counts thống kê khoảng (bySource/byCategory/inA4Window/inRagCorpus/lexicon).
 */

/** Số tin A4 đọc mỗi chu kỳ — mirror latestNewsForContext(10) (agent-context.ts). */
const A4_WINDOW = 10;
/** Trần quét thống kê lexicon toàn khoảng — chống phình nếu kho lớn dần. */
const LEXICON_SCAN_CAP = 5_000;

/** "YYYY-MM-DD" theo ICT (UTC+7) của thời điểm cho trước. */
function ictDateIso(now: Date): string {
  return new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
}

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const fromRaw = sp.get("from");
    const toRaw = sp.get("to");

    const fields: { field: string; message: string }[] = [];
    if (fromRaw != null && !isValidIctDay(fromRaw)) {
      fields.push({ field: "from", message: "Từ ngày phải là ngày YYYY-MM-DD hợp lệ." });
    }
    if (toRaw != null && !isValidIctDay(toRaw)) {
      fields.push({ field: "to", message: "Đến ngày phải là ngày YYYY-MM-DD hợp lệ." });
    }

    // Mặc định 7 ngày gần nhất theo ICT khi client không gửi.
    const todayIct = ictDateIso(new Date());
    const weekAgoIct = ictDateIso(new Date(Date.now() - 6 * 86_400_000));
    const from = fromRaw ?? weekAgoIct;
    const to = toRaw ?? todayIct;
    if (fields.length === 0 && ictDayStart(from) > ictDayEnd(to)) {
      fields.push({ field: "to", message: "Đến ngày phải sau (hoặc bằng) Từ ngày." });
    }
    if (fields.length > 0) {
      return NextResponse.json(
        { error: "Phạm vi ngày không hợp lệ.", fields },
        { status: 422 }
      );
    }

    const takeParam = Number(sp.get("take") ?? 30);
    const take = Math.min(
      100,
      Math.max(1, Number.isFinite(takeParam) ? Math.floor(takeParam) : 30)
    );
    const offsetParam = Number(sp.get("offset") ?? 0);
    const offset = Math.max(0, Number.isFinite(offsetParam) ? Math.floor(offsetParam) : 0);

    const rangeStart = ictDayStart(from);
    const rangeEnd = ictDayEnd(to);
    const rangeWhere = { publishedAt: { gte: rangeStart, lte: rangeEnd } };

    const [pageItems, total, a4Ids, ragIds, lexScan, bounds, bySource, byCategory] =
      await Promise.all([
        db.newsItem.findMany({
          where: rangeWhere,
          orderBy: { publishedAt: "desc" },
          skip: offset,
          take,
          select: {
            id: true,
            title: true,
            summary: true,
            url: true,
            source: true,
            category: true,
            publishedAt: true,
            fetchedAt: true,
          },
        }),
        db.newsItem.count({ where: rangeWhere }),
        // Cửa sổ A4 = 10 tin MỚI NHẤT toàn kho (không phụ thuộc khoảng lọc).
        db.newsItem.findMany({
          orderBy: { publishedAt: "desc" },
          take: A4_WINDOW,
          select: { id: true },
        }),
        db.newsItem.findMany({
          orderBy: { publishedAt: "desc" },
          take: CORPUS_NEWS,
          select: { id: true },
        }),
        // Quét lexicon toàn khoảng (có trần) — chỉ title+summary, nhẹ.
        db.newsItem.findMany({
          where: rangeWhere,
          orderBy: { publishedAt: "desc" },
          take: LEXICON_SCAN_CAP,
          select: { title: true, summary: true },
        }),
        db.newsItem.aggregate({ _min: { publishedAt: true }, _max: { publishedAt: true } }),
        db.newsItem.groupBy({ by: ["source"], where: rangeWhere, _count: true }),
        db.newsItem.groupBy({ by: ["category"], where: rangeWhere, _count: true }),
      ]);

    const a4Set = new Set(a4Ids.map((n) => n.id));
    const ragSet = new Set(ragIds.map((n) => n.id));

    const items = pageItems.map((n) => ({
      ...n,
      lexiconScore: scoreNews(`${n.title} ${n.summary ?? ""}`.trim()),
      inA4Window: a4Set.has(n.id),
      inRagCorpus: ragSet.has(n.id),
    }));

    // Thống kê lexicon trên toàn khoảng đã quét.
    let lexPos = 0;
    let lexNeg = 0;
    for (const n of lexScan) {
      const s = scoreNews(`${n.title} ${n.summary ?? ""}`.trim());
      if (s > 0) lexPos++;
      else if (s < 0) lexNeg++;
    }

    // Đếm A4 window ∩ khoảng và RAG corpus ∩ khoảng (id sets nhỏ: 10 & 200).
    const [a4InRange, ragInRange] = await Promise.all([
      a4Set.size > 0
        ? db.newsItem.count({ where: { id: { in: [...a4Set] }, ...rangeWhere } })
        : Promise.resolve(0),
      ragSet.size > 0
        ? db.newsItem.count({ where: { id: { in: [...ragSet] }, ...rangeWhere } })
        : Promise.resolve(0),
    ]);

    return NextResponse.json({
      items,
      meta: {
        total,
        from: rangeStart.toISOString(),
        to: rangeEnd.toISOString(),
        take,
        offset,
        bounds: {
          min: bounds._min.publishedAt?.toISOString() ?? null,
          max: bounds._max.publishedAt?.toISOString() ?? null,
        },
        counts: {
          bySource: Object.fromEntries(bySource.map((g) => [g.source ?? "khác", g._count])),
          byCategory: Object.fromEntries(
            byCategory.map((g) => [g.category ?? "khác", g._count])
          ),
          inA4Window: a4InRange,
          inRagCorpus: ragInRange,
          lexiconPos: lexPos,
          lexiconNeg: lexNeg,
        },
      },
    });
  } catch (err) {
    console.error("[api/news/archive GET]", err);
    return NextResponse.json(
      { error: "Không tải được kho tin tức lúc này." },
      { status: 500 }
    );
  }
}
