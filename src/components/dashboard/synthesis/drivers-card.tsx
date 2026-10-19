"use client";

// (Task 144 P2-c) — tách từ synthesis-workspace.tsx (pure move)
// Card 5 "Bằng chứng & mức đóng góp": bảng drivers Bayes sắp theo |Δ log-odds|
// giảm dần + thanh bar đóng góp quy đổi theo driver mạnh nhất.

import * as React from "react";
import { Sigma } from "lucide-react";
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
import type { BayesDriver, MarketAssessmentView } from "@/lib/types";
import { DRIVER_DIRECTION } from "./constants";
import { nf2, pct1, signed2 } from "./helpers";

/* ─────────────────── 5. Bằng chứng & mức đóng góp ─────────────────── */

export function DriversCard({ assessment }: { assessment: MarketAssessmentView }) {
  const drivers = React.useMemo(
    () =>
      [...(assessment.drivers ?? [])].sort(
        (a, b) => Math.abs(b.deltaLogOdds) - Math.abs(a.deltaLogOdds)
      ),
    [assessment.drivers]
  );
  const maxAbsDelta = React.useMemo(
    () => Math.max(0.000001, ...drivers.map((d) => Math.abs(d.deltaLogOdds))),
    [drivers]
  );

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sigma className="size-4 text-muted-foreground" aria-hidden="true" />
          Bằng chứng &amp; mức đóng góp
        </CardTitle>
        <CardDescription>
          {drivers.length} bằng chứng — sắp theo |Δ log-odds| giảm dần (driver
          mạnh nhất đứng đầu)
        </CardDescription>
      </CardHeader>
      <CardContent className="pb-0">
        {drivers.length === 0 ? (
          <p className="pb-6 text-sm text-muted-foreground">Không có bằng chứng nào.</p>
        ) : (
          <div className="max-h-[360px] overflow-y-auto custom-scrollbar">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Agent</TableHead>
                  <TableHead className="text-xs">Cấp</TableHead>
                  <TableHead className="text-xs">Hướng</TableHead>
                  <TableHead className="hidden text-xs sm:table-cell">Trọng số</TableHead>
                  <TableHead className="hidden text-xs sm:table-cell">LR</TableHead>
                  <TableHead className="text-xs">Δ log-odds</TableHead>
                  <TableHead className="hidden text-xs md:table-cell">Ghi chú</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {drivers.map((d, i) => (
                  <DriverRow key={`${d.source}-${i}`} driver={d} maxAbsDelta={maxAbsDelta} />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DriverRow({ driver, maxAbsDelta }: { driver: BayesDriver; maxAbsDelta: number }) {
  const dir = DRIVER_DIRECTION[driver.direction] ?? DRIVER_DIRECTION.FLAT;
  const DirIcon = dir.icon;
  const barPct = Math.min(100, (Math.abs(driver.deltaLogOdds) / maxAbsDelta) * 100);

  return (
    <TableRow>
      <TableCell>
        <div className="flex flex-col leading-tight">
          <span className="text-xs font-semibold">{driver.agentName || driver.source}</span>
          {driver.gen1 && (
            <Badge variant="secondary" className="mt-0.5 w-fit font-mono text-[9px]">
              {driver.gen1}
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {driver.level === "market"
          ? "Thị trường"
          : driver.symbol
            ? `Cổ phiếu · ${driver.symbol}`
            : "Cổ phiếu"}
      </TableCell>
      <TableCell>
        <span className={cn("flex items-center gap-1 text-xs font-medium", dir.className)}>
          <DirIcon className="size-3.5" aria-hidden="true" />
          <span className="sr-only">{dir.label}</span>
          <span aria-hidden="true">{dir.label}</span>
        </span>
      </TableCell>
      <TableCell className="hidden tabular-nums text-xs text-muted-foreground sm:table-cell">
        {pct1(driver.weight)}
      </TableCell>
      <TableCell className="hidden tabular-nums text-xs text-muted-foreground sm:table-cell">
        ×{nf2.format(driver.likelihoodRatio)}
      </TableCell>
      <TableCell>
        <span className="flex flex-col gap-1">
          <span
            className={cn(
              "tabular-nums text-xs font-semibold",
              changeColor(driver.deltaLogOdds)
            )}
          >
            {signed2(driver.deltaLogOdds)}
          </span>
          <span className="h-1 w-14 overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <span
              className={cn(
                "block h-full rounded-full",
                driver.deltaLogOdds >= 0 ? "bg-up" : "bg-down"
              )}
              style={{ width: `${barPct}%` }}
            />
          </span>
        </span>
      </TableCell>
      <TableCell className="hidden max-w-52 md:table-cell">
        <p className="truncate text-xs text-muted-foreground" title={driver.note}>
          {driver.note}
        </p>
      </TableCell>
    </TableRow>
  );
}
