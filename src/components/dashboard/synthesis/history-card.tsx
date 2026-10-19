"use client";

// (Task 144 P2-c) — tách từ synthesis-workspace.tsx (pure move)
// Card 6 "Lịch sử nhận định": mini LineChart P(tăng) theo thời gian (recharts)
// + danh sách 5 bản gần nhất.

import * as React from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";
import { History } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { DIRECTION } from "./constants";
import { nf1, pct1 } from "./helpers";
import type { HistoryRow } from "./types";

/* ─────────────────── 6. Lịch sử ─────────────────── */

interface ChartRow {
  label: string;
  pUp: number;
  lastDot: number | null;
}

export function HistoryCard({
  rows,
  recent,
}: {
  rows: HistoryRow[];
  recent: HistoryRow[];
}) {
  // Chuẩn hoá cho recharts: nhãn thời gian + dot cuối chuỗi.
  const chartData = React.useMemo<ChartRow[]>(
    () =>
      rows.map((r, i) => ({
        label: formatDateTime(r.createdAt),
        pUp: r.pUp * 100,
        lastDot: i === rows.length - 1 ? r.pUp * 100 : null,
      })),
    [rows]
  );

  const renderTip = React.useCallback((props: TooltipContentProps) => {
    const { active, payload } = props;
    if (!active || !payload?.length) return null;
    const row = payload[0]?.payload as ChartRow | undefined;
    const source = rows.find((r) => formatDateTime(r.createdAt) === row?.label);
    if (!row || !source) return null;
    return (
      <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-lg">
        <p className="mb-1 font-medium">{row.label}</p>
        <p className="tabular-nums">
          P(tăng): <span className="font-semibold">{pct1(source.pUp)}</span>
        </p>
        <p className="tabular-nums text-muted-foreground">
          P(đi ngang): {pct1(source.pFlat)} · P(giảm): {pct1(source.pDown)}
        </p>
      </div>
    );
  }, [rows]);

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="size-4 text-muted-foreground" aria-hidden="true" />
          Lịch sử nhận định
        </CardTitle>
        <CardDescription>
          P(tăng) theo thời gian · {rows.length} bản gần nhất
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 lg:flex-row lg:items-start">
        {/* Mini LineChart pUp */}
        <div className="h-40 flex-1 lg:min-w-0">
          {chartData.length >= 2 ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="var(--border)"
                  opacity={0.6}
                />
                <XAxis
                  dataKey="label"
                  minTickGap={48}
                  tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                  tickLine={false}
                  axisLine={{ stroke: "var(--border)" }}
                  dy={6}
                />
                <YAxis
                  domain={[0, 100]}
                  ticks={[0, 25, 50, 75, 100]}
                  tickFormatter={(v: number) => `${nf1.format(v * 100)}%`}
                  tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                  tickLine={false}
                  axisLine={false}
                  width={44}
                />
                <Tooltip
                  content={renderTip}
                  cursor={{ stroke: "var(--muted-foreground)", strokeDasharray: "4 4", strokeWidth: 1 }}
                />
                <Line
                  type="monotone"
                  dataKey="pUp"
                  name="P(tăng)"
                  stroke="var(--foreground)"
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                />
                {/* Dot cuối chuỗi */}
                <Line
                  type="monotone"
                  dataKey="lastDot"
                  stroke="var(--up)"
                  strokeWidth={2}
                  dot={{ r: 3, fill: "var(--up)", strokeWidth: 0 }}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Cần ít nhất 2 bản tổng hợp để vẽ biểu đồ.
            </div>
          )}
        </div>

        <Separator className="lg:hidden" />

        {/* 5 bản gần nhất */}
        <ul className="flex w-full flex-col divide-y rounded-lg border lg:max-w-72">
          {recent.map((r) => {
            const dir = DIRECTION[r.marketDirection] ?? DIRECTION.NEUTRAL;
            return (
              <li key={r.createdAt} className="flex min-h-11 items-center gap-2 px-3 py-1.5">
                <span className="tabular-nums text-xs text-muted-foreground">
                  {formatDateTime(r.createdAt)}
                </span>
                <Badge variant="outline" className={cn("ml-auto text-[10px]", dir.className)}>
                  {dir.label}
                </Badge>
                <span className="tabular-nums text-xs font-semibold">{pct1(r.pUp)}</span>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
