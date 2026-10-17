/**
 * F-16 (#129-D) — LỊCH CÔNG BỐ CHUỖI VĨ MÔ VIỆT NAM (config tĩnh, ước tính).
 *
 * Mục đích (docs/AI_ENGINEER_REVIEW_BRAIN.md §F-16): phân biệt "series đang
 * CHỜ công bố" với "series đang HỎNG". Quy tắc stale Q13 (monthly > 45 ngày /
 * quarterly > 120 ngày không kỳ mới) chỉ nói "lâu rồi không có số mới" —
 * lịch công bố trả lời thêm câu "số kế tiếp dự kiến khi nào". Chuỗi CPI công
 * bố ~29 hằng tháng: stale ở ngày 10 với kỳ release kế ước tính 29/10 là
 * "đang chờ số mới" chứ không phải nguồn chết.
 *
 * Tính chất: TUYỆT ĐỐI TĨNH — không gọi mạng, không đụng DB, không LLM. Ước
 * lượng theo chu kỳ công bố đã biết của các nguồn chính thức:
 * - GSO/TCTK:  CPI ~ngày 29 hằng tháng · GDP quý ~T+20 ngày sau cuối quý ·
 *   tín dụng/M2 ~ngày 10–15 tháng sau · XNK/FDI ~cuối tháng.
 * - S&P Global: PMI sản xuất phát hành đầu tháng kế.
 * - SBV: họp điều hành lãi suất tối đa ~4 lần/năm (khoảng T1–T3 · giữa năm ·
 *   Q3 · Q4) — chỉ khai báo "khoảng", không giả vờ biết ngày họp thật.
 * - TPCP VN 10Y & lãi liên ngân hàng: giao dịch liên tục — không có lịch
 *   công bố định kỳ (dateISO = null).
 *
 * Mọi note đều chốt đuôi "ước tính lịch công bố tham khảo" — đây KHÔNG phải
 * cam kết lịch thật của GSO/SBV; UI/prompt phải trình bày như ước tính.
 */

export interface ReleaseEstimate {
  /** Ngày ước tính công bố kế tiếp (ISO "YYYY-MM-DD") — null khi chuỗi liên tục. */
  dateISO: string | null;
  /** Mô tả quy tắc + disclaimer "ước tính lịch công bố tham khảo". */
  note: string;
}

/** 4 loại quy tắc tuần hoàn mà lịch tĩnh có thể khai báo. */
type CalendarRule =
  /** ~ngày D hằng tháng (CPI 29 · tín dụng/M2 13 · PMI 1 · XNK/FDI 29). */
  | { kind: "monthly-day"; day: number; note: string }
  /** ~T+lagDays sau ngày cuối quý (GDP ~T+20). */
  | { kind: "quarter-lag"; lagDays: number; note: string }
  /** ~N cửa sổ trong năm (SBV ≤4 kỳ — khai báo "khoảng", tháng 0-based). */
  | { kind: "yearly-windows"; windows: Array<[number, number]>; note: string }
  /** Giao dịch liên tục — không có lịch định kỳ (TPCP 10Y, liên ngân hàng). */
  | { kind: "continuous"; note: string };

const DISCLAIMER = "ước tính lịch công bố tham khảo";

const CALENDAR: Record<string, CalendarRule> = {
  CPI_YOY: {
    kind: "monthly-day",
    day: 29,
    note: "GSO/TCTK công bố CPI khoảng ngày 29 hằng tháng",
  },
  GDP_YOY: {
    kind: "quarter-lag",
    lagDays: 20,
    note: "GSO công bố GDP quý khoảng 20 ngày sau khi quý kết thúc",
  },
  SBV_REFI_RATE: {
    kind: "yearly-windows",
    // Tháng 0-based: [T1–T3] · [T6–T7] · [T9–T10] · [T11–T12].
    windows: [
      [0, 2],
      [5, 6],
      [8, 9],
      [10, 11],
    ],
    note: "SBV họp điều hành lãi suất tối đa ~4 lần/năm (khoảng T1–T3 · giữa năm · Q3 · Q4) — chỉ biết 'khoảng', không có ngày cố định",
  },
  CREDIT_YOY: {
    kind: "monthly-day",
    day: 13,
    note: "GSO/SBV công bố tăng trưởng tín dụng khoảng ngày 10–15 tháng sau",
  },
  M2_YOY: {
    kind: "monthly-day",
    day: 13,
    note: "SBV công bố M2 khoảng ngày 10–15 tháng sau",
  },
  PMI_MANU: {
    kind: "monthly-day",
    day: 1,
    note: "S&P Global phát hành PMI sản xuất đầu tháng kế (ngày làm việc đầu tiên)",
  },
  VNGB_10Y: {
    kind: "continuous",
    note: "Trái phiếu chính phủ VN kỳ hạn 10 năm giao dịch liên tục — không có lịch công bố định kỳ",
  },
  INTERBANK_OVN: {
    kind: "continuous",
    note: "Lãi liên ngân hàng qua đêm quan sát hằng ngày — không có lịch công bố định kỳ",
  },
  TRADE_BAL: {
    kind: "monthly-day",
    day: 29,
    note: "GSO công bố cán cân thương mại ~cuối tháng (cùng đợt số liệu CPI)",
  },
  FDI_DISB: {
    kind: "monthly-day",
    day: 29,
    note: "GSO công bố FDI vốn thực hiện giải ngân ~cuối tháng",
  },
};

