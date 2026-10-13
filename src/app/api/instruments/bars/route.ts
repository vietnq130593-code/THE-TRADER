import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";
// F-1091-01 (fixbug api #109): validate ngày chia sẻ. Route này không dựng
// Date từ param (so sánh chuỗi ISO) nên không 500 như 5 route kia — nhưng
// "2026-13-01" vẫn lọt qua regex-only cũ → 200 với 0 nến im lặng (verify
// live). isValidIctDay bắt cả roll-over "2026-02-30" → fallback days cũ.
import { isValidIctDay } from "@/lib/api-dates";

export const dynamic = "force-dynamic";

/**
 * GET /api/instruments/bars?symbol=VCB&days=90
 * GET /api/instruments/bars?symbol=VCB&from=2026-09-12&to=2026-10-12 (#105)
 * OHLCV bars for charting + SMA20 (computed over full history before slicing).
 *
 * #105 — khoảng thời gian toàn cục: from/to là ngày "YYYY-MM-DD" theo ICT.
 * Khi hợp lệ, lọc nến theo ngày ISO của nến (so sánh chuỗi — không lệch múi
 * giờ lưu trữ) và NÂNG trần từ 90 nến (F-208) lên 1.200 nến (~5 năm) vì
 * trader chủ động chọn khoảng dài qua bộ chọn trên thanh bar. days= vẫn giữ
 * nguyên hành vi cũ 10..90 khi không có from/to.
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const symbol = (searchParams.get("symbol") ?? "VCB").toUpperCase().trim();
    const fromParam = searchParams.get("from");
    const toParam = searchParams.get("to");
    const hasRange = Boolean(
      fromParam &&
        toParam &&
        isValidIctDay(fromParam) &&
        isValidIctDay(toParam) &&
        fromParam <= toParam,
    );
    const daysRaw = Number(searchParams.get("days") ?? 90);
    const days = Number.isFinite(daysRaw)
      ? Math.min(Math.max(Math.round(daysRaw), 10), 90) // F-208 (audit 19-b): đồng bộ với doc — cap 90 ngày
      : 90;

    const instrument = await db.instrument.findUnique({
      where: { symbol },
      select: { id: true, symbol: true, name: true },
    });
    if (!instrument) {
      return NextResponse.json(
        { error: `Không tìm thấy mã chứng khoán ${symbol}.` },
        { status: 404 }
      );
    }

    const [allBars, quote] = await Promise.all([
      db.bar.findMany({
        where: { instrumentId: instrument.id },
        orderBy: { date: "asc" },
        select: {
          date: true,
          open: true,
          high: true,
          low: true,
          close: true,
          volume: true,
          value: true,
        },
      }),
      db.quote.findFirst({
        where: { instrumentId: instrument.id },
        orderBy: { tradedAt: "desc" },
        select: { last: true, change: true, changePct: true },
      }),
    ]);

    // SMA20 over the full series so early sliced points stay accurate
    const closes = allBars.map((b) => b.close);
    const sma20: (number | null)[] = allBars.map((_, idx) => {
      if (idx < 19) return null;
      const window = closes.slice(idx - 19, idx + 1);
      return window.reduce((s, c) => s + c, 0) / 20;
    });

    // #105: có from/to → lọc trực tiếp theo ngày ISO của nến (SMA20 vẫn tính
    // trên TOÀN BỘ lịch sử nên đầu chuỗi chính xác). Trần 1.200 nến.
    const selected = hasRange
      ? allBars
          .map((b, idx) => ({ b, idx }))
          .filter(({ b }) => {
            const iso = b.date.toISOString().slice(0, 10);
            return iso >= fromParam! && iso <= toParam!;
          })
          .slice(-1200)
      : allBars.map((b, idx) => ({ b, idx })).slice(-days);

    const bars = selected.map(({ b, idx }) => {
      return {
        date: b.date.toISOString().slice(0, 10),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        value: b.value,
        sma20: sma20[idx],
      };
    });

    return NextResponse.json(
      toPlain({
        symbol: instrument.symbol,
        name: instrument.name,
        days: hasRange ? bars.length : days,
        from: hasRange ? fromParam : null,
        to: hasRange ? toParam : null,
        last: quote?.last ?? bars.at(-1)?.close ?? 0,
        change: quote?.change ?? 0,
        changePct: quote?.changePct ?? 0,
        bars,
      })
    );
  } catch (err) {
    console.error("[api/instruments/bars]", err);
    return NextResponse.json(
      { error: "Không tải được dữ liệu biểu đồ." },
      { status: 500 }
    );
  }
}
