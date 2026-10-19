/**
 * tests/ml-calibration.test.ts — Task 144-P1 Tier 1 (docs/SECURITY.md §5).
 *
 * Unit test F-08 ISOTONIC CALIBRATION (PAV) của src/lib/ml/calibration.ts —
 * fitIsotonic · applyIsotonic · fitCalibration · applyCalibration ·
 * parseCalibration, toàn bộ hàm thuần (module KHÔNG import db). Trọng tâm
 * FIX #130: 5 tầng phòng hộ NaN/undefined + AUDIT 137 B5 gate holdout.
 */
import { describe, test, expect } from "bun:test";
import {
  fitIsotonic,
  applyIsotonic,
  fitCalibration,
  applyCalibration,
  parseCalibration,
  CALIBRATION_MIN_PER_CLASS,
  CALIBRATION_BINS,
  type IsotonicCurve,
} from "@/lib/ml/calibration";

describe("hằng số calibration", () => {
  test("tối thiểu 60 mẫu/class để fit · 10 bin reliability curve", () => {
    expect(CALIBRATION_MIN_PER_CLASS).toBe(60);
    expect(CALIBRATION_BINS).toBe(10);
  });
});

/* ── fitIsotonic — PAV bằng pool đối tượng (FIX #130) ───────────────────── */

/** p tăng dần 0,01..0,60 (60 mẫu) + nhãn theo ngưỡng — fixture 1-to-1. */
const p60 = Array.from({ length: 60 }, (_, i) => (i + 1) / 100);
const yStep = p60.map((p) => (p <= 0.3 ? 0 : 1)); // 0...0 1...1 — đơn điệu sẵn

describe("fitIsotonic", () => {
  test("< 60 mẫu → null (không đủ dữ liệu fit)", () => {
    expect(fitIsotonic([0.1, 0.2, 0.3], [0, 1, 1])).toBeNull();
    expect(fitIsotonic(Array(59).fill(0.5), Array(59).fill(1))).toBeNull();
  });
  test("đúng 60 mẫu đơn điệu → curve với 60 mốc (mỗi mẫu 1 pool)", () => {
    const curve = fitIsotonic(p60, yStep);
    expect(curve).not.toBeNull();
    expect(curve!.xs).toHaveLength(60);
    expect(curve!.ys).toHaveLength(60);
    // mốc giữa vùng y=1: p=0,31 → q=1
    expect(curve!.ys[30]).toBe(1);
    expect(curve!.ys[29]).toBe(0);
  });
  test("chuỗi vi phạm dồn về 1 pool duy nhất → < 2 mốc → null", () => {
    // y = [1, 0, 0, …]: 1 vi phạm mọi pool trước → gộp hết thành 1 pool
    const yViol = Array.from({ length: 60 }, (_, i) => (i === 0 ? 1 : 0));
    expect(fitIsotonic(p60, yViol)).toBeNull();
  });
  test("PAV gộp bậc thang vi phạm ở ĐUÔI (cascade + trung bình có trọng số)", () => {
    // 29 mẫu y=0 (p 0,01..0,29) + 30 mẫu y=1 (p 0,30..0,59) + 1 mẫu y=0 (p 0,60)
    // → mẫu cuối vi phạm pool 1 gần nhất → cascade gộp TRỌN 30 pool-1 + mẫu 0
    //   thành 1 pool {30×1 + 1×0}/31 ≈ 0,9677; 29 pool-0 đứng yên
    const y = [...Array(29).fill(0), ...Array(30).fill(1), 0];
    const curve = fitIsotonic(p60, y);
    expect(curve).not.toBeNull();
    expect(curve!.xs).toHaveLength(30); // 29 pool-0 + 1 pool gộp
    const last = curve!.ys[curve!.ys.length - 1]!;
    expect(last).toBeCloseTo(30 / 31, 6);
    expect(curve!.ys[0]).toBe(0);
  });
});

/* ── applyIsotonic — clip + nội suy tuyến tính, KHÔNG ngoại suy ─────────── */

