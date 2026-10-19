/**
 * tests/market-session.test.ts — Task 144-P1 Tier 1 (docs/SECURITY.md §5).
 *
 * Unit test lịch & phiên giao dịch VN src/lib/market-session.ts — module
 * client-safe THUẦN (0 DB). Mọi mốc giờ được dựng từ epoch UTC rồi đối chiếu
 * quy ước ICT (UTC+7): 09:15 ICT = 02:15Z · 11:30 = 04:30Z · 13:00 = 06:00Z
 * · 14:45 = 07:45Z · 15:00 = 08:00Z. Ngày giao dịch chuẩn: T2 06/10/2025.
 */
import { describe, test, expect } from "bun:test";
import {
  vnDateIso,
  vnHolidayOf,
  VN_HOLIDAYS_OFFICIAL,
  SESSION_PHASE_LABEL,
  isTradingDay,
  isTradingSession,
  sessionPhase,
  nextTradingSessionOpen,
  shouldGenerateTicks,
} from "@/lib/market-session";

/** Epoch UTC — Thứ Hai 06/10/2025 (ngày giao dịch chuẩn, không lễ). */
const MON_OCT6 = (h: number, m = 0, s = 0): Date =>
  new Date(Date.UTC(2025, 9, 6, h, m, s));
/** Thứ Bảy 04/10/2025. */
const SAT_OCT4 = (h: number): Date => new Date(Date.UTC(2025, 9, 4, h));
/** Chủ nhật 05/10/2025. */
const SUN_OCT5 = (h: number): Date => new Date(Date.UTC(2025, 9, 5, h));

describe("vnDateIso — ranh giới ngày theo ICT (UTC+7)", () => {
  test("17:00Z = 00:00 ngày KẾ sang ICT", () => {
    expect(vnDateIso(new Date(Date.UTC(2025, 9, 5, 17, 0, 0)))).toBe("2025-10-06");
  });
  test("16:59:59Z vẫn là ngày cũ theo ICT", () => {
    expect(vnDateIso(new Date(Date.UTC(2025, 9, 5, 16, 59, 59)))).toBe("2025-10-05");
  });
  test("00:00Z là 07:00 sáng cùng ngày ICT", () => {
    expect(vnDateIso(new Date(Date.UTC(2026, 0, 1, 0, 0, 0)))).toBe("2026-01-01");
  });
});

describe("lịch lễ chính thức (nguồn sự thật tĩnh P2-4)", () => {
  test("Tết Bính Ngọ 2026 nghỉ 5 phiên 16-20/02", () => {
    for (const d of ["2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20"]) {
      expect(vnHolidayOf(d)).toBeDefined();
      expect(VN_HOLIDAYS_OFFICIAL.some((h) => h.date === d)).toBe(true);
    }
  });
  test("vnHolidayOf tra tên đúng + ngày thường → undefined", () => {
    expect(vnHolidayOf("2026-01-01")?.name).toBe("Tết Dương lịch");
    expect(vnHolidayOf("2025-12-25")).toBeUndefined();
    expect(vnHolidayOf("2026-03-09")).toBeUndefined();
  });
});

describe("isTradingDay — T2-T6 trừ lễ", () => {
  test("Thứ Hai → Thứ Sáu là ngày giao dịch", () => {
    // 06-10 (T2) · 07 (T3) · 08 (T4) · 09 (T5) · 10 (T6)
    for (let d = 6; d <= 10; d++) {
      expect(isTradingDay(new Date(Date.UTC(2025, 9, d, 3, 0, 0)))).toBe(true);
    }
  });
  test("Thứ Bảy + Chủ nhật không giao dịch", () => {
    expect(isTradingDay(SAT_OCT4(3))).toBe(false);
    expect(isTradingDay(SUN_OCT5(3))).toBe(false);
  });
  test("ngày lễ (dù đúng giờ phiên + thứ Hai) không giao dịch", () => {
    // 17/02/2026 thứ Ba — mùng 2 Tết; 16/02 thứ Hai — 29 Tết
    expect(isTradingDay(new Date(Date.UTC(2026, 1, 17, 3, 0, 0)))).toBe(false);
    expect(isTradingDay(new Date(Date.UTC(2026, 1, 16, 3, 0, 0)))).toBe(false);
    expect(isTradingDay(new Date(Date.UTC(2026, 3, 30, 3, 0, 0)))).toBe(false); // 30/04
  });
  test("ranh giới ngày theo ICT: 17:00Z Chủ nhật = 00:00 Thứ Hai ICT → giao dịch", () => {
    expect(isTradingDay(new Date(Date.UTC(2025, 9, 5, 17, 0, 0)))).toBe(true);
  });
});

