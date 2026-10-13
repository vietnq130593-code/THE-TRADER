"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Bot } from "lucide-react";
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
import { apiGet } from "@/lib/api";
import { useUiStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { AgentsResponse } from "@/lib/types";
// F-1113-05 (fixbug #111): thứ tự nhóm MỘT nguồn từ agent-roster (như agents-workspace).
import { AGENT_GROUP_ORDER as GROUP_ORDER } from "@/lib/agent-roster";

/**
 * Phiên #34 — card tóm tắt hệ thống 23 agents (5 nhóm) trên Tổng quan.
 * Mỗi nhóm 1 hàng: tên + badge số lượng + chấm trạng thái tổng (đỏ khi có
 * agent ERROR, xanh nhấp nháy khi có agent RUNNING). Hàng cuối: link sang
 * workspace Đội Agent + model LLM đang chạy (phiên #47 — nút chạy chu kỳ
 * dời hết về nút "Chạy agent" duy nhất trên thanh bar trên cùng).
 */

const GROUP_LABELS: Record<string, string> = {
  research: "Hội đồng nghiên cứu",
  control: "Ủy ban kiểm soát",
  executive: "Điều hành & thực thi",
  platform: "Nền tảng dữ liệu",
  ml: "Học máy",
};

interface GroupStatus {
  key: string;
  label: string;
  count: number;
  error: number;
  running: number;
}

function groupStatuses(agents: AgentsResponse["agents"]): GroupStatus[] {
  const rows: GroupStatus[] = GROUP_ORDER.map((key) => ({
    key,
    label: GROUP_LABELS[key] ?? key,
    count: 0,
    error: 0,
    running: 0,
  }));
  const byKey = new Map<string, GroupStatus>(rows.map((r) => [r.key, r]));
  const other: GroupStatus = {
    key: "other",
    label: "Khác",
    count: 0,
    error: 0,
    running: 0,
  };
  for (const a of agents) {
    const row = byKey.get(a.group) ?? other;
    row.count += 1;
    if (a.status === "ERROR") row.error += 1;
    if (a.status === "RUNNING") row.running += 1;
  }
  return [...rows, other].filter((r) => r.count > 0);
}

export function AgentSystemBrief() {
  const setActiveWorkspace = useUiStore((s) => s.setActiveWorkspace);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["agents"],
    queryFn: () => apiGet<AgentsResponse>("/api/agents"),
    staleTime: 30_000,
  });

  // Giữ tham chiếu ổn định từ cache (tránh useMemo deps đổi mỗi render).
  const agents = data?.agents;
  const agentList = agents ?? [];
  const groups = React.useMemo(() => groupStatuses(agents ?? []), [agents]);
  const errorCount = agentList.filter((a) => a.status === "ERROR").length;
  const runningCount = agentList.filter((a) => a.status === "RUNNING").length;

  return (
    <section aria-label="Hệ thống đa tác tử — tóm tắt">
      <Card className="gap-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Bot className="size-4 text-muted-foreground" aria-hidden="true" />
            Hệ thống đa tác tử
          </CardTitle>
          <CardDescription>
            {data
              ? `${agentList.length} agents · 5 nhóm · nền tảng dữ liệu → nghiên cứu → kiểm soát VETO → chủ tịch → thực thi`
              : "23 agents · 5 nhóm phối hợp"}
          </CardDescription>
          <CardAction>
            <Button
              variant="ghost"
              size="sm"
              className="min-h-9 gap-1 text-xs text-muted-foreground"
              onClick={() => setActiveWorkspace("agents")}
              aria-label="Mở workspace Đội Agent"
            >
              Xem đội agent
              <ArrowRight className="size-3" aria-hidden="true" />
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {isLoading ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          ) : isError ? (
            <p className="text-sm text-down">
              {error?.message ?? "Không tải được danh sách agent."}
            </p>
          ) : (
            <ul className="flex flex-col divide-y rounded-lg border">
              {groups.map((g) => {
                const hasError = g.error > 0;
                const hasRunning = g.running > 0;
                return (
                  <li
                    key={g.key}
                    className="flex min-h-11 items-center gap-2 px-3 py-1.5 text-sm"
                  >
                    <span className="min-w-0 flex-1 truncate">{g.label}</span>
                    <Badge variant="secondary" className="tabular-nums text-[10px]">
                      {g.count} agent
                    </Badge>
                    <span className="flex w-24 items-center justify-end gap-1.5 text-[11px] text-muted-foreground">
                      <span className="relative flex size-2">
                        {hasRunning && (
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-up opacity-60" />
                        )}
                        <span
                          className={cn(
                            "relative inline-flex size-2 rounded-full",
                            hasError ? "bg-down" : hasRunning ? "bg-up" : "bg-muted-foreground"
                          )}
                          aria-hidden="true"
                        />
                      </span>
                      {hasError
                        ? `${g.error} lỗi`
                        : hasRunning
                          ? "đang chạy"
                          : "ổn định"}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {(runningCount > 0 || errorCount > 0) && (
                <span
                  className={cn(
                    "mr-2 font-medium",
                    errorCount > 0 ? "text-down" : "text-up"
                  )}
                >
                  {errorCount > 0 ? `${errorCount} lỗi` : `${runningCount} đang chạy`} ·
                </span>
              )}
              Model đang chạy{" "}
              <span
                className="font-mono text-foreground"
                title={data?.llm?.modelLabel}
              >
                {data?.llm?.modelLabel ?? data?.llm?.model ?? "…"}
              </span>
            </p>
            {/* Phiên #47 — nút "Chạy chu kỳ 23 agents" bị XOÁ: nút "Chạy agent"
                trên thanh bar trên cùng là nút chạy chu kỳ DUY NHẤT của app. */}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
