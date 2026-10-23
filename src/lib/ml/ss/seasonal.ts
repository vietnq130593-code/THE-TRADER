/**
 * src/lib/ml/ss/seasonal.ts — SS-9 · SEASONAL CẤU TRÚC: DAY-OF-WEEK + TẾT.
 *
 * STATE_SPACE_BLUEPRINT SS-9 (THẤP — "chỉ làm khi có bằng chứng"): fit trên
 * dữ liệu thật, log-score holdout phải chứng minh seasonality có tín hiệu đáng
 * kể trên HOSE TRƯỚC khi đụng UI/strategist. Output Phase 2 = BÁO CÁO có/không
 * kết luận dứt khoát (docs/SS_SEASONALITY_REPORT.md — Task 178).
 *
 * Dạng SS (Harvey — dummy seasonal): y_t = μ + Σ_d γ_d·1[dow(t)=d] + γ_tet·
 * 1[t∈cửa sổ Tết] + ε_t với trạng thái [μ, γ_T3..γ_T6, γ_tet] HẰNG SỐ
 * (T = I · Q = 0 — "seasonal deterministic"; Z_t đổi theo ngày ⇒ ZSeq của
 * kalman.ts). So sánh:
 *   M0 (baseline): y_t = μ + ε_t — cùng máy, cùng kỷ luật
 *   M1 (seasonal): đầy đủ day-of-week + Tết
 * Cả 2 chấm log-score holdout (SS-11): filter xuyên holdout, mật độ 1-bước
 * N(ŷ_{t|t−1}, F_t) — PIT tuyệt đối (quy tắc 2), σ² đóng băng theo train
 * (quy tắc 3). Tết = "seasonal không đều" — ngày dương dịch mỗi năm, đối xử
 * bằng dummy cửa sổ ±7 ngày lịch quanh mốc Tết (blueprint: ±5 phiên).
 *
 * Pure function, 0 DB — p178 T-P2-7 kiểm định (có tín hiệu → M1 thắng; không
 * tín hiệu → M0 không thua — trung thực 2 chiều).
 */

import { kalmanFilter, type KalmanFilterResult, type KalmanSpec } from "@/lib/ml/ss/kalman";
import { nelderMead, SS_NM_MAX_ITER, SS_NM_TOL } from "@/lib/ml/ss/holt-ss";
import { logNormalDensity } from "@/lib/ml/ss/gauss";

/** Số phiên tối thiểu để so sánh có nghĩa. */
export const SEASONAL_MIN_N = 120;

/** Tỉ lệ holdout mặc định (1/4 — mirror logscore.ts). */
export const SEASONAL_HOLDOUT_RATIO = 4;

/**
 * Mốc TẾT NGUYÊN ĐÁN (mùng 1 tháng Giêng âm lịch — bảng cứng, cập nhật thủ
 * công khi vượt 2028; ghi rõ trong báo cáo). Cửa sổ hiệu ứng = ±7 ngày lịch
 * quanh mốc (≈ ±5 phiên giao dịch — blueprint SS-9).
 */
export const TET_DATES: Record<string, string> = {
  "2024": "2024-02-10", // Giáp Thìn
  "2025": "2025-01-29", // Ất Tỵ
  "2026": "2026-02-17", // Bính Ngọ
  "2027": "2027-02-06", // Đinh Mùi
  "2028": "2028-01-26", // Mậu Thân
};

/** Trong cửa sổ ±7 ngày lịch quanh mốc Tết? */
export function inTetWindow(dateStr: string, windowDays = 7): boolean {
  const year = dateStr.slice(0, 4);
  const tet = TET_DATES[year] ?? TET_DATES[String(Number(year) + 1)] ?? null;
  if (!tet) return false;
  const t = Date.parse(`${tet}T00:00:00Z`);
  const d = Date.parse(`${dateStr}T00:00:00Z`);
  if (!Number.isFinite(t) || !Number.isFinite(d)) return false;
  return Math.abs(d - t) <= windowDays * 86_400_000;
}

/** Hàng thiết kế M1 tại ngày d: [1, dT3, dT4, dT5, dT6, dTet] (T2 = baseline). */
export function seasonalDesignRow(dateStr: string): number[] {
  const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay(); // 1=T2 .. 5=T6
  const d3 = dow === 2 ? 1 : 0;
  const d4 = dow === 3 ? 1 : 0;
  const d5 = dow === 4 ? 1 : 0;
  const d6 = dow === 5 ? 1 : 0;
  const tet = inTetWindow(dateStr) ? 1 : 0;
  return [1, d3, d4, d5, d6, tet];
}

