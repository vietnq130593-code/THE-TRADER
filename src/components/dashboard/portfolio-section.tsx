"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Activity,
  ArrowLeftRight,
  Briefcase,
  ClipboardList,
  Coins,
  FlaskConical,
  Loader2,
  PieChart,
  RotateCcw,
  TrendingUp,
  Wallet,
} from "lucide-react";
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
import { usePortfolioWorld, useResetPaperWorld, buildOrdersUrl } from "@/hooks/use-portfolio-world";
import { AllocationDonut } from "@/components/dashboard/allocation-donut";
import { EquityCurveCard } from "@/components/dashboard/portfolio/equity-curve-card";
// F-1112-08: pnlToneOf — quyết định tone P&L một nguồn (kit) thay pnlTone local.
import { ChipMeta, EmptyState, ListRow, StatTile, pnlToneOf } from "@/components/dashboard/kit";
import {
  changeColor,
  formatDateTime,
  formatPct,
  formatPrice,
  formatSigned,
  formatVnd,
  formatVndCompact,
  formatVolume,
} from "@/lib/format";
import type {
  OrderRow,
  OrdersResponse,
  OrdersSessionContext,
  PortfolioPosition,
  PortfolioResponse,
  TradeRow,
} from "@/lib/types";
import { cn } from "@/lib/utils";

// F-1112-06 (fixbug #111): OrdersResponse + OrdersSessionContext chuyển về
// MỘT nguồn src/lib/types.ts — xoá 2 bản copy interface local ở đây và ở
// overview/todo-panel.tsx (rủi ro drift khi /api/orders đổi shape).

