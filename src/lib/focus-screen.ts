import { db } from "@/lib/db";

/**
 * src/lib/focus-screen.ts — SCREEN MÃ TRỌNG TÂM T2 (UNIVERSE_TIERING_BLUEPRINT §4).
 *
 * Phễu ngược của T0: từ ~1.000 mã toàn sàn chọn ~20-30 mã "đáng bám" bằng
 * ADTV20 (than khoản) + ổn định 2 snapshot (hysteresis từ lịch sử — thuần hàm
 * của Bar, deterministic, chạy lại ra cùng kết quả):
 *
 *   focus = top-30 ADTV20 hôm nay VÀ rank ADTV20 tại mốc T-10 phiên ≤ 40
 *   (chống mã nhảy vào top vì MỘT phiên volume bất thường — gần đúng luật
 *   2-trong-3-tuần đầy đủ của Phase 2 nhưng rẻ và giải thích được).
 *
 * Phase 1 = ĐỀ XUẤT hiển thị (badge THĂNG CẤP T2 cho BROAD vào focus · GIỮ
 * cho CORE ở lại · HẠ CẤP cho CORE rơi khỏi top-60). Phase 2 (tiêu thụ dữ
 * liệu T2: bar 5-phút · tin RAG · phiếu LLM) mới ép luật vào/ra có trạng thái.
 *
 * On-demand + cache TTL 10 phút — KHÔNG trong chu kỳ agent 23 agents.
 */

const FOCUS_CACHE_TTL_MS = 10 * 60_000;
const FOCUS_WINDOW_DAYS = 420; // khớp cửa sổ cuộn T0
/** Số phiên lùi để tính snapshot ổn định thứ hai. */
const STABILITY_LAG_SESSIONS = 10;
/** focus = top-N hôm nay; ổn định = rank tại T-10 ≤ STABILITY_MAX_RANK. */
export const FOCUS_TOP_N = 30;
export const STABILITY_MAX_RANK = 40;
/** Trả thêm N mã "gần trọng tâm" để UI có ngữ cảnh bám sát. */
const NEAR_FOCUS_EXTRA = 10;
/** CORE rơi khỏi top-60 → gợi ý xem lại (hysteresis hạt lớn). */
const DEMOTION_RANK = 60;

export type FocusAction = "THĂNG-CẤP-T2" | "GIỮ-T1" | "GẦN-TRỌNG-TÂM" | "THEO-DÕI-T0" | "XEM-LẠI";

export interface FocusRow {
  symbol: string;
  name: string;
  market: string;
  tier: "CORE" | "BROAD";
  /** ADTV20 hôm nay (VND). */
  adtv20Vnd: number;
  rankNow: number;
  /** Rank ADTV20 tại snapshot T-10 phiên (null = không đủ dữ liệu). */
  rankStable: number | null;
  /** Động lượng 20 phiên (%, close cuối / close 20 phiên trước − 1). */
  momentum20Pct: number | null;
  aboveMa50: boolean | null;
  action: FocusAction;
}

export interface FocusScreen {
  asOf: string;
  /** Top-N đạt điều kiện ổn định (đề xuất trọng tâm). */
  focus: FocusRow[];
  /** Top tiếp theo chưa đạt ổn định (gần trọng tâm — bám sát). */
  near: FocusRow[];
  /** Thống kê trưng bày + nghiệm thu T1.8. */
  stats: {
    universeStocks: number;
    broadInFocus: number;
    coreInFocus: number;
    coreDemoted: number;
  };
  rule: { topN: number; stabilityMaxRank: number; lagSessions: number; demotionRank: number };
  computedAt: string;
}

interface CacheBox {
  at: number;
  value: FocusScreen;
}
let focusCacheBox: CacheBox | null = null;

