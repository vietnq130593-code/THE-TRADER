/**
 * src/lib/ml/ss/tvp.ts — SS-5 · β ĐỘNG (TIME-VARYING PARAMETER · ch. 8).
 *
 * STATE_SPACE_BLUEPRINT SS-5 (W1 rổ top-10 ADTV HOSE): β của từng mã so
 * VNINDEX chưa được mô hình hoá động (reward rổ chung). Sách dạy (ch. 8):
 *   r_i,t = α_i,t + β_i,t·r_m,t + ε_t · β_{t+1} = β_t + η_t (random walk)
 * — Kalman cho β_{t|t} mỗi ngày kèm Var(β) → biết "β đang trôi và mình chắc
 * đến đâu".
 *
 * Dạng SS (Phụ lục A): trạng thái α_t = [α_i,t; β_i,t] · T = I₂ · R = I₂ ·
 * Q = diag(τ²α, τ²β) · H = σ²ε · **Z_t = [1, r_m,t] đổi theo bước** (ZSeq của
 * kalman.ts — Task 178). MLE 3 tham số bằng Nelder-Mead multi-start 5 mồi
 * clamp biên σ² ≥ 0 (F4) — tái dùng nelderMead của holt-ss.ts. Phiên r_m hoặc
 * r_i thiếu (SS-3) ⇒ skip-update — trạng thái trôi, P phình trung thực.
 *
 * Ứng dụng (blueprint): hedge ratio dự phòng cho strategist · tách biến động
 * thị trường vs idiosyncratic (risk route — future hook sizing) · Var(β)
 * phình = cờ destabilising. PIT: β_{t|t} chỉ dùng dữ liệu ≤ t (filter, không
 * smoother — quy tắc 2). Pure function, 0 DB — p178 T-P2-5/6 kiểm định.
 */

import { kalmanFilter, type KalmanSpec } from "@/lib/ml/ss/kalman";
import { nelderMead, SS_NM_MAX_ITER, SS_NM_TOL } from "@/lib/ml/ss/holt-ss";

/** Chuỗi phiên tối thiểu để TVP có nghĩa (fit + đánh giá Var β). */
export const TVP_MIN_N = 60;

/** Trần σ² = 10⁶·Var(y) — chống simplex bay vô hạn (mirror holt-ss). */
const SIGMA2_CAP_MULT = 1e6;

/** Kết quả fit TVP — mọi field ghi đủ tái tạo (quy tắc 3 Phần IV). */
export interface TvpFit {
  /** σ²ε — nhiễu quan sát (phần idiosyncratic của r_i). */
  sigma2Eps: number;
  /** τ²α — nhiễu random walk của intercept. */
  sigma2EtaAlpha: number;
  /** τ²β — nhiễu random walk của β. */
  sigma2EtaBeta: number;
  logLik: number;
  /** Intercept lọc cuối α_{T|T}. */
  alphaT: number;
  /** β lọc cuối β_{T|T} — PIT an toàn (E(β_T | dữ liệu ≤ T)). */
  betaT: number;
  /** √P[1][1] cuối — "β đang trôi và mình chắc đến đâu". */
  betaSdT: number;
  /** β tại phần tử CÓ MẶT thứ (n − lag) — đo độ dịch β trên cửa sổ. */
  betaAtPresentFromEnd: (lag: number) => number | null;
  n: number;
  /** Số phiên có đủ cả r_i và r_m (cặp dùng được). */
  presentPairs: number;
  burnIn: number;
  converged: boolean;
  iter: number;
  starts: { seed: number[]; logLik: number }[];
}

/** Đặc tả TVP từ 3 phương sai (T=I · Q=diag · H — ZSeq cung cấp ngoài). */
function tvpSpec(sigma2Eps: number, tau2Alpha: number, tau2Beta: number): KalmanSpec {
  return {
    T: [
      [1, 0],
      [0, 1],
    ],
    Z: [1, 0], // placeholder — kalmanFilter dùng ZSeq từng bước
    R: [
      [1, 0],
      [0, 1],
    ],
    Q: [
      [Math.max(tau2Alpha, 0), 0],
      [0, Math.max(tau2Beta, 0)],
    ],
    H: Math.max(sigma2Eps, 0),
  };
}

