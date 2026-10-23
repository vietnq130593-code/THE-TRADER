/**
 * src/lib/ml/ss/kalman.ts — BỘ LỌC KALMAN ĐA BIẾN TỐI THIỂU (STATE_SPACE_BLUEPRINT Phần IV quy tắc 1).
 *
 * Dạng không gian trạng thái (Durbin & Koopman 2012, ch. 3 — Phụ lục A blueprint):
 *   y_t = Z_t·α_t + ε_t,          ε_t ~ N(0, H_t)      (quan sát — H vô hướng)
 *   α_{t+1} = T_t·α_t + R_t·η_t,  η_t ~ N(0, Q_t)      (trạng thái)
 *
 * Toán lõi đúng nguyên văn Phụ lục A:
 *   v_t = y_t − Z·a_{t|t−1} · F_t = Z·P_{t|t−1}·Z' + H · K_t = P_{t|t−1}·Z'/F_t
 *   a_{t|t} = a_{t|t−1} + K·v · P_{t|t} = P_{t|t−1} − K·F·K'
 *   a_{t+1|t} = T·a_{t|t} · P_{t+1|t} = T·P_{t|t}·T' + R·Q·R'
 *   y_t THIẾU (null) ⇒ BỎ 4 dòng cập nhật (chỉ chạy 2 dòng dự báo) — P phình
 *   tự nhiên (SS-3 · ch. 5 — không bịa số, không bỏ dòng).
 *   ℓ = −½ Σ [ln(2πF_t) + v_t²/F_t]   (prediction error decomposition)
 *   Dự báo h bước: lặp a,P dự báo; Var(ŷ) = Z·P_{t+h|t}·Z' + H (ĐỆ QUY —
 *   tránh công thức đóng như blueprint yêu cầu).
 *
 * Smoother RTS (ch. 4) — CHỈ cho audit/forensic (SS-8 Phase 2), SAC ĐỎ PIT
 * (Phần IV quy tắc 2): smoothed quantities KHÔNG BAO GIỜ đi vào
 * train-set/feature/evidence tại thời điểm t:
 *   α̂_{t|T} = a_{t|t−1} + P_{t|t−1}·r_{t−1}
 *   r_{t−1} = Z_t'F_t^{−1}v_t + L_t'r_t · L_t = T_t(I − K_tZ_t) · r_T = 0
 *   (y_t thiếu ⇒ K_t = 0 ⇒ L_t = T_t — r đi qua không đổi thành phần cập nhật)
 *
 * Pure function, 0 DB, 0 dependency ngoài — deterministic (nhân bản triết lý
 * train v17/v18). Ma trận nhỏ (m ≤ 2 trong mọi model Phase 1) — cài trực tiếp
 * number[][], không cần thư viện đại số.
 */

/** Đặc tả model trạng thái (hệ số cố định theo thời gian — đủ cho Phase 1). */
export interface KalmanSpec {
  /** m×m — ma trận chuyển trạng thái T. */
  T: number[][];
  /** m — vector hàng quan sát Z. */
  Z: number[];
  /** m×r — bộ chọn nhiễu trạng thái R. */
  R: number[][];
  /** r×r — hiệp phương sai nhiễu trạng thái Q. */
  Q: number[][];
  /** Phương sai nhiễu quan sát H (quan sát vô hướng). */
  H: number;
}

/** Khởi tạo filter: a₁/P₁ (theo sơ đồ Phụ lục A — caller tính). */
export interface KalmanInit {
  a: number[];
  P: number[][];
}

/** Một bước lọc — giữ đủ cho audit + diag (innovation chuẩn hoá e = v/√F). */
export interface KalmanStep {
  /** Chỉ số quan sát (0-based trong mảng đầu vào). */
  t: number;
  /** Quan sát — null = thiếu (skip-update, ch. 5). */
  y: number | null;
  /** Innovation v_t (null khi y thiếu). */
  v: number | null;
  /** Phương sai innovation F_t (null khi y thiếu). */
  F: number | null;
  /** Innovation chuẩn hoá e_t = v/√F — thước "độ ngạc nhiên" SS-7. */
  e: number | null;
  /** True khi F degenerate (P triệt để + H=0 — nghiệm biên F4): K=0,
  * smoother/aux phải coi như KHÔNG có cập nhật (F-177-4 Task 177). */
  degenerate?: boolean;
  aPred: number[];
  PPred: number[][];
  aUpd: number[];
  PUpd: number[][];
}

