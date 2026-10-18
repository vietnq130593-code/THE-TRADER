"use client";

import * as React from "react";
import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { vi } from "date-fns/locale";
import { Activity, Database, ExternalLink, FileText, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { apiGet } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/lib/store";
import type { QueryCache, QueryClient } from "@tanstack/react-query";
import type { AgentsResponse, SystemStatusResponse } from "@/lib/types";

/**
 * Sticky footer (blueprint §3): trạng thái nguồn dữ liệu động (S4 stale
 * marking — DataSourceStatus), lần cập nhật cache cuối, chế độ giao dịch
 * (S3 paper/live) và realtime indicator. Lấy từ GET /api/system/status.
 *
 * "Lần cập nhật cuối" đọc cache TanStack Query qua useSyncExternalStore
 * (pattern chuẩn React 19 — không setState trong timer/subscription).
 */

/** Thời điểm ghi cache mới nhất — reactive theo cache, thuần khi render. */
function useCacheLastUpdatedMs(): number {
  const queryClient: QueryClient = useQueryClient();
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      const cache: QueryCache = queryClient.getQueryCache();
      return cache.subscribe(onChange);
    },
    [queryClient]
  );
  const getSnapshot = React.useCallback(() => {
    let max = 0;
    for (const q of queryClient.getQueryCache().getAll()) {
      if (q.state.dataUpdatedAt > max) max = q.state.dataUpdatedAt;
    }
    return max;
  }, [queryClient]);
  return React.useSyncExternalStore(subscribe, getSnapshot, () => 0);
}

/** Đồng hồ 15s (hydration-safe) để làm mới nhãn tương đối. */
function useNowMs15(): number {
  return React.useSyncExternalStore(
    (onChange) => {
      const timer = setInterval(onChange, 15_000);
      return () => clearInterval(timer);
    },
    () => Math.floor(Date.now() / 15_000) * 15_000,
    () => 0
  );
}

const MODE_LABEL: Record<string, string> = {
  live: "trực tiếp",
  simulated: "mô phỏng",
  fallback: "cache",
  paper: "paper",
  real: "EOD thật",
};

function modeDotClass(mode: string, stale: boolean): string {
  if (stale) return "bg-flat"; // vàng cảnh báo stale (phiên #45 — token chủ đề)
  switch (mode) {
    case "live":
    case "real": // EOD thật từ VNDIRECT dchart — xanh dương như live
      return "bg-up";
    case "simulated":
      return "bg-flat/80";
    case "fallback":
      return "bg-down";
    default:
      return "bg-muted-foreground";
  }
}

/** Định dạng gọn số token (946.123 → "946K", 2.1M). */
function formatTokensCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

