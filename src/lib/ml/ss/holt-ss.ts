/**
 * src/lib/ml/ss/holt-ss.ts — SS-1 · HOLT → LOCAL LINEAR TREND TRẠNG THÁI (MLE).
 *
 * STATE_SPACE_BLUEPRINT SS-1 (điểm neo Phase 1): thay cặp α=0,5/β=0,25 cứng
 * của src/lib/quant/forecast.ts bằng local linear trend SSM (Durbin & Koopman
 * ch. 2–3):
 *   α_t = [μ_t; b_t] (level + slope) · T = [[1,1],[0,1]] · Z = [1,0]
 *   Q = diag(σ²ημ, σ²ηb) · H = σ²ε — 3 THAM SỐ PHƯƠNG SAI thay α/β cố định
 * Ước lượng MLE trên prediction error decomposition (Phần I.3) bằng
 * NELDER-MEAD MULTI-START (F4-v1.1: 3 tham số — golden-section 1-D không đủ;
 * ≥ 5 mồi gồm mồi từ α/β cũ qui ra signal-to-noise; clamp biên σ² ≥ 0 —
 * nghiệm biên σ²→0 là mô hình rút gọn HỢP LỆ, không phải lỗi hội tụ;
 * likelihood phẳng trên chuỗi ngắn khi 2 phương sai hoán đổi vai trò —
 * multi-start chống kẹt). Ngừng khi Δℓ < 1e−8 — deterministic (khởi tạo cố
 * định theo khối KHỞI TẠO Phụ lục A, nhân bản triết lý train v17/v18).
 *
 * KHỞI TẠO (Phụ lục A — áp mọi model SS ở đây):
 *   a₁ = [y₁; y₂−y₁] · P₁ = κ·I, κ = 10⁶·Var(y) (xấp xỉ diffuse hữu hạn)
 *   burn-in m = 5 điểm đầu khỏi likelihood ℓ
 *
 * Predictive variance (SS-2): Var(ŷ_{t+h|t}) từ đệ quy P (kalman.ts) — thay
 * heuristic Z80·σ_res·√h. pUp theo công thức F1-v1.1: pUp = Φ(meanPct/sd).
 *
 * PIT (Phần IV quy tắc 2): mọi hàm chỉ tiêu thụ closes ≤ castDate — caller
 * đảm bảo (đường shadow dùng cửa sổ kết thúc hôm nay; không có lookahead).
 * Pure function, 0 DB — scripts/p176 kiểm định hermetic.
 */

import {
  kalmanFilter,
  kalmanForecast,
  type KalmanSpec,
} from "@/lib/ml/ss/kalman";
import { pUpFromPct } from "@/lib/ml/ss/gauss";

/** Burn-in điểm đầu khỏi likelihood (Phụ lục A). */
export const SS_BURN_IN = 5;

/** Ngưỡng hội tụ Nelder-Mead: spread (max−min) mục tiêu < 1e−8. */
export const SS_NM_TOL = 1e-8;

/** Số vòng Nelder-Mead tối đa mỗi mồi (safety net — 3 tham số hội tụ ≪ 500). */
export const SS_NM_MAX_ITER = 500;

/** Số mồi multi-start (F4: ≥ 5). */
export const SS_NM_STARTS = 5;

/** Trần σ² = 10⁶·Var(Δy) — chống simplex bay vô hạn trên likelihood phẳng. */
const SIGMA2_CAP_MULT = 1e6;

/** Chuỗi tối thiểu để fit có nghĩa (dưới → null fail-soft trung thực). */
export const SS_MIN_N = 30;

/* ───────────────────────── Model local linear trend ───────────────────────── */

/** Đặc tả local linear trend từ 3 phương sai (T/Z/R cố định theo D&K ch. 2). */
function localLinearTrendSpec(sigma2Eps: number, sigma2EtaMu: number, sigma2EtaB: number): KalmanSpec {
  return {
    T: [
      [1, 1],
      [0, 1],
    ],
    Z: [1, 0],
    R: [
      [1, 0],
      [0, 1],
    ],
    Q: [
      [Math.max(sigma2EtaMu, 0), 0],
      [0, Math.max(sigma2EtaB, 0)],
    ],
    H: Math.max(sigma2Eps, 0),
  };
}

