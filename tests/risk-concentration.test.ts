/**
 * tests/risk-concentration.test.ts — Task 144-P1 Tier 1 (docs/SECURITY.md §5).
 *
 * Unit test CRB-4 (HHI tập trung ngành/vị thế) + CRB-5 (ma trận tương quan
 * "số cược hiệu quả") của src/lib/risk/concentration.ts — toàn bộ hàm thuần
 * (hhi · computeConcentration · pearson · computeCorrelation). Fixture
 * tương quan dùng chuỗi DatedReturn 45 phiên chung để vượt CORR_MIN_OVERLAP=40.
 */
import { describe, test, expect } from "bun:test";
import {
  hhi,
  computeConcentration,
  pearson,
  computeCorrelation,
  HHI_SECTOR_THRESHOLD,
  HHI_POSITION_THRESHOLD,
  CORR_WINDOW,
  CORR_MIN_OVERLAP,
  CORR_TOP_N,
  AVG_CORR_THRESHOLD,
  type DatedReturn,
} from "@/lib/risk/concentration";

describe("hằng số ngưỡng (chốt thiết kế CRB §4)", () => {
  test("HHI_SECTOR_THRESHOLD = 0,25 (< 4 ngành hiệu quả)", () => {
    expect(HHI_SECTOR_THRESHOLD).toBe(0.25);
  });
  test("HHI_POSITION_THRESHOLD = 0,15 (< 6,7 vị thế vs target 8)", () => {
    expect(HHI_POSITION_THRESHOLD).toBe(0.15);
  });
  test("Cửa sổ tương quan 60 phiên · tối thiểu 40 phiên chung · top 15 vị thế", () => {
    expect(CORR_WINDOW).toBe(60);
    expect(CORR_MIN_OVERLAP).toBe(40);
    expect(CORR_TOP_N).toBe(15);
    expect(AVG_CORR_THRESHOLD).toBe(0.7);
  });
});

describe("hhi — HHI từ danh sách tỷ trọng", () => {
  test("mảng rỗng → 0 (không bịa — caller xử lý proxy mode)", () => {
    expect(hhi([])).toBe(0);
  });
  test("1 ngành 100% → HHI = 1 (tập trung tuyệt đối)", () => {
    expect(hhi([1])).toBe(1);
  });
  test("2 ngành 50/50 → HHI = 0,5", () => {
    expect(hhi([0.5, 0.5])).toBeCloseTo(0.5, 12);
  });
  test("4 ngành đều 25% → HHI = 0,25 (đúng sát ngưỡng)", () => {
    expect(hhi([0.25, 0.25, 0.25, 0.25])).toBeCloseTo(0.25, 12);
  });
  test("3 ngành 39/39/22 → 0,3426 vượt ngưỡng (gap A7 cũ)", () => {
    // HHI = 0,1521 + 0,1521 + 0,0484 = 0,3526
    expect(hhi([0.39, 0.39, 0.22])).toBeCloseTo(0.3526, 10);
  });
  test("trọng số âm bị kẹp 0 (không vào tổng bình phương)", () => {
    expect(hhi([-0.5, 0.5])).toBeCloseTo(0.25, 12);
    expect(hhi([-1])).toBe(0);
  });
});

describe("computeConcentration — CRB-4 từ % NAV", () => {
  test("3 ngành 40/30/30 + 5 vị thế 20 mỗi → 2 breach (ngành + vị thế)", () => {
    const r = computeConcentration([40, 30, 30], [20, 20, 20, 20, 20]);
    // HHI ngành = 0,16+0,09+0,09 = 0,34 > 0,25; HHI vị thế = 5×0,04 = 0,2 > 0,15
    expect(r.hhiSector).toBeCloseTo(0.34, 12);
    expect(r.hhiPosition).toBeCloseTo(0.2, 12);
    expect(r.effSectors).toBeCloseTo(1 / 0.34, 10);
    expect(r.effPositions).toBeCloseTo(5, 10);
    expect(r.breach).toBe(true);
    expect(r.breaches).toHaveLength(2);
    expect(r.breaches[0]).toContain("HHI ngành");
    expect(r.breaches[1]).toContain("HHI vị thế");
  });
  test("8 ngành ~12,5% + 8 vị thế 12,5% → không breach", () => {
    const r = computeConcentration(
      Array(8).fill(12.5),
      Array(8).fill(12.5)
    );
    // HHI = 8 × 0,015625 = 0,125 < cả hai ngưỡng
    expect(r.hhiSector).toBeCloseTo(0.125, 12);
    expect(r.hhiPosition).toBeCloseTo(0.125, 12);
    expect(r.breach).toBe(false);
    expect(r.breaches).toHaveLength(0);
    expect(r.effSectors).toBeCloseTo(8, 10);
    expect(r.effPositions).toBeCloseTo(8, 10);
  });
  test("chỉ vị thế tập trung (1 vị thế 100%) → 1 breach duy nhất", () => {
    const r = computeConcentration([10, 10, 10, 10, 10, 10, 10, 10, 10, 10], [100]);
    expect(r.hhiSector).toBeCloseTo(0.1, 12);
    expect(r.hhiPosition).toBe(1);
    expect(r.breaches).toHaveLength(1);
    expect(r.breaches[0]).toContain("HHI vị thế");
  });
  test("danh sách rỗng → HHI 0, effSectors/effPositions 0 (chia 0 được chống)", () => {
    const r = computeConcentration([], []);
    expect(r.hhiSector).toBe(0);
    expect(r.hhiPosition).toBe(0);
    expect(r.effSectors).toBe(0);
    expect(r.effPositions).toBe(0);
    expect(r.breach).toBe(false);
  });
});

