"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Loader2,
  Network,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet, apiPost } from "@/lib/api";
import { cn } from "@/lib/utils";
import type {
  MarketRelationsResponse,
  MarketRelationView,
  XrelInsightResponse,
  XrelRefreshResponse,
} from "@/lib/types";

/**
 * M2_RELATION_BLUEPRINT (phiên #103 — cơ chế số 2): card "Quan hệ thị trường"
 * trong module Thị trường. Hiển thị bảng quan hệ ĐÃ HỌC từ dữ liệu quá khứ
 * (giá→giá lead-lag + tin→giá event-study, cửa sổ 750 phiên) + nhận định LLM
 * tổng hợp định kỳ. Hai nút: Học lại (engine quant) · Tổng hợp nhận định (LLM).
 */

function fmtVi(n: number, digits = 2): string {
  return n.toLocaleString("vi-VN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtPctVi(p: number): string {
  return `${Math.round(p * 100)}%`;
}

function fmtDayVi(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

function lagLabel(lag: number): string {
  return lag === 0 ? "cùng ngày" : "ngày kế";
}

/** Narrative LLM thỉnh thoảng chứa markdown **đậm** — render thành <strong>
 *  thay vì hiển thị thô dấu sao (P2 #104 — F-1041-02). An toàn: không HTML
 *  thô, chỉ tách chuỗi quanh cặp ** **. */
function renderNarrative(text: string): React.ReactNode[] {
  const parts = text.split(/\*\*([\s\S]+?)\*\*/g);
  return parts.map((part, i) =>
    i % 2 === 1 ? <strong key={i}>{part}</strong> : <React.Fragment key={i}>{part}</React.Fragment>
  );
}

function kindLabel(kind: MarketRelationView["kind"]): string {
  return kind === "price" ? "Giá → Giá" : "Tin → Giá";
}

/** Một dòng quan hệ: badge loại · A → B · lag · corr + thanh sức mạnh · P điều kiện · n. */
function RelationRow({ r }: { r: MarketRelationView }) {
  const strengthPct = Math.min(100, Math.round(Math.abs(r.corr) * 100));
  const positive = r.corr >= 0;
  return (
    <li className="px-4 py-3 transition-colors hover:bg-accent/40 sm:px-6">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge
          variant={r.kind === "news" ? "secondary" : "outline"}
          className="px-1.5 py-0 text-[10px] font-medium"
        >
          {kindLabel(r.kind)}
        </Badge>
        <span className="text-sm font-medium leading-snug">
          {r.sourceLabel}
          <ArrowRight
            className="mx-1 inline size-3.5 align-middle text-muted-foreground"
            aria-hidden="true"
          />
          {r.targetLabel}
        </span>
        <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-muted-foreground">
          {lagLabel(r.lag)}
        </Badge>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span
          className={cn(
            "font-semibold tabular-nums",
            positive ? "text-up" : "text-down"
          )}
          title="Tương quan Pearson trên chuỗi ngày giao dịch chung"
        >
          r={positive ? "+" : "−"}
          {fmtVi(Math.abs(r.corr))}
        </span>
        <span
          className="inline-block h-1.5 w-16 overflow-hidden rounded-full bg-border/70 align-middle"
          aria-hidden="true"
        >
          <span
            className={cn(
              "block h-full rounded-full",
              positive ? "bg-up/70" : "bg-down/70"
            )}
            style={{ width: `${strengthPct}%` }}
          />
        </span>
        {r.condUp != null && (
          <span
            title={`Khi ${r.sourceLabel} bật > +0,75% (${r.shockUpN} mẫu): ${r.targetLabel} cũng tăng ${fmtPctVi(r.condUp)} lần`}
          >
            P(↑|↑)={fmtPctVi(r.condUp)}
          </span>
        )}
        {r.condDown != null && (
          <span
            title={`Khi ${r.sourceLabel} rơi < −0,75% (${r.shockDownN} mẫu): ${r.targetLabel} cũng giảm ${fmtPctVi(r.condDown)} lần`}
          >
            P(↓|↓)={fmtPctVi(r.condDown)}
          </span>
        )}
        <span title="Số cặp quan sát dùng tính tương quan">n={r.obs.toLocaleString("vi-VN")}</span>
      </div>
    </li>
  );
}

export function RelationsCard() {
  const queryClient = useQueryClient();

  const relationsQuery = useQuery({
    queryKey: ["market-relations"],
    queryFn: () => apiGet<MarketRelationsResponse>("/api/market/relations"),
    staleTime: 5 * 60_000,
  });

  const refresh = useMutation({
    mutationFn: () => apiPost<XrelRefreshResponse>("/api/market/relations/refresh"),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ["market-relations"] });
      const r = res.result;
      toast.success(
        `Đã học lại: ${r.priceRelations} quan hệ giá→giá · ${r.newsRelations} quan hệ tin→giá`,
        {
          description:
            r.newsNote ??
            `${r.segments} phân đoạn · cửa sổ ${fmtDayVi(r.windowFrom)} → ${fmtDayVi(r.windowTo)} · ${r.durationMs}ms`,
        }
      );
    },
    onError: (err: Error) => {
      toast.error("Học lại thất bại", { description: err.message });
    },
  });

  const insight = useMutation({
    mutationFn: () => apiPost<XrelInsightResponse>("/api/market/relations/insight"),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ["market-relations"] });
      toast.success("Đã tổng hợp nhận định quan hệ thị trường", {
        description: `Model ${res.insight.model} · ${res.insight.relationsCount} quan hệ làm cơ sở`,
      });
    },
    onError: (err: Error) => {
      toast.error("Tổng hợp nhận định thất bại", {
        description: err.message,
      });
    },
  });

  const data = relationsQuery.data;
  const meta = data?.meta;
  const relations = data?.relations ?? [];
  const insightData = data?.insight;
  const busy = refresh.isPending || insight.isPending;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Network className="size-4 text-primary" aria-hidden="true" />
          Quan hệ thị trường
        </CardTitle>
        <CardDescription>
          Cơ chế số 2 — học từ tin tức &amp; biến động giá <strong>đã qua</strong>
          (750 phiên): ai dẫn dắt ai, xác suất lan toả cú sốc
        </CardDescription>
        <CardAction>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 px-2.5"
              onClick={() => insight.mutate()}
              disabled={busy}
              aria-label="Tổng hợp nhận định quan hệ thị trường bằng LLM"
            >
              {insight.isPending ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Sparkles className="size-3.5" aria-hidden="true" />
              )}
              <span className="hidden sm:inline">Tổng hợp nhận định</span>
              <span className="sm:hidden">Nhận định</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 px-2.5"
              onClick={() => refresh.mutate()}
              disabled={busy}
              aria-label="Chạy lại engine học quan hệ thị trường"
            >
              {refresh.isPending ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw className="size-3.5" aria-hidden="true" />
              )}
              <span className="hidden sm:inline">Học lại</span>
            </Button>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="pb-0">
        {relationsQuery.isLoading ? (
          <div className="flex flex-col gap-2 px-6 pb-6">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : relationsQuery.isError ? (
          <p className="px-6 pb-6 text-sm text-down">
            {relationsQuery.error?.message ?? "Không tải được quan hệ thị trường."}
          </p>
        ) : relations.length === 0 ? (
          <p className="px-6 pb-6 text-sm text-muted-foreground">
            Chưa học được quan hệ nào — bấm{" "}
            <strong>Học lại</strong> để engine chạy trên dữ liệu giá lịch sử.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 px-4 pb-3 sm:px-6">
              <Badge variant="secondary" className="gap-1 px-2 py-0.5 text-[10px]">
                {meta?.total ?? relations.length} quan hệ
              </Badge>
              <Badge variant="outline" className="px-2 py-0.5 text-[10px] text-muted-foreground">
                {meta?.price ?? 0} giá→giá · {meta?.news ?? 0} tin→giá
              </Badge>
              {meta?.windowFrom && meta?.windowTo && (
                <Badge variant="outline" className="px-2 py-0.5 text-[10px] text-muted-foreground">
                  cửa sổ {fmtDayVi(meta.windowFrom)} → {fmtDayVi(meta.windowTo)}
                </Badge>
              )}
              {meta?.computedAt && (
                <span
                  className="text-[11px] text-muted-foreground"
                  suppressHydrationWarning
                >
                  học lúc{" "}
                  {new Date(meta.computedAt).toLocaleTimeString("vi-VN", {
                    hour: "2-digit",
                    minute: "2-digit",
                    timeZone: "Asia/Ho_Chi_Minh",
                  })}
                </span>
              )}
            </div>
            <ul className="max-h-96 divide-y divide-border/60 overflow-y-auto custom-scrollbar">
              {relations.map((r) => (
                <RelationRow key={`${r.sourceKey}-${r.targetKey}-${r.lag}-${r.kind}`} r={r} />
              ))}
            </ul>
            {(meta?.news ?? 0) === 0 && (
              <p className="px-4 pt-3 text-[11px] text-amber-600 dark:text-amber-400 sm:px-6">
                Lớp tin→giá đang tích luỹ: crawler RSS cần ≥ 15 ngày giao dịch có
                tin đối chiếu được mới học quan hệ tin tức→giá (trung thực, không
                ngoại suy từ ít mẫu).
              </p>
            )}
            {insightData && (
              <div className="mx-4 mt-4 mb-6 rounded-lg border border-border/70 bg-accent/30 p-4 sm:mx-6">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Sparkles className="size-3.5 text-primary" aria-hidden="true" />
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Nhận định quan hệ ảnh hưởng qua lại
                  </span>
                  <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-muted-foreground">
                    {insightData.model}
                  </Badge>
                  <span
                    className="text-[11px] text-muted-foreground"
                    suppressHydrationWarning
                  >
                    {new Date(insightData.generatedAt).toLocaleString("vi-VN", {
                      timeZone: "Asia/Ho_Chi_Minh",
                    })}
                  </span>
                </div>
                <p className="max-h-96 overflow-y-auto custom-scrollbar whitespace-pre-line text-sm leading-relaxed">
                  {renderNarrative(insightData.narrative)}
                </p>
              </div>
            )}
            <p className="px-4 py-3 text-[11px] text-muted-foreground sm:px-6">
              Hồi cứu từ dữ liệu quá khứ (M2 #103) — ngữ cảnh đối chiếu cho
              Market Analyst · News &amp; Sentiment · Chủ tịch mỗi chu kỳ; learning-rag
              học lại &amp; tổng hợp nhận định mỗi Chủ nhật 05:00.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