/** Đặc tả local level (ch. 2 — mô hình sông Nile, dùng nghiệm thu T1 p176). */
function localLevelSpec(sigma2Eps: number, sigma2Eta: number): KalmanSpec {
  return {
    T: [[1]],
    Z: [1],
    R: [[1]],
    Q: [[Math.max(sigma2Eta, 0)]],
    H: Math.max(sigma2Eps, 0),
  };
}

/** Khởi tạo theo Phụ lục A cho chuỗi y (local linear trend 2 chiều trạng thái). */
function lltInit(ys: number[]): { a: number[]; P: number[][] } {
  const n = ys.length;
  const mean = ys.reduce((s, y) => s + y, 0) / n;
  const varY = ys.reduce((s, y) => s + (y - mean) * (y - mean), 0) / Math.max(1, n - 1);
  const kappa = 1e6 * Math.max(varY, Number.MIN_VALUE);
  return {
    a: [ys[0], ys[1] - ys[0]],
    P: [
      [kappa, 0],
      [0, kappa],
    ],
  };
}

/** Khởi tạo local level (a₁ = y₁ · P₁ = κ·I₁). */
function llInit(ys: number[]): { a: number[]; P: number[][] } {
  const n = ys.length;
  const mean = ys.reduce((s, y) => s + y, 0) / n;
  const varY = ys.reduce((s, y) => s + (y - mean) * (y - mean), 0) / Math.max(1, n - 1);
  return { a: [ys[0]], P: [[1e6 * Math.max(varY, Number.MIN_VALUE)]] };
}

/* ───────────────────── Nelder-Mead (3-D, clamp σ² ≥ 0) ───────────────────── */

/**
 * Nelder-Mead tối thiểu hoá f(x) trên x ∈ R^k với clamp từng toạ độ ≥ 0
 * (biên σ² = 0 = mô hình rút gọn hợp lệ — F4). Simplex khởi từ x0 với bước
 * step[i] = 10% x0[i] (floor nhỏ). Trả điểm tốt nhất + giá trị.
 */
export function nelderMead(
  k: number,
  x0: number[],
  f: (x: number[]) => number,
  opts: { maxIter?: number; tol?: number } = {}
): { x: number[]; fx: number; iter: number; converged: boolean } {
  const maxIter = opts.maxIter ?? SS_NM_MAX_ITER;
  const tol = opts.tol ?? SS_NM_TOL;
  const clamp = (v: number[]): number[] => v.map((c) => (Number.isFinite(c) && c > 0 ? c : 0));
  const evalF = (v: number[]): number => {
    const r = f(clamp(v));
    return Number.isFinite(r) ? r : 1e300; // NaN/∞ → phạt cực đại (đẩy simplex quay lại)
  };

  // Simplex ban đầu: x0 + các đỉnh lệch 1 trục
  const simplex: { x: number[]; fx: number }[] = [];
  const fx0 = evalF(x0);
  simplex.push({ x: clamp(x0.slice()), fx: fx0 });
  for (let i = 0; i < k; i++) {
    const xi = clamp(x0.slice());
    const stepI = Math.max(Math.abs(x0[i]) * 0.1, Math.abs(x0[i]) * 1e-4, 1e-12);
    xi[i] = xi[i] + stepI;
    simplex.push({ x: xi, fx: evalF(xi) });
  }

  const ALPHA = 1; // phản chiếu
  const GAMMA = 2; // giãn
  const RHO = 0.5; // co
  const SIGMA = 0.5; // co cả simplex

  let iter = 0;
  let converged = false;
  for (; iter < maxIter; iter++) {
    simplex.sort((a, b) => a.fx - b.fx);
    const best = simplex[0];
    const worst = simplex[k];
    const spread = Math.abs(simplex[k].fx - simplex[0].fx);
    if (spread < tol) {
      converged = true;
      break;
    }
    // Tâm mặt (bỏ đỉnh xấu nhất)
    const centroid = Array(k).fill(0) as number[];
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) centroid[j] += simplex[i].x[j];
    }
    for (let j = 0; j < k; j++) centroid[j] /= k;
    // Phản chiếu
    const refl = clamp(centroid.map((c, j) => c + ALPHA * (c - worst.x[j])));
    const fRefl = evalF(refl);
    if (fRefl < simplex[0].fx) {
      // Giãn
      const exp = clamp(centroid.map((c, j) => c + GAMMA * (refl[j] - c)));
      const fExp = evalF(exp);
      if (fExp < fRefl) simplex[k] = { x: exp, fx: fExp };
      else simplex[k] = { x: refl, fx: fRefl };
    } else if (fRefl < simplex[k - 1].fx) {
      simplex[k] = { x: refl, fx: fRefl };
    } else {
      // Co (trong hay ngoài tuỳ phản chiếu có tốt hơn xấu nhất không)
      const doInside = fRefl < worst.fx;
      const contr = clamp(
        centroid.map((c, j) => c + RHO * ((doInside ? refl[j] : worst.x[j]) - c))
      );
      const fContr = evalF(contr);
      if (fContr < (doInside ? fRefl : worst.fx)) {
        simplex[k] = { x: contr, fx: fContr };
      } else {
        // Co cả simplex về đỉnh tốt nhất
        for (let i = 1; i <= k; i++) {
          const xi = clamp(best.x.map((b, j) => b + SIGMA * (simplex[i].x[j] - b)));
          simplex[i] = { x: xi, fx: evalF(xi) };
        }
      }
    }
  }
  simplex.sort((a, b) => a.fx - b.fx);
  return { x: clamp(simplex[0].x), fx: simplex[0].fx, iter, converged };
}