export interface KalmanFilterResult {
  /** log-likelihood kể từ sau burn-in (điểm burn-in đầu chuỗi chưa ổn định — Phụ lục A). */
  logLik: number;
  steps: KalmanStep[];
  /** Trạng thái lọc cuối (dùng làm gốc dự báo — PIT an toàn: E(α_T | y_1..T)). */
  aFinal: number[];
  PFinal: number[][];
}

/* ─────────────── Ma trận nhỏ (m, r ≤ 2) — inline, không dependency ─────────────── */

function matVec(A: number[][], x: number[]): number[] {
  return A.map((row) => row.reduce((s, a, j) => s + a * x[j], 0));
}

function matMul(A: number[][], B: number[][]): number[][] {
  const n = A.length;
  const m = B[0].length;
  const k = B.length;
  const out: number[][] = Array.from({ length: n }, () => Array(m).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      let s = 0;
      for (let a = 0; a < k; a++) s += A[i][a] * B[a][j];
      out[i][j] = s;
    }
  }
  return out;
}

function matT(A: number[][]): number[][] {
  return A[0].map((_, j) => A.map((row) => row[j]));
}

/** Symmetrise (P + P')/2 — chống trôi bất đối xứng dấu phẩy động qua chuỗi dài. */
function symmetrise(P: number[][]): number[][] {
  const n = P.length;
  const out: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const v = 0.5 * (P[i][j] + P[j][i]);
      out[i][j] = v;
      out[j][i] = v;
    }
  }
  return out;
}

/**
 * Chạy filter trên chuỗi quan sát (null = thiếu — SS-3 skip-update).
 * burnIn: bỏ m điểm quan sát CÓ MẶT ĐẦU khỏi likelihood (Phụ lục A — đoạn
 * khởi tạo xấp xỉ diffuse hữu hạn chưa ổn định; bước bị bỏ VẪN cập nhật
 * trạng thái, chỉ không đóng góp vào ℓ).
 * ZSeq (Task 178 — SS-5 TVP ch. 8 + SS-9 seasonal dummy): Z_t đổi theo
 * bước — truyền mảng cùng độ dài ys; thiếu phần tử → dùng spec.Z. Đường
 * không truyền giữ NGUYÊN VĂN hành vi cũ (regression p176/p178).
 */
