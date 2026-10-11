"use client";

import * as React from "react";
import {
  CalendarClock,
  ClipboardList,
  Loader2,
  Pause,
  RefreshCw,
  Sparkles,
} from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";
import { describeSchedule } from "@/lib/schedule";
import { cn } from "@/lib/utils";
import { useK4, useUpdateK4 } from "@/hooks/use-k4";

/**
 * K4 #94 (AUTONOMY_BLUEPRINT §7.3) — khối "Giao việc" trong workspace Đội
 * Agent, đặt NGAY DƯỚI section nhóm executive (cùng pattern ChairmanScorecard):
 *
 * - Bảng "Nhiệm vụ đã giao": AgentTask createdByAgentId ≠ null (agent nhận ·
 *   title · lịch · trạng thái · runCount · lần chạy cuối · badge "Chủ tịch
 *   giao") — danh sách dài max-h-96 overflow-y-auto custom-scrollbar.
 * - Cấu hình: Switch bật/tắt + 2 input giới hạn (1..10) + dòng giải thích quy
 *   tắc "chỉ Chủ tịch giao · chỉ nhóm ngoài executive · nhiệm vụ đang treo
 *   không tự huỷ khi tắt".
 */

export function K4AssignedCard() {
  const k4Query = useK4();
  const updateK4 = useUpdateK4();

  const state = k4Query.data;
  // Local state = null nghĩa là "chưa chạm" → hiển thị theo giá trị server
  // (tránh setState trong effect — derive khi render); người dùng nhập → local
  // thắng; lưu xong → reset về null để bám giá trị server mới.
  const [maxOpenInput, setMaxOpenInput] = React.useState<string | null>(null);
  const [maxCycleInput, setMaxCycleInput] = React.useState<string | null>(null);
  const maxOpen = maxOpenInput ?? (state ? String(state.maxOpenTasksPerAgent) : "");
  const maxCycle = maxCycleInput ?? (state ? String(state.maxTasksPerCycle) : "");

  const limitsDirty =
    state != null &&
    ((maxOpenInput !== null && Number(maxOpen) !== state.maxOpenTasksPerAgent) ||
      (maxCycleInput !== null && Number(maxCycle) !== state.maxTasksPerCycle));
  const limitsValid =
    Number.isInteger(Number(maxOpen)) &&
    Number(maxOpen) >= 1 &&
    Number(maxOpen) <= 10 &&
    Number.isInteger(Number(maxCycle)) &&
    Number(maxCycle) >= 1 &&
    Number(maxCycle) <= 10;

  if (k4Query.isLoading) {
    return (
      <Card aria-busy="true" aria-label="Đang tải khối giao việc">
        <CardHeader className="pb-3">
          <Skeleton className="h-6 w-64" />
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-40 w-full rounded-lg" />
        </CardContent>
      </Card>
    );
  }

  if (k4Query.isError || !state) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardList className="size-4 text-primary" aria-hidden="true" />
            Giao việc — Ban Điều hành (K4)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-down" role="alert">
            {k4Query.error?.message ?? "Không tải được khối giao việc."}
          </p>
        </CardContent>
      </Card>
    );
  }

  const tasks = state.tasks ?? [];

  return (
    <Card className="gap-4" aria-labelledby="k4-assigned-heading">
      <CardHeader>
        <CardTitle id="k4-assigned-heading" className="flex items-center gap-2 text-base">
          <ClipboardList className="size-4 text-primary" aria-hidden="true" />
          Giao việc — Ban Điều hành (K4)
        </CardTitle>
        <CardDescription>
          Chủ tịch Hội đồng giao việc cho agents ngoài Ban Điều hành ngay trong
          chu kỳ 23 agents — nhiệm vụ rơi vào hạ tầng định kỳ K3.
        </CardDescription>
        <CardAction className="flex items-center gap-2">
          <Badge
            variant="outline"
            className={cn(
              "text-[10px]",
              state.enabled
                ? "border-emerald-600/40 text-emerald-700 dark:text-emerald-400"
                : "text-muted-foreground"
            )}
          >
            {state.enabled ? "Đang bật" : "Đang tắt"}
          </Badge>
          {state.stats.assignedTotal > 0 && (
            <Badge variant="secondary" className="text-[10px] tabular-nums">
              {state.stats.assignedTotal} đã giao
            </Badge>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* ── Cấu hình K4 ── */}
        <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Switch
                id="k4-enabled"
                size="sm"
                checked={state.enabled}
                disabled={updateK4.isPending}
                onCheckedChange={(checked) => updateK4.mutate({ enabled: checked })}
                aria-label="Bật/tắt Chủ tịch giao việc"
              />
              <Label htmlFor="k4-enabled" className="text-xs font-medium">
                Cho phép Chủ tịch giao việc
              </Label>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label="Tải lại khối giao việc"
              title="Tải lại"
              onClick={() => void k4Query.refetch()}
            >
              <RefreshCw className="size-4" aria-hidden="true" />
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="k4-max-open" className="text-[11px]">
                Nhiệm vụ treo tối đa / agent
              </Label>
              <Input
                id="k4-max-open"
                type="number"
                min={1}
                max={10}
                step={1}
                value={maxOpen}
                onChange={(e) => setMaxOpenInput(e.target.value)}
                className="h-9"
                disabled={updateK4.isPending}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="k4-max-cycle" className="text-[11px]">
                Nhiệm vụ tối đa / chu kỳ
              </Label>
              <Input
                id="k4-max-cycle"
                type="number"
                min={1}
                max={10}
                step={1}
                value={maxCycle}
                onChange={(e) => setMaxCycleInput(e.target.value)}
                className="h-9"
                disabled={updateK4.isPending}
              />
            </div>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Quy tắc: chỉ <strong>Chủ tịch</strong> giao · chỉ nhóm ngoài Ban
              Điều hành (Nghiên cứu/Kiểm soát/Nền tảng/Học máy) · nhiệm vụ đang
              treo <strong>không tự huỷ</strong> khi tắt — vẫn chạy đúng lịch.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-11 gap-1.5 sm:h-9"
              disabled={!limitsDirty || !limitsValid || updateK4.isPending}
              title={
                limitsValid
                  ? "Lưu giới hạn giao việc"
                  : "Giới hạn phải là số nguyên 1..10"
              }
              onClick={() =>
                updateK4.mutate(
                  {
                    maxOpenTasksPerAgent: Number(maxOpen),
                    maxTasksPerCycle: Number(maxCycle),
                  },
                  {
                    onSuccess: () => {
                      setMaxOpenInput(null);
                      setMaxCycleInput(null);
                    },
                  }
                )
              }
            >
              {updateK4.isPending ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : null}
              Lưu giới hạn
            </Button>
          </div>
        </div>

        {/* ── Bảng nhiệm vụ đã giao ── */}
        <div>
          <p className="mb-2 text-xs font-semibold">
            Nhiệm vụ đã giao ({state.stats.assignedTotal})
            {state.stats.lastAssignedAt && (
              <span className="ml-2 font-normal text-muted-foreground">
                · gần nhất {formatDateTime(state.stats.lastAssignedAt)}
              </span>
            )}
          </p>
          {tasks.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {state.enabled
                ? "Chủ tịch chưa giao việc nào — sẽ xuất hiện sau chu kỳ kế tiếp."
                : "Chưa có nhiệm vụ nào được giao. Bật công tắc để Chủ tịch bắt đầu giao việc."}
            </p>
          ) : (
            <div className="max-h-96 overflow-auto custom-scrollbar rounded-lg border">
              <Table className="min-w-[560px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Agent nhận</TableHead>
                    <TableHead>Nhiệm vụ</TableHead>
                    <TableHead>Lịch</TableHead>
                    <TableHead>Trạng thái</TableHead>
                    <TableHead className="text-right">Số lần</TableHead>
                    <TableHead>Chạy cuối</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tasks.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell className="whitespace-nowrap">
                        <span className="text-sm">{t.agentName}</span>
                        <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">
                          {t.agentCode}
                        </span>
                      </TableCell>
                      <TableCell className="max-w-[220px]">
                        <p className="truncate text-sm" title={t.title}>
                          {t.title}
                        </p>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {t.schedule ? (
                          <Badge
                            variant="outline"
                            className="gap-1 border-emerald-600/30 text-emerald-700 dark:text-emerald-400"
                          >
                            <CalendarClock className="size-3" aria-hidden="true" />
                            {describeSchedule(t.schedule)}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-muted-foreground">
                            Một lần
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {t.paused ? (
                          <Badge
                            variant="outline"
                            className="gap-1 border-amber-500/40 text-amber-600 dark:text-amber-400"
                          >
                            <Pause className="size-3" aria-hidden="true" />
                            Tạm dừng
                          </Badge>
                        ) : t.status === "PENDING" ? (
                          <Badge
                            variant="outline"
                            className="border-emerald-600/30 text-emerald-700 dark:text-emerald-400"
                          >
                            Đang chờ lịch
                          </Badge>
                        ) : t.status === "COMPLETED" ? (
                          <Badge variant="outline" className="text-muted-foreground">
                            Hoàn tất
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="border-down/40 text-down">
                            {t.status === "FAILED" ? "Thất bại" : t.status}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {t.runCount}
                      </TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                        {t.lastRunAt ? formatDateTime(t.lastRunAt) : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Sparkles className="size-3 shrink-0" aria-hidden="true" />
            Nhiệm vụ do Chủ tịch giao mang nhãn “Chủ tịch giao” trong tab Nhiệm
            vụ của từng agent — trader xoá/sửa như nhiệm vụ thường.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