/* ─────────────────────────────── Fit interfaces ─────────────────────────────── */

/** Innovation quan sát được (sau burn-in) — đầu vào diag SS-7 + audit. */
export interface SsInnovation {
  t: number;
  v: number;
  F: number;
  e: number;
}

/** Kết quả fit chuẩn hoá — mọi field ghi đủ để tái tạo (quy tắc 3 Phần IV). */
export interface SsFitBase {
  /** log-likelihood tối ưu (đã trừ burn-in). */
  logLik: number;
  /** Innovations sau burn-in (chỉ bước có quan sát). */
  innovations: SsInnovation[];
  /** Trạng thái lọc cuối — gốc dự báo (PIT: E(α_T|y_1..T)). */
  aFinal: number[];
  PFinal: number[][];
  n: number;
  burnIn: number;
  /** Trạng thái hội tụ NM của mồi thắng (meta trung thực). */
  converged: boolean;
  /** Số vòng NM của mồi thắng. */
  iter: number;
}

/** Fit local linear trend (3 tham số — SS-1). */
export interface HoltSsFit extends SsFitBase {
  sigma2Eps: number;
  sigma2EtaMu: number;
  sigma2EtaB: number;
  /** 5 mồi: seed + logLik đích (audit multi-start chống kẹt likelihood phẳng). */
  starts: { seed: number[]; logLik: number }[];
}

/** Fit local level (2 tham số — Nile T1 + baseline so sánh). */
export interface LocalLevelFit extends SsFitBase {
  sigma2Eps: number;
  sigma2Eta: number;
  starts: { seed: number[]; logLik: number }[];
}

function validateCloses(closes: (number | null)[]): closes is number[] {
  if (closes.length < SS_MIN_N) return false;
  for (const c of closes) {
    // Chỉ đòi FINITE — KHÔNG đòi > 0: SS-7 fit LOG-GIÁ (log có thể âm hợp
    // lệ với giá < 1 — toán Kalman không cần dương). Guard dương chỉ nằm ở
    // holtSsForecast (chia % theo close cuối — giá thật luôn dương).
    if (c == null || !Number.isFinite(c)) return false;
  }
  return true;
}

/** Var của sai phân 1 bước — thước đo quy mô nhiễu dùng dựng mồi (floor chống 0). */
function diffVar(ys: number[]): number {
  const d: number[] = [];
  for (let i = 1; i < ys.length; i++) d.push(ys[i] - ys[i - 1]);
  const mean = d.reduce((s, x) => s + x, 0) / d.length;
  const v = d.reduce((s, x) => s + (x - mean) * (x - mean), 0) / Math.max(1, d.length - 1);
  return Math.max(v, Number.MIN_VALUE);
}

/**
 * 5 mồi deterministic (F4): mồi 0 = cầu từ heuristic cũ — Holt α=0,5/β=0,25
 * qui ra signal-to-noise (local level steady-state K=α ⇒ q = α²/(1−α) = 0,5;
 * trend noise theo β²/(1−β) nhỏ hơn nhiều vì slope đổi chậm); mồi 1–4 trải
 * nhỏ/large trên cả 2 trục state-noise chống likelihood phẳng hoán đổi vai.
 */
