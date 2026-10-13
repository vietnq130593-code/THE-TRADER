"use client";

/**
 * settings/step-badge.tsx (M4.8 #110 — UIUX_UPGRADE_BLUEPRINT §4) — chip số
 * bước tròn cạnh CardTitle của 3 card chính trong workspace Cài đặt:
 * 1 Kết nối → 2 Chạy agent → 3 Thử nghiệm (các card còn lại là "cấu hình bổ
 * sung" — không số). Dùng chung settings-workspace + sandbox-card.
 */

export function StepBadge({ n, label }: { n: 1 | 2 | 3; label: string }) {
  return (
    <span
      aria-label={`Bước ${n} — ${label}`}
      title={`Bước ${n} — ${label}`}
      className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-bold tabular-nums text-primary"
    >
      {n}
    </span>
  );
}
