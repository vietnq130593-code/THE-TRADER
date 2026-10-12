/**
 * Lịch & phiên giao dịch VN (Q7/Q8 — DATA_SOURCES.md §5).
 * Timezone tính toán: Asia/Ho_Chi_Minh (UTC+7).
 *
 * P2-4 (phiên #62 — DATA_PLATFORM_BLUEPRINT §5): lịch nghỉ lễ Việt Nam
 * CHÍNH THỨC làm nguồn sự thật tĩnh (client-safe, sync — dùng cho UI + tick
 * + A9 fallback); phần overlay runtime (AppSetting "vn-holidays" — ngày lễ
 * đột xuất/tuỳ chỉnh không cần deploy) nằm ở src/lib/vn-calendar.ts phía
 * server và MERGE với danh sách này qua isOfficialTradingDay().
 */

/** Ngày VN "thật" của một thời điểm UTC (dịch +7h rồi lấy phần UTC). */
function vnShift(date: Date): Date {
  return new Date(date.getTime() + 7 * 3_600_000);
}

/** Ngày ISO (YYYY-MM-DD) theo Asia/Ho_Chi_Minh — ranh giới ngày luôn theo ICT (F-212). */
export function vnDateIso(date: Date = new Date()): string {
  return vnShift(date).toISOString().slice(0, 10);
}

export interface VnHoliday {
  date: string; // YYYY-MM-DD
  name: string;
  /** Ghi chú nguồn — "chính thức" = công bố đủ; "ước lượng" = chốt khi có công bố. */
  note?: string;
}

/**
 * Lịch nghỉ lễ Việt Nam CHÍNH THỨC (thị trường chứng khoán ngừng phiên —
 * khác ngày nghỉ cơ quan nhà nước khi có nghỉ bù cuối tuần).
 * Cập nhật hàng năm; 2027 là ƯỚC LƯỢNG theo quy luật công bố thường niên —
 * cập nhật khi Nhà nước/Sở công bố chính thức.
 */
export const VN_HOLIDAYS_OFFICIAL: VnHoliday[] = [
  // 2026 (fixbug #63 F-63C-01/F-63C-02 — đối chiếu công bố HOSE/HNX: Tết nghỉ
  // 5 phiên 16-20/02 (29 Tết → mùng 4); Quốc khánh nghỉ 31/8→2/9 do 2/9 rơi
  // thứ Tư, sở hoán đổi ngày làm việc T2 31/8, KHÔNG có phiên bù T7 22/8)
  { date: "2026-01-01", name: "Tết Dương lịch" },
  { date: "2026-02-16", name: "Tết Bính Ngọ (29 Tết)" },
  { date: "2026-02-17", name: "Tết Bính Ngọ (mùng 1)" },
  { date: "2026-02-18", name: "Tết Bính Ngọ (mùng 2)" },
  { date: "2026-02-19", name: "Tết Bính Ngọ (mùng 3)" },
  { date: "2026-02-20", name: "Tết Bính Ngọ (mùng 4)" },
  // F-110 (audit): Giỗ Tổ 10/3 âm = CN 26/04/2026 → thị trường nghỉ bù thứ Hai 27/04
  { date: "2026-04-27", name: "Giỗ Tổ Hùng Vương (nghỉ bù)" },
  { date: "2026-04-30", name: "Ngày Giải phóng miền Nam" },
  { date: "2026-05-01", name: "Ngày Quốc tế Lao động" },
  { date: "2026-08-31", name: "Quốc khánh (nghỉ hoán đổi)" },
  { date: "2026-09-01", name: "Quốc khánh (nghỉ liền)" },
  { date: "2026-09-02", name: "Quốc khánh" },
  // 2027 — ƯỚC LƯỢNG (Tết Đinh Mùi mùng 1 = 06/02/2027 Thứ Bảy; 02/09/2027
  // thứ Năm → KHÔNG nghỉ bù 03/09 — fixbug #63 F-63C-05)
  { date: "2027-01-01", name: "Tết Dương lịch", note: "ước lượng 2027" },
  { date: "2027-02-05", name: "Tết Đinh Mùi (30 Tết)", note: "ước lượng 2027" },
  { date: "2027-02-08", name: "Tết Đinh Mùi (mùng 3)", note: "ước lượng 2027" },
  { date: "2027-02-09", name: "Tết Đinh Mùi (mùng 4)", note: "ước lượng 2027" },
  { date: "2027-02-10", name: "Tết Đinh Mùi (mùng 5)", note: "ước lượng 2027" },
  { date: "2027-02-11", name: "Tết Đinh Mùi (mùng 6)", note: "ước lượng 2027" },
  { date: "2027-04-16", name: "Giỗ Tổ Hùng Vương (10/3 âm)", note: "ước lượng 2027" },
  { date: "2027-04-30", name: "Ngày Giải phóng miền Nam" },
  { date: "2027-05-03", name: "Ngày Quốc tế Lao động (nghỉ bù)", note: "ước lượng 2027" },
  { date: "2027-09-02", name: "Quốc khánh" },
];