function lltSeeds(ys: number[]): number[][] {
  const S = diffVar(ys);
  const cap = SIGMA2_CAP_MULT * S;
  const cl = (v: number): number => Math.min(Math.max(v, 0), cap);
  return [
    [cl(S * 0.9), cl(S * 0.45), cl(S * 0.0025)], // mồi heuristic α/β cũ
    [cl(S * 0.9), cl(S * 0.045), cl(S * 0.0009)], // state-noise nhỏ
    [cl(S * 0.9), cl(S * 4.5), cl(S * 0.045)], // ημ lớn
    [cl(S * 0.09), cl(S * 0.45), cl(S * 0.0045)], // ε nhỏ
    [cl(S * 9), cl(S * 4.5), cl(S * 0.45)], // tất cả lớn
  ];
}

/** Mồi local level (Nile): heuristic + trải q nhỏ→large. */
function llSeeds(ys: number[]): number[][] {
  const S = diffVar(ys);
  const cap = SIGMA2_CAP_MULT * S;
  const cl = (v: number): number => Math.min(Math.max(v, 0), cap);
  return [
    [cl(S * 0.9), cl(S * 0.45)],
    [cl(S * 0.9), cl(S * 0.045)],
    [cl(S * 0.9), cl(S * 4.5)],
    [cl(S * 0.09), cl(S * 0.45)],
    [cl(S * 9), cl(S * 4.5)],
  ];
}

/* ───────────────────────────────── Fit chính ───────────────────────────────── */

/**
 * holtSsFit — MLE local linear trend trên closes (SS-1). Trả null khi chuỗi
 * < 30 điểm hoặc chứa giá ≤ 0/NaN (fail-soft trung thực — không bịa fit).
 * Deterministic: mồi cố định, NM thuần, không RNG.
 */
export function holtSsFit(closes: number[], opts: { maxIter?: number } = {}): HoltSsFit | null {
  if (!validateCloses(closes)) return null;
  const ys = closes;
  const init = lltInit(ys);
  const cap = SIGMA2_CAP_MULT * diffVar(ys);
  const nmOpts = {
    maxIter: Math.max(1, Math.floor(opts.maxIter ?? SS_NM_MAX_ITER)),
  };
  const negLik = (x: number[]): number => {
    const [s2e, s2mu, s2b] = x.map((v) => Math.min(Math.max(v, 0), cap));
    const res = kalmanFilter(ys, localLinearTrendSpec(s2e, s2mu, s2b), init, { burnIn: SS_BURN_IN });
    return -res.logLik;
  };

  const starts: { seed: number[]; logLik: number }[] = [];
  let best: { x: number[]; fx: number; iter: number; converged: boolean } | null = null;
  for (const seed of lltSeeds(ys)) {
    const r = nelderMead(3, seed, negLik, nmOpts);
    starts.push({ seed, logLik: -r.fx });
    if (best == null || r.fx < best.fx) best = r;
  }
  if (!best) return null;

  const [sigma2Eps, sigma2EtaMu, sigma2EtaB] = best.x;
  const res = kalmanFilter(
    ys,
    localLinearTrendSpec(sigma2Eps, sigma2EtaMu, sigma2EtaB),
    init,
    { burnIn: SS_BURN_IN }
  );
  const innovations: SsInnovation[] = [];
  let seen = 0;
  for (const s of res.steps) {
    if (s.v != null && s.F != null) {
      seen++;
      if (seen > SS_BURN_IN) innovations.push({ t: s.t, v: s.v, F: s.F, e: s.e ?? 0 });
    }
  }
  return {
    sigma2Eps,
    sigma2EtaMu,
    sigma2EtaB,
    logLik: res.logLik,
    innovations,
    aFinal: res.aFinal,
    PFinal: res.PFinal,
    n: ys.length,
    burnIn: SS_BURN_IN,
    converged: best.converged,
    iter: best.iter,
    starts,
  };
}

/**
 * localLevelFit — MLE local level (ch. 2, 2 tham số). Dùng nghiệm thu TÀI LIỆU
 * (Nile — scripts/p176 T1) + baseline so sánh nhanh. Cùng sơ đồ khởi tạo/burn-in.
 */