/** Var của chuỗi hiện diện — dựng mồi + cap (floor chống 0). */
function presentVar(xs: (number | null)[]): number {
  const v = xs.filter((x): x is number => x != null && Number.isFinite(x));
  if (v.length < 2) return 1e-6;
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  const out = v.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (v.length - 1);
  return Number.isFinite(out) && out > 0 ? out : 1e-6;
}

/** Khởi tạo: α=0 · β=1 (prior trung tính thị trường) · P₁ = κ·I₂ (Phụ lục A). */
function tvpInit(y: (number | null)[]): { a: number[]; P: number[][] } {
  const kappa = 1e6 * Math.max(presentVar(y), Number.MIN_VALUE);
  return {
    a: [0, 1],
    P: [
      [kappa, 0],
      [0, kappa],
    ],
  };
}

/** 5 mồi deterministic (F4): trải signal-to-noise từ nhỏ → lớn trên cả 2 trục. */
function tvpSeeds(y: (number | null)[]): number[][] {
  const S = presentVar(y);
  const cap = SIGMA2_CAP_MULT * S;
  const cl = (v: number): number => Math.min(Math.max(v, 0), cap);
  return [
    [cl(S * 0.9), cl(S * 0.01), cl(S * 0.01)], // β gần hằng
    [cl(S * 0.9), cl(S * 0.001), cl(S * 0.05)], // β trôi vừa
    [cl(S * 0.9), cl(S * 0.1), cl(S * 0.1)], // cả hai trôi
    [cl(S * 0.09), cl(S * 0.001), cl(S * 0.001)], // ε nhỏ — quan sát sạch
    [cl(S * 9), cl(S * 1), cl(S * 1)], // tất cả lớn
  ];
}

/** Cặp (y_t, x_t) dùng được — thiếu 1 trong 2 ⇒ skip-update (SS-3). */
function usablePairs(
  y: (number | null)[],
  x: (number | null)[]
): { y: number[]; x: number[]; ZSeq: number[][] } {
  const ys: number[] = [];
  const xs: number[] = [];
  const ZSeq: number[][] = [];
  for (let t = 0; t < Math.min(y.length, x.length); t++) {
    const yt = y[t];
    const xt = x[t];
    if (yt != null && Number.isFinite(yt) && xt != null && Number.isFinite(xt)) {
      ys.push(yt);
      xs.push(xt);
      ZSeq.push([1, xt]);
    } else {
      // skip-update: vẫn giữ bước thời gian (ZSeq rỗng → filter dùng spec.Z?
      // KHÔNG — truyền null-observation vào chuỗi y, ZSeq vẫn cần phần tử).
      ys.push(Number.NaN); // sẽ được kalmanFilter coi như null
      xs.push(Number.NaN);
      ZSeq.push([1, 0]); // Z bất kì — y NaN ⇒ nhánh skip-update
    }
  }
  return { y: ys, x: xs, ZSeq };
}

/** NaN → null (kalmanFilter hiểu null là thiếu — SS-3). */
function nanToNull(ys: number[]): (number | null)[] {
  return ys.map((y) => (Number.isFinite(y) ? y : null));
}

/**
 * tvpFit — MLE TVP (α, β random walk) của y theo x. Trả null khi < 60 cặp
 * dùng được (fail-soft trung thực). Deterministic — không RNG.
 */
