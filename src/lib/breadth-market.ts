import { db } from "@/lib/db";

/**
 * src/lib/breadth-market.ts — BREADTH TOÀN SÀN T0 (UNIVERSE_TIERING_BLUEPRINT §7).
 *
 * Lấp khoảng trống Task 186: breadth cũ chỉ trên ~30 mã HOSE-STOCK quoted CORE;
 * breadth này tính trên TOÀN BỘ STOCK VN có bar (CORE + BROAD ~1.000 mã):
 *   • A/D — tăng/giảm/giữ so close PHIÊN TRƯỚC của chính mã (phiên chuẩn =
 *     ngày bar mới nhất TOÀN THỊ TRƯỜNG; mã không có bar phiên đó = không tính)
 *   • %trên MA20/50/200 — trên chuỗi close từng mã trong cửa sổ cuộn
 *
 * On-demand + cache TTL 10 phút (pattern MACRO_CACHE_TTL_MS) — KHÔNG nằm
 * trong chu kỳ agent 23 agents (ngân sách 180s); Phase 2 mới cân nhắc bỏ
 * phiếu vào Bayes composite (kèm bài toán trọng số + test T5.2).
 *
 * Chỉ type STOCK (chuẩn A/D sàn — ETF không tham gia breadth); ETF BROAD
 * vẫn được nạp bar để screen trọng tâm dùng riêng.
 */

const BREADTH_CACHE_TTL_MS = 10 * 60_000;
/** Cửa sổ tải bar — khớp BROAD_WINDOW_DAYS 420 ngày (~260 phiên cho MA200). */
const BREADTH_WINDOW_DAYS = 420;

export interface BreadthRow {
  market: string;
  advancing: number;
  declining: number;
  unchanged: number;
  /** Có bar trong cửa sổ nhưng KHÔNG có bar phiên chuẩn → không tính A/D. */
  nonTrading: number;
  aboveMa20: number;
  aboveMa50: number;
  aboveMa200: number;
  /** Số mã có ≥2 bar trong cửa sổ (mẫu tính A/D + %MA). */
  counted: number;
}

export interface BreadthMarket {
  /** Phiên chuẩn (ngày bar mới nhất toàn thị trường, ISO YYYY-MM-DD). */
  asOf: string;
  byMarket: BreadthRow[];
  total: BreadthRow;
  /** Phân bổ vũ trụ theo tầng (giao diện + nghiệm thu T1.7). */
  universe: { core: number; broad: number; broadNoBar: number };
  computedAt: string;
}

interface CacheBox {
  at: number;
  value: BreadthMarket;
}
let breadthCacheBox: CacheBox | null = null;

interface BarLite {
  instrumentId: string;
  date: Date;
  close: number;
}

export async function loadBreadthMarket(): Promise<BreadthMarket> {
  if (breadthCacheBox && Date.now() - breadthCacheBox.at < BREADTH_CACHE_TTL_MS) {
    return breadthCacheBox.value;
  }

  const instruments = await db.instrument.findMany({
    where: {
      isActive: true,
      market: { in: ["HOSE", "HNX", "UPCOM"] },
      type: "STOCK",
    },
    select: { id: true, market: true, universeTier: true },
  });
  const idToMarket = new Map(instruments.map((i) => [i.id, i.market as string]));
  const universe = {
    core: instruments.filter((i) => i.universeTier === "CORE").length,
    broad: instruments.filter((i) => i.universeTier === "BROAD").length,
    broadNoBar: 0,
  };

  const cutoff = new Date(Date.now() - BREADTH_WINDOW_DAYS * 86_400_000);
  // 1 query duy nhất toàn bộ bar trong cửa sổ (≈ 1.000 mã × ~270 phiên
  // ≈ 270K dòng chọn 3 cột — WAN ~3-5s, cache 10' phía sau)
  const bars = await db.bar.findMany({
    where: { instrumentId: { in: instruments.map((i) => i.id) }, date: { gte: cutoff } },
    orderBy: [{ instrumentId: "asc" }, { date: "asc" }],
    select: { instrumentId: true, date: true, close: true },
  });

  // Gom chuỗi close từng mã (đã sort asc theo (instrumentId, date))
  const series = new Map<string, { dates: string[]; closes: number[] }>();
  let asOf = "";
  for (const b of bars as BarLite[]) {
    if (!(b.close > 0)) continue;
    let e = series.get(b.instrumentId);
    if (!e) {
      e = { dates: [], closes: [] };
      series.set(b.instrumentId, e);
    }
    const d = b.date.toISOString().slice(0, 10);
    e.dates.push(d);
    e.closes.push(b.close);
    if (d > asOf) asOf = d;
  }

  universe.broadNoBar = instruments.filter(
    (i) => i.universeTier === "BROAD" && !series.has(i.id)
  ).length;

  const ma = (closes: number[], n: number): number | null => {
    if (closes.length < n) return null;
    let s = 0;
    for (let k = closes.length - n; k < closes.length; k++) s += closes[k]!;
    return s / n;
  };

  const emptyRow = (market: string): BreadthRow => ({
    market,
    advancing: 0,
    declining: 0,
    unchanged: 0,
    nonTrading: 0,
    aboveMa20: 0,
    aboveMa50: 0,
    aboveMa200: 0,
    counted: 0,
  });
  const rows = new Map<string, BreadthRow>();
  const total = emptyRow("TOTAL");
  for (const m of ["HOSE", "HNX", "UPCOM"]) rows.set(m, emptyRow(m));

  for (const [instrumentId, s] of series) {
    if (s.closes.length < 2) continue; // mẫu tối thiểu A/D
    const market = idToMarket.get(instrumentId);
    const row = market ? (rows.get(market) ?? total) : total;
    row.counted++;
    total.counted++;
    // A/D: so close phiên chuẩn vs phiên trước của CHÍNH mã
    const lastIdx = s.dates.length - 1;
    if (s.dates[lastIdx] === asOf) {
      const diff = s.closes[lastIdx]! - s.closes[lastIdx - 1]!;
      if (diff > 0) {
        row.advancing++;
        total.advancing++;
      } else if (diff < 0) {
        row.declining++;
        total.declining++;
      } else {
        row.unchanged++;
        total.unchanged++;
      }
    } else {
      row.nonTrading++;
      total.nonTrading++;
    }
    // %trên MA
    const last = s.closes[lastIdx]!;
    if ((ma(s.closes, 20) ?? -Infinity) < last) {
      row.aboveMa20++;
      total.aboveMa20++;
    }
    if ((ma(s.closes, 50) ?? -Infinity) < last) {
      row.aboveMa50++;
      total.aboveMa50++;
    }
    if ((ma(s.closes, 200) ?? -Infinity) < last) {
      row.aboveMa200++;
      total.aboveMa200++;
    }
  }

  const value: BreadthMarket = {
    asOf: asOf || new Date().toISOString().slice(0, 10),
    byMarket: [...rows.values()],
    total,
    universe,
    computedAt: new Date().toISOString(),
  };
  breadthCacheBox = { at: Date.now(), value };
  return value;
}