export function localLevelFit(closes: number[]): LocalLevelFit | null {
  if (!validateCloses(closes)) return null;
  const ys = closes;
  const init = llInit(ys);
  const cap = SIGMA2_CAP_MULT * diffVar(ys);
  const negLik = (x: number[]): number => {
    const [s2e, s2eta] = x.map((v) => Math.min(Math.max(v, 0), cap));
    const res = kalmanFilter(ys, localLevelSpec(s2e, s2eta), init, { burnIn: SS_BURN_IN });
    return -res.logLik;
  };
  const starts: { seed: number[]; logLik: number }[] = [];
  let best: { x: number[]; fx: number; iter: number; converged: boolean } | null = null;
  for (const seed of llSeeds(ys)) {
    const r = nelderMead(2, seed, negLik);
    starts.push({ seed, logLik: -r.fx });
    if (best == null || r.fx < best.fx) best = r;
  }
  if (!best) return null;
  const [sigma2Eps, sigma2Eta] = best.x;
  const res = kalmanFilter(ys, localLevelSpec(sigma2Eps, sigma2Eta), init, { burnIn: SS_BURN_IN });
  const innovations: SsInnovation[] = [];
  let seen = 0;
  for (const s of res.steps) {
    if (s.v != null && s.F != null) {
      seen++;
      if (seen > SS_BURN_IN) innovations.push({ t: s.t, v: s.v, F: s.F, e: s.e ?? 0 });
    }
  }
  return {
    sigma2Eps,
    sigma2Eta,
    logLik: res.logLik,
    innovations,
    aFinal: res.aFinal,
    PFinal: res.PFinal,
    n: ys.length,
    burnIn: SS_BURN_IN,
    converged: best.converged,
    iter: best.iter,
    starts,
  };
}

/* ─────────────────────────────── Dự báo (SS-2) ─────────────────────────────── */

/** Dự báo h bước từ fit — predictive variance chuẩn (thay Z80·σ√h heuristic). */
export interface HoltSsForecast {
  /** Dự báo điểm từng horizon (đơn vị giá). */
  mean: number[];
  /** √Var(ŷ_{t+h|t}) từng horizon (đơn vị giá) — từ đệ quy P (SS-2). */
  sd: number[];
  /** % so giá close cuối + sd% + z từng horizon. */
  meanPct: number[];
  sdPct: number[];
  /** z_h = meanPct/sdPct (mức tin theo horizon). */
  z: number[];
  /** pUp tại horizon cuối (Φ(meanPct/sdPct) — công thức F1-v1.1). */
  pUp: number | null;
  /** Giá close cuối (neo %). */
  lastClose: number;
}

/**
 * holtSsForecast(fit, closes, h) — đúng chữ ký blueprint SS-1. Dự báo từ
 * trạng thái lọc cuối của fit; neo % vào closes cuối THẬT (y_T) để so sánh
 * công bằng với driver cũ holtForecastPct (cũng neo y_T). PIT an toàn.
 */
export function holtSsForecast(
  fit: HoltSsFit,
  closes: number[],
  horizon: number
): HoltSsForecast | null {
  const h = Math.max(1, Math.min(30, Math.round(horizon)));
  if (closes.length === 0) return null;
  const lastClose = closes[closes.length - 1];
  if (!(lastClose > 0)) return null;
  const spec = localLinearTrendSpec(fit.sigma2Eps, fit.sigma2EtaMu, fit.sigma2EtaB);
  const pts = kalmanForecast(spec, fit.aFinal, fit.PFinal, h);
  if (pts.length === 0) return null;
  const mean = pts.map((p) => p.mean);
  const sd = pts.map((p) => Math.sqrt(Math.max(p.variance, 0)));
  const meanPct = mean.map((m) => ((m - lastClose) / lastClose) * 100);
  const sdPct = sd.map((s) => (s / lastClose) * 100);
  const z = meanPct.map((mp, i) => (sdPct[i] > 0 ? mp / sdPct[i] : 0));
  const lastIdx = h - 1;
  return {
    mean,
    sd,
    meanPct,
    sdPct,
    z,
    pUp: pUpFromPct(meanPct[lastIdx], sdPct[lastIdx]),
    lastClose,
  };
}
