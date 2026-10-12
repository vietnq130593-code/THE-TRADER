"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, Star, StarOff, TableProperties } from "lucide-react";
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

export function QuotesTable() {
  const selectedSymbol = useUiStore((s) => s.selectedSymbol);
  const setSelectedSymbol = useUiStore((s) => s.setSelectedSymbol);
  const watchlistOnly = useUiStore((s) => s.watchlistOnly);
  const setWatchlistOnly = useUiStore((s) => s.setWatchlistOnly);
  // PHASE3 B3 §5.2 — toggle cột mở rộng (mặc định tắt, tránh tràn ngang mobile)
  const quotesExpanded = useUiStore((s) => s.quotesExpanded);
  const setQuotesExpanded = useUiStore((s) => s.setQuotesExpanded);

  const quotesQuery = useQuery({
    queryKey: ["quotes"],
    queryFn: () => apiGet<QuotesResponse>("/api/market/quotes"),
    staleTime: 30_000,
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

  const quotes = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return source;
    return source.filter(
      (row) =>
        row.symbol.toLowerCase().includes(q) ||
        row.name.toLowerCase().includes(q) ||
        row.sector.toLowerCase().includes(q)
    );
  }, [source, search]);

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
        label: "Chỉ số (VN-Index · HNX · UPCOM · S&P 500 · HSI)",
        rows: indexes,
      });
    }
    return sections;
  }, [quotes]);

  // B13 — giá theo đơn vị của loại tài sản (VND nguyên · index điểm · cents)
  const fmtP = (n: number | null | undefined, q: QuoteRow) =>
    formatUnitPrice(n, unitKindOf(q.market, q.type), q.currency);
  const fmtSignedUnit = (n: number | null | undefined, q: QuoteRow) => {
    if (n == null || Number.isNaN(n)) return "—";
    const s = formatUnitPrice(Math.abs(n), unitKindOf(q.market, q.type), q.currency);
    return n > 0 ? `+${s}` : n < 0 ? `-${s}` : s;
  };

  const isLoading = watchlistOnly && !watchlistQuery.data ? watchlistQuery.isLoading : quotesQuery.isLoading;
  const isError = watchlistOnly && !watchlistQuery.data ? watchlistQuery.isError : quotesQuery.isError;
  const error = watchlistOnly && !watchlistQuery.data ? watchlistQuery.error : quotesQuery.error;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="text-base">
          {watchlistOnly ? "Danh mục theo dõi" : "Bảng giá đa sàn"}
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
            <div className="max-h-96 overflow-y-auto custom-scrollbar">
              <Table className={cn(quotesExpanded ? "min-w-[900px]" : "min-w-[600px]")}>
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-10 pl-6">
                      <span className="sr-only">Theo dõi</span>
                    </TableHead>
                    <TableHead>Mã</TableHead>
                    <TableHead className="text-right">Giá</TableHead>
                    <TableHead className="text-right">+/-</TableHead>
                    <TableHead className="text-right">%</TableHead>
                    <TableHead className="text-right">KL</TableHead>
                    <TableHead className="pr-6 text-right">Bid/Ask</TableHead>
                    {/* PHASE3 B3 §5.2 — cột mở rộng (chỉ ≥ sm) */}
                    <TableHead className="hidden text-right sm:table-cell">Trần</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">Sàn</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">TC</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">Cao</TableHead>
                    <TableHead className="hidden pr-6 text-right sm:table-cell">Thấp</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {groups.map((g) => (
                    <React.Fragment key={g.key}>
                      {/* B13 — hàng đầu nhóm sàn */}
                      <TableRow className="bg-muted/40 hover:bg-muted/40">
                        <TableCell
                          colSpan={12}
                          className="py-1.5 pl-6 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
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
                      <TableCell className="w-10 py-2.5 pl-6">
                        <Button
                          variant="ghost"
                          size="icon"
                          className={cn(
                            "size-7 text-muted-foreground transition-colors hover:text-amber-500",
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
                      <TableCell className="py-2.5">
                        <p className="font-semibold">{q.symbol}</p>
                        <p className="max-w-[160px] truncate text-[11px] text-muted-foreground">
                          {quotesExpanded
                            ? `TC ${fmtP(q.refPrice, q)} · C ${fmtP(q.high, q)} · T ${fmtP(q.low, q)}`
                            : q.sector || q.name}
                        </p>
                      </TableCell>
                      <TableCell className="tabular-nums py-2.5 text-right font-medium">
                        {/* Phiên #45 — giá tô màu theo hướng so tham chiếu:
                         * tăng xanh dương · giảm đỏ · đứng giá vàng (chuẩn bảng giá VN).
                         * Q2 HOSE: chạm trần ⌃ / chạm sàn ⌄ đậm hơn. */}
                        {q.ceilingPrice != null && q.last >= q.ceilingPrice ? (
                          <span className="font-bold text-up">
                            ⌃ {fmtP(q.last, q)}
                          </span>
                        ) : q.floorPrice != null && q.last <= q.floorPrice ? (
                          <span className="font-bold text-down">
                            ⌄ {fmtP(q.last, q)}
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
                            {fmtP(q.last, q)}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className={`tabular-nums py-2.5 text-right ${changeColor(q.change)}`}>
                        {fmtSignedUnit(q.change, q)}
                      </TableCell>
                      <TableCell
                        className={`tabular-nums py-2.5 text-right font-medium ${changeColor(q.changePct)}`}
                      >
                        {formatPct(q.changePct)}
                      </TableCell>
                      <TableCell className="tabular-nums py-2.5 text-right text-muted-foreground">
                        {formatVolume(q.volume)}
                      </TableCell>
                      <TableCell className="tabular-nums py-2.5 pr-6 text-right text-xs">
                        <span className="text-up">{fmtP(q.bidPrice, q)}</span>
                        <span className="text-muted-foreground"> / </span>
                        <span className="text-down">{fmtP(q.askPrice, q)}</span>
                      </TableCell>
                      {/* Cột trần/sàn: trần = xanh dương · sàn = đỏ (phiên #45) */}
                      <TableCell className="hidden tabular-nums py-2.5 text-right font-semibold text-up sm:table-cell">
                        {fmtP(q.ceilingPrice, q)}
                      </TableCell>
                      <TableCell className="hidden tabular-nums py-2.5 text-right font-semibold text-down sm:table-cell">
                        {fmtP(q.floorPrice, q)}
                      </TableCell>
                      <TableCell className="hidden tabular-nums py-2.5 text-right text-muted-foreground sm:table-cell">
                        {fmtP(q.refPrice, q)}
                      </TableCell>
                      <TableCell className="hidden tabular-nums py-2.5 text-right sm:table-cell">
                        {fmtP(q.high, q)}
                      </TableCell>
                      <TableCell className="hidden tabular-nums py-2.5 pr-6 text-right sm:table-cell">
                        {fmtP(q.low, q)}
                      </TableCell>
                    </TableRow>
                      ))}
                    </React.Fragment>
                  ))}
                  {quotes.length === 0 && (
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
            <p className="px-6 py-3 text-[11px] text-muted-foreground">
              Hiển thị {quotes.length}/{totalCount} mã · nhóm theo sàn (HOSE · HNX · UPCOM · US · HK · Chỉ số)
              {watchlistOnly ? " · danh mục theo dõi" : ""}
              {quotesExpanded ? " · cột mở rộng: trần/sàn/TC/cao/thấp" : ""}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
