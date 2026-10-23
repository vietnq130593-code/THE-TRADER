"use client";

import * as React from "react";
import {
  AlertTriangle,
  Clock,
  Coins,
  Loader2,
  RefreshCw,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
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
  type MlAutoRetrainStatus,
  type MlSsStatus,
} from "@/hooks/use-ml";
import { MlpBlock } from "./ml/mlp-block";
import { GateBlock } from "./ml/gate-block";
import { RlBlock } from "./ml/rl-block";
import { BanditBlock } from "./ml/bandit-block";
import { OverviewStrip } from "./ml/overview-strip";
import type { DriftStatus } from "./ml/shared";

/**
 * PHIÊN #90 — refactor theo hiệu lệnh trader: KHÔNG còn "module Học máy" riêng
 * nằm đuôi dưới workspace Tổng hợp (trader: "module Học máy với 5 tab của bạn
 * đúng ra từ module Tổng hợp mà ra — không cần module học máy, chỉ cần chia
 * module tổng hợp thành các tab hợp lý").
 *
 * MlPanel (Card + Tabs 5 cấp lồng) được PHÂN GIẢI:
 *   - MlOverviewTab (file này)   → tab "Học máy" của workspace Tổng hợp
 *                                  (dải 8 thẻ mini + 4 khối chi tiết + nút
 *                                  Huấn luyện/Kết toán reward).
 *   - NnTab/AlgorithmsTab/DataTab/TuningTab (src/components/dashboard/ml/)
 *                                → 4 tab ngang hàng còn lại của workspace.
 *
 * Tab này giữ nguyên 100% nội dung & hành vi tab "Tổng quan" phiên #89 —
 * chỉ thay vỏ: bỏ Card bao ngoài (workspace đã có header), bỏ Tabs lồng.
 *
 * Backend 35-ML chạy song song: GET /api/ml/status có thể 404 → render
 * empty-state (query vẫn polling 30s để tự lành). Màu chỉ dùng
 * emerald / rose / amber / neutral theo token ngữ nghĩa của app.
 */

export function MlOverviewTab() {
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
  // W3 (#164) — field `autoRetrain` additive (trạng thái cơ chế auto-retrain
  // theo PSI) — đọc qua cast cục bộ như drift.
  const autoRetrain =
    (data as ({ autoRetrain?: MlAutoRetrainStatus } | undefined))?.autoRetrain ?? null;
  // Task 176 — field `ss` additive (tầng State Space: A/B bóng holt-ss +
  // guard ngạc nhiên CUSUM) — đọc qua cast cục bộ như drift/autoRetrain.
  const ss = (data as ({ ss?: MlSsStatus } | undefined))?.ss ?? null;

  if (isLoading) {
    return <MlOverviewSkeleton />;
  }
  if (waitingBackend) {
    return <WaitingBackend />;
  }
  if (isError) {
    return (
      <MlErrorState
        message={error?.message ?? ""}
        onRetry={() => void refetch()}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <OverviewStrip data={data} drift={drift} />

      {/* Khối 1 — MLP dự báo 5 phiên (học sâu) */}
      <MlpBlock model={data?.dlMlp ?? null} drift={drift} autoRetrain={autoRetrain} ss={ss} />

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
    </div>
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

function MlOverviewSkeleton() {
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
