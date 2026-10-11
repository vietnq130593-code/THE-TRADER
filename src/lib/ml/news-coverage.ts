import { db } from "@/lib/db";
import { scoreNews } from "@/lib/quant/sentiment";

/**
 * src/lib/ml/news-coverage.ts — C2-pipeline (#99 · ML_AUTOML_BLUEPRINT §5.1,
 * Q4 đã duyệt): đo TIẾN ĐỘ CỔNG DỮ LIỆU "tin tức → đặc trưng v3-news22".
 *
 * NGUYÊN TẮC (blueprint §2.11 + §5.1):
 *  - KHÔNG backfill, KHÔNG bịa dữ liệu — chỉ đo trên NewsItem THẬT crawler RSS
 *    đã thu (5 nguồn VN, nạp 15 phút/lần — engine NEWS_MS).
 *  - Cổng dữ liệu: cần ≥ 60 PHIÊN GIAO DỊCH có tin tích luỹ trước khi train
 *    đặc trưng news (~3 tháng chạy liên tục). Đo bằng mapping PIT: mỗi tin
 *    được gán vào PHIÊN ĐẦU TIÊN mà nó "biết được trước đóng cửa" — tin
 *    publishedAt ≤ 15:45 ICT phiên D → phiên D; tin sau 15:45 hoặc rơi cuối
 *    tuần/lễ → PHIÊN GIAO DỊCH kế tiếp (Thứ Hai–Thứ Sáu). Chính là chuẩn
 *    "không nhìn tương lai" của Bar EOD (eod-sync 15:45 ICT).
 *  - Coverage lexicon: % tiêu đề+trích dẫn có ≥ 1 hit trong từ điển polarity
 *    ~75 thuật ngữ (quant/sentiment.ts — cùng từ điển block bằng chứng
 *    news-lexicon của Bayes). Descriptive — KHÔNG kết luận gì về giá.
 *
 * Tự chín: hàm này được /api/ml/status gọi (TTL cache 60s — crawler đổi mỗi
 * 15 phút nên cache hấp thụ phần lớn request) + scripts/ml-news-coverage.ts
 * in báo cáo. Khi sessionsWithNews ≥ 60 → readyToTrain=true — khi đó mới cân
 * nhắc dựng đặc trưng + gate-news (§5.3), không sớm hơn.
 *
 * Ghi chú trung thực: phiên đếm theo Thứ Hai–Thứ Sáu (chưa trừ ngày lễ VN —
 * lệch vài phiên/năm, không đổi kết luận cổng).
 */

/** UTC+7 — mọi mốc PIT của hệ thống theo ICT (Asia/Ho_Chi_Minh). */
const ICT_OFFSET_MS = 7 * 3_600_000;
/** Giờ đóng cửa cổng PIT — cùng chuẩn eod-sync 15:45 ICT (A1 settle 16:15
 * chạy SAU mốc này 30 phút). */
const PIT_CUTOFF_MINUTES = 15 * 60 + 45;
/** Cổng dữ liệu C2 — số phiên có tin tối thiểu trước khi train (§5.1). */
export const NEWS_SESSIONS_REQUIRED = 60;
/** Trần an toàn số tin nạp để đo (tương lai ~2.000 tin/3 tháng — dư biên 2,5×). */
const MAX_NEWS_SCAN = 5_000;
/** TTL cache module — crawler chạy 15 phút/lần, UI poll 30s (pattern driftCache). */
const CACHE_TTL_MS = 60_000;

export interface NewsSourceCoverage {
  source: string;
  news: number;
  hit: number;
  /** 0..1 — tỉ lệ tiêu đề có ≥ 1 hit lexicon trong nguồn. */
  coverage: number;
}

export interface NewsCoverageReport {
  /** false khi DB lỗi/chưa có tin — kèm reason trung thực. */
  available: boolean;
  reason?: string;
  /** Tổng số tin đã quét (≤ MAX_NEWS_SCAN). */
  totalNews: number;
  /** Số PHIÊN GIAO DỊCH (T2–T6) có ≥ 1 tin biết trước đóng cửa — PIT-strict. */
  sessionsWithNews: number;
  /** 60 — ngưỡng cổng dữ liệu (§5.1). */
  sessionsRequired: number;
  /** true khi sessionsWithNews ≥ sessionsRequired — điều kiện CẦN (chưa đủ —
   *  còn gate-news §5.3), KHÔNG tự train gì. */
  readyToTrain: boolean;
  /** % (0..1) tiêu đề/trích dẫn có ≥ 1 hit lexicon. */
  coveragePercent: number;
  /** Số tin có hit lexicon (tử số của coveragePercent). */
  hitTitles: number;
  /** Số tin đã đo (mẫu số — bỏ tin rỗng tiêu đề). */
  measuredTitles: number;
  perSource: NewsSourceCoverage[];
  firstNewsAt: string | null;
  lastNewsAt: string | null;
  /** Thời điểm đo (ISO) — UI hiển thị độ tươi. */
  measuredAt: string;
}

