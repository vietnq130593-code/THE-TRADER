/**
 * src/lib/council/baskets.ts — CHỈ SỐ 5 RỔ THỊ TRƯỜNG (#106
 * COUNCIL_STEWARDSHIP_BLUEPRINT §2.4 — tầng nền cho thí nghiệm phân bổ E-ALLOC
 * + card "Đa rổ thị trường" trong module Thị trường).
 *
 * Rổ và cách tính (mô hình hoá MINH BẠCH, mọi quyết định ghi trong code):
 *   VN_EQUITY    — top-10 ADTV HOSE (rổ topByAdtv DUY NHẤT của hệ thống,
 *                  P0-2 #57) · equal-weight lợi suất VND.
 *   INTL_EQUITY  — cổ phiếu US/HK equal-weight · USD→VND: (1+r_usd)×(1+r_usdvnd)−1.
 *   BOND         — "thang trái phiếu" 3 tenor Treasury (5Y/10Y/30Y), mỗi tenor
 *                  r_t = −D·Δy% + y%/252 (D = 4,5/8/17 — duration hiệu dụng đơn
 *                  giản hoá; Δy theo điểm %). Rõ ràng là MÔ HÌNH, không phải giá
 *                  từng bond thật — đủ cho nghiên cứu phân bổ (blueprint §7.4).
 *   FOREX        — biến động USD/VND (VND=X): lợi suất giữ USD so với giữ VND —
 *                  quyết định forex cốt lõi của hội đồng VN.
 *   COMMODITY    — hàng hoá equal-weight USD × hệ số USD/VND (như INTL).
 *
 * Trung thực dữ liệu: ngày nào rổ thiếu thành viên (Yahoo quota) → equal-weight
 * trên số thành viên CÓ dữ liệu + cờ coverage; ngày thiếu USD/VND → giữ lợi suất
 * USD thô + cờ fxMissing. Chuỗi ngày = lịch giao dịch THẬT của các bar (không
 * tự sinh ngày). Cache in-process 60s (pattern xrel #103).
 */

import { db } from "@/lib/db";
import { topByAdtv } from "@/lib/dated-series";

export type BasketKey =
  | "VN_EQUITY"
  | "INTL_EQUITY"
  | "BOND"
  | "FOREX"
  | "COMMODITY";

export interface BasketDef {
  key: BasketKey;
  label: string;
  short: string;
  description: string;
}

export const BASKET_DEFS: readonly BasketDef[] = [
  {
    key: "VN_EQUITY",
    label: "Cổ phiếu Việt Nam (top-10 thanh khoản HOSE)",
    short: "CP Việt Nam",
    description: "Equal-weight rổ topByAdtv(10) HOSE — cùng rổ với bằng chứng Bayes/ML",
  },
  {
    key: "INTL_EQUITY",
    label: "Cổ phiếu quốc tế (Mỹ + Hồng Kông)",
    short: "CP quốc tế",
    description: "Equal-weight cổ phiếu US/HK — quy VND qua USD/VND hằng ngày",
  },
  {
    key: "BOND",
    label: "Trái phiếu (Treasury Mỹ 5Y/10Y/30Y)",
    short: "Trái phiếu",
    description: "Thang trái phiếu mô hình hoá: −D·Δy + carry; D = 4,5/8/17",
  },
  {
    key: "FOREX",
    label: "Forex (giữ USD so với VND)",
    short: "Forex USD/VND",
    description: "Lợi suất giữ USD đo bằng biến động cặp USD/VND",
  },
  {
    key: "COMMODITY",
    label: "Hàng hoá (vàng · bạc · dầu · đồng · khí)",
    short: "Hàng hoá",
    description: "Equal-weight hàng hoá USD — quy VND qua USD/VND hằng ngày",
  },
];

// F-1113-04 (fixbug #111 — dọn code rác): xoá 2 export chết BASKET_KEYS +
// basketLabel (0 consumer toàn repo — UI dùng nhãn riêng basket-filter.ts;
// nhãn dài có sẵn trong BasketStats.label trả về mỗi route).

// ─────────────────────────────────────────────────────────────────
// Truy vấn thành viên + chuỗi giá
// ─────────────────────────────────────────────────────────────────

interface MemberSeries {
  symbol: string;
  /** ISO date (YYYY-MM-DD) → close (đơn vị DB theo UnitSpec). */
  closes: Map<string, number>;
}

