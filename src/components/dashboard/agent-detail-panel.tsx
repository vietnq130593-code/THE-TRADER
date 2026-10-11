"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { format, subDays } from "date-fns";
import {
  AlertTriangle,
  Brain,
  CircleCheck,
  CircleX,
  Loader2,
  Play,
  X,
} from "lucide-react";
import {
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiGet } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useSignalDecision } from "@/hooks/use-agent-actions";
import {
  AGENT_ROLE_ICONS,
  AGENT_STATUS_DOT,
  agentSuccessPct,
} from "@/components/dashboard/agent-roster-card";
import { AgentChat } from "@/components/dashboard/agent-chat";
// K3 (#94 — AUTONOMY_BLUEPRINT §6.4): tab Nhiệm vụ nâng cấp — form tạo nhiệm
// vụ định kỳ + danh sách đầy đủ trường mới + tạm dừng/xoá/chạy ngay.
import { AgentTasksTab } from "@/components/dashboard/agent-tasks-tab";
import { MessageItem } from "@/components/dashboard/agents-panel";
import type { AgentDetailResponse, SignalRow } from "@/lib/types";

/** Input → Output theo vai (map tĩnh tiếng Việt — PHASE3 §4.6). */
const AGENT_IO: Record<string, { input: string; output: string }> = {
  "market-analyst": {
    input: "Bảng giá + chỉ báo kỹ thuật",
    output: "Nhận định xu hướng 2–4 câu",
  },
  "news-sentiment": {
    input: "10 tin RSS mới nhất",
    output: "Chấm cảm xúc bullish/bearish/neutral",
  },
  "risk-manager": {
    input: "Danh mục + hạn mức",
    output: "Các vi phạm + mức rủi ro",
  },
  "portfolio-strategist": {
    input: "3 bản phân tích",
    output: "Tổng hợp + tín hiệu",
  },
  "execution-manager": {
    input: "Tín hiệu được duyệt",
    output: "Lệnh paper LIMIT",
  },
};