const ORDER_STATUS: Record<string, { label: string; className: string }> = {
  PENDING: { label: "Chờ khớp", className: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  SUBMITTED: { label: "Đã gửi", className: "border-border bg-secondary text-secondary-foreground" },
  PARTIALLY_FILLED: { label: "Khớp một phần", className: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  FILLED: { label: "Đã khớp", className: "border-up/40 bg-up/10 text-up" },
  CANCELLED: { label: "Đã hủy", className: "border-border bg-muted text-muted-foreground" },
  REJECTED: { label: "Bị từ chối", className: "border-down/40 bg-down/10 text-down" },
  EXPIRED: { label: "Hết hiệu lực", className: "border-border bg-muted text-muted-foreground" },
};

/** "% TH" kiểu vi-VN (dấu phẩy thập phân) — dùng cả cột bảng lẫn thẻ mobile. */
const wf1 = new Intl.NumberFormat("vi-VN", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
function fmtWeight(pct: number): string {
  return `${wf1.format(pct)}%`;
}

/** M4.1.2 — badge đếm trên tab: amber khi có việc đang chờ (lệnh chờ khớp). */
function TabCount({ value, warn = false }: { value: number; warn?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none tabular-nums",
        warn
          ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
          : "bg-muted-foreground/10 text-muted-foreground",
      )}
    >
      {value}
    </span>
  );
}

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
    portfolioUrl,
    vndirectConfigured,
  } = usePortfolioWorld();
  const setActiveWorkspace = useUiStore((s) => s.setActiveWorkspace);
  // M4.1.3 — điều hướng chéo #88: bấm vị thế → chọn mã + chuyển module Thị trường.
  const setSelectedSymbol = useUiStore((s) => s.setSelectedSymbol);

  // #91 việc 1 — reset thế giới Giấy: Dialog xác nhận tường minh (pattern #90
  // sandbox-card) — một lần bấm không đủ & dễ hiểu nhầm là đã xong.
  const resetPaper = useResetPaperWorld();
  const [resetDialogOpen, setResetDialogOpen] = React.useState(false);

  const portfolioQuery = useQuery({
    queryKey: ["portfolio", viewAccountType],
    // F-1112-07: dùng portfolioUrl từ hook (một nguồn) thay chuỗi tự build.
    queryFn: () => apiGet<PortfolioResponse>(portfolioUrl),
    staleTime: 60_000,
  });
  // #105 — khoảng thời gian toàn cục: lọc lệnh + giao dịch theo khoảng
  // (vị thế/danh mục là trạng-thái HIỆN TẠI — không lọc theo thời gian).
  const { rangeQuery, rangeKey } = useDateRange();
  const ordersQuery = useQuery({
    queryKey: ["orders", viewAccountType, rangeKey],
    // F-1112-07: buildOrdersUrl từ hook — cùng builder với todo-panel.
    queryFn: () => apiGet<OrdersResponse>(buildOrdersUrl(viewAccountType, rangeQuery)),
    staleTime: 60_000,
  });

  const p = portfolioQuery.data;
  const loading = portfolioQuery.isLoading || ordersQuery.isLoading;
  const isSandbox = viewAccountType === "sandbox";

  // M4.1.2 — nhãn đếm theo vòng đời: vị thế mở · lệnh CHỜ (PENDING/khớp một
  // phần — "thấy ngay có việc đang chờ") · giao dịch đã khớp.
  const positionsCount = p?.positions.length ?? 0;
  const pendingOrdersCount =
    ordersQuery.data?.orders.filter(
      (o) => o.status === "PENDING" || o.status === "PARTIALLY_FILLED"
    ).length ?? 0;
  const tradesCount = ordersQuery.data?.trades.length ?? 0;

  // M4.1.1 — sức mua (#110-F API trả sẵn; fallback client cho cache cũ thiếu trường).
  const buyingPower =
    p?.buyingPower ??
    (p
      ? p.account.cashBalance +
        Math.max(0, p.totals.totalMarketValue * 0.5 - p.account.marginUsed)
      : 0);

  // M4.1.3 — pattern #88: chọn mã + chuyển workspace "market" (cả 2 setter đã
  // có trong useUiStore) — dùng chung hàng bảng desktop & thẻ mobile.
  const goMarket = (symbol: string) => {
    setSelectedSymbol(symbol);
    setActiveWorkspace("market");
  };

  return (
    <>
      {/* ══════ Tầng 1 (M4.1.1): KPI tier-1 + thông tin phụ hạ cấp ══════
          Hết "floating island" — 4 ô StatTile (kit) trả lời ngay "tôi đang
          lãi/lỗ bao nhiêu"; tiền mặt/GTTH/margin/LN thực hiện hạ cấp thành
          khối ListRow mảnh (không còn 6 tile cùng trọng lượng). */}
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
                className="ml-2 inline-flex min-h-9 items-center gap-1 rounded text-xs font-medium text-primary underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/40 md:min-h-6"
              >
                quản lý vốn &amp; đặt lại: Cài đặt → Cơ chế thử nghiệm
              </button>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {loading ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-24 w-full rounded-lg" />
              ))}
            </div>
          ) : portfolioQuery.isError ? (
            <p className="text-sm text-down">
              {portfolioQuery.error?.message ?? "Không tải được danh mục."}
            </p>
          ) : p ? (
            <>
              {/* Tier-1 (kit.StatTile): mobile 2 cột → sm 4 cột */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatTile
                  label="Tổng tài sản"
                  value={formatVnd(p.totals.totalEquity)}
                  sub={`tiền ${formatVndCompact(p.account.cashBalance)} · vị thế ${formatVndCompact(p.totals.totalMarketValue)}`}
                  icon={Wallet}
                />
                <StatTile
                  label="Lãi/lỗ chưa thực hiện"
                  value={`${formatSigned(p.totals.totalUnrealizedPnl)} ₫`}
                  sub={formatPct(p.totals.totalUnrealizedPnlPct)}
                  tone={pnlToneOf(p.totals.totalUnrealizedPnl)}
                  icon={TrendingUp}
                />
                <StatTile
                  label="Biến động ngày"
                  value={formatPct(p.totals.dayChangePct)}
                  sub="so tham chiếu phiên trước"
                  tone={pnlToneOf(p.totals.dayChangePct)}
                  icon={Activity}
                />
                <StatTile
                  label="Sức mua"
                  value={formatVnd(buyingPower)}
                  sub="ước tính 50% ký quỹ"
                  icon={Coins}
                />
              </div>

              {/* Thông tin phụ hạ cấp (kit.ListRow): 1 khối mảnh 2 cột thay 2 tile cũ */}
              <div className="grid rounded-lg border bg-muted/20 sm:grid-cols-2">
                <ListRow label="Tiền mặt" value={formatVnd(p.account.cashBalance)} className="py-2" />
                <ListRow label="Giá trị vị thế" value={formatVnd(p.totals.totalMarketValue)} className="py-2" />
                <ListRow label="Margin đang dùng" value={formatVnd(p.account.marginUsed)} className="py-2" />
                <ListRow
                  label="Lãi/lỗ đã thực hiện"
                  value={`${formatSigned(p.totals.totalRealizedPnl)} ₫`}
                  tone={pnlToneOf(p.totals.totalRealizedPnl)}
                  className="py-2"
                />
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>

      {/* ══════ Tầng 2 (M4.1.1): đường cong equity + phân bổ ngành ══════
          xl 7fr/5fr cạnh nhau · mobile xếp dọc. Curve rỗng/flat-zero →
          EmptyState trung thực (kit). Donut giữ nguyên component #34 — chỉ đổi vị trí.
          F-1112-03 (fixbug #111): khi /api/portfolio LỖI → KHÔNG render tầng 2 —
          nếu vẫn render, curve/donut rơi vào nhánh "chưa có dữ liệu" (§2.5 trung
          thực trạng thái: lỗi ≠ trống) trong khi tier-1 đã hiện câu lỗi đúng. */}
      {!portfolioQuery.isError && (
        <div className="grid gap-4 xl:grid-cols-[7fr_5fr]">
          <EquityCurveCard curve={p?.equityCurve} loading={portfolioQuery.isLoading} />
          <Card className="gap-4">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <PieChart className="size-4 text-muted-foreground" aria-hidden="true" />
                Phân bổ ngành
              </CardTitle>
            </CardHeader>
            <CardContent className="pb-6">
              <AllocationDonut
                positions={p?.positions ?? []}
                totalMarketValue={p?.totals.totalMarketValue ?? 0}
                loading={portfolioQuery.isLoading}
              />
            </CardContent>
          </Card>
        </div>
      )}

      {/* ══════ Tầng 3 (M4.1.2–M4.1.4): tabs theo vòng đời + bảng/thẻ ══════ */}
      <Card className="gap-4">
        <CardContent className="flex flex-col gap-4">
          <Tabs value={portfolioTab} onValueChange={setPortfolioTab} className="min-w-0 flex-1">
            <TabsList className="h-9">
              <TabsTrigger value="positions" className="text-xs sm:text-sm">
                Vị thế
                <TabCount value={positionsCount} />
              </TabsTrigger>
              <TabsTrigger value="orders" className="text-xs sm:text-sm" title="Số lệnh đang chờ khớp">
                {/* F-1112-05 (fixbug #111): nội dung tab hiển thị MỌI lệnh trong
                khoảng (by design #110) → nhãn "Lệnh chờ" nói sai phạm vi; đổi
                thành "Lệnh", badge giữ nguyên đếm số chờ khớp + tooltip giải nghĩa. */}
                Lệnh
                <TabCount value={pendingOrdersCount} warn={pendingOrdersCount > 0} />
              </TabsTrigger>
              <TabsTrigger value="trades" className="text-xs sm:text-sm">
                Giao dịch
                <TabCount value={tradesCount} />
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
                <>
                  {/* M4.10 — mobile <md: thẻ dọc thay bảng min-w-720 (hết cuộn ngang) */}
                  <div className="flex flex-col gap-2 md:hidden">
                    {p.positions.map((pos) => (
                      <PositionCardView
                        key={pos.symbol}
                        pos={pos}
                        totalMarketValue={p.totals.totalMarketValue}
                        onOpen={() => goMarket(pos.symbol)}
                      />
                    ))}
                    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg border border-dashed px-3 py-2 text-xs tabular-nums">
                      <span className="text-muted-foreground">
                        Tổng GTTH{" "}
                        <span className="font-semibold text-foreground">
                          {formatVnd(p.totals.totalMarketValue)}
                        </span>
                      </span>
                      <span className={changeColor(p.totals.totalUnrealizedPnl)}>
                        L/L {formatSigned(p.totals.totalUnrealizedPnl)} ₫ (
                        {formatPct(p.totals.totalUnrealizedPnlPct)})
                      </span>
                    </div>
                  </div>
                  {/* Desktop ≥ md: bảng — hàng bấm được → biểu đồ mã (M4.1.3) */}
                  <div className="hidden overflow-x-auto custom-scrollbar md:block">
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
                          <TableRow
                            key={pos.symbol}
                            className="min-h-11 cursor-pointer hover:bg-accent/50"
                            title={`Xem biểu đồ ${pos.symbol} — chuyển sang Thị trường`}
                            tabIndex={0}
                            onClick={() => goMarket(pos.symbol)}
                            onKeyDown={(e: React.KeyboardEvent<HTMLTableRowElement>) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                goMarket(pos.symbol);
                              }
                            }}
                          >
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
                                ? fmtWeight((pos.marketValue / p.totals.totalMarketValue) * 100)
                                : "—"}
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
                </>
              ) : (
                /* M4.1.4 — empty có hành động: việc cần làm để có dữ liệu */
                <EmptyState
                  icon={Briefcase}
                  title="Chưa có vị thế mở"
                  description="Duyệt một tín hiệu MUA để vị thế đầu tiên xuất hiện tại đây — lãi/lỗ cập nhật theo từng chu kỳ."
                  action={
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setActiveWorkspace("signals")}
                    >
                      Xem tín hiệu đề xuất
                    </Button>
                  }
                />
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
                <>
                  {/* M4.10 — mobile <md: thẻ dọc thay bảng min-w-820 */}
                  <div className="flex flex-col gap-2 md:hidden">
                    {ordersQuery.data.orders.map((o) => (
                      <OrderRowView
                        key={o.id}
                        order={o}
                        session={ordersQuery.data.session}
                        variant="card"
                      />
                    ))}
                  </div>
                  <div className="hidden overflow-x-auto custom-scrollbar md:block">
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
                </>
              ) : (
                <EmptyState
                  icon={ClipboardList}
                  title="Chưa có lệnh nào"
                  description="Lệnh xuất hiện khi tín hiệu đề xuất được duyệt — tín hiệu gần nhất đang chờ duyệt ở module Tín hiệu."
                  action={
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setActiveWorkspace("signals")}
                    >
                      Tới module Tín hiệu
                    </Button>
                  }
                />
              )}
            </TabsContent>

            {/* Trades */}
            <TabsContent value="trades" className="mt-3">
              {ordersQuery.isLoading ? (
                <Skeleton className="h-56 w-full" />
              ) : ordersQuery.isError ? (
                /* F-1112-02 (fixbug #111): tab Giao dịch thiếu nhánh lỗi như tab
                Lệnh — trước fix API lỗi lại hiện EmptyState "Chưa có giao dịch
                khớp nào" (§2.5: trống ≠ lỗi). */
                <p className="text-sm text-down">
                  {ordersQuery.error?.message ?? "Không tải được giao dịch."}
                </p>
              ) : ordersQuery.data && ordersQuery.data.trades.length > 0 ? (
                <>
                  {/* M4.10 — mobile <md: thẻ dọc thay bảng min-w-720 */}
                  <div className="flex flex-col gap-2 md:hidden">
                    {ordersQuery.data.trades.map((t) => (
                      <TradeCardView key={t.id} t={t} />
                    ))}
                  </div>
                  <div className="hidden overflow-x-auto custom-scrollbar md:block">
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
                </>
              ) : (
                /* M4.1.4 — GIỮ hint ngoài phiên #96 bên trong EmptyState */
                <EmptyState
                  icon={ArrowLeftRight}
                  title="Chưa có giao dịch khớp nào"
                  description={
                    <>
                      <p>Lệnh đã đặt sẽ sinh giao dịch khi được khớp trong phiên.</p>
                      {(() => {
                        const sess = ordersQuery.data?.session;
                        if (!sess || sess.inSession || !sess.strictSession) return null;
                        return (
                          <p>
                            Ngoài phiên giao dịch — lệnh đang chờ sẽ được xét khớp khi mở phiên{" "}
                            <span className="font-medium text-amber-600 dark:text-amber-400">
                              {sess.nextOpenLabel ?? "kế tiếp"}
                            </span>
                            .
                          </p>
                        );
                      })()}
                    </>
                  }
                />
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

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
                  {/* F-1112-04 (fixbug #111): N đếm từ ordersQuery đang lọc theo
                  khoảng thời gian toàn cục, còn reset xoá TOÀN BỘ lệnh mọi thời
                  điểm — câu cũ "hiện có N lệnh sẽ bị xoá"/"đã sạch" sai khi chọn
                  khoảng hẹp. Đổi văn bản trung thực phạm vi hai số. */}
                  {(ordersQuery.data?.orders.length ?? 0) > 0
                    ? `khoảng đang xem có ${ordersQuery.data?.orders.length} lệnh — reset xoá MỌI lệnh mọi thời điểm.`
                    : "khoảng đang xem không còn lệnh nào — reset vẫn xoá mọi lệnh mọi thời điểm."}
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
    </>
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

/**
 * M4.10 — thẻ vị thế dọc mobile: tiêu đề = symbol + badge biến động ngày ·
 * dòng 2 = KL/vốn/HT/giá trị · dòng 3 = meta lãi/lỗ + % TH. Thẻ bấm được
 * như hàng bảng desktop (chuyển module Thị trường + chọn mã — M4.1.3).
 */
function PositionCardView({
  pos,
  totalMarketValue,
  onOpen,
}: {
  pos: PortfolioPosition;
  totalMarketValue: number;
  onOpen: () => void;
}) {
  const weight = totalMarketValue > 0 ? (pos.marketValue / totalMarketValue) * 100 : null;
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`Xem biểu đồ ${pos.symbol} — chuyển sang Thị trường`}
      className="flex min-h-11 w-full flex-col gap-1.5 rounded-lg border bg-card p-3 text-left outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/40 active:bg-accent"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="font-semibold">{pos.symbol}</span>
          <span className="truncate text-[11px] text-muted-foreground">
            {pos.sector || pos.name}
          </span>
        </span>
        <ChipMeta tone={pnlToneOf(pos.changePct)} title="Biến động ngày của mã">
          {formatPct(pos.changePct)}
        </ChipMeta>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs tabular-nums">
        <span>
          <span className="text-muted-foreground">KL </span>
          {formatVolume(pos.quantity)}
        </span>
        <span>
          <span className="text-muted-foreground">vốn </span>
          {formatPrice(pos.avgPrice)}
        </span>
        <span>
          <span className="text-muted-foreground">HT </span>
          {formatPrice(pos.last)}
        </span>
        <span>
          <span className="text-muted-foreground">GT </span>
          {formatVndCompact(pos.marketValue)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs tabular-nums">
        <span className={changeColor(pos.unrealizedPnl)}>
          L/L {formatSigned(pos.unrealizedPnl)} ₫ ({formatPct(pos.unrealizedPnlPct)})
        </span>
        <span className="text-muted-foreground">
          %TH {weight != null ? fmtWeight(weight) : "—"}
        </span>
      </div>
    </button>
  );
}

/** M4.10 — thẻ giao dịch dọc mobile (không bấm — chỉ đọc). */
function TradeCardView({ t }: { t: TradeRow }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <span className="font-semibold">{t.symbol}</span>
          <SideBadge side={t.side} />
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {formatDateTime(t.executedAt)}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs tabular-nums">
        <span>
          <span className="text-muted-foreground">KL </span>
          {formatVolume(t.quantity)}
        </span>
        <span>
          <span className="text-muted-foreground">giá khớp </span>
          {formatPrice(t.price)}
        </span>
        <span>
          <span className="text-muted-foreground">GT </span>
          {formatVndCompact(t.value)}
        </span>
        <span>
          <span className="text-muted-foreground">phí+thuế </span>
          {formatVnd(Number(t.fee) + Number(t.tax))}
        </span>
      </div>
    </div>
  );
}

