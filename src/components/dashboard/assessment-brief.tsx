"use client";

import * as React from "react";
import { useAssessment } from "@/hooks/use-assessment";
import { ArrowRight, Brain, MoveRight, TrendingDown, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ChipMeta } from "@/components/dashboard/kit";
import { useUiStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/format";
import type {
  ConsensusSnapshot,
  MarketAssessmentView,
  SegmentAssessment,
} from "@/lib/types";

/**
 * Phiên #34 — bản tóm tắt nhận định Bayes trên workspace Tổng quan.
 * Card gọn: badge hướng + stacked probability bar + 3 stat + caption nguồn;
 * nhấn "Xem chi tiết" → workspace synthesis. Chưa có assessment → empty state
 * hướng dẫn dùng nút "Chạy agent" trên thanh bar trên cùng (phiên #47 — nút
 * chạy chu kỳ chỉ còn duy nhất ở đó; assessment tự invalidate sau chu kỳ).
 */

const DIRECTION: Record<string, { label: string; className: string }> = {
  BULLISH: { label: "TĂNG", className: "bg-up/15 text-up hover:bg-up/15" },
  BEARISH: { label: "GIẢM", className: "bg-down/15 text-down hover:bg-down/15" },
  NEUTRAL: { label: "ĐI NGANG", className: "bg-muted text-muted-foreground hover:bg-muted" },
};

/** "42,3%" — NHẬP TỶ LỆ 0..1 (pUp/confidence…) → nhân 100; 1 chữ số, dấu phẩy VN. */
function pct1(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${(n * 100).toLocaleString("vi-VN", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

export function AssessmentBrief() {
  const { data, isLoading, isError, error, refetch } = useAssessment();
  const setActiveWorkspace = useUiStore((s) => s.setActiveWorkspace);
  const assessment = data?.assessment ?? null;

  return (
    <section aria-label="Nhận định thị trường — Bộ tổng hợp Bayes">
      <Card className="gap-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Brain className="size-4 text-muted-foreground" aria-hidden="true" />
            Nhận định thị trường — Bộ tổng hợp Bayes
          </CardTitle>
          <CardDescription>
            {assessment
              ? assessment.source === "cycle"
                ? `Nguồn: chu kỳ 24 agents lúc ${formatDateTime(assessment.createdAt)}`
                : "Tổng hợp lại thủ công"
              : "Tổng hợp đánh giá 24 agents theo mô hình nhân quả Bayes"}
          </CardDescription>
          {assessment && (
            <CardAction>
              <Button
                variant="ghost"
                size="sm"
                className="min-h-9 gap-1 text-xs text-muted-foreground"
                onClick={() => setActiveWorkspace("synthesis")}
                aria-label="Mở workspace Tổng hợp"
              >
                Xem chi tiết
                <ArrowRight className="size-3" aria-hidden="true" />
              </Button>
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {isLoading ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-7 w-36" />
              <Skeleton className="h-7 w-full rounded-md" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : isError ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-down">
                {error?.message ?? "Không tải được nhận định."}
              </p>
              <Button variant="outline" size="sm" className="h-9" onClick={() => void refetch()}>
                Thử lại
              </Button>
            </div>
          ) : !assessment ? (
            /* Empty state — chưa chạy chu kỳ nào (phiên #47: hướng dẫn sang nút
             * "Chạy agent" duy nhất trên thanh bar trên cùng) */
            <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed p-4">
              <p className="text-sm text-muted-foreground">
                Bộ tổng hợp Bayes chưa chạy — dùng nút “Chạy agent” trên thanh
                bar trên cùng để cả đội phân tích, nhận định thị trường sẽ hiện
                ở đây ngay sau chu kỳ.
              </p>
            </div>
          ) : (
            <AssessmentBriefBody assessment={assessment} />
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function AssessmentBriefBody({ assessment }: { assessment: MarketAssessmentView }) {
  const dir = DIRECTION[assessment.marketDirection] ?? DIRECTION.NEUTRAL;
  const { pUp, pFlat, pDown } = assessment;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Badge className={cn("px-3 py-1 text-sm font-bold tracking-wide", dir.className)}>
          {dir.label}
        </Badge>
        {/* Stacked probability bar 3 màu (pUp/pFlat/pDown) */}
        <div
          className="flex h-7 min-w-48 flex-1 overflow-hidden rounded-md border border-border/60"
          role="img"
          aria-label={`Xác suất tăng ${pct1(pUp)}, đi ngang ${pct1(pFlat)}, giảm ${pct1(pDown)}`}
        >
          <ProbSegment value={pUp} className="bg-up" tone="text-up" label="Tăng" />
          <ProbSegment value={pFlat} className="bg-muted-foreground/25" tone="text-foreground" label="Đi ngang" />
          <ProbSegment value={pDown} className="bg-down" tone="text-down" label="Giảm" />
        </div>
        {/* M4.4.2 (#110-d) — "đọc số" không phải đo thanh: 2 chip pUp/pDown cạnh bar */}
        <ChipMeta
          tone="up"
          title={`Xác suất hậu nghiệm thị trường TĂNG — ${pct1(pUp)}`}
        >
          Tăng {pct1(pUp)}
        </ChipMeta>
        <ChipMeta
          tone="down"
          title={`Xác suất hậu nghiệm thị trường GIẢM — ${pct1(pDown)}`}
        >
          Giảm {pct1(pDown)}
        </ChipMeta>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <ChipMeta title="Độ tin cậy posterior do Bộ tổng hợp Bayes tự báo cáo">
          Độ tin cậy {pct1(assessment.confidence)}
        </ChipMeta>
        <ChipMeta title="Mức bất đồng giữa các agent trước khi tổng hợp">
          Bất đồng {pct1(assessment.disagreement)}
        </ChipMeta>
        <ChipMeta title="Số bằng chứng (chỉ số + tin tức) đưa vào suy luận">
          {assessment.evidenceCount.toLocaleString("vi-VN")} bằng chứng
        </ChipMeta>
        {assessment.veto.blocked && (
          <Badge variant="outline" className="border-down/40 text-down">
            Ủy ban Kiểm soát phủ quyết
          </Badge>
        )}
      </div>

      {/* B5 compact — đa thị trường: composite + 3 phân đoạn nổi bật */}
      {assessment.segments != null && assessment.segments.length > 0 && (
        <BriefSegments segments={assessment.segments} />
      )}

      {/* B9 compact — cổng đồng thuận 80% */}
      {assessment.consensus != null && (
        <BriefConsensus consensus={assessment.consensus} />
      )}
    </div>
  );
}

/* ─────────────── B5/B9 compact — chip phân đoạn + cổng đồng thuận ─────────────── */

/** Thứ tự ưu tiên hiển thị: 1 dòng tổng (composite) + 3 segment nổi bật. */
const BRIEF_SEGMENT_ORDER = [
  "VN-COMPOSITE",
  "VN-HOSE-STOCK",
  "VN-HNX-STOCK",
  "VN-INDEX",
] as const;

/** Nhãn ngắn từng segment (đồng bộ SEGMENT_SHORT trong synthesis-workspace). */
const BRIEF_SEGMENT_SHORT: Record<string, string> = {
  "VN-HOSE-STOCK": "HOSE",
  "VN-HNX-STOCK": "HNX",
  "VN-UPCOM-STOCK": "UPCOM",
  "VN-ETF": "ETF",
  "VN-INDEX": "INDEX",
  "VN-COMPOSITE": "VN tổng",
  INTERNATIONAL: "Quốc tế",
};

/** Gate badge compact: ĐỒNG THUẬN xanh lá · ĐA SỐ YẾU vàng · KHÔNG ĐỒNG THUẬN đỏ. */
const BRIEF_GATE_TONE: Record<string, string> = {
  CONSENSUS: "border-emerald-600/40 text-emerald-700 dark:text-emerald-400",
  WEAK_MAJORITY: "border-amber-500/40 text-amber-700 dark:text-amber-400",
  NO_CONSENSUS: "border-rose-600/40 text-rose-700 dark:text-rose-400",
};

function BriefSegments({ segments }: { segments: SegmentAssessment[] }) {
  const bySegment = new Map(segments.map((s) => [s.segment, s]));
  const picked = BRIEF_SEGMENT_ORDER.map((k) => bySegment.get(k)).filter(
    (s): s is SegmentAssessment => s != null
  );
  if (picked.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">Đa thị trường:</span>
      {picked.map((s) => {
        const tone =
          s.marketDirection === "BULLISH"
            ? "text-up"
            : s.marketDirection === "BEARISH"
              ? "text-down"
              : "text-muted-foreground";
        const Icon =
          s.marketDirection === "BULLISH"
            ? TrendingUp
            : s.marketDirection === "BEARISH"
              ? TrendingDown
              : MoveRight;
        // Xác suất trùng hướng đang hiển thị (dominant của 3 xác suất).
        const dominant = Math.max(s.pUp, s.pDown, s.pFlat);
        return (
          <span
            key={s.segment}
            className="flex items-center gap-1 rounded-md border px-1.5 py-0.5"
            title={`${s.label} — P(tăng) ${pct1(s.pUp)} · P(đi ngang) ${pct1(s.pFlat)} · P(giảm) ${pct1(s.pDown)}`}
          >
            <span
              className={cn(
                "font-medium",
                s.segment === "VN-COMPOSITE" && "font-semibold"
              )}
            >
              {BRIEF_SEGMENT_SHORT[s.segment] ?? s.label}
            </span>
            <Icon className={cn("size-3", tone)} aria-hidden="true" />
            <span className={cn("tabular-nums", tone)}>{pct1(dominant)}</span>
          </span>
        );
      })}
    </div>
  );
}

function BriefConsensus({ consensus }: { consensus: ConsensusSnapshot }) {
  const tone =
    BRIEF_GATE_TONE[consensus.gate] ?? BRIEF_GATE_TONE.NO_CONSENSUS;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">Cổng đồng thuận 80%:</span>
      <Badge
        variant="outline"
        className={cn("text-[11px] font-semibold", tone)}
        title={consensus.note || "Tỷ lệ trọng số phiếu 7 cử tri Hội đồng Nghiên cứu"}
      >
        {consensus.gateLabel}
      </Badge>
      <span className="tabular-nums font-semibold">{pct1(consensus.ratio)}</span>
      <span className="text-[11px] text-muted-foreground">
        · {consensus.present}/7 cử tri
      </span>
      {consensus.shadow ? (
        <Badge
          variant="outline"
          className="border-amber-500/50 px-1 py-0 text-[9px] text-amber-700 dark:text-amber-400"
          title="Cổng đang chạy shadow-mode — tính nhưng chưa chặn tín hiệu"
        >
          shadow
        </Badge>
      ) : (
        <Badge
          className="bg-emerald-600/15 px-1 py-0 text-[9px] text-emerald-700 dark:text-emerald-400"
          title="Enforcement đang bật — tín hiệu ngược số đông bị chặn"
        >
          enforcement
        </Badge>
      )}
    </div>
  );
}

function ProbSegment({
  value,
  className,
  tone,
  label,
}: {
  value: number;
  className: string;
  tone: string;
  label: string;
}) {
  if (!Number.isFinite(value) || value <= 0) return null;
  // value là tỷ lệ 0..1 → CSS % cần ×100 (0.71 → 71%)
  const widthPct = Math.min(100, Math.max(0, value * 100));
  return (
    <div
      className={cn("flex items-center justify-center", className)}
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
