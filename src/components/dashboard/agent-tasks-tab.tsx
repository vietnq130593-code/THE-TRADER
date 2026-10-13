"use client";

import * as React from "react";
import {
  CalendarClock,
  CalendarDays,
  CircleHelp,
  Loader2,
  Pause,
  Play,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatDateTime } from "@/lib/format";
import { describeSchedule } from "@/lib/schedule";
import { cn } from "@/lib/utils";
import {
  useAgentTasks,
  useCreateAgentTask,
  useDeleteAgentTask,
  useRunAgentTask,
  useUpdateAgentTask,
} from "@/hooks/use-agent-tasks";
import { PriorityBadge, TaskStatusIcon } from "@/components/dashboard/agents-panel";
import type { AgentTaskDetail } from "@/lib/types";

/**
 * K3 #94 (AUTONOMY_BLUEPRINT §6.4) — tab "Nhiệm vụ" của panel chi tiết agent:
 *
 * - Form "Tạo nhiệm vụ": tiêu đề · mô tả · lịch (Một lần (tay) / Hằng ngày
 *   HH:MM / Hằng tuần thứ + HH:MM) · ưu tiên — nextDueAt do SERVER tính.
 * - Danh sách: badge Định kỳ (describeSchedule) / Tay · nextDueAt · lastRunAt
 *   · runCount · failStreak (amber ≥3, đỏ =5 tự dừng) · Switch tạm dừng ·
 *   nút xoá (Dialog xác nhận) · nút "Chạy ngay" (POST run {taskId}) ·
 *   badge "Chủ tịch giao" khi createdByAgentId ≠ null (K4).
 * - Danh sách dài: max-h-96 overflow-y-auto custom-scrollbar.
 * Responsive 390px: hàng xếp dọc trên mobile, actions xuống dòng.
 */

type ScheduleKind = "once" | "daily" | "weekly";

const DOW_OPTIONS: { value: string; label: string }[] = [
  { value: "MON", label: "Thứ Hai" },
  { value: "TUE", label: "Thứ Ba" },
  { value: "WED", label: "Thứ Tư" },
  { value: "THU", label: "Thứ Năm" },
  { value: "FRI", label: "Thứ Sáu" },
  { value: "SAT", label: "Thứ Bảy" },
  { value: "SUN", label: "Chủ nhật" },
];

interface AgentTasksTabProps {
  agentId: string;
  agentCode: string;
}

