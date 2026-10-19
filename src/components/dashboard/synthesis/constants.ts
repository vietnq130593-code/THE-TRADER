// (Task 144 P2-c) — tách từ synthesis-workspace.tsx (pure move)
// Bản đồ nhãn/màu (label maps) + mảng hằng module-level dùng chung các section
// của workspace Tổng hợp.

import type * as React from "react";
import { MoveRight, TrendingDown, TrendingUp } from "lucide-react";

/* ─────────────────── Label maps ─────────────────── */

export const DIRECTION: Record<string, { label: string; className: string }> = {
  BULLISH: { label: "TĂNG", className: "bg-up/15 text-up hover:bg-up/15" },
  BEARISH: { label: "GIẢM", className: "bg-down/15 text-down hover:bg-down/15" },
  NEUTRAL: { label: "ĐI NGANG", className: "bg-muted text-muted-foreground hover:bg-muted" },
};

export const STANCE: Record<string, { label: string; className: string }> = {
  BUY: { label: "MUA", className: "bg-up/15 text-up hover:bg-up/15" },
  SELL: { label: "BÁN", className: "bg-down/15 text-down hover:bg-down/15" },
  HOLD: { label: "GIỮ", className: "bg-muted text-muted-foreground hover:bg-muted" },
};

export const SECTOR_STANCE: Record<string, { label: string; className: string }> = {
  UP: { label: "TĂNG", className: "bg-up/15 text-up hover:bg-up/15" },
  DOWN: { label: "GIẢM", className: "bg-down/15 text-down hover:bg-down/15" },
  FLAT: { label: "ĐI NGANG", className: "bg-muted text-muted-foreground hover:bg-muted" },
};

export const REGIME_LABELS: Record<string, string> = {
  "risk-on": "Ưa rủi ro (risk-on)",
  "risk-off": "Né rủi ro (risk-off)",
  neutral: "Trung tính",
  bull: "Xu hướng tăng (bull)",
  bear: "Xu hướng giảm (bear)",
};

/* ─────────────────── 1b. B5 — Đa thị trường: posterior phân đoạn ─────────────────── */

export const SEGMENT_SHORT: Record<string, string> = {
  "VN-HOSE-STOCK": "HOSE",
  "VN-HNX-STOCK": "HNX",
  "VN-UPCOM-STOCK": "UPCOM",
  "VN-ETF": "ETF",
  "VN-INDEX": "INDEX",
  "VN-COMPOSITE": "VN tổng",
  INTERNATIONAL: "Quốc tế",
};

/* ─────────────────── 1c. B9 — Cổng đồng thuận 80% ─────────────────── */

/** Màu badge gate: ĐỒNG THUẬN xanh lá · ĐA SỐ YẾU vàng · KHÔNG ĐỒNG THUẬN đỏ. */
export const GATE_TONE: Record<string, string> = {
  CONSENSUS: "bg-emerald-600/15 text-emerald-700 dark:text-emerald-400",
  WEAK_MAJORITY: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  NO_CONSENSUS: "bg-rose-600/15 text-rose-700 dark:text-rose-400",
};

export const TALLY_DIRS = ["UP", "DOWN", "FLAT"] as const;

/* ─────────────────── 1d. Phiên #51 — CRB: Ủy ban Kiểm soát Định lượng ─────────────────── */

export const ALERT_TONE: Record<string, string> = {
  INFO: "bg-emerald-600/15 text-emerald-700 dark:text-emerald-400",
  WARNING: "bg-amber-600/15 text-amber-700 dark:text-amber-400",
  CRITICAL: "bg-rose-600/15 text-rose-700 dark:text-rose-400",
};

/* ─────────────────── 5. Bằng chứng & mức đóng góp ─────────────────── */

export const DRIVER_DIRECTION: Record<
  string,
  { label: string; icon: React.ComponentType<{ className?: string }>; className: string }
> = {
  UP: { label: "Tăng", icon: TrendingUp, className: "text-up" },
  DOWN: { label: "Giảm", icon: TrendingDown, className: "text-down" },
  FLAT: { label: "Đi ngang", icon: MoveRight, className: "text-muted-foreground" },
};
