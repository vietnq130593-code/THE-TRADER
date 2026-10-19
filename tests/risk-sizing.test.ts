/**
 * tests/risk-sizing.test.ts — Task 144-P1 Tier 1 (docs/SECURITY.md §5).
 *
 * Unit test CRB-9 · FRACTIONAL KELLY (¼-Kelly) của src/lib/risk/sizing.ts —
 * alignedCouncilP + fractionalKelly, toàn bộ hàm thuần (module KHÔNG import
 * db). Chốt toán: p trung bình trọng số posterior Beta các cử tri đồng hướng,
 * b = thưởng:rủi, f = clamp(f* × ¼, 0, dynMaxPositionPct/100).
 */
import { describe, test, expect } from "bun:test";
import {
  alignedCouncilP,
  fractionalKelly,
  KELLY_FRACTION,
  KELLY_NEUTRAL_P,
  type CouncilArm,
  type CouncilVote,
} from "@/lib/risk/sizing";

describe("hằng số Kelly", () => {
  test("KELLY_FRACTION = 0,25 (¼-Kelly giảm variance)", () => {
    expect(KELLY_FRACTION).toBe(0.25);
  });
  test("KELLY_NEUTRAL_P = 0,5 (không cử tri đồng hướng)", () => {
    expect(KELLY_NEUTRAL_P).toBe(0.5);
  });
});

/* ── alignedCouncilP — p trọng số posterior cử tri đồng hướng ──────────── */

const arms: CouncilArm[] = [
  { agentCode: "market-analyst", weight: 1, posteriorMean: 0.7 },
  { agentCode: "fair-value", weight: 0.8, posteriorMean: 0.6 },
  { agentCode: "news-sentiment", weight: 0.5, posteriorMean: 0.9 },
  { agentCode: "risk-manager", weight: 1, posteriorMean: 0.4 },
];

describe("alignedCouncilP", () => {
  test("không cử tri đồng hướng → p trung tính 0,5", () => {
    const votes: CouncilVote[] = [{ code: "market-analyst", direction: "DOWN" }];
    expect(alignedCouncilP(arms, votes, "UP")).toBe(0.5);
  });
  test("một cử tri đồng hướng → đúng posterior của cử tri đó", () => {
    const votes: CouncilVote[] = [{ code: "market-analyst", direction: "UP" }];
    expect(alignedCouncilP(arms, votes, "UP")).toBeCloseTo(0.7, 12);
  });
  test("nhiều cử tri đồng hướng → trung bình TRỌNG SỐ posterior", () => {
    const votes: CouncilVote[] = [
      { code: "market-analyst", direction: "UP" },
      { code: "fair-value", direction: "UP" },
      { code: "news-sentiment", direction: "UP" },
    ];
    // (1×0,7 + 0,8×0,6 + 0,5×0,9) / (1 + 0,8 + 0,5) = 1,63 / 2,3 ≈ 0,7087
    expect(alignedCouncilP(arms, votes, "UP")).toBeCloseTo(1.63 / 2.3, 12);
  });
  test("chỉ đếm cử tri ĐỒNG HƯỚNG — phiếu ngược hướng không kéo p", () => {
    const votes: CouncilVote[] = [
      { code: "market-analyst", direction: "UP" },
      { code: "risk-manager", direction: "DOWN" }, // posterior 0,4 phải bị bỏ
    ];
    expect(alignedCouncilP(arms, votes, "UP")).toBeCloseTo(0.7, 12);
  });
  test("cử tri không có arm (code lạ) không được tính", () => {
    const votes: CouncilVote[] = [
      { code: "ghost-agent", direction: "UP" },
      { code: "market-analyst", direction: "UP" },
    ];
    expect(alignedCouncilP(arms, votes, "UP")).toBeCloseTo(0.7, 12);
  });
  test("weight bị kẹp [0,3 · 1]: weight 5 → 1, weight 0 → 0,3", () => {
    const extreme: CouncilArm[] = [
      { agentCode: "a", weight: 5, posteriorMean: 0.9 },
      { agentCode: "b", weight: 0, posteriorMean: 0.5 },
    ];
    const votes: CouncilVote[] = [
      { code: "a", direction: "UP" },
      { code: "b", direction: "UP" },
    ];
    // (1×0,9 + 0,3×0,5) / 1,3 = 1,05/1,3 ≈ 0,8077
    expect(alignedCouncilP(extreme, votes, "UP")).toBeCloseTo(1.05 / 1.3, 12);
  });
  test("posterior ngoài [0,1] bị kẹp (0 → 0, 1,5 → 1)", () => {
    const dirty: CouncilArm[] = [
      { agentCode: "a", weight: 1, posteriorMean: 1.5 },
      { agentCode: "b", weight: 1, posteriorMean: -0.5 },
    ];
    const votes: CouncilVote[] = [
      { code: "a", direction: "DOWN" },
      { code: "b", direction: "DOWN" },
    ];
    // (1×1 + 1×0)/2 = 0,5
    expect(alignedCouncilP(dirty, votes, "DOWN")).toBeCloseTo(0.5, 12);
  });
  test("p bị kẹp dải an toàn [0,05 · 0,95] (odds 0/∞)", () => {
    const certain: CouncilArm[] = [{ agentCode: "a", weight: 1, posteriorMean: 1 }];
    const votes: CouncilVote[] = [{ code: "a", direction: "UP" }];
    expect(alignedCouncilP(certain, votes, "UP")).toBe(0.95);
    const hopeless: CouncilArm[] = [{ agentCode: "a", weight: 1, posteriorMean: 0 }];
    expect(alignedCouncilP(hopeless, votes, "UP")).toBe(0.05);
  });
  test("mảng arm rỗng → trung tính 0,5 (wSum = 0)", () => {
    expect(alignedCouncilP([], [], "UP")).toBe(0.5);
  });
});

