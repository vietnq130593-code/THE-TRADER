"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { formatPrice } from "@/lib/format";
import type {
  AgentChatResponse,
  AgentSingleRunResponse,
  SignalDecisionResponse,
} from "@/lib/types";

/**
 * PHASE3_BLUEPRINT §4.3–§4.5 — 3 mutation dùng chung cho workspace Đội Agent:
 * chạy riêng 1 agent, chat trực tiếp, phê duyệt/từ chối tín hiệu.
 */

/**
 * Lỗi 429 rate-limit — mang `retryAfterSeconds` để component render đếm ngược
 * ("Chờ Xs") thay vì phải parse chuỗi thông báo.
 */
export class RateLimitError extends Error {
  readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  }
}

/**
 * POST JSON cho các endpoint agent — giống apiPostJson nhưng 429 được nâng lên
 * thành RateLimitError (kèm retryAfterSeconds từ body) thay vì Error thường.
 */
async function postForRateLimit<T>(
  path: string,
  body: unknown
): Promise<T> {
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

/** POST /api/agents/[id]/run — chạy riêng 1 agent (§4.3). */
export function useSingleAgentRun() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (agentId: string) =>
      postForRateLimit<AgentSingleRunResponse>(
        `/api/agents/${agentId}/run`,
        {}
      ),
    onSuccess: (res, agentId) => {
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
      void queryClient.invalidateQueries({ queryKey: ["agent-messages"] });
      // Invalidates đúng tầng hồ sơ agent này (biến của mutation):
      void queryClient.invalidateQueries({ queryKey: ["agent", agentId] });

      const run = res.run;
      const secs = run?.durationMs ? (run.durationMs / 1000).toFixed(1) : null;
      toast.success("Agent đã hoàn tất phân tích", {
        description:
          [
            run ? `${(run.tokensIn + run.tokensOut).toLocaleString("vi-VN")} tokens` : null,
            run ? `$${run.costUsd.toFixed(4)}` : null,
            secs ? `${secs}s` : null,
          ]
            .filter(Boolean)
            .join(" · ") || undefined,
      });
    },
    onError: (err: Error) => {
      // 429 → component tự bắt RateLimitError để đếm ngược; vẫn toast thông báo gốc.
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
      toast.error(err.message || "Chạy riêng agent thất bại.");
    },
  });
}

/** POST /api/agents/[id]/chat — chat trực tiếp (§4.4). */
export function useAgentChat(agentId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (message: string) =>
      postForRateLimit<AgentChatResponse>(`/api/agents/${agentId}/chat`, {
        message,
      }),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ["agent", agentId] });
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
      // 200 nhưng LLM lỗi → reply null + error VN (tin user đã lưu, không mất)
      if (res.error) toast.error(res.error);
    },
    onError: (err: Error) => {
      // RateLimitError → component set countdown; toast giữ thông điệp gốc.
      toast.error(err.message || "Không gửi được tin nhắn.");
    },
  });
}

const DIRECTION_LABEL: Record<string, string> = {
  BUY: "MUA",
  SELL: "BÁN",
  HOLD: "GIỮ",
};

/** POST /api/signals/[id]/decision — phê duyệt / từ chối tín hiệu (§4.5). */
export function useSignalDecision() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (vars: {
      signalId: string;
      action: "APPROVE" | "REJECT";
      note?: string;
    }) =>
      postForRateLimit<SignalDecisionResponse>(
        `/api/signals/${vars.signalId}/decision`,
        vars.note ? { action: vars.action, note: vars.note } : { action: vars.action }
      ),
    onSuccess: (res, vars) => {
      void queryClient.invalidateQueries({ queryKey: ["signals"] });
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      void queryClient.invalidateQueries({ queryKey: ["portfolio"] });
      void queryClient.invalidateQueries({ queryKey: ["agent-messages"] });
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
      // Mọi hồ sơ chi tiết agent (tab Phát thanh có thể đang mở khối tín hiệu):
      void queryClient.invalidateQueries({
        predicate: (q) => q.queryKey[0] === "agent",
      });

      const dirLabel = DIRECTION_LABEL[res.signal.direction] ?? res.signal.direction;
      if (vars.action === "APPROVE") {
        // F-73A-10 (fixbug #73): toast thấy đủ kế hoạch TWAP — N lát + tổng
        // khối lượng (trước đây chỉ thấy lát đầu, dễ tưởng duyệt thiếu lệnh).
        const twapSuffix = res.twap
          ? ` — TWAP ${res.twap.sliceCount} lát · tổng ${res.twap.totalQuantity.toLocaleString("vi-VN")} cp`
          : "";
        toast.success("Đã phê duyệt tín hiệu", {
          description: res.order
            ? `Lệnh LIMIT ${res.order.side === "BUY" ? "MUA" : "BÁN"} ${res.order.quantity.toLocaleString("vi-VN")} cp ${res.order.symbol} @ ${formatPrice(res.order.price)} ₫${twapSuffix}`
            : `${res.signal.symbol} · ${dirLabel} · điểm ${res.signal.score.toFixed(0)}/100`,
        });
      } else {
        toast.success("Đã từ chối tín hiệu", {
          description: `${res.signal.symbol} · ${dirLabel} · điểm ${res.signal.score.toFixed(0)}/100`,
        });
      }
    },
    onError: (err: Error) => {
      toast.error(err.message || "Không xử lý được quyết định tín hiệu.");
    },
  });
}
