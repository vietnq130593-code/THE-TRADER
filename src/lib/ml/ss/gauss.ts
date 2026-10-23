/**
 * src/lib/ml/ss/gauss.ts — GAUSS TOÁN HỌC DÙNG CHUNG CHO TẦNG STATE SPACE.
 *
 * STATE_SPACE_BLUEPRINT (docs/STATE_SPACE_BLUEPRINT.md) Phần IV quy tắc 1:
 * thư viện SS thuần TS, 0 dependency ngoài, pure + deterministic. File này là
 * nguồn DUY NHẤT của Φ (normal CDF) / mật độ chuẩn — dùng cho:
 *   - pUp của driver holt-ss (SS-1, công thức F1-v1.1: pUp = Φ(meanPct/sd))
 *   - KS-test vs N(0,1) của guard ngạc nhiên (SS-7 · diag.ts)
 *   - log predictive density (SS-11 · logscore.ts)
 *
 * erf xấp xỉ Abramowitz–Stegun 7.1.26 (sai số tuyệt đối < 1,5e−7) — đủ chính
 * xác cho cổng xác suất/diagnostic. Pure function — không DB, không side-effect.
 */

/** |ε| < 1.5e−7 — xấp xỉ erf của Abramowitz & Stegun (1965) 7.1.26. */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/** Φ(x) — hàm phân phối tích luỹ chuẩn N(0,1). */
export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/** φ(x) — mật độ xác suất chuẩn N(0,1). */
export function normalPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * ln N(y; mean, variance) — log predictive density (SS-11 log-score dùng cái
 * này). variance PHẢI > 0 (caller chặn; variance ≤ 0 nghĩa là model degenerate
 * — logscore.ts tự guard bằng sàn MIN_VALUE).
 */
export function logNormalDensity(y: number, mean: number, variance: number): number {
  const v = Math.max(variance, Number.MIN_VALUE);
  const diff = y - mean;
  return -0.5 * (Math.log(2 * Math.PI * v) + (diff * diff) / v);
}

/**
 * pUp theo công thức F1 (hiệu đính v1.1 — Task 172): nghĩa là "xác suất giá
 * ĐI LÊN sau h phiên" với dự báo phần trăm ~ N(meanPct, sdPct²):
 *   pUp = 1 − Φ((0 − meanPct)/sdPct) ≡ Φ(meanPct/sdPct)
 * Công thức sai `Φ((0−mean)/sd)` (đã bị review F1 bắt) trả về pDown — đảo
 * ngược evidence tăng/giảm. Unit-test T10 của scripts/p176 chặn regression.
 * sdPct ≤ 0 → null (model degenerate — caller tự fail-soft).
 */
export function pUpFromPct(meanPct: number, sdPct: number): number | null {
  if (!(sdPct > 0) || !Number.isFinite(meanPct) || !Number.isFinite(sdPct)) return null;
  return normalCdf(meanPct / sdPct);
}
