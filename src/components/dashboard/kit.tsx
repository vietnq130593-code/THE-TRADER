"use client";

/**
 * src/components/dashboard/kit.tsx — UIUX_UPGRADE_BLUEPRINT §2.4 (#110)
 * "Một ngôn ngữ thành phần": StatTile · ListRow · ChipMeta · VerdictBadge ·
 * Sparkline · EmptyState — mỗi thành phần MỘT mục đích, dùng lại mọi module
 * (đối xứng cách ML_OPS quản lý model: một nguồn, không bản sao rải rác).
 *
 * Quy tắc §2: màu chỉ mang 4 ngữ nghĩa — tăng (xanh dương --up) · giảm (đỏ
 * --down) · đứng/cảnh báo (amber) · thương hiệu/hành động (emerald-teal
 * --primary). Số trung tính KHÔNG tô màu tùy hứng — tabular-nums.
 */

import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/* ─────────────────── StatTile — ô KPI (tier-1) ─────────────────── */

export type StatTileTone = "up" | "down" | "flat" | "primary" | "neutral";

function toneTextClass(tone: StatTileTone): string {
  switch (tone) {
    case "up":
      return "text-up";
    case "down":
      return "text-down";
    case "flat":
      return "text-amber-600 dark:text-amber-400";
    case "primary":
      return "text-primary";
    default:
      return "text-foreground";
  }
}

export interface StatTileProps {
  /** Nhãn T3 (14px/500) — vd "Tổng tài sản". */
  label: string;
  /** Giá trị tier-1 (T1 · 700 · tabular) — số hoặc ReactNode có sẵn màu. */
  value: React.ReactNode;
  /** Dòng phụ T4 — vd "+2,3% so vốn" (tự tô theo tone khi là string). */
  sub?: React.ReactNode;
  /** Ngữ nghĩa màu cho value/sub (mặc định neutral — KHÔNG tô tùy hứng). */
  tone?: StatTileTone;
  /** Icon nhỏ bên phải nhãn (không bắt buộc). */
  icon?: LucideIcon;
  className?: string;
}

/**
 * Ô KPI tier-1 chuẩn §2.2/§3.1/§3.3: mặt `--tile-bg` (card + 1 mức nổi),
 * p-3, giá trị `.tier-1-value`. Dùng cho hàng 3–4 ô số lớn mở đầu mỗi module.
 */
export function StatTile({
  label,
  value,
  sub,
  tone = "neutral",
  icon: Icon,
  className,
}: StatTileProps) {
  return (
    <div
      className={cn(
        "kpi-tile rounded-lg border p-3",
        "flex min-w-0 flex-col gap-1",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-1.5">
        <p className="truncate text-sm font-medium text-muted-foreground">{label}</p>
        {Icon ? <Icon className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden="true" /> : null}
      </div>
      <p className={cn("tier-1-value truncate", toneTextClass(tone))}>{value}</p>
      {sub != null ? (
        <p className={cn("truncate text-xs tabular-nums", tone !== "neutral" ? toneTextClass(tone) : "text-muted-foreground")}>
          {sub}
        </p>
      ) : null}
    </div>
  );
}

/* ─────────────────── ListRow — nhãn trái · số phải ─────────────────── */

export interface ListRowProps {
  /** Nhãn bên trái (T3, muted). */
  label: React.ReactNode;
  /** Giá trị bên phải (tabular-nums · font-medium). */
  value: React.ReactNode;
  /** Tô màu giá trị theo ngữ nghĩa tăng/giảm/đứng. */
  tone?: StatTileTone;
  /** Nội dung thay thế hàng (vd badge) — khi có thì label/value bỏ. */
  children?: React.ReactNode;
  className?: string;
}

/** Hàng danh sách chuẩn §2.4: label trái — value phải · py-2.5 · px-4. */
export function ListRow({ label, value, tone = "neutral", children, className }: ListRowProps) {
  if (children != null) {
    return (
      <div className={cn("flex items-center gap-3 px-4 py-2.5", className)}>{children}</div>
    );
  }
  return (
    <div className={cn("flex items-center justify-between gap-3 px-4 py-2.5", className)}>
      <span className="min-w-0 truncate text-sm text-muted-foreground">{label}</span>
      <span className={cn("shrink-0 text-sm font-medium tabular-nums", toneTextClass(tone))}>
        {value}
      </span>
    </div>
  );
}

/* ─────────────────── ChipMeta — chip dữ liệu phụ ─────────────────── */

export interface ChipMetaProps {
  children: React.ReactNode;
  /** Ngữ nghĩa màu viền/chữ. */
  tone?: StatTileTone;
  title?: string;
  className?: string;
}

/** Chip meta T4/T5 — nguồn, timestamp, trạng thái nhỏ (§2.3 không trang trí). */
export function ChipMeta({ children, tone = "neutral", title, className }: ChipMetaProps) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium tabular-nums",
        tone === "up" && "border-up/40 text-up",
        tone === "down" && "border-down/40 text-down",
        tone === "flat" && "border-amber-500/40 text-amber-600 dark:text-amber-400",
        tone === "primary" && "border-primary/40 text-primary",
        tone === "neutral" && "border-border bg-muted/40 text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ─────────────────── VerdictBadge — phán quyết D-LEDGER ─────────────────── */

/** Phán quyết sổ đánh giá quyết định (D-LEDGER #106) — WIN/LOSS/NEUTRAL. */
export type Verdict = "WIN" | "LOSS" | "NEUTRAL";

export function verdictClass(verdict: string): string {
  if (verdict === "WIN") return "border-up/40 text-up";
  if (verdict === "LOSS") return "border-down/40 text-down";
  return "border-amber-500/40 text-amber-600 dark:text-amber-400";
}

export function verdictLabel(verdict: string): string {
  if (verdict === "WIN") return "LỢI";
  if (verdict === "LOSS") return "TỔN THẤT";
  return "ĐI NGANG";
}

export function VerdictBadge({ verdict, className }: { verdict: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full border px-1.5 py-0 text-[10px] font-semibold uppercase tracking-wide",
        verdictClass(verdict),
        className,
      )}
    >
      {verdictLabel(verdict)}
    </span>
  );
}

