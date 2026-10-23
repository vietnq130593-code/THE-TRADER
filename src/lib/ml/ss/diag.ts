/**
 * src/lib/ml/ss/diag.ts — SS-7 · GUARD "ĐỘ NGẠC NHIÊN" BÊN CẠNH PSI (ch. 3 + 9).
 *
 * STATE_SPACE_BLUEPRINT SS-7 (hiệu đính v1.1 F6 — chống báo động giả):
 * Innovation chuẩn hoá e_t = v_t/√F_t ~ N(0,1) nếu model trung tâm còn khớp.
 * HOSE đuôi dày khiến KS vs N(0,1) reject MẠN TÍNH ⇒:
 *   - TIN CHÍNH: CUSUM-of-squares trên e²−1 (cửa sổ cuộn 60 phiên) — chuẩn
 *     hoá Σ(e²−1)/√(2w) ~ N(0,1) dưới Gaussian (Var(e²) = 2); cờ khi |C| > 3.
 *   - TIN PHỤ: KS-test một mẫu vs N(0,1) với ngưỡng Bonferroni
 *     α/(số mã × số check/ngày) — p dưới ngưỡng MỚI tính là cờ.
 *   - |e| > 4: cờ đơn phát (outlier một ngày).
 * Phase 1: guard ghi audit SS_SURPRISE READ-ONLY — KHÔNG hành động (4 tuần
 * audit im lặng trước khi nối vào auto-retrain có sẵn — F9/tinh thần W3).
 *
 * Pure function — scripts/p176 kiểm định hermetic (T7: sạch không cờ + bơm
 * break phải cờ).
 */

import { normalCdf } from "@/lib/ml/ss/gauss";

/** Cửa sổ CUSUM cuộn (phiên) — blueprint SS-7. */
export const SURPRISE_WINDOW = 60;

/** Ngưỡng |CUSUM chuẩn hoá| — 3σ (blueprint: tin chính). */
export const SURPRISE_CUSUM_THRESHOLD = 3;

/** Cờ |e| đơn phát (blueprint SS-7). */
export const SURPRISE_ABS_E = 4;

/** α gốc cho Bonferroni (0,01 — blueprint SS-7). */
export const SURPRISE_ALPHA_BASE = 0.01;

/** Kết quả diagnostic một chuỗi innovation. */
export interface SurpriseDiag {
  /** Số e sử dụng (sau khi cắt về cửa sổ). */
  n: number;
  /** CUSUM chuẩn hoá Σ(e²−1)/√(2w) trên cửa sổ cuối — TIN CHÍNH. */
  cusum: number;
  /** KS-D so N(0,1). */
  ksD: number;
  /** p-value KS (tiệm cận Kolmogorov) — TIN PHỤ. */
  ksP: number;
  /** max|e| trong cửa sổ. */
  maxAbsE: number;
  /** Số lần |e| > 4. */
  nAbsGt4: number;
  /** Cờ tổng (CUSUM ∨ KS-Bonferroni ∨ |e|>4). */
  flagged: boolean;
  /** Lý do cờ (rỗng khi không cờ — audit trung thực). */
  reasons: string[];
}

/**
 * Bonferroni α — blueprint F6: 0,01 / (số kiểm định). Caller truyền
 * nSymbols × checksPerDay (mặc định 1 check/ngày ⇒ chỉ số mã).
 */
export function bonferroniAlpha(nSymbols: number, checksPerDay = 1): number {
  const n = Math.max(1, Math.floor(nSymbols) * Math.max(1, Math.floor(checksPerDay)));
  return SURPRISE_ALPHA_BASE / n;
}