describe("isTradingSession — phiên liên tục HOSE 09:15-11:30 / 13:00-14:45", () => {
  test("trong phiên sáng 02:15Z (09:15 ICT) → true", () => {
    expect(isTradingSession(MON_OCT6(2, 15, 0))).toBe(true);
    expect(isTradingSession(MON_OCT6(3, 30, 0))).toBe(true); // 10:30 ICT
  });
  test("1 giây TRƯỚC mở phiên → false", () => {
    expect(isTradingSession(MON_OCT6(2, 14, 59))).toBe(false);
  });
  test("nghỉ trưa 11:31 ICT → false", () => {
    expect(isTradingSession(MON_OCT6(4, 31, 0))).toBe(false);
  });
  test("biên 11:30:00 ICT vẫn trong phiên (khoảng đóng)", () => {
    expect(isTradingSession(MON_OCT6(4, 30, 0))).toBe(true);
  });
  test("phiên chiều 06:00Z (13:00 ICT) → true; biên đóng 07:45Z (14:45) → true", () => {
    expect(isTradingSession(MON_OCT6(6, 0, 0))).toBe(true);
    expect(isTradingSession(MON_OCT6(7, 45, 0))).toBe(true);
  });
  test("ATC 07:46Z (14:46 ICT) KHÔNG còn phiên liên tục → false", () => {
    expect(isTradingSession(MON_OCT6(7, 46, 0))).toBe(false);
  });
  test("cuối tuần đúng giờ phiên → false", () => {
    expect(isTradingSession(SAT_OCT4(3))).toBe(false);
    expect(isTradingSession(SUN_OCT5(3))).toBe(false);
  });
});

describe("sessionPhase — thang đầy đủ 6 pha theo ICT", () => {
  test("pre-open → morning → lunch → afternoon → atc → closed", () => {
    expect(sessionPhase(MON_OCT6(1, 0, 0))).toBe("pre-open"); // 08:00 ICT
    expect(sessionPhase(MON_OCT6(2, 15, 0))).toBe("morning"); // 09:15 ICT
    expect(sessionPhase(MON_OCT6(4, 30, 0))).toBe("morning"); // 11:30 (biên đóng)
    expect(sessionPhase(MON_OCT6(4, 30, 1))).toBe("lunch"); // 11:30:01
    expect(sessionPhase(MON_OCT6(5, 59, 59))).toBe("lunch"); // 12:59:59
    expect(sessionPhase(MON_OCT6(6, 0, 0))).toBe("afternoon"); // 13:00
    expect(sessionPhase(MON_OCT6(7, 45, 0))).toBe("afternoon"); // 14:45
    expect(sessionPhase(MON_OCT6(7, 45, 1))).toBe("atc"); // 14:45:01
    expect(sessionPhase(MON_OCT6(8, 0, 0))).toBe("atc"); // 15:00 (biên đóng)
    expect(sessionPhase(MON_OCT6(8, 0, 1))).toBe("closed"); // 15:00:01
  });
  test("ngoài ngày giao dịch (cuối tuần/lễ) → closed", () => {
    expect(sessionPhase(SAT_OCT4(3))).toBe("closed");
    expect(sessionPhase(new Date(Date.UTC(2026, 1, 17, 3, 0, 0)))).toBe("closed");
  });
  test("SESSION_PHASE_LABEL đủ nhãn 6 pha", () => {
    expect(Object.keys(SESSION_PHASE_LABEL).sort()).toEqual(
      ["afternoon", "atc", "closed", "lunch", "morning", "pre-open"]
    );
  });
});