/** Set tra cứu nhanh (sync — nội bộ module + isTradingDay). */
const VN_HOLIDAYS = new Set<string>(VN_HOLIDAYS_OFFICIAL.map((h) => h.date));

/** Tìm thông tin ngày lễ theo ISO date (tra cứu hiển thị). */
export function vnHolidayOf(iso: string): VnHoliday | undefined {
  return VN_HOLIDAYS_OFFICIAL.find((h) => h.date === iso);
}

// Biên phiên tính bằng GIÂY kể từ 00:00 ICT (F-111 — chính xác tới từng giây):
// 09:15:00=33300 · 11:30:00=41400 · 13:00:00=46800 · 14:45:00=53100 · 15:00:00=54000
const SEC_MORNING_OPEN = 9 * 3_600 + 15 * 60;
const SEC_MORNING_CLOSE = 11 * 3_600 + 30 * 60;
const SEC_PM_OPEN = 13 * 3_600;
const SEC_PM_CLOSE = 14 * 3_600 + 45 * 60;
const SEC_EOD = 15 * 3_600;

function vnSeconds(date: Date): number {
  const v = vnShift(date);
  return v.getUTCHours() * 3_600 + v.getUTCMinutes() * 60 + v.getUTCSeconds();
}

export function isTradingDay(date: Date): boolean {
  const v = vnShift(date);
  const dow = v.getUTCDay(); // 0 = CN, 6 = thứ 7
  if (dow === 0 || dow === 6) return false;
  const iso = v.toISOString().slice(0, 10);
  return !VN_HOLIDAYS.has(iso);
}

/** Phiên liên tục HOSE: 09:15–11:30 và 13:00–14:45 (ATC 14:45–15:00 tính riêng). */
export function isTradingSession(date: Date): boolean {
  if (!isTradingDay(date)) return false;
  const t = vnSeconds(date);
  return (
    (t >= SEC_MORNING_OPEN && t <= SEC_MORNING_CLOSE) ||
    (t >= SEC_PM_OPEN && t <= SEC_PM_CLOSE)
  );
}

export type SessionPhase =
  | "pre-open" // trước 09:15
  | "morning" // 09:15–11:30
  | "lunch" // 11:30–13:00
  | "afternoon" // 13:00–14:45
  | "atc" // 14:45–15:00
  | "closed"; // sau 15:00 hoặc ngoài ngày giao dịch

export function sessionPhase(date: Date): SessionPhase {
  if (!isTradingDay(date)) return "closed";
  const t = vnSeconds(date);
  if (t < SEC_MORNING_OPEN) return "pre-open";
  if (t <= SEC_MORNING_CLOSE) return "morning";
  if (t < SEC_PM_OPEN) return "lunch";
  if (t <= SEC_PM_CLOSE) return "afternoon";
  if (t <= SEC_EOD) return "atc";
  return "closed";
}

export const SESSION_PHASE_LABEL: Record<SessionPhase, string> = {
  "pre-open": "Trước phiên (ATO 09:00–09:15)",
  morning: "Liên tục sáng 09:15–11:30",
  lunch: "Nghỉ trưa 11:30–13:00",
  afternoon: "Liên tục chiều 13:00–14:45",
  atc: "ATC 14:45–15:00",
  closed: "Ngoài phiên",
};

