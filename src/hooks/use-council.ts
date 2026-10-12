"use client";

/**
 * src/hooks/use-council.ts — #106 COUNCIL_STEWARDSHIP_BLUEPRINT.
 * Queries + mutations cho module "Hội đồng": tổng quan 1 cửa (tài khoản toàn
 * cục + sổ đánh giá quyết định + thí nghiệm phân bổ), thống kê 5 rổ thị
 * trường (dùng chung với card Đa rổ trong module Thị trường), và 4 thao tác
 * (đánh giá · mark thí nghiệm · hội nghị phân bổ LLM · tạo/dừng thí nghiệm).
 *
 * Query key namespacing chuẩn nhà: ["council-overview", rangeKey] ·
 * ["council-baskets"] — mutation luôn invalidateQueries prefix "council".
 * Khoảng from/to theo ngày ICT (#105 pattern rangeQuery/rangeKey).
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  apiGet,
  apiPost,
  apiPostJson,
  apiPut,
} from "@/lib/api";
import type {
  CouncilBasketsResponse,
  CouncilCreateExperimentResponse,
  CouncilEvalResponse,
  CouncilMarkResponse,
  CouncilOverviewResponse,
  CouncilSessionResponse,
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

/** Mark-to-market thí nghiệm đang chạy (idempotent) — nút UI + engine 16:35. */
export function useMarkExperiments() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<CouncilMarkResponse>("/api/council/experiments/mark"),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["council-overview"] });
      toast.success(
        `Đã đánh giá ${res.running} thí nghiệm · ${res.snapshotsWritten} snapshot mới`,
        {
          description:
            res.finalized.length > 0
              ? `Đã tổng kết ${res.finalized.length} thí nghiệm đủ horizon`
              : "Không có thí nghiệm nào đủ horizon để tổng kết",
        }
      );
    },
    onError: (err) => {
      toast.error("Đánh giá thí nghiệm thất bại", { description: err.message });
    },
  });
}

/** Họp Hội đồng phân bổ (LLM ~25s) — nút UI + engine CN 05:50 ICT. */
export function useAllocationSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiPost<CouncilSessionResponse>("/api/council/allocation-session"),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["council-overview"] });
      void qc.invalidateQueries({ queryKey: ["agents-messages"] });
      if (res.created && res.experimentName) {
        const w = (res.weights ?? [])
          .map((x) => `${x.basket} ${x.weight}%`)
          .join(" · ");
        toast.success(`Hội đồng đề xuất thí nghiệm "${res.experimentName}"`, {
          description: `${w} — model ${res.model} · ${Math.round(res.durationMs / 1000)}s${res.parseFail ? ` · lưu ý: ${res.parseFail}` : ""}`,
          duration: 10_000,
        });
      } else {
        toast.success("Hội nghị họp xong — không tạo thí nghiệm mới", {
          description: `${res.parseFail ?? res.narrative?.slice(0, 120) ?? "Chủ tịch chỉ tổng hợp — xem Luồng thảo luận"} · model ${res.model}`,
          duration: 10_000,
        });
      }
    },
    onError: (err) => {
      toast.error("Hội nghị phân bổ thất bại", { description: err.message });
    },
  });
}

export interface CreateExperimentInput {
  name: string;
  hypothesis: string;
  weights: Array<{ basket: string; weight: number }>;
  capitalVND: number;
  horizonDays: number;
}

/** Trader tạo thí nghiệm tay qua dialog. */
export function useCreateExperiment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateExperimentInput) =>
      apiPostJson<CouncilCreateExperimentResponse>(
        "/api/council/experiments",
        input
      ),
    onSuccess: (res) => {
      if (res.ok && res.experiment) {
        void qc.invalidateQueries({ queryKey: ["council-overview"] });
        toast.success(`Đã tạo thí nghiệm "${res.experiment.name}"`, {
          description: `Vốn ${res.experiment.capitalVND.toLocaleString("vi-VN")} ₫ · horizon ${res.experiment.horizonDays} ngày — engine 16:35 ICT đánh giá hằng ngày`,
        });
      }
    },
    onError: (err) => {
      toast.error("Tạo thí nghiệm thất bại", { description: err.message });
    },
  });
}

/** Dừng thí nghiệm đang chạy — tổng kết ngay với dữ liệu có tới nay. */
export function useStopExperiment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiPut<{ ok: boolean }>(`/api/council/experiments?id=${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["council-overview"] });
      toast.success("Đã dừng thí nghiệm — tổng kết với dữ liệu tới nay");
    },
    onError: (err) => {
      toast.error("Dừng thí nghiệm thất bại", { description: err.message });
    },
  });
}
