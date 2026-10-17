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
 *   · F-10 #129-B (thêm sau #128): Lớp 1b QUỐC TẾ — lead-lag kênh truyền dẫn
 *     quốc tế → VN (^GSPC · ^IXIC · DXY · GC · CL · US10Y · ^HSI · Tencent ×
 *     VNINDEX · VN30) ghép cặp point-in-time theo GIỜ ĐÓNG CỬA (đêm Mỹ tối qua
 *     → sáng VN nay = lag 0; HK đóng sau close VN cùng ngày nên chỉ lag ≥ 1),
 *     permutation test + Bonferroni; lưu CÙNG bảng MarketRelation nhưng dưới
 *     họ sourceKey "intl:*" tách biệt họ trong nước — chi tiết §F-10 bên dưới.
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

  // Gom thành viên theo segment: ETF proxy trước, rồi sector HOSE — sector
  // chấp nhận cả 1 mã (blueprint §1: health = DHG) vì half = max(1, ⌈n/2⌉.
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
    // Không đủ segment để học — xoá bảng cũ (CHỈ họ trong nước — F-10 #129-B giữ
    // nguyên họ "intl:*" có vòng refresh riêng), trả rỗng trung thực.
    await db.marketRelation.deleteMany({
      where: { sourceKey: { not: { startsWith: "intl:" } } },
    });
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
  // Persist: bảng là trạng thái học hiện tại — replace toàn bộ HỌ TRONG NƯỚC
  // (≤ 60 dòng). F-10 #129-B: deleteMany scoped `not startsWith "intl:"` —
  // refresh trong nước KHÔNG xoá quan hệ quốc tế (họ intl: có vòng tính riêng
  // refreshIntlRelations, cùng bảng, cách nhau bằng prefix key).
  await db.$transaction([
    db.marketRelation.deleteMany({
      where: { sourceKey: { not: { startsWith: "intl:" } } },
    }),
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

// ─────────────── F-10 #129-B · Lớp 1b — XREL quốc tế (lead-lag căn giờ) ───────────────
//
// Kênh truyền dẫn quốc tế → VN (AI_ENGINEER_REVIEW_BRAIN v3 §F-10): tính
// lead-lag giữa 8 nguồn quốc tế và 2 chỉ số VN, lưu MarketRelation (kind
// "price") dưới họ sourceKey "intl:*" — prefix tách 2 họ trong CÙNG bảng để
// (a) refresh trong nước không đè quan hệ quốc tế và ngược lại, (b) consumer
// quốc tế (buildXrelIntlPromptBlock) đọc riêng, consumer trong nước giữ nguyên.
//
// QUY TẮC CĂN GIỜ (N4 — point-in-time, quan trọng nhất của F-10):
//   · Nguyên tắc: bar nguồn phải đóng cửa STRICT TRƯỚC phiên VN phản ứng — mọi
//     cặp (nguồn d, đích t) chỉ được ghép khi close nguồn xong trước khi phiên
//     VN t mở cửa 09:00 ICT, tức thông tin nguồn ĐÃ BIẾT khi VN giao dịch t.
//   · Nhóm US (đóng ~04:00 ICT ngày d+1, TRƯỚC mở VN 09:00 ngày d+1): US(d) ghép
//     với phiên VN ĐẦU TIÊN sau ngày d — "đêm Mỹ tối qua → sáng VN nay" = LAG 0;
//     lag L = thêm L phiên VN nữa (US(d) → VN(d+1) là lag 0 theo khung "US lead").
//   · Nhóm HK (đóng 17:00 ICT ngày d — SAU close VN 15:00 cùng ngày, phiên HK
//     giao dịch chồng lấn phiên VN cùng ngày): bỏ pairing trực tiếp ngay phiên
//     kế — HK chỉ dùng LAG ≥ 1 (đích = phiên VN kế của phiên kế sau close HK).
//   · Thực dụng (theo đúng spec): lịch phiên VN = distinct Bar.date của VNINDEX
//     (sorted ASC); base(d) = ngày VN giao dịch đầu tiên > d (binary search);
//     target = base(d) + L phiên VN. Ngày lễ lệch → base tự nhảy sang phiên VN
//     kế có thật (đúng nguyên tắc point-in-time); hết mảng → bỏ cặp.
//
// Thống kê (§F-10.3): Pearson r trên logret daily, tối thiểu 120 cặp ngày
// chung (obs = overlapDays); permutation test 200 lần xáo trộn chuỗi nguồn
// (mulberry32 seed cố định — tái lập được, 0 dependency) → p hai phía; hiệu
// chỉnh Bonferroni × số test đã tính; giữ |r| ≥ 0,25 & p_bonf ≤ 0,05.

/** F-10 #129-B: ngưỡng số cặp ngày chung tối thiểu để tính 1 tổ hợp. */
const INTL_MIN_OVERLAP = 120;
/** F-10 #129-B: số phép xáo trộn cho permutation test (seed cố định). */
const INTL_PERM_N = 200;
/** Seed cố định mulberry32 — cùng dữ liệu ⇒ cùng p-value (tái lập được). */
const INTL_PERM_SEED = 0x129b;
/** Ngưỡng giữ quan hệ quốc tế: |r| tối thiểu (chặt hơn trong nước 0,15). */
const INTL_MIN_ABS_CORR = 0.25;
/** Ngưỡng giữ quan hệ quốc tế: p permutation SAU Bonferroni. */
const INTL_MAX_P = 0.05;
/** Số dòng quan hệ quốc tế tiêm khối prompt (kèm diễn giải chiều). */
const INTL_PROMPT_TOP = 3;
/** Trần ký tự khối prompt quốc tế (3 dòng giàu diễn giải hơn domestic). */
const INTL_PROMPT_CHAR_CAP = 1_200;
/** Cache in-process cho khối prompt quốc tế (đồng nhịp BLOCK_TTL_MS). */
const INTL_BLOCK_TTL_MS = 60_000;

/** Nguồn quốc tế: symbol DB → key chuẩn hoá (bỏ ký tự đặc biệt) + nhãn tiếng Việt. */
interface IntlSourceSpec {
  symbol: string;
  /** Prefix "intl:" + ký hiệu đã làm sạch (^GSPC → intl:GSPC, 0700.HK → intl:HK0700). */
  key: string;
  label: string;
  /** Nhóm giờ đóng cửa: "US" ≈ 04:00 ICT ngày d+1 · "HK" = 17:00 ICT ngày d. */
  closeGroup: "US" | "HK";
  /** Lag được phép: US {0,1,2} · HK {1,2} (bỏ lag 0 — close HK sau close VN). */
  lags: number[];
}

/** 8 nguồn F-10 #129-B — mọi mã ĐÃ sync 06:15 (Instrument.symbol thật trong DB). */
const INTL_SOURCES: IntlSourceSpec[] = [
  { symbol: "^GSPC", key: "intl:GSPC", label: "S&P 500 (Mỹ)", closeGroup: "US", lags: [0, 1, 2] },
  { symbol: "^IXIC", key: "intl:IXIC", label: "Nasdaq Composite (Mỹ)", closeGroup: "US", lags: [0, 1, 2] },
  { symbol: "DX-Y.NYB", key: "intl:DXY", label: "Chỉ số Đô la Mỹ (DXY)", closeGroup: "US", lags: [0, 1, 2] },
  { symbol: "GC=F", key: "intl:GC", label: "Vàng COMEX (Mỹ)", closeGroup: "US", lags: [0, 1, 2] },
  { symbol: "CL=F", key: "intl:CL", label: "Dầu thô WTI (Mỹ)", closeGroup: "US", lags: [0, 1, 2] },
  { symbol: "US10Y", key: "intl:US10Y", label: "Lợi suất TPCP Mỹ 10 năm", closeGroup: "US", lags: [0, 1, 2] },
  { symbol: "^HSI", key: "intl:HSI", label: "Chỉ số Hang Seng (Hồng Kông)", closeGroup: "HK", lags: [1, 2] },
  { symbol: "0700.HK", key: "intl:HK0700", label: "Tencent (Hồng Kông)", closeGroup: "HK", lags: [1, 2] },
];

/** Tra nhanh closeGroup theo sourceKey (dùng lại ở serving để diễn giải lag). */
const INTL_SOURCE_BY_KEY = new Map(INTL_SOURCES.map((s) => [s.key, s]));

/** Đích VN: giữ key chuẩn trong nước (VN30 = "vn30" như segment ETF proxy của
 * refreshRelations; VNINDEX theo cùng quy ước slug thường — không tách chuẩn). */
const INTL_TARGETS: { symbol: string; key: string; label: string }[] = [
  { symbol: "VNINDEX", key: "vnindex", label: "VN-Index" },
  { symbol: "VN30", key: "vn30", label: "Chỉ số VN30" },
];

/** 1 dòng quan hệ quốc tế đủ số liệu để persist (shape khớp MarketRelation). */
interface IntlRelationDraft {
  sourceKey: string;
  sourceLabel: string;
  targetKey: string;
  targetLabel: string;
  lag: number;
  kind: "price";
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

/** Kết quả 1 đợt refresh quốc tế — summary trung thực theo spec F-10 #129-B. */
export interface XrelIntlSkipped {
  /** "intl:GSPC→vnindex:L0" — định danh tổ hợp (nguồn × đích × lag). */
  pair: string;
  reason: string;
}

export interface XrelIntlRefreshResult {
  /** Tổng tổ hợp (nguồn × đích × lag) đã duyệt = kept + skipped.length. */
  pairs: number;
  /** Số quan hệ đạt CẢ 2 ngưỡng (|r| ≥ 0,25 & p Bonferroni ≤ 0,05) → đã lưu. */
  kept: number;
  /** Kích thước họ giả thuyết đã tính p — hệ số Bonferroni của đợt. */
  tested: number;
  /** Từng tổ hợp không lưu được + lý do (thiếu mẫu / dưới ngưỡng / lỗi cặp). */
  skipped: XrelIntlSkipped[];
  windowFrom: string;
  windowTo: string;
  durationMs: number;
}

/** PRNG mulberry32 (F-10 #129-B — tự viết, 0 dependency, seed cố định). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates in-place dùng PRNG truyền vào (xáo trộn chuỗi nguồn). */
function shuffleInPlace<T>(arr: T[], rand: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

/**
 * Permutation test 2 phía cho Pearson: xáo trộn THỨ TỰ chuỗi nguồn 200 lần,
 * đếm tỉ lệ |r| xáo trộn ≥ |r| quan sát. Seed cố định mỗi tổ hợp ⇒ p-value tái
 * lập được giữa các đợt (cùng dữ liệu → cùng kết luận, không nhảy ngẫu nhiên).
 */
function intlPermTwoSidedP(xs: number[], ys: number[], rObs: number): number {
  const rand = mulberry32(INTL_PERM_SEED);
  const shuffled = xs.slice();
  const absRObs = Math.abs(rObs);
  let ge = 0;
  for (let i = 0; i < INTL_PERM_N; i++) {
    shuffleInPlace(shuffled, rand);
    const rp = correlation(shuffled, ys);
    if (rp != null && Math.abs(rp) >= absRObs) ge++;
  }
  return ge / INTL_PERM_N;
}

/** Nạp chuỗi logret daily của 1 instrument theo symbol (bar ASC theo ngày). */
async function loadIntlReturns(
  symbol: string
): Promise<{ days: string[]; rets: Map<string, number> } | null> {
  // Instrument.symbol là @unique — findFirst deterministic; giữ filter like
  // loadPriceSegments để không học trên mã đã deactivate/xoá mềm.
  const inst = await db.instrument.findFirst({
    where: { symbol, isActive: true, deletedAt: null },
    select: { id: true },
  });
  if (!inst) return null;
  const bars = await db.bar.findMany({
    where: { instrumentId: inst.id },
    orderBy: { date: "asc" },
    select: { date: true, close: true },
  });
  if (bars.length < 2) return null;
  const days: string[] = [];
  const rets = new Map<string, number>();
  for (let i = 1; i < bars.length; i++) {
    // Lợi suất log của chính chuỗi nguồn (close phiên trước → close phiên này,
    // theo lịch phiên CỦA NGUỒN — không dính lịch VN).
    const r = logRet(bars[i - 1].close, bars[i].close);
    if (r == null) continue;
    const day = barDayKey(bars[i].date);
    days.push(day);
    rets.set(day, r);
  }
  if (days.length === 0) return null;
  return { days, rets };
}

/** lower-bound: index ĐẦU TIÊN của mảng ngày ASC có day > key (=== length ⇒ hết). */
function firstIndexAfter(sortedDays: string[], key: string): number {
  let lo = 0;
  let hi = sortedDays.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedDays[mid] <= key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Ghép cặp point-in-time 1 tổ hợp (nguồn × đích × lag) theo quy tắc căn giờ
 * §F-10: với mỗi ngày nguồn d có lợi suất, base = phiên VN ĐẦU TIÊN > d (đêm
 * Mỹ/chiều HK đã đóng trước đó), target = base + L phiên VN. Trả về mảng cặp
 * (x = logret nguồn, y = logret đích tại target) + biên cửa sổ dữ liệu thực.
 */
function pairIntlLag(
  srcDays: string[],
  srcRets: Map<string, number>,
  tgtRets: Map<string, number>,
  vnCalendar: string[],
  lag: number
): {
  xs: number[];
  ys: number[];
  firstSourceDay: string | null;
  lastTargetDay: string | null;
} {
  const xs: number[] = [];
  const ys: number[] = [];
  let firstSourceDay: string | null = null;
  let lastTargetDay: string | null = null;
  for (const d of srcDays) {
    const x = srcRets.get(d);
    if (x == null) continue;
    const base = firstIndexAfter(vnCalendar, d);
    if (base >= vnCalendar.length) continue; // không còn phiên VN nào sau d
    const ti = base + lag;
    if (ti >= vnCalendar.length) continue; // lag đẩy ra khỏi mảng → bỏ cặp
    const tDay = vnCalendar[ti];
    const y = tgtRets.get(tDay);
    if (y == null) continue; // đích thiếu dữ liệu ngày đó (trung thực: bỏ cặp)
    xs.push(x);
    ys.push(y);
    if (firstSourceDay == null) firstSourceDay = d;
    lastTargetDay = tDay;
  }
  return { xs, ys, firstSourceDay, lastTargetDay };
}

/**
 * Chạy toàn bộ engine Lớp 1b quốc tế F-10 #129-B: nạp chuỗi nguồn/đích → ghép
 * cặp căn giờ point-in-time → Pearson + permutation + Bonferroni → upsert họ
 * "intl:*" trong MarketRelation (dọn quan hệ cũ không còn đạt ngưỡng — bảng
 * luôn phản ánh trạng thái học HIỆN TẠI). Fail-soft TỪNG CẶP: 1 tổ hợp lỗi
 * (thiếu instrument, thiếu bar, exception tính toán) chỉ vào `skipped`, không
 * giết đợt. Idempotent, an toàn gọi chồng.
 */
export async function refreshIntlRelations(): Promise<XrelIntlRefreshResult> {
  const t0 = Date.now();
  const skipped: XrelIntlSkipped[] = [];

  // ── Đích VN + lịch phiên VN (neo lịch vào VNINDEX theo spec F-10) ──────────
  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  let vnIndex: Awaited<ReturnType<typeof loadIntlReturns>> = null;
  let vnIndexErr: string | null = null;
  let vn30: Awaited<ReturnType<typeof loadIntlReturns>> = null;
  let vn30Err: string | null = null;
  try {
    vnIndex = await loadIntlReturns("VNINDEX");
  } catch (err) {
    vnIndexErr = errMsg(err);
  }
  try {
    vn30 = await loadIntlReturns("VN30");
  } catch (err) {
    vn30Err = errMsg(err);
  }
  const vnCalendar = vnIndex?.days ?? null;
  const targets: {
    spec: (typeof INTL_TARGETS)[number];
    data: Awaited<ReturnType<typeof loadIntlReturns>>;
    err: string | null;
  }[] = [
    { spec: INTL_TARGETS[0], data: vnIndex, err: vnIndexErr },
    { spec: INTL_TARGETS[1], data: vn30, err: vn30Err },
  ];

  // ── Ghép cặp + thống kê từng tổ hợp (fail-soft từng cặp) ──────────────────
  // 2 pha: (1) gom tổ hợp ĐỦ MẪU có r hợp lệ → p permutation; (2) Bonferroni
  // với m = số test đã tính rồi chốt ngưỡng giữ — m phản ánh đúng họ giả thuyết.
  interface Staged {
    draft: IntlRelationDraft;
    pPerm: number;
  }
  const staged: Staged[] = [];

  for (const src of INTL_SOURCES) {
    let srcData: Awaited<ReturnType<typeof loadIntlReturns>> = null;
    let srcErr: string | null = null;
    try {
      srcData = await loadIntlReturns(src.symbol);
    } catch (err) {
      srcErr = errMsg(err);
    }
    for (const tgt of targets) {
      for (const lag of src.lags) {
        const pair = `${src.key}→${tgt.spec.key}:L${lag}`;
        try {
          if (srcErr) {
            skipped.push({ pair, reason: `lỗi nạp bar nguồn ${src.symbol}: ${srcErr}` });
            continue;
          }
          if (!srcData) {
            skipped.push({ pair, reason: `nguồn ${src.symbol} không có instrument active hoặc không đủ bar trong DB` });
            continue;
          }
          if (!vnCalendar) {
            skipped.push({
              pair,
              reason: `lịch phiên VN không dựng được từ VNINDEX${vnIndexErr ? `: ${vnIndexErr}` : " (không có bar)"}`,
            });
            continue;
          }
          if (tgt.err) {
            skipped.push({ pair, reason: `lỗi nạp bar đích ${tgt.spec.symbol}: ${tgt.err}` });
            continue;
          }
          if (!tgt.data) {
            skipped.push({ pair, reason: `đích ${tgt.spec.symbol} không có instrument active hoặc không đủ bar trong DB` });
            continue;
          }

          const { xs, ys, firstSourceDay, lastTargetDay } = pairIntlLag(
            srcData.days,
            srcData.rets,
            tgt.data.rets,
            vnCalendar,
            lag
          );
          const obs = xs.length; // overlapDays — số cặp ngày chung thực dụng
          if (obs < INTL_MIN_OVERLAP) {
            skipped.push({
              pair,
              reason: `chưa đủ mẫu: ${obs}/${INTL_MIN_OVERLAP} cặp ngày chung (dữ liệu quốc tế đang tích luỹ)`,
            });
            continue;
          }
          const corr = correlation(xs, ys);
          if (corr == null) {
            skipped.push({ pair, reason: "chuỗi không có phương sai — corr không xác định" });
            continue;
          }

          // Cú sốc nguồn (ngưỡng dùng chung SHOCK_PCT với lớp trong nước) — condUp/
          // condDown KHÔNG bịa khi thiếu mẫu: null nếu số mẫu cú sốc < SHOCK_MIN_N.
          let shockUpN = 0;
          let shockUpTargetUp = 0;
          let shockDownN = 0;
          let shockDownTargetDown = 0;
          for (let i = 0; i < obs; i++) {
            const x = xs[i];
            const y = ys[i];
            if (x > SHOCK_PCT) {
              shockUpN++;
              if (y > 0) shockUpTargetUp++;
            } else if (x < -SHOCK_PCT) {
              shockDownN++;
              if (y < 0) shockDownTargetDown++;
            }
          }

          staged.push({
            draft: {
              sourceKey: src.key,
              sourceLabel: src.label,
              targetKey: tgt.spec.key,
              targetLabel: tgt.spec.label,
              lag,
              kind: "price",
              corr,
              condUp: shockUpN >= SHOCK_MIN_N ? shockUpTargetUp / shockUpN : null,
              condDown: shockDownN >= SHOCK_MIN_N ? shockDownTargetDown / shockDownN : null,
              obs,
              shockUpN,
              shockDownN,
              strength: Math.abs(corr) * Math.min(1, obs / 250),
              // Cửa sổ từ dữ liệu THỰC của chính tổ hợp (ngày nguồn đầu ghép
              // được → ngày đích cuối ghép được), không phải hằng số.
              windowFrom: new Date(`${firstSourceDay}T00:00:00.000Z`),
              windowTo: new Date(`${lastTargetDay}T00:00:00.000Z`),
            },
            pPerm: intlPermTwoSidedP(xs, ys, corr),
          });
        } catch (err) {
          skipped.push({ pair, reason: `lỗi tính toán: ${errMsg(err)}` });
        }
      }
    }
  }

  // ── Bonferroni trên đúng họ đã tính → chốt quan hệ giữ ────────────────────
  const m = staged.length;
  const kept: IntlRelationDraft[] = [];
  for (const { draft, pPerm } of staged) {
    const pBonf = Math.min(1, pPerm * m);
    const reasons: string[] = [];
    if (Math.abs(draft.corr) < INTL_MIN_ABS_CORR) {
      reasons.push(`|r|=${draft.corr.toFixed(3)} < ${INTL_MIN_ABS_CORR}`);
    }
    if (pBonf > INTL_MAX_P) {
      reasons.push(`p_bonf=${pBonf.toFixed(3)} > ${INTL_MAX_P}`);
    }
    if (reasons.length > 0) {
      skipped.push({
        pair: `${draft.sourceKey}→${draft.targetKey}:L${draft.lag}`,
        reason: reasons.join(" · "),
      });
      continue;
    }
    kept.push(draft);
  }

  // ── Persist họ "intl:*": upsert tổ hợp đạt ngưỡng + dọn tổ hợp cũ đã rớt ──
  // (bảng = trạng thái học hiện tại của HỌ intl — mirror semantics replace-all
  // của lớp trong nước nhưng scoped prefix; unique [sourceKey,targetKey,lag,kind]).
  const now = new Date();
  await db.$transaction([
    db.marketRelation.deleteMany({
      where:
        kept.length === 0
          ? { sourceKey: { startsWith: "intl:" } }
          : {
              sourceKey: { startsWith: "intl:" },
              NOT: {
                OR: kept.map((k) => ({
                  sourceKey: k.sourceKey,
                  targetKey: k.targetKey,
                  lag: k.lag,
                  kind: "price",
                })),
              },
            },
    }),
    ...kept.map((k) =>
      db.marketRelation.upsert({
        where: {
          sourceKey_targetKey_lag_kind: {
            sourceKey: k.sourceKey,
            targetKey: k.targetKey,
            lag: k.lag,
            kind: "price",
          },
        },
        create: { ...k, computedAt: now },
        update: { ...k, computedAt: now },
      })
    ),
  ]);

  const windowFrom = kept.length
    ? new Date(Math.min(...kept.map((k) => k.windowFrom.getTime())))
        .toISOString()
        .slice(0, 10)
    : "";
  const windowTo = kept.length
    ? new Date(Math.max(...kept.map((k) => k.windowTo.getTime())))
        .toISOString()
        .slice(0, 10)
    : "";

  return {
    pairs: kept.length + skipped.length,
    kept: kept.length,
    tested: m,
    skipped,
    windowFrom,
    windowTo,
    durationMs: Date.now() - t0,
  };
}

/** Diễn giải lag quốc tế cho prompt — quy ước căn giờ F-10 #129-B. */
function intlLagPhrase(sourceKey: string, lag: number): string {
  // lag 0 (chỉ nhóm US) = phiên VN ĐẦU TIÊN sau đêm nguồn; lag L = L phiên
  // bổ sung nữa ⇒ phiên VN thứ (L+1) kể từ sau đóng cửa nguồn.
  if (lag === 0) return "đêm Mỹ tối qua → sáng VN nay (lag 0)";
  const group = INTL_SOURCE_BY_KEY.get(sourceKey)?.closeGroup;
  if (group === "HK") return `chiều HK → phiên VN thứ ${lag + 1} sau close HK (lag ${lag})`;
  if (group === "US") return `đêm Mỹ → phiên VN thứ ${lag + 1} sau (lag ${lag})`;
  return `phiên VN thứ ${lag + 1} sau đóng cửa nguồn (lag ${lag})`;
}

/** Dòng quan hệ quốc tế rút gọn + diễn giải chiều cho prompt agents. */
function intlRelationLine(r: {
  sourceKey: string;
  sourceLabel: string;
  targetLabel: string;
  lag: number;
  corr: number;
  condUp: number | null;
  condDown: number | null;
  shockUpN: number;
  shockDownN: number;
  obs: number;
}): string {
  // Diễn giải chiều (F-10 #129-B): r>0 — nguồn tăng thì VN có xu hướng tăng
  // phiên phản ứng ("Mỹ tăng đêm qua → VN có xu hướng tăng phiên kế"); r<0 nghịch.
  const dir =
    r.corr >= 0
      ? `${r.sourceLabel} tăng → ${r.targetLabel} có xu hướng TĂNG phiên phản ứng (cùng chiều)`
      : `${r.sourceLabel} tăng → ${r.targetLabel} có xu hướng GIẢM phiên phản ứng (nghịch chiều)`;
  const parts = [
    `${r.sourceLabel} → ${r.targetLabel}`,
    intlLagPhrase(r.sourceKey, r.lag),
    `r=${r.corr >= 0 ? "+" : ""}${r.corr.toFixed(2)}`,
    `n=${r.obs} cặp ngày`,
    dir,
  ];
  if (r.condUp != null) parts.push(`P(VN↑|nguồn↑)=${Math.round(r.condUp * 100)}% (${r.shockUpN} mẫu)`);
  if (r.condDown != null) parts.push(`P(VN↓|nguồn↓)=${Math.round(r.condDown * 100)}% (${r.shockDownN} mẫu)`);
  if (r.condUp == null && r.condDown == null) {
    parts.push("chưa đủ mẫu cú sốc cho xác suất điều kiện");
  }
  return parts.join(" · ");
}

let intlBlockCache: { at: number; block: string | null } | null = null;

/**
 * Khối prompt "KÊNH TRUYỀN DẪN QUỐC TẾ → VN" (F-10 #129-B — 3 quan hệ mạnh
 * nhất kèm diễn giải chiều + obs + lag + điều kiện đủ mẫu). Cache 60s trong
 * process như khối domestic. N2 (trung thực): 0 hàng hoặc < 3 cặp đáng tin →
 * trả NULL để caller bỏ hẳn khối — KHÔNG bịa quan hệ, KHÔNG hạ ngưỡng.
 */
export async function buildXrelIntlPromptBlock(): Promise<string | null> {
  try {
    if (intlBlockCache && Date.now() - intlBlockCache.at < INTL_BLOCK_TTL_MS) {
      return intlBlockCache.block;
    }
    const relations = await db.marketRelation.findMany({
      where: { sourceKey: { startsWith: "intl:" }, kind: "price" },
      orderBy: { strength: "desc" },
      take: INTL_PROMPT_TOP,
    });
    if (relations.length < INTL_PROMPT_TOP) {
      intlBlockCache = { at: Date.now(), block: null };
      return null;
    }
    let block =
      "KÊNH TRUYỀN DẪN QUỐC TẾ → VN (XREL quốc tế — lead-lag có chỉnh múi giờ):\n" +
      "(quan hệ THỐNG KÊ quá khứ, không phải quan hệ nhân quả — Pearson trên cặp ngày " +
      "ghép theo giờ đóng cửa: nguồn đóng TRƯỚC phiên VN phản ứng; dùng làm NGỮ CẢNH đối chiếu)";
    for (const r of relations) {
      const candidate = `${block}\n· ${intlRelationLine(r)}`;
      if (candidate.length > INTL_PROMPT_CHAR_CAP) break;
      block = candidate;
    }
    intlBlockCache = { at: Date.now(), block };
    return block;
  } catch (err) {
    console.error("[xrel-intl] buildXrelIntlPromptBlock lỗi (tiêm null):", err);
    return null;
  }
}

// ─────────────────────────── Lớp 3 · Serving ───────────────────────────

/**
 * Đọc quan hệ hiện có (đã xếp theo strength DESC).
 * F-10 #129-B: mặc định LOẠI họ quốc tế (sourceKey "intl:*") — consumer trong
 * nước (khối prompt domestic + Lớp 2 LLM tổng hợp) giữ đúng ngữ cảnh lag
 * "cùng ngày/ngày kế" như trước F-10; họ intl có khối prompt riêng
 * buildXrelIntlPromptBlock() với diễn giải múi giờ riêng. Muốn đọc họ intl:
 * query db.marketRelation trực tiếp (như GET /api/market/relations).
 */
export async function getRelations(take = 60) {
  return db.marketRelation.findMany({
    where: { sourceKey: { not: { startsWith: "intl:" } } },
    orderBy: { strength: "desc" },
    take,
  });
}

/** GET-route: refresh nếu bảng quá cũ (trong nước hoặc quốc tế) — fail-soft. */

/**
 * Mốc (in-process) lần cuối THỬ refresh intl — F-10 #129-B. Khi họ "intl:*"
 * rỗng dai dẳng (chưa tổ hợp nào đạt ngưỡng — trung thực theo N2), không có
 * dòng nào mang computedAt để biết "đã thử lúc nào" → không có cooldown này,
 * MỌI GET route đều trả ~2s phí refresh vô ích. Cooldown này kẹp tần độ thử
 * lại về đúng nhịp STALE_MS như hành vi lazy-refresh gốc (per-process).
 */
let intlLastAttemptAt = 0;

export async function maybeRefreshIfStale(): Promise<boolean> {
  try {
    // F-10 #129-B: 2 nhịp stale ĐỘC LẬP trên cùng STALE_MS (KHÔNG thêm
    // scheduler — intl chạy chung nhịp lazy-refresh này là đủ theo spec):
    //   · trong nước: judge trên các dòng KHÔNG intl: (giữ nguyên hành vi cũ —
    //     trước F-10 toàn bảng chỉ có dòng trong nước);
    //   · intl: judge trên riêng họ "intl:*" để lần triển khai đầu tiên (bảng
    //     trong nước còn tươi, họ intl chưa có dòng) vẫn được tính ngay; họ intl
    //     rỗng dai dẳng thì cooldown kẹp còn ≤ 1 lần thử mỗi STALE_MS/process.
    const [latest, latestIntl] = await Promise.all([
      db.marketRelation.findFirst({
        where: { sourceKey: { not: { startsWith: "intl:" } } },
        orderBy: { computedAt: "desc" },
        select: { computedAt: true },
      }),
      db.marketRelation.findFirst({
        where: { sourceKey: { startsWith: "intl:" } },
        orderBy: { computedAt: "desc" },
        select: { computedAt: true },
      }),
    ]);
    const stale =
      !latest || Date.now() - latest.computedAt.getTime() > STALE_MS;
    const intlRowsStale =
      !latestIntl || Date.now() - latestIntl.computedAt.getTime() > STALE_MS;
    const intlStale =
      intlRowsStale && Date.now() - intlLastAttemptAt > STALE_MS;
    if (!stale && !intlStale) return false;
    if (stale) await refreshRelations();
    if (intlStale) {
      // F-10 #129-B: sau refresh trong nước — fail-soft bọc riêng, 1 đợt intl
      // lỗi KHÔNG làm hỏng kết quả trong nước đã persist ở trên. Đánh dấu mốc
      // thử TRƯỚC khi chạy để đợt lỗi cũng được kẹp nhịp retry (không spam).
      intlLastAttemptAt = Date.now();
      try {
        await refreshIntlRelations();
      } catch (err) {
        console.error("[xrel-intl] refreshIntlRelations lỗi (giữ bản intl cũ):", err);
      }
    }
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