export function AgentTasksTab({ agentId, agentCode }: AgentTasksTabProps) {
  const tasksQuery = useAgentTasks(agentId);
  const createTask = useCreateAgentTask(agentId);
  const updateTask = useUpdateAgentTask(agentId);
  const deleteTask = useDeleteAgentTask(agentId);
  const runTask = useRunAgentTask(agentId);

  // ── Form state ──
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [kind, setKind] = React.useState<ScheduleKind>("once");
  const [time, setTime] = React.useState("09:30");
  const [dow, setDow] = React.useState("MON");
  const [priority, setPriority] = React.useState<"low" | "medium" | "high">("medium");
  const [confirmDeleteId, setConfirmDeleteId] = React.useState<string | null>(null);

  const canSubmit =
    title.trim().length > 0 &&
    title.trim().length <= 200 &&
    description.length <= 2000 &&
    !createTask.isPending &&
    (kind === "once" || /^\d{2}:\d{2}$/.test(time));

  // M4.9 (#110 — pattern #102 “DISABLED-CÓ-LÝ-DO”): vì sao chưa tạo được —
  // hiển thị trong tooltip bọc nút chính (riêng phần pending hiển thị spinner).
  const submitDisabledReason: string | null =
    title.trim().length === 0
      ? "Nhập tiêu đề nhiệm vụ (bắt buộc) để tạo"
      : title.trim().length > 200
        ? "Tiêu đề vượt quá 200 ký tự"
        : description.length > 2000
          ? "Mô tả vượt quá 2000 ký tự"
          : kind !== "once" && !/^\d{2}:\d{2}$/.test(time)
            ? "Giờ chạy phải đúng dạng HH:MM"
            : null;

  function buildSchedule(): string | null {
    if (kind === "once") return null;
    if (!/^\d{2}:\d{2}$/.test(time)) return null;
    if (kind === "daily") return time;
    return `${dow}:${time}`;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    createTask.mutate(
      {
        title: title.trim(),
        description: description.trim() || null,
        schedule: buildSchedule(),
        priority,
      },
      {
        onSuccess: () => {
          setTitle("");
          setDescription("");
          setKind("once");
        },
      }
    );
  }

  const tasks = tasksQuery.data?.tasks ?? [];
  // M4.9 — tiêu đề dialog xoá động theo nhiệm vụ đang xác nhận.
  const taskToDelete = tasks.find((t) => t.id === confirmDeleteId) ?? null;

  return (
    <div className="flex flex-col gap-4">
      {/* ── Form tạo nhiệm vụ ── */}
      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3"
        aria-label="Tạo nhiệm vụ định kỳ"
      >
        {/* M4.9 — legend dài chuyển sang popover “?” (thay footnote dài dòng) */}
        <div className="flex items-center gap-1.5">
          <p className="text-xs font-semibold">Tạo nhiệm vụ</p>
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40"
                aria-label="Cách chọn lịch chạy nhiệm vụ"
              >
                <CircleHelp className="size-3.5 text-muted-foreground" aria-hidden="true" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-80 text-xs leading-relaxed text-muted-foreground">
              <p className="mb-1.5 text-xs font-semibold text-foreground">Lịch chạy</p>
              {kind === "once"
                ? "Nhiệm vụ một lần — dùng nút “Chạy ngay” trong danh sách khi cần."
                : "Giờ chạy kế tiếp do server tính theo giờ Việt Nam (ICT) — không lệ múi giờ máy. Định kỳ hằng ngày HH:MM · hằng tuần thứ + HH:MM."}
            </PopoverContent>
          </Popover>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor={`task-title-${agentCode}`} className="text-[11px]">
              Tiêu đề <span className="text-down">*</span>
            </Label>
            <Input
              id={`task-title-${agentCode}`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="VD: Rà soát hỗ trợ VCB mỗi sáng"
              maxLength={200}
              required
            />
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor={`task-desc-${agentCode}`} className="text-[11px]">
              Mô tả (tuỳ chọn)
            </Label>
            <Textarea
              id={`task-desc-${agentCode}`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Nội dung nhiệm vụ sẽ được tiêm vào prompt của agent khi đến giờ chạy…"
              maxLength={2000}
              rows={2}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-[11px]">Lịch chạy</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as ScheduleKind)}>
              <SelectTrigger className="w-full" aria-label="Kiểu lịch chạy">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="once">Một lần (tay)</SelectItem>
                <SelectItem value="daily">Hằng ngày</SelectItem>
                <SelectItem value="weekly">Hằng tuần</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {kind === "weekly" && (
            <div className="flex flex-col gap-1.5">
              <Label className="text-[11px]">Thứ trong tuần</Label>
              <Select value={dow} onValueChange={setDow}>
                <SelectTrigger className="w-full" aria-label="Thứ trong tuần">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DOW_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {kind !== "once" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`task-time-${agentCode}`} className="text-[11px]">
                Giờ chạy (giờ Việt Nam)
              </Label>
              <Input
                id={`task-time-${agentCode}`}
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                required
              />
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label className="text-[11px]">Ưu tiên</Label>
            <Select
              value={priority}
              onValueChange={(v) => setPriority(v as "low" | "medium" | "high")}
            >
              <SelectTrigger className="w-full" aria-label="Độ ưu tiên">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="high">Cao</SelectItem>
                <SelectItem value="medium">Trung bình</SelectItem>
                <SelectItem value="low">Thấp</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {/* M4.9 — nút chính disabled-có-lý-do (tooltip #102), bỏ footnote dài */}
        <div className="flex justify-end">
          {createTask.isPending || submitDisabledReason == null ? (
            <Button
              type="submit"
              disabled={createTask.isPending}
              className="h-11 gap-1.5 sm:h-9 sm:w-auto"
              aria-label="Tạo nhiệm vụ"
            >
              {createTask.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Plus className="size-4" aria-hidden="true" />
              )}
              Tạo nhiệm vụ
            </Button>
          ) : (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* span bọc để tooltip vẫn hiện trên nút disabled (pattern #102) */}
                  <span tabIndex={0} className="inline-flex cursor-not-allowed">
                    <Button
                      type="button"
                      className="h-11 gap-1.5 sm:h-9 sm:w-auto"
                      disabled
                      aria-disabled="true"
                      aria-label="Tạo nhiệm vụ"
                    >
                      <Plus className="size-4" aria-hidden="true" />
                      Tạo nhiệm vụ
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-64 text-left">
                  {submitDisabledReason}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      </form>

      {/* ── Danh sách nhiệm vụ ── */}
      {tasksQuery.isLoading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : tasksQuery.isError ? (
        <p className="py-4 text-center text-sm text-down" role="alert">
          {tasksQuery.error?.message ?? "Không tải được danh sách nhiệm vụ."}
        </p>
      ) : tasks.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          Chưa có nhiệm vụ nào — tạo nhiệm vụ định kỳ đầu tiên ở trên.
        </p>
      ) : (
        <ul className="max-h-96 divide-y overflow-y-auto custom-scrollbar rounded-lg border">
          {tasks.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              updatePending={
                updateTask.isPending && updateTask.variables?.taskId === t.id
              }
              runPending={runTask.isPending && runTask.variables === t.id}
              deletePending={
                // F-1113-03 (fixbug #111): so với t.id (hàng đang xoá) như
                // runPending/updatePending — trước fix so với confirmDeleteId
                // (không phụ thuộc hàng) → MỌI hàng cùng spinner khi xoá.
                deleteTask.isPending && deleteTask.variables === t.id
              }
              onTogglePause={(paused) => updateTask.mutate({ taskId: t.id, paused })}
              onRun={() => runTask.mutate(t.id)}
              onDelete={() => setConfirmDeleteId(t.id)}
            />
          ))}
        </ul>
      )}

      {/* ── Dialog xác nhận xoá (M4.9 chuẩn hoá: max-w-lg · tiêu đề động
          theo nhiệm vụ đang xoá · footer Huỷ + nút chính disabled-có-lý-do) ── */}
      <Dialog
        open={confirmDeleteId != null}
        onOpenChange={(open) => {
          if (!open) setConfirmDeleteId(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {taskToDelete
                ? `Xoá nhiệm vụ “${taskToDelete.title}”?`
                : "Xoá nhiệm vụ?"}
            </DialogTitle>
            <DialogDescription>
              Nhiệm vụ sẽ bị xoá vĩnh viễn cùng lịch định kỳ của nó. Lịch sử
              AgentRun đã chạy vẫn được giữ nguyên để truy vết.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <DialogClose asChild>
              <Button variant="outline" className="h-11 sm:h-9">
                Huỷ
              </Button>
            </DialogClose>
            {deleteTask.isPending ? (
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    {/* span bọc để tooltip vẫn hiện trên nút disabled (pattern #102) */}
                    <span tabIndex={0} className="inline-flex cursor-not-allowed">
                      <Button
                        variant="destructive"
                        className="h-11 gap-1.5 sm:h-9"
                        disabled
                        aria-disabled="true"
                      >
                        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                        Xoá nhiệm vụ
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-64 text-left">
                    Đang xoá nhiệm vụ — đợi giây lát, hộp thoại tự đóng khi xong.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : (
              <Button
                variant="destructive"
                className="h-11 gap-1.5 sm:h-9"
                onClick={() => {
                  if (confirmDeleteId) {
                    deleteTask.mutate(confirmDeleteId, {
                      onSettled: () => setConfirmDeleteId(null),
                    });
                  }
                }}
              >
                <Trash2 className="size-4" aria-hidden="true" />
                Xoá nhiệm vụ
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Một hàng nhiệm vụ — mobile xếp dọc, sm+ nằm ngang. */
function TaskRow({
  task,
  updatePending,
  runPending,
  deletePending,
  onTogglePause,
  onRun,
  onDelete,
}: {
  task: AgentTaskDetail;
  updatePending: boolean;
  runPending: boolean;
  deletePending: boolean;
  onTogglePause: (paused: boolean) => void;
  onRun: () => void;
  onDelete: () => void;
}) {
  const scheduled = task.schedule != null;
  const failStreak = task.failStreak ?? 0;
  const failTone =
    failStreak >= 5
      ? "border-down/40 bg-down/10 text-down"
      : failStreak >= 3
        ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
        : "border-border text-muted-foreground";

  return (
    <li className="flex flex-col gap-2 p-3">
      <div className="flex items-start gap-2.5">
        <TaskStatusIcon status={task.status} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-snug">{task.title}</p>
          {task.description && (
            <p
              className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground"
              title={task.description}
            >
              {task.description}
            </p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {scheduled ? (
              <Badge
                variant="outline"
                className="gap-1 border-emerald-600/30 text-emerald-700 dark:text-emerald-400"
              >
                <CalendarClock className="size-3" aria-hidden="true" />
                {describeSchedule(task.schedule)}
              </Badge>
            ) : (
              <Badge variant="outline" className="gap-1 text-muted-foreground">
                <CalendarDays className="size-3" aria-hidden="true" />
                Tay · một lần
              </Badge>
            )}
            {task.createdByAgentId != null && (
              <Badge
                variant="outline"
                className="gap-1 border-amber-500/40 text-amber-600 dark:text-amber-400"
                title={`Do ${task.createdByName ?? "Chủ tịch"} giao`}
              >
                <Sparkles className="size-3" aria-hidden="true" />
                Chủ tịch giao
              </Badge>
            )}
            {task.paused && (
              <Badge variant="outline" className="gap-1 border-amber-500/40 text-amber-600 dark:text-amber-400">
                <Pause className="size-3" aria-hidden="true" />
                Đang tạm dừng
              </Badge>
            )}
            <PriorityBadge priority={task.priority} />
            {scheduled && (
              <Badge
                variant="outline"
                className={cn("text-[10px] tabular-nums", failTone)}
                title={
                  failStreak >= 5
                    ? `Tự tạm dừng sau ${failStreak} lỗi liên tiếp (kill-switch K3)`
                    : `Chuỗi lỗi liên tiếp: ${failStreak}/5 (đến 5 thì tự tạm dừng)`
                }
              >
                lỗi {failStreak}/5
              </Badge>
            )}
          </div>
          <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] tabular-nums text-muted-foreground">
            {scheduled && task.nextDueAt && (
              <span className="inline-flex items-center gap-1">
                <CalendarClock className="size-3" aria-hidden="true" />
                chạy lúc {formatDateTime(task.nextDueAt)}
              </span>
            )}
            {task.lastRunAt && (
              <span>chạy cuối {formatDateTime(task.lastRunAt)}</span>
            )}
            <span>{task.runCount} lần</span>
          </p>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 pl-6">
        {scheduled && (
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Switch
              size="sm"
              checked={!task.paused}
              disabled={updatePending}
              onCheckedChange={(checked) => onTogglePause(!checked)}
              aria-label={
                task.paused
                  ? `Nhiệm vụ "${task.title}" đang tạm dừng — bật lại để chạy đúng lịch`
                  : `Nhiệm vụ "${task.title}" đang chạy đúng lịch — tắt để tạm dừng`
              }
            />
            {task.paused ? "Tiếp tục" : "Tạm dừng"}
          </label>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 gap-1.5"
          disabled={runPending || task.status === "COMPLETED" || task.status === "RUNNING"}
          title="Chạy agent theo đúng nhiệm vụ này ngay bây giờ"
          aria-label={`Chạy ngay nhiệm vụ ${task.title}`}
          onClick={onRun}
        >
          {runPending ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Play className="size-3.5" aria-hidden="true" />
          )}
          Chạy ngay
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-9 text-muted-foreground hover:text-down"
          disabled={deletePending}
          title="Xoá nhiệm vụ"
          aria-label={`Xoá nhiệm vụ ${task.title}`}
          onClick={onDelete}
        >
          {deletePending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Trash2 className="size-4" aria-hidden="true" />
          )}
        </Button>
      </div>
    </li>
  );
}
