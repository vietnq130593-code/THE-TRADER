"use client";

import { AGENT_STATUS_DOT } from "@/components/dashboard/agent-roster-card";
import { cn } from "@/lib/utils";
import type { AgentCard } from "@/lib/types";

/**
 * M4.3.1 (UIUX_UPGRADE_BLUEPRINT §4 — Đội Agent 5.5 → 7.5) — dải 23 chấm
 * trạng thái "map sức khoẻ đội": 1 agent = 1 chấm, đọc cả đội trong 1 giây.
 *
 * Màu theo §3.1: RUNNING = PRIMARY + soft-pulse · ERROR = đỏ · PAUSED =
 * amber · IDLE = mờ. Chấm bấm được (vùng đấm 24×24 cho từng chấm size-2.5)
 * → onSelect(agent) mở panel chi tiết như bấm thẻ/hàng agent.
 */

/** Màu chấm squad — dùng chung strip + hàng agent gọn (M4.3.2). */
export function squadDotClass(status: string): string {
  switch (status) {
    case "RUNNING":
      return "bg-primary animate-soft-pulse";
    case "ERROR":
      return "bg-down";
    case "PAUSED":
      return "bg-amber-500";
    default:
      return "bg-muted-foreground/40";
  }
}

/** Nhãn tiếng Việt của trạng thái runtime (RUNNING/ERROR/PAUSED/IDLE). */
export function squadStatusLabel(status: string): string {
  return (AGENT_STATUS_DOT[status] ?? AGENT_STATUS_DOT.IDLE).label;
}

/** Tooltip/aria-label 1 chấm: "tên — nhóm — trạng thái — sức khoẻ N%". */
function dotLabel(agent: AgentCard): string {
  const health = Math.max(0, Math.min(100, Math.round(agent.healthScore)));
  return `${agent.name} — ${agent.groupLabel} — ${squadStatusLabel(agent.status)} — sức khoẻ ${health}%`;
}

export interface SquadHealthStripProps {
  /** Agents hiển thị (đã qua bộ lọc nhóm của workspace). */
  agents: AgentCard[];
  /** Agent đang mở panel chi tiết — chấm tương ứng được đánh dấu. */
  selectedId: string | null;
  /** Bấm chấm → mở hồ sơ agent (cùng luồng bấm thẻ/hàng agent). */
  onSelect: (agent: AgentCard) => void;
}

export function SquadHealthStrip({
  agents,
  selectedId,
  onSelect,
}: SquadHealthStripProps) {
  const counts: Record<string, number> = { RUNNING: 0, ERROR: 0, PAUSED: 0, IDLE: 0 };
  for (const a of agents) {
    const key = a.status in counts ? a.status : "IDLE";
    counts[key] += 1;
  }
  const legend: { key: string; label: string; dot: string; count: number }[] = [
    { key: "RUNNING", label: "Đang chạy", dot: "bg-primary", count: counts.RUNNING },
    { key: "ERROR", label: "Lỗi", dot: "bg-down", count: counts.ERROR },
    { key: "PAUSED", label: "Tạm dừng", dot: "bg-amber-500", count: counts.PAUSED },
    { key: "IDLE", label: "Nhàn rỗi", dot: "bg-muted-foreground/40", count: counts.IDLE },
  ];

  return (
    <div className="flex flex-col gap-2.5">
      <div
        className="flex flex-wrap gap-0.5"
        role="group"
        aria-label={`Dải trạng thái ${agents.length} agent — bấm chấm để mở hồ sơ`}
      >
        {agents.map((a) => {
          const selected = selectedId === a.id;
          const label = dotLabel(a);
          return (
            <button
              key={a.id}
              type="button"
              title={label}
              aria-label={label}
              aria-pressed={selected}
              onClick={() => onSelect(a)}
              className={cn(
                "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
                selected ? "bg-accent" : "hover:bg-accent/60",
              )}
            >
              <span
                className={cn("size-2.5 rounded-full", squadDotClass(a.status))}
                aria-hidden="true"
              />
            </button>
          );
        })}
      </div>
      {/* Legend 4 mục — chấm + nhãn + đếm (theo tập agent đang hiển thị) */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {legend.map((l) => (
          <span
            key={l.key}
            className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
          >
            <span className={cn("size-2 shrink-0 rounded-full", l.dot)} aria-hidden="true" />
            {l.label}
            <span className="tabular-nums font-medium text-foreground">{l.count}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
