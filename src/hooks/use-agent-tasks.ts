"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiDelete, apiGet, apiPatchJson, apiPostJson } from "@/lib/api";
import { describeSchedule } from "@/lib/schedule";
import type { AgentSingleRunResponse, AgentTasksResponse } from "@/lib/types";
import { RateLimitError } from "@/hooks/use-agent-actions";

/**
 * K3 #94 (AUTONOMY_BLUEPRINT §6.2/§6.4) — data hooks cho tab "Nhiệm vụ"
 * của panel chi tiết agent:
 *
 * - useAgentTasks: GET /api/agents/[id]/tasks — danh sách đầy đủ trường mới
 *   (schedule/nextDueAt/lastRunAt/runCount/failStreak/paused/createdByName).
 * - useCreateAgentTask: POST — tạo nhiệm vụ (server tính nextDueAt).
 * - useUpdateAgentTask: PATCH — pause/resume/sửa/đổi lịch.
 * - useDeleteAgentTask: DELETE (409 khi AgentRun đang chạy).
 * - useRunAgentTask: POST /api/agents/[id]/run {taskId} — chạy nhiệm vụ NGAY
 *   (429 → RateLimitError kèm retryAfterSeconds cho UI đếm ngược).
 *
 * Toast sonner + invalidate TanStack Query theo pattern use-ml/use-agent-actions.
 */

export const AGENT_TASKS_QUERY_KEY = "agent-tasks" as const;

export interface CreateAgentTaskInput {
  title: string;
  description?: string | null;
  schedule?: string | null;
  priority?: "low" | "medium" | "high";
}

export interface UpdateAgentTaskInput {
  taskId: string;
  paused?: boolean;
  title?: string;
  description?: string | null;
  schedule?: string | null;
  priority?: "low" | "medium" | "high";
}

export function useAgentTasks(agentId: string) {
  return useQuery({
    queryKey: [AGENT_TASKS_QUERY_KEY, agentId],
    queryFn: () => apiGet<AgentTasksResponse>(`/api/agents/${agentId}/tasks`),
    staleTime: 15_000,
    enabled: Boolean(agentId),
  });
}

export function useCreateAgentTask(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAgentTaskInput) =>
      apiPostJson<{ task: { id: string; schedule: string | null } }>(
        `/api/agents/${agentId}/tasks`,
        input
      ),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: [AGENT_TASKS_QUERY_KEY, agentId] });
      void queryClient.invalidateQueries({ queryKey: ["agent", agentId] });
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
      toast.success("Đã tạo nhiệm vụ", {
        description: res.task?.schedule
          ? `Định kỳ ${describeSchedule(res.task.schedule)} — server tự tính giờ chạy kế tiếp.`
          : "Nhiệm vụ một lần — bấm \"Chạy ngay\" khi cần.",
      });
    },
    onError: (err) => {
      toast.error("Không tạo được nhiệm vụ", { description: err.message });
    },
  });
}

export function useUpdateAgentTask(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateAgentTaskInput) => {
      const { taskId, ...patch } = input;
      return apiPatchJson<{ task: { paused: boolean; schedule: string | null } }>(
        `/api/agents/${agentId}/tasks/${taskId}`,
        patch
      );
    },
    onSuccess: (res, vars) => {
      void queryClient.invalidateQueries({ queryKey: [AGENT_TASKS_QUERY_KEY, agentId] });
      void queryClient.invalidateQueries({ queryKey: ["agent", agentId] });
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
      if (vars.paused === true) {
        toast.success("Đã tạm dừng nhiệm vụ", {
          description: "Engine bỏ qua due-check khi nhiệm vụ đang tạm dừng.",
        });
      } else if (vars.paused === false) {
        toast.success("Đã tiếp tục nhiệm vụ", {
          description: res.task?.schedule
            ? `Lần chạy kế tiếp: ${describeSchedule(res.task.schedule)} (tính lại từ bây giờ).`
            : undefined,
        });
      } else {
        toast.success("Đã cập nhật nhiệm vụ");
      }
    },
    onError: (err) => {
      toast.error("Không cập nhật được nhiệm vụ", { description: err.message });
    },
  });
}

export function useDeleteAgentTask(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) =>
      apiDelete<{ ok: boolean }>(`/api/agents/${agentId}/tasks/${taskId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [AGENT_TASKS_QUERY_KEY, agentId] });
      void queryClient.invalidateQueries({ queryKey: ["agent", agentId] });
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
      toast.success("Đã xoá nhiệm vụ");
    },
    onError: (err) => {
      toast.error("Không xoá được nhiệm vụ", { description: err.message });
    },
  });
}

/** POST /api/agents/[id]/run {taskId} — 429 nâng thành RateLimitError. */
async function postRunTask<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await res.json().catch(() => null)) as
    | (T & { error?: string; retryAfterSeconds?: number })
    | null;
  if (!res.ok || data == null) {
    if (res.status === 429) {
      const secs =
        typeof data?.retryAfterSeconds === "number" && data.retryAfterSeconds > 0
          ? data.retryAfterSeconds
          : 60;
      throw new RateLimitError(
        data?.error ?? "Vui lòng đợi thêm ít lâu rồi thử lại.",
        secs
      );
    }
    throw new Error(data?.error ?? `Yêu cầu thất bại (${res.status})`);
  }
  return data;
}

export function useRunAgentTask(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) =>
      postRunTask<AgentSingleRunResponse>(`/api/agents/${agentId}/run`, { taskId }),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: [AGENT_TASKS_QUERY_KEY, agentId] });
      void queryClient.invalidateQueries({ queryKey: ["agent", agentId] });
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
      void queryClient.invalidateQueries({ queryKey: ["agent-messages"] });
      const secs = res.run?.durationMs ? (res.run.durationMs / 1000).toFixed(1) : null;
      toast.success("Nhiệm vụ đã hoàn tất", {
        description:
          [
            res.run ? `${(res.run.tokensIn + res.run.tokensOut).toLocaleString("vi-VN")} tokens` : null,
            secs ? `${secs}s` : null,
          ]
            .filter(Boolean)
            .join(" · ") || undefined,
      });
    },
    onError: (err) => {
      toast.error(
        err instanceof RateLimitError ? "Agent vừa chạy cách đây ít phút" : "Không chạy được nhiệm vụ",
        { description: err.message }
      );
    },
  });
}