const curve2: IsotonicCurve = { xs: [0.2, 0.5], ys: [0.1, 0.9] };

describe("applyIsotonic", () => {
  test("curve null → identity (trả nguyên p)", () => {
    expect(applyIsotonic(null, 0.42)).toBe(0.42);
  });
  test("p dưới x0 → clip về ys[0]", () => {
    expect(applyIsotonic(curve2, 0.05)).toBeCloseTo(0.1, 12);
    expect(applyIsotonic(curve2, 0.2)).toBeCloseTo(0.1, 12);
  });
  test("p trên xN → clip về ys[N]", () => {
    expect(applyIsotonic(curve2, 0.9)).toBeCloseTo(0.9, 12);
    expect(applyIsotonic(curve2, 0.5)).toBeCloseTo(0.9, 12);
  });
  test("trong khoảng → nội suy tuyến tính (điểm giữa 0,35 → 0,5)", () => {
    expect(applyIsotonic(curve2, 0.35)).toBeCloseTo(0.5, 12);
    expect(applyIsotonic(curve2, 0.275)).toBeCloseTo(0.3, 12);
  });
  test("p NaN/Infinity → trả nguyên p (FIX #130 — không lan rác)", () => {
    expect(Number.isNaN(applyIsotonic(curve2, Number.NaN))).toBe(true);
    expect(applyIsotonic(curve2, Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });
  test("curve lệch độ dài xs/ys → identity (chống curve rác)", () => {
    const broken: IsotonicCurve = { xs: [0.2, 0.5], ys: [0.1] };
    expect(applyIsotonic(broken, 0.35)).toBe(0.35);
  });
  test("curve rỗng → identity", () => {
    expect(applyIsotonic({ xs: [], ys: [] }, 0.7)).toBe(0.7);
  });
  test("curve nhiều mốc — binary search đúng đoạn giữa", () => {
    const multi: IsotonicCurve = {
      xs: [0.1, 0.2, 0.3, 0.4, 0.5],
      ys: [0.05, 0.1, 0.5, 0.6, 0.95],
    };
    // p=0,34 nằm giữa (0,3 → 0,5) và (0,4 → 0,6): t=0,4 → 0,5+0,4×0,1=0,54
    expect(applyIsotonic(multi, 0.34)).toBeCloseTo(0.54, 12);
    expect(applyIsotonic(multi, 0.25)).toBeCloseTo(0.3, 12);
  });
});

/* ── fitCalibration — 3 class + gate holdout (AUDIT 137 B5) ─────────────── */

describe("fitCalibration", () => {
  test("đầu vào rỗng → spec fail-soft (curves null, ece null, gate in-sample)", () => {
    const spec = fitCalibration([], []);
    expect(spec.curves).toEqual([null, null, null]);
    expect(spec.fitted).toBe(0);
    expect(spec.eceBefore).toBeNull();
    expect(spec.eceAfter).toBeNull();
    expect(spec.gateHoldout).toBe(false);
  });
  test("mẫu rác (NaN/Infinity) bị lọc TRƯỚC fit (FIX #130)", () => {
    const probs: number[][] = [];
    const labels: number[] = [];
    for (let i = 0; i < 100; i++) {
      probs.push([Number.NaN, 0.3, 0.7]);
      labels.push(Number.NaN);
    }
    const spec = fitCalibration(probs, labels);
    expect(spec.fitted).toBe(0); // 0 mẫu sạch → không fit được gì
    expect(spec.eceBefore).toBeNull(); // gate rỗng → null
  });
  test("< 80 mẫu → gateHoldout false (in-sample như bản cũ)", () => {
    const probs = Array.from({ length: 70 }, () => [0.6, 0.2, 0.2]);
    const labels = Array.from({ length: 70 }, (_, i) => (i % 2 === 0 ? 0 : 1));
    const spec = fitCalibration(probs, labels);
    expect(spec.gateHoldout).toBe(false);
  });
  test("≥ 80 mẫu → gateHoldout true (fit nửa đầu / chấm ECE nửa sau)", () => {
    const probs = Array.from({ length: 100 }, () => [0.9, 0.05, 0.05]);
    const labels = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? 0 : 1));
    const spec = fitCalibration(probs, labels);
    expect(spec.gateHoldout).toBe(true);
    // nửa fit = 50 mẫu < 60/class → curves null (identity) → ECE trước = sau
    expect(spec.curves).toEqual([null, null, null]);
    // holdout 50 mẫu: conf 0,9 · acc 0,5 → ECE = |0,5 − 0,9| = 0,4
    expect(spec.eceBefore).toBeCloseTo(0.4, 6);
    expect(spec.eceAfter).toBeCloseTo(0.4, 6);
  });
  test("≥ 120 mẫu → nửa fit ≥ 60/class → curve non-null, fitted = 60", () => {
    // 120 mẫu: p class 0 = 0,9 nhãn xen kẽ 0/1 → y class 0 = 1,0,1,0… (PAV gộp pool)
    const probs = Array.from({ length: 120 }, () => [0.9, 0.05, 0.05]);
    const labels = Array.from({ length: 120 }, (_, i) => (i % 2 === 0 ? 0 : 1));
    const spec = fitCalibration(probs, labels);
    expect(spec.curves[0]).not.toBeNull();
    expect(spec.fitted).toBe(60);
    expect(spec.gateHoldout).toBe(true);
    expect(spec.fittedAt).not.toBe("");
  });
  test("probs bị clamp [0,1] trước fit (âm/≥1 không xuyên qua)", () => {
    const probs = Array.from({ length: 90 }, (_, i) => [i % 2 === 0 ? 1.5 : -0.2, 0.3, 0.4]);
    const labels = Array.from({ length: 90 }, () => 0);
    const spec = fitCalibration(probs, labels);
    // 45 mẫu nửa đầu < 60 → curves null — nhưng ECE vẫn đo được (đã clamp)
    expect(spec.gateHoldout).toBe(true);
    expect(spec.eceBefore).not.toBeNull();
    expect(spec.eceBefore!).toBeGreaterThanOrEqual(0);
    expect(spec.eceBefore!).toBeLessThanOrEqual(1);
  });
});

