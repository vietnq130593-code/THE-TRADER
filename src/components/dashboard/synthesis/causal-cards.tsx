"use client";

// (Task 144 P2-c) — tách từ synthesis-workspace.tsx (pure move)
// Nhóm card "tường thuật + bậc nhân quả 0/1/2" của tab Nhận định: NarrativeCard
// (+ VETO) · PriorCard (Bậc 0) · MarketLevelCard (Bậc 1) · SectorsCard (Bậc 2).

import { ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { changeColor, formatVnd } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { MarketAssessmentView } from "@/lib/types";
import { REGIME_LABELS, SECTOR_STANCE } from "./constants";
import { pct1, pct1s, signed2 } from "./helpers";

/* ─────────────────── 2. Narrative + VETO ─────────────────── */

export function NarrativeCard({ assessment }: { assessment: MarketAssessmentView }) {
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="text-base">Tường thuật nhận định</CardTitle>
        <CardDescription>
          Sinh tự động từ xác suất posterior — tiếng Việt
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="italic leading-relaxed text-muted-foreground">
          {assessment.narrative || "—"}
        </p>
        {assessment.veto.blocked && (
          <div
            role="alert"
            className="flex items-start gap-2.5 rounded-lg border border-down/40 bg-down/10 p-3 text-sm text-down"
          >
            <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <p>
              <span className="font-semibold">
                Ủy ban Kiểm soát đang PHỦ QUYẾT
              </span>
              {assessment.veto.reason ? ` — ${assessment.veto.reason}` : ""}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ─────────────────── 3a. Bậc 0 — Tiên nghiệm ─────────────────── */

export function PriorCard({ assessment }: { assessment: MarketAssessmentView }) {
  const { prior } = assessment;
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <span className="tabular-nums rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-bold text-muted-foreground">
            Bậc 0
          </span>
          Tiên nghiệm
        </CardTitle>
        <CardDescription>Base-rate lịch sử thật trước khi có bằng chứng</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {/* flex-wrap: mobile 390px không tràn ngang */}
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1.5">
          <span className="tabular-nums text-2xl font-bold text-up">{pct1(prior.pUp)}</span>
          <span className="text-xs text-muted-foreground">P(tăng)</span>
          <span className="tabular-nums text-lg font-semibold text-muted-foreground">
            {pct1(prior.pFlat)}
          </span>
          <span className="text-xs text-muted-foreground">P(đi ngang)</span>
          <span className="tabular-nums text-2xl font-bold text-down">{pct1(prior.pDown)}</span>
          <span className="text-xs text-muted-foreground">P(giảm)</span>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {prior.baseRateNote || "Tần suất tăng/giảm lịch sử của rổ VN30."}
        </p>
      </CardContent>
    </Card>
  );
}

/* ─────────────────── 3b. Bậc 1 — Thị trường ─────────────────── */

export function MarketLevelCard({ assessment }: { assessment: MarketAssessmentView }) {
  const { market, forecast5d } = assessment;
  const regimeLabel = REGIME_LABELS[market.regime] ?? market.regime;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <span className="tabular-nums rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-bold text-muted-foreground">
            Bậc 1
          </span>
          Thị trường
        </CardTitle>
        <CardDescription>Breadth · regime · tin tức · dòng khối ngoại</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {/* Breadth */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-up" aria-hidden="true" />
            <span className="tabular-nums font-semibold">{market.advancing}</span>
            <span className="text-xs text-muted-foreground">tăng</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-down" aria-hidden="true" />
            <span className="tabular-nums font-semibold">{market.declining}</span>
            <span className="text-xs text-muted-foreground">giảm</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-muted-foreground" aria-hidden="true" />
            <span className="tabular-nums font-semibold">{market.unchanged}</span>
            <span className="text-xs text-muted-foreground">đi ngang</span>
          </span>
          <Badge variant="outline" className="text-[11px]">
            Regime: {regimeLabel}
          </Badge>
        </div>

        <Separator />

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
          {market.newsSentimentScore != null && (
            <span className="flex items-center gap-1.5">
              Điểm tin tức
              <Badge
                variant="outline"
                className={cn(
                  "tabular-nums",
                  market.newsSentimentScore > 0
                    ? "border-up/40 text-up"
                    : market.newsSentimentScore < 0
                      ? "border-down/40 text-down"
                      : "text-muted-foreground"
                )}
              >
                {signed2(market.newsSentimentScore)}
              </Badge>
            </span>
          )}
          {market.netForeignFlowVnd != null && (
            <span className="flex items-center gap-1.5">
              Khối ngoại ròng
              <span
                className={cn(
                  "tabular-nums font-semibold",
                  changeColor(market.netForeignFlowVnd)
                )}
              >
                {formatVnd(market.netForeignFlowVnd)}
              </span>
            </span>
          )}
        </div>

        {/* Dự báo rổ 5 phiên */}
        {forecast5d && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-2.5 text-xs">
            <span className="font-medium">Dự báo rổ 5 phiên</span>
            <Badge
              variant="outline"
              className={cn(
                "tabular-nums font-semibold",
                forecast5d.expectedPct > 0
                  ? "border-up/40 text-up"
                  : forecast5d.expectedPct < 0
                    ? "border-down/40 text-down"
                    : "text-muted-foreground"
              )}
            >
              {pct1s(forecast5d.expectedPct)}
            </Badge>
            <span className="tabular-nums text-muted-foreground">
              KTC {pct1s(forecast5d.lowPct)} … {pct1s(forecast5d.highPct)}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ─────────────────── 3c. Bậc 2 — Nhóm ngành ─────────────────── */

export function SectorsCard({ assessment }: { assessment: MarketAssessmentView }) {
  const sectors = assessment.sectors ?? [];
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <span className="tabular-nums rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-bold text-muted-foreground">
            Bậc 2
          </span>
          Nhóm ngành
        </CardTitle>
        <CardDescription>{sectors.length} nhóm · posterior ngành</CardDescription>
      </CardHeader>
      <CardContent className="pb-0">
        {sectors.length === 0 ? (
          <p className="pb-6 text-sm text-muted-foreground">Không có dữ liệu ngành.</p>
        ) : (
          <div className="max-h-[260px] overflow-y-auto custom-scrollbar">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Ngành</TableHead>
                  <TableHead className="text-xs">Mã</TableHead>
                  <TableHead className="text-xs">Momentum 5p</TableHead>
                  <TableHead className="text-xs">P(tăng)</TableHead>
                  <TableHead className="text-xs">Stance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sectors.map((s) => {
                  const stance = SECTOR_STANCE[s.stance] ?? SECTOR_STANCE.FLAT;
                  return (
                    <TableRow key={s.sector}>
                      <TableCell className="max-w-32 truncate text-xs font-medium">
                        {s.sector}
                      </TableCell>
                      <TableCell className="tabular-nums text-xs text-muted-foreground">
                        {s.symbolCount}
                      </TableCell>
                      <TableCell
                        className={cn("tabular-nums text-xs", changeColor(s.avgMomentum5d))}
                      >
                        {pct1s(s.avgMomentum5d)}
                      </TableCell>
                      <TableCell className="text-xs">
                        <span className="flex items-center gap-1.5">
                          <span
                            className="h-1.5 w-10 overflow-hidden rounded-full bg-muted"
                            aria-hidden="true"
                          >
                            <span
                              className="block h-full rounded-full bg-up"
                              style={{
                                width: `${Math.min(100, Math.max(0, s.pUp))}%`,
                              }}
                            />
                          </span>
                          <span className="tabular-nums text-muted-foreground">{pct1(s.pUp)}</span>
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={cn("text-[10px]", stance.className)}>
                          {stance.label}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
