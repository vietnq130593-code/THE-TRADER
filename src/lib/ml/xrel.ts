/**
 * src/lib/ml/xrel.ts — M2_RELATION_BLUEPRINT (phiên #103, cơ chế số 2).
 *
 * "HỌC QUAN HỆ ẢNH HƯỞNG QUA LẠI GIỮA CÁC THỊ TRƯỜNG" từ dữ liệu ĐÃ QUA:
 *   · Lớp 1 (quant, 0 LLM): lead-lag Pearson + xác suất điều kiện giữa các
 *     phân đoạn giá (VN30/VN100 + 10 ngành HOSE, equal-weight từ Bar 750 phiên
 *     ≈ 3 năm) và giữa sentiment tin tức theo ngày (lexicon quant/sentiment.ts)
 *     với lợi suất segment cùng ngày & ngày kế (event-study).
 *   · Lớp 2 (LLM, 1 lần/tuần): tổng hợp nhận định tiếng Việt trên đỉnh quan
 *     hệ đã học — lưu RelationInsight (gọi bởi nhiệm vụ Chủ nhật 05:00 của
 *     learning-rag A13, hoặc nút tay trong UI / POST API).
 *   · Lớp 3 (serving): top quan hệ → khối prompt "QUAN HỆ THỊ TRƯỜNG ĐÃ HỌC"
 *     cho market-analyst · news-sentiment · portfolio-strategist (fail-soft).
 *
 * Kỷ luật trung thực (blueprint §0): mọi quan hệ kèm obs + cửa sổ dữ liệu;
 * không đủ mẫu → KHÔNG lưu quan hệ (kho tin hiện ngắn → lớp news tự báo
 * "đang tích luỹ" thay vì bịa). Engine fail-soft tuyệt đối: lỗi → trả null /
 * kết quả rỗng, không bao giờ làm hỏng chu kỳ agent hay route nào.
 */

import { db } from "@/lib/db";
import { scoreNews } from "@/lib/quant/sentiment";
import { correlation } from "@/lib/quant/statistics";
import { callLlmWithRetry, currentModelId } from "@/lib/llm";

// ─────────────────────────── Hằng số (blueprint §2) ───────────────────────────

/** Cửa sổ học: 750 phiên ≈ 3 năm — đủ dài để quan hệ ổn định. */
const WINDOW_BARS = 750;
/** Ngưỡng lưu quan hệ giá→giá: |corr| tối thiểu. */
const PRICE_MIN_ABS_CORR = 0.15;
/** Ngưỡng lưu quan hệ giá→giá: số cặp quan sát tối thiểu. */
const PRICE_MIN_OBS = 60;
/** Ngưỡng lưu quan hệ tin→giá: số ngày có BOTH tin & lợi suất. */
const NEWS_MIN_OBS = 15;
/** Cú sốc giá: ±0,75% lợi suất 1 ngày của nguồn. */
const SHOCK_PCT = 0.0075;
/** Cú sốc tin: điểm lexicon trung bình ngày vượt ±0,25. */
const NEWS_SHOCK = 0.25;
/** Số mẫu cú sốc tối thiểu để tính condUp/condDown (minh bạch). */
const SHOCK_MIN_N = 15;
/** Giữ top-N quan hệ mỗi loại khi persist. */
const MAX_PRICE_RELATIONS = 40;
const MAX_NEWS_RELATIONS = 20;
/** Lazy-refresh khi bảng quá cũ (GET) — 12h. */
const STALE_MS = 12 * 3_600_000;
/** Nhận định LLM chín khi cũ hơn 6 ngày (chu kỳ Chủ nhật A13). */
const INSIGHT_FRESH_MS = 6 * 86_400_000;
/** Giữ lịch sử nhận định 50 bản gần nhất. */
const INSIGHT_KEEP = 50;
/** Số dòng quan hệ tiêm prompt agents. */
const PROMPT_TOP = 10;
/** Trần ký tự khối prompt (~350 token tiếng Việt). */
const PROMPT_CHAR_CAP = 900;
/** Cache in-process cho khối prompt (giảm đọc DB khi chu kỳ dồn). */
const BLOCK_TTL_MS = 60_000;

// ─────────────────────────── Phân đoạn thị trường (§1) ───────────────────────────

