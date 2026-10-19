"use client";

// (Task 144 P2-c) — tách từ synthesis-workspace.tsx (pure move)
// File gốc giữ vai trò COMPOSITION: state chính + hooks data (use-*) + ghép
// các section card từ ./synthesis/* — toàn bộ card/helper đã dời sang thư mục
// ./synthesis/ không đổi hành vi hiển thị.

import * as React from "react";
import { Brain, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
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
// (Task 144 P2-c) — các section card tách theo seam (pure move):
import { AssessmentHeaderCard } from "@/components/dashboard/synthesis/assessment-header-card";
import { SegmentsCard } from "@/components/dashboard/synthesis/segments-card";
import { ConsensusCard } from "@/components/dashboard/synthesis/consensus-card";
import { RiskQuantCard } from "@/components/dashboard/synthesis/risk-quant-card";
import {
  MarketLevelCard,
  NarrativeCard,
  PriorCard,
  SectorsCard,
} from "@/components/dashboard/synthesis/causal-cards";
import { SymbolsCard } from "@/components/dashboard/synthesis/symbols-card";
import { DriversCard } from "@/components/dashboard/synthesis/drivers-card";
import { HistoryCard } from "@/components/dashboard/synthesis/history-card";
import { EmptyState, SynthesisSkeleton } from "@/components/dashboard/synthesis/fallbacks";

/**
 * Phiên #34 — workspace "Tổng hợp" (Bộ tổng hợp Bayes — nhận định thị trường).
 * Hiển thị MarketAssessmentView đầy đủ theo 4 bậc nhân quả:
 * Bậc 0 tiên nghiệm → Bậc 1 thị trường → Bậc 2 ngành → Bậc 3 cổ phiếu,
 * kèm bảng bằng chứng (drivers), lịch sử pUp và hành động tổng hợp lại.
 *
 * API /api/assessment có thể chưa sẵn sàng (backend song song) — mọi trạng
 * thái loading/error/empty đều render riêng, không crash trang.
 */

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
          {/* M4.7 (#110) — 1 dòng đọc nhanh: kết luận + 3 số thật từ assessment.
              F-1115-03: truyền cờ error để phân biệt lỗi API với chưa có dữ liệu. */}
          <EvidenceQuickRead
            assessment={readyAssessment}
            historyCount={historyAsc.length}
            loading={isLoading}
            error={isError}
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
