"use client";

// (Task 144 P2-c) — tách từ synthesis-workspace.tsx (pure move)
// Card 1 "Nhận định hiện tại": badge hướng + stacked bar xác suất 3 màu + 3 stat
// (độ tin cậy · bất đồng · số bằng chứng).

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Tooltip as UiTooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { MarketAssessmentView } from "@/lib/types";
import { DIRECTION } from "./constants";
import { pct1 } from "./helpers";

/* ─────────────────── 1. Header card ─────────────────── */

export function AssessmentHeaderCard({ assessment }: { assessment: MarketAssessmentView }) {
  const dir = DIRECTION[assessment.marketDirection] ?? DIRECTION.NEUTRAL;
  const { pUp, pFlat, pDown } = assessment;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="text-base">Nhận định hiện tại</CardTitle>
        <CardDescription>
          {assessment.source === "cycle"
            ? `Nguồn: chu kỳ 24 agents lúc ${formatDateTime(assessment.createdAt)}`
            : "Tổng hợp lại thủ công"}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-4">
          <Badge className={cn("px-4 py-1.5 text-lg font-bold tracking-wide", dir.className)}>
            {dir.label}
          </Badge>
          {/* Stacked probability bar 3 màu — mỗi đoạn hiện % khi ≥8% */}
          <div
            className="flex h-7 min-w-56 flex-1 overflow-hidden rounded-md border border-border/60"
            role="img"
            aria-label={`Xác suất tăng ${pct1(pUp)}, đi ngang ${pct1(pFlat)}, giảm ${pct1(pDown)}`}
          >
            <ProbSegment value={pUp} bg="bg-up" tone="text-up" label="Tăng" />
            <ProbSegment value={pFlat} bg="bg-muted-foreground/25" tone="text-foreground" label="Đi ngang" />
            <ProbSegment value={pDown} bg="bg-down" tone="text-down" label="Giảm" />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
          <span>
            Độ tin cậy{" "}
            <span className="tabular-nums font-semibold text-foreground">
              {pct1(assessment.confidence)}
            </span>
          </span>
          <TooltipProvider delayDuration={200}>
            <UiTooltip>
              <TooltipTrigger asChild>
                <span className="cursor-help underline decoration-dotted underline-offset-4">
                  Bất đồng{" "}
                  <span className="tabular-nums font-semibold text-foreground">
                    {pct1(assessment.disagreement)}
                  </span>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-64 text-left">
                Mức bất đồng giữa các bằng chứng đầu vào: 0% = tất cả agent đồng
                quan điểm, cao = bằng chứng đang kéo theo chiều ngược nhau.
              </TooltipContent>
            </UiTooltip>
          </TooltipProvider>
          <span>
            Số bằng chứng{" "}
            <span className="tabular-nums font-semibold text-foreground">
              {assessment.evidenceCount.toLocaleString("vi-VN")}
            </span>
          </span>
          <span className="ml-auto">
            {assessment.agentsConsidered.length.toLocaleString("vi-VN")} agent
            đóng góp bằng chứng
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function ProbSegment({
  value,
  bg,
  tone,
  label,
}: {
  value: number;
  bg: string;
  tone: string;
  label: string;
}) {
  if (!Number.isFinite(value) || value <= 0) return null;
  // value là tỷ lệ 0..1 → CSS % cần ×100 (0.71 → 71%)
  const widthPct = Math.min(100, Math.max(0, value * 100));
  return (
    <div
      className={cn("flex items-center justify-center", bg)}
      style={{ width: `${widthPct}%` }}
      title={`${label}: ${pct1(value)}`}
    >
      {widthPct >= 8 && (
        <span className={cn("tabular-nums text-[11px] font-semibold", tone)}>
          {pct1(value)}
        </span>
      )}
    </div>
  );
}