/** Map sector VN (bảng Instrument) → key segment M2. */
const SECTOR_KEYS: Record<string, { key: string; label: string }> = {
  "Ngân hàng": { key: "banks", label: "Ngân hàng" },
  "Chứng khoán": { key: "sec", label: "Chứng khoán" },
  "Bất động sản": { key: "re", label: "Bất động sản" },
  "Vật liệu": { key: "steel", label: "Thép & vật liệu" },
  "Công nghệ": { key: "tech", label: "Công nghệ" },
  "Hàng không": { key: "air", label: "Hàng không" },
  "Năng lượng": { key: "energy", label: "Năng lượng" },
  "Tiêu dùng": { key: "consume", label: "Tiêu dùng" },
  "Bán lẻ": { key: "retail", label: "Bán lẻ" },
  "Y tế": { key: "health", label: "Y tế" },
};

/** ETF proxy chỉ số (thành phần đơn). */
const ETF_PROXIES: Record<string, { key: string; label: string }> = {
  E1VFVN30: { key: "vn30", label: "Chỉ số VN30" },
  FUEVN100: { key: "vn100", label: "Chỉ số VN100" },
};

/** Phân đoạn tin tức (ảo — tổng hợp theo ngày ICT). */
const NEWS_SEGMENTS: { key: string; label: string; category: string }[] = [
  { key: "macro-news", label: "Tin vĩ mô", category: "macro" },
  { key: "market-news", label: "Tin thị trường", category: "market" },
];

interface PriceSegment {
  key: string;
  label: string;
  /** instrumentId[] góp segment. */
  members: string[];
  /** dayKey "YYYY-MM-DD" → lợi suất log equal-weight. */
  returns: Map<string, number>;
}

export interface XrelRelationRow {
  sourceKey: string;
  sourceLabel: string;
  targetKey: string;
  targetLabel: string;
  lag: number;
  kind: "price" | "news";
  corr: number;
  condUp: number | null;
  condDown: number | null;
  obs: number;
  shockUpN: number;
  shockDownN: number;
  strength: number;
  windowFrom: Date;
  windowTo: Date;
}

export interface XrelRefreshResult {
  segments: number;
  priceRelations: number;
  newsRelations: number;
  /** Số ngày ICT có tin tức trong cửa sổ (đối chiếu với giá). */
  newsDays: number;
  /** Ghi chú trung thực khi lớp tin chưa đủ mẫu. */
  newsNote: string | null;
  windowFrom: string;
  windowTo: string;
  durationMs: number;
}

// ─────────────────────────── Tiện ích ───────────────────────────