/* ─────────────────── Sparkline — SVG polyline dùng chung ─────────────────── */

export interface SparklineProps {
  /** Dãy số theo thời gian (cũ → mới). */
  values: number[];
  /** Chiều cao khung SVG (px) — mặc định 56. */
  height?: number;
  /** viewBox width cơ sở — mặc định 240 (tự co theo container). */
  width?: number;
  /** "auto" = xanh dương nếu cuối ≥ đầu, đỏ nếu giảm (ngữ nghĩa #45). */
  tone?: "auto" | "up" | "down" | "primary";
  /** Vẽ vùng phủ dưới đường (mờ 10%). */
  area?: boolean;
  /** Chấm cuối đường (điểm hiện tại). */
  endDot?: boolean;
  className?: string;
  ariaLabel?: string;
}

/**
 * Sparkline SVG chuẩn (pattern council-workspace #106 — tách ra kit dùng
 * chung #110): polyline + area mờ + chấm cuối · vectorEffect giữ nét khi co.
 */
export function Sparkline({
  values,
  height = 56,
  width = 240,
  tone = "auto",
  area = true,
  endDot = true,
  className,
  ariaLabel,
}: SparklineProps) {
  const n = values.length;
  if (n < 2) return null;
  const pad = 4;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.max(1, Math.abs(max) * 0.001);
  const xy = values.map((v, i) => ({
    x: pad + (i / (n - 1)) * (width - 2 * pad),
    y: height - pad - ((v - min) / span) * (height - 2 * pad),
  }));
  const line = xy.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const areaPoints = area
    ? `${pad},${height - pad} ${line} ${(width - pad).toFixed(1)},${height - pad}`
    : null;
  const rising = values[n - 1] >= values[0];
  const stroke =
    tone === "primary"
      ? "var(--color-primary)"
      : tone === "up" || (tone === "auto" && rising)
        ? "var(--color-up)"
        : "var(--color-down)";
  const fill =
    tone === "primary"
      ? "color-mix(in oklab, var(--color-primary) 12%, transparent)"
      : rising && tone !== "down"
        ? "color-mix(in oklab, var(--color-up) 12%, transparent)"
        : "color-mix(in oklab, var(--color-down) 12%, transparent)";
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={cn("w-full", className)}
      style={{ height }}
      role="img"
      aria-label={
        ariaLabel ??
        `Xu hướng ${n} điểm — từ ${values[0].toLocaleString("vi-VN")} đến ${values[n - 1].toLocaleString("vi-VN")}`
      }
      preserveAspectRatio="none"
    >
      {areaPoints ? <polygon points={areaPoints} fill={fill} /> : null}
      <polyline
        points={line}
        fill="none"
        stroke={stroke}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      {endDot ? (
        <circle
          cx={xy[xy.length - 1].x}
          cy={xy[xy.length - 1].y}
          r={3}
          fill={stroke}
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
    </svg>
  );
}

/* ─────────────────── EmptyState — trống kèm việc cần làm ─────────────────── */

export interface EmptyStateProps {
  icon?: LucideIcon;
  /** Câu chính (T2 16px/600). */
  title: string;
  /** Giải thích + "việc cần làm để có dữ liệu" (§2.5 trung thực trạng thái). */
  description?: React.ReactNode;
  /** Nút/hành động (vd "Chạy chu kỳ agents" chuyển workspace). */
  action?: React.ReactNode;
  className?: string;
}

/**
 * Empty-state chuẩn §2.5: KHÔNG còn 1 dòng mờ — có icon, có câu trả lời
 * "làm gì để có dữ liệu", có nút hành động (pattern NewsCard/RelationsCard
 * #103 — tách thành phần dùng chung #110).
 */
export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-8 text-center",
        className,
      )}
    >
      {Icon ? <Icon className="size-6 text-muted-foreground/60" aria-hidden="true" /> : null}
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {description ? (
        <div className="max-w-sm text-xs leading-relaxed text-muted-foreground">{description}</div>
      ) : null}
      {action ? <div className="mt-1 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}
