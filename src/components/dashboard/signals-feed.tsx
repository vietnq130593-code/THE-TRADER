"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { vi } from "date-fns/locale";
import {
  ArrowRight,
  FlaskConical,
  Loader2,
  Minus,
  Radar,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet, apiPost } from "@/lib/api";
import { useDateRange } from "@/hooks/use-date-range";
import { formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { SignalRow } from "@/lib/types";

const DIRECTION: Record<
  string,
  { label: string; className: string; icon: React.ComponentType<{ className?: string }> }
> = {
  BUY: {
    label: "Mua",
    className: "bg-up/15 text-up hover:bg-up/15",
    icon: TrendingUp,
  },
  SELL: {
    label: "Bán",
    className: "bg-down/15 text-down hover:bg-down/15",
    icon: TrendingDown,
  },
  HOLD: {
    label: "Giữ",
    className: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    icon: Minus,
  },
};

const CONFIDENCE: Record<string, { label: string; className: string }> = {
  HIGH: { label: "Tin cậy cao", className: "border-up/40 text-up" },
  MEDIUM: { label: "Tin cậy vừa", className: "border-amber-500/40 text-amber-600 dark:text-amber-400" },
  LOW: { label: "Tin cậy thấp", className: "text-muted-foreground" },
};

/**
 * Phiên #34 — props tùy chọn cho bản compact trên workspace Tổng quan:
 * - limit: số dòng hiển thị tối đa (chỉ hiệu lực khi compact).
 * - compact: mỗi dòng gọn hơn (ẩn cột phụ, không nút Chuyển lệnh).
 * - onSeeAll: callback footer "Xem tất cả (N) →" (vd chuyển sang tab Tín hiệu).
 * Mặc định (không truyền props) giữ 100% hành vi cũ.
 */
export interface SignalsFeedProps {
  limit?: number;
  compact?: boolean;
  onSeeAll?: () => void;
}

export function SignalsFeed({ limit, compact = false, onSeeAll }: SignalsFeedProps) {
  const queryClient = useQueryClient();
  // #105 — khoảng thời gian toàn cục trên thanh bar: lọc tín hiệu theo khoảng.
  const { rangeQuery, rangeKey, dateRange } = useDateRange();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["signals", rangeKey],
    queryFn: () =>
      apiGet<{ signals: SignalRow[] }>(`/api/signals${rangeQuery ? `?${rangeQuery}` : ""}`),
    staleTime: 60_000,
  });

  const convertMutation = useMutation({
    mutationFn: (id: string) =>
      apiPost<{ order: { symbol: string; side: string; quantity: number; price: number } }>(
        `/api/signals/${id}/convert`
      ),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ["signals"] });
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      toast.success("Đã tạo lệnh chờ khớp", {
        description: `${res.order.side === "BUY" ? "MUA" : "BÁN"} ${res.order.quantity} cp ${res.order.symbol} @ ${formatPrice(res.order.price)} ₫`,
      });
    },
    onError: (err: Error) => {
      toast.error(err.message || "Không chuyển được tín hiệu thành lệnh.");
    },
  });

  const signals = data?.signals ?? [];
  // Bản compact chỉ hiện `limit` dòng đầu (mặc định 5 khi compact mà không truyền limit).
  const maxRows = compact ? (limit ?? 5) : signals.length;
  const visible = signals.slice(0, maxRows);
  const hiddenCount = signals.length - visible.length;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Radar className="size-4 text-muted-foreground" aria-hidden="true" />
          Tín hiệu giao dịch
          {dateRange != null && (
            <span className="rounded-sm bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              theo khoảng đã chọn
            </span>
          )}
        </CardTitle>
        <CardDescription>
          {compact
            ? `Khuyến nghị mới nhất từ các agent · ${signals.length} tín hiệu`
            : "Khuyến nghị mới nhất từ các agent"}
        </CardDescription>
      </CardHeader>
      <CardContent className="pb-0">
        {isLoading ? (
          <div className="flex flex-col gap-3 pb-4">
            {Array.from({ length: compact ? 3 : 4 }).map((_, i) => (
              <Skeleton key={i} className={compact ? "h-14 w-full rounded-lg" : "h-24 w-full rounded-lg"} />
            ))}
          </div>
        ) : isError ? (
          <p className="pb-6 text-sm text-down">
            {error?.message ?? "Không tải được tín hiệu."}
          </p>
        ) : signals.length === 0 ? (
          <p className="pb-6 text-sm text-muted-foreground">Chưa có tín hiệu nào.</p>
        ) : (
          <ul
            className={cn(
              "divide-y overflow-y-auto custom-scrollbar",
              compact ? "max-h-none" : "max-h-[32rem]"
            )}
          >
            {visible.map((s) => {
              const dir = DIRECTION[s.direction] ?? DIRECTION.HOLD;
              const DirIcon = dir.icon;
              const conf = CONFIDENCE[s.confidence] ?? CONFIDENCE.MEDIUM;
              const convertible = !compact && s.direction !== "HOLD" && !s.actedAt;
              if (compact) {
                // Dòng compact: hướng + mã + điểm + lý do cắt 1 dòng + tuổi.
                return (
                  <li key={s.id} className="flex flex-col gap-1 py-2.5 pr-1">
                    <div className="flex items-center gap-2">
                      <Badge className={cn("gap-1", dir.className)}>
                        <DirIcon className="size-3" aria-hidden="true" />
                        {dir.label}
                      </Badge>
                      <span className="text-sm font-bold tracking-tight">{s.symbol}</span>
                      <span className="tabular-nums text-xs text-muted-foreground">
                        {s.score.toFixed(0)}/100
                      </span>
                      {s.sandboxExecuted && (
                        <Badge
                          variant="outline"
                          className="gap-1 border-primary/40 text-[10px] text-primary"
                          title="Agents đã tự thực thi tín hiệu này trong tài khoản thử nghiệm (K1)"
                        >
                          <FlaskConical className="size-3" aria-hidden="true" />
                          Thực thi
                        </Badge>
                      )}
                      {s.actedAt && (
                        <Badge variant="secondary" className="ml-auto text-[10px]">
                          Đã chuyển lệnh
                        </Badge>
                      )}
                    </div>
                    {s.rationale && (
                      <p className="truncate text-xs text-muted-foreground" title={s.rationale}>
                        {s.rationale}
                      </p>
                    )}
                  </li>
                );
              }
              return (
                <li key={s.id} className="flex flex-col gap-2 py-3.5 pr-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge className={cn("gap-1", dir.className)}>
                      <DirIcon className="size-3" aria-hidden="true" />
                      {dir.label}
                    </Badge>
                    <span className="text-sm font-bold tracking-tight">{s.symbol}</span>
                    <span className="max-w-[220px] truncate text-xs text-muted-foreground">
                      {s.name}
                    </span>
                    {convertible && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="ml-auto h-8 gap-1.5 px-2.5 text-xs"
                        disabled={convertMutation.isPending}
                        onClick={() => convertMutation.mutate(s.id)}
                      >
                        {convertMutation.isPending &&
                        convertMutation.variables === s.id ? (
                          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                        ) : (
                          <ArrowRight className="size-3" aria-hidden="true" />
                        )}
                        Chuyển lệnh
                      </Button>
                    )}
                    {s.actedAt && (
                      <Badge variant="secondary" className="ml-auto text-[10px]">
                        Đã chuyển lệnh
                      </Badge>
                    )}
                    {s.sandboxExecuted && (
                      <Badge
                        variant="outline"
                        className={cn(
                          "gap-1 border-primary/40 text-[10px] text-primary",
                          !s.actedAt && "ml-auto"
                        )}
                        title="Agents đã tự thực thi tín hiệu này trong tài khoản thử nghiệm (K1) — xem lệnh ở Danh mục → Thử nghiệm"
                      >
                        <FlaskConical className="size-3" aria-hidden="true" />
                        Đã thực thi · thử nghiệm
                      </Badge>
                    )}
                  </div>

                  <p className="text-sm leading-relaxed">{s.rationale}</p>

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
                    <div className="flex min-w-32 flex-1 items-center gap-2 sm:max-w-48">
                      <span className="whitespace-nowrap text-muted-foreground">
                        Điểm {s.score.toFixed(0)}/100
                      </span>
                      <Progress
                        value={s.score}
                        className="h-1.5 [&_[data-slot=progress-indicator]]:bg-primary"
                      />
                    </div>
                    <Badge variant="outline" className={cn("text-[10px]", conf.className)}>
                      {conf.label}
                    </Badge>
                  </div>

                  <div className="tabular-nums flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                    {s.targetPrice != null && (
                      <span>
                        Mục tiêu:{" "}
                        <span className="font-medium text-foreground">
                          {formatPrice(s.targetPrice)} ₫
                        </span>
                      </span>
                    )}
                    {s.stopLoss != null && (
                      <span>
                        Cắt lỗ:{" "}
                        <span className="font-medium text-down">
                          {formatPrice(s.stopLoss)} ₫
                        </span>
                      </span>
                    )}
                    {s.takeProfit != null && (
                      <span>
                        Chốt lời:{" "}
                        <span className="font-medium text-up">
                          {formatPrice(s.takeProfit)} ₫
                        </span>
                      </span>
                    )}
                    <span className="ml-auto">
                      {s.agentName ?? "Agent"} ·{" "}
                      {formatDistanceToNow(new Date(s.createdAt), {
                        addSuffix: true,
                        locale: vi,
                      })}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {/* Footer compact — "Xem tất cả (N) →" chuyển sang workspace Tín hiệu */}
        {compact && !isLoading && !isError && hiddenCount > 0 && onSeeAll && (
          <button
            type="button"
            onClick={onSeeAll}
            className="my-2 flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg border border-dashed text-sm font-medium text-primary transition-colors hover:bg-accent"
          >
            Xem tất cả ({signals.length.toLocaleString("vi-VN")})
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </button>
        )}
      </CardContent>
    </Card>
  );
}
