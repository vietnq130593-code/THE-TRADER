import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ingestNews, type FeedReliabilityMap } from "@/lib/news";
import { readSources, staleOf } from "@/lib/sources";
// F-1091-01 (fixbug api #109): validate ngày chia sẻ — regex-only cũ cho
// "2026-13-01" vượt DATE_RE → Invalid Date → Prisma 500 (verify live).
import { isValidIctDay, ictDayStart, ictDayEnd } from "@/lib/api-dates";

export const dynamic = "force-dynamic";

/**
 * GET  /api/news?limit=12 — tin mới nhất (S5) + meta nguồn (stale marking)
 * + P2-2/#62: reliability per-feed (tỉ lệ parse lỗi/tin trùng tích luỹ).
 * POST /api/news — chạy crawler RSS ngay (rate-limit 60s giữa 2 lần nạp).
 */

export async function GET(req: NextRequest) {
  try {
    const limitParam = Number(req.nextUrl.searchParams.get("limit") ?? 12);
    const limit = Math.min(
      30,
      Math.max(1, Number.isFinite(limitParam) ? limitParam : 12)
    );
    // #105 — khoảng thời gian toàn cục: from/to ngày ICT "YYYY-MM-DD".
    // Hợp lệ → lọc publishedAt trong khoảng (take nới tối đa 60).
    const fromParam = req.nextUrl.searchParams.get("from");
    const toRaw = req.nextUrl.searchParams.get("to");
    const hasRange = Boolean(
      fromParam &&
        toRaw &&
        isValidIctDay(fromParam) &&
        isValidIctDay(toRaw) &&
        fromParam <= toRaw
    );

    const [items, sources, total] = await Promise.all([
      db.newsItem.findMany({
        where: hasRange
          ? {
              publishedAt: { gte: ictDayStart(fromParam!), lte: ictDayEnd(toRaw!) },
            }
          : undefined,
        orderBy: { publishedAt: "desc" },
        take: hasRange ? Math.max(limit, 60) : limit,
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
      readSources(),
      db.newsItem.count(),
    ]);
    const newsSource = sources.find((s) => s.key === "news");
    const stale = newsSource
      ? staleOf(newsSource)
      : { stale: false, ageMinutes: null };
    // P2-2/#62 — độ tin cậy per-feed tích luỹ từ meta nguồn (parse lỗi + trùng)
    const reliability =
      (newsSource?.meta?.reliability as FeedReliabilityMap | undefined) ?? {};
    const lastFeeds =
      (newsSource?.meta?.feeds as
        | { name: string; ok: boolean; items: number; skipped?: number; duplicates?: number }[]
        | undefined) ?? [];

    return NextResponse.json({
      items,
      meta: {
        total,
        mode: newsSource?.mode ?? "fallback",
        lastSuccessAt: newsSource?.lastSuccessAt?.toISOString() ?? null,
        stale: stale.stale,
        ageMinutes: stale.ageMinutes,
        providers: (newsSource?.meta?.providers as string[] | undefined) ?? [],
        reliability,
        feeds: lastFeeds,
      },
    });
  } catch (err) {
    console.error("[api/news GET]", err);
    return NextResponse.json(
      { error: "Không tải được tin tức." },
      { status: 500 }
    );
  }
}

export async function POST() {
  try {
    const result = await ingestNews();
    if (result.feeds.length === 0) {
      return NextResponse.json(
        {
          error: "Vừa nạp tin cách đây dưới 60 giây — vui lòng đợi chút.",
          ...result,
        },
        // F-210 (audit 19-b): header chuẩn Retry-After để client backoff đúng
        {
          status: 429,
          headers: { "Retry-After": String(result.retryAfterSeconds ?? 60) },
        }
      );
    }
    return NextResponse.json(result);
  } catch (err) {
    console.error("[api/news POST]", err);
    return NextResponse.json(
      { error: "Nạp tin tức thất bại. Vui lòng thử lại." },
      { status: 500 }
    );
  }
}