export function kalmanFilter(
  ys: (number | null)[],
  spec: KalmanSpec,
  init: KalmanInit,
  opts: { burnIn?: number; ZSeq?: number[][] } = {}
): KalmanFilterResult {
  const burnIn = Math.max(0, Math.floor(opts.burnIn ?? 0));
  const n = ys.length;
  const steps: KalmanStep[] = [];
  let logLik = 0;
  let aPred = init.a.slice();
  let PPred = symmetrise(init.P);
  let aUpd = aPred.slice();
  let PUpd = PPred.map((r) => r.slice());
  let seen = 0; // số quan sát CÓ MẶT (burn-in đếm theo quan sát, không theo index)

  for (let t = 0; t < n; t++) {
    const y = ys[t];
    if (y == null || !Number.isFinite(y)) {
      // SS-3 (ch. 5): quan sát thiếu ⇒ bỏ cập nhật — trạng thái trôi theo T,
      // P phình đúng lượng bất định tích luỹ. KHÔNG bịa số, KHÔNG bỏ dòng.
      aUpd = aPred.slice();
      PUpd = PPred.map((r) => r.slice());
      steps.push({
        t, y: null, v: null, F: null, e: null,
        aPred: aPred.slice(), PPred: PPred.map((r) => r.slice()),
        aUpd: aUpd.slice(), PUpd: PUpd.map((r) => r.slice()),
      });
    } else {
      const Zt = opts.ZSeq && opts.ZSeq[t] ? opts.ZSeq[t]! : spec.Z;
      const zA = Zt.reduce((s, z, i) => s + z * aPred[i], 0);
      const v = y - zA;
      // F = Z·P·Z' + H
      const zPz = Zt.reduce(
        (s, z, i) => s + z * Zt.reduce((s2, z2, j) => s2 + z2 * PPred[i][j], 0),
        0
      );
      const F = zPz + spec.H;
      const Fsafe = F > 0 && Number.isFinite(F) ? F : Number.MIN_VALUE;
      if (Fsafe === Number.MIN_VALUE) {
        // F degenerate (P triệt để + H = 0 — model rút gọn biên hợp lệ F4):
        // K = 0 (không cập nhật), e cờ khổng lồ để SS-7 tự nhìn thấy.
        aUpd = aPred.slice();
        PUpd = PPred.map((r) => r.slice());
        const e = Math.sign(v) * 1e6;
        seen++;
        if (seen > burnIn) logLik += -0.5 * (Math.log(2 * Math.PI * Fsafe) + (v * v) / Fsafe);
        steps.push({
          t, y, v, F: Fsafe, e, degenerate: true,
          aPred: aPred.slice(), PPred: PPred.map((r) => r.slice()),
          aUpd: aUpd.slice(), PUpd: PUpd.map((r) => r.slice()),
        });
      } else {
        // K = P·Z'/F (m×1)
        const PZ = PPred.map((row) => row.reduce((s, p, j) => s + p * Zt[j], 0));
        aUpd = aPred.map((a, i) => a + (PZ[i] / Fsafe) * v);
        // P − K·F·K' ≡ P − (PZ·PZ')/F (dạng ổn định số học — Joseph rút gọn)
        PUpd = symmetrise(PPred.map((row, i) => row.map((p, j) => p - (PZ[i] * PZ[j]) / Fsafe)));
        const e = v / Math.sqrt(Fsafe);
        seen++;
        if (seen > burnIn) logLik += -0.5 * (Math.log(2 * Math.PI * Fsafe) + (v * v) / Fsafe);
        steps.push({
          t, y, v, F: Fsafe, e,
          aPred: aPred.slice(), PPred: PPred.map((r) => r.slice()),
          aUpd: aUpd.slice(), PUpd: PUpd.map((r) => r.slice()),
        });
      }
    }
    // Dự báo bước tiếp: a' = T·a · P' = T·P·T' + R·Q·R'
    aPred = matVec(spec.T, aUpd);
    const TPT = matMul(matMul(spec.T, PUpd), matT(spec.T));
    const RQR = matMul(matMul(spec.R, spec.Q), matT(spec.R));
    PPred = symmetrise(TPT.map((row, i) => row.map((p, j) => p + RQR[i][j])));
  }

  return { logLik, steps, aFinal: aUpd, PFinal: PUpd };
}

/** Một điểm dự báo h bước từ trạng thái (a, P). */
export interface KalmanForecastPoint {
  /** E(ŷ_{t+h}|t). */
  mean: number;
  /** Var(ŷ_{t+h}|t) = Z·P_{t+h|t}·Z' + H. */
  variance: number;
  aNext: number[];
  PNext: number[][];
}

/** Dự báo h = 1..horizon bằng đệ quy a,P (PIT an toàn — chỉ dùng dữ liệu ≤ t). */
export function kalmanForecast(
  spec: KalmanSpec,
  a: number[],
  P: number[][],
  horizon: number
): KalmanForecastPoint[] {
  const out: KalmanForecastPoint[] = [];
  let aCur = a.slice();
  let PCur = symmetrise(P);
  for (let h = 1; h <= horizon; h++) {
    const aPred = matVec(spec.T, aCur);
    const TPT = matMul(matMul(spec.T, PCur), matT(spec.T));
    const RQR = matMul(matMul(spec.R, spec.Q), matT(spec.R));
    const PPred = symmetrise(TPT.map((row, i) => row.map((p, j) => p + RQR[i][j])));
    const mean = spec.Z.reduce((s, z, i) => s + z * aPred[i], 0);
    const variance =
      spec.Z.reduce(
        (s, z, i) => s + z * spec.Z.reduce((s2, z2, j) => s2 + z2 * PPred[i][j], 0),
        0
      ) + spec.H;
    out.push({ mean, variance: Math.max(variance, 0), aNext: aPred, PNext: PPred });
    aCur = aPred;
    PCur = PPred;
  }
  return out;
}

/**
 * Trạng thái smoothed α̂_{t|T} (RTS backward — Phụ lục A). AUDIT-ONLY:
 * SAC ĐỎ PIT quy tắc 2 — không đi vào train/feature/evidence tại t.
 * Kiểm chứng khó (smoke test p176 T5d): α̂_{T|T} == a_{T|T} lọc (r_T = 0).
 */
