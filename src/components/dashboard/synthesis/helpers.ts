// (Task 144 P2-c) — tách từ synthesis-workspace.tsx (pure move)
// Helper format số liệu vi-VN (1–2 chữ số thập phân, dấu − U+2212) dùng chung
// các section của workspace Tổng hợp.

import { SEGMENT_SHORT } from "./constants";

/* ─────────────────── Format helpers (vi-VN, 1 chữ số thập phân) ─────────────────── */

export const nf1 = new Intl.NumberFormat("vi-VN", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
export const nf2 = new Intl.NumberFormat("vi-VN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "42,3%" — NHẬP TỶ LỆ 0..1 (pUp/confidence…) → nhân 100. */
export function pct1(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${nf1.format(n * 100)}%`;
}

/** "+1,2%" / "−0,8%" */
export function pct1s(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  const s = nf1.format(Math.abs(n));
  return n > 0 ? `+${s}%` : n < 0 ? `−${s}%` : `0%`;
}

/** "−0,42" (số có dấu, 2 chữ số) */
export function signed2(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  const s = nf2.format(Math.abs(n));
  return n > 0 ? `+${s}` : n < 0 ? `−${s}` : "0,00";
}

/** "22,5%" — giá trị đã Ở DẠNG % (không nhân 100). */
export function pctRaw(n: number | null | undefined, digits = 1): string {
  if (n == null || Number.isNaN(n)) return "—";
  const nf = digits === 2 ? nf2 : nf1;
  return `${nf.format(n)}%`;
}

/* ─────────────────── Đa thị trường (B5) ─────────────────── */

/** Nhãn ngắn mỗi segment (dòng phụ trọng số + bản compact ở overview). */
export function segmentShort(segment: string): string {
  return SEGMENT_SHORT[segment] ?? segment;
}

/** "% nguyên" — segment quá nhẹ (<0,5%) hiển thị "<1%" trung thực hơn "0%". */
export function formatShare(share: number | null): string | null {
  if (share == null) return null;
  const pct = Math.round(share * 100);
  return pct > 0 ? `${pct}%` : share > 0 ? "<1%" : "0%";
}
