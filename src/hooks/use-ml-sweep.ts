"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ML_ARCHITECTURE_QUERY_KEY,
  ML_STATUS_QUERY_KEY,
  MlApiError,
} from "@/hooks/use-ml";

/** vi-VN, 1 chữ số thập phân — thời lượng toast (giây). */
const nf1 = new Intl.NumberFormat("vi-VN", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/**
 * C1 (#99 · ML_AUTOML_BLUEPRINT §4.5/F9) — data hooks cho tab "Tự động tìm
 * kiếm" (sweep AutoML L1 deterministic), theo đúng pattern use-ml.ts:
 *
 * - useMlSweep: GET /api/ml/sweep — cấu hình AppSetting "ml-sweep" + snapshot
 *   bản serving dl-mlp + 10 đợt SweepRun gần nhất (champion board). Làm mới
 *   30s + realtime WS "ml-sweep" (use-realtime.ts) invalidate key này.
 * - useRunSweepNow: POST /api/ml/sweep {force:true} — nút "Chạy đợt ngay"
 *   (deterministic — cùng windowHash + cùng seed ⇒ cùng kết quả, mọi champion
 *   vẫn phải qua cổng 4 điều kiện nên không thể "câu" kết quả). 429 mutex
 *   đọc Retry-After để toast đúng số giây phải đợi.
 * - useSaveSweepConfig: POST {action:"config", config} — cập nhật kill-switch
 *   + budget/seed/δ/maxParamFactor (semantic partial, 422 kèm fields[]).
 *
 * Types đặt tại chỗ (hợp đồng route), tolerant-trong-khi-đúng-kiểu —
 * champion/log có thể null khi chưa có đợt nào.
 */

/** Query key dùng chung cho trạng thái sweep (realtime WS cũng invalidate). */
export const ML_SWEEP_QUERY_KEY = ["ml-sweep"] as const;

/* ─────────────────── Types (hợp đồng GET /api/ml/sweep) ─────────────────── */

export interface MlSweepConfig {
  /** Kill-switch đường ENGINE Chủ nhật 04:15 ICT (nút tay vẫn chạy). */
  enabled: boolean;
  /** F-18 (#131): champion qua cổng & swap serving → tự động ghi kiến trúc
   *  + hyper xuống tab Mạng thần kinh (ml-tuning). Tắt → chỉ swap weights. */
  autoPromoteTuning: boolean;
  /** Số ứng viên/đợt (coarse 12 trước, refine 4 sau) — 1..64. */
  budgetCandidates: number;
  /** Seed dãy ứng viên — deterministic. */
  seed: number;
  /** δ swap (điểm valAcc champion phải vượt serving) — điều kiện 1. */
  deltaSwap: number;
  /** Hệ số cap tham số — điều kiện 3. */
  maxParamFactor: number;
  lastRunAt: string | null;
  updatedAt?: string;
}

export interface MlSweepServing {
  version: number;
  valAcc: number | null;
  featureSet: string;
  windowHash: string | null;
}

export interface MlSweepHyper {
  epochs: number;
  patience: number;
  batchSize: number;
  lr: number;
  l2: number;
  valFraction: number;
  seed: number;
  /** F-18 (#131): bộ đặc trưng của champion ("v2-lag16" | "v3-macro"). */
  featureSet?: string;
}

/** championJson của một đợt — null khi đợt không có ứng viên sống nào. */
export interface MlSweepChampion {
  index: number;
  tag: string;
  arch: string;
  activations: string[];
  lossWeights: [number, number, number];
  hyper: MlSweepHyper;
  valAcc: number;
  valLoss: number;
  brier: number;
  paramCount: number;
  score: number;
  swapProposed: boolean;
  swapReason: string;
  modelVersion: number;
  deltaBrier?: { mean: number; ciLow: number; ciHigh: number } | null;
  serving?: { valAcc: number | null; paramCount: number | null; version: number | null } | null;
  /** F-18 (#131): đồng bộ champion → ml-tuning (chỉ có khi swap thành công). */
  tuningSync?: { synced: boolean; note: string } | null;
}

/** 1 dòng champion board (logJson) — mọi ứng viên kể cả thua (§2.10). */
export interface MlSweepLogRow {
  i: number;
  tag?: string;
  arch: string;
  activations: string[];
  lossWeights: [number, number, number];
  valAcc?: number;
  valLoss?: number;
  brier?: number;
  params?: number;
  score?: number;
  ms?: number;
  error?: string;
}

export interface MlSweepGateSummary {
  pass: boolean;
  reasons: string[];
  deltaBrier: { mean: number; ciLow: number; ciHigh: number } | null;
  serving: { valAcc: number | null; paramCount: number | null; version: number | null } | null;
}

export interface MlSweepRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  /** running | done | failed */
  status: string;
  candidates: number;
  evaluated: number;
  seed: number;
  windowHash: string;
  featureSet: string;
  champion: MlSweepChampion | null;
  gateSummary: MlSweepGateSummary | null;
  /** logJson parse sẵn — champion board mọi ứng viên của đợt (kể cả thua). */
  log: MlSweepLogRow[];
}

export interface MlSweepResponse {
  ok: boolean;
  config: MlSweepConfig;
  serving: MlSweepServing | null;
  runs: MlSweepRun[];
}

/** Response POST chạy đợt (đầy đủ khi chạy thật; skipped khi skip-guard chặn). */
export interface MlSweepRunResponse {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  runId?: string;
  status?: "done" | "failed";
  windowHash?: string;
  candidates?: number;
  evaluated?: number;
  seed?: number;
  champion?: MlSweepChampion | null;
  swapped?: boolean;
  durationMs?: number;
  log?: MlSweepLogRow[];
  error?: string;
}