const DAY_MS = 86_400_000;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * F-16 — ước tính kỳ công bố KẾ TIẾP của một chuỗi vĩ mô, tính từ `asOf`.
 *
 * Thuần toán lịch UTC (không lệch múi giờ deploy), hoàn toàn deterministic —
 * cùng (seriesKey, asOf) luôn ra cùng kết quả. Trả {dateISO: null} cho chuỗi
 * liên tục hoặc key chưa khai báo; note LUÔN chứa disclaimer ước tính.
 */
export function nextReleaseEstimate(
  seriesKey: string,
  asOf: Date = new Date()
): ReleaseEstimate {
  const rule = CALENDAR[seriesKey];
  if (!rule) {
    return {
      dateISO: null,
      note: `Chưa khai báo lịch công bố cho chuỗi "${seriesKey}" — ${DISCLAIMER}`,
    };
  }

  switch (rule.kind) {
    case "continuous": {
      return { dateISO: null, note: `${rule.note} — ${DISCLAIMER}` };
    }

    case "monthly-day": {
      // Ứng viên gần nhất: ngày D của tháng hiện tại; đã qua asOf → tháng sau
      // (Date.UTC tự wrap tháng 12 → tháng 1 năm kế).
      const y = asOf.getUTCFullYear();
      const m = asOf.getUTCMonth();
      let cand = new Date(Date.UTC(y, m, rule.day));
      if (cand.getTime() <= asOf.getTime()) {
        cand = new Date(Date.UTC(y, m + 1, rule.day));
      }
      return { dateISO: isoDate(cand), note: `${rule.note} — ${DISCLAIMER}` };
    }

    case "quarter-lag": {
      // Ứng viên = (ngày cuối quý + lagDays) của mọi quý lân cận asOf.
      const y = asOf.getUTCFullYear();
      const candidates: Date[] = [];
      for (const yr of [y - 1, y, y + 1]) {
        for (const month of [2, 5, 8, 11]) {
          // Date.UTC(yr, month + 1, 0) = ngày CUỐI CÙNG của tháng `month`.
          const quarterEnd = new Date(Date.UTC(yr, month + 1, 0));
          candidates.push(new Date(quarterEnd.getTime() + rule.lagDays * DAY_MS));
        }
      }
      candidates.sort((a, b) => a.getTime() - b.getTime());
      const next = candidates.find((c) => c.getTime() > asOf.getTime()) ?? null;
      return {
        dateISO: next ? isoDate(next) : null,
        note: `${rule.note} — ${DISCLAIMER}`,
      };
    }

    case "yearly-windows": {
      // Ứng viên = giữa mỗi cửa sổ họp (ngày 15 của tháng giữa cửa sổ) —
      // "khoảng" là bản chất của lịch SBV, không giả chính xác.
      const y = asOf.getUTCFullYear();
      const candidates: Date[] = [];
      for (const yr of [y - 1, y, y + 1]) {
        for (const [start, end] of rule.windows) {
          const mid = Math.round((start + end) / 2);
          candidates.push(new Date(Date.UTC(yr, mid, 15)));
        }
      }
      candidates.sort((a, b) => a.getTime() - b.getTime());
      const next = candidates.find((c) => c.getTime() > asOf.getTime()) ?? null;
      return {
        dateISO: next ? isoDate(next) : null,
        note: `${rule.note} — ${DISCLAIMER}`,
      };
    }
  }
}