/**
 * Phiên giao dịch PIT của một mốc thời gian: nếu ≤ 15:45 ICT trong một ngày
 * T2–T6 → chính ngày đó; nếu sau 15:45 hoặc rơi T7/CN → PHIÊN T2–T6 kế tiếp.
 * Trả "YYYY-MM-DD" (mốc ICT) — null vô lý về mặt lý thuyết (7 ngày lăn đều
 * tìm được 1 ngày làm việc).
 */
function pitTradingSessionOf(publishedAt: Date): string | null {
  // Làm việc trên "đồng hồ ICT": dịch epoch +7h rồi đọc getUTC* → đúng giờ Việt Nam.
  const ict = new Date(publishedAt.getTime() + ICT_OFFSET_MS);
  const minutes = ict.getUTCHours() * 60 + ict.getUTCMinutes();
  let day = Date.UTC(ict.getUTCFullYear(), ict.getUTCMonth(), ict.getUTCDate());
  if (minutes > PIT_CUTOFF_MINUTES) day += 86_400_000; // sau 15:45 → phiên kế tiếp
  for (let i = 0; i < 7; i++) {
    const dow = new Date(day).getUTCDay();
    if (dow !== 0 && dow !== 6) return new Date(day).toISOString().slice(0, 10);
    day += 86_400_000; // lăn qua T7/CN
  }
  return null;
}

let cache: { at: number; value: NewsCoverageReport } | null = null;

/** Đo báo cáo coverage (TTL cache 60s) — fail-soft: lỗi DB → available:false. */
export async function newsCoverageReport(): Promise<NewsCoverageReport> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;

  const measuredAt = new Date().toISOString();
  let value: NewsCoverageReport;
  try {
    const rows = await db.newsItem.findMany({
      orderBy: { publishedAt: "desc" },
      take: MAX_NEWS_SCAN,
      select: { title: true, summary: true, source: true, publishedAt: true },
    });
    if (rows.length === 0) {
      value = {
        available: false,
        reason:
          "chưa có tin nào trong DB — crawler RSS 5 nguồn chạy 15 phút/lần, dữ liệu tự tích luỹ",
        totalNews: 0,
        sessionsWithNews: 0,
        sessionsRequired: NEWS_SESSIONS_REQUIRED,
        readyToTrain: false,
        coveragePercent: 0,
        hitTitles: 0,
        measuredTitles: 0,
        perSource: [],
        firstNewsAt: null,
        lastNewsAt: null,
        measuredAt,
      };
    } else {
      const sessions = new Set<string>();
      const bySource = new Map<string, NewsSourceCoverage>();
      let hitTitles = 0;
      let measuredTitles = 0;
      let firstMs = Infinity;
      let lastMs = -Infinity;
      for (const r of rows) {
        const session = pitTradingSessionOf(r.publishedAt);
        if (session) sessions.add(session);
        const ms = r.publishedAt.getTime();
        if (ms < firstMs) firstMs = ms;
        if (ms > lastMs) lastMs = ms;
        // Coverage lexicon — cùng từ điển news-lexicon của Bayes (scoreNews ≠ 0
        // = có ≥ 1 thuật ngữ polarity khớp, đã xử lý phủ định).
        const text = [r.title, r.summary ?? ""].filter(Boolean).join(" — ").trim();
        const hasText = text.length > 0;
        const hit = hasText && scoreNews(text) !== 0;
        if (hasText) measuredTitles++;
        if (hit) hitTitles++;
        const src = bySource.get(r.source) ?? {
          source: r.source,
          news: 0,
          hit: 0,
          coverage: 0,
        };
        src.news++;
        if (hit) src.hit++;
        bySource.set(r.source, src);
      }
      const perSource = [...bySource.values()]
        .map((s) => ({ ...s, coverage: s.news > 0 ? s.hit / s.news : 0 }))
        .sort((a, b) => b.news - a.news);
      const sessionsWithNews = sessions.size;
      value = {
        available: true,
        totalNews: rows.length,
        sessionsWithNews,
        sessionsRequired: NEWS_SESSIONS_REQUIRED,
        readyToTrain: sessionsWithNews >= NEWS_SESSIONS_REQUIRED,
        coveragePercent: measuredTitles > 0 ? hitTitles / measuredTitles : 0,
        hitTitles,
        measuredTitles,
        perSource,
        firstNewsAt: Number.isFinite(firstMs) ? new Date(firstMs).toISOString() : null,
        lastNewsAt: Number.isFinite(lastMs) ? new Date(lastMs).toISOString() : null,
        measuredAt,
      };
    }
  } catch (err) {
    value = {
      available: false,
      reason: `lỗi đọc NewsItem — ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`,
      totalNews: 0,
      sessionsWithNews: 0,
      sessionsRequired: NEWS_SESSIONS_REQUIRED,
      readyToTrain: false,
      coveragePercent: 0,
      hitTitles: 0,
      measuredTitles: 0,
      perSource: [],
      firstNewsAt: null,
      lastNewsAt: null,
      measuredAt,
    };
  }
  cache = { at: now, value };
  return value;
}