/** Hàng thiết kế M0: [1] (chỉ intercept). */
function baselineRow(): number[] {
  return [1];
}

/** Đặc tả từ σ² (trạng thái hằng số — Q = 0). */
function staticSpec(m: number, sigma2Eps: number): KalmanSpec {
  return {
    T: Array.from({ length: m }, (_, i) =>
      Array.from({ length: m }, (_, j) => (i === j ? 1 : 0))
    ),
    Z: Array.from({ length: m }, (_, i) => (i === 0 ? 1 : 0)),
    R: Array.from({ length: m }, () => Array.from({ length: m }, () => 0)),
    Q: Array.from({ length: m }, () => Array.from({ length: m }, () => 0)),
    H: Math.max(sigma2Eps, 0),
  };
}

/** Var chuỗi hiện diện (floor chống 0 — mirror tvp.ts). */
function presentVar(xs: (number | null)[]): number {
  const v = xs.filter((x): x is number => x != null && Number.isFinite(x));
  if (v.length < 2) return 1e-6;
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  const out = v.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (v.length - 1);
  return Number.isFinite(out) && out > 0 ? out : 1e-6;
}

/** MLE σ² 1 tham số (NM 1-D — đủ cho 1 chiều, multi-start 3 mồi nhỏ/lớn/vừa). */
function fitSigma2(
  ys: (number | null)[],
  ZSeq: number[][],
  m: number
): { sigma2: number; logLik: number } | null {
  const kappa = 1e6 * Math.max(presentVar(ys), Number.MIN_VALUE);
  const init = {
    a: Array.from({ length: m }, () => 0),
    P: Array.from({ length: m }, (_, i) =>
      Array.from({ length: m }, (_, j) => (i === j ? kappa : 0))
    ),
  };
  const cap = 1e6 * Math.max(presentVar(ys), Number.MIN_VALUE);
  const negLik = (p: number[]): number => {
    const s2 = Math.min(Math.max(p[0] ?? 0, 0), cap);
    const res = kalmanFilter(ys, staticSpec(m, s2), init, { burnIn: 5, ZSeq });
    return -res.logLik;
  };
  const S = Math.max(presentVar(ys), 1e-9);
  let best: { x: number[]; fx: number } | null = null;
  for (const seed of [[S], [S * 0.05], [S * 5]]) {
    const r = nelderMead(1, seed, negLik, { maxIter: SS_NM_MAX_ITER, tol: SS_NM_TOL });
    if (!best || r.fx < best.fx) best = { x: r.x, fx: r.fx };
  }
  if (!best) return null;
  return { sigma2: Math.min(Math.max(best.x[0] ?? 0, 0), cap), logLik: -best.fx };
}

/** Kết quả một model (M0 hoặc M1). */
export interface SeasonalModelResult {
  /** σ̂² MLE trên train (đóng băng xuyên holdout — quy tắc 3). */
  sigma2: number;
  logLikTrain: number;
  /** Σ log N(y_t | ŷ_{t|t−1}, F_t) trên holdout — thước SS-11. */
  holdoutLogScore: number;
  holdoutN: number;
  /** Hệ số lọc cuối + √P cuối từng chiều (γ̂ ± sd — dùng trong báo cáo). */
  state: { name: string; mean: number; sd: number }[];
}

/** Kết quả so sánh M0 vs M1 trên một chuỗi. */
export interface SeasonalCompare {
  trainN: number;
  holdoutN: number;
  presentN: number;
  m0: SeasonalModelResult;
  m1: SeasonalModelResult;
  /** M1 − M0 trên mean log-score holdout (dương = seasonal CÓ tín hiệu). */
  diffPerStep: number;
  /** Hiệu ứng từng ngày trong tuần (% so σ của chuỗi) + Tết. */
  effects: { name: string; mean: number; sd: number; unitSd: number }[];
}

/**
 * So sánh M0 (mean hằng) vs M1 (DOW + Tết) trên chuỗi return/điểm y kèm ngày.
 * returns/datess cùng độ dài — null ở y = phiên thiếu (SS-3 skip-update).
 * Trả null khi không đủ dữ liệu (fail-soft trung thực).
 */
