"use client";

import * as React from "react";
import {
  AlertTriangle,
  Brain,
  Clock,
  Coins,
  Loader2,
  RefreshCw,
  Zap,
} from "lucide-react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip as UiTooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  isMlNotFound,
  useMlStatus,
  useSettleMl,
  useTrainMl,
} from "@/hooks/use-ml";
import { MlpBlock } from "./ml/mlp-block";
import { GateBlock } from "./ml/gate-block";
import { RlBlock } from "./ml/rl-block";
import { BanditBlock } from "./ml/bandit-block";
import { OverviewStrip } from "./ml/overview-strip";
import { NnTab } from "./ml/nn-tab";
import { AlgorithmsTab } from "./ml/algorithms-tab";
import { DataTab } from "./ml/data-tab";
import { TuningTab } from "./ml/tuning-tab";
import type { DriftStatus } from "./ml/shared";

/**
 * Phiên #89 — module "Học máy & Học tăng cường" CHUYỂN SANG 5 TAB (nội dung
 * cũ dài cuộn dọc — trader muốn thấy & tinh chỉnh nhiều phần hơn):
 *
 *   1. Tổng quan     — dải 8 thẻ mini nhìn-xong-liền + 4 khối chi tiết
 *                      (MLP · Cổng B2 · Q-learning · Bandit) + nút hành động.
 *   2. Mạng thần kinh— sơ đồ MLP vẽ bằng TRỌNG SỐ THẬT bản serving (cạnh
 *                      dày/mảnh theo |w|, xanh/đỏ theo dấu, dòng chảy động)
 *                      + sơ đồ GRU-24 3 cổng + công thức ensemble.
 *   3. Thuật toán    — 10 thuật toán đang chạy: file · hàm thật · hằng số thật.
 *   4. Dữ liệu       — dòng chảy 8 chặng (nguồn → quyết định) + trình duyệt
 *                      34 model Prisma (tìm kiếm · lọc nhóm · chi tiết) + RAG.
 *   5. Tinh chỉnh    — ô nhập hyper MLP/RAG GHI THẬT vào AppSetting
 *                      ml-tuning + kill-switch GRU + reset vòng học Bandit.
 *
 * Backend 35-ML chạy song song: GET /api/ml/status có thể 404 → render
 * empty-state (query vẫn polling 30s để tự lành). Màu chỉ dùng
 * emerald / rose / amber / neutral theo token ngữ nghĩa của app.
 */

const TABS = [
  { value: "overview", label: "Tổng quan" },
  { value: "network", label: "Mạng thần kinh" },
  { value: "algorithms", label: "Thuật toán" },
  { value: "data", label: "Dữ liệu" },
  { value: "tuning", label: "Tinh chỉnh" },
] as const;

