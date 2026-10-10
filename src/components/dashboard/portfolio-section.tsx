"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Wallet } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiGet, apiPost } from "@/lib/api";
import { useUiStore } from "@/lib/store";
import { AllocationDonut } from "@/components/dashboard/allocation-donut";
import {
  changeColor,
  formatDateTime,
  formatPct,
  formatPrice,
  formatSigned,
  formatVnd,
  formatVolume,
} from "@/lib/format";
import type { OrderRow, PortfolioResponse, TradeRow } from "@/lib/types";
import { cn } from "@/lib/utils";

interface OrdersResponse {
  orders: OrderRow[];
  trades: TradeRow[];
}

const ORDER_STATUS: Record<string, { label: string; className: string }> = {
  PENDING: { label: "Chờ khớp", className: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  SUBMITTED: { label: "Đã gửi", className: "border-border bg-secondary text-secondary-foreground" },
  PARTIALLY_FILLED: { label: "Khớp một phần", className: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  FILLED: { label: "Đã khớp", className: "border-up/40 bg-up/10 text-up" },
  CANCELLED: { label: "Đã hủy", className: "border-border bg-muted text-muted-foreground" },
  REJECTED: { label: "Bị từ chối", className: "border-down/40 bg-down/10 text-down" },
  EXPIRED: { label: "Hết hiệu lực", className: "border-border bg-muted text-muted-foreground" },
};

export function PortfolioSection() {
  const portfolioTab = useUiStore((s) => s.portfolioTab);
  const setPortfolioTab = useUiStore((s) => s.setPortfolioTab);

  const portfolioQuery = useQuery({
    queryKey: ["portfolio"],
    queryFn: () => apiGet<PortfolioResponse>("/api/portfolio"),
    staleTime: 60_000,
  });
  const ordersQuery = useQuery({
    queryKey: ["orders"],
    queryFn: () => apiGet<OrdersResponse>("/api/orders"),
    staleTime: 60_000,
  });

  const p = portfolioQuery.data;
  const loading = portfolioQuery.isLoading || ordersQuery.isLoading;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Wallet className="size-4 text-muted-foreground" aria-hidden="true" />
          Danh mục đầu tư
        </CardTitle>
        <CardDescription>
          {p
            ? `Tài khoản ${p.account.broker} · ${p.account.accountNumber} · ${
                p.account.accountType === "margin" ? "Ký quỹ (margin)" : "Thường"
              }`
            : "Tài khoản VNDIRECT"}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {loading ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-lg" />
            ))}
          </div>
        ) : portfolioQuery.isError ? (
          <p className="text-sm text-down">
            {portfolioQuery.error?.message ?? "Không tải được danh mục."}
          </p>
        ) : p ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Tile label="Tiền mặt" value={formatVnd(p.account.cashBalance)} />
            <Tile label="Giá trị vị thế" value={formatVnd(p.totals.totalMarketValue)} />
            <Tile
              label="Lãi/lỗ chưa thực hiện"
              value={
                <span className={changeColor(p.totals.totalUnrealizedPnl)}>
                  {formatSigned(p.totals.totalUnrealizedPnl)} ₫
                  <span className="ml-1 text-xs">
                    ({formatPct(p.totals.totalUnrealizedPnlPct)})
                  </span>
                </span>
              }
            />
            <Tile label="Tổng tài sản" value={formatVnd(p.totals.totalEquity)} />
            {/* PHASE3 B3 §5.3 — ô ghép: Biến động ngày + Lãi/lỗ ĐÃ THỰC HIỆN (realized) */}
            <Tile
              label="Biến động ngày / LN thực hiện"
              value={
                <span className="flex flex-col leading-tight">
                  <span className={changeColor(p.totals.dayChangePct)}>
                    {formatPct(p.totals.dayChangePct)}
                    <span className="text-[11px] font-normal text-muted-foreground"> ngày</span>
                  </span>
                  <span className={cn("text-xs", changeColor(p.totals.totalRealizedPnl))}>
                    {formatSigned(p.totals.totalRealizedPnl)} ₫
                    <span className="text-[11px] font-normal text-muted-foreground"> đã thực hiện</span>
                  </span>
                </span>
              }
            />
            <Tile label="Margin đang dùng" value={formatVnd(p.account.marginUsed)} />
          </div>
        ) : null}

        {/* PHASE3 B3 §5.3 — Tabs + donut phân bổ ngành (desktop ≥ md) cạnh nhau */}
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <Tabs value={portfolioTab} onValueChange={setPortfolioTab} className="min-w-0 flex-1">
          <TabsList className="h-9">
            <TabsTrigger value="positions" className="text-xs sm:text-sm">
              Vị thế
            </TabsTrigger>
            <TabsTrigger value="orders" className="text-xs sm:text-sm">
              Lệnh
            </TabsTrigger>
            <TabsTrigger value="trades" className="text-xs sm:text-sm">
              Giao dịch
            </TabsTrigger>
          </TabsList>

          {/* Positions */}
          <TabsContent value="positions" className="mt-3">
            {portfolioQuery.isLoading ? (
              <Skeleton className="h-56 w-full" />
            ) : portfolioQuery.isError ? (
              <p className="text-sm text-down">
                {portfolioQuery.error?.message ?? "Không tải được vị thế."}
              </p>
            ) : p && p.positions.length > 0 ? (
              <div className="overflow-x-auto custom-scrollbar">
                <Table className="min-w-[720px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Mã</TableHead>
                      <TableHead className="text-right">KL</TableHead>
                      <TableHead className="text-right">Giá vốn</TableHead>
                      <TableHead className="text-right">Giá HT</TableHead>
                      <TableHead className="text-right">Giá trị</TableHead>
                      {/* PHASE3 B3 §5.3 — % tỷ trọng trong GTTH */}
                      <TableHead className="text-right">% TH</TableHead>
                      <TableHead className="text-right">Lãi/lỗ</TableHead>
                      <TableHead className="text-right">%</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {p.positions.map((pos) => (
                      <TableRow key={pos.symbol} className="min-h-11">
                        <TableCell>
                          <p className="font-semibold">{pos.symbol}</p>
                          <p className="max-w-[180px] truncate text-[11px] text-muted-foreground">
                            {pos.sector || pos.name}
                          </p>
                        </TableCell>
                        <TableCell className="tabular-nums text-right">
                          {formatVolume(pos.quantity)}
                        </TableCell>
                        <TableCell className="tabular-nums text-right">
                          {formatPrice(pos.avgPrice)}
                        </TableCell>
                        <TableCell
                          className={cn("tabular-nums text-right", changeColor(pos.changePct))}
                        >
                          {formatPrice(pos.last)}
                          <span className="ml-1 text-[11px]">
                            {formatPct(pos.changePct)}
                          </span>
                        </TableCell>
                        <TableCell className="tabular-nums text-right">
                          {formatVnd(pos.marketValue)}
                        </TableCell>
                        {/* % tỷ trọng = marketValue / tổng GTTH (§5.3) */}
                        <TableCell className="tabular-nums text-right font-medium">
                          {p.totals.totalMarketValue > 0
                            ? ((pos.marketValue / p.totals.totalMarketValue) * 100).toFixed(1)
                            : "—"}
                          %
                        </TableCell>
                        <TableCell
                          className={cn("tabular-nums text-right", changeColor(pos.unrealizedPnl))}
                        >
                          {formatSigned(pos.unrealizedPnl)}
                        </TableCell>
                        <TableCell
                          className={cn(
                            "tabular-nums text-right font-medium",
                            changeColor(pos.unrealizedPnlPct)
                          )}
                        >
                          {formatPct(pos.unrealizedPnlPct)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  <TableFooter>
                    <TableRow>
                      <TableCell className="font-medium">Tổng cộng</TableCell>
                      <TableCell className="tabular-nums text-right">
                        {formatVolume(
                          p.positions.reduce((s, x) => s + x.quantity, 0)
                        )}
                      </TableCell>
                      <TableCell className="text-right">—</TableCell>
                      <TableCell className="text-right">—</TableCell>
                      <TableCell className="tabular-nums text-right font-semibold">
                        {formatVnd(p.totals.totalMarketValue)}
                      </TableCell>
                      <TableCell className="tabular-nums text-right font-semibold">
                        100,0%
                      </TableCell>
                      <TableCell
                        className={cn(
                          "tabular-nums text-right font-semibold",
                          changeColor(p.totals.totalUnrealizedPnl)
                        )}
                      >
                        {formatSigned(p.totals.totalUnrealizedPnl)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "tabular-nums text-right font-semibold",
                          changeColor(p.totals.totalUnrealizedPnlPct)
                        )}
                      >
                        {formatPct(p.totals.totalUnrealizedPnlPct)}
                      </TableCell>
                    </TableRow>
                  </TableFooter>
                </Table>
              </div>
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Chưa có vị thế mở.
              </p>
            )}
          </TabsContent>

          {/* Orders */}
          <TabsContent value="orders" className="mt-3">
            {ordersQuery.isLoading ? (
              <Skeleton className="h-56 w-full" />
            ) : ordersQuery.isError ? (
              <p className="text-sm text-down">
                {ordersQuery.error?.message ?? "Không tải được lệnh."}
              </p>
            ) : ordersQuery.data && ordersQuery.data.orders.length > 0 ? (
              <div className="overflow-x-auto custom-scrollbar">
                <Table className="min-w-[820px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Thời gian</TableHead>
                      <TableHead>Mã</TableHead>
                      <TableHead>Bên</TableHead>
                      <TableHead>Loại</TableHead>
                      <TableHead className="text-right">KL</TableHead>
                      <TableHead className="text-right">Giá</TableHead>
                      <TableHead className="text-right">KL khớp</TableHead>
                      <TableHead>Trạng thái</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ordersQuery.data.orders.map((o) => (
                      <OrderRowView key={o.id} order={o} />
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Chưa có lệnh nào.
              </p>
            )}
          </TabsContent>

          {/* Trades */}
          <TabsContent value="trades" className="mt-3">
            {ordersQuery.isLoading ? (
              <Skeleton className="h-56 w-full" />
            ) : ordersQuery.data && ordersQuery.data.trades.length > 0 ? (
              <div className="overflow-x-auto custom-scrollbar">
                <Table className="min-w-[720px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Thời gian</TableHead>
                      <TableHead>Mã</TableHead>
                      <TableHead>Bên</TableHead>
                      <TableHead className="text-right">KL</TableHead>
                      <TableHead className="text-right">Giá khớp</TableHead>
                      <TableHead className="text-right">Giá trị</TableHead>
                      <TableHead className="text-right">Phí + thuế</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ordersQuery.data.trades.map((t) => (
                      <TableRow key={t.id} className="min-h-11">
                        <TableCell className="tabular-nums whitespace-nowrap text-muted-foreground">
                          {formatDateTime(t.executedAt)}
                        </TableCell>
                        <TableCell className="font-semibold">{t.symbol}</TableCell>
                        <TableCell>
                          <SideBadge side={t.side} />
                        </TableCell>
                        <TableCell className="tabular-nums text-right">
                          {formatVolume(t.quantity)}
                        </TableCell>
                        <TableCell className="tabular-nums text-right">
                          {formatPrice(t.price)}
                        </TableCell>
                        <TableCell className="tabular-nums text-right">
                          {formatVnd(t.value)}
                        </TableCell>
                        <TableCell className="tabular-nums text-right text-muted-foreground">
                          {formatVnd(Number(t.fee) + Number(t.tax))}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Chưa có giao dịch khớp nào.
              </p>
            )}
          </TabsContent>
        </Tabs>
        {/* PHASE3 B3 §5.3 — donut phân bổ ngành: cạnh tabs ở xl, xuống dưới ở md/lg */}
        <div className="w-full shrink-0 xl:w-auto">
          <AllocationDonut
            positions={p?.positions ?? []}
            totalMarketValue={p?.totals.totalMarketValue ?? 0}
            loading={portfolioQuery.isLoading}
          />
        </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** E-P0-2 (EX-A2): parse nhẹ ExecutionPlan từ Order.note ngay tại client —
 *  không import module server (roster/constants) để giữ bundle nhẹ. */
function parsePlanNote(note: string | null): {
  humanNote: string;
  summary: string;
} | null {
  if (!note || !note.trim().startsWith("{")) return null;
  try {
    const raw = JSON.parse(note) as {
      kind?: string;
      humanNote?: string;
      style?: string;
      slippageBudgetPct?: number;
      deadlineTicks?: number;
      sizing?: string;
      slices?: { quantity?: number; price?: number }[];
    };
    if (raw.kind !== "ExecutionPlan") return null;
    const slice = raw.slices?.[0];
    return {
      humanNote: typeof raw.humanNote === "string" ? raw.humanNote : "",
      summary:
        `Kế hoạch ${raw.style ?? "?"}: ${(raw.slices?.length ?? 1)} lát` +
        (slice?.quantity != null ? ` × ${slice.quantity} cp` : "") +
        ` · trượt ≤${raw.slippageBudgetPct ?? "?"}% · hạn ${raw.deadlineTicks ?? "?"} tick phiên`,
    };
  } catch {
    return null;
  }
}

function OrderRowView({ order }: { order: OrderRow }) {
  const status = ORDER_STATUS[order.status] ?? {
    label: order.status,
    className: "border-border bg-muted text-muted-foreground",
  };
  const queryClient = useQueryClient();

  // F-206 (audit): hủy lệnh đang chờ khớp (phần chưa khớp) — POST /api/orders/[id]/cancel
  const cancelable = order.status === "PENDING" || order.status === "PARTIALLY_FILLED";
  const cancelMutation = useMutation({
    mutationFn: () =>
      apiPost<{ order: { id: string; status: string } }>(
        `/api/orders/${order.id}/cancel`
      ),
    onSuccess: () => {
      toast.success(`Đã hủy lệnh ${order.symbol}`);
      queryClient.invalidateQueries({ queryKey: ["orders"] });
    },
    onError: (err: Error) => {
      toast.error(err.message ?? "Không hủy được lệnh.");
    },
  });

  return (
    <TableRow className="min-h-11">
      <TableCell className="tabular-nums whitespace-nowrap text-muted-foreground">
        {formatDateTime(order.createdAt)}
      </TableCell>
      <TableCell>
        <p className="font-semibold">{order.symbol}</p>
        {(() => {
          const plan = parsePlanNote(order.note);
          if (plan) {
            return (
              <div className="flex max-w-[240px] flex-col gap-0.5">
                {plan.humanNote ? (
                  <span className="truncate text-[11px] text-muted-foreground" title={plan.humanNote}>
                    {plan.humanNote}
                  </span>
                ) : null}
                <span
                  className="truncate text-[10px] text-primary/90"
                  title={plan.summary}
                >
                  {plan.summary}
                </span>
              </div>
            );
          }
          return order.note ? (
            <p className="max-w-[220px] truncate text-[11px] text-muted-foreground" title={order.note}>
              {order.note}
            </p>
          ) : null;
        })()}
      </TableCell>
      <TableCell>
        <SideBadge side={order.side} />
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {order.type === "LIMIT" ? "LO" : order.type === "MARKET" ? "MP" : order.type}
      </TableCell>
      <TableCell className="tabular-nums text-right">
        {formatVolume(order.quantity)}
      </TableCell>
      <TableCell className="tabular-nums text-right">
        {formatPrice(order.price)}
      </TableCell>
      <TableCell className="tabular-nums text-right">
        {order.filledQuantity > 0 ? (
          <>
            {formatVolume(order.filledQuantity)}
            {order.avgFillPrice ? (
              <span className="ml-1 text-[11px] text-muted-foreground">
                @{formatPrice(order.avgFillPrice)}
              </span>
            ) : null}
          </>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={cn("whitespace-nowrap", status.className)}>
            {status.label}
          </Badge>
          {cancelable ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 px-3 text-xs text-muted-foreground"
              disabled={cancelMutation.isPending}
              onClick={() => cancelMutation.mutate()}
              aria-label={`Hủy lệnh ${order.side === "BUY" ? "mua" : "bán"} ${order.symbol}`}
            >
              {cancelMutation.isPending ? "Đang hủy…" : "Hủy"}
            </Button>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}

function SideBadge({ side }: { side: "BUY" | "SELL" }) {
  return side === "BUY" ? (
    <Badge className="bg-up/15 text-up hover:bg-up/15">Mua</Badge>
  ) : (
    <Badge className="bg-down/15 text-down hover:bg-down/15">Bán</Badge>
  );
}

function Tile({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2">
      <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
      <p className="tabular-nums mt-0.5 truncate text-sm font-semibold">{value}</p>
    </div>
  );
}
