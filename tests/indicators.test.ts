/**
 * tests/indicators.test.ts — Task 144-P1 Tier 1 (docs/SECURITY.md §5).
 *
 * Unit test chỉ báo kỹ thuật src/lib/indicators.ts — sma/rsi/pctChange/
 * latestVsMean/macd/bollinger/atr/obv/stochastic, toàn bộ hàm thuần trên
 * mảng ascending. Fixture tính tay: RSI Wilder 14 trên chuỗi 15 giá (seed
 * gain/loss = 10/4 → RSI 71,4286), Bollinger 20 trên chuỗi 19×10 + 30.
 */
import { describe, test, expect } from "bun:test";
import {
  sma,
  rsi,
  pctChange,
  latestVsMean,
  macd,
  bollinger,
  atr,
  obv,
  stochastic,
  type PriceBar,
} from "@/lib/indicators";

describe("sma", () => {
  test("trung bình `period` giá cuối — [1..5] period 3 → 4", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toBeCloseTo(4, 12);
    expect(sma([1, 2, 3, 4, 5], 5)).toBeCloseTo(3, 12);
  });
  test("thiếu dữ liệu → null", () => {
    expect(sma([1, 2], 3)).toBeNull();
    expect(sma([], 1)).toBeNull();
  });
  test("period 1 → giá cuối cùng", () => {
    expect(sma([7, 9, 11], 1)).toBe(11);
  });
});

describe("rsi — Wilder 14", () => {
  test("chuỗi 15 giá seed 10 gain / 4 loss → RSI = 71,4286 (tính tay)", () => {
    // diff: +1,+1,−1,+1,+1,−1,+1,+1,−1,+1,+1,−1,+1,+1
    // avgGain = 10/14, avgLoss = 4/14 → rs = 2,5 → RSI = 100 − 100/3,5
    const closes = [10, 11, 12, 11, 12, 13, 12, 13, 14, 13, 14, 15, 14, 15, 16];
    expect(rsi(closes, 14)).toBeCloseTo(100 - 100 / 3.5, 8);
    expect(rsi(closes, 14)).toBeCloseTo(71.428571, 5);
  });
  test("toàn gain (tăng đều) → RSI = 100 chuẩn Wilder", () => {
    expect(rsi(Array.from({ length: 15 }, (_, i) => i + 1), 14)).toBe(100);
  });
  test("chuỗi PHẲNG → null (F-118 — không có xu hướng đo được)", () => {
    expect(rsi(Array(15).fill(10), 14)).toBeNull();
  });
  test("chuỗi ngắn hơn period+1 → null", () => {
    expect(rsi([10, 11, 12], 14)).toBeNull();
    expect(rsi(Array(14).fill(10), 14)).toBeNull();
  });
  test("mặc định period = 14 (không truyền cũng vậy)", () => {
    const closes = [10, 11, 12, 11, 12, 13, 12, 13, 14, 13, 14, 15, 14, 15, 16];
    expect(rsi(closes)).toBeCloseTo(rsi(closes, 14) ?? Number.NaN, 12);
  });
});

describe("pctChange", () => {
  test("tăng/giảm đúng dấu, làm tròn 2 chữ số thập phân", () => {
    expect(pctChange(100, 110)).toBe(10);
    expect(pctChange(100, 90)).toBe(-10);
    expect(pctChange(3, 4)).toBe(33.33);
    expect(pctChange(7, 7)).toBe(0);
  });
  test("from ≤ 0 → 0 (không chia 0 / không đảo dấu giá âm)", () => {
    expect(pctChange(0, 5)).toBe(0);
    expect(pctChange(-10, 5)).toBe(0);
  });
});

describe("latestVsMean", () => {
  test("giá cuối vs trung bình cửa sổ trailing (excl. latest)", () => {
    // series 6 giá, window 5: trailing = [2,2,2,2,2] mean 2, latest 4 → 2
    expect(latestVsMean([2, 2, 2, 2, 2, 4], 5)).toBe(2);
    expect(latestVsMean([1, 1, 1, 1, 1, 1, 1, 1], 5)).toBe(1);
  });
  test("thiếu dữ liệu → null", () => {
    expect(latestVsMean([1, 2, 3], 5)).toBeNull();
  });
  test("trailing mean ≤ 0 → null (không chia 0)", () => {
    expect(latestVsMean([0, 0, 0, 0, 0, 5], 5)).toBeNull();
  });
});