/**
 * p-value KS tiệm cận (phân phối Kolmogorov Q(λ)).
 * F-177-5 (Task 177 vá ở Task 178): chuỗi 2Σ(−1)^{j−1}e^{−2j²λ²} KHÔNG hội
 * tụ khi λ siêu nhỏ (các số hạng ≈ ±2 nhảy vách mãi — tổng riêng dao động
 * 2/0 thay vì tiến 1). Với λ < 0,4 ta có Q(λ) ≥ 0,996 ≈ 1 (tính tay: λ=0,4
 * → 0,996; λ=0,2 → 0,982) — trả thẳng 1, đúng nghĩa "D siêu nhỏ = không bác
 * bỏ". KS chỉ là TIN PHỤ Bonferroni (F6) nên mất vài chữ số cuối ở vùng p≈1
 * vô hại với quyết định cờ.
 */
export function ksPValue(d: number, n: number): number {
  if (!(d > 0) || n <= 0) return 1;
  const lambda = (Math.sqrt(n) + 0.12 + 0.11 / Math.sqrt(n)) * d;
  if (lambda < 0.4) return 1; // F-177-5: vùng không hội tụ — Q ≈ 1
  // Q(λ) = 2 Σ_{j≥1} (−1)^{j−1} exp(−2j²λ²) — hội tụ nhanh khi λ ≥ 0,4
  let q = 0;
  for (let j = 1; j <= 100; j++) {
    const term = 2 * (j % 2 === 1 ? 1 : -1) * Math.exp(-2 * j * j * lambda * lambda);
    q += term;
    if (Math.abs(term) < 1e-10) break;
  }
  return Math.min(1, Math.max(0, q));
}

/**
 * Diagnostic một chuỗi innovation chuẩn hoá e (từ SsFit.innovations — lấy
 * window=60 PHẦN CUỐI như blueprint). Pure — không DB.
 */
export function surpriseDiagnostics(
  eAll: number[],
  opts: { alpha?: number } = {}
): SurpriseDiag {
  const alpha = opts.alpha ?? SURPRISE_ALPHA_BASE;
  const w = Math.min(SURPRISE_WINDOW, eAll.length);
  const e = eAll.slice(-w);
  const n = e.length;
  if (n === 0) {
    return {
      n: 0, cusum: 0, ksD: 0, ksP: 1, maxAbsE: 0, nAbsGt4: 0,
      flagged: false, reasons: [],
    };
  }

  // TIN CHÍNH — CUSUM-of-squares chuẩn hoá: Σ(e²−1)/√(2w)
  let sumE2m1 = 0;
  let maxAbsE = 0;
  let nAbsGt4 = 0;
  for (const x of e) {
    sumE2m1 += x * x - 1;
    const ax = Math.abs(x);
    if (ax > maxAbsE) maxAbsE = ax;
    if (ax > SURPRISE_ABS_E) nAbsGt4++;
  }
  const cusum = sumE2m1 / Math.sqrt(2 * n);

  // TIN PHỤ — KS một mẫu vs N(0,1)
  const sorted = e.slice().sort((a, b) => a - b);
  let ksD = 0;
  for (let i = 0; i < n; i++) {
    const fEmp = (i + 1) / n;
    const f = normalCdf(sorted[i]);
    ksD = Math.max(ksD, Math.abs(fEmp - f), Math.abs(f - i / n));
  }
  const ksP = ksPValue(ksD, n);

  const reasons: string[] = [];
  if (Math.abs(cusum) > SURPRISE_CUSUM_THRESHOLD) {
    reasons.push(`CUSUM(e²−1) ${cusum.toFixed(2)} vượt ±${SURPRISE_CUSUM_THRESHOLD}`);
  }
  if (ksP < alpha) {
    reasons.push(`KS p ${ksP.toExponential(2)} < Bonferroni ${alpha.toExponential(2)}`);
  }
  if (nAbsGt4 > 0) {
    reasons.push(`${nAbsGt4} lần |e| > ${SURPRISE_ABS_E} (max ${maxAbsE.toFixed(1)})`);
  }

  return {
    n,
    cusum,
    ksD,
    ksP,
    maxAbsE,
    nAbsGt4,
    flagged: reasons.length > 0,
    reasons,
  };
}
