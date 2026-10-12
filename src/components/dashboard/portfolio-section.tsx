"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FlaskConical, Loader2, RotateCcw, Wallet } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { useDateRange } from "@/hooks/use-date-range";
import { useUiStore } from "@/lib/store";
import { usePortfolioWorld, useResetPaperWorld } from "@/hooks/use-portfolio-world";
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
  /** #96 — bối cảnh phiên (server tính): hint "lệnh đang chờ gì". */
  session?: OrdersSessionContext;
}

/** #96 — /api/orders kèm bối cảnh phiên giao dịch để giải thích lệnh chờ. */
interface OrdersSessionContext {
  /** MARKET_STRICT_SESSION=true → matching nghỉ ngoài phiên. */
  strictSession: boolean;
  /** Đang trong phiên liên tục HOSE? */
  inSession: boolean;
  /** Phase hiện tại (pre-open/morning/lunch/afternoon/atc/closed). */
  phase?: string;
  /** Nhãn tiếng Việt của phase — vd "Ngoài phiên". */
  phaseLabel?: string;
  /** ISO của thời điểm mở phiên kế. */
  nextOpenAt?: string;
  /** Nhãn hiển thị — vd "Thứ Hai 12/10 · 09:15 ICT". */
  nextOpenLabel?: string;
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

  // K1 (#87 — AUTONOMY_BLUEPRINT v1.1 §5.6-Q3): bộ lọc tài khoản Giấy/Thử nghiệm.
  // PHIÊN #90 — dùng usePortfolioWorld (một nguồn suy luận dùng chung với chip
  // tiền trên Header): cơ chế thử nghiệm đang bật & trader chưa từng bấm chọn
  // tay → Danh mục TỰ xem thế giới Thử nghiệm (hiệu lệnh "kích hoạt thử nghiệm
  // thì coi tiền chế độ đó là tiền chính để đầu tư giả định" — trước đây mặc
  // định Giấy 452tr demo nên trader thấy "vẫn giữ giá trị demo cũ"). Query key
  // gắn accountType → mọi world tự invalidate theo prefix ["portfolio"] như cũ.
  // PHIÊN #91 — paperLabel "Giấy"→"Thực tế" khi VNDIRECT thật đã cấu hình
  // (việc 2) + useResetPaperWorld "Đặt lại thế giới Giấy về 0" (việc 1).
  const {
    viewAccountType,
    sandboxAvailable,
    sandboxState: kSandbox,
    setWorld: setAccountType,
    paperLabel,
    vndirectConfigured,
  } = usePortfolioWorld();
  const setActiveWorkspace = useUiStore((s) => s.setActiveWorkspace);

  // #91 việc 1 — reset thế giới Giấy: Dialog xác nhận tường minh (pattern #90
  // sandbox-card) — một lần bấm không đủ & dễ hiểu nhầm là đã xong.
  const resetPaper = useResetPaperWorld();
  const [resetDialogOpen, setResetDialogOpen] = React.useState(false);

  const portfolioQuery = useQuery({
    queryKey: ["portfolio", viewAccountType],
    queryFn: () =>
      apiGet<PortfolioResponse>(
        viewAccountType === "sandbox" ? "/api/portfolio?accountType=sandbox" : "/api/portfolio"
      ),
    staleTime: 60_000,
  });
  // #105 — khoảng thời gian toàn cục: lọc lệnh + giao dịch theo khoảng
  // (vị thế/danh mục là trạng-thái HIỆN TẠI — không lọc theo thời gian).
  const { rangeQuery, rangeKey } = useDateRange();
  const ordersQuery = useQuery({
    queryKey: ["orders", viewAccountType, rangeKey],
    queryFn: () =>
      apiGet<OrdersResponse>(
        `${viewAccountType === "sandbox" ? "/api/orders?accountType=sandbox" : "/api/orders"}${rangeQuery ? (viewAccountType === "sandbox" ? "&" : "?") : ""}${rangeQuery}`
      ),
    staleTime: 60_000,
  });

