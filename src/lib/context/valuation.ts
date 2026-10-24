/** (Task 144 P2-b) — tách từ src/lib/agent-context.ts (pure move)
 *  Khối A3 Fair Value: buildValuationBlock (dải định giá 90 phiên). */

import { db } from "@/lib/db";
import { topByAdtv } from "@/lib/dated-series";

/** Trung bình / độ lệch chuẩn — cho dải giá 90 phiên (A3 Fair Value). */
function meanOf(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}
function stdOf(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = meanOf(xs);
  return Math.sqrt(meanOf(xs.map((x) => (x - m) * (x - m))));
}

/**
 * Dải định giá 90 phiên cho top-10 thanh khoản (A3 Fair Value — mở rộng 23 agents):
 * giá hiện tại vs min/max/mean/σ, z-score, % so đỉnh/đáy 90 phiên.
 */
export async function buildValuationBlock(): Promise<string> {
  // B5 §3.4 — khoá rổ về HOSE-STOCK (continuity #34; universe đa sàn/index
  // volume ~2,1 tỷ không được tràn vào top-10 định giá)
  const instruments = await db.instrument.findMany({
    // F-1892-01 (fixbug #189): lọc tồn tại Quote ở DB — BROAD HOSE (359 mã
    // không quote) khỏi nạp hàng chết; hành vi như cũ (quoteRows lọc null).
    where: { isActive: true, market: "HOSE", type: "STOCK", quotes: { some: {} } },
    select: {
      id: true,
      symbol: true,
      sector: true,
      quotes: { orderBy: { tradedAt: "desc" }, take: 1, select: { last: true } },
    },
  });
  const quoteRows = instruments
    .map((i) => {
      const q = i.quotes[0];
      return q ? { id: i.id, symbol: i.symbol, sector: i.sector, last: q.last } : null;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  // P0-2 (phiên #57): top-10 qua rổ DUY NHẤT topByAdtv (ADTV 45 phiên
  // Bar.value) — thay xếp theo quote volume (lớp bug F6 còn sót)
  const adtvTop = await topByAdtv(10, { market: "HOSE", type: "STOCK" }).catch(() => []);
  const quotedById = new Map(quoteRows.map((r) => [r.id, r]));
  const top10 = adtvTop
    .map((t) => quotedById.get(t.id))
    .filter((r): r is NonNullable<typeof r> => r != null);

  const bars = await db.bar.findMany({
    where: { instrumentId: { in: top10.map((t) => t.id) } },
    orderBy: { date: "asc" },
    select: { instrumentId: true, close: true },
  });
  const closesBy = new Map<string, number[]>();
  for (const b of bars) {
    const arr = closesBy.get(b.instrumentId) ?? [];
    arr.push(b.close);
    closesBy.set(b.instrumentId, arr);
  }

  // B11 — cột P/E · EPS · BVPS · ROE CHỈ thêm khi nguồn finfo mode=real có dữ liệu
  // (pending-egress trong sandbox → giữ lời khai báo giới hạn trung thực như cũ)
  const fundStatus = await db.dataSourceStatus.findUnique({ where: { key: "fundamentals" } });
  const fundamentalsReal = fundStatus?.mode === "real";
  const fundByInstrument = new Map<
    string,
    { pe: number | null; eps: number | null; bvps: number | null; roe: number | null }
  >();
  if (fundamentalsReal) {
    const fundRows = await db.financialFundamental
      .findMany({
        where: { instrumentId: { in: top10.map((t) => t.id) }, mode: "real" },
        orderBy: [{ year: "desc" }, { period: "desc" }],
        select: { instrumentId: true, pe: true, eps: true, bvps: true, roe: true },
      })
      .catch(() => []);
    for (const f of fundRows) {
      //orderBy year/period desc → bản đầu mỗi instrument là mới nhất
      if (!fundByInstrument.has(f.instrumentId)) {
        fundByInstrument.set(f.instrumentId, { pe: f.pe, eps: f.eps, bvps: f.bvps, roe: f.roe });
      }
    }
  }

  const lines = top10.map((t) => {
    const closes = closesBy.get(t.id) ?? [];
    const last = t.last || (closes.length ? closes[closes.length - 1] : 0);
    if (closes.length < 20 || !last) {
      return `- ${t.symbol}: (không đủ dữ liệu dải giá)`;
    }
    const min = Math.min(...closes);
    const max = Math.max(...closes);
    const m = meanOf(closes);
    const sd = stdOf(closes);
    const z = sd > 0 ? (last - m) / sd : 0;
    const vsHigh = max > 0 ? ((last - max) / max) * 100 : 0;
    const vsLow = min > 0 ? ((last - min) / min) * 100 : 0;
    const band = z > 1.5 ? "ĐẮT bất thường" : z < -1.5 ? "RẺ bất thường" : "trong dải hợp lý";
    const f = fundByInstrument.get(t.id);
    const fundCols =
      fundamentalsReal && f
        ? [
            `P/E ${f.pe != null ? f.pe.toFixed(1).replace(".", ",") : "—"}`,
            `EPS ${f.eps != null ? Math.round(f.eps).toLocaleString("vi-VN") + "₫" : "—"}`,
            `BVPS ${f.bvps != null ? Math.round(f.bvps).toLocaleString("vi-VN") + "₫" : "—"}`,
            `ROE ${f.roe != null ? (f.roe * 100).toFixed(1).replace(".", ",") + "%" : "—"}`,
          ]
        : [];
    return [
      `- ${t.symbol} (${t.sector ?? "—"}):`,
      `giá ${last.toLocaleString("vi-VN")}`,
      `dải 90 phiên ${min.toLocaleString("vi-VN")}–${max.toLocaleString("vi-VN")}`,
      `TB ${Math.round(m).toLocaleString("vi-VN")} ± ${Math.round(sd).toLocaleString("vi-VN")}`,
      `z ${z.toFixed(2)} (${band})`,
      `đỉnh ${vsHigh.toFixed(1)}% · đáy +${vsLow.toFixed(1)}%`,
      ...fundCols,
    ].join(" · ");
  });

  return [
    "DẢI ĐỊNH GIÁ 90 PHIÊN — TOP 10 THANH KHOẢN (z-score = lệch chuẩn so giá TB lịch sử):",
    ...lines,
    fundamentalsReal
      ? "(Cột P/E · EPS · BVPS · ROE từ finfo — chế độ real, đơn vị VND nguyên / tỷ lệ thô)"
      : "(Dữ liệu cơ bản finfo đang ở chế độ pending-egress — chưa thoát khỏi sandbox — định giá chỉ theo dải giá lịch sử, KHÔNG bịa P/E hay chỉ số tài chính)",
  ].join("\n");
}