describe("macd (12, 26, 9)", () => {
  test("chuỗi không đủ slow+signal → null", () => {
    expect(macd(Array(34).fill(10))).toBeNull();
    expect(macd([])).toBeNull();
  });
  test("chuỗi phẳng đủ dài → macd = signal = histogram = 0", () => {
    const r = macd(Array(40).fill(100));
    expect(r).not.toBeNull();
    expect(r!.macd).toBeCloseTo(0, 12);
    expect(r!.signal).toBeCloseTo(0, 12);
    expect(r!.histogram).toBeCloseTo(0, 12);
  });
  test("xu hướng TĂNG đều → macd > 0 (EMA nhanh trên EMA chậm)", () => {
    const r = macd(Array.from({ length: 60 }, (_, i) => i + 1));
    expect(r).not.toBeNull();
    expect(r!.macd).toBeGreaterThan(0);
    // ramp tuyến tính: macd hội tụ hằng số → histogram → ~0 (không assert dấu)
    expect(Math.abs(r!.histogram)).toBeLessThan(0.5);
  });
  test("xu hướng GIẢM đều → macd < 0", () => {
    const r = macd(Array.from({ length: 60 }, (_, i) => 100 - i));
    expect(r!.macd).toBeLessThan(0);
  });
  test("histogram = macd − signal (bất biến đại số)", () => {
    const r = macd(Array.from({ length: 50 }, (_, i) => 50 + Math.sin(i / 4) * 10));
    expect(r).not.toBeNull();
    expect(r!.histogram).toBeCloseTo(r!.macd - r!.signal, 10);
  });
});

describe("bollinger (20, 2)", () => {
  test("19 giá ×10 + 1 giá 30 — tính tay: mid 11 · sd √19 · %B > 1", () => {
    const closes = [...Array(19).fill(10), 30];
    const r = bollinger(closes, 20, 2)!;
    expect(r).not.toBeNull();
    const sd = Math.sqrt(19); // phương sai tổng thể 380/20 = 19
    expect(r.mid).toBeCloseTo(11, 12);
    expect(r.upper).toBeCloseTo(11 + 2 * sd, 12);
    expect(r.lower).toBeCloseTo(11 - 2 * sd, 12);
    expect(r.percentB).toBeCloseTo((30 - (11 - 2 * sd)) / (4 * sd), 10);
  });
  test("chuỗi phẳng → dải co hết (upper=mid=lower), %B = 0,5", () => {
    const r = bollinger(Array(20).fill(10))!;
    expect(r.upper).toBeCloseTo(10, 12);
    expect(r.lower).toBeCloseTo(10, 12);
    expect(r.percentB).toBe(0.5);
  });
  test("thiếu dữ liệu → null", () => {
    expect(bollinger(Array(19).fill(10), 20)).toBeNull();
  });
  test("giá cuối ≤ 0 → null", () => {
    const closes = [...Array(19).fill(10), 0];
    expect(bollinger(closes, 20)).toBeNull();
  });
});

describe("atr — Wilder 14", () => {
  const bar = (h: number, l: number, c: number): PriceBar => ({ high: h, low: l, close: c });

  test("15 bar TR đều 2 → ATR = 2 (seed, không có phần mượt)", () => {
    const bars = Array.from({ length: 15 }, () => bar(12, 10, 11));
    expect(atr(bars, 14)).toBeCloseTo(2, 12);
  });
  test("16 bar — bar cuối TR 20 → ATR = (2×13 + 20)/14 = 46/14 (mượt Wilder)", () => {
    const bars = [...Array.from({ length: 15 }, () => bar(12, 10, 11)), bar(30, 10, 11)];
    // TR cuối = max(30−10, |30−11|, |10−11|) = 20
    expect(atr(bars, 14)).toBeCloseTo(46 / 14, 12);
  });
  test("thiếu dữ liệu → null", () => {
    expect(atr(Array.from({ length: 15 }, () => bar(12, 10, 11)), 15)).toBeNull();
    expect(atr([], 14)).toBeNull();
  });
});

describe("obv", () => {
  test("tích luỹ ±volume theo dấu close — tính tay 4 bar", () => {
    const bars = [
      { close: 10, volume: 100 },
      { close: 11, volume: 200 },
      { close: 11, volume: 300 },
      { close: 10, volume: 400 },
    ];
    expect(obv(bars)).toEqual([0, 200, 200, -200]);
  });
  test("mảng rỗng → []", () => {
    expect(obv([])).toEqual([]);
  });
});

describe("stochastic (14, 3)", () => {
  const bar = (h: number, l: number, c: number): PriceBar => ({ high: h, low: l, close: c });

  test("close chạm đỉnh dải 15 điểm → %K = %D = 100", () => {
    const bars = [
      ...Array.from({ length: 13 }, () => bar(10, 5, 7)),
      ...Array.from({ length: 3 }, () => bar(20, 5, 20)),
    ];
    const r = stochastic(bars)!;
    expect(r).not.toBeNull();
    expect(r.k).toBeCloseTo(100, 10);
    expect(r.d).toBeCloseTo(100, 10);
  });
  test("close chạm đáy dải → %K = 0", () => {
    const bars = [
      ...Array.from({ length: 13 }, () => bar(10, 5, 7)),
      ...Array.from({ length: 3 }, () => bar(10, 5, 5)),
    ];
    expect(stochastic(bars)!.k).toBeCloseTo(0, 10);
  });
  test("dải phẳng (không đo được vị trí) → %K = %D = 50", () => {
    const bars = Array.from({ length: 16 }, () => bar(10, 10, 10));
    const r = stochastic(bars)!;
    expect(r.k).toBe(50);
    expect(r.d).toBe(50);
  });
  test("thiếu dữ liệu → null", () => {
    expect(stochastic(Array.from({ length: 15 }, () => bar(10, 5, 7)))).toBeNull();
  });
});
