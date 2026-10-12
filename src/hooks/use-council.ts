"use client";

/**
 * src/hooks/use-council.ts — #106/#107 COUNCIL_STEWARDSHIP_BLUEPRINT v2.0.
 * Queries + mutations cho module "Hội đồng": tổng quan 1 cửa (tài khoản toàn
 * cục đa thị trường + sổ đánh giá quyết định), thống kê 5 nhóm thị trường
 * (dùng chung với card Đa rổ trong module Thị trường — lớp thống kê, không
 * phải đối tượng đầu tư), và thao tác đánh giá lại sổ quyết định.
 *
 * #107: bỏ toàn bộ hooks thí nghiệm phân bổ E-ALLOC (mark · hội nghị LLM ·
 * tạo/dừng) — khoản tiền thử nghiệm sandbox CHÍNH LÀ thí nghiệm.
 *
 * Query key namespacing chuẩn nhà: ["council-overview", rangeKey] ·
 * ["council-baskets"] — mutation luôn invalidateQueries prefix "council".
 * Khoảng from/to theo ngày ICT (#105 pattern rangeQuery/rangeKey).
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiGet, apiPost } from "@/lib/api";
import type {
  CouncilBasketsResponse,
  CouncilEvalResponse,
  CouncilOverviewResponse,
} from "@/lib/types";

export function useCouncilOverview(rangeQuery: string, rangeKey: string) {
  return useQuery({
    queryKey: ["council-overview", rangeKey],
    queryFn: () =>
      apiGet<CouncilOverviewResponse>(
        `/api/council/overview${rangeQuery ? `?${rangeQuery}` : ""}`
      ),
    staleTime: 60_000,
  });
}

export function useCouncilBaskets() {
  return useQuery({
    queryKey: ["council-baskets"],
    queryFn: () => apiGet<CouncilBasketsResponse>("/api/council/baskets"),
    staleTime: 60_000,
  });
}

/** Đánh giá lại sổ quyết định (idempotent) — nút UI + engine 16:45 ICT. */
export function useRunDecisionEval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<CouncilEvalResponse>("/api/council/evaluate"),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["council-overview"] });
      toast.success(`Đã đánh giá ${res.evaluated} quyết định`, {
        description: `WIN ${res.byVerdict.WIN} · LOSS ${res.byVerdict.LOSS} · NEUTRAL ${res.byVerdict.NEUTRAL} — thực thi ${res.executed} · chưa ${res.unexecuted}`,
      });
    },
    onError: (err) => {
      toast.error("Đánh giá quyết định thất bại", { description: err.message });
    },
  });
}
