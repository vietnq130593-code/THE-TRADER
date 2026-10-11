/**
 * scripts/ml-news-coverage.ts — C2-pipeline (#99 · ML_AUTOML_BLUEPRINT
 * §5.1/Q4 đã duyệt): đo TIẾN ĐỘ CỔNG DỮ LIỆU "tin tức → đặc trưng v3-news22"
 * và in báo cáo console (cùng hàm lib mà /api/ml/status dùng — một nguồn).
 *
 * Đo:
 *  1. Số PHIÊN GIAO DỊCH (T2–T6) có ≥ 1 tin biết trước đóng cửa (PIT-strict
 *     ≤ 15:45 ICT — cùng chuẩn eod-sync) + tiến độ /60 phiên.
 *  2. Coverage lexicon — % tin (tiêu đề + trích dẫn) có ≥ 1 hit trong từ điển
 *     ~75 thuật ngữ polarity tài chính VN (quant/sentiment.ts) + phân bố nguồn.
 *  3. Descriptive — KHÔNG kết luận gì về chất lượng dự báo.
 *
 * Chạy: `DATABASE_URL=… bun run scripts/ml-news-coverage.ts`
 * (không truyền DATABASE_URL → dùng .env như các script nhà khác qua next;
 *  script thuần bun cần env tường minh — xem worklog #99 C0).
 * 0 LLM · 0 ghi DB (chỉ đọc) · fail-soft: lỗi DB → available:false + reason.
 */

import { db } from "../src/lib/db";
import { newsCoverageReport, type NewsCoverageReport } from "../src/lib/ml/news-coverage";

function printReport(r: NewsCoverageReport): void {
  console.log("═".repeat(72));
  console.log("CỔNG DỮ LIỆU C2 — TIN TỨC → ĐẶC TRƯNG v3-news22 (ML_AUTOML §5.1)");
  console.log("═".repeat(72));
  if (!r.available) {
    console.log(`KHÔNG ĐO ĐƯỢC: ${r.reason ?? "(không rõ lý do)"}`);
    return;
  }
  const progress = Math.min(1, r.sessionsWithNews / r.sessionsRequired);
  const bar = "█".repeat(Math.round(progress * 24)).padEnd(24, "░");
  console.log(`Phiên có tin (PIT ≤ 15:45 ICT): ${r.sessionsWithNews}/${r.sessionsRequired}  [${bar}] ${(progress * 100).toFixed(1)}%`);
  console.log(
    r.readyToTrain
      ? "→ ĐỦ PHIÊN — điều kiện CẦN thoả (bước kế tiếp §5.3: coverage ≥ 60% → dựng đặc trưng + gate-news)"
      : "→ CHƯA ĐỦ — đặc trưng news chưa train (nguyên tắc §2.11: không backfill, không bịa)"
  );
  console.log(`\nTổng tin đã quét:          ${r.totalNews} (mới nhất ${r.lastNewsAt ?? "?"})`);
  console.log(`Lexicon ~75 thuật ngữ:     ${(r.coveragePercent * 100).toFixed(1)}% tin có hit (${r.hitTitles}/${r.measuredTitles})`);
  console.log(`Tin đầu tiên:              ${r.firstNewsAt ?? "?"}`);
  console.log("\nPhân bố theo nguồn:");
  for (const s of r.perSource) {
    console.log(
      `  - ${s.source.padEnd(12)} ${String(s.news).padStart(4)} tin · hit ${(s.coverage * 100).toFixed(1)}% (${s.hit}/${s.news})`
    );
  }
  console.log(`\nĐo lúc: ${r.measuredAt} · TTL cache lib 60s · UI: tab Dữ liệu — khối "Tin tức → đặc trưng (C2)"`);
}

async function main() {
  const report = await newsCoverageReport();
  printReport(report);
  await db.$disconnect();
}

void main().catch((err) => {
  console.error("LỖI script ml-news-coverage:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
