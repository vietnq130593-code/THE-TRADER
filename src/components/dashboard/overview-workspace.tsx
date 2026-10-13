"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ClipboardCheck, Gauge, Radar, Wallet } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { MarketSummary } from "@/components/dashboard/market-summary";
import { AssessmentBrief } from "@/components/dashboard/assessment-brief";
import { AgentSystemBrief } from "@/components/dashboard/agent-system-brief";
import { NewsCard } from "@/components/dashboard/news-card";
import { SignalsFeed } from "@/components/dashboard/signals-feed";
import { TodoPanel } from "@/components/dashboard/overview/todo-panel";
import { StatTile, type StatTileTone } from "@/components/dashboard/kit";
import {
  SIGNAL_DIRECTION,
  consensusMeta,
} from "@/components/dashboard/signals/signal-detail-dialog";
import { useCouncilOverview } from "@/hooks/use-council";
import { useDateRange } from "@/hooks/use-date-range";
import { apiGet } from "@/lib/api";
import { formatPct, formatVndCompact } from "@/lib/format";
import { useUiStore } from "@/lib/store";
import type {
  CouncilAccountView,
  QuotesResponse,
  SignalRow,
} from "@/lib/types";

/**
 * M4.4 (UIUX_UPGRADE_BLUEPRINT §4 — #110-d): workspace "Tổng quan" 6.5 → 7.5.
 * "Một màn hình trả lời 3 câu hỏi" trong 3 giây:
 *
 *  (1) TIER-1 "Bảng chốt phiên" — 3 StatTile lớn mở đầu: VN30 · tín hiệu mới
 *      nhất · P&L Hội đồng hôm nay (D-LEDGER #106 có dữ liệu thật).
 *  (2) TIER-2 — MarketSummary (stat cards + pulse bar) đặt ngay dưới bảng
 *      chốt phiên: bảng chốt phiên PHÓNG TO 3 số quan trọng nhất, MarketSummary
 *      giữ vai trò chi tiết (bề rộng · thanh khoản · tăng giá nhất).
 *  (3) Trái 2/3 — Nhận định Bayes + Tin nhanh 5 tiêu đề (M4.4.2) + Tín hiệu
 *      compact (#110-b); phải 1/3 — "Việc cần làm" (M4.4.3) + tóm tắt đội
 *      agent. Mobile xếp dọc — TodoPanel xuống cuối.
 *
 * Unmount sạch khi chuyển tab — realtime socket sống ở cấp page.tsx.
 */

/* ─────────────────── M4.4.1 — Tier-1 "Bảng chốt phiên" ─────────────────── */

/** Màu ngữ nghĩa #45: dương → up · âm → down · 0/null → flat (amber). */
function signTone(n: number | null | undefined): StatTileTone {
  if (n == null || Number.isNaN(n) || n === 0) return "flat";
  return n > 0 ? "up" : "down";
}

/**
 * Sub "từ lúc kích hoạt" — % khi có nghĩa (|pct| ≥ 0,005), còn lại về số
 * VND (tránh hiển thị trung thực "-0,00%" khi chênh lệch bé hơn nửa chữ số lẻ).
 */
function sinceActivationSub(account: CouncilAccountView | undefined): string {
  const pct = account?.pnlPctSinceActivation;
  const vnd = account?.pnlSinceActivation;
  if (pct != null && Math.abs(pct) >= 0.005) {
    return `từ lúc kích hoạt ${formatPct(pct)}`;
  }
  if (vnd != null && vnd !== 0) {
    return `từ lúc kích hoạt ${formatVndCompact(vnd)}`;
  }
  if (pct != null || vnd != null) return "từ lúc kích hoạt ±0,00%";
  return "từ lúc kích hoạt —";
}

/** Skeleton đúng kích thước 1 StatTile (label h-4 · value h-7 · sub h-3.5). */
function StatTileSkeleton() {
  return (
    <div className="kpi-tile flex min-w-0 flex-col gap-1 rounded-lg border p-3">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-7 w-32" />
      <Skeleton className="h-3.5 w-28" />
    </div>
  );
}

