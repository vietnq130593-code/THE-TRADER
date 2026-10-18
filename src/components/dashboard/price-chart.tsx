"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Area,
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";
import { ChartCandlestick, ChartLine, ChevronsUpDown } from "lucide-react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { apiGet } from "@/lib/api";
import { useDateRange } from "@/hooks/use-date-range";
import { useUiStore } from "@/lib/store";
import { changeColor, formatPct, formatUnitPrice, formatVndCompact, formatVolume, unitKindOf } from "@/lib/format";
import type { BarPoint, BarsResponse, QuotesResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

const TIMEFRAMES = [30, 60, 90] as const;

// AUDIT 137 D1 — polling fallback khi WebSocket gãy: nhịp làm mới ["quotes"]
// khi realtimeConnected=false (WS market-engine chết); khi WS sống → false.
const QUOTES_FALLBACK_POLL_MS = 30_000;

/**
 * PHASE3_BLUEPRINT §5.1 — RSI Wilder TỪNG PHIÊN (đồ thị chuỗi, không phải chỉ
 * giá trị cuối). Mô phỏng đúng ngữ nghĩa src/lib/indicators.ts `rsi()`:
 * trung bình đơn giản `period` biến động đầu, sau đó làm trơn Wilder;
 * chuỗi phẳng → null (F-118), toàn gain → 100.
 */
function rsiSeries(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d;
    else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  const setVal = (i: number) => {
    if (avgGain === 0 && avgLoss === 0) out[i] = null; // F-118: phẳng
    else if (avgLoss === 0) out[i] = 100;
    else out[i] = 100 - 100 / (1 + avgGain / avgLoss);
  };
  setVal(period);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    setVal(i);
  }
  return out;
}

/** Props recharts truyền cho Bar `shape` (BarShapeProps — dùng trường cần thiết). */
interface CandleShapeProps {
  x: number;
  y: number;
  width: number;
  height: number;
  payload?: BarPoint | null;
}

/**
 * Nến Nhật vẽ thủ công qua Bar shape (PHASE3_BLUEPRINT §5.1):
 * probe Bar dataKey="high" trên trục giá với domain tường minh [lo, hi]
 * → y = pixel(high), height = pixel(lo) − pixel(high) → suy ra mọi mức giá.
 * Màu (phiên #45 — chuẩn tài chính VN): close > open = --up (xanh dương),
 * close < open = --down (đỏ), close = open (doji) = --flat (vàng).
 */
function candleColor(open: number, close: number): string {
  if (close > open) return "var(--up)";
  if (close < open) return "var(--down)";
  return "var(--flat)";
}

function makeCandleShape(lo: number) {
  return function CandleShape(props: CandleShapeProps) {
    const { x, y, width, height, payload } = props;
    const b = payload;
    if (!b || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(height)) return null;
    const range = b.high - lo;
    const ppu = range > 0 ? height / range : 0; // pixel per đơn vị giá
    const yBottom = y + height; // pixel của domain[0]
    const color = candleColor(b.open, b.close);
    const yHigh = y;
    const yLow = yBottom - (b.low - lo) * ppu;
    const yOpen = yBottom - (b.open - lo) * ppu;
    const yClose = yBottom - (b.close - lo) * ppu;
    const bodyW = Math.max(1.5, width * 0.62);
    const bodyTop = Math.min(yOpen, yClose);
    const bodyH = Math.max(1, Math.abs(yClose - yOpen));
    const xc = x + width / 2;
    return (
      <g>
        {/* ràng nến: high → low */}
        <line x1={xc} x2={xc} y1={yHigh} y2={yLow} stroke={color} strokeWidth={1} />
        {/* thân nến: open → close */}
        <rect x={x + (width - bodyW) / 2} y={bodyTop} width={bodyW} height={bodyH} fill={color} />
      </g>
    );
  };
}