/* ── applyCalibration — áp 3 curve + tái chuẩn hoá Σ = 1 ────────────────── */

describe("applyCalibration", () => {
  const specCurve: IsotonicCurve = { xs: [0.1, 0.9], ys: [1, 1] };

  test("spec null → trả BẢN SAO xác suất gốc (identity, không mutate)", () => {
    const pr = [0.5, 0.3, 0.2];
    const out = applyCalibration(null, pr);
    expect(out).toEqual(pr);
    expect(out).not.toBe(pr); // bản sao — caller giữ nguyên mảng gốc
  });
  test("curve ép cả 3 class về cùng giá trị → tái chuẩn hoá đều 1/3", () => {
    const spec = {
      curves: [specCurve, specCurve, specCurve],
      fitted: 60,
      eceBefore: null,
      eceAfter: null,
      fittedAt: "",
    };
    expect(applyCalibration(spec, [0.5, 0.3, 0.2])).toEqual([
      1 / 3, 1 / 3, 1 / 3,
    ]);
  });
  test("curve đưa class 2 lên cao → Σ > 1 tái chuẩn hoá giữ thứ tự", () => {
    const up: IsotonicCurve = { xs: [0.1, 0.9], ys: [0, 3] };
    const flat: IsotonicCurve = { xs: [0.1, 0.9], ys: [0, 0] };
    const spec = { curves: [flat, flat, up], fitted: 60, eceBefore: null, eceAfter: null, fittedAt: "" };
    const out = applyCalibration(spec, [0.5, 0.3, 0.2]);
    // raw = [0, 0, 1.5] → chuẩn hoá [0, 0, 1]
    expect(out[0]).toBeCloseTo(0, 12);
    expect(out[2]).toBeCloseTo(1, 12);
    const sum = out[0]! + out[1]! + out[2]!;
    expect(sum).toBeCloseTo(1, 12);
  });
  test("cả 3 curve đều map về 0 (sum = 0) → phân bố đều 1/3 trung tính", () => {
    const zero: IsotonicCurve = { xs: [0.1, 0.9], ys: [0, 0] };
    const spec = { curves: [zero, zero, zero], fitted: 60, eceBefore: null, eceAfter: null, fittedAt: "" };
    expect(applyCalibration(spec, [0.5, 0.3, 0.2])).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });
  test("curve rác cho kết quả không hữu hạn → trả xác suất GỐC (fail-soft)", () => {
    const bad: IsotonicCurve = { xs: [Number.NaN, 0.9], ys: [0.2, 0.8] };
    const spec = { curves: [bad, null, null], fitted: 60, eceBefore: null, eceAfter: null, fittedAt: "" };
    // applyIsotonic với xs[0]=NaN: p <= NaN là false, p >= xs[last]… p=0.5 >= 0.9 false
    // → binary search với NaN vẫn đi vào nội suy → kết quả NaN → sum NaN → identity
    const out = applyCalibration(spec, [0.5, 0.3, 0.2]);
    expect(out.every((v) => Number.isFinite(v))).toBe(true);
  });
});

