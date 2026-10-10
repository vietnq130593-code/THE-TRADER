"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

/** vi-VN, 1 chữ số thập phân — dùng cho giây/thời lượng toast. */
const nf1 = new Intl.NumberFormat("vi-VN", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/**
 * Phiên #35 (Task 35-FE) — data hooks cho card "Học máy & Học tăng cường"
 * trong workspace Tổng hợp (synthesis).
 *
 * - useMlStatus: GET /api/ml/status — trạng thái 3 mô hình học thật
 *   (MLP dự báo 5 phiên · Q-learning gym · Bandit Thompson sampling).
 *   Refetch mỗi 30 giây; lỗi 404 (backend 35-ML chưa merge) KHÔNG retry —
 *   UI render empty-state "Đang chờ backend học máy" và tự lành khi API lên.
 * - useTrainMl: POST /api/ml/train {target} — huấn luyện lại;
 *   429 cooldown đọc header Retry-After để toast đúng số giây phải đợi.
 *
 * Hợp đồng theo spec 35-ML; types đặt tại chỗ vì src/lib/types.ts do
 * subagent backend sở hữu (FE không sửa). Mọi trường đều optional-tolerant:
 * dlMlp/rlQ có thể null khi chưa train.
 */

/** Query key dùng chung cho mọi query trạng thái học máy trên UI. */
export const ML_STATUS_QUERY_KEY = ["ml-status"] as const;

/** Target huấn luyện — "all" (MLP + Q-learning) hoặc từng mô hình. */
export type MlTrainTarget = "all" | "dl-mlp" | "rl-q";

/* ─────────────────── Types (hợp đồng GET /api/ml/status) ─────────────────── */

export interface DlMlpMetrics {
  epochs: number;
  /** Số mẫu huấn luyện (định dạng vi-VN trên UI). */
  samples: number;
  /** 0..1 — UI ×100 thành %. */
  trainAcc: number;
  /** 0..1 — UI ×100 thành % (xanh ≥50% / đỏ <50%). */
  valAcc: number;
  trainLoss: number;
  valLoss: number;
  /** Horizon dự báo (phần) — thường 5. */
  horizonDays: number;
  /** Số đặc trưng đầu vào. */
  features: number;
  /** Mã đóng góp mạnh nhất vào dự báo (max 8 chip trên UI). */
  topSymbols: string[];
}

export interface RlQMetrics {
  episodes: number;
  /** ε cuối cùng sau decay (0..1). */
  epsilonEnd: number;
  /** Phần thưởng trung bình 50 episode cuối (có dấu). */
  avgRewardLast50: number;
  states: number;
  actions: number;
  /** Stance hiện tại của chính sách: "tăng" | "giữ" | "giảm". */
  stance: string;
  /** 0..1 — tỷ lệ phơi nhiễm rủi ro hiện tại. */
  exposure: number;
  /** Q-value lớn nhất (có dấu). */
  qMax: number;
}

export interface BanditArm {
  agentCode: string;
  name: string;
  alpha: number;
  beta: number;
  pulls: number;
  /** Số "thắng" tích luỹ (reward liên tục, không nhất thiết nguyên). */
  wins: number;
  /** Trung bình posterior Beta(α+1, β+1) — 0..1. */
  posteriorMean: number;
}

export interface MlModelStatus<TMetrics> {
  version: number;
  /** "serving" | "training" | … (UI map, không đoán cứng). */
  status: string;
  trainedAt: string;
  metrics: TMetrics;
}

export interface MlStatusResponse {
  /** null khi chưa huấn luyện lần nào. */
  dlMlp: MlModelStatus<DlMlpMetrics> | null;
  /** null khi chưa huấn luyện lần nào. */
  rlQ: MlModelStatus<RlQMetrics> | null;
  bandit: { arms: BanditArm[]; lastSettleAt: string | null } | null;
  /** Số phiếu LLM chờ kết toán reward. */
  pendingSettles: number;
}

/* ─────────────────── Types (hợp đồng POST /api/ml/train) ─────────────────── */

/** Response train — dlMlp/rlQ là BẢN METRICS (không bọc version/status).
 *  A4 (phiên #79) — serving-swap guard trả thêm trường tuỳ chọn promoted
 *  (false = valAcc bản mới thua bản serving → lưu archived, KHÔNG thay mô
 *  hình đang phục vụ). F-801-03 (Fixbug #80): UI đọc để toast trung thực. */
export interface MlTrainResponse {
  ok: boolean;
  trained: string[];
  durationMs: number;
  dlMlp: DlMlpMetrics | null;
  rlQ: RlQMetrics | null;
  /** false = bản mới không lên serving (valAcc thấp hơn bản đang phục vụ). */
  promoted?: boolean;
  /** valAcc bản serving TRƯỚC khi train (null = chưa có bản nào). */
  servingValAcc?: number | null;
  /** valAcc bản vừa train. */
  newValAcc?: number;
}

/* ─────────────────── Fetch helpers ─────────────────── */

/** Lỗi API học máy — giữ status để UI phân nhánh 404 (chờ backend) vs lỗi khác. */
export class MlApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "MlApiError";
    this.status = status;
  }
}

