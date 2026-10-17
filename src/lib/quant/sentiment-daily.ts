/**
 * src/lib/quant/sentiment-daily.ts — F-04 (#129 — AI_ENGINEER_REVIEW_BRAIN
 * §3 F-04) · CHUỖI SENTIMENT HẰNG NGÀY (phần CÓ DB).
 *
 * "Cảm xúc tin tức là biến NHANH hiếm hoi của lớp 2 khi chuỗi chậm chưa có"
 * → chuỗi sent_7 (−1..+1) làm chiều x[23] của v3-macro (F-01) + dashboard.
 *
 * Công thức (đặc tả F-04): điểm sentiment lexicon mọi NewsItem theo NGÀY;
 * sent_7 = trung bình trọng số TUYẾN TÍNH THEO ĐỘ TƯƠI trên 7 ngày liền trước
 * (hôm nay ×1,0 → 6 ngày trước ×0,4); n < 5 tin trong cửa sổ → co về 0
 * (trung thực — không phóng đại tín hiệu từ 1-2 tin). Ngày nghỉ n=0 → 0.
 * AppSetting "news-sentiment-daily" giữ rolling 90 ngày cho UI (job settle
 * 16:15 ghi); loader feature tính TRỰC TIẾP từ NewsItem (1 nguồn sự thật
 * thuật toán — cùng hàm thuần, không 2 đường tính).
 *
 * TÁCH KHỎI sentiment.ts (#129 fix Turbopack): news-card.tsx ("use client")
 * import các hàm thuần của sentiment.ts — module đó PHẢI giữ thuần (0 DB);
 * phần chạm DB sống ở đây (server-only: features loader + settle route).
 */

import { db } from "@/lib/db";
import { scoreNews } from "@/lib/quant/sentiment";

/** Điểm sentiment một ngày (thuần). */
export interface DailySentimentPoint {
  /** "YYYY-MM-DD" (giờ UTC — cùng quy ước Bar). */
  date: string;
  /** Điểm trung bình các tin trong ngày ∈ [−1, 1]. */
  score: number;
  /** Số tin có trong ngày. */
  n: number;
}

/** Số ngày giữ trong AppSetting rolling (đặc tả F-04: 90 ngày). */
export const SENTIMENT_DAILY_WINDOW_DAYS = 90;
/** Ngưỡng n tối thiểu để sent_7 khác 0 (đặc tả: n < 5 → co về 0). */
export const SENTIMENT_MIN_NEWS = 5;

/** Tổng hợp điểm sentiment theo NGÀY từ danh sách tin (thuần, không DB). */
export function aggregateDailySentiment(
  items: { publishedAt: Date; title: string; summary?: string | null }[]
): Map<string, { score: number; n: number }> {
  const byDate = new Map<string, number[]>();
  for (const it of items) {
    const key = it.publishedAt.toISOString().slice(0, 10);
    const score = scoreNews([it.title, it.summary ?? ""].filter(Boolean).join(" — "));
    let arr = byDate.get(key);
    if (!arr) {
      arr = [];
      byDate.set(key, arr);
    }
    arr.push(score);
  }
  const out = new Map<string, { score: number; n: number }>();
  for (const [date, scores] of byDate) {
    out.set(date, {
      score: scores.reduce((s, v) => s + v, 0) / scores.length,
      n: scores.length,
    });
  }
  return out;
}

/**
 * sent_7 cho ngày endDate: trung bình trọng số tuyến tính theo độ tươi trên
 * 7 NGÀY LỊCH liền trước (kể cả endDate) — hôm nay ×1,0 → 6 ngày trước ×0,4.
 * n < 5 tin (cửa sổ) → 0 (trung thực). Thuần, deterministic.
 */
export function weightedSentiment7(
  daily: Map<string, { score: number; n: number }>,
  endDate: string
): number {
  const end = new Date(`${endDate}T00:00:00.000Z`);
  let wSum = 0;
  let sSum = 0;
  let n = 0;
  for (let age = 0; age <= 6; age++) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - age);
    const key = d.toISOString().slice(0, 10);
    const pt = daily.get(key);
    if (!pt) continue;
    const w = 1 - 0.6 * (age / 6); // 1,0 (hôm nay) → 0,4 (6 ngày trước)
    wSum += w;
    sSum += w * pt.score;
    n += pt.n;
  }
  if (n < SENTIMENT_MIN_NEWS || wSum === 0) return 0;
  return Math.max(-1, Math.min(1, sSum / wSum));
}

/**
 * Điểm sentiment hằng ngày TOÀN BỘ NewsItem còn trong kho (loader feature
 * F-01 x[23] — PIT đúng nghĩa: chỉ tin publishedAt ≤ ngày lấy mẫu vì
 * truy vấn theo mốc quá khứ). Giới hạn tin 2 năm gần nhất (đủ mọi cửa sổ
 * train hiện hữu + tiết kiệm WAN).
 */
export async function dailySentimentScores(): Promise<Map<string, { score: number; n: number }>> {
  const since = new Date(Date.now() - 730 * 86_400_000);
  const items = await db.newsItem.findMany({
    where: { publishedAt: { gte: since } },
    orderBy: { publishedAt: "asc" },
    select: { publishedAt: true, title: true, summary: true },
  });
  return aggregateDailySentiment(items);
}

/**
 * Snapshot rolling 90 ngày cho AppSetting "news-sentiment-daily" (job settle
 * 16:15 ghi — F-04): [{date, score, n}] ngày có tin, mới nhất cuối mảng.
 */
export async function sentimentDailySnapshot(): Promise<DailySentimentPoint[]> {
  const daily = await dailySentimentScores();
  const since = new Date(Date.now() - SENTIMENT_DAILY_WINDOW_DAYS * 86_400_000);
  const sinceKey = since.toISOString().slice(0, 10);
  const out: DailySentimentPoint[] = [];
  for (const [date, pt] of [...daily.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (date >= sinceKey) out.push({ date, score: Number(pt.score.toFixed(4)), n: pt.n });
  }
  return out;
}