function SessionClosePanel() {
  const { rangeQuery, rangeKey } = useDateRange();

  // Cả 3 query DÙNG CHUNG cache (không thêm request): ["quotes"] với
  // MarketSummary/QuotesTable · ["signals", rangeKey] với SignalsFeed ·
  // ["council-overview", rangeKey] với council-workspace (#105 pattern).
  const quotesQuery = useQuery({
    queryKey: ["quotes"],
    queryFn: () => apiGet<QuotesResponse>("/api/market/quotes"),
    staleTime: 30_000,
  });
  const signalsQuery = useQuery({
    queryKey: ["signals", rangeKey],
    queryFn: () =>
      apiGet<{ signals: SignalRow[] }>(`/api/signals${rangeQuery ? `?${rangeQuery}` : ""}`),
    staleTime: 60_000,
  });
  const councilQuery = useCouncilOverview(rangeQuery, rangeKey);

  // VN30 — cùng nguồn suy luận với MarketSummary ("VN30 chỉ số proxy" từ
  // summary.avgChangePct trung bình 30 mã HOSE; quotes không có quote INDEX VN).
  const s = quotesQuery.data?.summary;
  const vn30Tone: StatTileTone = quotesQuery.isError ? "neutral" : signTone(s?.avgChangePct);
  const vn30Sub = quotesQuery.isError
    ? "không tải được dữ liệu thị trường"
    : s == null
      ? "—"
      : s.avgChangePct > 0
        ? "hướng tăng hôm nay"
        : s.avgChangePct < 0
          ? "hướng giảm hôm nay"
          : "đi ngang hôm nay";

  // Tín hiệu mới nhất — signals[0] (API trả mới nhất trước).
  const latest = signalsQuery.data?.signals[0];
  const dir = latest ? (SIGNAL_DIRECTION[latest.direction] ?? SIGNAL_DIRECTION.HOLD) : null;
  const cons = latest ? consensusMeta(latest.consensusGate, latest.consensusRatio) : null;
  const signalTone: StatTileTone = latest
    ? latest.direction === "BUY"
      ? "up"
      : latest.direction === "SELL"
        ? "down"
        : "flat"
    : "neutral";

  // P&L Hội đồng hôm nay — account sandbox K1 (D-LEDGER #106).
  const account = councilQuery.data?.account;
  const councilReady = account != null && account.configured === true;
  const dayChange = account?.dayChange;
  const pnlTone: StatTileTone = councilQuery.isError || !councilReady
    ? "neutral"
    : signTone(dayChange);

  return (
    <section aria-label="Bảng chốt phiên">
      <Card className="gap-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardCheck className="size-4 text-primary" aria-hidden="true" />
            Bảng chốt phiên
          </CardTitle>
          <CardDescription>
            Ba câu trả lời nhanh nhất: thị trường đang thế nào · tín hiệu mới nhất ·
            P&amp;L Hội đồng
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {/* 1 — VN30 */}
            {quotesQuery.isLoading ? (
              <StatTileSkeleton />
            ) : (
              <StatTile
                label="VN30"
                value={s ? formatPct(s.avgChangePct) : "—"}
                tone={vn30Tone}
                sub={vn30Sub}
                icon={Gauge}
              />
            )}

            {/* 2 — Tín hiệu mới nhất */}
            {signalsQuery.isLoading ? (
              <StatTileSkeleton />
            ) : (
              <StatTile
                label="Tín hiệu mới nhất"
                value={latest && dir ? `${dir.upper} ${latest.symbol}` : "—"}
                tone={signalTone}
                sub={
                  signalsQuery.isError
                    ? "không tải được tín hiệu"
                    : latest
                      ? `score ${latest.score.toFixed(0)}/100 · ${cons?.label ?? "chưa qua hội đồng"}`
                      : "chưa có tín hiệu nào"
                }
                icon={Radar}
              />
            )}

            {/* 3 — P&L Hội đồng hôm nay */}
            {councilQuery.isLoading ? (
              <StatTileSkeleton />
            ) : (
              <StatTile
                label="P&L Hội đồng hôm nay"
                value={councilReady ? formatVndCompact(dayChange ?? null) : "—"}
                tone={pnlTone}
                sub={
                  councilQuery.isError
                    ? "không tải được dữ liệu hội đồng"
                    : councilReady
                      ? sinceActivationSub(account)
                      : "chưa kích hoạt thử nghiệm"
                }
                icon={Wallet}
              />
            )}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

/* ─────────────────── Workspace Tổng quan ─────────────────── */

export function OverviewWorkspace() {
  const setActiveWorkspace = useUiStore((s) => s.setActiveWorkspace);

  return (
    <div
      role="tabpanel"
      id="workspace-panel-overview"
      aria-labelledby="workspace-tab-overview"
      className="flex flex-col gap-6"
    >
      <h2 className="sr-only">Tổng quan — bảng chốt phiên, tin nhanh &amp; việc cần làm</h2>

      {/* M4.4.1 — Tier-1: 3 số quan trọng nhất (3 giây hiểu §2.1) */}
      <SessionClosePanel />

      {/* Tier-2 — chi tiết thị trường: stat cards + pulse bar (giữ nguyên
          MarketSummary — bảng chốt phiên phóng to 3 số, đây là phần chi tiết) */}
      <MarketSummary />

      {/* M4.4.2/M4.4.3 — trái 2/3: nhận định Bayes + tin nhanh 5 tiêu đề +
          tín hiệu compact; phải 1/3 (xl+): Việc cần làm + tóm tắt đội agent.
          Mobile: 1 cột — TodoPanel xuống cuối xếp dọc. */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="flex flex-col gap-6 xl:col-span-2">
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <AssessmentBrief />
            <NewsCard compact limit={5} onSeeAll={() => setActiveWorkspace("market")} />
          </div>
          <SignalsFeed compact limit={5} onSeeAll={() => setActiveWorkspace("signals")} />
        </div>
        <div className="flex flex-col gap-6">
          <TodoPanel />
          <AgentSystemBrief />
        </div>
      </div>
    </div>
  );
}