export function tvpFit(
  y: (number | null)[],
  x: (number | null)[],
  opts: { maxIter?: number } = {}
): TvpFit | null {
  const n = Math.min(y.length, x.length);
  if (n < TVP_MIN_N) return null;
  const pairs = usablePairs(y, x);
  const presentPairs = pairs.y.filter((v) => Number.isFinite(v)).length;
  if (presentPairs < TVP_MIN_N) return null;

  const ys: (number | null)[] = nanToNull(pairs.y);
  const ZSeq = pairs.ZSeq;
  const init = tvpInit(ys);
  const cap = SIGMA2_CAP_MULT * presentVar(ys);
  const nmOpts = {
    maxIter: Math.max(1, Math.floor(opts.maxIter ?? SS_NM_MAX_ITER)),
    tol: SS_NM_TOL,
  };
  const negLik = (p: number[]): number => {
    const [s2e, t2a, t2b] = p.map((v) => Math.min(Math.max(v, 0), cap));
    const res = kalmanFilter(ys, tvpSpec(s2e, t2a, t2b), init, { burnIn: 5, ZSeq });
    return -res.logLik;
  };

  const starts: { seed: number[]; logLik: number }[] = [];
  let best: { x: number[]; fx: number; iter: number; converged: boolean } | null = null;
  for (const seed of tvpSeeds(ys)) {
    const r = nelderMead(3, seed, negLik, nmOpts);
    starts.push({ seed, logLik: -r.fx });
    if (best == null || r.fx < best.fx) best = r;
  }
  if (!best) return null;
  const [sigma2Eps, sigma2EtaAlpha, sigma2EtaBeta] = best.x;
  const res = kalmanFilter(ys, tvpSpec(sigma2Eps, sigma2EtaAlpha, sigma2EtaBeta), init, {
    burnIn: 5,
    ZSeq,
  });

  // betaAtPresentFromEnd(lag): β lọc tại phiên có-mặt thứ (present − lag) —
  // đo Δβ trên cửa sổ (cờ destabilising) mà không đụng mảng compact cũ.
  const presentIdx: number[] = [];
  for (let t = 0; t < n; t++) if (ys[t] != null) presentIdx.push(t);
  const betaAtPresentFromEnd = (lag: number): number | null => {
    const idx = presentIdx.length - 1 - Math.max(0, Math.floor(lag));
    if (idx < 0) return null;
    return res.steps[presentIdx[idx]!]?.aUpd[1] ?? null;
  };

  return {
    sigma2Eps,
    sigma2EtaAlpha,
    sigma2EtaBeta,
    logLik: res.logLik,
    alphaT: res.aFinal[0] ?? 0,
    betaT: res.aFinal[1] ?? 1,
    betaSdT: Math.sqrt(Math.max(res.PFinal[1]?.[1] ?? 0, 0)),
    betaAtPresentFromEnd,
    n,
    presentPairs,
    burnIn: 5,
    converged: best.converged,
    iter: best.iter,
    starts,
  };
}

/** Kết quả phân tách rủi ro thị trường vs idiosyncratic (SS-5 ứng dụng 2). */
export interface BetaDecomposition {
  /** Tỉ lệ phương sai r_i giải thích bởi thành phần thị trường β²·Var(r_m). */
  systematicShare: number;
  /** 1 − systematicShare. */
  idiosyncraticShare: number;
  /** Var(r_m) cửa sổ (đo trên cặp dùng được). */
  marketVar: number;
  /** Var(r_i) cửa sổ. */
  symbolVar: number;
}

/** Phân tách Var(r_i) ≈ β_T²·Var(r_m) + σ²ε (φễu steady-state, β_T lọc cuối). */
export function betaDecompose(
  fit: TvpFit,
  y: (number | null)[],
  x: (number | null)[]
): BetaDecomposition {
  const pairs = usablePairs(y, x);
  const mVar = presentVar(nanToNull(pairs.x));
  const sVar = presentVar(nanToNull(pairs.y));
  const systematic = fit.betaT * fit.betaT * mVar;
  const total = systematic + Math.max(fit.sigma2Eps, 0);
  return {
    systematicShare: total > 0 ? Math.min(1, systematic / total) : 0,
    idiosyncraticShare: total > 0 ? Math.max(0, 1 - systematic / total) : 1,
    marketVar: mVar,
    symbolVar: sVar,
  };
}

/** Cờ destabilising (SS-5 ứng dụng 3): Var(β) phình hoặc β dịch nhanh. */
export function betaDestabilising(
  fit: TvpFit,
  opts: { sdThreshold?: number; deltaThreshold?: number; deltaLag?: number } = {}
): { flagged: boolean; reasons: string[] } {
  const sdThreshold = opts.sdThreshold ?? 0.5;
  const deltaThreshold = opts.deltaThreshold ?? 1;
  const deltaLag = opts.deltaLag ?? 60;
  const reasons: string[] = [];
  if (fit.betaSdT >= sdThreshold) {
    reasons.push(`√Var(β_T) ${fit.betaSdT.toFixed(2)} ≥ ${sdThreshold} — β không chắc`);
  }
  const betaPast = fit.betaAtPresentFromEnd(deltaLag);
  if (betaPast != null && Math.abs(fit.betaT - betaPast) >= deltaThreshold) {
    reasons.push(
      `|Δβ ${deltaLag} phiên| ${(fit.betaT - betaPast).toFixed(2)} ≥ ${deltaThreshold} — quan hệ dịch nhanh`
    );
  }
  return { flagged: reasons.length > 0, reasons };
}