describe("pearson — tương quan 2 chuỗi cùng độ dài", () => {
  test("chuỗi giống hệt nhau → 1", () => {
    const a = Float64Array.from([0.01, -0.02, 0.03, 0.02, -0.01, 0.04, -0.03]);
    expect(pearson(a, a)).toBeCloseTo(1, 12);
  });
  test("chuỗi đảo dấu → −1", () => {
    const a = Float64Array.from([0.01, -0.02, 0.03, 0.02, -0.01, 0.04, -0.03]);
    const b = Float64Array.from(a).map((v) => -v);
    expect(pearson(a, b)).toBeCloseTo(-1, 12);
  });
  test("chuỗi hằng số (phương sai 0) → 0 an toàn (không chia 0)", () => {
    const a = Float64Array.from([0.01, 0.01, 0.01, 0.01]);
    expect(pearson(a, Float64Array.from([0.02, -0.02, 0.03, -0.03]))).toBe(0);
  });
  test("độ dài < 2 → 0", () => {
    expect(pearson(Float64Array.from([0.01]), Float64Array.from([0.01]))).toBe(0);
    expect(pearson(new Float64Array(0), new Float64Array(0))).toBe(0);
  });
  test("độ dài lệch nhau → dùng min length an toàn", () => {
    const a = Float64Array.from([0.01, -0.02, 0.03, 0.02]);
    const b = Float64Array.from([0.01, -0.02, 0.03]);
    expect(pearson(a, b)).toBeCloseTo(1, 12);
  });
});

/* ── Fixture CRB-5: 45 phiên chung (≥ CORR_MIN_OVERLAP 40) ─────────────── */

function makeDatedReturns(rets: number[], startIso = "2025-09-01"): DatedReturn[] {
  const start = new Date(`${startIso}T00:00:00Z`).getTime();
  return rets.map((ret, i) => ({
    date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
    ret,
  }));
}

/** 45 phiên so le +/-1%: +1,-1,+1,-1… (variance > 0, không chuỗi phẳng). */
const alternating45 = Array.from({ length: 45 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01));

describe("computeCorrelation — CRB-5 số cược hiệu quả", () => {
  test("0 hoặc 1 vị thế → bỏ qua đo tương quan (avgCorr 0, không breach)", () => {
    expect(computeCorrelation([]).n).toBe(0);
    const one = computeCorrelation([makeDatedReturns(alternating45)]);
    expect(one.n).toBe(1);
    expect(one.avgCorr).toBe(0);
    expect(one.effBets).toBe(1);
    expect(one.breach).toBe(false);
    expect(one.note).toContain("< 2 vị thế");
  });
  test("2 vị thế tương quan hoàn hảo (+1) → effBets = 1, breach", () => {
    const r = computeCorrelation([
      makeDatedReturns(alternating45),
      makeDatedReturns(alternating45),
    ]);
    expect(r.n).toBe(2);
    expect(r.pairsDropped).toBe(0);
    expect(r.avgCorr).toBeCloseTo(1, 12);
    // N_eff = 2 / (1 + 1×1) = 1
    expect(r.effBets).toBeCloseTo(1, 12);
    expect(r.breach).toBe(true);
  });
  test("2 vị thế tương quan đảo (−1) → mẫu số ~0 → effBets = n (fail-safe)", () => {
    const r = computeCorrelation([
      makeDatedReturns(alternating45),
      makeDatedReturns(alternating45.map((v) => -v)),
    ]);
    expect(r.avgCorr).toBeCloseTo(-1, 12);
    expect(r.effBets).toBeCloseTo(2, 10);
    expect(r.breach).toBe(false);
  });
  test("cặp < 40 phiên chung → bị bỏ (pairsDropped), note nói rõ", () => {
    const r = computeCorrelation([
      makeDatedReturns(alternating45),
      makeDatedReturns(alternating45.slice(0, 30)), // chỉ 30 phiên chung
    ]);
    expect(r.pairsDropped).toBe(1);
    expect(r.avgCorr).toBe(0);
    expect(r.effBets).toBe(2);
    expect(r.breach).toBe(false);
    expect(r.note).toContain("không đủ 40 phiên chung");
  });
  test("phiên lệch ngày không bị ghép sai (fixbug #52-F1 — ghép theo NGÀY)", () => {
    // a có phiên 2025-09-01..45; b lệch 1 ngày (bắt đầu 09-02) → 44 phiên chung,
    // vẫn ≥ 40, tương quan hoàn hảo trên phần chung
    const b = makeDatedReturns(alternating45.slice(1), "2025-09-02");
    const r = computeCorrelation([makeDatedReturns(alternating45), b]);
    expect(r.pairsDropped).toBe(0);
    expect(r.avgCorr).toBeCloseTo(1, 12);
  });
  test("3 vị thế: cặp A-B corr +1, cặp A-C/B-C corr −1 → avgCorr = −1/3", () => {
    const a = makeDatedReturns(alternating45);
    const same = makeDatedReturns(alternating45);
    const inv = makeDatedReturns(alternating45.map((v) => -v));
    const r = computeCorrelation([a, same, inv]);
    // 3 cặp: (+1 + −1 + −1)/3 = −1/3
    expect(r.avgCorr).toBeCloseTo(-1 / 3, 10);
    // N_eff = 3 / (1 + 2×(−1/3)) = 3 / (1/3) = 9 (> N — đa dạng hoá, giữ nguyên)
    expect(r.effBets).toBeCloseTo(9, 6);
    expect(r.breach).toBe(false);
  });
});
