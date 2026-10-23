/**
 * src/lib/ml/ss/calendar.ts — SS-3 · BỎ CẬP NHẬT THAY VÌ BỊA SỐ (ch. 5).
 *
 * STATE_SPACE_BLUEPRINT SS-3 "Phiên thiếu / mã treo": mã ngừng giao dịch,
 * IPO giữa cửa sổ, nghỉ Tết — dữ liệu lởm chởm. Kalman xử lý bằng skip-update
 * (kalman.ts đã có từ Phase 1 + kiểm định T5 p176) — file này là CẦU NỐI vào
 * ĐƯỜNG THẬT: dựng LỊCH PHIÊN (union ngày của rổ), căn từng mã về lịch đó
 * (null = thiếu), và dựng chỉ số rổ theo LỊCH (không còn trôi pha khi một mã
 * thiếu phiên — trước đây buildBasketIndex căn theo INDEX mảng compact, mã
 * thiếu 3 phiên làm chuỗi lệch pha nhau).
 *
 * Ranh giới triết lý (Phần III SS-3): SS chỉ là lựa chọn CHO CÁC ĐƯỜNG DỰ
 * BÁO — KHÔNG đổi featureset dl-mlp đang serving (đòi digest bump — Phần VI
 * mục 3). Tầng feature giữ nguyên MacroContext "absent" trung thực F-166b-3.
 *
 * Pure function, 0 DB, 0 dependency ngoài. Chuỗi dày (không thiếu phiên) →
 * alignedBasketIndex ĐỒNG NHẤT buildBasketIndex cũ (p178 T-P2-2 regression).
 */

/** Lịch phiên = union ngày (YYYY-MM-DD, tăng dần) của các chuỗi thành phần. */
export function unionCalendar(dateLists: string[][]): string[] {
  const set = new Set<string>();
  for (const dates of dateLists) {
    for (const d of dates) set.add(d);
  }
  return [...set].sort();
}

/**
 * Căn chuỗi closes về lịch: closesByDate.get(date) ?? null. Ngày có bar nhưng
 * close ≤ 0 → null (không dùng — trung thực như loadSegmentBaskets lọc sẵn).
 */
export function alignSeries(
  dates: string[],
  closes: number[],
  calendar: string[]
): { closes: (number | null)[]; present: number } {
  const byDate = new Map<string, number>();
  for (let i = 0; i < dates.length && i < closes.length; i++) {
    const c = closes[i];
    if (c != null && Number.isFinite(c) && c > 0) byDate.set(dates[i]!, c);
  }
  const out: (number | null)[] = [];
  let present = 0;
  for (const d of calendar) {
    const v = byDate.get(d) ?? null;
    if (v != null) present++;
    out.push(v);
  }
  return { closes: out, present };
}

/** Kết quả dựng rổ theo lịch. */
export interface AlignedBasket {
  /** Lịch phiên đã cắt về cửa sổ (tăng dần). */
  dates: string[];
  /** Chỉ số rổ theo lịch — null = ngày KHÔNG mã nào có giá (hiếm: lỗi dữ liệu). */
  closes: (number | null)[];
  /** Số mã đóng góp (≥60 điểm trong cửa sổ — cùng tiêu chí buildBasketIndex). */
  symbols: number;
  /** Số ngày lịch có ≥1 mã có mặt. */
  presentDays: number;
}

/**
 * Chỉ số rổ EQUAL-WEIGHT theo LỊCH (thay buildBasketIndex căn-index-compact):
 * mỗi mã chuẩn hoá về close CÓ MẶT ĐẦU TIÊN của chính nó trong cửa sổ lịch,
 * mỗi ngày lấy trung bình các mã CÓ MẶT hôm đó (skip — không bịa fill). Mã
 * thiếu phiên đầu cửa sổ vẫn đóng góp từ ngày có mặt (không cắt ngắn cửa sổ
 * của cả rổ như bản cũ n = min(lengths)).
 */
export function alignedBasketIndex(
  series: { dates: string[]; closes: number[] }[],
  sessions: number
): AlignedBasket {
  if (series.length === 0 || sessions < 2) {
    return { dates: [], closes: [], symbols: 0, presentDays: 0 };
  }
  // Lịch full → cắt cửa sổ `sessions` ngày cuối
  const fullCalendar = unionCalendar(series.map((s) => s.dates));
  const calendar = fullCalendar.slice(-Math.max(2, Math.floor(sessions)));

  const usable: { byDate: Map<string, number>; base: number }[] = [];
  for (const s of series) {
    const { closes: aligned, present } = alignSeries(s.dates, s.closes, calendar);
    if (present < 60) continue; // cùng ngưỡng usable của buildBasketIndex cũ
    // base = close CÓ MẶT đầu tiên trong cửa sổ lịch
    let base: number | null = null;
    for (const c of aligned) {
      if (c != null) {
        base = c;
        break;
      }
    }
    if (base == null || !(base > 0)) continue;
    const byDate = new Map<string, number>();
    calendar.forEach((d, i) => {
      const c = aligned[i];
      if (c != null) byDate.set(d, c / base);
    });
    usable.push({ byDate, base });
  }
  if (usable.length === 0) {
    return { dates: calendar, closes: calendar.map(() => null), symbols: 0, presentDays: 0 };
  }

  const closes: (number | null)[] = calendar.map((d) => {
    let sum = 0;
    let count = 0;
    for (const u of usable) {
      const v = u.byDate.get(d);
      if (v != null) {
        sum += v;
        count++;
      }
    }
    return count > 0 ? sum / count : null;
  });
  const presentDays = closes.filter((c) => c != null).length;
  return { dates: calendar, closes, symbols: usable.length, presentDays };
}