describe("nextTradingSessionOpen — hint lệnh đang chờ (#96)", () => {
  test("đang trong phiên sáng → trả chính thời điểm vào + nhãn đang trong phiên", () => {
    const now = MON_OCT6(2, 30, 0);
    const r = nextTradingSessionOpen(now);
    expect(r.at.getTime()).toBe(now.getTime());
    expect(r.whenLabel).toBe("đang trong phiên");
  });
  test("đang trong phiên chiều → tương tự", () => {
    const now = MON_OCT6(6, 30, 0);
    expect(nextTradingSessionOpen(now).whenLabel).toBe("đang trong phiên");
  });
  test("trước mở sáng T2 → 09:15 ICT hôm nay (02:15Z)", () => {
    const r = nextTradingSessionOpen(MON_OCT6(1, 0, 0));
    expect(r.at.getTime()).toBe(Date.UTC(2025, 9, 6, 2, 15, 0));
    expect(r.whenLabel).toBe("Thứ Hai 06/10 · 09:15 ICT");
  });
  test("nghỉ trưa → 13:00 ICT hôm nay (06:00Z)", () => {
    const r = nextTradingSessionOpen(MON_OCT6(4, 45, 0));
    expect(r.at.getTime()).toBe(Date.UTC(2025, 9, 6, 6, 0, 0));
    expect(r.whenLabel).toBe("Thứ Hai 06/10 · 13:00 ICT");
  });
  test("sau ATC thứ Sáu (10/10 15:30 ICT) → 09:15 THỨ HAI 13/10", () => {
    const fri = new Date(Date.UTC(2025, 9, 10, 8, 30, 0));
    const r = nextTradingSessionOpen(fri);
    expect(r.at.getTime()).toBe(Date.UTC(2025, 9, 13, 2, 15, 0));
    expect(r.whenLabel).toBe("Thứ Hai 13/10 · 09:15 ICT");
  });
  test("Thứ Bảy → 09:15 Thứ Hai 06/10", () => {
    const r = nextTradingSessionOpen(SAT_OCT4(10));
    expect(r.at.getTime()).toBe(Date.UTC(2025, 9, 6, 2, 15, 0));
  });
  test("quét vượt Tết 5 phiên liền: sau ATC T6 13/02/2026 → T2 23/02/2026", () => {
    const fri = new Date(Date.UTC(2026, 1, 13, 8, 30, 0));
    const r = nextTradingSessionOpen(fri);
    expect(r.at.getTime()).toBe(Date.UTC(2026, 1, 23, 2, 15, 0));
    expect(r.whenLabel).toBe("Thứ Hai 23/02 · 09:15 ICT");
  });
});

describe("shouldGenerateTicks — simulator 24/7 vs strict session", () => {
  test("mặc định (không set MARKET_STRICT_SESSION) → true (simulator demo)", () => {
    const prev = process.env.MARKET_STRICT_SESSION;
    delete process.env.MARKET_STRICT_SESSION;
    try {
      expect(shouldGenerateTicks()).toBe(true);
    } finally {
      if (prev !== undefined) process.env.MARKET_STRICT_SESSION = prev;
    }
  });
  test("MARKET_STRICT_SESSION=true → đi theo isTradingSession(now) (boolean)", () => {
    const prev = process.env.MARKET_STRICT_SESSION;
    process.env.MARKET_STRICT_SESSION = "true";
    try {
      const out = shouldGenerateTicks();
      expect(typeof out).toBe("boolean");
      // đồng nhất định nghĩa: đúng bằng isTradingSession tại thời điểm gọi
      expect(out).toBe(isTradingSession(new Date()));
    } finally {
      if (prev !== undefined) process.env.MARKET_STRICT_SESSION = prev;
      else delete process.env.MARKET_STRICT_SESSION;
    }
  });
  test("MARKET_STRICT_SESSION != \"true\" (vd false) → vẫn simulator 24/7", () => {
    const prev = process.env.MARKET_STRICT_SESSION;
    process.env.MARKET_STRICT_SESSION = "false";
    try {
      expect(shouldGenerateTicks()).toBe(true);
    } finally {
      if (prev !== undefined) process.env.MARKET_STRICT_SESSION = prev;
      else delete process.env.MARKET_STRICT_SESSION;
    }
  });
});