const RUN_STATUS: Record<string, { label: string; className: string }> = {
  COMPLETED: { label: "Hoàn tất", className: "border-up/40 bg-up/10 text-up" },
  FAILED: { label: "Thất bại", className: "border-down/40 bg-down/10 text-down" },
  RUNNING: {
    label: "Đang chạy",
    className:
      "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
};

const DIRECTION_BADGE: Record<string, { label: string; className: string }> = {
  BUY: { label: "MUA", className: "bg-up/15 text-up hover:bg-up/15" },
  SELL: { label: "BÁN", className: "bg-down/15 text-down hover:bg-down/15" },
  HOLD: {
    label: "GIỮ",
    className:
      "border border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
};

function configValue(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

interface AgentDetailPanelProps {
  agentId: string;
  onClose: () => void;
  onRun: () => void;
  runPending: boolean;
  /** Giây còn phải chờ sau 429 — panel header tự tick giảm. */
  retryAfterSeconds?: number | null;
}

/**
 * PHASE3_BLUEPRINT §4.7 — panel chi tiết 1 agent (cột phải workspace Đội Agent):
 * 5 tab Hồ sơ · Hoạt động · Nhiệm vụ · Phát thanh · Chat.
 * Execution Manager: không có tab Chat (thay bằng thông báo) + không chạy lẻ.
 */
export function AgentDetailPanel({
  agentId,
  onClose,
  onRun,
  runPending,
  retryAfterSeconds = null,
}: AgentDetailPanelProps) {
  const detailQuery = useQuery({
    queryKey: ["agent", agentId],
    queryFn: () => apiGet<AgentDetailResponse>(`/api/agents/${agentId}`),
    staleTime: 30_000,
  });

  // Đếm ngược rate-limit 429 — workspace cha giữ + tick giảm, panel suy ra từ prop.
  const countdown = Math.max(0, Math.ceil(retryAfterSeconds ?? 0));
  const counting = countdown > 0;

  const detail = detailQuery.data;
  const runs = useMemo(() => detail?.runs ?? [], [detail]);
  const configEntries = useMemo(
    () => Object.entries(detail?.agent.config ?? {}),
    [detail]
  );

  // Sparkline chi phí 7 ngày gần nhất — group runs theo ngày (dd/MM), sum costUsd.
  const costByDay = useMemo(() => {
    const buckets: { day: string; cost: number }[] = [];
    const today = new Date();
    for (let i = 6; i >= 0; i--) {
      buckets.push({ day: format(subDays(today, i), "dd/MM"), cost: 0 });
    }
    const byDay = new Map(buckets.map((b) => [b.day, b]));
    for (const r of runs) {
      const b = byDay.get(format(new Date(r.startedAt), "dd/MM"));
      if (b) b.cost += r.costUsd;
    }
    return buckets;
  }, [runs]);

  if (detailQuery.isLoading) {
    return (
      <Card aria-busy="true" aria-label="Đang tải hồ sơ agent">
        <CardHeader className="pb-3">
          <Skeleton className="h-12 w-2/3" />
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Skeleton className="h-9 w-full max-w-md" />
          <Skeleton className="h-72 w-full rounded-lg" />
        </CardContent>
      </Card>
    );
  }

  if (detailQuery.isError || !detail) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Hồ sơ agent</CardTitle>
          <CardAction>
            <Button
              variant="ghost"
              size="icon"
              className="size-9"
              aria-label="Đóng chi tiết agent"
              onClick={onClose}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-down">
            {detailQuery.error?.message ?? "Không tải được hồ sơ agent."}
          </p>
        </CardContent>
      </Card>
    );
  }

  const agent = detail.agent;
  const RoleIcon = AGENT_ROLE_ICONS[agent.role] ?? Brain;
  const dot = AGENT_STATUS_DOT[agent.status] ?? AGENT_STATUS_DOT.IDLE;
  const isExec = agent.code === "execution-manager";
  const isStrategist = agent.code === "portfolio-strategist";
  const running = agent.status === "RUNNING";
  const health = Math.max(0, Math.min(100, agent.healthScore));
  const io = AGENT_IO[agent.code] ?? null;

  // Stats ưu tiên từ backend; fallback tính từ dữ liệu chi tiết đang có.
  const stats = agent.stats;
  const runCount = stats?.runCount ?? runs.length;
  const successPct = stats
    ? agentSuccessPct(stats.successRate)
    : runs.length > 0
      ? Math.round(
          (runs.filter((r) => r.taskStatus === "COMPLETED").length / runs.length) * 100
        )
      : 0;
  const tokensIn = stats?.totalTokensIn ?? runs.reduce((s, r) => s + r.tokensIn, 0);
  const tokensOut = stats?.totalTokensOut ?? runs.reduce((s, r) => s + r.tokensOut, 0);
  const totalCost = stats?.totalCostUsd ?? runs.reduce((s, r) => s + r.costUsd, 0);
  const chatCount = stats?.chatCount ?? detail.chat.length;
  const lastError =
    stats?.lastError ?? runs.find((r) => r.error)?.error ?? null;

  const runDisabled = runPending || counting || running || isExec;
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
    <Card className="gap-4">
      <CardHeader className="pb-3">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
            <RoleIcon className="size-5 text-foreground/80" aria-hidden="true" />
          </span>
          <div className="leading-tight">
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              {agent.name}
              <Badge variant="outline" className="font-mono text-[10px]">
                {agent.model}
              </Badge>
            </CardTitle>
            <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <span className="text-[11px] text-muted-foreground">
                {agent.roleLabel}
              </span>
              <span className="flex items-center gap-1" title={dot.label}>
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
              <span className="tabular-nums text-[11px] text-muted-foreground">
                Sức khỏe {health.toFixed(0)}%
              </span>
              {agent.pendingTaskCount > 0 && (
                <Badge variant="secondary" className="text-[10px]">
                  {agent.pendingTaskCount} nhiệm vụ chờ
                </Badge>
              )}
            </div>
          </div>
        </div>
        <CardAction className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-9 gap-1.5"
            disabled={runDisabled}
            title={runTitle}
            aria-label={`Chạy riêng ${agent.name}`}
            onClick={onRun}
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
                <span className="hidden sm:inline">Chạy riêng</span>
                <span className="sm:hidden">Chạy</span>
              </>
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-9"
            aria-label="Đóng chi tiết agent"
            title="Đóng chi tiết agent"
            onClick={onClose}
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <Tabs defaultValue="profile">
          <TabsList className="w-full">
            <TabsTrigger value="profile" className="px-1 text-[11px] sm:text-xs">
              Hồ sơ
            </TabsTrigger>
            <TabsTrigger value="runs" className="px-1 text-[11px] sm:text-xs">
              Hoạt động
            </TabsTrigger>
            <TabsTrigger value="tasks" className="px-1 text-[11px] sm:text-xs">
              Nhiệm vụ
            </TabsTrigger>
            <TabsTrigger value="broadcast" className="px-1 text-[11px] sm:text-xs">
              Phát thanh
            </TabsTrigger>
            {!isExec && (
              <TabsTrigger value="chat" className="px-1 text-[11px] sm:text-xs">
                Chat
              </TabsTrigger>
            )}
          </TabsList>

          {/* ── Hồ sơ ─────────────────────────────────────────────── */}
          <TabsContent value="profile" className="mt-3 flex flex-col gap-4">
            <p className="text-sm leading-relaxed">{agent.description}</p>

            {io && (
              <div className="rounded-lg border bg-muted/30 p-3">
                <p className="mb-1 text-xs font-semibold">Đầu vào → Đầu ra</p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Input: {io.input} → Output: {io.output}
                </p>
              </div>
            )}

            {configEntries.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-semibold">Cấu hình</p>
                <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
                  {configEntries.map(([k, v]) => (
                    <div
                      key={k}
                      className="flex gap-2 border-b border-border/40 py-1 text-xs"
                    >
                      <dt
                        className="w-24 shrink-0 truncate text-muted-foreground"
                        title={k}
                      >
                        {k}
                      </dt>
                      <dd className="min-w-0 flex-1 break-words font-mono tabular-nums text-foreground">
                        {configValue(v)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}

            <div>
              <p className="mb-2 text-xs font-semibold">Thống kê vận hành</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <StatTile label="Số lần chạy" value={runCount.toLocaleString("vi-VN")} />
                <StatTile label="Tỷ lệ thành công" value={`${successPct}%`} />
                <StatTile label="Tokens vào" value={tokensIn.toLocaleString("vi-VN")} />
                <StatTile label="Tokens ra" value={tokensOut.toLocaleString("vi-VN")} />
                <StatTile label="Chi phí AI" value={`$${totalCost.toFixed(4)}`} />
                <StatTile
                  label="Tin nhắn chat"
                  value={chatCount.toLocaleString("vi-VN")}
                />
              </div>
            </div>

            {lastError && (
              <div
                className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3"
                role="alert"
              >
                <AlertTriangle
                  className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-amber-600 dark:text-amber-400">
                    Lỗi gần nhất
                  </p>
                  <p className="break-words text-xs text-muted-foreground">
                    {lastError}
                  </p>
                </div>
              </div>
            )}
          </TabsContent>

          {/* ── Hoạt động (AgentRun) ──────────────────────────────── */}
          <TabsContent value="runs" className="mt-3 flex flex-col gap-3">
            {runs.length > 0 ? (
              <div className="max-h-96 overflow-y-auto custom-scrollbar rounded-lg border">
                <Table className="min-w-[640px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Thời gian</TableHead>
                      <TableHead>Trạng thái</TableHead>
                      <TableHead className="text-right">Thời lượng</TableHead>
                      <TableHead className="text-right">Tokens (vào/ra)</TableHead>
                      <TableHead className="text-right">Chi phí</TableHead>
                      <TableHead>Lỗi</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {runs.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="tabular-nums whitespace-nowrap text-muted-foreground">
                          {formatDateTime(r.startedAt)}
                        </TableCell>
                        <TableCell>
                          <RunStatusBadge status={r.taskStatus} />
                        </TableCell>
                        <TableCell className="tabular-nums text-right">
                          {r.durationMs != null
                            ? `${(r.durationMs / 1000).toFixed(1)}s`
                            : "—"}
                        </TableCell>
                        <TableCell className="tabular-nums text-right">
                          {r.tokensIn.toLocaleString("vi-VN")}/
                          {r.tokensOut.toLocaleString("vi-VN")}
                        </TableCell>
                        <TableCell className="tabular-nums text-right">
                          ${r.costUsd.toFixed(4)}
                        </TableCell>
                        <TableCell className="max-w-[160px]">
                          {r.error ? (
                            <span
                              className="block truncate text-xs text-down"
                              title={r.error}
                            >
                              {r.error}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Chưa có lượt chạy nào.
              </p>
            )}

            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div className="w-full text-muted-foreground sm:max-w-xs">
                <p className="mb-1 text-[11px] text-muted-foreground">
                  Chi phí 7 ngày gần nhất
                </p>
                <ResponsiveContainer width="100%" height={64}>
                  <BarChart
                    data={costByDay}
                    margin={{ top: 4, right: 4, bottom: 0, left: 4 }}
                  >
                    <ChartTooltip
                      cursor={{ fill: "currentColor", fillOpacity: 0.08 }}
                      formatter={(value) => [
                        `$${Number(value).toFixed(4)}`,
                        "Chi phí",
                      ]}
                    />
                    <Bar
                      dataKey="cost"
                      fill="rgb(245 158 11)"
                      fillOpacity={0.65}
                      radius={[2, 2, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <p className="shrink-0 text-xs text-muted-foreground">
                Tổng chi phí agent:{" "}
                <span className="tabular-nums font-semibold text-foreground">
                  ${totalCost.toFixed(4)}
                </span>
              </p>
            </div>
          </TabsContent>

          {/* ── Nhiệm vụ (K3 #94 — định kỳ + tay, form tạo, tạm dừng, xoá) ── */}
          <TabsContent value="tasks" className="mt-3">
            <AgentTasksTab agentId={agent.id} agentCode={agent.code} />
          </TabsContent>

          {/* ── Phát thanh (broadcast feed + tín hiệu mở) ─────────── */}
          <TabsContent value="broadcast" className="mt-3 flex flex-col gap-3">
            {isStrategist && detail.signals.length > 0 && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                <p className="mb-2 text-xs font-semibold">
                  Tín hiệu đang mở ({detail.signals.length}) — chờ phê duyệt
                </p>
                <ul className="flex flex-col gap-2">
                  {detail.signals.map((s) => (
                    <SignalDecisionRow key={s.id} signal={s} />
                  ))}
                </ul>
              </div>
            )}

            {detail.broadcastFeed.length > 0 ? (
              <ul className="max-h-96 divide-y overflow-y-auto custom-scrollbar pr-1">
                {detail.broadcastFeed.map((m) => (
                  <MessageItem key={m.id} message={m} />
                ))}
              </ul>
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Chưa có tin phát rộng nào.
              </p>
            )}
          </TabsContent>

          {/* ── Chat (4 agent — không có execution-manager) ───────── */}
          {!isExec && (
            <TabsContent value="chat" className="mt-3">
              <AgentChat
                agentId={agent.id}
                agentName={agent.name}
                initialMessages={detail.chat}
              />
            </TabsContent>
          )}
        </Tabs>

        {isExec && (
          <div
            className="flex gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4"
            role="note"
          >
            <AlertTriangle
              className="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-amber-400"
              aria-hidden="true"
            />
            <p className="text-sm leading-relaxed">
              Execution Manager không hỗ trợ chat/chạy lẻ — agent này chỉ thực
              thi khi trader phê duyệt tín hiệu trong chu kỳ đầy đủ.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RunStatusBadge({ status }: { status: string }) {
  const s =
    RUN_STATUS[status] ?? {
      label: status,
      className: "border-border bg-muted text-muted-foreground",
    };
  return (
    <Badge
      variant="outline"
      className={cn("whitespace-nowrap text-[10px]", s.className)}
    >
      {s.label}
    </Badge>
  );
}

/** Dòng tín hiệu ACTIVE của portfolio-strategist + nút Phê duyệt / Từ chối. */
function SignalDecisionRow({ signal }: { signal: SignalRow }) {
  const decision = useSignalDecision();
  const isHold = signal.direction === "HOLD";
  const pending = decision.isPending;
  const dir = DIRECTION_BADGE[signal.direction] ?? DIRECTION_BADGE.HOLD;

  return (
    <li className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2">
      <Badge className={cn("text-[10px]", dir.className)}>{dir.label}</Badge>
      <span className="text-sm font-bold tracking-tight">{signal.symbol}</span>
      <span className="tabular-nums text-[11px] text-muted-foreground">
        điểm {signal.score.toFixed(0)}/100
      </span>
      <div className="ml-auto flex items-center gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 gap-1.5 border-up/40 text-up hover:bg-up/10"
          disabled={pending || isHold}
          title={
            isHold
              ? "Tín hiệu GIỮ không thể chuyển lệnh"
              : "Phê duyệt và đặt lệnh paper LIMIT"
          }
          aria-label={`Phê duyệt tín hiệu ${dir.label} ${signal.symbol}`}
          onClick={() =>
            decision.mutate({ signalId: signal.id, action: "APPROVE" })
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
          aria-label={`Từ chối tín hiệu ${dir.label} ${signal.symbol}`}
          onClick={() =>
            decision.mutate({ signalId: signal.id, action: "REJECT" })
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
    </li>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2">
      <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
      <p className="tabular-nums mt-0.5 truncate text-sm font-semibold">
        {value}
      </p>
    </div>
  );
}
