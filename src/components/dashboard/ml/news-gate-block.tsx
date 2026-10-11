"use client";

/**
 * ml/news-gate-block.tsx (#99 — C2-pipeline · ML_AUTOML_BLUEPRINT §5.1/Q4) —
 * khối "Tin tức → đặc trưng (C2): cổng dữ liệu" trong tab Dữ liệu & kiến trúc.
 *
 * TỰ CHÍN: số liệu đo từ NewsItem thật (crawler RSS 5 nguồn 15 phút/lần) —
 * không có nút bấm, không backfill, không bịa dữ liệu (nguyên tắc §2.11).
 * Khi đủ ≥ 60 phiên có tin (PIT-strict ≤ 15:45 ICT) mới cân nhắc dựng đặc
 * trưng v3-news22 + gate-news (§5.3) — block này chỉ hiển thị TIẾN ĐỘ trung thực.
 */

import { Newspaper } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/format";
import type { MlNewsGateStatus } from "@/hooks/use-ml";
import { nf0, pct1 } from "./shared";

export function NewsGateBlock({ newsGate }: { newsGate: MlNewsGateStatus | null }) {
  const ready = newsGate?.readyToTrain === true;
  const progress =
    newsGate && newsGate.sessionsRequired > 0
      ? Math.min(1, newsGate.sessionsWithNews / newsGate.sessionsRequired)
      : 0;

  return (
    <section aria-labelledby="ml-newsgate-heading" className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="ml-newsgate-heading" className="flex items-center gap-2 text-sm font-semibold">
          <Newspaper className="size-4 text-muted-foreground" aria-hidden="true" />
          Tin tức → đặc trưng (C2): cổng dữ liệu
        </h3>
        {newsGate ? (
          <Badge
            variant="outline"
            className={`shrink-0 text-[10px] ${ready ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}
          >
            {ready ? "đủ 60 phiên — có thể dựng đặc trưng" : `${nf0.format(newsGate.sessionsWithNews)}/${newsGate.sessionsRequired} phiên`}
          </Badge>
        ) : (
          <Badge variant="outline" className="shrink-0 text-[10px] text-muted-foreground">
            chưa đo
          </Badge>
        )}
      </div>

      {!newsGate || !newsGate.available ? (
        <div className="rounded-lg border bg-muted/20 px-3 py-2.5">
          <p className="text-xs leading-relaxed text-muted-foreground">
            {newsGate?.reason ?? "chưa đo — tiến độ cổng dữ liệu tự cập nhật theo crawler tin tức."}
          </p>
        </div>
      ) : (
        <div className="rounded-lg border bg-muted/20 px-3 py-2.5">
          {/* Tiến độ cổng dữ liệu */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-medium">Phiên giao dịch có tin (PIT ≤ 15:45 ICT)</span>
            <span className="tabular-nums">
              {nf0.format(newsGate.sessionsWithNews)} / {nf0.format(newsGate.sessionsRequired)}
              {" phiên "}
              <span className="text-muted-foreground">({pct1(progress)})</span>
            </span>
          </div>
          <div
            className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-background"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            aria-label="Tiến độ cổng dữ liệu tin tức"
          >
            <div
              className={`h-full rounded-full ${ready ? "bg-emerald-500" : "bg-primary"}`}
              style={{ width: `${Math.max(2, progress * 100)}%` }}
            />
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
            Cần ≥ {newsGate.sessionsRequired} phiên tích luỹ (~3 tháng chạy liên tục) trước khi
            huấn luyện bộ đặc trưng <span className="font-mono">v3-news22</span> (16 chiều kỹ thuật
            hiện có + 6 chiều tin tức). Không backfill, không bịa dữ liệu — cổng tự chín theo
            crawler RSS 15 phút/lần, không cần bấm gì. Đếm phiên theo Thứ Hai–Thứ Sáu (chưa trừ
            ngày lễ).
          </p>

          {/* Coverage lexicon */}
          <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] tabular-nums text-muted-foreground">
            <span>
              Lexicon ~75 thuật ngữ:{" "}
              <span className="font-medium text-foreground">
                {pct1(newsGate.coveragePercent)}
              </span>{" "}
              tin có hit ({nf0.format(newsGate.hitTitles)}/{nf0.format(newsGate.measuredTitles)})
            </span>
            <span>·</span>
            <span>Tổng {nf0.format(newsGate.totalNews)} tin</span>
            {newsGate.lastNewsAt ? (
              <>
                <span>·</span>
                <span>tin mới nhất {formatDateTime(newsGate.lastNewsAt)}</span>
              </>
            ) : null}
          </div>

          {/* Phân bố theo nguồn */}
          {newsGate.perSource.length > 0 && (
            <div className="mt-2 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
              {newsGate.perSource.map((s) => (
                <div
                  key={s.source}
                  className="min-w-0 rounded-md border bg-background/60 px-2 py-1"
                  title={`${s.source}: ${s.hit}/${s.news} tin có hit lexicon`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[10px] font-medium">{s.source}</span>
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                      {pct1(s.coverage)}
                    </span>
                  </div>
                  <div className="text-[10px] tabular-nums text-muted-foreground">
                    {nf0.format(s.hit)}/{nf0.format(s.news)} tin có hit
                  </div>
                </div>
              ))}
            </div>
          )}

          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            {ready
              ? "Đủ phiên tích luỹ — điều kiện CẦN đã thoả. Bước kế tiếp (theo blueprint §5.3): đo coverage ≥ 60% rồi dựng đặc trưng + chạy gate-news B2-style trước khi swap serving."
              : "Chưa đủ phiên — hiện 4 đường tiêu thụ tin tức (LLM vote · lexicon Bayes · RAG · bandit posterior) vẫn chạy bình thường; chỉ đặc trưng mạng học đang chờ cổng dữ liệu này."}
            {newsGate.firstNewsAt ? ` Đo lúc ${formatDateTime(newsGate.measuredAt)}.` : ""}
          </p>
        </div>
      )}
    </section>
  );
}
