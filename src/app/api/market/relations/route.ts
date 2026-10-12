import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { maybeRefreshIfStale } from "@/lib/ml/xrel";

export const dynamic = "force-dynamic";

/**
 * GET /api/market/relations (#103 — M2_RELATION_BLUEPRINT, cơ chế số 2).
 *
 * Phục vụ bảng quan hệ thị trường ĐÃ HỌC (giá→giá & tin→giá) + nhận định
 * LLM gần nhất cho card "Quan hệ thị trường" (module Thị trường).
 * Lazy-refresh: bảng trống hoặc cũ hơn 12h → chạy engine quant ngay (fail-soft,
 * lỗi thì vẫn phục vụ bản cũ — engine không bao giờ chặn UI).
 */
export async function GET() {
  try {
    const refreshed = await maybeRefreshIfStale();
    const [relations, insight, counts] = await Promise.all([
      db.marketRelation.findMany({ orderBy: { strength: "desc" }, take: 60 }),
      db.relationInsight.findFirst({ orderBy: { generatedAt: "desc" } }),
      db.marketRelation.groupBy({ by: ["kind"], _count: true }),
    ]);

    const kindCount = Object.fromEntries(counts.map((c) => [c.kind, c._count]));
    return NextResponse.json({
      relations,
      insight: insight
        ? {
            narrative: insight.narrative,
            model: insight.model,
            generatedAt: insight.generatedAt.toISOString(),
            relationsCount: insight.relationsCount,
          }
        : null,
      meta: {
        total: relations.length,
        price: kindCount["price"] ?? 0,
        news: kindCount["news"] ?? 0,
        refreshedNow: refreshed,
        computedAt:
          relations.length > 0
            ? relations[0].computedAt.toISOString()
            : null,
        windowFrom:
          relations.length > 0
            ? relations[0].windowFrom.toISOString().slice(0, 10)
            : null,
        windowTo:
          relations.length > 0
            ? relations[0].windowTo.toISOString().slice(0, 10)
            : null,
      },
    });
  } catch (err) {
    console.error("[api/market/relations GET]", err);
    return NextResponse.json(
      { error: "Không tải được quan hệ thị trường lúc này." },
      { status: 500 }
    );
  }
}
