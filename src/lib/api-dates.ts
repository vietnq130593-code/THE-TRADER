/**
 * Shared date-param helpers cho API routes (fixbug #109 — scope `api`).
 *
 * GỐC LỖI của cả lớp F-1081-01/F-1091-01: mỗi route tự khai báo
 * `const DATE_RE = /^\d{4}-\d{2}-\d{2}$/` rồi tin regex là đủ — nhưng regex chỉ
 * bắt SAI ĐỊNH DẠNG, KHÔNG bắt 2 dạng sai NGỮ NGHĨA:
 *   (a) "2026-13-01" (tháng 13) / "2026-10-32" (ngày 32) — vượt regex,
 *       `new Date(\`${s}T00:00:00+07:00\`)` → Invalid Date → Prisma
 *       PrismaClientValidationError → HTTP 500 (đã verify live dev.log #109).
 *   (b) "2026-02-30" / "2026-11-31" — vượt regex VÀ parse KHÔNG NaN mà
 *       ROLL-OVER sang tháng sau (2026-02-30 → 03-02) → 200 nhưng lọc sai
 *       khoảng im lặng (lớp F-63C-09 quay lại qua đường API).
 *
 * Chuẩn hoá về MỘT nguồn (pattern round-trip đã chứng minh ở market/calendar
 * + settings F-63C-09): parse mốc UTC → NaN check → round-trip
 * `toISOString().slice(0,10) === s` bắt cả (a) lẫn (b); ngày thật (kể cả
 * 2024-02-29 năm nhuận) luôn pass.
 */

/** Định dạng "YYYY-MM-DD" (chỉ cú pháp —语义 kiểm bằng isValidIctDay). */
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Ngày "YYYY-MM-DD" là NGÀY THẬT trên lịch: đúng cú pháp + parse được +
 * KHÔNG roll-over (round-trip UTC). Bắt: tháng 13, ngày 32, 2026-02-30,
 * 2026-02-29 năm thường — mọi ngày hợp lệ đều pass.
 */
export function isValidIctDay(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const t = new Date(`${s}T00:00:00.000Z`).getTime();
  if (Number.isNaN(t)) return false;
  return new Date(t).toISOString().slice(0, 10) === s;
}

/** Ngày bắt đầu ICT (00:00 +07:00) của chuỗi "YYYY-MM-DD" ĐÃ qua isValidIctDay. */
export function ictDayStart(date: string): Date {
  return new Date(`${date}T00:00:00+07:00`);
}

/** Ngày kết thúc ICT (cuối ngày +07:00) của chuỗi "YYYY-MM-DD" ĐÃ qua isValidIctDay. */
export function ictDayEnd(date: string): Date {
  return new Date(`${date}T23:59:59.999+07:00`);
}