function OrderRowView({
  order,
  session,
  variant = "table",
}: {
  order: OrderRow;
  session?: OrdersSessionContext;
  /** M4.10 — "table" cho desktop ≥ md, "card" cho thẻ dọc mobile. */
  variant?: "table" | "card";
}) {
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

  // M4.10 — biến thể THẺ DỌC mobile: tiêu đề = symbol + badge trạng thái ·
  // dòng 2 = số chính KL/giá/khớp · dòng 3 = meta thời gian + kế hoạch +
  // hint "đang chờ gì" + nút Hủy cho lệnh PENDING (y như bảng desktop).
  if (variant === "card") {
    const plan = parsePlanNote(order.note);
    return (
      <div className="flex flex-col gap-1.5 rounded-lg border bg-card p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2">
            <span className="font-semibold">{order.symbol}</span>
            <SideBadge side={order.side} />
            <span className="text-[11px] text-muted-foreground">
              {order.type === "LIMIT" ? "LO" : order.type === "MARKET" ? "MP" : order.type}
            </span>
          </span>
          <Badge variant="outline" className={cn("shrink-0 whitespace-nowrap", status.className)}>
            {status.label}
          </Badge>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs tabular-nums">
          <span>
            <span className="text-muted-foreground">KL </span>
            {formatVolume(order.quantity)}
          </span>
          <span>
            <span className="text-muted-foreground">giá </span>
            {formatPrice(order.price)}
          </span>
          <span>
            <span className="text-muted-foreground">khớp </span>
            {order.filledQuantity > 0 ? (
              <>
                {formatVolume(order.filledQuantity)}
                {order.avgFillPrice ? (
                  <span className="text-muted-foreground"> @{formatPrice(order.avgFillPrice)}</span>
                ) : null}
              </>
            ) : (
              "—"
            )}
          </span>
        </div>
        <p className="text-[11px] tabular-nums text-muted-foreground">
          {formatDateTime(order.createdAt)}
        </p>
        {plan ? (
          <p
            className="truncate text-[10px] leading-snug text-primary/90"
            title={plan.humanNote || plan.summary}
          >
            {plan.humanNote || plan.summary}
          </p>
        ) : order.note ? (
          <p
            className="truncate text-[10px] leading-snug text-muted-foreground"
            title={order.note}
          >
            {order.note}
          </p>
        ) : null}
        {waitingHint ? (
          <p className="text-[10px] leading-snug text-amber-600 dark:text-amber-400">
            {waitingHint}
          </p>
        ) : null}
        {cancelable ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 self-start px-3 text-xs text-muted-foreground"
            disabled={cancelMutation.isPending}
            onClick={() => cancelMutation.mutate()}
            aria-label={`Hủy lệnh ${order.side === "BUY" ? "mua" : "bán"} ${order.symbol}`}
          >
            {cancelMutation.isPending ? "Đang hủy…" : "Hủy lệnh"}
          </Button>
        ) : null}
      </div>
    );
  }

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
