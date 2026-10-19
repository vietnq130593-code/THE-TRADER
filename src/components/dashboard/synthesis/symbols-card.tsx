"use client";

// (Task 144 P2-c) — tách từ synthesis-workspace.tsx (pure move)
// Card 4 "Bậc 3 — Cổ phiếu": bảng symbols sắp theo |P(tăng) − P(giảm)| giảm dần
// (z · RSI14 · momentum · dự báo 5p · bằng chứng).

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { changeColor } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { MarketAssessmentView, SymbolAssessment } from "@/lib/types";
import { STANCE } from "./constants";
import { nf1, pct1, pct1s, signed2 } from "./helpers";

/* ─────────────────── 4. Bậc 3 — Cổ phiếu ─────────────────── */

export function SymbolsCard({ assessment }: { assessment: MarketAssessmentView }) {
  // Sort client theo |pUp − pDown| giảm dần (API đã sort, chắc chắn lại).
  const symbols = React.useMemo(
    () =>
      [...(assessment.symbols ?? [])].sort(
        (a, b) => Math.abs(b.pUp - b.pDown) - Math.abs(a.pUp - a.pDown)
      ),
    [assessment.symbols]
  );

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <span className="tabular-nums rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-bold text-muted-foreground">
            Bậc 3
          </span>
          Cổ phiếu
        </CardTitle>
        <CardDescription>
          {symbols.length} mã thanh khoản cao — sắp theo |P(tăng) − P(giảm)| giảm dần
        </CardDescription>
      </CardHeader>
      <CardContent className="pb-0">
        {symbols.length === 0 ? (
          <p className="pb-6 text-sm text-muted-foreground">Không có đánh giá mã nào.</p>
        ) : (
          <div className="max-h-[420px] overflow-y-auto custom-scrollbar">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Mã</TableHead>
                  <TableHead className="text-xs">P(tăng)</TableHead>
                  <TableHead className="text-xs">P(giảm)</TableHead>
                  <TableHead className="text-xs">Stance</TableHead>
                  <TableHead className="hidden text-xs md:table-cell">z</TableHead>
                  <TableHead className="text-xs">RSI14</TableHead>
                  <TableHead className="hidden text-xs md:table-cell">Momentum 5p</TableHead>
                  <TableHead className="hidden text-xs lg:table-cell">Dự báo 5p</TableHead>
                  <TableHead className="hidden text-xs xl:table-cell">Bằng chứng</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {symbols.map((s) => (
                  <SymbolRow key={s.symbol} row={s} />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SymbolRow({ row }: { row: SymbolAssessment }) {
  const stance = STANCE[row.stance] ?? STANCE.HOLD;
  const pUpDominant = row.pUp >= row.pDown;
  const rsiHot = row.rsi14 != null && (row.rsi14 < 30 || row.rsi14 > 70);
  const notes = (row.drivers ?? []).slice(0, 2).join(" · ");

  return (
    <TableRow>
      <TableCell>
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-bold tracking-tight">{row.symbol}</span>
          <span className="max-w-28 truncate text-[11px] text-muted-foreground">
            {row.name}
          </span>
        </div>
      </TableCell>
      <TableCell>
        <Badge
          variant="outline"
          className={cn(
            "tabular-nums text-[11px]",
            pUpDominant ? "border-up/40 text-up" : "text-muted-foreground"
          )}
        >
          {pct1(row.pUp)}
        </Badge>
      </TableCell>
      <TableCell>
        <span
          className={cn(
            "tabular-nums text-xs",
            !pUpDominant ? "font-semibold text-down" : "text-muted-foreground"
          )}
        >
          {pct1(row.pDown)}
        </span>
      </TableCell>
      <TableCell>
        <Badge variant="outline" className={cn("text-[10px]", stance.className)}>
          {stance.label}
        </Badge>
      </TableCell>
      <TableCell className="hidden tabular-nums text-xs md:table-cell">
        {signed2(row.zScore)}
      </TableCell>
      <TableCell
        className={cn(
          "tabular-nums text-xs",
          rsiHot ? "font-semibold text-amber-600 dark:text-amber-400" : "text-muted-foreground"
        )}
      >
        {row.rsi14 != null ? nf1.format(row.rsi14) : "—"}
      </TableCell>
      <TableCell
        className={cn(
          "hidden tabular-nums text-xs md:table-cell",
          changeColor(row.momentum5d)
        )}
      >
        {pct1s(row.momentum5d)}
      </TableCell>
      <TableCell className="hidden text-xs lg:table-cell">
        {row.forecast ? (
          <span className="flex flex-col leading-tight">
            <span className={cn("tabular-nums font-semibold", changeColor(row.forecast.expectedPct))}>
              {pct1s(row.forecast.expectedPct)}
            </span>
            <span className="tabular-nums text-[10px] text-muted-foreground">
              {pct1s(row.forecast.lowPct)} … {pct1s(row.forecast.highPct)}
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="hidden max-w-44 xl:table-cell">
        {notes ? (
          <p className="truncate text-xs text-muted-foreground" title={notes}>
            {notes}
          </p>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
    </TableRow>
  );
}