export function PriceChart() {
  const symbol = useUiStore((s) => s.selectedSymbol);
  const setSymbol = useUiStore((s) => s.setSelectedSymbol);
  const days = useUiStore((s) => s.chartDays);
  const setDays = useUiStore((s) => s.setChartDays);
  const chartMode = useUiStore((s) => s.chartMode);
  const setChartMode = useUiStore((s) => s.setChartMode);
  // #105 — khoảng thời gian toàn cục: khi trader chọn khoảng trên thanh bar,
  // cửa sổ biểu đồ theo NGUYÊN khoảng (API nâng trần 1.200 nến); tab 30/60/90N
  // tạm khoá để tránh 2 nguồn thật khiên nhau.
  const { dateRange, rangeQuery, rangeKey } = useDateRange();
  // AUDIT 137 D1 — WS chết ⇒ ["quotes"] đóng băng (không interval, focus-refetch
  // tắt) — thanh giá tham chiếu trên biểu đồ đứng im. Polling fallback 30s chỉ
  // khi WS gãy; khi WS sống → false (zero tải thêm).
  const realtimeConnected = useUiStore((s) => s.realtimeConnected);

  const { data: quotesData } = useQuery({
    queryKey: ["quotes"],
    queryFn: () => apiGet<QuotesResponse>("/api/market/quotes"),
    staleTime: 30_000,
    // AUDIT 137 D1 — polling fallback khi WebSocket gãy
    refetchInterval: realtimeConnected ? false : QUOTES_FALLBACK_POLL_MS,
  });

  // F-106-01 (fixbug #106) — đơn vị giá theo loại tài sản của MÃ ĐANG XEM:
  // trước đây biểu đồ formatPrice + " ₫" cứng cho mọi mã → mã phi-VN sai đơn
  // vị (VND=X hiển thị 258.860.000 ₫ thay vì 25.886 · GC=F 415.050 ₫ thay vì
  // $4.150,50 · US10Y "425 ₫" thay vì 4,25%). Tra QuoteRow của mã trong cache
  // quotes dùng chung → UnitKind → formatUnitPrice (một nguồn sự thật).
  const quoteRow = quotesData?.quotes.find((q) => q.symbol === symbol);
  const unitKind = quoteRow
    ? unitKindOf(quoteRow.market, quoteRow.type)
    : ("VND" as const);
  const quoteCurrency = quoteRow?.currency;
  const fmtP = React.useCallback(
    (n: number | null | undefined) => formatUnitPrice(n, unitKind, quoteCurrency),
    [unitKind, quoteCurrency]
  );

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["bars", symbol, dateRange != null ? rangeKey : days],
    queryFn: () =>
      apiGet<BarsResponse>(
        rangeQuery
          ? `/api/instruments/bars?symbol=${encodeURIComponent(symbol)}&${rangeQuery}`
          : `/api/instruments/bars?symbol=${encodeURIComponent(symbol)}&days=${days}`
      ),
    staleTime: 5 * 60_000,
  });

  const bars = React.useMemo(() => data?.bars ?? [], [data]);

  // RSI14 từng phiên (nối vào data cho panel dưới)
  const chartData = React.useMemo(() => {
    const rsis = rsiSeries(bars.map((b) => b.close), 14);
    return bars.map((b, i) => ({ ...b, rsi14: rsis[i] }));
  }, [bars]);

  // Domain giá tường minh (cần cho phép vẽ nến suy ngược pixel)
  const domain = React.useMemo<[number, number]>(() => {
    if (bars.length === 0) return [0, 1] as [number, number];
    const lo = Math.min(...bars.map((b) => b.low));
    const hi = Math.max(...bars.map((b) => b.high));
    const pad = Math.max((hi - lo) * 0.06, hi * 0.004);
    return [Math.max(0, lo - pad), hi + pad] as [number, number];
  }, [bars]);

  // Volume: trục ẩn riêng, nén histogram xuống ~1/4 dưới đáy biểu đồ
  const volMax = React.useMemo(
    () => Math.max(1, ...bars.map((b) => b.volume)),
    [bars]
  );
  const CandleShape = React.useMemo(() => makeCandleShape(domain[0]), [domain]);

  const lastRsi = React.useMemo(() => {
    for (let i = chartData.length - 1; i >= 0; i--) {
      if (chartData[i].rsi14 != null) return chartData[i].rsi14;
    }
    return null;
  }, [chartData]);

  const lastClose = bars.length > 0 ? bars[bars.length - 1].close : null;
  const firstClose = bars.length > 0 ? bars[0].close : null;
  // Phiên #45 — đường/gradient: xanh dương tăng · đỏ giảm · vàng đi ngang
  const trendColor =
    lastClose == null || firstClose == null
      ? "var(--up)"
      : lastClose > firstClose
        ? "var(--up)"
        : lastClose < firstClose
          ? "var(--down)"
          : "var(--flat)";
  const strokeColor = trendColor;
  const gradientId = `priceGrad-${symbol}`;

  const renderTip = React.useCallback(
    (props: TooltipContentProps) => {
      const { active, payload, label } = props;
      if (!active || !payload?.length || typeof label !== "string") return null;
      const bar: BarPoint | undefined = bars.find((b) => b.date === label);
      if (!bar) return null;
      const barUp = bar.close > bar.open;
      const barFlat = bar.close === bar.open;
      return (
        <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-lg">
          <p className="mb-1.5 font-medium">
            {`${label.slice(8, 10)}/${label.slice(5, 7)}/${label.slice(0, 4)}`}
          </p>
          <p className="tabular-nums">
            M: <span className="font-semibold">{fmtP(bar.open)}</span>
            <span
              className={cn(
                "ml-1.5 font-semibold",
                barFlat ? "text-flat" : barUp ? "text-up" : "text-down"
              )}
            >
              ⋯ Đ: {fmtP(bar.close)}
            </span>
          </p>
          <p className="tabular-nums text-muted-foreground">
            Cao: {fmtP(bar.high)} · Thấp: {fmtP(bar.low)}
          </p>
          {bar.sma20 != null && (
            <p className="tabular-nums text-muted-foreground">
              SMA20: {fmtP(bar.sma20)}
            </p>
          )}
          {/* #110 M4.5.3 — đơn vị trung thực: giá trị giao dịch (GT) chỉ
           * hiển thị cho tài sản VND (bars.value quy VND); KL phiên luôn có
           * cho mọi lớp tài sản. Giá mọi nơi đã qua formatUnitPrice
           * (F-106-01 — FX_RATE/điểm index/cents đúng đơn vị). */}
          <p className="tabular-nums text-muted-foreground">
            KL: {formatVolume(bar.volume)}
            {unitKind === "VND" ? ` cp · GT: ${formatVndCompact(bar.value)}` : " phiên"}
          </p>
        </div>
      );
    },
    [bars, fmtP, unitKind]
  );

  const renderRsiTip = React.useCallback(
    (props: TooltipContentProps) => {
      const { active, payload, label } = props;
      if (!active || !payload?.length || typeof label !== "string") return null;
      const row = chartData.find((b) => b.date === label);
      const v = row?.rsi14;
      return (
        <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-lg">
          <p className="mb-1 font-medium">
            {`${label.slice(8, 10)}/${label.slice(5, 7)}/${label.slice(0, 4)}`}
          </p>
          <p className="tabular-nums">
            RSI(14):{" "}
            <span className="font-semibold">
              {v != null ? v.toFixed(1) : "—"}
            </span>
          </p>
        </div>
      );
    },
    [chartData]
  );

  const rsiLabel =
    lastRsi == null ? null : lastRsi >= 70 ? "quá mua" : lastRsi <= 30 ? "quá bán" : null;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-base">
          {data ? (
            <>
              <span className="text-lg font-bold tracking-tight">{data.symbol}</span>
              <span className="tabular-nums font-semibold">{fmtP(data.last)}</span>
              <span
                className={cn("tabular-nums text-sm font-medium", changeColor(data.changePct))}
              >
                {formatPct(data.changePct)}
              </span>
            </>
          ) : (
            <span className="text-lg font-bold tracking-tight">{symbol}</span>
          )}
        </CardTitle>
        <CardDescription className="col-start-1 row-start-2 max-w-[240px] truncate">
          {data?.name ?? "Biểu đồ giá theo phiên"}
        </CardDescription>
        {/* F-451 (cùng bảng giá): card hẹp → cụm chọn mã/nền/trục xuống hàng 3
         * full-width (đặt vị trí tường minh — desc giữ hàng 2 cột 1);
         * card ≥ 48rem (@3xl) → cột phải trải 2 hàng như thiết kế gốc. */}
        <CardAction className="col-span-2 col-start-1 row-start-3 w-full justify-self-stretch @3xl:col-span-1 @3xl:col-start-2 @3xl:row-span-2 @3xl:row-start-1 @3xl:w-auto @3xl:justify-self-end">
          <div className="flex flex-wrap items-end justify-end gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-9 min-w-11 gap-1.5 font-mono">
                {symbol}
                <ChevronsUpDown className="size-3.5 opacity-60" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto custom-scrollbar">
              <DropdownMenuLabel>Chọn mã</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {(quotesData?.quotes ?? []).map((q) => (
                <DropdownMenuItem
                  key={q.symbol}
                  onSelect={() => setSymbol(q.symbol)}
                  className={cn("gap-2", q.symbol === symbol && "bg-accent")}
                >
                  <span className="w-12 font-mono font-medium">{q.symbol}</span>
                  <span className="tabular-nums ml-auto text-xs text-muted-foreground">
                    {formatUnitPrice(q.last, unitKindOf(q.market, q.type), q.currency)}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="flex items-center gap-1.5">
            {/* PHASE3 B3 §5.1 — toggle chế độ Nến/Đường (nhớ trong Zustand) */}
            <Tabs
              value={chartMode}
              onValueChange={(v) => setChartMode(v as "candle" | "line")}
            >
              <TabsList className="h-9">
                <TabsTrigger value="candle" className="gap-1 px-2.5 text-xs" title="Biểu đồ nến Nhật">
                  <ChartCandlestick className="size-3.5" aria-hidden="true" />
                  <span className="hidden sm:inline">Nến</span>
                </TabsTrigger>
                <TabsTrigger value="line" className="gap-1 px-2.5 text-xs" title="Biểu đồ đường">
                  <ChartLine className="size-3.5" aria-hidden="true" />
                  <span className="hidden sm:inline">Đường</span>
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <Tabs
              value={String(days)}
              onValueChange={(v) => setDays(Number(v))}
            >
              <TabsList className="h-9" aria-disabled={dateRange != null}>
                {TIMEFRAMES.map((d) => (
                  <TabsTrigger
                    key={d}
                    value={String(d)}
                    className="px-2.5 text-xs data-[state=active]:data-[disabled]:text-muted-foreground"
                    disabled={dateRange != null}
                    title={
                      dateRange != null
                        ? "Cửa sổ biểu đồ đang theo khoảng thời gian đã chọn trên thanh bar — xoá khoảng để dùng lại tab nhanh"
                        : `${d} phiên giao dịch gần nhất`
                    }
                  >
                    {d}N
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="pb-0">
        <div className="h-64 sm:h-72 xl:h-80">
          {isLoading ? (
            <Skeleton className="h-full w-full" />
          ) : isError ? (
            <div className="flex h-full items-center justify-center text-sm text-down">
              {error?.message ?? "Không tải được biểu đồ."}
            </div>
          ) : bars.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Không có dữ liệu phiên.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={strokeColor} stopOpacity={0.32} />
                    <stop offset="100%" stopColor={strokeColor} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="var(--border)"
                  opacity={0.6}
                />
                <XAxis
                  dataKey="date"
                  tickFormatter={(d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`}
                  minTickGap={40}
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  tickLine={false}
                  axisLine={{ stroke: "var(--border)" }}
                  dy={6}
                />
                {/* Trục giá — domain tường minh để nến suy ngược pixel */}
                <YAxis
                  yAxisId="price"
                  domain={domain}
                  tickFormatter={(v: number) => fmtP(v)}
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  tickLine={false}
                  axisLine={false}
                  width={72}
                />
                {/* Trục khối lượng ẩn — nén histogram xuống đáy */}
                <YAxis yAxisId="vol" domain={[0, volMax * 4]} hide />
                <Tooltip
                  content={renderTip}
                  cursor={{ stroke: "var(--muted-foreground)", strokeDasharray: "4 4", strokeWidth: 1 }}
                />
                {/* Volume histogram — màu theo phiên tăng/giảm/đứng (§5.1 + #45) */}
                <Bar dataKey="volume" yAxisId="vol" isAnimationActive={false} fillOpacity={0.45}>
                  {chartData.map((b, i) => (
                    <Cell key={i} fill={candleColor(b.open, b.close)} />
                  ))}
                </Bar>
                {chartMode === "candle" ? (
                  /* Nến Nhật: probe Bar "high" vẽ wick + thân (§5.1) */
                  <Bar
                    dataKey="high"
                    yAxisId="price"
                    shape={CandleShape}
                    isAnimationActive={false}
                  />
                ) : (
                  <Area
                    type="monotone"
                    dataKey="close"
                    yAxisId="price"
                    name="Giá đóng cửa"
                    stroke={strokeColor}
                    strokeWidth={2}
                    fill={`url(#${gradientId})`}
                    isAnimationActive={false}
                    activeDot={{ r: 3, strokeWidth: 0 }}
                  />
                )}
                <Line
                  type="monotone"
                  dataKey="sma20"
                  yAxisId="price"
                  name="SMA 20"
                  stroke="var(--muted-foreground)"
                  strokeWidth={1.5}
                  strokeDasharray="5 4"
                  dot={false}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* PHASE3 B3 §5.1 — panel RSI14 (~96px): guideline 30/70, vùng quá mua/bán tô amber */}
        {bars.length > 0 && (
          <div className="mt-1">
            <div className="flex items-center justify-between px-1 pb-0.5">
              <p className="text-[11px] font-medium text-muted-foreground">
                RSI (14 phiên · Wilder)
              </p>
              {lastRsi != null && (
                <p
                  className={cn(
                    "tabular-nums text-[11px] font-semibold",
                    rsiLabel ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
                  )}
                >
                  {lastRsi.toFixed(1)}
                  {rsiLabel ? ` — ${rsiLabel}` : ""}
                </p>
              )}
            </div>
            <div className="h-24">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <XAxis dataKey="date" hide />
                  <YAxis
                    domain={[0, 100]}
                    ticks={[30, 50, 70]}
                    tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                    tickLine={false}
                    axisLine={false}
                    width={72}
                  />
                  <Tooltip content={renderRsiTip} cursor={{ stroke: "var(--muted-foreground)", strokeDasharray: "4 4", strokeWidth: 1 }} />
                  {/* vùng quá mua / quá bán */}
                  <ReferenceArea y1={70} y2={100} fill="var(--amber-500)" fillOpacity={0.08} stroke="none" ifOverflow="extendDomain" />
                  <ReferenceArea y1={0} y2={30} fill="var(--amber-500)" fillOpacity={0.08} stroke="none" ifOverflow="extendDomain" />
                  <ReferenceLine y={70} stroke="var(--amber-500)" strokeDasharray="4 3" strokeWidth={1} />
                  <ReferenceLine y={30} stroke="var(--amber-500)" strokeDasharray="4 3" strokeWidth={1} />
                  <Line
                    type="monotone"
                    dataKey="rsi14"
                    stroke="var(--primary)"
                    strokeWidth={1.5}
                    dot={false}
                    connectNulls
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
        <p className="px-1 py-3 text-[11px] text-muted-foreground">
          {data
            ? `${data.days} phiên gần nhất · nến xanh dương = đóng > mở · nến đỏ = đóng < mở · nến vàng = đóng = mở · đường đứt: SMA 20 phiên · khối lượng: màu theo phiên tăng/giảm/đứng`
            : ""}
        </p>
      </CardContent>
    </Card>
  );
}