export function kalmanSmoother(spec: KalmanSpec, steps: KalmanStep[]): number[][] {
  const n = steps.length;
  if (n === 0) return [];
  const m = spec.T.length;
  const alpha: number[][] = Array.from({ length: n }, () => Array(m).fill(0));
  let r: number[] = Array(m).fill(0); // r_T = 0
  for (let t = n - 1; t >= 0; t--) {
    const s = steps[t];
    // r_{t−1} = Z_t'F_t^{−1}v_t + L_t'·r_t · L_t = T(I − K_tZ_t)
    let rPrev: number[];
    if (s.v != null && s.F != null && s.F > 0 && !s.degenerate) {
      // Capture local — narrowing không sống sót trong closure (tsc strict)
      const vT = s.v;
      const FT = s.F;
      const PZ = s.PPred.map((row) => row.reduce((acc, p, j) => acc + p * spec.Z[j], 0));
      const L = matMul(
        spec.T,
        spec.T.map((row, i) =>
          row.map((_, j) => (i === j ? 1 : 0) - (PZ[i] / FT) * spec.Z[j])
        )
      );
      const ZFv = spec.Z.map((z) => (z * vT) / FT);
      const LTr = matVec(matT(L), r);
      rPrev = ZFv.map((zf, i) => zf + LTr[i]);
    } else {
      // y thiếu HOẶC F degenerate (F-177-4 Task 177 — K_t = 0 ⇒ L_t = T_t ⇒
      // KHÔNG chia F ~ MIN_VALUE như trước; r đi qua không đổi thành phần cập nhật)
      rPrev = matVec(matT(spec.T), r);
    }
    // α̂_{t|T} = a_{t|t−1} + P_{t|t−1}·r_{t−1}
    alpha[t] = s.aPred.map((a, i) => a + s.PPred[i].reduce((acc, p, j) => acc + p * rPrev[j], 0));
    r = rPrev;
  }
  return alpha;
}

/* ───────────── Task 178 · SS-8 — AUXILIARY RESIDUALS (ch. 9) ───────────── */

/** Phần dư phụ trợ chuẩn hoá một bước (SS-8 — Durbin & Koopman 2012 ch. 9). */
export interface AuxResidual {
  /** Chỉ số bước (0-based — caller map về ngày). */
  t: number;
  /** ε̂_t = E(ε_t | y_1..T) — sốc QUAN SÁT (outlier giá). */
  uHat: number;
  /** √Var(ε̂_t) — chuẩn hoá (null khi ≤0/NaN: bỏ cờ trung thực). */
  uSd: number | null;
  /** η̂_t từng chiều trạng thái (chi 0 = sốc LEVEL · chi 1 = sốc TREND). */
  etaHat: number[];
  /** √diag Var(η̂_t) từng chiều (0 = sentinel ≤0 → caller bỏ cờ chiều đó). */
  etaSd: number[];
  /** Quan sát có mặt + F lành ở bước này không (false ⇒ chỉ có state residual). */
  observed: boolean;
}

export interface AuxResidualsResult {
  aux: AuxResidual[];
  /** Số lần phương sai chuẩn hoá ≤0 bị bỏ (degenerate — đếm trung thực). */
  skippedVariance: number;
}

/**
 * kalmanAuxResiduals — SMOOTHED DISTURBANCE RESIDUALS (SS-8 · ch. 4.4.4 + 9):
 *   ε̂_t = H(F_t^{-1}v_t − K_t'·r_t) · Var(ε̂_t) = H − Z(P − P·N_{t−1}·P)Z'
 *   η̂_t = Q·R'·r_t                    · Var(η̂_t) = Q·R'·N_t·R·Q
 * với r_t/N_t từ backward pass (r_T = N_T = 0 · L_t = T(I − K_tZ_t)):
 *   r_{t−1} = Z'F^{-1}v + L'r_t · N_{t−1} = Z'F^{-1}Z + L'N_tL
 * (y thiếu hoặc F degenerate ⇒ K=0 ⇒ L=T — r/N đi qua thuần thành phần cập
 * nhật; ε̂_t chỉ tính khi quan sát có mặt + F lành.) Var(ε̂) kiểm chứng chéo
 * với dạng đại số H²(F^{-1}+K'N_tK) ở p178 T-P2-4 (hai dạng tương đương —
 * bảo hiểm chống sai ký hiệu; suy ra bằng law-of-total-variance + kiểm biên
 * t=T: Var(ε̂_T) = H²/F khớp hậu nghiệm lọc 1 bước). AUDIT-ONLY (quy tắc 2).
 */
