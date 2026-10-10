import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";

export const dynamic = "force-dynamic";

/**
 * GET /api/market/intraday?symbol=VCB&days=5 — chuỗi bar 5-phút (bảng
 * IntradayBar, phiên #83 — ML_OPS_BLUEPRINT §6 "Lớp chuỗi đầy đủ").
 *
 * Query:
 *   symbol (bắt buộc) — mã Instrument (VCB, FPT...)
 *   days   (mặc định 5) — số ngày phiên gần nhất lấy về (bỏ qua khi có day)
 *   day    (tuỳ chọn, "YYYY-MM-DD") — lấy ĐÚNG 1 ngày phiên, biên chính xác
 *          [ngày 15:00Z, ngày+1 15:00Z) theo neo date của IntradayBar
 *          (F-841-02/#84: trước fix dùng gte đơn — trả cả mọi ngày SAU ngày
 *          yêu cầu, mâu thuẫn meta days:1 và doc "đúng 1 ngày")
 *
 * Trả về: bars (startTime ISO asc · OHLCV · source · tickCount) + meta
 * {symbol, days, count, tradingDays, lastBarAt, coverage} — coverage = số
 * bucket 5-phút đầy đủ (tickCount ≥ 25 ≈ tick 10s kín bucket 250s) để UI/ML
 * đánh giá độ phủ trung thực (bucket đứt do restart lộ ngay).
 *
 * Không bịa dữ liệu: bucket nào thiếu là thiếu — API chỉ trả những gì có.
 */

const MAX_DAYS = 30;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbol = (url.searchParams.get("symbol") ?? "").trim().toUpperCase();
  const dayParam = url.searchParams.get("day") ?? null;
  const days = Math.min(Math.max(1, Number(url.searchParams.get("days")) || 5), MAX_DAYS);

  if (!symbol) {
    return NextResponse.json(
      { error: "Thiếu tham số symbol (ví dụ: ?symbol=VCB)." },
      { status: 400 }
    );
  }

  try {
    const instrument = await db.instrument.findUnique({
      where: { symbol },
      select: { id: true, symbol: true, name: true, market: true },
    });
    if (!instrument) {
      return NextResponse.json({ error: `Không tìm thấy mã "${symbol}".` }, { status: 404 });
    }

    // Ngày phiên gần nhất có bar (IntradayBar.date neo 15:00Z theo ngày ICT)
    const latestDay = await db.intradayBar.findFirst({
      where: { instrumentId: instrument.id },
      orderBy: { date: "desc" },
      select: { date: true },
    });

    let dateFilter: Date | null = null;
    let dateEnd: Date | null = null; // F-841-02/#84 — biên trên độc quyền khi có day
    if (dayParam && /^\d{4}-\d{2}-\d{2}$/.test(dayParam)) {
      dateFilter = new Date(`${dayParam}T15:00:00.000Z`);
      dateEnd = new Date(dateFilter.getTime() + 86_400_000);
    } else if (latestDay) {
      // lùi (days−1) phiên có dữ liệu — nhóm theo date lấy N ngày gần nhất
      const distinctDays = await db.intradayBar.groupBy({
        by: ["date"],
        where: { instrumentId: instrument.id },
        orderBy: { date: "desc" },
        take: days,
      });
      const oldest = distinctDays[distinctDays.length - 1]?.date;
      dateFilter = oldest ?? latestDay.date;
    }

    const bars = dateFilter
      ? await db.intradayBar.findMany({
          where: {
            instrumentId: instrument.id,
            // F-841-02/#84: có day → range [ngày, ngày+1) — đúng 1 phiên; không
            // có day → gte theo ngày cũ nhất trong cửa sổ days phiên gần nhất.
            date: dateEnd ? { gte: dateFilter, lt: dateEnd } : { gte: dateFilter },
          },
          orderBy: { startTime: "asc" },
          select: {
            startTime: true,
            date: true,
            open: true,
            high: true,
            low: true,
            close: true,
            volume: true,
            value: true,
            source: true,
            tickCount: true,
          },
        })
      : [];

    const fullBuckets = bars.filter((b) => b.tickCount >= 25).length;
    const tradingDays = new Set(bars.map((b) => b.date.toISOString().slice(0, 10))).size;
    const lastBarAt = bars.length > 0 ? bars[bars.length - 1].startTime : null;

    return NextResponse.json(
      toPlain({
        symbol: instrument.symbol,
        name: instrument.name,
        market: instrument.market,
        days: dayParam ? 1 : days,
        count: bars.length,
        tradingDays,
        lastBarAt,
        coverage: {
          fullBuckets,
          partialBuckets: bars.length - fullBuckets,
          note:
            "bucket 5-phút kín (tickCount ≥ 25 ≈ tick 10s suốt bucket) — bucket đứt do restart hiển thị tickCount thật",
        },
        bars,
      })
    );
  } catch (err) {
    console.error("[api/market/intraday]", err);
    return NextResponse.json(
      { error: "Đọc chuỗi intraday 5-phút thất bại." },
      { status: 500 }
    );
  }
}
