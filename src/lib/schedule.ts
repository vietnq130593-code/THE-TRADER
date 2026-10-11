/**
 * src/lib/schedule.ts — K3 "Nhiệm vụ định kỳ" (AUTONOMY_BLUEPRINT v1.1 §6.1).
 *
 * Module parser lịch CHUNG cho engine + API + UI (1 nguồn sự thật — đúng
 * nguyên tắc "cú pháp lịch = grammar engine sẵn có, không phát minh cron mới").
 * Engine mini-services/market-engine giữ bản parseHhMm/parseWeekly riêng cho
 * 7 lịch env của nó (không refactor rủi ro) — module này TÁI DÙNG cùng ngữ
 * nghĩa tuyệt đối:
 *
 *   "HH:MM"      → hằng ngày   (ví dụ "09:30")
 *   "DOW:HH:MM"  → hằng tuần   (ví dụ "MON:09:30"; DOW ∈ MON..TUE..SUN)
 *   "D:HH:MM"    → hằng tuần dạng số cũ của engine env (0=CN..6=T7)
 *   null/""      → nhiệm vụ tay 1 lần (không có lịch)
 *
 * Giờ tính theo ICT (UTC+7) — cùng cách engine đang dùng cho EOD_SYNC
 * (ictNow(): dịch trục +7h rồi đọc phần UTC) — không lệ thuộc timezone
 * tiến trình server. Toàn bộ hàm THUẦN (không import DB) để verify script
 * kiểm trực tiếp.
 */

/** Phút trong ngày ICT (0..1439). */
export type ScheduleMinutes = number;

/** Kết quả parse grammar lịch. */
export type ScheduleGrammar =
  | { kind: "daily"; minutes: ScheduleMinutes }
  | { kind: "weekly"; minutes: ScheduleMinutes; dow: number };

/** ICT = UTC+7 (Việt Nam không có DST — offset cố định round-year). */
export const ICT_OFFSET_MS = 7 * 3_600_000;

/** Thứ trong tuần (JS getDay(): 0=Chủ nhật .. 6=Thứ bảy). */
export const DOW_NAMES: Record<string, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

/** Tên thứ tiếng Việt hiển thị UI — index theo dow 0..6. */
export const DOW_LABELS_VN: readonly string[] = [
  "Chủ nhật",
  "thứ Hai",
  "thứ Ba",
  "thứ Tư",
  "thứ Năm",
  "thứ Sáu",
  "thứ Bảy",
];

/** "HH:MM" → phút kể từ nửa đêm; sai định dạng/giờ → null. */
export function parseHhMm(s: string): ScheduleMinutes | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** "SUN:HH:MM" (tên 3 chữ) hoặc "0:HH:MM" (0=CN..6=T7) → {dow, minutes};
 *  sai → null. Cùng ngữ nghĩa parseWeekly của engine index.ts. */
export function parseWeekly(s: string): { dow: number; minutes: number } | null {
  const m = /^(SUN|MON|TUE|WED|THU|FRI|SAT):(\d{1,2}):(\d{2})$/i.exec(s.trim());
  if (m) {
    const h = Number(m[2]);
    const min = Number(m[3]);
    if (h > 23 || min > 59) return null;
    return { dow: DOW_NAMES[m[1].toUpperCase()]!, minutes: h * 60 + min };
  }
  // Hình cũ "D:HH:MM" (0=CN..6=T7) — tương thích env engine đã set theo số.
  const d = /^(\d):(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!d) return null;
  const dow = Number(d[1]);
  const h = Number(d[2]);
  const min = Number(d[3]);
  if (dow > 6 || h > 23 || min > 59) return null;
  return { dow, minutes: h * 60 + min };
}

/** Parser chính cho cột AgentTask.schedule — null khi không phải grammar nào. */
export function parseScheduleGrammar(s: string): ScheduleGrammar | null {
  const daily = parseHhMm(s);
  if (daily != null) return { kind: "daily", minutes: daily };
  const weekly = parseWeekly(s);
  if (weekly) return { kind: "weekly", minutes: weekly.minutes, dow: weekly.dow };
  return null;
}

/**
 * Lần due kế tiếp kể từ `from` (mặc định now), trả Date (UTC instant):
 *  - daily  : giờ đó HÔM NAY (ICT) nếu còn tới (strict > from), không thì
 *             NGÀY MAI đúng giờ;
 *  - weekly : thứ gần nhất >= hôm nay đúng giờ; đúng hôm nay nhưng đã qua
 *             giờ → TUẦN SAU (không phát sinh 2 due cùng slot đã trôi).
 *
 * Giải thuật trục ICT: dịch +7h → mọi phép toán theo "ngày UTC của trục
 * dịch" (86.400.000ms) — không DST, không lệ thuộc timezone server.
 * Ném Error khi schedule không hợp lệ — caller phải validate bằng
 * parseScheduleGrammar TRƯỚC (mọi route đã làm vậy).
 */
export function computeNextDueAt(schedule: string, from: Date = new Date()): Date {
  const g = parseScheduleGrammar(schedule);
  if (!g) throw new Error(`Lịch không hợp lệ: "${schedule}"`);
  const ictMs = from.getTime() + ICT_OFFSET_MS;
  // Nửa đêm ICT của "ngày ICT hiện tại" (bắt đầu ngày theo trục dịch).
  const dayStart = Math.floor(ictMs / 86_400_000) * 86_400_000;
  if (g.kind === "daily") {
    const todaySlot = dayStart + g.minutes * 60_000;
    const nextSlot = todaySlot > ictMs ? todaySlot : todaySlot + 86_400_000;
    return new Date(nextSlot - ICT_OFFSET_MS);
  }
  // weekly — dow của ngày ICT hiện tại (getUTCDay trên mốc nửa đêm trục dịch)
  const dowNow = new Date(dayStart).getUTCDay();
  let diff = (g.dow - dowNow + 7) % 7;
  const todaySlot = dayStart + g.minutes * 60_000;
  if (diff === 0 && todaySlot <= ictMs) diff = 7;
  return new Date(dayStart + diff * 86_400_000 + g.minutes * 60_000 - ICT_OFFSET_MS);
}

/**
 * Chuỗi tiếng Việt hiển thị UI:
 *   "09:30"      → "hằng ngày 09:30"
 *   "MON:09:30"  → "hằng tuần thứ Hai 09:30"
 *   "SUN:04:00"  → "hằng tuần Chủ nhật 04:00"
 * Chuỗi sai grammar → trả nguyên chuỗi (UI vẫn hiển thị được để trader sửa).
 */
export function describeSchedule(s: string | null | undefined): string {
  if (!s) return "Một lần (tay)";
  const g = parseScheduleGrammar(s);
  if (!g) return s;
  const hhmm = `${String(Math.floor(g.minutes / 60)).padStart(2, "0")}:${String(g.minutes % 60).padStart(2, "0")}`;
  if (g.kind === "daily") return `hằng ngày ${hhmm}`;
  return `hằng tuần ${DOW_LABELS_VN[g.dow]} ${hhmm}`;
}

/** Định dạng "HH:MM" từ phút — dùng UI form dựng lại chuỗi schedule. */
export function minutesToHhMm(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
