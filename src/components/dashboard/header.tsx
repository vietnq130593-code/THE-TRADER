"use client";

import * as React from "react";
import { useIsFetching, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import {
  FlaskConical,
  Loader2,
  Moon,
  Play,
  Radio,
  RefreshCw,
  Sun,
  TrendingUp,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { apiGet, apiPostJson } from "@/lib/api";
import { useRunAgents } from "@/hooks/use-run-agents";
import { usePortfolioWorld } from "@/hooks/use-portfolio-world";
import { useUiStore, type Workspace } from "@/lib/store";
import { GlobalDateRange } from "@/components/dashboard/global-date-range";
import { cn } from "@/lib/utils";
import { formatVnd, isMarketOpen, vnClock, vnDate } from "@/lib/format";
import type { KRunState, PortfolioResponse } from "@/lib/types";

/** Nhãn module hiện tại — hiển thị cạnh logo để định vị khi sidebar đóng. */
const WORKSPACE_LABELS: Record<Workspace, string> = {
  overview: "Tổng quan",
  market: "Thị trường",
  portfolio: "Danh mục",
  signals: "Tín hiệu",
  agents: "Đội Agent",
  synthesis: "Tổng hợp",
  settings: "Cài đặt",
};

const emptySubscribe = () => () => {};

/** K2 (AUTONOMY_BLUEPRINT v1.1 §4.1 — §8-Q4 duyệt): bộ nhịp chu kỳ liên tục
 *  ∈ {60, 120, 240, 480} phút. Mirror hằng K_RUN_INTERVALS của src/lib/k-run.ts
 *  (server là nguồn validate) — không import trực tiếp vì lib/k-run kéo theo
 *  Prisma client (server-only), client chỉ cần danh sách hiển thị. */
const K2_INTERVALS = [60, 120, 240, 480] as const;

const K2_INTERVAL_LABELS: Record<(typeof K2_INTERVALS)[number], string> = {
  60: "Mỗi giờ",
  120: "Mỗi 2 giờ",
  240: "Mỗi 4 giờ",
  480: "Mỗi 8 giờ",
};

/** Nhãn đếm ngược tới chu kỳ kế (K2) — "≈ 2g15p nữa" / "≈ 45 phút nữa" /
 *  "sắp chạy" khi tới hạn (engine tick 60s sẽ bắt trong ≤60s). */
function k2CountdownLabel(nextCycleAt: string | null, now: Date | null): string | null {
  if (!nextCycleAt || !now) return null;
  const dueMs = Date.parse(nextCycleAt);
  if (!Number.isFinite(dueMs)) return null;
  const diffMs = dueMs - now.getTime();
  if (diffMs <= 0) return "sắp chạy";
  const mins = Math.ceil(diffMs / 60_000);
  if (mins < 60) return `≈ ${mins} phút nữa`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return `≈ ${hours}g${rem > 0 ? `${rem}p` : ""} nữa`;
}

/** true only after hydration (avoids theme icon flash + hydration mismatch) */
function useMounted(): boolean {
  return React.useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );
}

/** Live wall clock, updating every second (null during SSR). */
function useNow(): Date | null {
  const seconds = React.useSyncExternalStore(
    (onChange) => {
      const timer = setInterval(onChange, 1000);
      return () => clearInterval(timer);
    },
    () => Math.floor(Date.now() / 1000),
    () => 0
  );
  return React.useMemo(
    () => (seconds > 0 ? new Date(seconds * 1000) : null),
    [seconds]
  );
}

/**
 * PHIÊN #105 — THANH BAR TRÊN CÙNG THIẾT KẾ LẠI (audit UI/UX #105: "header
 * quá tải — 11-12 phần tử riêng lẻ không có nhóm").
 *
 * Bố cục 3 VÙNG rõ ràng, ngăn bằng Separator dọc (desktop):
 *   [Nhận diện]  logo (mở/đóng sidebar) + nhãn module đang mở
 *   [Thời gian]  BỘ CHỌN KHOẢNG THỜI GIAN TOÀN CỤC (yêu cầu trader) + đồng
 *                hồ ICT + trạng thái phiên + chấm realtime
 *   [Hành động]  chip tài khoản (kèm sức mua ước tính trong tooltip) + cụm
 *                vận hành (Chạy agent + công tắc Liên tục K2) + giao diện + làm mới
 *
 * Giảm nhiễu so với bản cũ:
 *   - chip Sức mua riêng (lg:) GỘP vào tooltip chip tài khoản — bớt 1 số lớn
 *     cạnh thương hiệu; sức mua vẫn thấy đầy đủ ở module Danh mục.
 *   - badge đếm ngược chu kỳ riêng GỘP vào tooltip công tắc Liên tục.
 *   - mọi nút/badge cao đúng 36px (h-9) — hàng ngang thẳng tắp, không nhấp nhô.
 * Mobile: flex-wrap 2 hàng tự nhiên — hàng 1 logo + khoảng thời gian + hành
 * động chính, hàng 2 đồng hồ + phiên + tài khoản.
 */
export function Header() {
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();
  const now = useNow();
  const queryClient = useQueryClient();
  const runAgents = useRunAgents();
  const realtimeConnected = useUiStore((s) => s.realtimeConnected);
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const activeWorkspace = useUiStore((s) => s.activeWorkspace);

  // PHIÊN #90 — chip tài khoản & sức mua ĐỒNG BỘ thế giới tiền đang xem
  // (usePortfolioWorld — cùng nguồn suy luận với Danh mục): cơ chế thử nghiệm
  // đang bật & trader chưa chọn tay → chip hiển thị tiền THỬ NGHIỆM (hiệu
  // lệnh "kích hoạt thử nghiệm thì coi tiền chế độ đó là tiền chính"), bấm
  // "Giấy" trong Danh mục thì chip theo về tài khoản giấy. Query key
  // ["portfolio", world] invalidate theo prefix như cũ.
  // PHIÊN #91 — paperLabel: VNDIRECT thật đã cấu hình → "THỰC TẾ" (việc 2).
  const { viewAccountType, portfolioUrl, paperLabel, vndirectConfigured } = usePortfolioWorld();
  const { data: portfolio } = useQuery({
    queryKey: ["portfolio", viewAccountType],
    queryFn: () => apiGet<PortfolioResponse>(portfolioUrl),
    staleTime: 60_000,
  });
  const isSandboxView = viewAccountType === "sandbox";

  // K2 (#86 — AUTONOMY_BLUEPRINT v1.1 §4.4): trạng thái chế độ chạy liên tục —
  // query riêng refetch 60s (đồng hồ đếm ngược nhích mỗi lần refetch; nhãn phút
  // không cần tick giây nên không thêm tải). exists=false → env hậu phương.
  const { data: kRun } = useQuery({
    queryKey: ["k-run"],
    queryFn: () => apiGet<KRunState>("/api/k/run"),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const kRunMutation = useMutation({
    mutationKey: ["k-run-toggle"],
    mutationFn: (vars: { action: "start" | "stop" | "interval"; intervalMinutes?: number }) =>
      apiPostJson<KRunState>("/api/k/run", vars),
    onSuccess: (res, vars) => {
      queryClient.setQueryData(["k-run"], res);
      if (vars.action === "start") {
        toast.success("Đã bật chế độ chạy liên tục", {
          description: `Chu kỳ 23 agents tự chạy mỗi ${res.intervalMinutes} phút — tắt bất cứ lúc nào bằng đúng nút này.`,
        });
      } else if (vars.action === "stop") {
        toast.success("Đã tắt chế độ chạy liên tục", {
          description: "Hiệu lực từ chu kỳ kế tiếp — chu kỳ đang chạy (nếu có) vẫn hoàn tất an toàn.",
        });
      } else {
        toast.success(`Đã đổi nhịp chu kỳ liên tục: mỗi ${res.intervalMinutes} phút`);
      }
    },
    onError: (err) => {
      toast.error("Không cập nhật được chế độ chạy liên tục", {
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const k2Countdown = k2CountdownLabel(kRun?.nextCycleAt ?? null, now);

  // PHIÊN #46 — công bố chiều cao header THẬT qua biến CSS --header-h
  // (header flex-wrap ở mobile nên cao thay đổi) để AppSidebar neo BÊN DƯỚI
  // mép dưới header thay vì che cả thanh bar trên cùng.
  const headerRef = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const publish = () =>
      document.documentElement.style.setProperty(
        "--header-h",
        `${Math.round(el.getBoundingClientRect().height)}px`
      );
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => {
      ro.disconnect();
      document.documentElement.style.removeProperty("--header-h");
    };
  }, []);

  const isRefreshing = useIsFetching() > 0;

  const open = now ? isMarketOpen(now) : false;

  // PHASE3_BLUEPRINT §5.4 — chip Sức mua (ước tính, minh bạch công thức):
  //   buyingPower = cash + marginRoom,  marginRoom = positionsMv × RATIO − marginUsed
  //   (AUD-CODE #15b: trước đây equity×RATIO đếm kép tiền mặt — equity = cash + GTTH)
  //   MARGIN_ROOM_RATIO default 0.5 (giả lập ký quỹ 50% — KHÔNG phải hạn mức thật VNDIRECT)
  // #105: giá trị này không còn hiện chip riêng trên header (giảm nhiễu) —
  // nằm trong TOOLTIP chip tài khoản + đầy đủ ở module Danh mục.
  const MARGIN_ROOM_RATIO = 0.5;
  const cash = portfolio?.account.cashBalance ?? 0;
  const equity = portfolio?.account.equity ?? 0;
  const marginUsed = portfolio?.account.marginUsed ?? 0;
  const positionsMv = Math.max(0, equity - cash); // GTTH vị thế mở
  const marginRoom = Math.round(positionsMv * MARGIN_ROOM_RATIO - marginUsed);
  const buyingPower = cash + marginRoom;
  const overMargin = marginRoom < 0;

  async function handleRefresh() {
    try {
      await queryClient.invalidateQueries();
      toast.success("Đã làm mới dữ liệu mới nhất");
    } catch {
      toast.error("Không thể làm mới dữ liệu. Vui lòng thử lại.");
    }
  }

  return (
    <header
      ref={headerRef}
      className="sticky top-0 z-40 w-full border-b border-border/60 bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/70"
    >
      <div className="mx-auto flex w-full max-w-[1440px] flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 sm:px-6">
        {/* ═══ VÙNG 1 — NHẬN DIỆN ═══
         * Phiên #45/#46 — logo "The Trader" CHÍNH LÀ nút bật/tắt sidebar trái:
         * nhấp logo để mở, nhấp lại đúng logo để đóng. Sidebar trượt ra BÊN DƯỚI
         * thanh header này nên logo luôn nhìn thấy & bấm được khi sidebar mở. */}
        <button
          type="button"
          aria-expanded={sidebarOpen}
          aria-controls="app-sidebar"
          title="Mở/đóng danh sách module"
          aria-label={
            sidebarOpen
              ? "Đóng thanh điều hướng module"
              : "Mở thanh điều hướng module"
          }
          onClick={toggleSidebar}
          className={cn(
            "flex min-h-9 items-center gap-2.5 rounded-lg px-1.5 py-1 outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/40",
            sidebarOpen && "bg-accent/70"
          )}
        >
          <div
            className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground"
            aria-hidden="true"
          >
            <TrendingUp className="size-4.5" />
          </div>
          <div className="leading-tight text-left">
            <p className="text-sm font-semibold tracking-tight">The Trader</p>
            <p className="hidden text-[11px] text-muted-foreground sm:block">
              Multi-Agent Trading · VNDIRECT
            </p>
          </div>
        </button>

        {/* Module hiện tại — định vị nhanh khi sidebar đóng (phiên #45) */}
        <Badge
          variant="outline"
          className="hidden items-center gap-1.5 px-2.5 py-1 text-xs text-foreground md:inline-flex"
          title={`Module đang mở: ${WORKSPACE_LABELS[activeWorkspace]} — nhấp logo “The Trader” để đổi`}
        >
          {WORKSPACE_LABELS[activeWorkspace]}
        </Badge>

        <Separator orientation="vertical" className="hidden h-7 md:block" />

        {/* ═══ VÙNG 2 — THỜI GIAN ═══
         * #105 — bộ chọn khoảng thời gian toàn cục (yêu cầu trader) + đồng hồ
         * ICT + trạng thái phiên gộp 1 badge với chấm realtime. */}
        <div className="flex min-w-0 items-center gap-2">
          <GlobalDateRange />
        </div>

        <div className="hidden flex-col items-end leading-tight lg:flex">
          <span className="tabular-nums text-sm font-medium" suppressHydrationWarning>
            {now ? vnClock(now) : "--:--:--"}
          </span>
          <span className="text-[11px] text-muted-foreground" suppressHydrationWarning>
            {now ? vnDate(now) : "—"}
          </span>
        </div>

        <Badge
          variant="outline"
          className={cn(
            "gap-1.5 px-2.5 py-1 text-xs",
            open ? "border-up/40 text-up" : "text-muted-foreground"
          )}
          title={
            open
              ? "Phiên giao dịch HOSE đang mở (09:15–11:30 · 13:00–14:45, T2–T6)"
              : "Ngoài phiên giao dịch HOSE"
          }
        >
          <span className="relative flex size-2">
            <span
              className={cn(
                "absolute inline-flex h-full w-full rounded-full opacity-60",
                open ? "animate-ping bg-up" : "bg-muted-foreground"
              )}
            />
            <span
              className={cn(
                "relative inline-flex size-2 rounded-full",
                open ? "bg-up" : "bg-muted-foreground"
              )}
            />
          </span>
          {open ? "Mở cửa" : "Đóng cửa"}
          {realtimeConnected && (
            <>
              <span aria-hidden="true">·</span>
              <Radio
                className="size-3 animate-pulse text-primary"
                aria-label="WebSocket market-engine đang nối"
              />
            </>
          )}
        </Badge>

        {/* ═══ VÙNG 3 — HÀNH ĐỘNG ═══ */}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* Chip tài khoản — #90: theo thế giới tiền đang xem (thử nghiệm khi
           * cơ chế K1 bật & chưa chọn tay — đồng bộ Danh mục). #105: tooltip
           * gộp THÊM sức mua ước tính (bỏ chip riêng đỡ nhiễu). */}
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  className={cn(
                    "hidden h-9 items-center gap-2 rounded-lg border px-3 md:flex",
                    isSandboxView && "border-primary/40 bg-primary/5"
                  )}
                >
                  {isSandboxView && (
                    <FlaskConical className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                  )}
                  <div className="leading-tight">
                    <p className="font-mono text-[11px] text-muted-foreground">
                      {isSandboxView
                        ? `THỬ NGHIỆM · ${portfolio?.account.accountNumber ?? "SANDBOX-K1"}`
                        : `${vndirectConfigured ? "THỰC TẾ · " : ""}VNDIRECT · ${portfolio?.account.accountNumber ?? "—"}`}
                    </p>
                    <p className="tabular-nums text-sm font-semibold">
                      {portfolio ? formatVnd(portfolio.account.equity) : "— ₫"}
                    </p>
                  </div>
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-72 text-left">
                {isSandboxView ? (
                  <div className="space-y-1.5">
                    <p className="text-xs leading-relaxed">
                      Tiền ảo của <b>cơ chế thử nghiệm (K1)</b> — agents tự giao dịch qua cổng
                      đồng thuận. Xem chi tiết: Danh mục → Thử nghiệm · quản lý vốn: Cài đặt →
                      Cơ chế thử nghiệm. Bấm “{paperLabel}” trong Danh mục để chip này quay về
                      tài khoản {vndirectConfigured ? "THỰC TẾ" : "giấy"} VNDIRECT.
                      {vndirectConfigured &&
                        " Cơ chế này đã TỰ ĐỘNG tạm dừng vì VNDIRECT thật đã kết nối."}
                    </p>
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      Sức mua ước tính: {formatVnd(buyingPower)} (tiền mặt {formatVnd(cash)} + phòng
                      ký quỹ ước tính {formatVnd(marginRoom)}) — chi tiết đầy đủ ở module Danh mục.
                    </p>
                  </div>
                ) : vndirectConfigured ? (
                  <div className="space-y-1.5">
                    <p className="text-xs leading-relaxed">
                      Tài khoản VNDIRECT <b>THẬT</b> của trader — đã kết nối (creds đầy đủ). Lệnh
                      thật vẫn qua duyệt từng lệnh của bạn; agents tiếp tục đề xuất như thường.
                    </p>
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      Sức mua ước tính: {formatVnd(buyingPower)} (tiền mặt {formatVnd(cash)} + phòng
                      ký quỹ ước tính {formatVnd(marginRoom)}).
                    </p>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <p className="text-xs leading-relaxed">Tài khoản giấy VNDIRECT của trader.</p>
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      Sức mua ước tính: {formatVnd(buyingPower)} = tiền mặt {formatVnd(cash)} + phòng
                      ký quỹ ước tính {formatVnd(marginRoom)} (hệ số giả lập 0,5 — không phải hạn
                      mức thật VNDIRECT)
                      {overMargin && " — ⚠ Vượt hạn mức ước tính."}
                    </p>
                  </div>
                )}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          {/* Cụm vận hành — #105: nút chạy chu kỳ + công tắc liên tục K2 đứng
           * cạnh nhau trong 1 cụm viền chung (trước đây 2 khối rời + badge
           * đếm ngược + chip riêng — 4 mảnh rời rạc). */}
          <div className="flex h-9 items-center gap-1 rounded-lg border border-border/60 bg-card/60 p-1 pl-1.5">
            <Button
              onClick={() => runAgents.mutate()}
              disabled={runAgents.isPending}
              className="h-7 gap-1.5 px-2.5 text-xs sm:px-3 sm:text-[13px]"
              size="sm"
            >
              {runAgents.isPending ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                  <span className="hidden sm:inline">Đang phân tích…</span>
                  <span className="sm:hidden">Phân tích…</span>
                </>
              ) : (
                <>
                  <Play className="size-3.5" aria-hidden="true" />
                  <span className="hidden sm:inline">Chạy agent</span>
                  <span className="sm:hidden">Agent</span>
                </>
              )}
            </Button>

            {/* K2 (#86 — AUTONOMY_BLUEPRINT v1.1 §4.4): chế độ chạy liên tục.
             * Bật → chu kỳ 23 agents tự chạy theo nhịp cho tới khi trader tắt.
             * Tắt hiệu lực từ chu kỳ kế (không giết giữa dòng). Khi key k-run
             * tồn tại, AppSetting thắng tuyệt đối — env AGENT_CYCLE_MINUTES chỉ
             * còn là mặc định hậu phương (exists=false). */}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    className="flex h-7 items-center gap-1.5 rounded-md px-1.5"
                    aria-label="Chế độ chạy agent liên tục"
                  >
                    <Switch
                      size="sm"
                      checked={!!kRun?.enabled}
                      disabled={kRunMutation.isPending || !kRun}
                      onCheckedChange={(checked) =>
                        kRunMutation.mutate({
                          action: checked ? "start" : "stop",
                          intervalMinutes: kRun?.intervalMinutes ?? 240,
                        })
                      }
                      aria-label={
                        kRun?.enabled
                          ? "Tắt chế độ chạy agent liên tục"
                          : "Bật chế độ chạy agent liên tục"
                      }
                    />
                    <span className="hidden text-xs font-medium text-muted-foreground md:inline">
                      Liên tục
                    </span>
                    {kRun?.enabled && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            className="rounded px-1 text-xs font-semibold tabular-nums text-primary outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/40"
                            aria-label={`Nhịp chu kỳ hiện tại: mỗi ${kRun.intervalMinutes} phút — bấm để đổi`}
                          >
                            {kRun.intervalMinutes}ph
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-36">
                          <DropdownMenuRadioGroup
                            value={String(kRun.intervalMinutes)}
                            onValueChange={(v) =>
                              kRunMutation.mutate({
                                action: "interval",
                                intervalMinutes: Number(v),
                              })
                            }
                          >
                            {K2_INTERVALS.map((m) => (
                              <DropdownMenuRadioItem key={m} value={String(m)}>
                                {K2_INTERVAL_LABELS[m]} ({m} phút)
                              </DropdownMenuRadioItem>
                            ))}
                          </DropdownMenuRadioGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-72 text-left">
                  <p className="mb-1 text-xs font-semibold">Chế độ chạy liên tục (K2)</p>
                  <ul className="space-y-1 text-[11px] leading-relaxed text-muted-foreground">
                    <li>Bật: chu kỳ 23 agents tự chạy lặp theo nhịp đã chọn.</li>
                    <li>Tắt: dừng từ chu kỳ kế tiếp — không giắt giữa dòng.</li>
                    <li>
                      Đã chạy tích luỹ: {kRun?.cyclesRun ?? 0} chu kỳ
                      {kRun?.enabled && k2Countdown ? ` · kế tiếp ${k2Countdown}` : ""}
                    </li>
                    {!kRun?.exists && (
                      <li className="pt-1 text-amber-600 dark:text-amber-400">
                        Chưa từng bật — nhịp env AGENT_CYCLE_MINUTES đang hiệu lực.
                      </li>
                    )}
                  </ul>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>

          {/* Theme toggle */}
          <Button
            variant="outline"
            size="icon"
            aria-label={mounted && theme === "dark" ? "Chuyển sang giao diện sáng" : "Chuyển sang giao diện tối"}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className="size-9"
          >
            {mounted && theme === "dark" ? (
              <Sun className="size-4" />
            ) : (
              <Moon className="size-4" />
            )}
          </Button>

          {/* Refresh */}
          <Button
            variant="outline"
            size="icon"
            aria-label="Làm mới dữ liệu"
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="size-9"
          >
            <RefreshCw className={cn("size-4", isRefreshing && "animate-spin")} />
          </Button>
        </div>
      </div>
    </header>
  );
}