/**
 * Có sinh tick giá mới không?
 * - MARKET_STRICT_SESSION=true → chỉ trong phiên (đúng Q7/Q8 cho nguồn thật);
 * - mặc định false → simulator chạy 24/7 cho demo (đã gắn nhãn "mô phỏng").
 */
export function shouldGenerateTicks(): boolean {
  if (process.env.MARKET_STRICT_SESSION === "true") {
    return isTradingSession(new Date());
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────
// #107 E-EXEC (COUNCIL_STEWARDSHIP_BLUEPRINT v2.0 §5.2) — phiên giao dịch
// PHI-VN cho matching lệnh sandbox đa thị trường. Client-safe thuần — chỉ
// toán ngày/giờ ICT, KHÔNG đụng DB. Đơn giản hoá trung thực (blueprint §7.5):
// US cố định 21:30–04:00 ICT (không đổi mùa đông/hè, không nghỉ lễ Mỹ) ·
// HK 09:30–12:00 + 13:00–16:00 ICT T2–T6 · forex & hàng hoá 24/5
// (T2 06:00 → T7 06:00 ICT). Trái phiếu Mỹ đi theo phiên US.
// ─────────────────────────────────────────────────────────────────

/** Loại phiên phi-VN — quyết định lúc nào lệnh sandbox thị trường đó được xét khớp. */
export type ForeignSessionKind = "US" | "HK" | "FX245";

const MIN_US_OPEN = 21 * 60 + 30; // 21:30 ICT
const MIN_US_CLOSE = 4 * 60; // 04:00 ICT
const MIN_HK_AM_OPEN = 9 * 60 + 30; // 09:30 ICT
const MIN_HK_AM_CLOSE = 12 * 60; // 12:00 ICT
const MIN_HK_PM_OPEN = 13 * 60; // 13:00 ICT
const MIN_HK_PM_CLOSE = 16 * 60; // 16:00 ICT
const MIN_FX_OPEN = 6 * 60; // 06:00 ICT (mở T2 06:00, đóng T7 06:00)

/** {dow ICT (0=CN), phút kể từ 00:00 ICT} của một thời điểm UTC. */
function ictDowMinutes(date: Date): { dow: number; minutes: number } {
  const v = vnShift(date);
  return {
    dow: v.getUTCDay(),
    minutes: v.getUTCHours() * 60 + v.getUTCMinutes(),
  };
}

/**
 * Phiên thị trường phi-VN có đang MỞ tại thời điểm cho trước?
 * - "US": T2–T6 (theo ngày giao dịch Mỹ): 21:30 ICT tối ngày D → 04:00 ICT sáng D+1.
 * - "HK": T2–T6 09:30–12:00 và 13:00–16:00 ICT.
 * - "FX245": 24/5 — T2 06:00 → T7 06:00 ICT (đóng cuối tuần từ T7 06:00 tới T2 06:00).
 */
export function isForeignSessionOpen(kind: ForeignSessionKind, date: Date = new Date()): boolean {
  const { dow, minutes: m } = ictDowMinutes(date);
  switch (kind) {
    case "US":
      // tối T2–T6 (21:30→24:00) hoặc sáng T3–T7 (00:00→04:00)
      return (dow >= 1 && dow <= 5 && m >= MIN_US_OPEN) || (dow >= 2 && dow <= 6 && m < MIN_US_CLOSE);
    case "HK":
      if (dow < 1 || dow > 5) return false;
      return (m >= MIN_HK_AM_OPEN && m < MIN_HK_AM_CLOSE) || (m >= MIN_HK_PM_OPEN && m < MIN_HK_PM_CLOSE);
    case "FX245":
      // đóng: T7 từ 06:00, toàn bộ CN, T2 trước 06:00
      if (dow === 6 && m >= MIN_FX_OPEN) return false;
      if (dow === 0) return false;
      if (dow === 1 && m < MIN_FX_OPEN) return false;
      return true;
    default:
      return false;
  }
}

// ─────────────────────────────────────────────────────────────────
// #96 — hint "lệnh đang chờ gì": phiên giao dịch KẾ TIẾP sẽ mở lúc nào.
// Nhu cầu gốc: trader thấy lệnh "Chờ khớp" đứng yên cả cuối tuần mà không
// biết hệ thống đang chờ mở phiên (matching engine chỉ chạy trong tick, tick
// chỉ chạy trong phiên khi MARKET_STRICT_SESSION=true) → tưởng đứt. Helper
// client-safe thuần — server dùng cho /api/orders, client hiển thị hint.
// ─────────────────────────────────────────────────────────────────

/** Nhãn thứ tiếng Việt (index = getUTCDay() của vnShift: 0 = CN). */
const DOW_VN = [
  "Chủ nhật",
  "Thứ Hai",
  "Thứ Ba",
  "Thứ Tư",
  "Thứ Năm",
  "Thứ Sáu",
  "Thứ Bảy",
];

export interface NextSessionOpen {
  /** Epoch UTC THẬT của thời điểm mở phiên (formatDateTime hiển thị đúng ICT). */
  at: Date;
  /** Nhãn hiển thị — vd "Thứ Hai 12/10 · 09:15 ICT". */
  whenLabel: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Dựng {at, whenLabel} cho một giờ mở (giây kể từ 00:00 ICT) của ngày ICT cho trước. */
function sessionOpenAt(vIct: Date, seconds: number): NextSessionOpen {
  const hh = Math.floor(seconds / 3_600);
  const mm = Math.round((seconds % 3_600) / 60);
  // Date.UTC theo trường ICT → epoch "như-UTC" — trừ 7h ra epoch UTC thật
  // (giữ invariant: formatDateTime(at) tại Asia/Ho_Chi_Minh hiển thị đúng giờ).
  const at = new Date(
    Date.UTC(
      vIct.getUTCFullYear(),
      vIct.getUTCMonth(),
      vIct.getUTCDate(),
      hh,
      mm,
      0
    ) - 7 * 3_600_000
  );
  return {
    at,
    whenLabel: `${DOW_VN[vIct.getUTCDay()]} ${pad2(vIct.getUTCDate())}/${pad2(
      vIct.getUTCMonth() + 1
    )} · ${pad2(hh)}:${pad2(mm)} ICT`,
  };
}

/**
 * Phiên giao dịch kế tiếp sẽ MỞ lúc nào?
 * - Đang trong phiên liên tục → trả chính thời điểm vào (whenLabel "đang trong phiên").
 * - Ngày giao dịch hôm nay chưa mở sáng → 09:15 hôm nay.
 * - Đang nghỉ trưa (11:30–13:00, vẫn ngày giao dịch) → 13:00 hôm nay.
 * - Sau ATC / cuối tuần / lễ → 09:15 NGÀY GIAO DỊCH KẾ (quét tối đa 16 ngày
 *   chống Tết nghỉ 5–9 phiên liền).
 */
export function nextTradingSessionOpen(date: Date = new Date()): NextSessionOpen {
  const phase = sessionPhase(date);
  if (phase === "morning" || phase === "afternoon") {
    return { at: date, whenLabel: "đang trong phiên" };
  }
  for (let i = 0; i < 16; i++) {
    const day = new Date(date.getTime() + i * 86_400_000);
    if (!isTradingDay(day)) continue;
    const v = vnShift(day);
    if (i === 0) {
      const t = vnSeconds(day);
      if (t < SEC_MORNING_OPEN) return sessionOpenAt(v, SEC_MORNING_OPEN);
      if (t >= SEC_MORNING_CLOSE && t < SEC_PM_OPEN) return sessionOpenAt(v, SEC_PM_OPEN);
      // t ≥ 14:45 (atc/closed) → đã qua mọi cửa mở hôm nay → quét ngày kế
      continue;
    }
    return sessionOpenAt(v, SEC_MORNING_OPEN);
  }
  // Lịch lễ dài bất thường — trung thực trả về thời điểm vào thay vì bịa.
  return { at: date, whenLabel: "—" };
}