/** Duration hiệu dụng của thang trái phiếu theo tenor (mô hình hoá §2.4). */
const BOND_DURATION: Record<string, number> = { US5Y: 4.5, US10Y: 8, US30Y: 17 };

async function loadMemberSeries(
  days: number
): Promise<{ byBasket: Map<BasketKey, MemberSeries[]>; usdVnd: MemberSeries | null }> {
  const cutoff = new Date(Date.now() - (days + 10) * 86_400_000);

  // VN_EQUITY — topByAdtv rổ duy nhất của hệ thống (chỉ cần symbol)
  const ranked = await topByAdtv(10, { market: "HOSE", type: "STOCK" }).catch(
    () => []
  );
  const vnSymbols = ranked.map((r) => r.symbol);

  const [intlRows, bondRows, cmdtyRows, vndRow, allBars] = await Promise.all([
    db.instrument.findMany({
      where: { isActive: true, market: { in: ["US", "HK"] }, type: "STOCK" },
      select: { id: true, symbol: true },
    }),
    db.instrument.findMany({
      where: { isActive: true, market: "BOND" },
      select: { id: true, symbol: true },
    }),
    db.instrument.findMany({
      where: { isActive: true, market: "COMMODITY", type: "CMDTY" },
      select: { id: true, symbol: true },
    }),
    db.instrument.findFirst({
      where: { isActive: true, symbol: "VND=X" },
      select: { id: true, symbol: true },
    }),
    db.bar.findMany({
      where: { date: { gte: cutoff } },
      select: { instrumentId: true, date: true, close: true },
      orderBy: { date: "asc" },
    }),
  ]);

  // Gom closes theo instrumentId (1 lượt scan)
  const closesByInst = new Map<string, Map<string, number>>();
  for (const b of allBars) {
    const iso = b.date.toISOString().slice(0, 10);
    let m = closesByInst.get(b.instrumentId);
    if (!m) {
      m = new Map();
      closesByInst.set(b.instrumentId, m);
    }
    m.set(iso, b.close);
  }
  const seriesOf = (rows: { id: string; symbol: string }[]): MemberSeries[] =>
    rows
      .map((r) => ({ symbol: r.symbol, closes: closesByInst.get(r.id) ?? new Map() }))
      .filter((m) => m.closes.size >= 2);

  // VN_EQUITY cần id của từng mã topByAdtv
  const vnRows = vnSymbols.length
    ? await db.instrument.findMany({
        where: { isActive: true, symbol: { in: vnSymbols }, market: "HOSE" },
        select: { id: true, symbol: true },
      })
    : [];

  const byBasket = new Map<BasketKey, MemberSeries[]>();
  byBasket.set("VN_EQUITY", seriesOf(vnRows));
  byBasket.set("INTL_EQUITY", seriesOf(intlRows));
  byBasket.set("BOND", seriesOf(bondRows));
  byBasket.set("COMMODITY", seriesOf(cmdtyRows));
  const usdVnd = vndRow ? seriesOf([vndRow])[0] ?? null : null;
  return { byBasket, usdVnd };
}

// ─────────────────────────────────────────────────────────────────
// Chuỗi lợi suất ngày theo rổ
// ─────────────────────────────────────────────────────────────────

export interface BasketDailyPoint {
  date: string; // ISO YYYY-MM-DD (15:00 UTC convention của Bar)
  ret: number; // lợi suất ngày theo % (VND)
  members: number; // số thành viên có dữ liệu ngày đó
  fxMissing: boolean; // ngày đó thiếu USD/VND (giữ lợi suất USD thô)
}

export interface BasketSeries {
  key: BasketKey;
  label: string;
  series: BasketDailyPoint[];
  memberSymbols: string[];
  coverageDays: number;
  firstDate: string | null;
}

/** Lợi suất USD/VND ngày d (undefined khi thiếu dữ liệu). */
function fxReturn(usdVnd: MemberSeries | null, d: string): number | undefined {
  if (!usdVnd) return undefined;
  const dates = [...usdVnd.closes.keys()].sort();
  const idx = dates.indexOf(d);
  if (idx <= 0) return undefined;
  const prev = usdVnd.closes.get(dates[idx - 1]);
  const cur = usdVnd.closes.get(d);
  if (!prev || !cur || prev <= 0) return undefined;
  return (cur - prev) / prev;
}