  const p = portfolioQuery.data;
  const loading = portfolioQuery.isLoading || ordersQuery.isLoading;
  const isSandbox = viewAccountType === "sandbox";

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2">
            <Wallet className="size-4 text-muted-foreground" aria-hidden="true" />
            Danh mục đầu tư
          </span>
          {/* K1 (#87 §5.6-Q3): bộ lọc tài khoản Giấy/Thử nghiệm — segmented control.
              #91 việc 2 — nhãn "Giấy" → "Thực tế" khi VNDIRECT thật đã cấu hình
              (paperLabel từ usePortfolioWorld — một nguồn cho cả Header chip). */}
          <div className="flex flex-wrap items-center gap-2">
            <div
              className="flex items-center gap-1 rounded-lg border border-border/60 p-1"
              role="group"
              aria-label="Chọn thế giới tài khoản hiển thị"
            >
              <button
                type="button"
                onClick={() => setAccountType("paper")}
                aria-pressed={viewAccountType === "paper"}
                title={
                  vndirectConfigured
                    ? "Thế giới THỰC TẾ — tài khoản VNDIRECT thật đã kết nối (lệnh vẫn qua duyệt của bạn)"
                    : "Thế giới Giấy (paper) — mô phỏng, chưa kết nối VNDIRECT thật"
                }
                className={cn(
                  "flex min-h-8 items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40",
                  viewAccountType === "paper"
                    ? "bg-secondary text-secondary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {vndirectConfigured && (
                  <span
                    className="size-1.5 shrink-0 rounded-full bg-up"
                    aria-hidden="true"
                    title="VNDIRECT thật đã kết nối"
                  />
                )}
                {paperLabel}
              </button>
              <button
                type="button"
                onClick={() => sandboxAvailable && setAccountType("sandbox")}
                disabled={!sandboxAvailable}
                aria-pressed={viewAccountType === "sandbox"}
                title={
                  sandboxAvailable
                    ? "Tài khoản thử nghiệm — agents tự giao dịch (K1)"
                    : "Chưa kích hoạt cơ chế thử nghiệm (Cài đặt → Cơ chế thử nghiệm)"
                }
                className={cn(
                  "flex min-h-8 items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50",
                  viewAccountType === "sandbox"
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <FlaskConical className="size-3" aria-hidden="true" />
                Thử nghiệm
              </button>
            </div>
            {/* #91 việc 1 — Đặt lại thế giới Giấy về 0 (chỉ khi đang xem Giấy/
                Thực tế; Thử nghiệm có công cụ riêng ở Settings). */}
            {!isSandbox && (
              <Button
                variant="outline"
                size="sm"
                className="min-h-8 gap-1.5 text-xs"
                disabled={resetPaper.isPending}
                onClick={() => setResetDialogOpen(true)}
                aria-label="Đặt lại thế giới Giấy về 0 — xoá toàn bộ dữ liệu demo"
                title="Xoá toàn bộ dữ liệu demo cũ của thế giới Giấy: lệnh · vị thế · giao dịch · đường cong — tiền về đúng 0 ₫"
              >
                <RotateCcw className="size-3.5" aria-hidden="true" />
                Đặt lại dữ liệu
              </Button>
            )}
          </div>
        </CardTitle>
        <CardDescription>
          {p
            ? `${
                isSandbox
                  ? "Tài khoản thử nghiệm K1 — agents tự giao dịch qua cổng đồng thuận"
                  : `Tài khoản ${p.account.broker} · ${p.account.accountNumber} · ${
                      p.account.accountType === "margin" ? "Ký quỹ (margin)" : "Thường"
                    }${vndirectConfigured ? " · ĐÃ KẾT NỐI THẬT — thế giới Thực tế" : ""}`
              }${isSandbox && kSandbox?.paused ? " · đang tạm dừng lệnh mới" : ""}`
            : isSandbox
              ? "Tài khoản thử nghiệm (K1)"
              : vndirectConfigured
                ? "Tài khoản VNDIRECT — thế giới Thực tế"
                : "Tài khoản VNDIRECT"}
          {isSandbox && (
            <button
              type="button"
              onClick={() => setActiveWorkspace("settings")}
              className="ml-2 inline-flex min-h-6 items-center gap-1 rounded text-xs font-medium text-primary underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              quản lý vốn &amp; đặt lại: Cài đặt → Cơ chế thử nghiệm
            </button>
          )}
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
                      <OrderRowView key={o.id} order={o} session={ordersQuery.data.session} />
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
              <div className="py-6 text-center">
                <p className="text-sm text-muted-foreground">Chưa có giao dịch khớp nào.</p>
                {/* #96 — ngoài phiên + strictSession → nói rõ vì sao chưa có gì khớp */}
                {(() => {
                  const sess = ordersQuery.data?.session;
                  if (!sess || sess.inSession || !sess.strictSession) return null;
                  return (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Ngoài phiên giao dịch — lệnh đang chờ sẽ được xét khớp khi mở phiên{" "}
                      <span className="font-medium text-amber-600 dark:text-amber-400">
                        {sess.nextOpenLabel ?? "kế tiếp"}
                      </span>
                      .
                    </p>
                  );
                })()}
              </div>
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

      {/* #91 việc 1 — Dialog xác nhận "Đặt lại thế giới Giấy về 0" (pattern
          #90 sandbox-card: tường minh thay nút 1-bấm dễ hiểu nhầm đã xong). */}
      <Dialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Đặt lại thế giới {paperLabel} về 0 — xoá toàn bộ dữ liệu demo?
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2">
                <p>
                  Xoá sạch quá khứ giao dịch của{" "}
                  <span className="font-medium">toàn bộ tài khoản {paperLabel.toLowerCase()}</span>{" "}
                  (mô phỏng — chưa/không phải tiền thật):
                </p>
                <ul className="ml-4 list-disc space-y-0.5">
                  <li>mọi lệnh (kể cả chờ khớp) · vị thế · giao dịch đã khớp</li>
                  <li>đường cong tiền/equity (CashSnapshot)</li>
                  <li>
                    tiền mặt &amp; tổng tài sản về{" "}
                    <span className="font-semibold text-foreground">0 ₫ tròn trĩnh</span>
                  </li>
                </ul>
                <p>
                  <span className="font-medium text-foreground">Không đụng tới:</span> tài khoản
                  Thử nghiệm (một đồng không đổi) · tín hiệu đề xuất · bài học &amp; bộ nhớ học
                  tập của agents — {" "}
                  {(ordersQuery.data?.orders.length ?? 0) > 0
                    ? `hiện có ${ordersQuery.data?.orders.length} lệnh sẽ bị xoá.`
                    : "thế giới này hiện không còn lệnh nào (đã sạch)."}
                </p>
                <p>
                  Tổng kết lãi/lỗ vòng cũ được lưu vào audit trước khi xoá (minh bạch — không
                  biến mất âm thầm).
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetDialogOpen(false)}>
              Huỷ
            </Button>
            <Button
              variant="destructive"
              className="gap-2"
              disabled={resetPaper.isPending}
              onClick={() => {
                resetPaper.mutate(undefined, {
                  onSuccess: () => setResetDialogOpen(false),
                });
              }}
            >
              {resetPaper.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <RotateCcw className="size-4" aria-hidden="true" />
              )}
              Xoá hết &amp; về 0
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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

function OrderRowView({ order, session }: { order: OrderRow; session?: OrdersSessionContext }) {
  const status = ORDER_STATUS[order.status] ?? {
    label: order.status,
    className: "border-border bg-muted text-muted-foreground",
  };
  const queryClient = useQueryClient();

  // F-206 (audit): hủy lệnh đang chờ khớp (phần chưa khớp) — POST /api/orders/[id]/cancel
  const cancelable = order.status === "PENDING" || order.status === "PARTIALLY_FILLED";

  // #96 — hint "lệnh đang chờ gì": giải thích TẠI SAO lệnh chưa khớp để trader
  // không tưởng hệ thống đứng yên (trường hợp thực: cuối tuần MARKET_STRICT_SESSION
  // → matching nghỉ, lệnh chờ mở phiên Thứ Hai). Trong phiên → nói điều kiện giá.
  const waitingHint = (() => {
    if (!cancelable || !session) return null;
    if (session.inSession) {
      return order.side === "BUY"
        ? `Đang chờ giá ≤ ${formatPrice(order.price)} trong phiên`
        : `Đang chờ giá ≥ ${formatPrice(order.price)} trong phiên`;
    }
    if (session.strictSession) {
      return `Ngoài phiên giao dịch — sẽ được xét khớp khi mở phiên ${session.nextOpenLabel ?? "kế tiếp"}`;
    }
    return "Ngoài phiên — simulator khớp lệnh 24/7 theo tick giá mô phỏng";
  })();
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
        {/* #96 — dòng giải thích "đang chờ gì" dưới badge trạng thái */}
        {waitingHint ? (
          <p className="mt-1 max-w-[260px] text-[10px] leading-snug text-amber-600 dark:text-amber-400">
            {waitingHint}
          </p>
        ) : null}
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
