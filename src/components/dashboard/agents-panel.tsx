"use client";

import * as React from "react";
import { useMemo } from "react";
import { useIsMutating, useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { vi } from "date-fns/locale";
import {
  ArrowRight,
  Brain,
  ChartCandlestick,
  CircleCheck,
  CircleDashed,
  CircleX,
  Loader2,
  Newspaper,
  Radio,
  ShieldAlert,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet } from "@/lib/api";
import { useSignalDecision } from "@/hooks/use-agent-actions";
import { RUN_AGENTS_MUTATION_KEY } from "@/hooks/use-run-agents";
import { useUiStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { AgentMessageRow, AgentsResponse, SignalRow } from "@/lib/types";

const ROLE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  MARKET_ANALYST: ChartCandlestick,
  NEWS_SENTIMENT: Newspaper,
  RISK_MANAGER: ShieldAlert,
  PORTFOLIO_STRATEGIST: Brain,
  EXECUTION_MANAGER: Zap,
};

/** Badge hướng tín hiệu cho khối phê duyệt/từ chối (PHASE3 B2 §4.5). */
const DIRECTION: Record<string, { label: string; className: string }> = {
  BUY: { label: "MUA", className: "bg-up/15 text-up hover:bg-up/15" },
  SELL: { label: "BÁN", className: "bg-down/15 text-down hover:bg-down/15" },
  HOLD: {
    label: "GIỮ",
    className: "border border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
};

export function AgentsPanel() {
  const setActiveWorkspace = useUiStore((s) => s.setActiveWorkspace);

  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: () => apiGet<AgentsResponse>("/api/agents"),
    staleTime: 30_000,
  });
  const messagesQuery = useQuery({
    queryKey: ["agent-messages"],
    queryFn: () =>
      apiGet<{ messages: AgentMessageRow[] }>("/api/agents/messages"),
    staleTime: 30_000,
  });
  // PHASE3 B2: signals ACTIVE để gắn nút Phê duyệt / Từ chối vào tin strategist.
  const signalsQuery = useQuery({
    queryKey: ["signals"],
    queryFn: () => apiGet<{ signals: SignalRow[] }>("/api/signals"),
    staleTime: 30_000,
  });

  // Phiên #47 — nút "Chạy chu kỳ phân tích" đã XOÁ (nút "Chạy agent" trên
  // thanh bar trên cùng là duy nhất). isRunning giờ đếm mutation đang chạy
  // TOÀN APP qua useIsMutating + mutationKey chia sẻ — nên hàng pulse
  // "Chu kỳ đa tác tử đang chạy" vẫn hiện đúng kể cả khi chu kỳ được kích
  // hoạt từ nút Header (trước đây state per-instance không thấy nhau).
  const isRunning = useIsMutating({ mutationKey: RUN_AGENTS_MUTATION_KEY }) > 0;

  const agents = agentsQuery.data?.agents ?? [];
  const tasks = agentsQuery.data?.tasks ?? [];
  const totals = agentsQuery.data?.totals;
  // Feed chỉ hiển thị tin của agent (bỏ tin USER chat 1-1 — §4.1 direction).
  const messages = (messagesQuery.data?.messages ?? []).filter(
    (m) => m.direction !== "USER"
  );
  const signals = signalsQuery.data?.signals ?? [];

  return (
    <section aria-label="Hệ thống đa tác tử" className="flex flex-col gap-4">
      <Card className="gap-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Radio className="size-4 text-muted-foreground" aria-hidden="true" />
            Hệ thống đa tác tử (Multi-Agent)
          </CardTitle>
          <CardDescription>
            {agents.length || 23} agents · 5 nhóm phối hợp: nền tảng dữ liệu → nghiên
            cứu → kiểm soát VETO → chủ tịch → thực thi
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* Phiên #34 — compact: lưới 23 thẻ agent đã chuyển sang workspace
              "Đội Agent" (roster đầy đủ); module này giữ header + nút chạy chu kỳ
              + feed broadcast + phê duyệt — không tràn cột hẹp 1/3. */}
          <Button
            variant="outline"
            size="sm"
            className="justify-start gap-2 text-xs text-muted-foreground"
            onClick={() => setActiveWorkspace("agents")}
            aria-label="Mở workspace Đội Agent"
          >
            Xem hồ sơ chi tiết 23 agents (workspace Đội Agent)
            <ArrowRight className="size-3" aria-hidden="true" />
          </Button>

          <Separator />

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-muted-foreground">
              Tổng cộng {agents.length} agent · mô hình nền tảng{" "}
              <span className="font-mono" title={agentsQuery.data?.llm?.modelLabel}>
                {agentsQuery.data?.llm?.model ?? "…"}
              </span>
              {totals ? (
                <>
                  {" · chi phí AI lũy kế "}
                  <span className="tabular-nums font-medium text-foreground">
                    ${totals.totalCostUsd.toFixed(2)}
                  </span>
                </>
              ) : null}
            </div>
            {/* Phiên #47 — nút "Chạy chu kỳ phân tích" XOÁ: dùng nút "Chạy agent"
                duy nhất trên thanh bar trên cùng. Hàng pulse “Chu kỳ đa tác tử
                đang chạy” phía dưới vẫn hiện đúng trạng thái đó qua useIsMutating. */}
          </div>
        </CardContent>
      </Card>

      {/* Tasks + message feed — dọc (cột hẹp 1/3 trong workspace Tín hiệu) */}
      <div className="grid grid-cols-1 gap-4">
        <Card className="gap-4">
          <CardHeader>
            <CardTitle className="text-sm">Nhiệm vụ agent</CardTitle>
            <CardDescription>12 nhiệm vụ gần nhất</CardDescription>
          </CardHeader>
          <CardContent className="pb-0">
            {agentsQuery.isLoading ? (
              <div className="flex flex-col gap-2 pb-4">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : tasks.length > 0 ? (
              <ul className="max-h-96 divide-y overflow-y-auto custom-scrollbar">
                {tasks.map((t) => (
                  <li key={t.id} className="flex min-h-11 items-center gap-3 py-2.5 pr-2">
                    <TaskStatusIcon status={t.status} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{t.title}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {t.agentName} ·{" "}
                        {formatDistanceToNow(new Date(t.createdAt), {
                          addSuffix: true,
                          locale: vi,
                        })}
                      </p>
                    </div>
                    <PriorityBadge priority={t.priority} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="pb-6 text-sm text-muted-foreground">
                Không có nhiệm vụ nào.
              </p>
            )}
          </CardContent>
        </Card>

        <Card className="gap-4">
          <CardHeader>
            <CardTitle className="text-sm">Luồng thảo luận giữa các agent</CardTitle>
            <CardDescription>30 tin nhắn gần nhất (mới nhất trước)</CardDescription>
          </CardHeader>
          <CardContent className="pb-0">
            {messagesQuery.isLoading ? (
              <div className="flex flex-col gap-3 pb-4">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex gap-3">
                    <Skeleton className="size-9 shrink-0 rounded-full" />
                    <div className="flex w-full flex-col gap-1.5">
                      <Skeleton className="h-3.5 w-40" />
                      <Skeleton className="h-4 w-full" />
                      <Skeleton className="h-4 w-2/3" />
                    </div>
                  </div>
                ))}
              </div>
            ) : messagesQuery.isError ? (
              <p className="pb-6 text-sm text-down">
                {messagesQuery.error?.message ?? "Không tải được tin nhắn."}
              </p>
            ) : (
              <ul className="max-h-[28rem] divide-y overflow-y-auto custom-scrollbar">
                {isRunning && (
                  <li className="flex items-center gap-3 py-3">
                    <span className="relative flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10">
                      <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />
                    </span>
                    <p className="animate-pulse text-sm text-muted-foreground">
                      <span className="font-medium text-foreground">
                        Chu kỳ đa tác tử
                      </span>{" "}
                      đang chạy: 23 agents qua 5 nhóm — nền tảng dữ liệu → nghiên cứu
                      → kiểm soát VETO → điều hành → học máy…
                    </p>
                  </li>
                )}
                {messages.map((m) => (
                  <MessageItem key={m.id} message={m} signals={signals} />
                ))}
                {messages.length === 0 && !isRunning && (
                  <li className="py-6 text-sm text-muted-foreground">
                    Chưa có tin nhắn. Hãy chạy chu kỳ đầu tiên bằng nút “Chạy
                    agent” trên thanh bar trên cùng.
                  </li>
                )}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

/**
 * Một tin broadcast trong feed — tái dùng trong tab "Phát thanh" của
 * AgentDetailPanel. Khi có signals ACTIVE, tin strategist hiển thị nút
 * Phê duyệt / Từ chối (PHASE3 B2 §4.5).
 */
export function MessageItem({
  message,
  signals = [],
}: {
  message: AgentMessageRow;
  /** Danh sách tín hiệu (AgentDetailPanel không truyền → ẩn nút quyết định). */
  signals?: SignalRow[];
}) {
  const RoleIcon = ROLE_ICONS[message.fromAgent?.role ?? ""] ?? Brain;
  const decision = useSignalDecision();

  // Tín hiệu ACTIVE của strategist sinh SAU tin broadcast này (cùng chu kỳ) —
  // chọn tín hiệu MỚI NHẤT khớp để phê duyệt/từ chối.
  const strategistSignal = useMemo(() => {
    if (message.fromAgent?.code !== "portfolio-strategist" || !message.broadcast) {
      return null;
    }
    const msgTime = new Date(message.createdAt).getTime();
    const candidates = signals.filter(
      (s) =>
        s.status === "ACTIVE" &&
        s.agentCode === "portfolio-strategist" &&
        new Date(s.createdAt).getTime() >= msgTime
    );
    if (candidates.length === 0) return null;
    return candidates.reduce((latest, s) =>
      new Date(s.createdAt).getTime() > new Date(latest.createdAt).getTime()
        ? s
        : latest
    );
  }, [message, signals]);

  const pending = decision.isPending;

  return (
    <li className="flex gap-3 py-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
        <RoleIcon className="size-4 text-foreground/80" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-semibold">
            {message.fromAgent?.name ?? "Agent"}
          </span>
          {message.sentiment && <SentimentBadge sentiment={message.sentiment} />}
          {message.toAgent ? (
            <span className="text-[11px] text-muted-foreground">
              → {message.toAgent.name}
            </span>
          ) : message.broadcast ? (
            <span className="text-[11px] text-muted-foreground">· phát rộng</span>
          ) : null}
          <span className="ml-auto whitespace-nowrap text-[11px] text-muted-foreground">
            {formatDistanceToNow(new Date(message.createdAt), {
              addSuffix: true,
              locale: vi,
            })}
          </span>
        </div>
        {/* F-73A-09: khối allocation Chủ tịch (narrative + bảng) nhiều dòng —
            whitespace-pre-line giữ cấu trúc, không dồn thành 1 đoạn. */}
        <p className="mt-1 whitespace-pre-line text-sm leading-relaxed">{message.content}</p>
        {message.reasoning && (
          <blockquote className="mt-2 border-l-2 border-border pl-3 text-xs italic leading-relaxed text-muted-foreground">
            {message.reasoning}
          </blockquote>
        )}

        {strategistSignal && (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-2">
            <SignalSummary signal={strategistSignal} />
            <div className="ml-auto flex items-center gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 gap-1.5 border-up/40 text-up hover:bg-up/10"
                disabled={
                  pending || strategistSignal.direction === "HOLD"
                }
                title={
                  strategistSignal.direction === "HOLD"
                    ? "Tín hiệu GIỮ không thể chuyển lệnh"
                    : "Phê duyệt và đặt lệnh paper LIMIT"
                }
                aria-label={`Phê duyệt tín hiệu ${strategistSignal.direction} ${strategistSignal.symbol}`}
                onClick={() =>
                  decision.mutate({
                    signalId: strategistSignal.id,
                    action: "APPROVE",
                  })
                }
              >
                {pending && decision.variables?.action === "APPROVE" ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <CircleCheck className="size-3.5" aria-hidden="true" />
                )}
                Phê duyệt
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 gap-1.5 border-down/40 text-down hover:bg-down/10"
                disabled={pending}
                title="Từ chối tín hiệu — không tạo lệnh"
                aria-label={`Từ chối tín hiệu ${strategistSignal.direction} ${strategistSignal.symbol}`}
                onClick={() =>
                  decision.mutate({
                    signalId: strategistSignal.id,
                    action: "REJECT",
                  })
                }
              >
                {pending && decision.variables?.action === "REJECT" ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <CircleX className="size-3.5" aria-hidden="true" />
                )}
                Từ chối
              </Button>
            </div>
          </div>
        )}
      </div>
    </li>
  );
}

function SignalSummary({ signal }: { signal: SignalRow }) {
  const dir = DIRECTION[signal.direction] ?? DIRECTION.HOLD;
  return (
    <>
      <Badge className={cn("text-[10px]", dir.className)}>{dir.label}</Badge>
      <span className="text-xs font-bold tracking-tight">{signal.symbol}</span>
      <span className="tabular-nums text-[11px] text-muted-foreground">
        điểm {signal.score.toFixed(0)}/100
      </span>
    </>
  );
}

function SentimentBadge({ sentiment }: { sentiment: string }) {
  if (sentiment === "bullish")
    return (
      <Badge className="bg-up/15 text-up hover:bg-up/15" variant="default">
        Tích cực
      </Badge>
    );
  if (sentiment === "bearish")
    return (
      <Badge className="bg-down/15 text-down hover:bg-down/15" variant="default">
        Tiêu cực
      </Badge>
    );
  return (
    <Badge variant="secondary" className="hover:bg-secondary">
      Trung tính
    </Badge>
  );
}

export function TaskStatusIcon({ status }: { status: string }) {
  switch (status) {
    case "RUNNING":
      return <Loader2 className="size-4 shrink-0 animate-spin text-amber-500" aria-label="Đang chạy" />;
    case "COMPLETED":
      return <CircleCheck className="size-4 shrink-0 text-up" aria-label="Hoàn tất" />;
    case "FAILED":
      return <CircleX className="size-4 shrink-0 text-down" aria-label="Thất bại" />;
    default:
      return <CircleDashed className="size-4 shrink-0 text-muted-foreground" aria-label="Đang chờ" />;
  }
}

export function PriorityBadge({ priority }: { priority: string }) {
  if (priority === "high")
    return (
      <Badge variant="outline" className="border-down/40 text-down">
        Cao
      </Badge>
    );
  if (priority === "medium")
    return (
      <Badge variant="outline" className="border-amber-500/40 text-amber-600 dark:text-amber-400">
        Trung bình
      </Badge>
    );
  return (
    <Badge variant="outline" className="text-muted-foreground">
      Thấp
    </Badge>
  );
}
