"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Coins,
  Flame,
  Gauge,
  ArrowLeftRight,
  Radio,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet } from "@/lib/api";
import { useUiStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import {
  changeColor,
  formatPct,
  formatPrice,
  formatVndCompact,
  formatVolume,
} from "@/lib/format";
import type { FlowsResponse, NewsResponse, QuotesResponse } from "@/lib/types";

// AUDIT 137 D1 — polling fallback khi WebSocket gãy: nhịp làm mới ["quotes"]
// khi realtimeConnected=false (WS market-engine chết); khi WS sống → false.
const QUOTES_FALLBACK_POLL_MS = 30_000;

export function MarketSummary() {
  // AUDIT 137 D1 — WS chết ⇒ ["quotes"] không interval + focus-refetch tắt →
  // 4 thẻ tổng quan thị trường đóng băng. Polling fallback 30s CHỈ khi WS gãy
  // (realtimeConnected=false) — zero tải thêm khi WS khỏe. (MarketPulseBar bên
  // dưới đã dùng realtimeConnected cho dot trạng thái — cùng nguồn store.)
  const realtimeConnected = useUiStore((s) => s.realtimeConnected);
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["quotes"],
    queryFn: () => apiGet<QuotesResponse>("/api/market/quotes"),
    staleTime: 30_000,
    // AUDIT 137 D1 — polling fallback khi WebSocket gãy
    refetchInterval: realtimeConnected ? false : QUOTES_FALLBACK_POLL_MS,
  });

  if (isLoading) {
    return (
      <section
        aria-label="Tổng quan thị trường"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="gap-3 py-4">
            <CardContent className="flex flex-col gap-2 px-4">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-8 w-36" />
              <Skeleton className="h-3 w-24" />
            </CardContent>
          </Card>
        ))}
      </section>
    );
  }

  if (isError || !data) {
    return (
      <section
        aria-label="Tổng quan thị trường"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        <Card className="py-4 sm:col-span-2 xl:col-span-4">
          <CardContent className="px-4 text-sm text-down">
            {error?.message ?? "Không tải được tổng quan thị trường."}
          </CardContent>
        </Card>
      </section>
    );
  }

  const s = data.summary;
  const breadthTotal = Math.max(1, s.advancing + s.declining + s.unchanged);
  const upPct = (s.advancing / breadthTotal) * 100;
  const downPct = (s.declining / breadthTotal) * 100;
  const flatPct = (s.unchanged / breadthTotal) * 100;

  return (
    <>
    <section
      aria-label="Tổng quan thị trường"
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
    >
      {/* VN30 proxy */}
      <StatCard
        icon={<Gauge className="size-4" aria-hidden="true" />}
        label="VN30 (chỉ số proxy)"
        value={
          <span className="tabular-nums">
            {s.indexLevel.toLocaleString("vi-VN", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </span>
        }
        sub={
          <span className={changeColor(s.avgChangePct)}>
            {s.avgChangePct > 0 ? (
              <ArrowUpRight className="size-3" aria-hidden="true" />
            ) : s.avgChangePct < 0 ? (
              <ArrowDownRight className="size-3" aria-hidden="true" />
            ) : null}
            {formatPct(s.avgChangePct)} · {s.count} mã HOSE
          </span>
        }
      />

      {/* Market breadth */}
      <StatCard
        icon={<BarChart3 className="size-4" aria-hidden="true" />}
        label="Bề rộng thị trường"
        value={
          <span className="tabular-nums">
            <span className="text-up">{s.advancing} tăng</span>
            <span className="text-muted-foreground"> / </span>
            <span className="text-down">{s.declining} giảm</span>
          </span>
        }
        sub={
          <span className="flex flex-col gap-1.5">
            <span className="tabular-nums text-muted-foreground">
              {s.unchanged} mã đứng giá
            </span>
            {/* Phiên #45 — 3 sắc thái: xanh dương tăng · đỏ giảm · vàng đứng giá */}
            <span className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <span className="bg-up" style={{ width: `${upPct}%` }} />
              <span className="bg-flat" style={{ width: `${flatPct}%` }} />
              <span className="bg-down" style={{ width: `${downPct}%` }} />
            </span>
          </span>
        }
      />

      {/* Liquidity */}
      <StatCard
        icon={<Coins className="size-4" aria-hidden="true" />}
        label="Thanh khoản phiên"
        value={
          <span className="tabular-nums">{formatVndCompact(s.totalValue)}</span>
        }
        sub={
          <span className="tabular-nums text-muted-foreground">
            Tổng KL: {formatVolume(s.totalVolume)} cp
          </span>
        }
      />

      {/* Top gainer */}
      <StatCard
        icon={<Flame className="size-4 text-up" aria-hidden="true" />}
        label="Tăng giá nhất"
        value={
          s.topGainer ? (
            <span className="flex items-baseline gap-2">
              <span className="text-lg font-bold tracking-tight">
                {s.topGainer.symbol}
              </span>
              <span className={`tabular-nums text-base font-semibold ${changeColor(s.topGainer.changePct)}`}>
                {formatPct(s.topGainer.changePct)}
              </span>
            </span>
          ) : (
            "—"
          )
        }
        sub={
          s.topGainer ? (
            <span className="tabular-nums text-muted-foreground">
              {formatPrice(s.topGainer.last)} ₫ / cp
            </span>
          ) : null
        }
      />
    </section>
    <MarketPulseBar />
    </>
  );
}

/**
 * Thanh pulse Giai đoạn 2: dòng khối ngoại (S6) + tin mới nhất (S5) +
 * trạng thái tick realtime (WebSocket market-engine).
 */

/** Đồng hồ 5s (hydration-safe, thuần khi render) để tính tuổi tick. */
function useNowMs(): number {
  return React.useSyncExternalStore(
    (onChange) => {
      const timer = setInterval(onChange, 5_000);
      return () => clearInterval(timer);
    },
    () => Math.floor(Date.now() / 5_000) * 5_000,
    () => 0
  );
}

function MarketPulseBar() {
  const realtimeConnected = useUiStore((s) => s.realtimeConnected);
  const lastTickAt = useUiStore((s) => s.lastTickAt);
  const nowMs = useNowMs();

  const { data: flows } = useQuery({
    queryKey: ["flows"],
    queryFn: () => apiGet<FlowsResponse>("/api/market/flows"),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
  const { data: news } = useQuery({
    queryKey: ["news"],
    queryFn: () => apiGet<NewsResponse>("/api/news?limit=1"),
    staleTime: 5 * 60_000,
  });

  const latest = news?.items[0];
  const tickAgeSec = lastTickAt && nowMs > 0
    ? Math.max(0, Math.round((nowMs - lastTickAt) / 1000))
    : null;

  return (
    <Card className="gap-0 py-3" aria-label="Xung thị trường">
      <CardContent className="flex flex-col gap-2 px-4 text-xs sm:flex-row sm:items-center sm:gap-6">
        {/* S6 — dòng khối ngoại ròng */}
        <div className="flex shrink-0 items-center gap-2" title={flows?.note}>
          <ArrowLeftRight className="size-4 text-muted-foreground" aria-hidden="true" />
          <span className="text-muted-foreground">Khối ngoại ròng:</span>
          {flows ? (
            <span className={cn("font-semibold tabular-nums", changeColor(flows.totalNet))}>
              {flows.totalNet >= 0 ? "+" : "−"}
              {formatVndCompact(Math.abs(flows.totalNet))}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
          {flows && (
            <span
              className="hidden text-[10px] text-muted-foreground md:inline"
              suppressHydrationWarning
            >
              {flows.mode === "live" ? "nguồn ngoài" : "mô phỏng"} · mua{" "}
              {formatVndCompact(flows.totalBuy)} / bán {formatVndCompact(flows.totalSell)}
            </span>
          )}
        </div>

        <span className="hidden text-muted-foreground/50 sm:inline" aria-hidden="true">
          ·
        </span>

        {/* S5 — tin mới nhất */}
        {latest ? (
          <a
            href={latest.url}
            target="_blank"
            rel="noopener noreferrer"
            className="min-w-0 flex-1 truncate outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
            title={latest.title}
          >
            <span className="mr-1.5 rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground">
              {latest.source}
            </span>
            {latest.title}
          </a>
        ) : (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            Chưa có tin mới — bấm “Nạp tin” ở thẻ Tin tức thị trường
          </span>
        )}

        {/* Realtime tick */}
        <span
          className={cn(
            "flex shrink-0 items-center gap-1.5 tabular-nums",
            realtimeConnected ? "text-up" : "text-muted-foreground"
          )}
          title={
            realtimeConnected
              ? "market-engine đang phát sóng tick mỗi 10 giây"
              : "WebSocket chưa kết nối — dữ liệu làm mới bằng polling"
          }
        >
          <Radio className="size-3.5" aria-hidden="true" />
          {realtimeConnected
            ? `tick ${tickAgeSec != null ? `${tickAgeSec}s` : ""} trước`
            : "offline"}
        </span>
      </CardContent>
    </Card>
  );
}

function StatCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <Card className="gap-3 py-4 transition-shadow hover:shadow-md">
      <CardContent className="flex flex-col gap-1.5 px-4">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          {icon}
          <span>{label}</span>
        </div>
        <div className="text-xl font-semibold tracking-tight sm:text-2xl">
          {value}
        </div>
        {sub ? <div className="text-xs">{sub}</div> : null}
      </CardContent>
    </Card>
  );
}