/* ── parseCalibration — đọc spec từ MlModel.meta JSON (fail-soft) ───────── */

describe("parseCalibration", () => {
  test("null / JSON rác / thiếu calibration → null (identity)", () => {
    expect(parseCalibration(null)).toBeNull();
    expect(parseCalibration("")).toBeNull();
    expect(parseCalibration("not json {")).toBeNull();
    expect(parseCalibration("{}")).toBeNull();
    expect(parseCalibration('{"other":1}')).toBeNull();
  });
  test("meta có calibration hợp lệ → parse đủ field", () => {
    const meta = JSON.stringify({
      calibration: {
        curves: [{ xs: [0.2, 0.8], ys: [0.1, 0.9] }, null, null],
        fitted: 120,
        eceBefore: 0.12,
        eceAfter: 0.05,
        gateHoldout: true,
        fittedAt: "2026-01-05T00:00:00.000Z",
      },
    });
    const spec = parseCalibration(meta);
    expect(spec).not.toBeNull();
    expect(spec!.curves[0]).toEqual({ xs: [0.2, 0.8], ys: [0.1, 0.9] });
    expect(spec!.curves[1]).toBeNull();
    expect(spec!.fitted).toBe(120);
    expect(spec!.eceBefore).toBe(0.12);
    expect(spec!.eceAfter).toBe(0.05);
    expect(spec!.gateHoldout).toBe(true);
    expect(spec!.fittedAt).toBe("2026-01-05T00:00:00.000Z");
  });
  test("curve chứa NaN (rác PAV bản cũ) → curve đó null (FIX #130)", () => {
    const meta = JSON.stringify({
      calibration: {
        curves: [{ xs: [0.2, "NaN"], ys: [0.1, 0.9] }, null, null],
        fitted: 100,
      },
    });
    const spec = parseCalibration(meta);
    // "NaN" string → typeof !== number → curve rác → mọi curve null → spec null
    expect(spec).toBeNull();
  });
  test("mọi curve null → spec null (không có gì để áp)", () => {
    const meta = JSON.stringify({
      calibration: { curves: [null, null, null], fitted: 50 },
    });
    expect(parseCalibration(meta)).toBeNull();
  });
  test("gateHoldout thiếu → undefined (bản cũ — trung thực 'không biết')", () => {
    const meta = JSON.stringify({
      calibration: { curves: [{ xs: [0.2, 0.8], ys: [0.1, 0.9] }, null, null], fitted: 60 },
    });
    expect(parseCalibration(meta)!.gateHoldout).toBeUndefined();
  });
});