export function MlPanel() {
  const { data, isLoading, isError, error, refetch } = useMlStatus();
  const train = useTrainMl();
  const settle = useSettleMl();

  // 404 = backend 35-ML chưa merge → empty-state lịch sự (không crash).
  const waitingBackend = isError && isMlNotFound(error);
  // Khi chưa có backend thì không cho train (POST cũng 404 → chỉ toast lỗi).
  const trainDisabled = train.isPending || waitingBackend;

  // A3 — field `drift` additive trên payload; đọc qua cast cục bộ tolerant.
  const drift =
    (data as ({ drift?: DriftStatus } | undefined))?.drift ?? null;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <span
            className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted"
            aria-hidden="true"
          >
            <Brain className="size-4 text-foreground/80" />
          </span>
          Học máy &amp; Học tăng cường
        </CardTitle>
        <CardDescription>
          5 tab: tổng quan 3 mô hình học thật (MLP backprop+Adam · Q-learning
          tabular · Thompson sampling) · mạng thần kinh &amp; trọng số · thuật
          toán &amp; hàm · kiến trúc dữ liệu · tinh chỉnh vận hành thật
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {isLoading ? (
          <MlPanelSkeleton />
        ) : waitingBackend ? (
          <WaitingBackend />
        ) : isError ? (
          <MlErrorState
            message={error?.message ?? ""}
            onRetry={() => void refetch()}
          />
        ) : (
          <Tabs defaultValue="overview">
            <div className="overflow-x-auto custom-scrollbar pb-1">
              <TabsList className="w-max">
                {TABS.map((t) => (
                  <TabsTrigger key={t.value} value={t.value} className="text-xs">
                    {t.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>

            {/* ── Tab 1 · Tổng quan ── */}
            <TabsContent value="overview" className="mt-4 flex flex-col gap-4">
              <OverviewStrip data={data} drift={drift} />

              {/* Khối 1 — MLP dự báo 5 phiên (học sâu) */}
              <MlpBlock model={data?.dlMlp ?? null} drift={drift} />

              <Separator />

              {/* B2/B3/B4 — Cổng bằng chứng chuỗi + GRU giọng thứ ba */}
              <GateBlock gate={data?.gate ?? null} gru={data?.gru ?? null} />

              <Separator />

              {/* Khối 2 — Q-learning Gym (học tăng cường) */}
              <RlBlock model={data?.rlQ ?? null} />

              <Separator />

              {/* Khối 3 — Bandit Thompson sampling (trọng số phiếu LLM) */}
              <BanditBlock
                bandit={data?.bandit ?? null}
                pendingSettles={data?.pendingSettles ?? 0}
              />

              {/* Hành động — cuối tab */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-4">
                <TooltipProvider delayDuration={200}>
                  <UiTooltip>
                    <TooltipTrigger asChild>
                      <Button
                        className="min-h-11 gap-2"
                        onClick={() => train.mutate("all")}
                        disabled={trainDisabled}
                      >
                        {train.isPending ? (
                          <>
                            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                            Đang huấn luyện…
                          </>
                        ) : (
                          <>
                            <Zap className="size-4" aria-hidden="true" />
                            Huấn luyện mô hình
                          </>
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      Train lại MLP + Q-learning trên dữ liệu EOD thật — dùng
                      cấu hình tab Tinh chỉnh
                    </TooltipContent>
                  </UiTooltip>
                  <UiTooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        className="min-h-11 gap-2"
                        onClick={() => settle.mutate()}
                        disabled={settle.isPending || waitingBackend}
                      >
                        {settle.isPending ? (
                          <>
                            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                            Đang kết toán…
                          </>
                        ) : (
                          <>
                            <Coins className="size-4" aria-hidden="true" />
                            Kết toán reward
                          </>
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      Kết toán ngay phiếu bầu đã đủ 5 phiên vào posterior Beta
                      (idempotent — engine 16:15 ICT vẫn chạy như thường)
                    </TooltipContent>
                  </UiTooltip>
                </TooltipProvider>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Huấn luyện lại chạy đúng thuật toán trong code — không tốn chi
                  phí LLM. Kết toán reward cũng 0 LLM.
                </p>
              </div>
            </TabsContent>

            {/* ── Tab 2 · Mạng thần kinh ── */}
            <TabsContent value="network" className="mt-4">
              <NnTab />
            </TabsContent>

            {/* ── Tab 3 · Thuật toán ── */}
            <TabsContent value="algorithms" className="mt-4">
              <AlgorithmsTab />
            </TabsContent>

            {/* ── Tab 4 · Dữ liệu & kiến trúc ── */}
            <TabsContent value="data" className="mt-4">
              <DataTab />
            </TabsContent>

            {/* ── Tab 5 · Tinh chỉnh ── */}
            <TabsContent value="tuning" className="mt-4">
              <TuningTab />
            </TabsContent>
          </Tabs>
        )}
      </CardContent>
    </Card>
  );
}

/* ─────────────────── Trạng thái đặc biệt ─────────────────── */

/** Backend 35-ML chưa merge (GET 404) — empty-state lịch sự, query polling tự lành. */
function WaitingBackend() {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-dashed bg-muted/20 p-4">
      <Clock
        className="mt-0.5 size-4 shrink-0 animate-pulse text-muted-foreground"
        aria-hidden="true"
      />
      <div className="min-w-0">
        <p className="text-sm font-medium">Đang chờ backend học máy</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          API /api/ml/status chưa sẵn sàng (đang được triển khai song song) —
          thẻ tự động tải lại mỗi 30 giây khi có dữ liệu.
        </p>
      </div>
    </div>
  );
}

/** Lỗi khác 404 — banner + Thử lại (không crash workspace). */
function MlErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-down/40 bg-down/10 p-4 text-sm text-down"
    >
      <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
      <p className="min-w-40 flex-1 leading-relaxed">
        Không tải được trạng thái học máy{message ? ` — ${message}` : "."}
      </p>
      <Button variant="outline" size="sm" className="gap-2" onClick={onRetry}>
        <RefreshCw className="size-3.5" aria-hidden="true" />
        Thử lại
      </Button>
    </div>
  );
}

/* ─────────────────── Skeleton ─────────────────── */

function MlPanelSkeleton() {
  return (
    <div
      className="flex flex-col gap-4"
      aria-busy="true"
      aria-label="Đang tải trạng thái học máy"
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-14 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-10 w-2/3" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-14 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-40 w-full rounded-lg" />
    </div>
  );
}
