"use client";

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
import {
  Brain,
  Gauge,
  Globe,
  History,
  Loader2,
  MoveRight,
  RefreshCw,
  ShieldAlert,
  Sigma,
  TrendingDown,
  TrendingUp,
  Vote,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip as UiTooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAssessment, useSynthesizeNow } from "@/hooks/use-assessment";
import { MlOverviewTab } from "@/components/dashboard/ml-panel";
import { NnTab } from "@/components/dashboard/ml/nn-tab";
import { AlgorithmsTab } from "@/components/dashboard/ml/algorithms-tab";
import { DataTab } from "@/components/dashboard/ml/data-tab";
import { TuningTab } from "@/components/dashboard/ml/tuning-tab";
import { SweepTab } from "@/components/dashboard/ml/sweep-tab";
// M4.7 (#110 — UIUX_UPGRADE_BLUEPRINT §4): hàng "1 dòng đọc nhanh" (kết luận
// + 3 số thật) mở đầu mỗi tab — trừ tab Nhận định đã có AssessmentHeaderCard.
import {
  AlgorithmsQuickRead,
  AutomlQuickRead,
  DataQuickRead,
  EvidenceQuickRead,
  MlQuickRead,
  NetworkQuickRead,
  TuningQuickRead,
} from "@/components/dashboard/synthesis/quick-read";
import { useUiStore } from "@/lib/store";
import { changeColor, formatDateTime, formatVnd } from "@/lib/format";
import { cn } from "@/lib/utils";
import type {
  BayesDriver,
  ConsensusSnapshot,
  ConsensusVote,
  MarketAssessmentView,
  RiskQuantView,
  SegmentAssessment,
  SymbolAssessment,
} from "@/lib/types";

/**
 * Phiên #34 — workspace "Tổng hợp" (Bộ tổng hợp Bayes — nhận định thị trường).
 * Hiển thị MarketAssessmentView đầy đủ theo 4 bậc nhân quả:
 * Bậc 0 tiên nghiệm → Bậc 1 thị trường → Bậc 2 ngành → Bậc 3 cổ phiếu,
 * kèm bảng bằng chứng (drivers), lịch sử pUp và hành động tổng hợp lại.
 *
 * API /api/assessment có thể chưa sẵn sàng (backend song song) — mọi trạng
 * thái loading/error/empty đều render riêng, không crash trang.
 */

/* ─────────────────── Format helpers (vi-VN, 1 chữ số thập phân) ─────────────────── */