/**
 * Equal-weight lợi suất ngày d của các thành viên, so với close NGÀY GẦN NHẤT
 * TRƯỚC d có dữ liệu của từng mã (không yêu cầu ngày liền kề — chống lỗ mạng
 * ngày nghỉ riêng từng sàn).
 */
function equalWeightRet(members: MemberSeries[], d: string): { ret: number | null; n: number } {
  let sum = 0;
  let n = 0;
  for (const m of members) {
    const cur = m.closes.get(d);
    if (cur == null) continue;
    // ngày gần nhất trước d có dữ liệu của mã này
    let prev: number | undefined;
    let prevKey = "";
    for (const k of m.closes.keys()) {
      if (k < d && (prevKey === "" || k > prevKey)) {
        prevKey = k;
      }
    }
    if (prevKey) prev = m.closes.get(prevKey);
    if (prev == null || prev <= 0 || cur == null) continue;
    sum += (cur - prev) / prev;
    n++;
  }
  return n === 0 ? { ret: null, n: 0 } : { ret: sum / n, n };
}

/** Tính chuỗi lợi suất ngày của 5 rổ trong `days` ngày lịch gần nhất. */
export async function basketDailySeries(days = 30): Promise<BasketSeries[]> {
  const { byBasket, usdVnd } = await loadMemberSeries(days);
  // Lịch ngày giao dịch = union ngày có bar của mọi thành viên + USD/VND
  const allDates = new Set<string>();
  for (const members of byBasket.values()) {
    for (const m of members) for (const d of m.closes.keys()) allDates.add(d);
  }
  for (const d of usdVnd?.closes.keys() ?? []) allDates.add(d);
  const sorted = [...allDates].sort().slice(-days);

  const out: BasketSeries[] = [];
  for (const def of BASKET_DEFS) {
    const members = byBasket.get(def.key) ?? [];
    const series: BasketDailyPoint[] = [];
    if (def.key === "FOREX") {
      for (const d of sorted) {
        const r = fxReturn(usdVnd, d);
        if (r == null) continue;
        series.push({ date: d, ret: r * 100, members: 1, fxMissing: false });
      }
    } else if (def.key === "BOND") {
      for (const d of sorted) {
        let sum = 0;
        let n = 0;
        for (const m of members) {
          const dur = BOND_DURATION[m.symbol];
          if (!dur) continue;
          const dates = [...m.closes.keys()].sort();
          const idx = dates.indexOf(d);
          if (idx <= 0) continue;
          const prev = m.closes.get(dates[idx - 1])!;
          const cur = m.closes.get(d)!;
          // y lưu %×100 (BOND_PCT) → Δy(điểm %) = (cur−prev)/100;
          // lợi suất = −D × Δy/100 + carry (y%/100/252)
          const ret =
            -dur * ((cur - prev) / 100 / 100) + (prev / 100) / 100 / 252;
          sum += ret;
          n++;
        }
        if (n === 0) continue;
        series.push({ date: d, ret: (sum / n) * 100, members: n, fxMissing: false });
      }
    } else {
      // VN_EQUITY (VND trực tiếp) · INTL_EQUITY/COMMODITY (USD × quy VND)
      const needsFx = def.key !== "VN_EQUITY";
      for (const d of sorted) {
        const { ret, n } = equalWeightRet(members, d);
        if (ret == null) continue;
        const fx = needsFx ? fxReturn(usdVnd, d) : 0;
        const fxMissing = needsFx && fx == null;
        const retVnd = needsFx && fx != null ? (1 + ret) * (1 + fx) - 1 : ret;
        series.push({ date: d, ret: retVnd * 100, members: n, fxMissing });
      }
    }
    out.push({
      key: def.key,
      label: def.label,
      series,
      // FOREX rổ = cặp USD/VND (nạp riêng qua usdVnd, không nằm trong
      // byBasket) — hiển thị đúng thành viên thay vì "0 mã"
      memberSymbols:
        def.key === "FOREX" ? (usdVnd ? [usdVnd.symbol] : []) : members.map((m) => m.symbol),
      coverageDays: series.length,
      firstDate: series[0]?.date ?? null,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────
// Thống kê phục vụ hội nghị phân bổ + UI
// ─────────────────────────────────────────────────────────────────

export interface BasketStats {
  key: BasketKey;
  label: string;
  short: string;
  description: string;
  members: string[];
  coverageDays: number;
  firstDate: string | null;
  lastDate: string | null;
  ret1d: number | null;
  ret5d: number | null;
  ret30d: number | null;
  vol30d: number | null; // độ lệch chuẩn lợi suất ngày (%)
  bestDay: number | null;
  worstDay: number | null;
  /** #110 M4.5.1 — chuỗi NAV lũy kế 30 phiên (base 100) để vẽ sparkline mỗi rổ
   *  trên card Đa rổ (UIUX_UPGRADE_BLUEPRINT §4 M4.5) — cùng dữ liệu đã tính
   *  cho ret30d, không query thêm. */
  nav30d: number[];
}

function windowRet(series: BasketDailyPoint[], n: number): number | null {
  if (series.length === 0) return null;
  const take = series.slice(-n - 1);
  if (take.length < 2) return null;
  // lũy kế nhân theo lợi suất ngày của rổ (compound đúng bản chất)
  let acc = 1;
  for (let i = 1; i < take.length; i++) acc *= 1 + take[i].ret / 100;
  return (acc - 1) * 100;
}

function stdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const varr = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(varr);
}

/** Thống kê từng rổ trong `window` phiên gần nhất (prompt hội nghị + card UI). */
export async function basketStats(window = 30): Promise<BasketStats[]> {
  const seriesList = await basketDailySeries(window + 5);
  return seriesList.map((s) => {
    const def = BASKET_DEFS.find((b) => b.key === s.key)!;
    const last30 = s.series.slice(-window);
    const rets = last30.map((p) => p.ret);
    // F-1113-01 (fixbug #111 — P1): NAV lũy kế phải dùng CÙNG cửa sổ nguồn với
    // windowRet (slice(-window-1), compound từ take[1] — bỏ r0, return của điểm
    // đầu thuộc biến động từ NGOÀI cửa sổ vào). Trước fix nav30d compound cả r0
    // → nav[0] ≠ 100 (VD VN_EQUITY 101,55) và nav[cuối] ≠ 100+ret30d → aria
    // "…% so nền 100" đọc sai số + 5 sparkline không đồng footing so chéo.
    // Neo 100 prepended literal ≡ mức đóng cửa ngày TRƯỚC cửa sổ: nav[cuối] ≡
    // 100×(1+ret30d/100) với MỌI coverage; độ dốc first→last không đổi.
    const nav30d: number[] = [];
    {
      const take = s.series.slice(-window - 1);
      let acc = 100;
      nav30d.push(acc);
      for (let i = 1; i < take.length; i++) {
        acc *= 1 + take[i].ret / 100;
        nav30d.push(acc);
      }
    }
    return {
      key: s.key,
      label: def.label,
      short: def.short,
      description: def.description,
      members: s.memberSymbols,
      coverageDays: s.coverageDays,
      firstDate: s.firstDate,
      lastDate: s.series[s.series.length - 1]?.date ?? null,
      ret1d: s.series[s.series.length - 1]?.ret ?? null,
      ret5d: windowRet(s.series, 5),
      // F-1114-03 (fixbug #111): ret30d theo tham số `window` (đồng bộ cửa sổ
      // với nav30d) — hiện caller duy nhất basketStatsCached() luôn window=30
      // nên giá trị không đổi; chống lệch cửa sổ nếu sau này gọi window≠30.
      ret30d: windowRet(s.series, window),
      vol30d: stdev(rets),
      bestDay: rets.length ? Math.max(...rets) : null,
      worstDay: rets.length ? Math.min(...rets) : null,
      nav30d,
    };
  });
}

// ─────────────────────────────────────────────────────────────────
// Cache in-process 60s (pattern xrel #103 — phục vụ vision + API)
// ─────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60_000;
let cacheAt = 0;
let cachedStats: BasketStats[] | null = null;

export async function basketStatsCached(): Promise<BasketStats[]> {
  if (cachedStats && Date.now() - cacheAt < CACHE_TTL_MS) return cachedStats;
  cachedStats = await basketStats(30);
  cacheAt = Date.now();
  return cachedStats;
}

// F-1113-04 (fixbug #111 — dọn code rác): xoá basketDailySeriesCached —
// 0 consumer toàn repo; kèm 2 lỗi latent nếu được hồi sinh: (a) chia sẻ
// biến cacheAt với basketStatsCached (stats refresh liên tục → series stale
// vô hạn), (b) tham số `days` bị bỏ qua khi cache-hit. cachedSeries xoá theo.