/** dayKey "YYYY-MM-DD" của bar (neo 15:00Z cùng ngày ICT — quy ước Bar). */
function barDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** dayKey "YYYY-MM-DD" theo ICT (UTC+7) của publishedAt. */
function ictDayKey(d: Date): string {
  return new Date(d.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
}

/** Lợi suất log 1 phiên, an toàn close trước > 0. */
function logRet(prevClose: number, close: number): number | null {
  if (prevClose <= 0 || close <= 0) return null;
  return Math.log(close / prevClose);
}

// ─────────────────────────── Lớp 1 · Engine quant ───────────────────────────

/** Nạp + tính chuỗi lợi suất equal-weight cho từng phân đoạn giá. */
async function loadPriceSegments(): Promise<PriceSegment[]> {
  const instruments = await db.instrument.findMany({
    where: { isActive: true, deletedAt: null, type: { in: ["STOCK", "ETF"] } },
    select: { id: true, symbol: true, sector: true, market: true },
  });

  // Gom thành viên theo segment: ETF proxy trước, rồi sector HOSE (≥2 mã).
  const byKey = new Map<string, { key: string; label: string; members: string[] }>();
  for (const i of instruments) {
    const proxy = ETF_PROXIES[i.symbol];
    if (proxy) {
      const cur = byKey.get(proxy.key) ?? { ...proxy, members: [] };
      cur.members.push(i.id);
      byKey.set(proxy.key, cur);
      continue;
    }
    if (i.market !== "HOSE") continue;
    const sec = i.sector ? SECTOR_KEYS[i.sector] : undefined;
    if (!sec) continue;
    const cur = byKey.get(sec.key) ?? { ...sec, members: [] };
    cur.members.push(i.id);
    byKey.set(sec.key, cur);
  }

  // Đọc 750 bar gần nhất mỗi instrument — lọc trước theo cửa sổ thời gian
  // 1.300 ngày lịch (> 750 phiên ~ 1.095 ngày lịch) để giảm IO, giữ newest-750
  // mỗi mã bằng đếm dồn trên thứ tự DESC toàn cục.
  const ids = [...byKey.values()].flatMap((s) => s.members);
  if (ids.length === 0) return [];
  const cutoff = new Date(Date.now() - 1_300 * 86_400_000);
  const bars = await db.bar.findMany({
    where: { instrumentId: { in: ids }, date: { gte: cutoff } },
    orderBy: { date: "desc" },
    select: { instrumentId: true, date: true, close: true },
  });
  const seen = new Map<string, number>();
  const kept = new Map<string, { day: string; close: number }[]>();
  for (const b of bars) {
    const n = seen.get(b.instrumentId) ?? 0;
    if (n >= WINDOW_BARS) continue;
    seen.set(b.instrumentId, n + 1);
    const list = kept.get(b.instrumentId) ?? [];
    list.push({ day: barDayKey(b.date), close: b.close });
    kept.set(b.instrumentId, list);
  }

  // Mỗi segment: lợi suất log equal-weight theo ngày — yêu cầu ≥ nửa thành
  // viên có dữ liệu ngày đó mới tính (tránh segment bị 1 mã thống trị cả ngày).
  const segments: PriceSegment[] = [];
  for (const { key, label, members } of byKey.values()) {
    const sums = new Map<string, number>();
    const counts = new Map<string, number>();
    for (const id of members) {
      const series = kept.get(id);
      if (!series || series.length < 2) continue;
      // series đang DESC (mới → cũ): lợi suất ngày MỚI = logRet(close cũ, close mới).
      for (let i = 1; i < series.length; i++) {
        const r = logRet(series[i].close, series[i - 1].close);
        if (r == null) continue;
        const day = series[i - 1].day;
        sums.set(day, (sums.get(day) ?? 0) + r);
        counts.set(day, (counts.get(day) ?? 0) + 1);
      }
    }
    const half = Math.max(1, Math.ceil(members.length / 2));
    const returns = new Map<string, number>();
    for (const [day, sum] of sums) {
      const c = counts.get(day) ?? 0;
      if (c >= half) returns.set(day, sum / c); // trung bình equal-weight
    }
    if (returns.size === 0) continue;
    segments.push({ key, label, members, returns });
  }
  return segments;
}

/** Tính quan hệ giá→giá cho mọi cặp có hướng & lag ∈ {0, 1}. */
function computePriceRelations(segs: PriceSegment[]): {
  rows: XrelRelationRow[];
  windowFrom: string;
  windowTo: string;
} {
  // Lịch phiên hợp nhất (tất cả dayKey xuất hiện) — ASC.
  const allDays = new Set<string>();
  for (const s of segs) for (const d of s.returns.keys()) allDays.add(d);
  const calendar = [...allDays].sort();
  const dayIndex = new Map(calendar.map((d, i) => [d, i]));

  // Chuyển Map → mảng theo lịch hợp nhất (undefined = segment thiếu ngày đó).
  const aligned = segs.map((s) => {
    const arr: (number | undefined)[] = new Array(calendar.length).fill(undefined);
    for (const [day, r] of s.returns) arr[dayIndex.get(day) as number] = r;
    return { seg: s, arr };
  });

  const rows: XrelRelationRow[] = [];
  for (const A of aligned) {
    for (const B of aligned) {
      if (A.seg.key === B.seg.key) continue;
      for (const lag of [0, 1] as const) {
        const xs: number[] = [];
        const ys: number[] = [];
        // Cú sốc theo A, phản ứng của B tại t+lag.
        let shockUpN = 0;
        let shockUpTargetUp = 0;
        let shockDownN = 0;
        let shockDownTargetDown = 0;
        for (let t = 0; t + lag < calendar.length; t++) {
          const a = A.arr[t];
          const b = B.arr[t + lag];
          if (a == null || b == null) continue;
          xs.push(a);
          ys.push(b);
          if (a > SHOCK_PCT) {
            shockUpN++;
            if (b > 0) shockUpTargetUp++;
          } else if (a < -SHOCK_PCT) {
            shockDownN++;
            if (b < 0) shockDownTargetDown++;
          }
        }
        const obs = xs.length;
        if (obs < PRICE_MIN_OBS) continue;
        const corr = correlation(xs, ys);
        if (corr == null || Math.abs(corr) < PRICE_MIN_ABS_CORR) continue;
        rows.push({
          sourceKey: A.seg.key,
          sourceLabel: A.seg.label,
          targetKey: B.seg.key,
          targetLabel: B.seg.label,
          lag,
          kind: "price",
          corr,
          condUp: shockUpN >= SHOCK_MIN_N ? shockUpTargetUp / shockUpN : null,
          condDown: shockDownN >= SHOCK_MIN_N ? shockDownTargetDown / shockDownN : null,
          obs,
          shockUpN,
          shockDownN,
          strength: Math.abs(corr) * Math.min(1, obs / 250),
          windowFrom: new Date(`${calendar[0]}T00:00:00.000Z`),
          windowTo: new Date(`${calendar[calendar.length - 1]}T00:00:00.000Z`),
        });
      }
    }
  }
  rows.sort((a, b) => b.strength - a.strength);
  return {
    rows: rows.slice(0, MAX_PRICE_RELATIONS),
    windowFrom: calendar[0],
    windowTo: calendar[calendar.length - 1],
  };
}

/** Tính quan hệ tin→giá: sentiment lexicon theo ngày ICT vs lợi suất segment. */
function computeNewsRelations(
  news: { day: string; category: string; score: number }[],
  segs: PriceSegment[],
  windowFrom: string,
  windowTo: string
): { rows: XrelRelationRow[]; newsDays: number } {
  // Trung bình điểm lexicon theo (ngày ICT × category).
  const sums = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const n of news) {
    const k = `${n.day}|${n.category}`;
    sums.set(k, (sums.get(k) ?? 0) + n.score);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  // Lịch phiên (chỉ ngày giao dịch có giá) trong cửa sổ.
  const allDays = new Set<string>();
  for (const s of segs) for (const d of s.returns.keys()) allDays.add(d);
  const calendar = [...allDays].sort();
  const dayIndex = new Map(calendar.map((d, i) => [d, i]));

  const rows: XrelRelationRow[] = [];
  let newsDays = 0;
  const newsDaysSeen = new Set<string>();
  for (const ns of NEWS_SEGMENTS) {
    // Chuỗi sentiment theo lịch phiên (undefined = ngày không có tin loại này).
    const sentArr: (number | undefined)[] = new Array(calendar.length).fill(undefined);
    for (const [k, sum] of sums) {
      const [day, cat] = k.split("|");
      if (cat !== ns.category) continue;
      const idx = dayIndex.get(day);
      if (idx == null) continue; // tin rơi vào ngày không giao dịch (T7/CN)
      const c = counts.get(k) ?? 1;
      sentArr[idx] = sum / c;
      newsDaysSeen.add(day);
    }
    for (const seg of segs) {
      const segArr: (number | undefined)[] = new Array(calendar.length).fill(undefined);
      for (const [day, r] of seg.returns) segArr[dayIndex.get(day) as number] = r;
      for (const lag of [0, 1] as const) {
        const xs: number[] = [];
        const ys: number[] = [];
        let shockUpN = 0;
        let shockUpTargetUp = 0;
        let shockDownN = 0;
        let shockDownTargetDown = 0;
        for (let t = 0; t + lag < calendar.length; t++) {
          const a = sentArr[t];
          const b = segArr[t + lag];
          if (a == null || b == null) continue;
          xs.push(a);
          ys.push(b);
          if (a > NEWS_SHOCK) {
            shockUpN++;
            if (b > 0) shockUpTargetUp++;
          } else if (a < -NEWS_SHOCK) {
            shockDownN++;
            if (b < 0) shockDownTargetDown++;
          }
        }
        const obs = xs.length;
        if (obs < NEWS_MIN_OBS) continue; // trung thực: chưa đủ ngày mẫu
        const corr = correlation(xs, ys);
        if (corr == null || Math.abs(corr) < PRICE_MIN_ABS_CORR) continue;
        rows.push({
          sourceKey: ns.key,
          sourceLabel: ns.label,
          targetKey: seg.key,
          targetLabel: seg.label,
          lag,
          kind: "news",
          corr,
          condUp: shockUpN >= SHOCK_MIN_N ? shockUpTargetUp / shockUpN : null,
          condDown: shockDownN >= SHOCK_MIN_N ? shockDownTargetDown / shockDownN : null,
          obs,
          shockUpN,
          shockDownN,
          strength: Math.abs(corr) * Math.min(1, obs / 250),
          windowFrom: new Date(`${windowFrom}T00:00:00.000Z`),
          windowTo: new Date(`${windowTo}T00:00:00.000Z`),
        });
      }
    }
  }
  newsDays = newsDaysSeen.size;
  rows.sort((a, b) => b.strength - a.strength);
  return { rows: rows.slice(0, MAX_NEWS_RELATIONS), newsDays };
}

/**
 * Chạy toàn bộ engine Lớp 1: nạp segments → tính price & news relations →
 * persist (bảng = trạng thái học HIỆN TẠI, refresh thay toàn bộ).
 * Idempotent, an toàn gọi chồng.
 */
export async function refreshRelations(): Promise<XrelRefreshResult> {
  const t0 = Date.now();
  const segs = await loadPriceSegments();
  if (segs.length < 2) {
    // Không đủ segment để học — xoá bảng cũ, trả rỗng trung thực.
    await db.marketRelation.deleteMany({});
    return {
      segments: segs.length,
      priceRelations: 0,
      newsRelations: 0,
      newsDays: 0,
      newsNote: "Chưa đủ phân đoạn thị trường để học (cần ≥ 2).",
      windowFrom: "",
      windowTo: "",
      durationMs: Date.now() - t0,
    };
  }

  const price = computePriceRelations(segs);

  // Tin tức: quét toàn kho (trần phòng vệ) + chấm lexicon từng bài.
  const newsItems = await db.newsItem.findMany({
    orderBy: { publishedAt: "desc" },
    take: 5_000,
    select: { title: true, summary: true, category: true, publishedAt: true },
  });
  const news = newsItems
    .filter((n) => n.category === "macro" || n.category === "market")
    .map((n) => ({
      day: ictDayKey(n.publishedAt),
      category: n.category as string,
      score: scoreNews(`${n.title} ${n.summary ?? ""}`.trim()),
    }));
  const newsRes = computeNewsRelations(news, segs, price.windowFrom, price.windowTo);

  const rows = [...price.rows, ...newsRes.rows];
  // Persist: bảng là trạng thái học hiện tại — replace toàn bộ (≤ 60 dòng).
  await db.$transaction([
    db.marketRelation.deleteMany({}),
    ...(rows.length > 0
      ? [db.marketRelation.createMany({ data: rows })]
      : []),
  ]);

  const newsNote =
    newsRes.newsDays < NEWS_MIN_OBS
      ? `Lớp tin→giá đang tích luỹ: ${newsRes.newsDays}/${NEWS_MIN_OBS} ngày có tin đối chiếu được — chưa đủ mẫu để lưu quan hệ (trung thực, không ngoại suy).`
      : null;

  return {
    segments: segs.length,
    priceRelations: price.rows.length,
    newsRelations: newsRes.rows.length,
    newsDays: newsRes.newsDays,
    newsNote,
    windowFrom: price.windowFrom,
    windowTo: price.windowTo,
    durationMs: Date.now() - t0,
  };
}

// ─────────────────────────── Lớp 3 · Serving ───────────────────────────

/** Đọc quan hệ hiện có (đã xếp theo strength DESC). */
export async function getRelations(take = 60) {
  return db.marketRelation.findMany({ orderBy: { strength: "desc" }, take });
}

/** GET-route: refresh nếu bảng trống hoặc cũ hơn 12h — fail-soft. */
export async function maybeRefreshIfStale(): Promise<boolean> {
  try {
    const latest = await db.marketRelation.findFirst({
      orderBy: { computedAt: "desc" },
      select: { computedAt: true },
    });
    const stale =
      !latest || Date.now() - latest.computedAt.getTime() > STALE_MS;
    if (!stale) return false;
    await refreshRelations();
    return true;
  } catch (err) {
    console.error("[xrel] maybeRefreshIfStale lỗi (serve bản cũ):", err);
    return false;
  }
}

let blockCache: { at: number; block: string | null } | null = null;

/** Dòng quan hệ rút gọn cho prompt: "vn30 → banks · cùng ngày · r=+0,86 · P(↑|↑)=82% · n=742". */
function relationLine(r: {
  sourceLabel: string;
  targetLabel: string;
  lag: number;
  kind: string;
  corr: number;
  condUp: number | null;
  condDown: number | null;
  obs: number;
}): string {
  const parts = [
    `${r.sourceLabel} → ${r.targetLabel}`,
    r.lag === 0 ? "cùng ngày" : "ngày kế",
    `r=${r.corr >= 0 ? "+" : ""}${r.corr.toFixed(2)}`,
  ];
  if (r.condUp != null) parts.push(`P(↑|↑)=${Math.round(r.condUp * 100)}%`);
  if (r.condDown != null) parts.push(`P(↓|↓)=${Math.round(r.condDown * 100)}%`);
  parts.push(`n=${r.obs}`);
  return parts.join(" · ");
}

/**
 * Khối prompt "QUAN HỆ THỊ TRƯỜNG ĐÃ HỌC" (top-10, ≤900 ký tự) — tiêm cho
 * market-analyst · news-sentiment · portfolio-strategist. Cache 60s trong
 * process; fail-soft trả null → prompt y như trước M2.
 */
export async function buildXrelPromptBlock(): Promise<string | null> {
  try {
    if (blockCache && Date.now() - blockCache.at < BLOCK_TTL_MS) {
      return blockCache.block;
    }
    const relations = await getRelations(PROMPT_TOP);
    if (relations.length === 0) {
      blockCache = { at: Date.now(), block: null };
      return null;
    }
    const lines = relations.map(relationLine);
    let block =
      "QUAN HỆ THỊ TRƯỜNG ĐÃ HỌC (XREL #103 — hồi cứu từ dữ liệu quá khứ, dùng làm NGỮ CẢNH đối chiếu, không thay bằng chứng định lượng mới nhất):";
    for (const line of lines) {
      const candidate = `${block}\n· ${line}`;
      if (candidate.length > PROMPT_CHAR_CAP) break;
      block = candidate;
    }
    blockCache = { at: Date.now(), block };
    return block;
  } catch (err) {
    console.error("[xrel] buildXrelPromptBlock lỗi (tiêm null):", err);
    return null;
  }
}

/** Thống kê phục vụ service-run learning-rag (A13). */
export async function relationStats(): Promise<{
  total: number;
  price: number;
  news: number;
  lastComputedAt: string | null;
  insight: { generatedAt: string; relationsCount: number } | null;
}> {
  const [total, price, news, latest, insight] = await Promise.all([
    db.marketRelation.count(),
    db.marketRelation.count({ where: { kind: "price" } }),
    db.marketRelation.count({ where: { kind: "news" } }),
    db.marketRelation.findFirst({ orderBy: { computedAt: "desc" }, select: { computedAt: true } }),
    db.relationInsight.findFirst({
      orderBy: { generatedAt: "desc" },
      select: { generatedAt: true, relationsCount: true },
    }),
  ]);
  return {
    total,
    price,
    news,
    lastComputedAt: latest?.computedAt.toISOString() ?? null,
    insight: insight
      ? {
          generatedAt: insight.generatedAt.toISOString(),
          relationsCount: insight.relationsCount,
        }
      : null,
  };
}

// ─────────────────────────── Lớp 2 · Nhận định LLM ───────────────────────────

export interface XrelInsightResult {
  insight: { narrative: string; model: string; generatedAt: string; relationsCount: number };
  created: boolean;
  skippedReason?: string;
}

/**
 * Tổng hợp nhận định quan hệ liên thị trường bằng LLM (1 gọi/tuần mặc định).
 * `force=true` (nút tay / API) → luôn sinh mới. Không có quan hệ → skip
 * trung thực (không cho LLM bịa).
 */
export async function synthesizeRelationInsight(
  force = false
): Promise<XrelInsightResult | null> {
  // Đảm bảo thống kê tươi trước khi tổng hợp (rẻ, idempotent).
  await maybeRefreshIfStale();
  const relations = await getRelations(15);
  if (relations.length === 0) {
    return {
      insight: {
        narrative:
          "Chưa học được quan hệ thị trường nào đủ mạnh để tổng hợp nhận định — engine cần ≥ 2 phân đoạn giá và các ngưỡng mẫu tối thiểu. Bấm «Học lại» sau khi dữ liệu giá/tin tức tích luỹ thêm.",
        model: "(chưa gọi LLM — không đủ dữ liệu)",
        generatedAt: new Date().toISOString(),
        relationsCount: 0,
      },
      created: false,
      skippedReason: "Không có quan hệ đã học — skip tổng hợp (trung thực).",
    };
  }

  if (!force) {
    const latest = await db.relationInsight.findFirst({
      orderBy: { generatedAt: "desc" },
      select: { generatedAt: true },
    });
    if (latest && Date.now() - latest.generatedAt.getTime() < INSIGHT_FRESH_MS) {
      const cur = await db.relationInsight.findFirst({
        orderBy: { generatedAt: "desc" },
      });
      if (cur) {
        return {
          insight: {
            narrative: cur.narrative,
            model: cur.model,
            generatedAt: cur.generatedAt.toISOString(),
            relationsCount: cur.relationsCount,
          },
          created: false,
          skippedReason: "Nhận định còn tươi (< 6 ngày) — dùng bản hiện có.",
        };
      }
    }
  }

  // Bảng quan hệ cho LLM (kèm đầy đủ số liệu để narrative dẫn chứng được).
  const table = relations
    .map(
      (r) =>
        `- ${r.sourceLabel} → ${r.targetLabel} · ${r.lag === 0 ? "cùng ngày" : "ngày kế"} · ` +
        `r=${r.corr >= 0 ? "+" : ""}${r.corr.toFixed(2)} · n=${r.obs}` +
        (r.condUp != null ? ` · P(đích tăng|nguồn bật)=${Math.round(r.condUp * 100)}% (${r.shockUpN} mẫu)` : "") +
        (r.condDown != null
          ? ` · P(đích giảm|nguồn rơi)=${Math.round(r.condDown * 100)}% (${r.shockDownN} mẫu)`
          : "")
    )
    .join("\n");

  const newsCount = relations.filter((r) => r.kind === "news").length;
  const sys =
    "Bạn là máy tổng hợp nhận định quan hệ thị trường của hệ thống giao dịch The Trader. " +
    "Nhiệm vụ: đọc bảng quan hệ ĐÃ HỌC từ dữ liệu quá khứ (tương quan + xác suất điều kiện) " +
    "và viết nhận định TIẾNG VIỆT 4–7 câu về mối quan hệ ảnh hưởng qua lại giữa các thị trường/phân đoạn. " +
    "Cấu trúc: (1) 3–4 quan hệ đáng chú ý nhất & ý nghĩa dẫn dắt thực tế; (2) quan hệ ngược chiều " +
    "hoặc phân tách bất thường nếu có; (3) ĐÚNG 1 câu trung thực về giới hạn mẫu dữ liệu; " +
    "(4) 1 câu hàm ý cần theo dõi cho phiên giao dịch tới. LUÔN dẫn số liệu từ bảng. " +
    "KHÔNG bịa quan hệ không có trong bảng. KHÔNG khuyên đầu tư.";
  const user =
    `BẢNG QUAN HỆ THỊ TRƯỜNG ĐÃ HỌC (${relations.length} quan hệ mạnh nhất, ` +
    `cửa sổ ${relations[0].windowFrom.toISOString().slice(0, 10)} → ${relations[0].windowTo.toISOString().slice(0, 10)}, ` +
    `${newsCount} trong đó là quan hệ tin-tức→giá):\n${table}\n\n` +
    `Viết nhận định theo cấu trúc đã hướng dẫn.`;

  const model = await currentModelId();
  const res = await callLlmWithRetry(sys, user);
  const narrative = res.raw.trim();
  if (!narrative) throw new Error("LLM trả narrative rỗng.");

  // Prune giữ 50 bản gần nhất + tạo bản mới.
  const created = await db.relationInsight.create({
    data: {
      narrative,
      model,
      relationsCount: relations.length,
      statsJson: JSON.stringify({
        top: relations.slice(0, 5).map((r) => ({
          src: r.sourceKey,
          dst: r.targetKey,
          lag: r.lag,
          corr: Number(r.corr.toFixed(3)),
          obs: r.obs,
        })),
        windowFrom: relations[0].windowFrom.toISOString(),
        windowTo: relations[0].windowTo.toISOString(),
        tokensIn: res.tokensIn,
        tokensOut: res.tokensOut,
      }),
    },
  });
  const old = await db.relationInsight.findMany({
    orderBy: { generatedAt: "desc" },
    skip: INSIGHT_KEEP,
    select: { id: true },
  });
  if (old.length > 0) {
    await db.relationInsight.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
  }

  return {
    insight: {
      narrative: created.narrative,
      model: created.model,
      generatedAt: created.generatedAt.toISOString(),
      relationsCount: created.relationsCount,
    },
    created: true,
  };
}
