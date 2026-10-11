"use client";

/**
 * ml/shared.tsx (#89) — tiểu khối + helper dùng chung cho các tab module
 * "Học máy & Học tăng cường". Tách từ ml-panel.tsx (phiên #35/#79/#81/#83)
 * khi module chuyển sang cấu trúc 5 tab — KHÔNG đổi hành vi hiển thị, chỉ
 * dời nhà để các tab tái sử dụng cùng bộ format/badge.
 */

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/format";

/* ─────────────────── A3 · types field `drift` (đối chiếu API ml/status) ─────────────────── */

/** Một chiều PSI trong payload drift (mirror hợp đồng API ml/status). */
export interface DriftDim {
  name: string;
  psi: number;
  level: string;
}

/** Field `drift` — unavailable kèm reason trung thực (bản train trước A3). */
export type DriftStatus =
  | { available: false; reason?: string }
  | {
      available: true;
      asOf: string;
      samples: number;
      dims: DriftDim[];
      maxPsi: number;
      maxDim: string;
      retrainRecommended: boolean;
    };

/* ─────────────────── Format helpers (vi-VN, dấu − U+2212) ─────────────────── */

export const nf0 = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 });
export const nf1 = new Intl.NumberFormat("vi-VN", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
export const nf2 = new Intl.NumberFormat("vi-VN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
/** 4 chữ số thập phân — ΔBrier/CI cổng bằng chứng (B2 #81). */
export const nf4 = new Intl.NumberFormat("vi-VN", {
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});

/** "61,0%" — nhập tỷ lệ 0..1 → ×100. */
export function pct1(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${nf1.format(n * 100)}%`;
}

/** "−0,12" / "+0,40" (2 chữ số, dấu − U+2212). */
export function signed2(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  const s = nf2.format(Math.abs(n));
  return n > 0 ? `+${s}` : n < 0 ? `−${s}` : "0,00";
}

export function clamp01(n: number | null | undefined): number {
  if (n == null || Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Xanh (emerald) khi ≥50%, đỏ (rose) khi <50% — cho độ chính xác 0..1. */
export function accTone(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "text-muted-foreground";
  return n >= 0.5
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-rose-600 dark:text-rose-400";
}

/** Dấu số: dương = emerald, âm = rose, 0/không xác định = muted. */
export function signTone(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n) || n === 0) return "text-muted-foreground";
  return n > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400";
}

/* ─────────────────── Label maps ─────────────────── */

export const MODEL_STATUS: Record<string, { label: string; className: string }> = {
  serving: {
    label: "serving",
    className: "bg-emerald-600/15 text-emerald-700 dark:text-emerald-400",
  },
  training: {
    label: "training",
    className: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  },
};

/* ─────────────────── Drift PSI visuals ─────────────────── */

/** Mức PSI 3 bậc → nhãn + màu badge; giá trị lạ → đỏ (fail-safe). */
export function driftLevelVisual(level: string | null | undefined): {
  label: string;
  className: string;
} {
  switch (level) {
    case "ổn":
      return {
        label: "ổn",
        className:
          "bg-emerald-600/15 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-600/15",
      };
    case "cảnh-báo":
      return {
        label: "cảnh báo",
        className:
          "bg-amber-500/15 text-amber-700 dark:text-amber-400 hover:bg-amber-500/15",
      };
    default:
      return {
        label: "dịch chuyển",
        className:
          "bg-rose-600/15 text-rose-700 dark:text-rose-400 hover:bg-rose-600/15",
      };
  }
}

/** Mức tóm lược của cả payload — theo chiều PSI cao nhất. */
export function driftWorstLevel(drift: Extract<DriftStatus, { available: true }>): string {
  const worst = [...drift.dims].sort((a, b) => b.psi - a.psi)[0];
  return worst?.level ?? "dịch-chuyển";
}

/** Chuẩn hoá stance (API trả tiếng Việt) → tăng / giữ / giảm. */
export function normalizeStance(stance: string | null | undefined): "up" | "hold" | "down" {
  const s = (stance ?? "").trim().toLowerCase();
  if (["tăng", "tang", "up", "buy", "long"].includes(s)) return "up";
  if (["giảm", "giam", "down", "sell", "short"].includes(s)) return "down";
  return "hold";
}

export const RL_STANCE: Record<"up" | "hold" | "down", { label: string; className: string }> = {
  up: {
    label: "TĂNG",
    className: "bg-emerald-600/15 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-600/15",
  },
  hold: {
    label: "GIỮ",
    className: "bg-amber-500/15 text-amber-700 dark:text-amber-400 hover:bg-amber-500/15",
  },
  down: {
    label: "GIẢM",
    className: "bg-rose-600/15 text-rose-700 dark:text-rose-400 hover:bg-rose-600/15",
  },
};

/* ─────────────────── Tiểu khối ─────────────────── */

/** Ô số liệu: nhãn muted + giá trị tabular-nums. */
export function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  tone?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border bg-muted/30 px-3 py-2">
      <span className="text-[11px] leading-tight text-muted-foreground">{label}</span>
      <span className={cn("tabular-nums text-lg font-semibold leading-tight", tone)}>
        {value}
      </span>
    </div>
  );
}

/** Badge phiên bản "v2". */
export function VersionBadge({ version }: { version: number }) {
  return (
    <Badge variant="secondary" className="font-mono text-[10px]">
      v{version}
    </Badge>
  );
}

/** Badge trạng thái mô hình — "serving" emerald, còn lại outline thô. */
export function StatusBadge({ status }: { status: string }) {
  const known = MODEL_STATUS[(status ?? "").toLowerCase()];
  if (known) {
    return (
      <Badge className={cn("font-mono text-[10px]", known.className)}>{known.label}</Badge>
    );
  }
  return (
    <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground">
      {status || "—"}
    </Badge>
  );
}

/** Dòng meta "Huấn luyện lúc …" căn phải hàng tiêu đề khối. */
export function TrainedAtCaption({ trainedAt }: { trainedAt: string | null | undefined }) {
  if (!trainedAt) return null;
  return (
    <span className="ml-auto text-[11px] text-muted-foreground">
      Huấn luyện {formatDateTime(trainedAt)}
    </span>
  );
}

/** Empty-state 1 khối (dlMlp/rlQ null — chưa train). */
export function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed bg-muted/20 px-3 py-3 text-sm leading-relaxed text-muted-foreground">
      {children}
    </p>
  );
}