/* ── fractionalKelly — ¼-Kelly cho 1 tín hiệu ──────────────────────────── */

describe("fractionalKelly — BUY chuẩn", () => {
  test("entry 100 · target 110 · stop 95 · p 0,6 · dynMax 20% → b=2, f=0,1", () => {
    const r = fractionalKelly({
      direction: "BUY",
      entry: 100,
      targetPrice: 110,
      stopLoss: 95,
      p: 0.6,
      dynMaxPositionPct: 20,
    });
    // b = (110−100)/(100−95) = 2; f* = (2×0,6 − 0,4)/2 = 0,4; f = 0,4×¼ = 0,1
    expect(r.skipped).toBe(false);
    expect(r.b).toBeCloseTo(2, 12);
    expect(r.f).toBeCloseTo(0.1, 12);
    expect(r.p).toBe(0.6);
    expect(r.note).toContain("Kelly ¼");
  });
  test("f bị chặn trên bởi hạn mức động (dynMax 5% → f = 0,05)", () => {
    const r = fractionalKelly({
      direction: "BUY",
      entry: 100,
      targetPrice: 150,
      stopLoss: 95,
      p: 0.7,
      dynMaxPositionPct: 5,
    });
    // b = 10; f* = (10×0,7 − 0,3)/10 = 0,67; ¼ = 0,1675 > 0,05 → chặn 0,05
    expect(r.f).toBeCloseTo(0.05, 12);
    expect(r.skipped).toBe(false);
  });
});

describe("fractionalKelly — SELL đảo dấu", () => {
  test("entry 100 · target 90 · stop 105 · p 0,6 → b=2, f=0,1 (đối xứng BUY)", () => {
    const r = fractionalKelly({
      direction: "SELL",
      entry: 100,
      targetPrice: 90,
      stopLoss: 105,
      p: 0.6,
      dynMaxPositionPct: 20,
    });
    // thưởng = entry − target = 10; rủi = stop − entry = 5 → b = 2
    expect(r.skipped).toBe(false);
    expect(r.b).toBeCloseTo(2, 12);
    expect(r.f).toBeCloseTo(0.1, 12);
  });
  test("SELL stop dưới entry (denom ≤ 0) → skip", () => {
    const r = fractionalKelly({
      direction: "SELL",
      entry: 100,
      targetPrice: 90,
      stopLoss: 95, // stop nằm SAI phía so với hướng SELL
      p: 0.6,
      dynMaxPositionPct: 20,
    });
    expect(r.skipped).toBe(true);
    expect(r.f).toBe(0);
  });
});