export function Footer() {
  const isFetching = useIsFetching() > 0;
  const realtimeConnected = useUiStore((s) => s.realtimeConnected);
  const lastUpdatedMs = useCacheLastUpdatedMs();
  const nowMs = useNowMs15();

  const { data: status } = useQuery({
    queryKey: ["system-status"],
    queryFn: () => apiGet<SystemStatusResponse>("/api/system/status"),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  // PHASE3 B3 §5.5 — chip chi phí AI (CFO phải thấy được đồng tiền):
  // aggregate AgentRun từ GET /api/agents (B2 stats), tăng sau mỗi run/chat.
  const { data: agents } = useQuery({
    queryKey: ["agents"],
    queryFn: () => apiGet<AgentsResponse>("/api/agents"),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const aiCost = agents?.totals;
  // Số agent động cho tooltip chi phí AI (fallback kiến trúc 23 agents).
  const agentCount = agents?.agents?.length;

  const relativeLabel =
    lastUpdatedMs > 0 && nowMs > 0
      ? formatDistanceToNow(new Date(lastUpdatedMs), {
          addSuffix: true,
          locale: vi,
        })
      : null;

  return (
    <footer className="mt-auto border-t bg-background/60">
      <div className="mx-auto flex w-full max-w-[1440px] flex-col items-center justify-between gap-2 px-4 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))] text-center text-xs text-muted-foreground sm:flex-row sm:px-6 sm:text-left">
        <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
          {/* Realtime (WebSocket market-engine) */}
          <Badge
            variant="outline"
            className="gap-1.5 px-2 py-0.5 text-[10px]"
            title={
              realtimeConnected
                ? "Đang kết nối WebSocket market-engine (cổng 3003) — bảng giá cập nhật mỗi 10 giây"
                : // AUDIT 137 D1 — tooltip cũ hứa "đang dùng polling TanStack
                  // Query" khi WS chết nhưng ["quotes"] KHÔNG có refetchInterval
                  // (khai polling giả — audit D1). Giờ ĐÃ CÓ fallback thật:
                  // ["quotes"] tự làm mới mỗi 30s khi realtimeConnected=false.
                  "Chưa kết nối WebSocket — bảng giá tự động làm mới mỗi 30 giây (chế độ dự phòng)"
            }
          >
            <span className="relative flex size-2">
              <span
                className={cn(
                  "absolute inline-flex h-full w-full rounded-full opacity-60",
                  realtimeConnected && "animate-ping",
                  realtimeConnected ? "bg-up" : "bg-muted-foreground"
                )}
              />
              <span
                className={cn(
                  "relative inline-flex size-2 rounded-full",
                  realtimeConnected ? "bg-up" : "bg-muted-foreground"
                )}
              />
            </span>
            <Activity className="size-3" aria-hidden="true" />
            Realtime
          </Badge>

          {/* PHASE3 B3 §5.5 — chi phí vận hành đội AI lũy kế */}
          {aiCost && (
            <Badge
              variant="outline"
              className="gap-1.5 px-2 py-0.5 text-[10px] text-muted-foreground"
              title={`Tổng chi phí LLM ${agents?.llm?.model ?? "—"} (${agents?.llm?.modelLabel ?? "provider src/lib/llm.ts"}) của ${agentCount ? `${agentCount} agents` : "24 agents"}: ${aiCost.runCount} lượt chạy · ${aiCost.totalTokensIn.toLocaleString("vi-VN")} token vào · ${aiCost.totalTokensOut.toLocaleString("vi-VN")} token ra${agents?.llm?.free ? " · model free-tier — chi phí phát sinh = $0" : ""}`}
            >
              <Sparkles className="size-3" aria-hidden="true" />
              AI: ${aiCost.totalCostUsd.toFixed(2)} ·{" "}
              {formatTokensCompact(aiCost.totalTokensIn + aiCost.totalTokensOut)} tokens
            </Badge>
          )}

          {/* Trạng thái từng nguồn dữ liệu (S4 stale marking) */}
          {status?.sources.map((s) => (
            <Badge
              key={s.key}
              variant="outline"
              className="gap-1.5 px-2 py-0.5 text-[10px] text-muted-foreground"
              title={
                s.lastError
                  ? `Lỗi gần nhất: ${s.lastError}`
                  : s.lastSuccessAt
                    ? `Lần thành công cuối: ${new Date(s.lastSuccessAt).toLocaleString("vi-VN")}`
                    : s.key === "trading"
                      ? status.trading.label
                      : "Chưa có lần thành công nào"
              }
            >
              <span
                className={cn("size-1.5 rounded-full", modeDotClass(s.mode, s.stale))}
                aria-hidden="true"
              />
              {s.label}: {MODE_LABEL[s.mode] ?? s.mode}
              {s.stale ? " · stale" : ""}
            </Badge>
          ))}

          {relativeLabel ? (
            <span className="tabular-nums whitespace-nowrap" suppressHydrationWarning>
              Cập nhật lần cuối {relativeLabel}
              {isFetching ? " · đang làm mới…" : ""}
            </span>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-end">
          <span className="hidden items-center gap-1 lg:inline-flex">
            <Database className="size-3" aria-hidden="true" />
            The Trader — đa tác tử · VNDIRECT · chỉ dùng cho minh họa
          </span>
          <nav aria-label="Liên kết chân trang" className="flex items-center gap-4">
            <a
              href="https://www.vndirect.com.vn"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center gap-1 transition-colors hover:text-foreground sm:min-h-0"
            >
              <ExternalLink className="size-3" aria-hidden="true" />
              VNDIRECT
            </a>
            <a
              href="#"
              className="inline-flex min-h-11 items-center gap-1 transition-colors hover:text-foreground sm:min-h-0"
              onClick={(e) => e.preventDefault()}
            >
              <FileText className="size-3" aria-hidden="true" />
              Tài liệu hệ thống
            </a>
          </nav>
        </div>
      </div>
    </footer>
  );
}
