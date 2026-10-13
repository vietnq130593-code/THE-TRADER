"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, ChevronRight, ClipboardList } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ChipMeta, EmptyState, pnlToneOf } from "@/components/dashboard/kit";
import { SIGNAL_DIRECTION } from "@/components/dashboard/signals/signal-detail-dialog";
import { useCouncilOverview } from "@/hooks/use-council";
import { useDateRange } from "@/hooks/use-date-range";
import { buildOrdersUrl, usePortfolioWorld } from "@/hooks/use-portfolio-world";
import { apiGet } from "@/lib/api";
import { useUiStore } from "@/lib/store";
import { formatDateTime, formatPrice, formatVndCompact } from "@/lib/format";
import { cn } from "@/lib/utils";
import type {
  AgentsResponse,
  OrdersResponse,
  SignalRow,
} from "@/lib/types";

/**
 * M4.4.3 (UIUX_UPGRADE_BLUEPRINT §4 — #110-d): cột phải "Việc cần làm" của
 * workspace Tổng quan — một nơi gom 4 nhóm việc đang chờ:
 *
 *  (1) Tín hiệu chờ duyệt (ACTIVE + MUA/BÁN chưa acted/rejected) → workspace
 *      Tín hiệu;
 *  (2) Lệnh chờ khớp (PENDING/PARTIALLY_FILLED) + hint nextOpenLabel #96 →
 *      Danh mục → tab Lệnh chờ;
 *  (3) Nhiệm vụ K3 sắp đến (3 nhiệm vụ gần nhất theo nextDueAt) → Đội Agent;
 *  (4) Vị thế Hội đồng kèm lãi/lỗ từng mã (D-LEDGER #106) → Hội đồng.
 *
 * Nhóm rỗng KHÔNG hiển thị; cả 4 trống → EmptyState "hệ thống đang chạy tự
 * động". Mọi query DÙNG CHUNG cache (["signals", rangeKey] · ["orders",
 * viewAccountType, rangeKey] · ["agents"] · ["council-overview", rangeKey]) —
 * panel không thêm request nào.
 */

/* ─────────────────── Thành phần dùng trong panel ─────────────────── */

/** Hàng việc bấm được — py-2.5 · hover accent · cursor-pointer · ≥44px touch. */
function TodoRow({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        title={title}
        className="flex min-h-11 w-full cursor-pointer items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        {children}
        <ChevronRight
          className="ml-auto size-3.5 shrink-0 text-muted-foreground/70"
          aria-hidden="true"
        />
      </button>
    </li>
  );
}

/** Tiêu đề nhóm — chữ hoa nhỏ + đếm tabular. */
function GroupHeader({ id, label, count }: { id: string; label: string; count: number }) {
  return (
    <div id={id} className="flex items-center gap-2 px-1 pb-1">
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="tabular-nums text-[11px] text-muted-foreground">
        {count.toLocaleString("vi-VN")}
      </span>
    </div>
  );
}

/** Màu lãi/lỗ ngữ nghĩa #45 — F-1112-08 (fixbug #111): quyết định tone tập
 * trung ở kit.pnlToneOf; bản map class giữ nguyên "text-flat" (amber nhạt hơn
 * amber-600 của kit.toneTextClass — KHÔNG đổi giao diện hiện tại). */
function pnlColor(n: number | null | undefined): string {
  switch (pnlToneOf(n)) {
    case "up":
      return "text-up";
    case "down":
      return "text-down";
    default:
      return "text-flat";
  }
}

/* ─────────────────── TodoPanel ─────────────────── */