describe("fractionalKelly — nhánh skip (không gợi ý, KHÔNG throw)", () => {
  const base = {
    direction: "BUY" as const,
    entry: 100,
    targetPrice: 110,
    stopLoss: 95,
    p: 0.6,
    dynMaxPositionPct: 20,
  };

  test("thiếu targetPrice → skip", () => {
    const r = fractionalKelly({ ...base, targetPrice: null });
    expect(r.skipped).toBe(true);
    expect(r.f).toBe(0);
    expect(r.note).toContain("bỏ qua");
  });
  test("thiếu stopLoss → skip", () => {
    expect(fractionalKelly({ ...base, stopLoss: null }).skipped).toBe(true);
  });
  test("entry ≤ 0 → skip", () => {
    expect(fractionalKelly({ ...base, entry: 0 }).skipped).toBe(true);
    expect(fractionalKelly({ ...base, entry: -5 }).skipped).toBe(true);
  });
  test("stopLoss ≤ 0 hoặc targetPrice ≤ 0 → skip", () => {
    expect(fractionalKelly({ ...base, stopLoss: 0 }).skipped).toBe(true);
    expect(fractionalKelly({ ...base, targetPrice: -1 }).skipped).toBe(true);
  });
  test("BUY target ≤ entry (b ≤ 0) → skip", () => {
    expect(fractionalKelly({ ...base, targetPrice: 100 }).skipped).toBe(true);
    expect(fractionalKelly({ ...base, targetPrice: 90 }).skipped).toBe(true);
  });
  test("BUY stop ≥ entry (denom ≤ 0) → skip", () => {
    expect(fractionalKelly({ ...base, stopLoss: 100 }).skipped).toBe(true);
    expect(fractionalKelly({ ...base, stopLoss: 120 }).skipped).toBe(true);
  });
});

describe("fractionalKelly — biên p", () => {
  test("p thấp (f* âm) → f = 0 nhưng KHÔNG skip (0 cũng là gợi ý)", () => {
    const r = fractionalKelly({
      direction: "BUY",
      entry: 100,
      targetPrice: 110,
      stopLoss: 95,
      p: 0.2, // f* = (2×0,2 − 0,8)/2 = −0,2 → ¼ = −0,05 → kẹp 0
      dynMaxPositionPct: 20,
    });
    expect(r.skipped).toBe(false);
    expect(r.f).toBe(0);
  });
  test("p = 1 toàn biết → f = ¼ f* trọn vẹn", () => {
    const r = fractionalKelly({
      direction: "BUY",
      entry: 100,
      targetPrice: 110,
      stopLoss: 95,
      p: 1,
      dynMaxPositionPct: 100,
    });
    // f* = (2×1 − 0)/2 = 1 → f = 0,25
    expect(r.f).toBeCloseTo(0.25, 12);
  });
  test("dynMaxPositionPct = 0 → maxF = 0 → f = 0 (hạn mức siết hết)", () => {
    const r = fractionalKelly({
      direction: "BUY",
      entry: 100,
      targetPrice: 110,
      stopLoss: 95,
      p: 0.9,
      dynMaxPositionPct: 0,
    });
    expect(r.f).toBe(0);
    expect(r.skipped).toBe(false);
  });
  test("note mang % NAV + cảnh báo tham mưu (trader phê duyệt A8)", () => {
    const r = fractionalKelly({
      direction: "BUY",
      entry: 100,
      targetPrice: 110,
      stopLoss: 95,
      p: 0.6,
      dynMaxPositionPct: 20,
    });
    expect(r.note).toContain("% NAV");
    expect(r.note).toContain("tham mưu");
  });
});
