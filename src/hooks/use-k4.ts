"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiGet, apiPostJson } from "@/lib/api";
import type { K4State } from "@/lib/types";

/**
 * K4 #94 (AUTONOMY_BLUEPRINT §7.3) — data hooks cho khối "Giao việc" trong
 * workspace Ban Điều hành (agents-workspace, dưới ChairmanScorecard):
 *
 * - useK4: GET /api/k4 — cấu hình + thống kê + 50 nhiệm vụ đã giao gần nhất.
 * - useUpdateK4: POST /api/k4 {enabled?, maxOpenTasksPerAgent?, maxTasksPerCycle?}.
 *
 * Toast sonner + invalidate TanStack Query theo pattern use-ml.
 */

export const K4_QUERY_KEY = ["k4"] as const;

export interface UpdateK4Input {
  enabled?: boolean;
  maxOpenTasksPerAgent?: number;
  maxTasksPerCycle?: number;
}

export function useK4() {
  return useQuery({
    queryKey: K4_QUERY_KEY,
    queryFn: () => apiGet<K4State>("/api/k4"),
    staleTime: 30_000,
  });
}

export function useUpdateK4() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateK4Input) => apiPostJson<K4State>("/api/k4", input),
    onSuccess: (state, vars) => {
      void queryClient.invalidateQueries({ queryKey: K4_QUERY_KEY });
      if (vars.enabled !== undefined) {
        toast.success(
          vars.enabled ? "Đã bật Chủ tịch giao việc (K4)" : "Đã tắt Chủ tịch giao việc (K4)",
          {
            description: vars.enabled
              ? "Từ chu kỳ kế tiếp, prompt Chủ tịch kèm khối GIAO VIỆC."
              : "Nhiệm vụ đang treo vẫn chạy đúng lịch K3 — không tự huỷ.",
          }
        );
      } else {
        toast.success("Đã cập nhật giới hạn giao việc");
      }
    },
    onError: (err) => {
      toast.error("Không cập nhật được cấu hình K4", { description: err.message });
    },
  });
}