async function fetchMlStatus(): Promise<MlStatusResponse> {
  const res = await fetch("/api/ml/status", { cache: "no-store" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new MlApiError(
      body?.error ?? `Không tải được trạng thái học máy (${res.status})`,
      res.status
    );
  }
  return (await res.json()) as MlStatusResponse;
}

export function isMlNotFound(error: unknown): boolean {
  return error instanceof MlApiError && error.status === 404;
}

/* ─────────────────── Queries ─────────────────── */

export function useMlStatus() {
  return useQuery({
    queryKey: ML_STATUS_QUERY_KEY,
    queryFn: fetchMlStatus,
    staleTime: 15_000,
    // Tự làm mới mỗi 30s — mô hình có thể được train/settle ở nơi khác.
    refetchInterval: 30_000,
    // 404 = backend 35-ML chưa merge: KHÔNG retry (tránh spam request),
    // refetchInterval vẫn polling để tự hiển thị khi API lên.
    retry: (failureCount, error) => {
      if (isMlNotFound(error)) return false;
      return failureCount < 2;
    },
  });
}

/* ─────────────────── Mutation ─────────────────── */

export function useTrainMl() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (target: MlTrainTarget): Promise<MlTrainResponse> => {
      const res = await fetch("/api/ml/train", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target }),
      });
      const data = (await res.json().catch(() => null)) as
        | (MlTrainResponse & { error?: string })
        | null;
      // Tolerant: lỗi có thể đến từ HTTP status, body {error} hoặc {ok:false}.
      if (!res.ok || data == null || data.ok === false || data.error != null) {
        if (res.status === 429) {
          // Cooldown — đọc Retry-After (giây) nếu có.
          const headerSecs = Number(res.headers.get("retry-after"));
          const secs =
            Number.isFinite(headerSecs) && headerSecs > 0 ? Math.ceil(headerSecs) : null;
          throw new MlApiError(
            secs != null
              ? `Mô hình đang trong thời gian chờ (cooldown) — thử lại sau khoảng ${secs} giây.`
              : (data?.error ??
                "Mô hình đang trong thời gian chờ (cooldown). Vui lòng đợi rồi thử lại."),
            429
          );
        }
        throw new MlApiError(
          data?.error ?? `Huấn luyện thất bại (${res.status})`,
          res.status
        );
      }
      return data;
    },
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ML_STATUS_QUERY_KEY });

      // Toast với số liệu THẬT từ response (tolerant — backend có thể thiếu field).
      const trained = Array.isArray(res.trained) ? res.trained : [];
      const secs =
        typeof res.durationMs === "number" && res.durationMs > 0
          ? `${nf1.format(res.durationMs / 1000)}s`
          : null;
      const valAccPct =
        res.dlMlp?.valAcc != null && Number.isFinite(res.dlMlp.valAcc)
          ? `${(res.dlMlp.valAcc * 100).toFixed(1).replace(".", ",")}%`
          : null;
      const episodes = res.rlQ?.episodes ?? null;

      // F-801-03 (Fixbug #80): serving-swap guard A4 — promoted=false nghĩa là
      // bản vừa train KHÔNG thay mô hình đang phục vụ (valAcc thấp hơn). Toast
      // phải nói rõ, tránh hiểu lầm "train xong là đang dùng bản mới".
      const pct = (v: number | null | undefined): string | null =>
        typeof v === "number" && Number.isFinite(v)
          ? `${(v * 100).toFixed(1).replace(".", ",")}%`
          : null;
      const notServing =
        res.promoted === false
          ? pct(res.servingValAcc ?? null) != null && pct(res.newValAcc ?? null) != null
            ? `Bản mới KHÔNG lên serving — valAcc ${pct(res.newValAcc)} < bản đang phục vụ ${pct(res.servingValAcc)} (giữ bản cũ, nguyên tắc §1.5).`
            : "Bản mới KHÔNG lên serving (valAcc thấp hơn bản đang phục vụ) — giữ bản cũ."
          : null;

      const title =
        valAccPct != null && episodes != null
          ? `Đã huấn luyện MLP (valAcc ${valAccPct}) + Q-learning (${episodes} episodes)${secs ? ` trong ${secs}` : ""}`
          : valAccPct != null
            ? `Đã huấn luyện MLP (valAcc ${valAccPct})${secs ? ` trong ${secs}` : ""}`
            : episodes != null
              ? `Đã huấn luyện Q-learning (${episodes} episodes)${secs ? ` trong ${secs}` : ""}`
              : `Đã huấn luyện mô hình học máy${secs ? ` trong ${secs}` : ""}`;

      toast.success(title, {
        description:
          [trained.length > 0 ? `Mục tiêu: ${trained.join(", ")}` : null, notServing]
            .filter((part): part is string => part != null)
            .join(" · ") || undefined,
      });
    },
    onError: (err: Error) => {
      toast.error(err.message || "Không huấn luyện được mô hình.");
    },
  });
}