/** Response POST action "config". */
export interface MlSweepConfigSaveResponse {
  ok: boolean;
  applied: string[];
  config: MlSweepConfig;
  error?: string;
  fields?: string[];
}

/* ─────────────────── Queries ─────────────────── */

async function fetchMlSweep(): Promise<MlSweepResponse> {
  const res = await fetch("/api/ml/sweep", { cache: "no-store" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new MlApiError(
      body?.error ?? `Không tải được trạng thái sweep (${res.status})`,
      res.status
    );
  }
  return (await res.json()) as MlSweepResponse;
}

export function useMlSweep() {
  return useQuery({
    queryKey: ML_SWEEP_QUERY_KEY,
    queryFn: fetchMlSweep,
    staleTime: 15_000,
    // Tự làm mới mỗi 30s — đợt có thể chạy ở engine CN 04:15 ICT.
    refetchInterval: 30_000,
    retry: (failureCount) => failureCount < 2,
  });
}

/* ─────────────────── Mutations ─────────────────── */

export function useRunSweepNow() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (): Promise<MlSweepRunResponse> => {
      const res = await fetch("/api/ml/sweep", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // force mặc định true ở route — gửi tường minh cho rõ ý nút tay.
        body: JSON.stringify({ force: true }),
      });
      const data = (await res.json().catch(() => null)) as MlSweepRunResponse | null;
      if (!res.ok || data == null || data.ok !== true) {
        if (res.status === 429) {
          const headerSecs = Number(res.headers.get("retry-after"));
          const secs =
            Number.isFinite(headerSecs) && headerSecs > 0 ? Math.ceil(headerSecs) : 30;
          throw new MlApiError(
            data?.error ??
              `Đợt sweep hoặc huấn luyện đang chạy — thử lại sau khoảng ${secs} giây.`,
            429
          );
        }
        throw new MlApiError(
          data?.error ?? `Đợt sweep thất bại (${res.status})`,
          res.status
        );
      }
      return data;
    },
    onSuccess: (res) => {
      // Làm mới trạng thái sweep + serving (có thể vừa SWAP) + sơ đồ kiến trúc.
      void queryClient.invalidateQueries({ queryKey: ML_SWEEP_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ML_STATUS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ML_ARCHITECTURE_QUERY_KEY });

      // Toast số liệu THẬT từ response — skip-guard / champion / swap verdict.
      const secs =
        typeof res.durationMs === "number" && res.durationMs > 0
          ? `${nf1.format(res.durationMs / 1000)}s`
          : null;
      if (res.skipped === true) {
        toast.info("Đợt sweep bị bỏ qua (skip-guard)", {
          description:
            res.reason ??
            "windowHash không đổi — không có bar mới để tìm kiếm thêm (điều kiện 4 cổng §4.4).",
        });
        return;
      }
      const champion = res.champion ?? null;
      const valAccPct =
        champion != null && Number.isFinite(champion.valAcc)
          ? `${(champion.valAcc * 100).toFixed(1).replace(".", ",")}%`
          : null;
      const title =
        champion != null
          ? `Đợt sweep hoàn tất — ${res.evaluated ?? "?"} ứng viên · champion ${champion.tag} (${champion.arch})${valAccPct != null ? ` · valAcc ${valAccPct}` : ""}${secs ? ` trong ${secs}` : ""}`
          : `Đợt sweep hoàn tất — ${res.evaluated ?? 0}/${res.candidates ?? "?"} ứng viên${secs ? ` trong ${secs}` : ""}`;
      toast.success(title, {
        description:
          champion == null
            ? "Không có ứng viên nào train thành công — xem logJson chi tiết trên bảng champion."
            : res.swapped === true
              ? champion.tuningSync?.synced === true
                ? "Champion qua CỔNG 4 ĐIỀU KIỆN — đã hoán đổi sang serving (audit ML_SWEEP_SWAP) VÀ đồng bộ kiến trúc + tinh chỉnh xuống tab Mạng thần kinh."
                : "Champion qua CỔNG 4 ĐIỀU KIỆN — đã hoán đổi sang serving (audit ML_SWEEP_SWAP)."
              : `Champion KHÔNG đổi serving — ${champion.swapReason || "chưa đủ vượt cổng 4 điều kiện"}.`,
      });
    },
    onError: (err: Error) => {
      toast.error(err.message || "Không chạy được đợt sweep.");
    },
  });
}

export function useSaveSweepConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      config: Partial<
        Pick<
          MlSweepConfig,
          "enabled" | "autoPromoteTuning" | "budgetCandidates" | "seed" | "deltaSwap" | "maxParamFactor"
        >
      >
    ): Promise<MlSweepConfigSaveResponse> => {
      const res = await fetch("/api/ml/sweep", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Quy ước route: action "config" phân biệt với chạy đợt (xem comment route).
        body: JSON.stringify({ action: "config", config }),
      });
      const data = (await res.json().catch(() => null)) as MlSweepConfigSaveResponse | null;
      if (!res.ok || data == null || data.ok !== true) {
        const fieldList = data?.fields?.length ? ` (${data.fields.join("; ")})` : "";
        throw new MlApiError(
          (data?.error ?? `Không lưu được cấu hình sweep (${res.status})`) + fieldList,
          res.status
        );
      }
      return data;
    },
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ML_SWEEP_QUERY_KEY });
      toast.success("Đã lưu cấu hình sweep", {
        description:
          res.applied.length > 0
            ? `Áp dụng: ${res.applied.join(" · ")} — hiệu lực từ đợt kế tiếp (Chủ nhật 04:15 ICT hoặc nút chạy ngay).`
            : undefined,
      });
    },
    onError: (err: Error) => {
      toast.error(err.message || "Không lưu được cấu hình sweep.");
    },
  });
}