export function TodoPanel() {
  const setActiveWorkspace = useUiStore((s) => s.setActiveWorkspace);
  const setPortfolioTab = useUiStore((s) => s.setPortfolioTab);
  const { rangeQuery, rangeKey } = useDateRange();
  const { viewAccountType } = usePortfolioWorld();

  // 4 nguồn — tất cả trùng key + URL với module tương ứng → dùng chung cache.
  const signalsQuery = useQuery({
    queryKey: ["signals", rangeKey],
    queryFn: () =>
      apiGet<{ signals: SignalRow[] }>(`/api/signals${rangeQuery ? `?${rangeQuery}` : ""}`),
    staleTime: 60_000,
  });
  // Cùng URL-builder với portfolio-section (F-1112-07 — buildOrdersUrl một
  // nguồn ở use-portfolio-world) → ["orders", viewAccountType, rangeKey]
  // chia sẻ cache với Danh mục.
  const ordersQuery = useQuery({
    queryKey: ["orders", viewAccountType, rangeKey],
    queryFn: () => apiGet<OrdersResponse>(buildOrdersUrl(viewAccountType, rangeQuery)),
    staleTime: 60_000,
  });
  // ["agents"] trùng AgentSystemBrief → scheduledTasks lấy từ cache sẵn có.
  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: () => apiGet<AgentsResponse>("/api/agents"),
    staleTime: 30_000,
  });
  const councilQuery = useCouncilOverview(rangeQuery, rangeKey);

  // (1) Tín hiệu chờ duyệt — ACTIVE + MUA/BÁN + chưa acted/rejected.
  const pendingSignals = (signalsQuery.data?.signals ?? []).filter(
    (s) =>
      s.status === "ACTIVE" &&
      (s.direction === "BUY" || s.direction === "SELL") &&
      s.actedAt == null &&
      s.rejectedAt == null,
  );

  // (2) Lệnh chờ khớp — PENDING/khớp một phần, kèm bối cảnh phiên #96.
  const waitingOrders = (ordersQuery.data?.orders ?? []).filter(
    (o) => o.status === "PENDING" || o.status === "PARTIALLY_FILLED",
  );
  const session = ordersQuery.data?.session;

  // (3) Nhiệm vụ K3 sắp đến — 3 nhiệm vụ gần nhất theo nextDueAt (bỏ tạm dừng).
  const scheduledTasks = (agentsQuery.data?.scheduledTasks ?? [])
    .filter((t) => !t.paused && t.nextDueAt)
    .sort((a, b) => a.nextDueAt.localeCompare(b.nextDueAt))
    .slice(0, 3);

  // (4) Vị thế Hội đồng — kèm lãi/lỗ từng mã (D-LEDGER #106).
  const positions = councilQuery.data?.account?.positions ?? [];

  const loading =
    signalsQuery.isLoading ||
    ordersQuery.isLoading ||
    agentsQuery.isLoading ||
    councilQuery.isLoading;

  const total =
    pendingSignals.length + waitingOrders.length + scheduledTasks.length + positions.length;

  const failedSources = [
    signalsQuery.isError ? "tín hiệu" : null,
    ordersQuery.isError ? "lệnh chờ" : null,
    agentsQuery.isError ? "nhiệm vụ K3" : null,
    councilQuery.isError ? "vị thế hội đồng" : null,
  ].filter((x): x is string => x != null);

  return (
    <section aria-label="Việc cần làm">
      <Card className="gap-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardList className="size-4 text-muted-foreground" aria-hidden="true" />
            Việc cần làm
          </CardTitle>
          <CardDescription>
            {loading
              ? "Đang tải…"
              : "Tín hiệu chờ duyệt · lệnh chờ khớp · nhiệm vụ K3 · vị thế hội đồng"}
          </CardDescription>
          {!loading && total > 0 && (
            <CardAction>
              <ChipMeta tone="primary" title="Tổng số việc đang chờ trên 4 nhóm">
                {total.toLocaleString("vi-VN")} việc
              </ChipMeta>
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="pb-0">
          {loading ? (
            <div className="flex flex-col gap-2 pb-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-11 w-full rounded-lg" />
              ))}
            </div>
          ) : total === 0 && failedSources.length === 0 ? (
            <EmptyState
              icon={CheckCircle2}
              title="Không có việc đang chờ"
              description="Hệ thống đang chạy tự động — tín hiệu chờ duyệt, lệnh chờ khớp, nhiệm vụ K3 sắp đến và vị thế Hội đồng sẽ xuất hiện tại đây."
              className="mb-4"
            />
          ) : total === 0 ? (
            <div className="mb-4 rounded-lg border border-down/30 bg-down/5 px-4 py-3">
              <p className="text-sm font-medium text-down">
                Chưa tải được toàn bộ danh sách việc
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Thử tải lại trang; nếu vẫn lỗi, kiểm tra API{" "}
                {failedSources.join(" · ")} trong log server.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-4 pb-2">
              {/* (1) Tín hiệu chờ duyệt → workspace Tín hiệu */}
              {pendingSignals.length > 0 && (
                <section aria-labelledby="todo-signals-h">
                  <GroupHeader
                    id="todo-signals-h"
                    label="Tín hiệu chờ duyệt"
                    count={pendingSignals.length}
                  />
                  <ul className="divide-y divide-border/60 rounded-lg border">
                    {pendingSignals.map((s) => {
                      const dir = SIGNAL_DIRECTION[s.direction] ?? SIGNAL_DIRECTION.HOLD;
                      return (
                        <TodoRow
                          key={s.id}
                          onClick={() => setActiveWorkspace("signals")}
                          title={`Xem tín hiệu ${s.symbol} — chuyển sang workspace Tín hiệu`}
                        >
                          <Badge className={cn("gap-1", dir.className)}>{dir.upper}</Badge>
                          <span className="text-sm font-bold tracking-tight">{s.symbol}</span>
                          <span className="tabular-nums text-[11px] text-muted-foreground">
                            {s.score.toFixed(0)}/100
                          </span>
                        </TodoRow>
                      );
                    })}
                  </ul>
                </section>
              )}

              {/* (2) Lệnh chờ khớp → Danh mục → tab Lệnh chờ */}
              {waitingOrders.length > 0 && (
                <section aria-labelledby="todo-orders-h">
                  <GroupHeader
                    id="todo-orders-h"
                    label="Lệnh chờ khớp"
                    count={waitingOrders.length}
                  />
                  <ul className="divide-y divide-border/60 rounded-lg border">
                    {waitingOrders.map((o) => (
                      <TodoRow
                        key={o.id}
                        onClick={() => {
                          setPortfolioTab("orders");
                          setActiveWorkspace("portfolio");
                        }}
                        title={`Xem lệnh ${o.symbol} — chuyển sang Danh mục → Lệnh chờ`}
                      >
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="flex flex-wrap items-center gap-2">
                            <Badge
                              className={
                                o.side === "BUY" ? "bg-up/15 text-up" : "bg-down/15 text-down"
                              }
                            >
                              {o.side === "BUY" ? "MUA" : "BÁN"}
                            </Badge>
                            <span className="text-sm font-bold tracking-tight">{o.symbol}</span>
                            <span className="tabular-nums text-xs text-muted-foreground">
                              {o.filledQuantity > 0
                                ? `${o.filledQuantity.toLocaleString("vi-VN")}/${o.quantity.toLocaleString("vi-VN")} @ `
                                : `${o.quantity.toLocaleString("vi-VN")} @ `}
                              {o.price != null ? formatPrice(o.price) : "ATO"}
                            </span>
                          </span>
                          {/* #96 — hint "lệnh đang chờ gì" khi matching nghỉ ngoài phiên */}
                          {session && !session.inSession && session.nextOpenLabel ? (
                            <span className="text-[11px] text-amber-600 dark:text-amber-400">
                              chờ mở phiên {session.nextOpenLabel}
                            </span>
                          ) : null}
                        </div>
                      </TodoRow>
                    ))}
                  </ul>
                </section>
              )}

              {/* (3) Nhiệm vụ K3 sắp đến → workspace Đội Agent */}
              {scheduledTasks.length > 0 && (
                <section aria-labelledby="todo-tasks-h">
                  <GroupHeader
                    id="todo-tasks-h"
                    label="Nhiệm vụ K3 sắp đến"
                    count={scheduledTasks.length}
                  />
                  <ul className="divide-y divide-border/60 rounded-lg border">
                    {scheduledTasks.map((t) => (
                      <TodoRow
                        key={t.id}
                        onClick={() => setActiveWorkspace("agents")}
                        title={`${t.title} — ${t.agentName} · đến hạn ${formatDateTime(t.nextDueAt)} · chuyển sang workspace Đội Agent`}
                      >
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="truncate text-sm font-medium">{t.title}</span>
                          <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                            <span className="truncate">{t.agentName}</span>
                            <span aria-hidden="true">·</span>
                            <span className="whitespace-nowrap tabular-nums">
                              {formatDateTime(t.nextDueAt)}
                            </span>
                          </span>
                        </div>
                      </TodoRow>
                    ))}
                  </ul>
                </section>
              )}

              {/* (4) Vị thế Hội đồng → workspace Hội đồng */}
              {positions.length > 0 && (
                <section aria-labelledby="todo-positions-h">
                  <GroupHeader
                    id="todo-positions-h"
                    label="Vị thế Hội đồng"
                    count={positions.length}
                  />
                  <ul className="divide-y divide-border/60 rounded-lg border">
                    {positions.map((p) => (
                      <TodoRow
                        key={`${p.market}-${p.symbol}`}
                        onClick={() => setActiveWorkspace("council")}
                        title={`Vị thế Hội đồng ${p.symbol} — chuyển sang workspace Hội đồng`}
                      >
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                          <span className="text-sm font-bold tracking-tight">{p.symbol}</span>
                          <span className="tabular-nums text-[11px] text-muted-foreground">
                            {p.quantity.toLocaleString("vi-VN")} {p.unitLabel}
                          </span>
                          <span
                            className={cn(
                              "ml-auto shrink-0 tabular-nums text-sm font-medium",
                              pnlColor(p.unrealizedPnl),
                            )}
                          >
                            {p.unrealizedPnl != null ? formatVndCompact(p.unrealizedPnl) : "—"}
                          </span>
                        </div>
                      </TodoRow>
                    ))}
                  </ul>
                </section>
              )}

              {/* Một phần nguồn lỗi (mặt khác vẫn có dữ liệu) — trung thực §2.5 */}
              {failedSources.length > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  Chưa tải được: {failedSources.join(" · ")} — thử tải lại trang.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