export function kalmanAuxResiduals(
  spec: KalmanSpec,
  steps: KalmanStep[],
  opts: { ZSeq?: number[][] } = {}
): AuxResidualsResult {
  const n = steps.length;
  if (n === 0) return { aux: [], skippedVariance: 0 };
  const m = spec.T.length;
  const aux: AuxResidual[] = [];
  let skippedVariance = 0;
  let r: number[] = Array(m).fill(0); // r_T = 0
  let N: number[][] = Array.from({ length: m }, () => Array(m).fill(0)); // N_T = 0
  const eye = (k: number): number[][] =>
    Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j ? 1 : 0)));

  for (let t = n - 1; t >= 0; t--) {
    const s = steps[t];
    const Zt = opts.ZSeq && opts.ZSeq[t] ? opts.ZSeq[t]! : spec.Z;
    const healthy = s.v != null && s.F != null && s.F > 0 && !s.degenerate;

    // η̂_t = Q·R'·r_t (r_t = giá trị TRƯỚC contribution bước t) — luôn tính
    // được (state disturbance tồn tại kể cả ngày y thiếu — tương thích SS-3).
    const Rr = matVec(matT(spec.R), r); // R'·r_t (r×1)
    const etaHat = matVec(spec.Q, Rr); // Q·R'·r_t (r×1)
    // Var(η̂_t) = Q·R'·N_t·R·Q — chặn âm từng chiều (trung thực, không bịa)
    const RN = matMul(matT(spec.R), N);
    const RNR = matMul(RN, spec.R);
    const QRNR = matMul(matMul(spec.Q, RNR), spec.Q);
    const etaSd: number[] = [];
    for (let j = 0; j < m; j++) {
      const v = QRNR[j]?.[j] ?? -1;
      if (v > 0 && Number.isFinite(v)) etaSd.push(Math.sqrt(v));
      else {
        etaSd.push(0); // sentinel ≤0 → caller bỏ cờ chiều này
        skippedVariance++;
      }
    }

    let uHat = 0;
    let uSd: number | null = null;
    let rPrev: number[];
    let NPrev: number[][];
    if (healthy) {
      const F = s.F!;
      const PZ = s.PPred.map((row) => row.reduce((acc, p, j) => acc + p * Zt[j], 0));
      const K = PZ.map((pz) => pz / F);
      // ε̂_t = H(F^{-1}v − K'r_t)
      const Kr = K.reduce((acc, k, i) => acc + k * r[i], 0);
      uHat = spec.H * (s.v! / F - Kr);
      // L = T(I − KZ)
      const L = matMul(
        spec.T,
        eye(m).map((row, i) => row.map((c, j) => c - K[i]! * Zt[j]))
      );
      const LTr = matVec(matT(L), r);
      const ZFv = Zt.map((z) => (z * s.v!) / F);
      rPrev = ZFv.map((zf, i) => zf + LTr[i]);
      // N_{t−1} = Z'F^{-1}Z + L'N_tL
      const ZFZ = Zt.map((zi) => Zt.map((zj) => (zi * zj) / F));
      const LNL = matMul(matMul(matT(L), N), L);
      NPrev = symmetrise(ZFZ.map((row, i) => row.map((c, j) => c + LNL[i]![j]!)));
      // Var(ε̂_t) = H − Z(P − P·N_{t−1}·P)Z' (NPrev VỪA tính ở bước này)
      const PNP = matMul(matMul(s.PPred, NPrev), s.PPred);
      const Pdiff = symmetrise(s.PPred.map((row, i) => row.map((p, j) => p - PNP[i][j])));
      const zPz = Zt.reduce(
        (acc, z, i) => acc + z * Zt.reduce((s2, z2, j) => s2 + z2 * Pdiff[i][j], 0),
        0
      );
      const uVar = spec.H - zPz;
      if (uVar > 0 && Number.isFinite(uVar)) uSd = Math.sqrt(uVar);
      else skippedVariance++;
    } else {
      // y thiếu / F degenerate: K=0 ⇒ L=T ⇒ r,N đi qua thuần túy
      rPrev = matVec(matT(spec.T), r);
      NPrev = symmetrise(matMul(matMul(matT(spec.T), N), spec.T));
    }
    aux.push({ t, uHat, uSd, etaHat, etaSd, observed: healthy });
    r = rPrev;
    N = NPrev;
  }
  aux.reverse(); // tăng dần theo t — dễ đọc audit
  return { aux, skippedVariance };
}