const nf1 = new Intl.NumberFormat("vi-VN", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat("vi-VN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "42,3%" — NHẬP TỶ LỆ 0..1 (pUp/confidence…) → nhân 100. */
function pct1(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${nf1.format(n * 100)}%`;
}

/** "+1,2%" / "−0,8%" */
function pct1s(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  const s = nf1.format(Math.abs(n));
  return n > 0 ? `+${s}%` : n < 0 ? `−${s}%` : `0%`;
}

/** "−0,42" (số có dấu, 2 chữ số) */
function signed2(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  const s = nf2.format(Math.abs(n));
  return n > 0 ? `+${s}` : n < 0 ? `−${s}` : "0,00";
}

/* ─────────────────── Label maps ─────────────────── */

const DIRECTION: Record<string, { label: string; className: string }> = {
  BULLISH: { label: "TĂNG", className: "bg-up/15 text-up hover:bg-up/15" },
  BEARISH: { label: "GIẢM", className: "bg-down/15 text-down hover:bg-down/15" },
  NEUTRAL: { label: "ĐI NGANG", className: "bg-muted text-muted-foreground hover:bg-muted" },
};

const STANCE: Record<string, { label: string; className: string }> = {
  BUY: { label: "MUA", className: "bg-up/15 text-up hover:bg-up/15" },
  SELL: { label: "BÁN", className: "bg-down/15 text-down hover:bg-down/15" },
  HOLD: { label: "GIỮ", className: "bg-muted text-muted-foreground hover:bg-muted" },
};

const SECTOR_STANCE: Record<string, { label: string; className: string }> = {
  UP: { label: "TĂNG", className: "bg-up/15 text-up hover:bg-up/15" },
  DOWN: { label: "GIẢM", className: "bg-down/15 text-down hover:bg-down/15" },
  FLAT: { label: "ĐI NGANG", className: "bg-muted text-muted-foreground hover:bg-muted" },
};

const REGIME_LABELS: Record<string, string> = {
  "risk-on": "Ưa rủi ro (risk-on)",
  "risk-off": "Né rủi ro (risk-off)",
  neutral: "Trung tính",
  bull: "Xu hướng tăng (bull)",
  bear: "Xu hướng giảm (bear)",
};

/** 1 dòng lịch sử cho chart + list. */
interface HistoryRow {
  createdAt: string;
  pUp: number;
  pDown: number;
  pFlat: number;
  marketDirection: string;
}

/* ─────────────────── Workspace ─────────────────── */

/**
 * PHIÊN #90 — hiệu lệnh trader: nội dung module Tổng hợp dài cuộn dọc (Bayes
 * + Học máy 1.075d nối đuôi). CHIA TAB NGANG (không thêm module mới —
 * trader: "không cần module học máy, chỉ cần chia module tổng hợp thành các
 * tab hợp lý"):
 *
 *   1. Nhận định      — header posterior + đa thị trường + cổng đồng thuận B9
 *                       + CRB + tường thuật + bậc nhân quả 0/1/2.
 *   2. Bằng chứng     — bậc 3 bảng cổ phiếu + drivers mức đóng góp + lịch sử pUp.
 *   3. Học máy        — dải 8 thẻ mini + 4 khối (MLP · cổng B2 · Q-learning ·
 *                       Bandit) + nút Huấn luyện / Kết toán reward.
 *   4. Mạng thần kinh — sơ đồ MLP trọng số THẬT + GRU-24 + ensemble (tab #89).
 *   5. Thuật toán     — 10 thẻ file·hàm·hằng số thật (tab #89).
 *   6. Dữ liệu        — pipeline 8 chặng + trình duyệt 34 model + RAG (tab #89).
 *   7. Tinh chỉnh     — ô nhập vận hành thật (tab #89).
 *   8. Tự động tìm kiếm — sweep AutoML L1 champion board + cổng 4 điều kiện
 *                       (tab C1 #99 — ML_AUTOML_BLUEPRINT §4.5/F9).
 *
 * 5 tab học máy #89 được PHÂN GIẢI lên ngang hàng (không còn Tabs lồng) —
 * tab đang mở lưu ở store (synthesisTab) để giữ khi đổi module qua lại.
 */
const SYNTHESIS_TABS = [
  { value: "assessment", label: "Nhận định" },
  { value: "evidence", label: "Bằng chứng" },
  { value: "ml", label: "Học máy" },
  { value: "network", label: "Mạng thần kinh" },
  { value: "algorithms", label: "Thuật toán" },
  { value: "data", label: "Dữ liệu" },
  { value: "tuning", label: "Tinh chỉnh" },
  { value: "automl", label: "Tự động tìm kiếm" },
] as const;

export function SynthesisWorkspace() {
  const { data, isLoading, isError, error, refetch } = useAssessment();
  const synthesizeNow = useSynthesizeNow();
  const synthesisTab = useUiStore((s) => s.synthesisTab);
  const setSynthesisTab = useUiStore((s) => s.setSynthesisTab);

  const assessment = data?.assessment ?? null;
  // Giữ tham chiếu ổn định từ cache (tránh useMemo deps đổi mỗi render).
  const history = data?.history;

  // Sắp desc (mới nhất trước) — API có thể trả asc, tự phòng vệ.
  const historyDesc = React.useMemo(() => {
    const arr = [...(history ?? [])];
    arr.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return arr;
  }, [history]);
  const historyAsc = React.useMemo(() => [...historyDesc].reverse(), [historyDesc]);

  const busy = synthesizeNow.isPending;

  // Thu hẹp kiểu một lần (TS không suy ra được “notReady == null ⇒ assessment
  // ≠ null” trong JSX) — dùng chung cho 2 tab Nhận định / Bằng chứng.
  const readyAssessment =
    !isLoading && !isError && assessment != null ? assessment : null;

  // Trạng thái assessment dùng chung cho 2 tab Nhận định / Bằng chứng — cùng
  // một nguồn /api/assessment (đủ điều kiện hiện bảng chứng mới khi có nhận
  // định). Render element dùng lại được ở cả 2 TabsContent (Radix chỉ mount
  // tab đang mở nên không trùng DOM).
  const assessmentNotReady = isLoading ? (
    <SynthesisSkeleton />
  ) : isError ? (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="text-base">Không tải được nhận định</CardTitle>
        <CardDescription>
          {error?.message ??
            "API /api/assessment chưa phản hồi — backend có thể đang triển khai."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="outline" className="min-h-11 gap-2" onClick={() => void refetch()}>
          <RefreshCw className="size-4" aria-hidden="true" />
          Thử lại
        </Button>
      </CardContent>
    </Card>
  ) : !readyAssessment ? (
    <EmptyState
      synthesizePending={synthesizeNow.isPending}
      onSynthesize={() => synthesizeNow.mutate()}
    />
  ) : null;

  return (
    <div
      role="tabpanel"
      id="workspace-panel-synthesis"
      aria-labelledby="workspace-tab-synthesis"
      className="flex flex-col gap-6"
    >
      <h2 className="sr-only">
        Tổng hợp — nhận định Bayes, học máy &amp; kiến trúc tinh chỉnh
      </h2>

      {/* Header workspace: mô tả + 2 hành động — LUÔN hiện trên mọi tab */}
      <Card>
        <CardContent className="flex flex-col gap-4 py-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <span
              className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted"
              aria-hidden="true"
            >
              <Brain className="size-5 text-foreground/80" />
            </span>
            <div className="leading-tight">
              <p className="text-base font-semibold">Bộ tổng hợp Bayes</p>
              <p className="text-xs text-muted-foreground">
                8 tab: nhận định 4 bậc nhân quả → bằng chứng cổ phiếu → học
                máy 3 mô hình → mạng thần kinh trọng số thật → thuật toán ·
                hàm → kiến trúc dữ liệu → tinh chỉnh vận hành thật
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <TooltipProvider delayDuration={200}>
              <UiTooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    className="min-h-11 gap-2"
                    onClick={() => synthesizeNow.mutate()}
                    disabled={busy}
                    aria-label="Tổng hợp lại ngay"
                  >
                    {synthesizeNow.isPending ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <RefreshCw className="size-4" aria-hidden="true" />
                    )}
                    Tổng hợp lại ngay
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  Thuật toán định lượng — 0 chi phí LLM
                </TooltipContent>
              </UiTooltip>
            </TooltipProvider>
            {/* Phiên #47 — nút "Chạy chu kỳ đầy đủ" bị XOÁ: nút "Chạy agent"
                trên thanh bar trên cùng là nút chạy chu kỳ DUY NHẤT của app. */}
          </div>
        </CardContent>
      </Card>

      <Tabs value={synthesisTab} onValueChange={setSynthesisTab}>
        {/* 8 tab — cuộn ngang trên mobile (pattern #89) */}
        <div className="overflow-x-auto custom-scrollbar pb-1">
          <TabsList className="w-max">
            {SYNTHESIS_TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value} className="text-xs">
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        {/* ── Tab 1 · Nhận định — posterior + đồng thuận + bậc 0/1/2 ── */}
        <TabsContent value="assessment" className="mt-4 flex flex-col gap-6">
          {readyAssessment ? (
            <>
              {/* 1. Header nhận định: badge hướng + stacked bar + 3 stat */}
              <AssessmentHeaderCard assessment={readyAssessment} />

              {/* 1b. B5 — Đa thị trường: posterior phân đoạn (row cũ chưa có) */}
              {readyAssessment.segments != null && readyAssessment.segments.length > 0 && (
                <SegmentsCard segments={readyAssessment.segments} />
              )}

              {/* 1c. B9 — Cổng đồng thuận 80% (row cũ chưa có) */}
              {readyAssessment.consensus != null && (
                <ConsensusCard consensus={readyAssessment.consensus} />
              )}

              {/* 1d. Phiên #51 — CRB: Ủy ban Kiểm soát Định lượng (row cũ chưa có) */}
              {readyAssessment.riskQuant != null && (
                <RiskQuantCard riskQuant={readyAssessment.riskQuant} />
              )}

              {/* 2. Tường thuật + VETO */}
              <NarrativeCard assessment={readyAssessment} />

              {/* 3. Bậc nhân quả 0/1/2 */}
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
                <PriorCard assessment={readyAssessment} />
                <MarketLevelCard assessment={readyAssessment} />
                <SectorsCard assessment={readyAssessment} />
              </div>
            </>
          ) : (
            assessmentNotReady
          )}
        </TabsContent>

        {/* ── Tab 2 · Bằng chứng — bậc 3 cổ phiếu + drivers + lịch sử ── */}
        <TabsContent value="evidence" className="mt-4 flex flex-col gap-6">
          {/* M4.7 (#110) — 1 dòng đọc nhanh: kết luận + 3 số thật từ assessment */}
          <EvidenceQuickRead
            assessment={readyAssessment}
            historyCount={historyAsc.length}
            loading={isLoading}
          />
          {readyAssessment ? (
            <>
              {/* 4. Bậc 3 — bảng cổ phiếu */}
              <SymbolsCard assessment={readyAssessment} />

              {/* 5. Bằng chứng & mức đóng góp */}
              <DriversCard assessment={readyAssessment} />

              {/* 6. Lịch sử */}
              {historyAsc.length > 0 && (
                <HistoryCard rows={historyAsc} recent={historyDesc.slice(0, 5)} />
              )}
            </>
          ) : (
            assessmentNotReady
          )}
        </TabsContent>

        {/* ── Tab 3 · Học máy — 3 mô hình học thật + hành động ── */}
        <TabsContent value="ml" className="mt-4 flex flex-col gap-4">
          <MlQuickRead />
          <MlOverviewTab />
        </TabsContent>

        {/* ── Tab 4 · Mạng thần kinh — MLP trọng số thật + GRU + ensemble ── */}
        <TabsContent value="network" className="mt-4 flex flex-col gap-4">
          <NetworkQuickRead />
          <NnTab />
        </TabsContent>

        {/* ── Tab 5 · Thuật toán — 10 thuật toán đang chạy ── */}
        <TabsContent value="algorithms" className="mt-4 flex flex-col gap-4">
          <AlgorithmsQuickRead />
          <AlgorithmsTab />
        </TabsContent>

        {/* ── Tab 6 · Dữ liệu & kiến trúc — pipeline + trình duyệt DB ── */}
        <TabsContent value="data" className="mt-4 flex flex-col gap-4">
          <DataQuickRead />
          <DataTab />
        </TabsContent>

        {/* ── Tab 7 · Tinh chỉnh — ô nhập vận hành thật ── */}
        <TabsContent value="tuning" className="mt-4 flex flex-col gap-4">
          <TuningQuickRead />
          <TuningTab />
        </TabsContent>

        {/* ── Tab 8 · Tự động tìm kiếm — sweep AutoML L1 champion board (C1 #99) ── */}
        <TabsContent value="automl" className="mt-4 flex flex-col gap-4">
          <AutomlQuickRead />
          <SweepTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ─────────────────── 1. Header card ─────────────────── */

function AssessmentHeaderCard({ assessment }: { assessment: MarketAssessmentView }) {
  const dir = DIRECTION[assessment.marketDirection] ?? DIRECTION.NEUTRAL;
  const { pUp, pFlat, pDown } = assessment;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="text-base">Nhận định hiện tại</CardTitle>
        <CardDescription>
          {assessment.source === "cycle"
            ? `Nguồn: chu kỳ 23 agents lúc ${formatDateTime(assessment.createdAt)}`
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

/* ─────────────────── 1b. B5 — Đa thị trường: posterior phân đoạn ─────────────────── */

/** Nhãn ngắn mỗi segment (dòng phụ trọng số + bản compact ở overview). */
const SEGMENT_SHORT: Record<string, string> = {
  "VN-HOSE-STOCK": "HOSE",
  "VN-HNX-STOCK": "HNX",
  "VN-UPCOM-STOCK": "UPCOM",
  "VN-ETF": "ETF",
  "VN-INDEX": "INDEX",
  "VN-COMPOSITE": "VN tổng",
  INTERNATIONAL: "Quốc tế",
};

function segmentShort(segment: string): string {
  return SEGMENT_SHORT[segment] ?? segment;
}

/** "% nguyên" — segment quá nhẹ (<0,5%) hiển thị "<1%" trung thực hơn "0%". */
function formatShare(share: number | null): string | null {
  if (share == null) return null;
  const pct = Math.round(share * 100);
  return pct > 0 ? `${pct}%` : share > 0 ? "<1%" : "0%";
}

function SegmentsCard({ segments }: { segments: SegmentAssessment[] }) {
  // Tỷ lệ đóng góp composite = compositeWeight / Σw — chỉ tính trên segment
  // có weight > 0 (bỏ COMPOSITE là tổng, bỏ INTERNATIONAL weight null).
  const weighted = segments.filter(
    (s) =>
      s.compositeWeight != null &&
      s.compositeWeight > 0 &&
      s.segment !== "VN-COMPOSITE"
  );
  const totalWeight = weighted.reduce(
    (sum, s) => sum + (s.compositeWeight ?? 0),
    0
  );
  const shareOf = (s: SegmentAssessment): number | null =>
    totalWeight > 0 &&
    s.compositeWeight != null &&
    s.compositeWeight > 0 &&
    s.segment !== "VN-COMPOSITE"
      ? s.compositeWeight / totalWeight
      : null;
  const weightNote = weighted
    .map((s) => `${segmentShort(s.segment)} ${formatShare(shareOf(s)) ?? "0%"}`)
    .join(" · ");

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Globe className="size-4 text-muted-foreground" aria-hidden="true" />
          Đa thị trường — posterior phân đoạn
        </CardTitle>
        <CardDescription>
          {segments.length} phân đoạn · composite VN = trung bình trọng số theo
          ADTV thật (index cố định 0,05/index)
        </CardDescription>
      </CardHeader>
      <CardContent className="pb-0">
        <div className="max-h-96 overflow-y-auto custom-scrollbar">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Phân đoạn</TableHead>
                <TableHead className="text-xs">Hướng</TableHead>
                <TableHead className="text-xs">P(tăng)</TableHead>
                <TableHead className="hidden text-xs sm:table-cell">
                  P(đi ngang)
                </TableHead>
                <TableHead className="text-xs">P(giảm)</TableHead>
                <TableHead className="hidden text-xs sm:table-cell">
                  Trọng số
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {segments.map((s) => (
                <SegmentRow key={s.segment} row={s} share={shareOf(s)} />
              ))}
            </TableBody>
          </Table>
        </div>
        {weightNote && (
          <p className="py-3 text-[11px] leading-relaxed text-muted-foreground">
            Trọng số: {weightNote} — tỷ lệ đóng góp vào composite VN (ADTV đo
            được, index khiêm tốn cố định).
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function SegmentRow({
  row,
  share,
}: {
  row: SegmentAssessment;
  share: number | null;
}) {
  const dir = DIRECTION[row.marketDirection] ?? DIRECTION.NEUTRAL;
  const isComposite = row.segment === "VN-COMPOSITE";
  // INTERNATIONAL (hoặc segment weight null) — tham khảo, không vào composite.
  const isReference =
    !isComposite && (row.segment === "INTERNATIONAL" || row.compositeWeight == null);
  const shareText = formatShare(share);

  return (
    <TableRow
      className={cn(isComposite && "border-t-2 border-border bg-muted/40")}
    >
      {/* Mobile — 1 hàng gộp (không tràn cột ở 390px) */}
      <TableCell colSpan={6} className="sm:hidden">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-0.5 leading-tight">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-xs font-semibold" title={row.note}>
                {row.label}
              </span>
              {isComposite && (
                <Badge variant="secondary" className="px-1 py-0 text-[9px]">
                  composite
                </Badge>
              )}
              {isReference && (
                <Badge
                  variant="outline"
                  className="px-1 py-0 text-[9px] text-muted-foreground"
                >
                  tham khảo
                </Badge>
              )}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {row.symbolCount.toLocaleString("vi-VN")} mã
              {isComposite
                ? " · Σ 100%"
                : shareText
                  ? ` · TL ${shareText}`
                  : ""}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Badge variant="outline" className={cn("text-[10px]", dir.className)}>
              {dir.label}
            </Badge>
            <span className="tabular-nums text-[11px] font-semibold">
              {pct1(row.pUp)}
            </span>
            <span className="text-[10px] text-muted-foreground">/</span>
            <span className="tabular-nums text-[11px] text-muted-foreground">
              {pct1(row.pDown)}
            </span>
          </div>
        </div>
      </TableCell>

      {/* Desktop — 6 cột đầy đủ */}
      <TableCell className="hidden sm:table-cell">
        <div className="flex flex-col leading-tight" title={row.note}>
          <span className="flex items-center gap-1.5 text-xs font-semibold">
            {row.label}
            {isComposite && (
              <Badge variant="secondary" className="px-1 py-0 text-[9px]">
                composite
              </Badge>
            )}
          </span>
          <span className="text-[10px] text-muted-foreground">
            {row.symbolCount.toLocaleString("vi-VN")} mã
          </span>
        </div>
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        <Badge variant="outline" className={cn("text-[10px]", dir.className)}>
          {dir.label}
        </Badge>
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        <span
          className={cn(
            "tabular-nums text-xs",
            row.marketDirection === "BULLISH"
              ? "font-semibold text-up"
              : "text-muted-foreground"
          )}
        >
          {pct1(row.pUp)}
        </span>
      </TableCell>
      <TableCell className="hidden tabular-nums text-xs text-muted-foreground sm:table-cell">
        {pct1(row.pFlat)}
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        <span
          className={cn(
            "tabular-nums text-xs",
            row.marketDirection === "BEARISH"
              ? "font-semibold text-down"
              : "text-muted-foreground"
          )}
        >
          {pct1(row.pDown)}
        </span>
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        {isComposite ? (
          <span
            className="tabular-nums text-xs text-muted-foreground"
            title="Tổng hợp có trọng số của các phân đoạn thành phần"
          >
            Σ 100%
          </span>
        ) : shareText ? (
          <span
            className="tabular-nums text-xs text-muted-foreground"
            title="Tỷ lệ đóng góp vào composite VN"
          >
            {shareText}
          </span>
        ) : (
          <span className="text-[11px] italic text-muted-foreground">tham khảo</span>
        )}
      </TableCell>
    </TableRow>
  );
}

/* ─────────────────── 1c. B9 — Cổng đồng thuận 80% ─────────────────── */

/** Màu badge gate: ĐỒNG THUẬN xanh lá · ĐA SỐ YẾU vàng · KHÔNG ĐỒNG THUẬN đỏ. */
const GATE_TONE: Record<string, string> = {
  CONSENSUS: "bg-emerald-600/15 text-emerald-700 dark:text-emerald-400",
  WEAK_MAJORITY: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  NO_CONSENSUS: "bg-rose-600/15 text-rose-700 dark:text-rose-400",
};

const TALLY_DIRS = ["UP", "DOWN", "FLAT"] as const;

function ConsensusCard({ consensus }: { consensus: ConsensusSnapshot }) {
  const tally = consensus.tally ?? [];
  const totalWeight = tally.reduce((s, v) => s + v.weight, 0);
  const votesOf = (d: (typeof TALLY_DIRS)[number]) =>
    tally.filter((v) => v.direction === d);
  const sumOf = (d: (typeof TALLY_DIRS)[number]) =>
    votesOf(d).reduce((s, v) => s + v.weight, 0);
  const shareOf = (d: (typeof TALLY_DIRS)[number]) =>
    totalWeight > 0 ? sumOf(d) / totalWeight : 0;
  const gateTone = GATE_TONE[consensus.gate] ?? GATE_TONE.NO_CONSENSUS;

  const ariaLabel =
    totalWeight > 0
      ? `Cổng đồng thuận 80%: tỷ lệ trọng số ${pct1(consensus.ratio)} — ${consensus.gateLabel}. ` +
        TALLY_DIRS.map(
          (d) =>
            `${votesOf(d).length} phiếu ${d === "UP" ? "tăng" : d === "DOWN" ? "giảm" : "đi ngang"} (${pct1(shareOf(d))})`
        ).join(", ") +
        ". Ngưỡng đồng thuận 80%."
      : "Cổng đồng thuận 80%: không có phiếu hợp lệ.";

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Vote className="size-4 text-muted-foreground" aria-hidden="true" />
          Cổng đồng thuận 80%
        </CardTitle>
        <CardDescription>
          {consensus.present}/6 cử tri Hội đồng Nghiên cứu · tỷ lệ đồng thuận
          trọng số{" "}
          <span className="tabular-nums font-semibold text-foreground">
            {pct1(consensus.ratio)}
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* Gate + trạng thái enforcement */}
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            className={cn("px-3 py-1 text-sm font-bold tracking-wide", gateTone)}
          >
            {consensus.gateLabel}
          </Badge>
          {consensus.shadow ? (
            <Badge
              variant="outline"
              className="border-amber-500/50 text-[11px] text-amber-700 dark:text-amber-400"
            >
              Shadow-mode — chưa chặn tín hiệu
            </Badge>
          ) : (
            <Badge className="bg-emerald-600/15 text-[11px] text-emerald-700 dark:text-emerald-400">
              Enforcement ĐANG BẬT
            </Badge>
          )}
          {consensus.present < 6 && (
            <span className="text-[11px] text-muted-foreground">
              {consensus.present}/6 cử tri có mặt
            </span>
          )}
        </div>

        {/* Thanh tally 3 cụm + đường ngưỡng 80% */}
        {totalWeight > 0 ? (
          <div className="flex flex-col gap-1.5">
            <div className="relative">
              <div
                className="flex h-8 overflow-hidden rounded-md border border-border/60"
                role="img"
                aria-label={ariaLabel}
              >
                {TALLY_DIRS.map((d) => {
                  const share = shareOf(d);
                  if (share <= 0) return null;
                  return (
                    <div
                      key={d}
                      className={cn(
                        "flex items-center justify-center border-r border-background/60 last:border-r-0",
                        d === "UP"
                          ? "bg-up/25"
                          : d === "DOWN"
                            ? "bg-down/25"
                            : "bg-muted-foreground/20"
                      )}
                      style={{ width: `${share * 100}%` }}
                      title={`${votesOf(d).length} phiếu · ${pct1(share)} trọng số`}
                    >
                      {share >= 0.18 && (
                        <span
                          className={cn(
                            "tabular-nums text-[11px] font-semibold",
                            d === "UP"
                              ? "text-up"
                              : d === "DOWN"
                                ? "text-down"
                                : "text-foreground"
                          )}
                        >
                          {votesOf(d).length} · {pct1(share)}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
              {/* Đường ngưỡng 80% (vị trí left 80%) */}
              <div
                className="pointer-events-none absolute inset-y-[-4px] left-[80%] w-0 border-l-2 border-dashed border-foreground/50"
                aria-hidden="true"
              />
            </div>
            {/* Nhãn ngưỡng dưới đường */}
            <div className="relative h-4">
              <span
                className="absolute left-[80%] -translate-x-1/2 whitespace-nowrap text-[10px] font-semibold text-muted-foreground"
                aria-hidden="true"
              >
                ▾ ngưỡng 80%
              </span>
            </div>
            {/* Legend — đọc được cả khi cụm quá hẹp */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
              {TALLY_DIRS.map((d) => (
                <span key={d} className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "size-2 rounded-full",
                      d === "UP" ? "bg-up" : d === "DOWN" ? "bg-down" : "bg-muted-foreground"
                    )}
                    aria-hidden="true"
                  />
                  {d === "UP" ? "Tăng" : d === "DOWN" ? "Giảm" : "Đi ngang"}{" "}
                  <span className="tabular-nums font-semibold text-foreground">
                    {votesOf(d).length}
                  </span>{" "}
                  phiếu · <span className="tabular-nums">{pct1(shareOf(d))}</span>
                </span>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Không có phiếu hợp lệ trong lần tổng hợp này.
          </p>
        )}

        {/* Danh sách 6 phiếu */}
        {tally.length > 0 && (
          <ul
            className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3"
            aria-label="Danh sách phiếu bầu Hội đồng Nghiên cứu"
          >
            {tally.map((v) => (
              <VoteRow key={v.code} vote={v} />
            ))}
          </ul>
        )}

        {/* Ghi chú narrative */}
        {consensus.note && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {consensus.note}
          </p>
        )}
        {consensus.shadow && consensus.wouldBlock && (
          <p className="text-xs leading-relaxed text-amber-700 dark:text-amber-400">
            Nếu bật enforcement: tín hiệu ngược hướng số đông tại lần tổng hợp
            này sẽ bị chặn.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function VoteRow({ vote }: { vote: ConsensusVote }) {
  // Tái dụng DRIVER_DIRECTION (Tăng/Giảm/Đi ngang + icon lucide + màu ngữ nghĩa).
  const dir = DRIVER_DIRECTION[vote.direction] ?? DRIVER_DIRECTION.FLAT;
  const DirIcon = dir.icon;

  return (
    <li className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2">
      <div className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-xs font-semibold" title={vote.agentName}>
          {vote.agentName}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {vote.gen1 ? `${vote.gen1} · ` : ""}
          {vote.code}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {vote.model === "ml" && (
          <Badge variant="secondary" className="px-1 py-0 text-[9px]">
            ML
          </Badge>
        )}
        <span
          className="tabular-nums text-[11px] text-muted-foreground"
          title="Trọng số phiếu = health × posterior bandit (clamp 0,3–1)"
        >
          w {nf2.format(vote.weight)}
        </span>
        <span className={cn("flex items-center gap-1 text-xs font-medium", dir.className)}>
          <DirIcon className="size-3.5" aria-hidden="true" />
          <span className="sr-only">{dir.label}</span>
          <span aria-hidden="true">{dir.label}</span>
        </span>
      </div>
    </li>
  );
}

/* ─────────────────── 1d. Phiên #51 — CRB: Ủy ban Kiểm soát Định lượng ─────────────────── */

const ALERT_TONE: Record<string, string> = {
  INFO: "bg-emerald-600/15 text-emerald-700 dark:text-emerald-400",
  WARNING: "bg-amber-600/15 text-amber-700 dark:text-amber-400",
  CRITICAL: "bg-rose-600/15 text-rose-700 dark:text-rose-400",
};

/** "22,5%" — giá trị đã Ở DẠNG % (không nhân 100). */
function pctRaw(n: number | null | undefined, digits = 1): string {
  if (n == null || Number.isNaN(n)) return "—";
  const nf = digits === 2 ? nf2 : nf1;
  return `${nf.format(n)}%`;
}

function QuantStat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: string;
}) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={cn("tabular-nums text-sm font-semibold", tone ?? "text-foreground")}>
        {value}
      </div>
      {hint ? <div className="text-[11px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

function RiskQuantCard({ riskQuant }: { riskQuant: RiskQuantView }) {
  const rq = riskQuant;
  const volTone =
    rq.volRatio > 1.33
      ? "text-rose-600 dark:text-rose-400"
      : rq.volRatio < 0.9
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-foreground";
  const loosened = rq.mult > 1 + 1e-9;
  const alerts = rq.alerts ?? [];
  const notes = rq.notes ?? [];

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Gauge className="size-4 text-muted-foreground" aria-hidden="true" />
          Ủy ban Kiểm soát Định lượng (QUANT)
        </CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-2">
          <span>
            EWMA λ=0,94 · HS-VaR/CVaR · MC bootstrap 5.000 path · HHI · CUSUM —
            deterministic, 0 LLM
          </span>
          {rq.proxyMode ? (
            <Badge
              variant="outline"
              className="border-amber-500/50 text-[11px] text-amber-700 dark:text-amber-400"
            >
              Proxy mode — rổ top-10 (danh mục chưa đủ dữ liệu)
            </Badge>
          ) : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* Khối 1 · Biến động + hạn mức động (CRB-1 hai chiều × CRB-7) */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <QuantStat
            label="Biến động EWMA20 (năm hoá)"
            value={pctRaw(rq.volEwmaAnnPct)}
            hint={`× ${nf2.format(rq.volRatio)} mốc bình thường`}
            tone={volTone}
          />
          <QuantStat
            label="Hệ số hạn mức"
            value={`× ${nf2.format(rq.mult)}`}
            hint={loosened ? "Nới +15% trần — INFO alert" : rq.mult <= 0.75 ? "Siết mạnh (vol/learning)" : "Siết vừa"}
            tone={loosened ? "text-emerald-600 dark:text-emerald-400" : rq.mult <= 0.75 ? "text-rose-600 dark:text-rose-400" : undefined}
          />
          <QuantStat
            label="Hạn vị thế động"
            value={pctRaw(rq.dynMaxPositionPct)}
            hint={`tĩnh ${pctRaw(rq.staticMaxPositionPct)}`}
          />
          <QuantStat
            label="Hạn ngành động"
            value={pctRaw(rq.dynMaxSectorPct)}
            hint={`tĩnh ${pctRaw(rq.staticMaxSectorPct)}`}
          />
          <QuantStat
            label="CUSUM downside S"
            value={nf2.format(rq.cusumS)}
            hint={rq.cusumAlarm ? "BÁO ĐỘNG vượt 4σ" : "trong ngưỡng"}
            tone={rq.cusumAlarm ? "text-rose-600 dark:text-rose-400" : undefined}
          />
        </div>

        {/* Khối 2 · Rủi ro đuôi + tập trung (CRB-2/3/4/5) */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <QuantStat
            label="VaR95 5 phiên"
            value={pctRaw(rq.var95Pct, 2)}
            hint={rq.var95Vnd > 0 ? `≈ ${formatVnd(rq.var95Vnd)}` : "rổ proxy"}
          />
          <QuantStat
            label="CVaR95 5 phiên"
            value={pctRaw(rq.cvar95Pct, 2)}
            hint={rq.cvar95Pct > 5 ? "vượt 5% NAV" : rq.cvar95Pct > 3 ? "vượt 3% NAV" : "an toàn"}
            tone={
              rq.cvar95Pct > 5
                ? "text-rose-600 dark:text-rose-400"
                : rq.cvar95Pct > 3
                  ? "text-amber-600 dark:text-amber-400"
                  : undefined
            }
          />
          <QuantStat
            label="MC · P(chạm DD 15%)"
            value={pct1(rq.mcPDd)}
            hint={`lỗ 5% tệ nhất: ${pctRaw(rq.mcLoss5Pct, 2)}`}
            tone={rq.mcPDd >= 0.1 ? "text-rose-600 dark:text-rose-400" : undefined}
          />
          <QuantStat
            label="HHI ngành / vị thế"
            value={`${nf2.format(rq.hhiSector)} / ${nf2.format(rq.hhiPosition)}`}
            hint={`≈ ${nf1.format(rq.effSectors)} ngành hiệu quả${rq.effBets > 0 ? ` · ~${nf1.format(rq.effBets)} cược` : ""}`}
            tone={
              rq.hhiSector > 0.25 || rq.hhiPosition > 0.15
                ? "text-amber-600 dark:text-amber-400"
                : undefined
            }
          />
          <QuantStat
            label="P(vi phạm 5 phiên)"
            value={rq.pBreach5d != null ? pct1(rq.pBreach5d) : "chưa serving"}
            hint={
              rq.pBreach5d != null
                ? rq.pBreach5d > 0.35
                  ? "vượt 35% — bằng chứng Bayes DOWN"
                  : "trong ngưỡng"
                : "AUC < 0,55 — trung thực không dự báo"
            }
            tone={rq.pBreach5d != null && rq.pBreach5d > 0.35 ? "text-amber-600 dark:text-amber-400" : undefined}
          />
        </div>

        {/* Khối 3 · Kelly ¼ (CRB-9 — tham mưu) */}
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2">
          <span className="text-[11px] text-muted-foreground">Kelly ¼ (tham mưu):</span>
          <span className="tabular-nums text-sm font-semibold text-foreground">
            {rq.kellyHint != null ? pct1(rq.kellyHint) : "—"}
          </span>
          <span className="text-[11px] text-muted-foreground">
            gợi ý tỷ trọng tối đa cho tín hiệu chu kỳ (bandit posterior cử tri đồng hướng,
            chặn hạn mức động) — khối lượng lệnh do trader phê duyệt
          </span>
        </div>

        {/* Cảnh báo quant (đã dedupe 24h phía engine) */}
        {alerts.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <div className="text-xs font-medium text-muted-foreground">
              Cảnh báo ({alerts.length})
            </div>
            <ul className="flex max-h-40 flex-col gap-1.5 overflow-y-auto pr-1">
              {alerts.map((a) => (
                <li key={a.code} className="flex items-start gap-2 text-xs">
                  <Badge className={cn("shrink-0 px-1.5 py-0 text-[10px] font-bold", ALERT_TONE[a.severity] ?? "")}>
                    {a.severity}
                  </Badge>
                  <span className="text-muted-foreground">{a.message}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* Ghi chú minh bạch (proxy mode, nguồn chuỗi NAV, sai lệch MC vs HS…) */}
        {notes.length > 0 ? (
          <ul className="flex max-h-24 flex-col gap-1 overflow-y-auto pr-1 text-[11px] text-muted-foreground">
            {notes.map((n, i) => (
              <li key={i}>· {n}</li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

/* ─────────────────── 2. Narrative + VETO ─────────────────── */

function NarrativeCard({ assessment }: { assessment: MarketAssessmentView }) {
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

function PriorCard({ assessment }: { assessment: MarketAssessmentView }) {
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

function MarketLevelCard({ assessment }: { assessment: MarketAssessmentView }) {
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

function SectorsCard({ assessment }: { assessment: MarketAssessmentView }) {
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

/* ─────────────────── 4. Bậc 3 — Cổ phiếu ─────────────────── */

function SymbolsCard({ assessment }: { assessment: MarketAssessmentView }) {
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

/* ─────────────────── 5. Bằng chứng & mức đóng góp ─────────────────── */

const DRIVER_DIRECTION: Record<
  string,
  { label: string; icon: React.ComponentType<{ className?: string }>; className: string }
> = {
  UP: { label: "Tăng", icon: TrendingUp, className: "text-up" },
  DOWN: { label: "Giảm", icon: TrendingDown, className: "text-down" },
  FLAT: { label: "Đi ngang", icon: MoveRight, className: "text-muted-foreground" },
};

function DriversCard({ assessment }: { assessment: MarketAssessmentView }) {
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

/* ─────────────────── 6. Lịch sử ─────────────────── */

interface ChartRow {
  label: string;
  pUp: number;
  lastDot: number | null;
}

function HistoryCard({
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

/* ─────────────────── Empty state ─────────────────── */

function EmptyState({
  synthesizePending,
  onSynthesize,
}: {
  synthesizePending: boolean;
  onSynthesize: () => void;
}) {
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Brain className="size-4 text-muted-foreground" aria-hidden="true" />
          Chưa có lần tổng hợp nào
        </CardTitle>
        <CardDescription>Bộ tổng hợp Bayes chưa chạy</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
          Bộ tổng hợp Bayes tổng hợp đánh giá của toàn bộ 23 agents theo mô hình
          nhân quả (thị trường → ngành → cổ phiếu). Dùng nút “Chạy agent” trên
          thanh bar trên cùng để cả đội sinh bằng chứng, hoặc tổng hợp ngay từ
          dữ liệu định lượng hiện có — không tốn LLM.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button
            variant="outline"
            onClick={onSynthesize}
            disabled={synthesizePending}
            className="min-h-11 gap-2"
          >
            {synthesizePending ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Đang tổng hợp…
              </>
            ) : (
              <>
                <RefreshCw className="size-4" aria-hidden="true" />
                Tổng hợp ngay (không tốn LLM)
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/* ─────────────────── Skeleton ─────────────────── */

function SynthesisSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Đang tải nhận định">
      <Card>
        <CardContent className="flex flex-col gap-4 py-6">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-7 w-full rounded-md" />
          <Skeleton className="h-4 w-2/3" />
        </CardContent>
      </Card>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="flex flex-col gap-3 py-6">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-4 w-4/5" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardContent className="py-6">
          <Skeleton className="h-64 w-full rounded-lg" />
        </CardContent>
      </Card>
    </div>
  );
}