export function seasonalCompare(
  ys: (number | null)[],
  dates: string[],
  opts: { holdoutRatio?: number } = {}
): SeasonalCompare | null {
  const n = Math.min(ys.length, dates.length);
  if (n < SEASONAL_MIN_N) return null;
  const present = ys.filter((y): y is number => y != null && Number.isFinite(y)).length;
  if (present < SEASONAL_MIN_N) return null;
  const ratio = Math.max(2, Math.floor(opts.holdoutRatio ?? SEASONAL_HOLDOUT_RATIO));
  const holdoutN = Math.max(20, Math.floor(n / ratio));
  const trainN = n - holdoutN;
  if (trainN < 60) return null;

  const yAll = ys.slice(0, n);
  const Z1 = dates.slice(0, n).map((d) => seasonalDesignRow(d));
  const Z0 = dates.slice(0, n).map(() => baselineRow());

  const runModel = (
    ZSeq: number[][],
    m: number
  ): { fit: { sigma2: number; logLik: number } | null; res: KalmanFilterResult | null } => {
    // σ² fit trên TRAIN (đóng băng) — filter xuyên TOÀN chuỗi cho holdout score
    const trainY = yAll.slice(0, trainN);
    const trainZ = ZSeq.slice(0, trainN);
    const fit = fitSigma2(trainY, trainZ, m);
    if (!fit) return { fit: null, res: null };
    const kappa = 1e6 * Math.max(presentVar(trainY), Number.MIN_VALUE);
    const res = kalmanFilter(
      yAll,
      staticSpec(m, fit.sigma2),
      {
        a: Array.from({ length: m }, () => 0),
        P: Array.from({ length: m }, (_, i) =>
          Array.from({ length: m }, (_, j) => (i === j ? kappa : 0))
        ),
      },
      { burnIn: 5, ZSeq }
    );
    return { fit, res };
  };

  const rm0 = runModel(Z0, 1);
  const rm1 = runModel(Z1, 6);
  if (!rm0.fit || !rm0.res || !rm1.fit || !rm1.res) return null;

  const holdoutScore = (res: KalmanFilterResult, ZSeq: number[][]): { sum: number; cnt: number } => {
    let sum = 0;
    let cnt = 0;
    for (let t = trainN; t < n; t++) {
      const s = res.steps[t];
      const y = yAll[t];
      const Zt = ZSeq[t]!;
      if (s?.v != null && s.F != null && y != null) {
        // ŷ_{t|t−1} = Z_t·aPred_t (đầy đủ hệ số mùa — KHÔNG chỉ aPred[0])
        const zA = Zt.reduce((acc, z, i) => acc + z * (s.aPred[i] ?? 0), 0);
        sum += logNormalDensity(y, zA, s.F);
        cnt++;
      }
    }
    return { sum, cnt };
  };
  const h0 = holdoutScore(rm0.res, Z0);
  const h1 = holdoutScore(rm1.res, Z1);

  const sdY = Math.sqrt(presentVar(yAll));
  const stateOf = (res: KalmanFilterResult, names: string[]) =>
    names.map((name, i) => ({
      name,
      mean: res.aFinal[i] ?? 0,
      sd: Math.sqrt(Math.max(res.PFinal[i]?.[i] ?? 0, 0)),
    }));
  const effects = stateOf(rm1.res, ["μ", "γ_T3", "γ_T4", "γ_T5", "γ_T6", "γ_Tết"])
    .slice(1) // bỏ μ — chỉ hiệu ứng mùa
    .map((s) => ({ ...s, unitSd: sdY > 0 ? s.mean / sdY : 0 }));

  return {
    trainN,
    holdoutN,
    presentN: present,
    m0: {
      sigma2: rm0.fit.sigma2,
      logLikTrain: rm0.fit.logLik,
      holdoutLogScore: h0.sum,
      holdoutN: h0.cnt,
      state: stateOf(rm0.res, ["μ"]),
    },
    m1: {
      sigma2: rm1.fit.sigma2,
      logLikTrain: rm1.fit.logLik,
      holdoutLogScore: h1.sum,
      holdoutN: h1.cnt,
      state: stateOf(rm1.res, ["μ", "γ_T3", "γ_T4", "γ_T5", "γ_T6", "γ_Tết"]),
    },
    diffPerStep: (h1.cnt > 0 ? h1.sum / h1.cnt : 0) - (h0.cnt > 0 ? h0.sum / h0.cnt : 0),
    effects,
  };
}
