"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  BookOpenText,
  ExternalLink,
  Library,
  Scale,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { NewsArchiveResponse, NewsArchiveItem } from "@/lib/types";

/**
 * Kho tin tức thị trường (#101) — dialog lọc từ ngày → đến ngày trên toàn bộ
 * NewsItem crawler RSS, kèm chỉ báo TIN NÀO ĐANG NUÔI TRI THỨC AGENTS:
 *   · A4      — nằm trong 10 tin mới nhất News & Sentiment đọc mỗi chu kỳ
 *   · RAG     — nằm trong corpus 200 tin BM25 truy hồi cho prompt nghiên cứu
 *   · Lexicon — điểm cảm xúc quant (~75 thuật ngữ VN) −1..+1
 * Nguồn truthful thứ 4 (bandit theo NGUỒN, không theo tin) giải thích ở legend.
 */

const PAGE_SIZE = 30;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "YYYY-MM-DD" theo ICT của thời điểm hiện tại (client-only — gọi trong state lazy). */
function ictToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function ictDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function NewsArchiveDialog({ open, onOpenChange }: Props) {
  // Mặc định 7 ngày gần nhất — lazy initializer (client chạy khi mount;
  // dialog đóng chưa render DOM nên không lệch hydration).
  const [from, setFrom] = React.useState<string>(() => ictDaysAgo(6));
  const [to, setTo] = React.useState<string>(() => ictToday());
  const [applied, setApplied] = React.useState<{ from: string; to: string }>(() => ({
    from: ictDaysAgo(6),
    to: ictToday(),
  }));
  const [page, setPage] = React.useState(0);

  const archiveQuery = useQuery({
    queryKey: ["news-archive", applied.from, applied.to, page],
    queryFn: () =>
      apiGet<NewsArchiveResponse>(
        `/api/news/archive?from=${applied.from}&to=${applied.to}&take=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`
      ),
    enabled: open,
    staleTime: 60_000,
  });

  const meta = archiveQuery.data?.meta;
  const items = archiveQuery.data?.items ?? [];
  const total = meta?.total ?? 0;
  const first = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const last = Math.min(total, (page + 1) * PAGE_SIZE);

  const applyRange = () => {
    if (from && to && DATE_RE.test(from) && DATE_RE.test(to) && from <= to) {
      setApplied({ from, to });
      setPage(0);
    }
  };
  const preset = (days: number) => {
    const f = days === 0 ? meta?.bounds.min?.slice(0, 10) ?? ictDaysAgo(365) : ictDaysAgo(days - 1);
    const t = ictToday();
    setFrom(f);
    setTo(t);
    setApplied({ from: f, to: t });
    setPage(0);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto custom-scrollbar sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Library className="size-4 text-primary" aria-hidden="true" />
            Kho tin tức thị trường
          </DialogTitle>
          <DialogDescription>
            Toàn bộ tin crawler RSS 5 nguồn — lọc theo ngày và xem tin nào đang
            nuôi tri thức agents (A4 · RAG · lexicon).
          </DialogDescription>
        </DialogHeader>

        {/* ── Bộ lọc từ ngày → đến ngày ── */}
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Từ ngày
              <Input
                type="date"
                value={from ?? ""}
                min={meta?.bounds.min?.slice(0, 10)}
                max={meta?.bounds.max?.slice(0, 10)}
                onChange={(e) => setFrom(e.target.value)}
                className="h-9 bg-background text-sm"
                aria-label="Từ ngày"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Đến ngày
              <Input
                type="date"
                value={to ?? ""}
                min={meta?.bounds.min?.slice(0, 10)}
                max={meta?.bounds.max?.slice(0, 10)}
                onChange={(e) => setTo(e.target.value)}
                className="h-9 bg-background text-sm"
                aria-label="Đến ngày"
              />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="outline" className="h-8" onClick={() => preset(1)}>
              Hôm nay
            </Button>
            <Button size="sm" variant="outline" className="h-8" onClick={() => preset(7)}>
              7 ngày
            </Button>
            <Button size="sm" variant="outline" className="h-8" onClick={() => preset(30)}>
              30 ngày
            </Button>
            <Button size="sm" variant="outline" className="h-8" onClick={() => preset(0)}>
              Toàn bộ
            </Button>
            <Button
              size="sm"
              className="ml-auto h-8"
              onClick={applyRange}
              disabled={
                !from || !to || !DATE_RE.test(from) || !DATE_RE.test(to) || from > to || (applied?.from === from && applied?.to === to)
              }
            >
              Áp dụng
            </Button>
          </div>
        </div>

        {/* ── Thống kê khoảng ── */}
        {meta && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">{total} tin</span>
            <span className="flex items-center gap-1">
              <Sparkles className="size-3 text-up" aria-hidden="true" />A4 đọc: {meta.counts.inA4Window}
            </span>
            <span className="flex items-center gap-1">
              <BookOpenText className="size-3 text-primary" aria-hidden="true" />RAG: {meta.counts.inRagCorpus}
            </span>
            <span className="flex items-center gap-1">
              <Scale className="size-3" aria-hidden="true" />
              Lexicon: <span className="text-up">{meta.counts.lexiconPos}+</span>{" "}
              / <span className="text-down">{meta.counts.lexiconNeg}−</span>
            </span>
            {Object.entries(meta.counts.bySource).length > 0 && (
              <span className="basis-full">
                Nguồn: {Object.entries(meta.counts.bySource).map(([s, c]) => `${s} ${c}`).join(" · ")}
              </span>
            )}
          </div>
        )}

        {/* ── Danh sách tin ── */}
        {archiveQuery.isLoading ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : archiveQuery.isError ? (
          <p className="rounded-md border border-down/30 bg-down/5 px-3 py-2 text-sm text-down">
            {archiveQuery.error?.message ?? "Không tải được kho tin tức."}
          </p>
        ) : items.length === 0 ? (
          <p className="rounded-md border border-border/60 px-3 py-6 text-center text-sm text-muted-foreground">
            Không có tin nào trong khoảng {applied?.from} → {applied?.to}. Thử
            mở rộng phạm vi ngày hoặc bấm <strong>Toàn bộ</strong>.
          </p>
        ) : (
          <ul className="max-h-[52vh] divide-y divide-border/60 overflow-y-auto custom-scrollbar rounded-md border border-border/60">
            {items.map((n) => (
              <NewsArchiveRow key={n.id} item={n} />
            ))}
          </ul>
        )}

        {/* ── Phân trang ── */}
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span suppressHydrationWarning>
              {first}–{last} / {total} tin
            </span>
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0 || archiveQuery.isFetching}
                aria-label="Trang trước"
              >
                <ArrowLeft className="size-3.5" aria-hidden="true" /> Trước
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1"
                onClick={() => setPage((p) => (last < total ? p + 1 : p))}
                disabled={last >= total || archiveQuery.isFetching}
                aria-label="Trang sau"
              >
                Sau <ArrowRight className="size-3.5" aria-hidden="true" />
              </Button>
            </div>
          </div>
        )}

        {/* ── Legend 4 đường tiêu thụ ── */}
        <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
          <p className="mb-1 font-medium text-foreground">Tin làm giàu tri thức agents qua 4 đường:</p>
          <p>
            <Badge variant="outline" className="mr-1 border-up/40 px-1 py-0 text-[9px] text-up">A4</Badge>
            10 tin mới nhất được agent News &amp; Sentiment đọc mỗi chu kỳ →
            phiếu cử tri Hội đồng.
          </p>
          <p>
            <Badge variant="outline" className="mr-1 border-primary/40 px-1 py-0 text-[9px] text-primary">RAG</Badge>
            Corpus 200 tin mới nhất cho truy hồi BM25 — tiêm ngữ cảnh liên quan
            vào prompt 5 agent nghiên cứu + Chủ tịch.
          </p>
          <p>
            <Badge variant="outline" className="mr-1 px-1 py-0 text-[9px]">Lexicon</Badge>
            Điểm cảm xúc quant (~75 thuật ngữ VN) −1..+1 — tổng hợp 24h vào
            bằng chứng Bayes.
          </p>
          <p>
            <Badge variant="outline" className="mr-1 px-1 py-0 text-[9px]">Bandit</Badge>
            Học theo <em>nguồn</em> (không theo từng tin) — Beta-Bernoulli tự
            chín độ tin cậy từng báo qua settle 16:15.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function NewsArchiveRow({ item: n }: { item: NewsArchiveItem }) {
  const lex = n.lexiconScore;
  const lexLabel = lex > 0 ? `+${lex.toFixed(1).replace(".", ",")}` : lex < 0 ? lex.toFixed(1).replace(".", ",") : null;
  return (
    <li className="px-3 py-2.5 transition-colors hover:bg-accent/40">
      <a
        href={n.url}
        target="_blank"
        rel="noopener noreferrer"
        className="group flex items-start justify-between gap-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm font-medium leading-snug group-hover:underline">{n.title}</p>
          {n.summary && <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{n.summary}</p>}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-medium">{n.source}</Badge>
            {n.category && (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-medium">
                {n.category === "market" ? "Thị trường" : "Vĩ mô"}
              </Badge>
            )}
            {n.inA4Window && (
              <Badge
                variant="outline"
                title="Trong 10 tin mới nhất News & Sentiment đọc mỗi chu kỳ"
                className="gap-1 border-up/40 px-1.5 py-0 text-[10px] font-medium text-up"
              >
                <Sparkles className="size-2.5" aria-hidden="true" />A4
              </Badge>
            )}
            {n.inRagCorpus && (
              <Badge
                variant="outline"
                title="Trong corpus 200 tin RAG BM25 truy hồi cho prompt nghiên cứu"
                className="gap-1 border-primary/40 px-1.5 py-0 text-[10px] font-medium text-primary"
              >
                <BookOpenText className="size-2.5" aria-hidden="true" />RAG
              </Badge>
            )}
            {lexLabel && (
              <Badge
                variant="outline"
                title={`Điểm lexicon quant ${lex.toFixed(2)} (−1..+1)`}
                className={cn(
                  "gap-1 px-1.5 py-0 text-[10px] font-medium",
                  lex > 0 ? "border-up/40 text-up" : "border-down/40 text-down"
                )}
              >
                <Scale className="size-2.5" aria-hidden="true" />
                {lexLabel}
              </Badge>
            )}
            <span suppressHydrationWarning className="ml-auto whitespace-nowrap">
              {formatDateTime(n.publishedAt)}
            </span>
          </div>
        </div>
        <ExternalLink
          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
          aria-hidden="true"
        />
      </a>
    </li>
  );
}