export async function loadFocusScreen(): Promise<FocusScreen> {
  if (focusCacheBox && Date.now() - focusCacheBox.at < FOCUS_CACHE_TTL_MS) {
    return focusCacheBox.value;
  }

  const instruments = await db.instrument.findMany({
    where: {
      isActive: true,
      market: { in: ["HOSE", "HNX", "UPCOM"] },
      type: { in: ["STOCK", "ETF"] },
    },
    select: { id: true, symbol: true, name: true, market: true, universeTier: true },
  });

  const cutoff = new Date(Date.now() - FOCUS_WINDOW_DAYS * 86_400_000);
  // 1 query: date + close + volume + value (value là king cho ADTV —
  // fallback close×volume giống topByAdtv #59)
  const bars = await db.bar.findMany({
    where: { instrumentId: { in: instruments.map((i) => i.id) }, date: { gte: cutoff } },
    orderBy: [{ instrumentId: "asc" }, { date: "asc" }],
    select: { instrumentId: true, date: true, close: true, volume: true, value: true },
  });

  interface Entry {
    dates: string[];
    closes: number[];
    values: number[];
  }
  const series = new Map<string, Entry>();
  for (const b of bars) {
    if (!(b.close > 0)) continue;
    let e = series.get(b.instrumentId);
    if (!e) {
      e = { dates: [], closes: [], values: [] };
      series.set(b.instrumentId, e);
    }
    e.dates.push(b.date.toISOString().slice(0, 10));
    e.closes.push(b.close);
    e.values.push(b.value != null ? Number(b.value) : b.close * b.volume);
  }

  const adtvAt = (e: Entry, endIdx: number): number | null => {
    if (endIdx < 20) return null; // cần đủ 20 phiên
    let s = 0;
    for (let k = endIdx - 19; k <= endIdx; k++) s += e.values[k]!;
    return s / 20;
  };

  // Xếp hạng hôm nay + snapshot T-10
  const todayList: { inst: (typeof instruments)[number]; adtv: number }[] = [];
  const stableList: { inst: (typeof instruments)[number]; adtv: number }[] = [];
  let asOf = "";
  for (const inst of instruments) {
    const e = series.get(inst.id);
    if (!e || e.closes.length < 22) continue; // ≥ 20 + 2 để có momentum/so sánh
    const lastIdx = e.closes.length - 1;
    if (e.dates[lastIdx]! > asOf) asOf = e.dates[lastIdx]!;
    const adtvNow = adtvAt(e, lastIdx);
    if (adtvNow != null && adtvNow > 0) {
      todayList.push({ inst, adtv: adtvNow });
    }
    const stableIdx = lastIdx - STABILITY_LAG_SESSIONS;
    const adtvStable = adtvAt(e, stableIdx);
    if (adtvStable != null && adtvStable > 0) {
      stableList.push({ inst, adtv: adtvStable });
    }
  }
  todayList.sort((a, b) => b.adtv - a.adtv);
  stableList.sort((a, b) => b.adtv - a.adtv);
  const rankNowBySymbol = new Map<string, number>();
  todayList.forEach((t, i) => rankNowBySymbol.set(t.inst.symbol, i + 1));
  const rankStableBySymbol = new Map<string, number>();
  stableList.forEach((t, i) => rankStableBySymbol.set(t.inst.symbol, i + 1));

  const toRow = (t: { inst: (typeof instruments)[number]; adtv: number }, rankNow: number): FocusRow => {
    const e = series.get(t.inst.id)!;
    const lastIdx = e.closes.length - 1;
    const momentum =
      e.closes.length >= 21
        ? (e.closes[lastIdx]! / e.closes[lastIdx - 20]! - 1) * 100
        : null;
    let ma50: number | null = null;
    if (e.closes.length >= 50) {
      let s = 0;
      for (let k = lastIdx - 49; k <= lastIdx; k++) s += e.closes[k]!;
      ma50 = s / 50;
    }
    const rankStable = rankStableBySymbol.get(t.inst.symbol) ?? null;
    const isCore = t.inst.universeTier === "CORE";
    const stable = rankStable != null && rankStable <= STABILITY_MAX_RANK;
    let action: FocusAction;
    if (rankNow <= FOCUS_TOP_N && stable) {
      action = isCore ? "GIỮ-T1" : "THĂNG-CẤP-T2";
    } else if (rankNow <= FOCUS_TOP_N + NEAR_FOCUS_EXTRA) {
      action = "GẦN-TRỌNG-TÂM";
    } else if (isCore && rankNow > DEMOTION_RANK) {
      action = "XEM-LẠI";
    } else {
      action = "THEO-DÕI-T0";
    }
    return {
      symbol: t.inst.symbol,
      name: t.inst.name,
      market: t.inst.market as string,
      tier: t.inst.universeTier === "CORE" ? "CORE" : "BROAD",
      adtv20Vnd: Math.round(t.adtv),
      rankNow,
      rankStable,
      momentum20Pct: momentum != null ? Number(momentum.toFixed(2)) : null,
      aboveMa50: ma50 != null ? e.closes[lastIdx]! > ma50 : null,
      action,
    };
  };

  const focus: FocusRow[] = [];
  const near: FocusRow[] = [];
  todayList.forEach((t, i) => {
    const rankNow = i + 1;
    if (rankNow > FOCUS_TOP_N + NEAR_FOCUS_EXTRA) return;
    const row = toRow(t, rankNow);
    const stable = row.rankStable != null && row.rankStable <= STABILITY_MAX_RANK;
    if (rankNow <= FOCUS_TOP_N && stable) focus.push(row);
    else near.push(row);
  });

  const coreDemoted = todayList
    .map((t, i) => ({ t, rank: i + 1 }))
    .filter(
      (x) =>
        x.t.inst.universeTier === "CORE" &&
        x.rank > DEMOTION_RANK &&
        series.has(x.t.inst.id) // có dữ liệu mà vẫn rơi — mới là "xem lại" thật
    ).length;

  const value: FocusScreen = {
    asOf: asOf || new Date().toISOString().slice(0, 10),
    focus,
    near,
    stats: {
      universeStocks: instruments.length,
      broadInFocus: focus.filter((f) => f.tier === "BROAD").length,
      coreInFocus: focus.filter((f) => f.tier === "CORE").length,
      coreDemoted,
    },
    rule: {
      topN: FOCUS_TOP_N,
      stabilityMaxRank: STABILITY_MAX_RANK,
      lagSessions: STABILITY_LAG_SESSIONS,
      demotionRank: DEMOTION_RANK,
    },
    computedAt: new Date().toISOString(),
  };
  focusCacheBox = { at: Date.now(), value };
  return value;
}
