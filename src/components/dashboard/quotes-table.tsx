"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Filter,
  Landmark,
  Microscope,
  Search,
  Star,
  StarOff,
  TableProperties,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/dashboard/kit";
import { basketLabel, marketsOfBasket } from "@/components/dashboard/market/basket-filter";
import { apiGet, apiPostJson } from "@/lib/api";
import { useUiStore } from "@/lib/store";
import {
  changeColor,
  formatPct,
  formatUnitPrice,
  formatVolume,
  unitKindOf,
} from "@/lib/format";
import type { QuoteRow, QuotesResponse, WatchlistResponse, WatchlistToggleResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

// AUDIT 137 D1 — polling fallback khi WebSocket gãy: nhịp làm mới ["quotes"]
// khi realtimeConnected=false (WS market-engine chết). 30s = đủ mượt cho bảng
// giá tham chiếu mà không đập /api/market/quotes; khi WS sống → false (tắt).
const QUOTES_FALLBACK_POLL_MS = 30_000;

/**
 * #110 M4.5.2 — props mới (optional, không phá cách dùng cũ):
 * bảng giá nhận rổ đang lọc từ card Đa rổ (state cục bộ market-workspace).
 */
export interface QuotesTableProps {
  /** Rổ đang lọc (BasketStatView.key · null = tất cả nhóm). */
  basketFilter?: string | null;
  /** Bỏ lọc rổ — chip "Đang lọc: … ✕" trên bảng giá. */
  onClearBasketFilter?: () => void;
}

/**
 * #110-g (P4 M4.10) — giá/± tách đuôi đơn vị FX (" VND" · " EUR" · " JPY"…) thành
 * span ẩn <md: hàng tỷ giá VND=X "25.889,00 VND" (cột 113px) + "−86,0000 VND"
 * (cột 103px) là nguyên nhân chính khiến bảng giá dãn 466px > vùng thẻ ~356px
 * trên mobile — đơn vị đã ngầm hiểu qua mã (VND=X · EURUSD=X). Desktop ≥md giữ
 * nguyên chuỗi đầy đủ (span hiện lại); các ô chỉ hiện ≥md (Bid/Ask, cột mở rộng,
 * dòng phụ TC·C·T) vẫn dùng fmtP nguyên chuỗi như cũ.
 */
const FX_UNIT_SUFFIX_RE = /^(.*\S)(\s[A-Z]{2,5})$/;

function UnitPrice({
  n,
  q,
  signed = false,
}: {
  n: number | null | undefined;
  q: QuoteRow;
  signed?: boolean;
}) {
  if (n == null || Number.isNaN(n)) return <>—</>;
  const s = formatUnitPrice(Math.abs(n), unitKindOf(q.market, q.type), q.currency);
  const m = FX_UNIT_SUFFIX_RE.exec(s);
  const main = m ? m[1] : s;
  const suffix = m ? m[2] : null;
  const withSign = signed ? (n > 0 ? `+${main}` : n < 0 ? `-${main}` : main) : main;
  return (
    <>
      {withSign}
      {suffix && <span className="hidden md:inline">{suffix}</span>}
    </>
  );
}


export function QuotesTable({
  basketFilter = null,
  onClearBasketFilter,
}: QuotesTableProps) {
  const selectedSymbol = useUiStore((s) => s.selectedSymbol);
  const setSelectedSymbol = useUiStore((s) => s.setSelectedSymbol);
  const watchlistOnly = useUiStore((s) => s.watchlistOnly);
  const setWatchlistOnly = useUiStore((s) => s.setWatchlistOnly);
  // PHASE3 B3 §5.2 — toggle cột mở rộng (mặc định tắt, tránh tràn ngang mobile)
  const quotesExpanded = useUiStore((s) => s.quotesExpanded);
  const setQuotesExpanded = useUiStore((s) => s.setQuotesExpanded);
  // #110 M4.5.2 — EmptyState rổ tham chiếu: nút dẫn sang module Hội đồng
  const setActiveWorkspace = useUiStore((s) => s.setActiveWorkspace);
  // AUDIT 137 D1 — WS chết ⇒ ["quotes"] không interval + focus-refetch tắt →
  // bảng giá đóng băng vĩnh viễn. Polling fallback 30s CHỈ khi WS gãy
  // (realtimeConnected=false) — zero tải thêm khi WS khỏe.
  const realtimeConnected = useUiStore((s) => s.realtimeConnected);

  const quotesQuery = useQuery({
    queryKey: ["quotes"],
    queryFn: () => apiGet<QuotesResponse>("/api/market/quotes"),
    staleTime: 30_000,
    // AUDIT 137 D1 — polling fallback khi WebSocket gãy
    refetchInterval: realtimeConnected ? false : QUOTES_FALLBACK_POLL_MS,
  });
  const watchlistQuery = useQuery({
    queryKey: ["watchlist"],
    queryFn: () => apiGet<WatchlistResponse>("/api/market/watchlist"),
    staleTime: 30_000,
    // Luôn bật để biết mã nào đang có sao (kể cả khi không ở chế độ theo dõi)
  });

  // Danh sách mã đang theo dõi (để tô sao)
  const watchedSymbols = React.useMemo(
    () => new Set(watchlistQuery.data?.watchlist.quotes.map((q) => q.symbol) ?? []),
    [watchlistQuery.data]
  );

  const queryClient = useQueryClient();
  const toggleWatch = useMutation({
    mutationFn: (symbol: string) =>
      apiPostJson<WatchlistToggleResponse>("/api/watchlist/toggle", { symbol }),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ["watchlist"] });
      void queryClient.invalidateQueries({ queryKey: ["system-status"] });
      toast.success(
        res.inWatchlist
          ? `Đã thêm ${res.symbol} vào danh mục theo dõi (${res.count} mã)`
          : `Đã gỡ ${res.symbol} khỏi danh mục theo dõi (${res.count} mã)`
      );
    },
    onError: (err: Error) => {
      toast.error("Không cập nhật được danh mục theo dõi", {
        description: err.message,
      });
    },
  });

  const [search, setSearch] = React.useState("");

  const source: QuoteRow[] = React.useMemo(
    () =>
      watchlistOnly
        ? (watchlistQuery.data?.watchlist.quotes ?? [])
        : (quotesQuery.data?.quotes ?? []),
    [watchlistOnly, watchlistQuery.data, quotesQuery.data]
  );
  const totalCount = watchlistOnly
    ? (watchlistQuery.data?.watchlist.count ?? 0)
    : (quotesQuery.data?.quotes.length ?? 0);

  // #110 M4.5.2 — lọc theo rổ thị trường (mapping basket-filter.ts):
  // nhóm "Chỉ số" LUÔN giữ nguyên hiển thị (dùng cho tham chiếu);
  // hiệu chỉnh v1.2 (#108) — rổ phi-VN là tham chiếu nghiên cứu, không phải
  // kênh đầu tư.
  const basketFiltered: QuoteRow[] = React.useMemo(() => {
    if (basketFilter == null) return source;
    const markets = marketsOfBasket(basketFilter);
    return source.filter(
      (q) => q.type === "INDEX" || markets.includes(q.market)
    );
  }, [source, basketFilter]);

  // Rổ không còn hàng giá trực tiếp (BOND/FOREX/COMMODITY chưa đồng bộ hoặc
  // rổ lạ) → EmptyState hướng dẫn sang module Hội đồng.
  const basketEmpty =
    basketFilter != null &&
    basketFiltered.every((q) => q.type === "INDEX");

  const quotes = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return basketFiltered;
    return basketFiltered.filter(
      (row) =>
        row.symbol.toLowerCase().includes(q) ||
        row.name.toLowerCase().includes(q) ||
        row.sector.toLowerCase().includes(q)
    );
  }, [basketFiltered, search]);

  // B13 — group bảng giá theo SÀN (HOSE → HNX → UPCOM → US → HK) + nhóm Chỉ số
  // riêng (index VN + quốc tế); mỗi nhóm giữ thứ tự khối lượng của nguồn.
  // #106 — thêm 3 nhóm lớp tài sản mới: BOND (trái phiếu) · FOREX (ngoại hối)
  // · COMMODITY (hàng hoá) — cùng pattern section, đơn vị qua UnitKind.
  const groups = React.useMemo(() => {
    const marketOrder = [
      "HOSE",
      "HNX",
      "UPCOM",
      "US",
      "HK",
      "BOND",
      "FOREX",
      "COMMODITY",
    ] as const;
    const marketLabels: Record<string, string> = {
      HOSE: "HOSE — Sàn TP.HCM",
      HNX: "HNX — Sàn Hà Nội",
      UPCOM: "UPCOM — Niêm yết OTC",
      US: "Mỹ (US)",
      HK: "Hồng Kông (HK)",
      BOND: "Trái phiếu (Treasury Mỹ — % lợi suất)",
      FOREX: "Ngoại hối (cặp USD)",
      COMMODITY: "Hàng hoá (vàng · dầu · kim loại)",
    };
    const sections: { key: string; label: string; rows: QuoteRow[] }[] = [];
    for (const m of marketOrder) {
      const rows = quotes.filter((q) => q.market === m && q.type !== "INDEX");
      if (rows.length > 0) {
        sections.push({ key: m, label: marketLabels[m] ?? m, rows });
      }
    }
    const indexes = quotes.filter((q) => q.type === "INDEX");
    if (indexes.length > 0) {
      sections.push({
        key: "INDEX",
        label: "Chỉ số (S&P 500 · Nasdaq · HSI)",
        rows: indexes,
      });
    }
    return sections;
  }, [quotes]);

  // B13 — giá theo đơn vị của loại tài sản (VND nguyên · index điểm · cents)
  const fmtP = (n: number | null | undefined, q: QuoteRow) =>
    formatUnitPrice(n, unitKindOf(q.market, q.type), q.currency);

  const isLoading = watchlistOnly && !watchlistQuery.data ? watchlistQuery.isLoading : quotesQuery.isLoading;
  const isError = watchlistOnly && !watchlistQuery.data ? watchlistQuery.isError : quotesQuery.isError;
  const error = watchlistOnly && !watchlistQuery.data ? watchlistQuery.error : quotesQuery.error;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="text-base">
          {watchlistOnly
            ? "Danh mục theo dõi"
            : basketFilter != null
              ? `Bảng giá · rổ ${basketLabel(basketFilter)}`
              : "Bảng giá đa sàn"}
        </CardTitle>
        <CardDescription className="col-start-1 row-start-2">
          Nhấp vào một mã để xem biểu đồ giá
        </CardDescription>
        {/* F-451 (VLM browser-verify): card bảng giá nằm cột hẹp ~540px trong grid
         * xl:grid-cols-5 — cụm search + 2 switch chiếm 445px khiến grid ép
         * tiêu đề về min-content 40px (chữ xếp dọc từng từ). Vá bằng container
         * query + đặt vị trí tường minh (desc phải ở hàng 2 cột 1, nếu không
         * auto-placement sẽ đẩy desc lên cột 2 cạnh tiêu đề): card hẹp → cụm
         * điều khiển xuống HÀNG 3 full-width; card ≥ 48rem (@3xl) → trở về
         * cột phải trải 2 hàng như thiết kế gốc. */}
        <CardAction className="col-span-2 col-start-1 row-start-3 w-full justify-self-stretch @3xl:col-span-1 @3xl:col-start-2 @3xl:row-span-2 @3xl:row-start-1 @3xl:w-auto @3xl:justify-self-end">
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
            {/* PHASE3 B3 §5.2 — cột mở rộng: Trần/Sàn/TC/Cao/Thấp */}
            <div
              className="flex items-center gap-2"
              title="Thêm cột Trần · Sàn · Tham chiếu · Cao · Thấp (chỉ hiển thị từ màn hình sm trở lên)"
            >
              <Switch
                id="quotes-expanded"
                checked={quotesExpanded}
                onCheckedChange={setQuotesExpanded}
                aria-label="Bật cột mở rộng (trần, sàn, tham chiếu, cao, thấp)"
              />
              <Label
                htmlFor="quotes-expanded"
                className="hidden cursor-pointer items-center gap-1 text-xs text-muted-foreground md:flex"
              >
                <TableProperties className="size-3.5" aria-hidden="true" />
                Cột mở rộng
              </Label>
            </div>
            <div
              className="flex items-center gap-2"
              title="Chỉ hiển thị các mã trong danh mục theo dõi mặc định"
            >
              <Switch
                id="watchlist-mode"
                checked={watchlistOnly}
                onCheckedChange={setWatchlistOnly}
                aria-label="Chỉ hiển thị danh mục theo dõi"
              />
              <Label
                htmlFor="watchlist-mode"
                className="hidden cursor-pointer items-center gap-1 text-xs text-muted-foreground sm:flex"
              >
                <Star className="size-3.5" aria-hidden="true" />
                Theo dõi
              </Label>
            </div>
            <div className="relative">
              <Search
                className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                type="search"
                inputMode="search"
                placeholder="Tìm mã / tên / ngành…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-9 w-36 pl-8 text-sm sm:w-48"
                aria-label="Tìm kiếm mã cổ phiếu, tên công ty hoặc ngành"
              />
            </div>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {isLoading ? (
          <div className="flex flex-col gap-2 px-6 pb-6">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : isError ? (
          <p className="px-6 pb-6 text-sm text-down">
            {error?.message ?? "Không tải được bảng giá."}
          </p>
        ) : (
          <>
            {/* #110 M4.5.2 — chip "Đang lọc: … ✕" (bấm ≥ 44px) bỏ lọc rổ */}
            {basketFilter != null && (
              <div className="flex flex-wrap items-center gap-2 px-4 pb-3 md:px-6">
                <Button
                  id="quotes-basket-filter"
                  variant="secondary"
                  size="sm"
                  onClick={onClearBasketFilter}
                  className="h-11 min-w-11 gap-2 rounded-full px-4"
                  aria-label={`Bỏ lọc rổ ${basketLabel(basketFilter)} — về tất cả nhóm`}
                >
                  <Filter className="size-3.5 text-primary" aria-hidden="true" />
                  <span className="text-xs font-medium">
                    Đang lọc: {basketLabel(basketFilter)}
                  </span>
                  <X className="size-4 text-muted-foreground" aria-hidden="true" />
                </Button>
              </div>
            )}

            {/* #110 M4.5.2 — rổ chưa có bảng giá trực tiếp (BOND/FOREX/
             * COMMODITY chưa đồng bộ): EmptyState hướng dẫn sang Hội đồng.
             * Hiệu chỉnh v1.2 (#108): rổ phi-VN là THAM CHIẾU nghiên cứu.
             * F-1113-02 (fixbug #111): chế độ watchlistOnly tính basketEmpty
             * trên `source` ĐÃ lọc theo danh mục theo dõi — bảng đa sàn có thể
             * CÓ hàng của lớp này; phải nói đúng phạm vi thiếu (danh mục theo
             * dõi) thay vì khẳng định "bảng giá đa sàn không có". */}
            {basketEmpty ? (
              <div className="px-4 pb-4 md:px-6">
                <EmptyState
                  icon={Microscope}
                  title="Rổ này hiện chỉ theo dõi trong nghiên cứu Hội đồng — chưa có bảng giá trực tiếp"
                  description={
                    <>
                      {watchlistOnly ? (
                        <p>
                          Danh mục theo dõi của bạn chưa có mã thuộc lớp tài sản
                          này — tắt chế độ “chỉ danh mục theo dõi” phía trên để
                          xem bảng giá đa sàn đầy đủ.
                        </p>
                      ) : (
                        <p>
                          Chưa có hàng giá nào cho lớp tài sản này trong bảng giá
                          đa sàn. Thống kê rổ (lợi suất · biến động 30 phiên) nằm
                          trong module Hội đồng — theo dõi tham chiếu nghiên cứu,
                          không phải đối tượng đầu tư theo chính sách VN-only.
                        </p>
                      )}
                    </>
                  }
                  action={
                    <Button
                      size="sm"
                      className="h-11 gap-2"
                      onClick={() => setActiveWorkspace("council")}
                    >
                      <Landmark className="size-4" aria-hidden="true" />
                      Xem Hội đồng
                    </Button>
                  }
                />
              </div>
            ) : null}

            {/* Bảng giá — ẩn hẳn khi rổ trống và không còn nhóm Chỉ số nào */}
            {(!basketEmpty || groups.length > 0) && (
              <div className="max-h-96 overflow-y-auto custom-scrollbar md:overflow-x-auto">
                {/* #110 M4.5.2 — chế độ "giọn": mobile <md chỉ 6 cột chính
                 * (Sao · Mã · Giá · +/- · % · KL khớp), cột phụ Bid/Ask hiện
                 * từ md; cột mở rộng chỉ khi bật toggle (≥ md). min-w CHỈ áp
                 * md+ — mobile không bảng dãn > màn hình (sw===cw 390). */}
                <Table className={cn(quotesExpanded ? "md:min-w-[900px]" : undefined)}>
                  <TableHeader className="sticky top-0 z-10 bg-card">
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-11 pl-2 md:w-10 md:pl-6">
                        <span className="sr-only">Theo dõi</span>
                      </TableHead>
                      <TableHead className="px-1.5 sm:px-2">Mã</TableHead>
                      <TableHead className="px-1.5 text-right sm:px-2">Giá</TableHead>
                      <TableHead className="px-1.5 text-right sm:px-2">+/-</TableHead>
                      <TableHead className="px-1.5 text-right sm:px-2">%</TableHead>
                      <TableHead className="px-1.5 text-right sm:px-2">KL</TableHead>
                      <TableHead className="hidden px-1.5 text-right sm:px-2 md:table-cell md:pr-6">Bid/Ask</TableHead>
                      {/* PHASE3 B3 §5.2 — cột mở rộng (chỉ ≥ md khi bật toggle) */}
                      <TableHead className={cn(quotesExpanded ? "hidden px-1.5 text-right sm:px-2 md:table-cell" : "hidden")}>Trần</TableHead>
                      <TableHead className={cn(quotesExpanded ? "hidden px-1.5 text-right sm:px-2 md:table-cell" : "hidden")}>Sàn</TableHead>
                      <TableHead className={cn(quotesExpanded ? "hidden px-1.5 text-right sm:px-2 md:table-cell" : "hidden")}>TC</TableHead>
                      <TableHead className={cn(quotesExpanded ? "hidden px-1.5 text-right sm:px-2 md:table-cell" : "hidden")}>Cao</TableHead>
                      <TableHead className={cn(quotesExpanded ? "hidden px-1.5 text-right sm:px-2 md:table-cell md:pr-6" : "hidden")}>Thấp</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {groups.map((g) => (
                      <React.Fragment key={g.key}>
                        {/* B13 — hàng đầu nhóm sàn */}
                        <TableRow className="bg-muted/40 hover:bg-muted/40">
                          <TableCell
                            colSpan={12}
                            className="py-1.5 pl-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground md:pl-6"
                          >
                            {g.label} · {g.rows.length} mã
                          </TableCell>
                        </TableRow>
                        {g.rows.map((q) => (
                    <TableRow
                      key={q.symbol}
                      onClick={() => setSelectedSymbol(q.symbol)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelectedSymbol(q.symbol);
                        }
                      }}
                      tabIndex={0}
                      role="button"
                      aria-label={`Chọn ${q.symbol}`}
                      className={cn(
                        "min-h-11 cursor-pointer transition-colors outline-none focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40",
                        q.symbol === selectedSymbol ? "bg-accent" : "hover:bg-accent/50"
                      )}
                    >
                      <TableCell className="w-11 py-0 pl-2 pr-0 md:w-10 md:py-2.5 md:pl-6">
                        <Button
                          variant="ghost"
                          size="icon"
                          className={cn(
                            "size-9 text-muted-foreground transition-colors hover:text-amber-500 md:size-7",
                            watchedSymbols.has(q.symbol) && "text-amber-500"
                          )}
                          aria-label={
                            watchedSymbols.has(q.symbol)
                              ? `Gỡ ${q.symbol} khỏi danh mục theo dõi`
                              : `Thêm ${q.symbol} vào danh mục theo dõi`
                          }
                          aria-pressed={watchedSymbols.has(q.symbol)}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleWatch.mutate(q.symbol);
                          }}
                        >
                          {watchedSymbols.has(q.symbol) ? (
                            <Star className="size-4 fill-current" aria-hidden="true" />
                          ) : (
                            <StarOff className="size-4" aria-hidden="true" />
                          )}
                        </Button>
                      </TableCell>
                      <TableCell className="px-1.5 py-2.5 sm:px-2">
                        <p className="font-semibold">{q.symbol}</p>
                        {/* Giọn mobile: dòng tên/ngành ẩn < sm cho gọn 6 cột */}
                        <p className="mt-0.5 hidden max-w-[160px] truncate text-[11px] text-muted-foreground sm:block">
                          {quotesExpanded
                            ? `TC ${fmtP(q.refPrice, q)} · C ${fmtP(q.high, q)} · T ${fmtP(q.low, q)}`
                            : q.sector || q.name}
                        </p>
                      </TableCell>
                      <TableCell className="px-1.5 py-2.5 text-right font-medium tabular-nums sm:px-2">
                        {/* Phiên #45 — giá tô màu theo hướng so tham chiếu:
                         * tăng xanh dương · giảm đỏ · đứng giá vàng (chuẩn bảng giá VN).
                         * Q2 HOSE: chạm trần ⌃ / chạm sàn ⌄ đậm hơn. */}
                        {q.ceilingPrice != null && q.last >= q.ceilingPrice ? (
                          <span className="font-bold text-up">
                            ⌃ <UnitPrice n={q.last} q={q} />
                          </span>
                        ) : q.floorPrice != null && q.last <= q.floorPrice ? (
                          <span className="font-bold text-down">
                            ⌄ <UnitPrice n={q.last} q={q} />
                          </span>
                        ) : (
                          <span
                            className={cn(
                              "font-semibold",
                              q.change > 0
                                ? "text-up"
                                : q.change < 0
                                  ? "text-down"
                                  : "text-flat"
                            )}
                          >
                            <UnitPrice n={q.last} q={q} />
                          </span>
                        )}
                      </TableCell>
                      <TableCell className={`px-1.5 py-2.5 text-right tabular-nums sm:px-2 ${changeColor(q.change)}`}>
                        <UnitPrice n={q.change} q={q} signed />
                      </TableCell>
                      <TableCell
                        className={`px-1.5 py-2.5 text-right font-medium tabular-nums sm:px-2 ${changeColor(q.changePct)}`}
                      >
                        {formatPct(q.changePct)}
                      </TableCell>
                      <TableCell className="px-1.5 py-2.5 text-right tabular-nums text-muted-foreground sm:px-2">
                        {formatVolume(q.volume)}
                      </TableCell>
                      <TableCell className="hidden px-1.5 py-2.5 text-right tabular-nums text-xs sm:px-2 md:table-cell md:pr-6">
                        <span className="text-up">{fmtP(q.bidPrice, q)}</span>
                        <span className="text-muted-foreground"> / </span>
                        <span className="text-down">{fmtP(q.askPrice, q)}</span>
                      </TableCell>
                      {/* Cột trần/sàn: trần = xanh dương · sàn = đỏ (phiên #45) */}
                      <TableCell className={cn(quotesExpanded ? "hidden px-1.5 py-2.5 text-right font-semibold tabular-nums text-up sm:px-2 md:table-cell" : "hidden")}>
                        {fmtP(q.ceilingPrice, q)}
                      </TableCell>
                      <TableCell className={cn(quotesExpanded ? "hidden px-1.5 py-2.5 text-right font-semibold tabular-nums text-down sm:px-2 md:table-cell" : "hidden")}>
                        {fmtP(q.floorPrice, q)}
                      </TableCell>
                      <TableCell className={cn(quotesExpanded ? "hidden px-1.5 py-2.5 text-right tabular-nums text-muted-foreground sm:px-2 md:table-cell" : "hidden")}>
                        {fmtP(q.refPrice, q)}
                      </TableCell>
                      <TableCell className={cn(quotesExpanded ? "hidden px-1.5 py-2.5 text-right tabular-nums sm:px-2 md:table-cell" : "hidden")}>
                        {fmtP(q.high, q)}
                      </TableCell>
                      <TableCell className={cn(quotesExpanded ? "hidden px-1.5 py-2.5 text-right tabular-nums sm:px-2 md:table-cell md:pr-6" : "hidden")}>
                        {fmtP(q.low, q)}
                      </TableCell>
                    </TableRow>
                      ))}
                    </React.Fragment>
                  ))}
                  {quotes.length === 0 && !basketEmpty && (
                    <TableRow>
                      <TableCell
                        colSpan={12}
                        className="py-8 text-center text-sm text-muted-foreground"
                      >
                        Không tìm thấy mã phù hợp.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
              </div>
            )}
            <p className="px-4 py-3 text-[11px] text-muted-foreground md:px-6">
              {basketEmpty
                ? groups.length > 0
                  ? `Nhóm "Chỉ số" giữ nguyên hiển thị để tham chiếu · rổ ${basketLabel(basketFilter)} chưa có hàng giá trực tiếp.`
                  : ""
                : <>
                  Hiển thị {quotes.length}/{totalCount} mã · nhóm theo sàn &amp; lớp tài sản (HOSE · HNX · UPCOM · US · HK · Trái phiếu · Forex · Hàng hoá · Chỉ số)
                  {watchlistOnly ? " · danh mục theo dõi" : ""}
                  {basketFilter != null ? ` · lọc theo rổ: ${basketLabel(basketFilter)}` : ""}
                  {quotesExpanded ? " · cột mở rộng: trần/sàn/TC/cao/thấp" : ""}
                </>}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
