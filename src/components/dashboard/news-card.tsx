"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { vi } from "date-fns/locale";
import { ExternalLink, Library, Loader2, Newspaper, RefreshCw, Rss, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet, apiPost } from "@/lib/api";
import { cn } from "@/lib/utils";
import { NewsArchiveDialog } from "@/components/dashboard/news-archive-dialog";
import type { NewsIngestResponse, NewsResponse } from "@/lib/types";

/**
 * S5 — News card (DATA_SOURCES.md §4.3): 12 tin mới nhất crawl từ RSS
 * 5 nguồn VN (VnEconomy, CafeF, VNExpress, Tuổi Trẻ, VietnamNet) + nút
 * nạp tay. Danh sách dài → max-h + custom-scrollbar. Meta nguồn hiển thị
 * mode live/fallback + stale marking đúng §6.
 */
export function NewsCard() {
  const queryClient = useQueryClient();
  const [archiveOpen, setArchiveOpen] = React.useState(false);

  const newsQuery = useQuery({
    queryKey: ["news"],
    queryFn: () => apiGet<NewsResponse>("/api/news?limit=12"),
    staleTime: 5 * 60_000,
  });

  const ingest = useMutation({
    mutationFn: () => apiPost<NewsIngestResponse>("/api/news"),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ["news"] });
      void queryClient.invalidateQueries({ queryKey: ["system-status"] });
      const okFeeds = res.feeds.filter((f) => f.ok).map((f) => f.name);
      toast.success(`Đã nạp ${res.added} tin mới`, {
        description:
          okFeeds.length > 0
            ? `Nguồn RSS hoạt động: ${okFeeds.join(", ")}`
            : "Không có nguồn RSS nào phản hồi — giữ bản cache.",
      });
    },
    onError: (err: Error) => {
      toast.error("Nạp tin tức thất bại", { description: err.message });
    },
  });

  const meta = newsQuery.data?.meta;
  const items = newsQuery.data?.items ?? [];

  // P2-2/#62 — độ tin cậy per-feed: tỉ lệ parse lỗi + tỉ lệ tin trùng tích luỹ
  const reliabilityEntries = Object.entries(meta?.reliability ?? {}).filter(
    ([, r]) => r.itemsSeen > 0
  );

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Newspaper className="size-4 text-primary" aria-hidden="true" />
          Tin tức thị trường
        </CardTitle>
        <CardDescription>Thị trường &amp; vĩ mô — nguồn cấp dữ liệu cho agent News &amp; Sentiment</CardDescription>
        <CardAction>
          <div className="flex items-center gap-2">
            {meta && (
              <Badge
                variant="outline"
                className={cn(
                  "gap-1.5 px-2 py-0.5 text-[10px]",
                  meta.mode === "live"
                    ? meta.stale
                      ? "border-amber-500/40 text-amber-600 dark:text-amber-400"
                      : "border-up/40 text-up"
                    : "border-red-500/40 text-red-600 dark:text-red-400"
                )}
                title={
                  meta.providers.length > 0
                    ? `Nguồn: ${meta.providers.join(", ")}${meta.lastSuccessAt ? ` · lần cuối: ${new Date(meta.lastSuccessAt).toLocaleString("vi-VN")}` : ""}`
                    : "Đang dùng bản cache — chưa kết nối được nguồn RSS"
                }
              >
                <Rss className="size-3" aria-hidden="true" />
                {meta.mode === "live"
                  ? meta.stale
                    ? "RSS · stale"
                    : "RSS trực tiếp"
                  : "Cache (offline)"}
              </Badge>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 px-2.5"
              onClick={() => setArchiveOpen(true)}
              aria-label="Mở kho tin tức theo ngày"
            >
              <Library className="size-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">Kho tin</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 px-2.5"
              onClick={() => ingest.mutate()}
              disabled={ingest.isPending}
              aria-label="Nạp tin tức mới từ RSS"
            >
              {ingest.isPending ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw className="size-3.5" aria-hidden="true" />
              )}
              <span className="hidden sm:inline">Nạp tin</span>
            </Button>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="pb-0">
        {newsQuery.isLoading ? (
          <div className="flex flex-col gap-2 px-6 pb-6">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : newsQuery.isError ? (
          <p className="px-6 pb-6 text-sm text-down">
            {newsQuery.error?.message ?? "Không tải được tin tức."}
          </p>
        ) : items.length === 0 ? (
          <p className="px-6 pb-6 text-sm text-muted-foreground">
            Chưa có tin nào — bấm <strong>Nạp tin</strong> để crawler RSS chạy
            ngay lần đầu.
          </p>
        ) : (
          <>
            <ul className="max-h-80 divide-y divide-border/60 overflow-y-auto custom-scrollbar">
              {items.map((n) => (
                <li key={n.id} className="px-6 py-3 transition-colors hover:bg-accent/40">
                  <a
                    href={n.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex items-start justify-between gap-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 text-sm font-medium leading-snug group-hover:underline">
                        {n.title}
                      </p>
                      {n.summary && (
                        <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">
                          {n.summary}
                        </p>
                      )}
                      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                        <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-medium">
                          {n.source}
                        </Badge>
                        <span suppressHydrationWarning>
                          {formatDistanceToNow(new Date(n.publishedAt), {
                            addSuffix: true,
                            locale: vi,
                          })}
                        </span>
                      </div>
                    </div>
                    <ExternalLink
                      className="mt-0.5 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                      aria-hidden="true"
                    />
                  </a>
                </li>
              ))}
            </ul>
            {reliabilityEntries.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 px-6 pt-3">
                <ShieldCheck
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                {reliabilityEntries.map(([name, r]) => {
                  const parseErrPct =
                    r.parsed + r.parseSkipped > 0
                      ? (r.parseSkipped / (r.parsed + r.parseSkipped)) * 100
                      : 0;
                  const dupPct =
                    r.itemsSeen > 0 ? (r.duplicates / r.itemsSeen) * 100 : 0;
                  const warn = parseErrPct > 20 || r.okRuns === 0;
                  return (
                    <Badge
                      key={name}
                      variant="outline"
                      title={`${name}: ${r.okRuns}/${r.runs} lần crawl OK · bỏ ${r.parseSkipped}/${r.parsed + r.parseSkipped} item parse lỗi (${parseErrPct.toFixed(0)}%) · ${r.duplicates}/${r.itemsSeen} tin trùng URL (${dupPct.toFixed(0)}%)${r.lastError ? ` · lỗi cuối: ${r.lastError}` : ""}`}
                      className={cn(
                        "gap-1 px-1.5 py-0 text-[10px] font-medium",
                        warn
                          ? "border-amber-500/40 text-amber-600 dark:text-amber-400"
                          : "border-border/60 text-muted-foreground"
                      )}
                    >
                      {name}
                      <span className="text-muted-foreground/70">
                        {parseErrPct.toFixed(0)}% lỗi · {dupPct.toFixed(0)}% trùng
                      </span>
                    </Badge>
                  );
                })}
              </div>
            )}
            <p className="px-6 py-3 text-[11px] text-muted-foreground">
              {items.length}/{meta?.total ?? items.length} tin · cập nhật bởi
              market-engine mỗi 15 phút
            </p>
          </>
        )}
      </CardContent>
      <NewsArchiveDialog open={archiveOpen} onOpenChange={setArchiveOpen} />
    </Card>
  );
}
