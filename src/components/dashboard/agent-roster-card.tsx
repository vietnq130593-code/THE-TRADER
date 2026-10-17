"use client";

import * as React from "react";
import { formatDistanceToNow } from "date-fns";
import { vi } from "date-fns/locale";
import {
  Bell,
  BookOpen,
  Boxes,
  Brain,
  ChartCandlestick,
  Compass,
  Cpu,
  Database,
  Droplets,
  FileCheck2,
  Gamepad2,
  Globe2,
  GraduationCap,
  History,
  Layers,
  Loader2,
  Newspaper,
  Play,
  Radar,
  Receipt,
  Scale,
  ScanSearch,
  ShieldAlert,
  TrendingUp,
  Wallet,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { AgentCard } from "@/lib/types";

/** Icon theo vai agent — dùng chung roster card + detail panel (PHASE3 §4.7).
 *  Mở rộng 24 agents (#126 thêm A20 macro-economist — icon Globe2): đủ icon
 *  cho toàn bộ role enum phía backend. */
export const AGENT_ROLE_ICONS: Record<
  string,
  React.ComponentType<{ className?: string }>
> = {
  MARKET_ANALYST: ChartCandlestick,
  NEWS_SENTIMENT: Newspaper,
  RISK_MANAGER: ShieldAlert,
  PORTFOLIO_STRATEGIST: Brain,
  EXECUTION_MANAGER: Zap,
  FAIR_VALUE: Scale,
  LIQUIDITY: Droplets,
  ML_FORECAST: TrendingUp,
  MACRO_ECONOMIST: Globe2,
  EXPOSURE: Radar,
  COMPLIANCE: FileCheck2,
  SETTLEMENT: Receipt,
  CASH_MANAGEMENT: Wallet,
  DATA_COLLECTOR: Database,
  NOTIFICATION_OFFICER: Bell,
  FEATURE_STORE: Boxes,
  DATA_INTEGRITY: ScanSearch,
  LEARNING_RAG: BookOpen,
  BACKTEST: History,
  RL_GYM: Gamepad2,
  RL_POLICY: Compass,
  DL_TRAINER: Cpu,
  RL_TRAINER: GraduationCap,
  MODEL_REGISTRY: Layers,
};

export const AGENT_STATUS_DOT: Record<
  string,
  { className: string; label: string }
> = {
  RUNNING: { className: "bg-up", label: "Đang chạy" },
  IDLE: { className: "bg-muted-foreground", label: "Nhàn rỗi" },
  PAUSED: { className: "bg-amber-500", label: "Tạm dừng" },
  ERROR: { className: "bg-down", label: "Lỗi" },
};

/** Màu thanh health theo ngưỡng: ≥80 up · ≥60 amber · <60 down. */
export function agentHealthColor(health: number): string {
  if (health >= 80) return "[&_[data-slot=progress-indicator]]:bg-up";
  if (health >= 60) return "[&_[data-slot=progress-indicator]]:bg-amber-500";
  return "[&_[data-slot=progress-indicator]]:bg-down";
}

/** successRate backend trả tỷ lệ 0–1 (hoặc % thẳng) — chuẩn hoá về %. */
export function agentSuccessPct(successRate: number): number {
  return Math.round(successRate <= 1 ? successRate * 100 : successRate);
}

interface AgentRosterCardProps {
  agent: AgentCard;
  selected: boolean;
  onSelect: () => void;
  onRun: () => void;
  runPending: boolean;
  /** Giây còn phải chờ sau 429 (RateLimitError) — workspace cha tick giảm. */
  retryAfterSeconds?: number | null;
}

/**
 * PHASE3_BLUEPRINT §4.7 — card agent trong roster workspace "Đội Agent":
 * icon vai + tên + trạng thái + health + stats chi phí + nút chạy riêng
 * (đếm ngược rate-limit). Click card → mở panel chi tiết.
 */
export function AgentRosterCard({
  agent,
  selected,
  onSelect,
  onRun,
  runPending,
  retryAfterSeconds = null,
}: AgentRosterCardProps) {
  const RoleIcon = AGENT_ROLE_ICONS[agent.role] ?? Brain;
  const dot = AGENT_STATUS_DOT[agent.status] ?? AGENT_STATUS_DOT.IDLE;
  const isExec = agent.code === "execution-manager";
  const health = Math.max(0, Math.min(100, agent.healthScore));

  // Đếm ngược rate-limit 429 — workspace cha giữ + tick giảm mỗi giây,
  // card chỉ hiển thị giá trị suy ra từ prop (thuần khi render).
  const countdown = Math.max(0, Math.ceil(retryAfterSeconds ?? 0));
  const counting = countdown > 0;

  const running = agent.status === "RUNNING";
  const runDisabled = runPending || counting || running;
  const runTitle = isExec
    ? "Execution Manager chỉ chạy trong chu kỳ đầy đủ"
    : running
      ? "Agent đang chạy chu kỳ"
      : counting
        ? `Vui lòng đợi thêm ${countdown} giây`
        : runPending
          ? "Đang chạy phân tích…"
          : "Chạy riêng agent này ngay bây giờ";

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`Xem chi tiết agent ${agent.name}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "flex cursor-pointer flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground shadow-sm outline-none transition-shadow hover:shadow-md focus-visible:ring-[3px] focus-visible:ring-ring/50",
        selected ? "border-primary ring-1 ring-primary/40" : "border-border",
        health < 60 && !selected && "border-amber-500/50 ring-1 ring-amber-500/30"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
            <RoleIcon className="size-4.5 text-foreground/80" aria-hidden="true" />
          </span>
          <div className="leading-tight">
            <p className="text-sm font-semibold">{agent.name}</p>
            <p className="text-[11px] text-muted-foreground">{agent.roleLabel}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 pt-1">
          {agent.group === "control" && (
            <Badge
              variant="outline"
              className="border-amber-500/40 px-1.5 py-0 text-[10px] font-semibold tracking-wide text-amber-600 dark:text-amber-400"
              title="Ủy ban Kiểm soát — có quyền phủ quyết (VETO) tín hiệu"
            >
              VETO
            </Badge>
          )}
          <span className="flex items-center gap-1.5" title={dot.label}>
            <span className="relative flex size-2">
              {running && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-up opacity-60" />
              )}
              <span
                className={cn(
                  "relative inline-flex size-2 rounded-full",
                  agent.status === "ERROR" ? "bg-down" : dot.className
                )}
                aria-hidden="true"
              />
            </span>
            <span className="text-[10px] text-muted-foreground">{dot.label}</span>
          </span>
        </div>
      </div>

      <p className="truncate text-[11px] leading-relaxed text-muted-foreground" title={agent.description}>
        {agent.description}
      </p>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>Sức khỏe</span>
          <span className="tabular-nums font-medium text-foreground">
            {health.toFixed(0)}%
          </span>
        </div>
        <Progress value={health} className={cn("h-1.5", agentHealthColor(health))} />
      </div>

      {agent.stats ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary" className="tabular-nums text-[10px]">
            {agent.stats.runCount} lần chạy
          </Badge>
          <Badge variant="secondary" className="tabular-nums text-[10px]">
            thành công {agentSuccessPct(agent.stats.successRate)}%
          </Badge>
          <Badge variant="secondary" className="tabular-nums text-[10px]">
            ${agent.stats.totalCostUsd.toFixed(2)}
          </Badge>
        </div>
      ) : null}

      <div className="mt-auto flex items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">
          {agent.lastRunAt
            ? `Chạy ${formatDistanceToNow(new Date(agent.lastRunAt), {
                locale: vi,
                addSuffix: true,
              })}`
            : "Chưa từng chạy"}
        </p>
        {isExec ? (
          <Badge
            variant="outline"
            className="border-amber-500/40 text-[10px] text-amber-600 dark:text-amber-400"
            title="Execution Manager cần Signal đầu vào — chỉ chạy trong chu kỳ orchestrator đầy đủ"
          >
            Chỉ chạy trong chu kỳ
          </Badge>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-9 gap-1.5"
            disabled={runDisabled}
            title={runTitle}
            aria-label={`Chạy riêng ${agent.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onRun();
            }}
          >
            {counting ? (
              `Chờ ${countdown}s`
            ) : runPending ? (
              <>
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                Đang chạy…
              </>
            ) : (
              <>
                <Play className="size-3.5" aria-hidden="true" />
                Chạy riêng
              </>
            )}
          </Button>
        )}
      </div>
    </div>
  );
}
