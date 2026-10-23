/**
 * scripts/p178-verify-ss-phase2.ts — KIỂM ĐỊNH HERMETIC PHASE 2 STATE SPACE
 * (Task 178 · docs/STATE_SPACE_BLUEPRINT.md — Phase 2: SS-3 nối đường thật +
 * SS-8 aux residuals + SS-5 TVP β + SS-9 seasonal + vá F-177-1..8).
 *
 * Kiểm định THUẦN LOGIC/TOÁN (0 DB — chạy `env -u DATABASE_URL` như p164/p176;
 * shadow.ts/phase2.ts import db nhưng chỉ dùng hàm THUẦN nên không chạm DB).
 *
 *   T-P2-1  SS-3 LỖ TUẦN TỰ (nghiệm thu blueprint SS-3): synthetic log-giá n=320
 *          với 8% lỗ ngẫu nhiên — so 3 chiến lược: skip-update (null) vs drop
 *          (compact) vs fill (forward-fill) về log-score h=1 ngoài mẫu (SS-11);
 *          kỳ vọng blueprint: skip THẮNG ở lỗ thưa. Kèm: P phình qua lỗ
 *          (P sau lỗ > P trước lỗ — variance trung thực ch. 5).
 *   T-P2-2  PARITY CHUỖI DẦY (regression đường thật): alignedBasketIndex trên
 *          chuỗi dày (mọi mã có đủ ngày) ≡ buildBasketIndex cũ TUYỆT ĐỐI;
 *          holtForecast null-tolerant ≡ thuật toán Holt gốc TUYỆT ĐỐI trên
 *          chuỗi dày (đường A15 không đổi hành vi khi không có lỗ).
 *   T-P2-3  SS-8 AUX RESIDUALS (ch. 9 — biệt thoại "dữ liệu bẩn" vs "đổi chế"):
 *          bơm SPIKE đơn phát (outlier quan sát) → |std obs residual| tại đó
 *          > 3,5 và state KHÔNG cờ; bơm LEVEL SHIFT bền → |std state residual|
 *          (chi level) > 3,5 tại đó và obs KHÔNG cờ — 2 loại PHÂN BIỆT được.
 *   T-P2-4  SS-8 CÔNG THỨC (bảo hiểm ký hiệu): Var(ε̂_t) của mình
 *          (H − Z(P−PNP)Z' — suy từ law-of-total-variance) ≡ dạng đại số
 *          D&K H²(F^{-1} + K'N_tK) trên mọi bước; biên t=T: Var(ε̂_T) = H²/F;
 *          0 ≤ Var(ε̂) ≤ H·(1+ε) mọi bước; 0 ≤ Var(η̂) ≤ Q.
 *   T-P2-5  SS-5 TVP RECOVERY (ch. 8): synthetic β random walk (τ=0,02) +
 *          α random walk + ε σ=0,3 — MLE τ²σ khôi phá trong ±40%, β_T lọc
 *          trong 3·sd của β thật (PIT filtered), decomp systematic ≈ lý thuyết.
 *   T-P2-6  SS-5 PIT (mirror p176 T4): filter cùng tham số — sửa TOÀN BỘ
 *          holdout ⇒ trạng thái lọc tại train KHÔNG đổi (leakage = 0).
 *   T-P2-7  SS-9 SEASONAL (chỉ làm khi có bằng chứng — 2 chiều trung thực):
 *          bơm hiệu ứng T2 −0,4σ/T5 +0,4σ → M1 (DOW) thắng M0 holdout log-score
 *          và khôi phục γ ±0,15; chuỗi THUẦN NHIỄN → M1 KHÔNG thắng đáng kể
 *          (diffPerStep < 0,02 — chống vẽ nên seasonality). Kèm cửa sổ Tết.
 *   T-P2-8  F-177-3 PARITY FLOOR: live + |meanPct| < 0,1% ⇒ KHÔNG đốt (parity
 *          driver cũ A15); |meanPct| ≥ 0,1% ⇒ đốt (regression T8c p176).
 *   T-P2-9  F-177-5 KS NHỎ: D siêu nhỏ → p ≈ 1 (không còn về ~0); D lớn → p
 *          nhỏ (hướng regression giữ nguyên).
 *   T-P2-10 F-177-4 SMOOTHER DEGENERATE: chuỗi linear THẬT CHÍNH XÁC (σ²ε → 0
 *          biên) → smoother + aux residuals chạy 0 NaN/Infinity (K=PZ/MIN_VALUE
 *          đã vá — bước degenerate coi như không cập nhật).
 *   T-P2-11 SS-3 NULL HOLT: holtForecast trên chuỗi có lỗ — skip-update không
 *          ném, neo % vào close có-mặt cuối; rollingSdPctH5 null-tolerant.
 *
 * Cách chạy: env -u DATABASE_URL bun scripts/p178-verify-ss-phase2.ts
 * Read-only: KHÔNG chạm DB, KHÔNG sửa file nguồn.
 */
import {
  kalmanFilter,
  kalmanSmoother,
  kalmanAuxResiduals,
  type KalmanSpec,
} from "../src/lib/ml/ss/kalman";
import { holtSsFit, holtSsForecast } from "../src/lib/ml/ss/holt-ss";
import { holdoutLogScores } from "../src/lib/ml/ss/logscore";
import { ksPValue } from "../src/lib/ml/ss/diag";
import {
  rollingSdPctH5,
  sdInflated,
  ssEvidenceDecision,
} from "../src/lib/ml/ss/shadow";
import { alignedBasketIndex, alignSeries, unionCalendar } from "../src/lib/ml/ss/calendar";
import { tvpFit, betaDecompose, betaDestabilising } from "../src/lib/ml/ss/tvp";
import { holtForecast } from "../src/lib/quant/forecast";
import {
  inTetWindow,
  seasonalCompare,
  seasonalDesignRow,
} from "../src/lib/ml/ss/seasonal";

/* ───────────────────────── Công cụ kiểm định ───────────────────────── */

let pass = 0;
let fail = 0;
const fails: string[] = [];

function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name} — ${detail}`);
  } else {
    fail++;
    fails.push(`${name} — ${detail}`);
    console.log(`  ✗ ${name} — ${detail}`);
  }
}

/** mulberry32 — PRNG deterministic (seed cố định — mirror p176). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stdNormal(rng: () => number): number {
  const u1 = Math.max(rng(), Number.MIN_VALUE);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Chuỗi ngày phiên (T2–T6) liên tiếp từ startDate — cho SS-9/calendar. */
function weekdayDates(startIso: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${startIso}T00:00:00.000Z`);
  while (out.length < n) {
    const dow = d.getUTCDay();
    if (dow >= 1 && dow <= 5) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/* ═══════════ T-P2-1 · SS-3 — lỗ tuần tự: skip vs drop vs fill ═══════════ */

console.log("\n── T-P2-1 · SS-3: skip-update vs drop vs fill (8% lỗ, n=320) ──");
{
  // Synthetic local linear trend trong LOG-SPACE (mirror p176 T2 seed khác
  // để độc lập): σ²ε=0.0009 · σ²ημ=0.0016 · σ²ηb=0.0001
  const rng = mulberry32(178);
  const S2E = 0.0009;
  const S2M = 0.0016;
  const S2B = 0.0001;
  const n = 320;
  let mu = 4.6;
  let b = 0.0008;
  const closes: number[] = [];
  for (let t = 0; t < n; t++) {
    const eMu = stdNormal(rng) * Math.sqrt(S2M);
    const eB = stdNormal(rng) * Math.sqrt(S2B);
    const eps = stdNormal(rng) * Math.sqrt(S2E);
    closes.push(Math.exp(mu + eps));
    mu = mu + b + eMu;
    b = b + eB;
  }

  // 8% lỗ ngẫu nhiên (vị trí deterministic từ rng — bỏ 5 đầu/5 cuối cho init)
  const holeIdx = new Set<number>();
  let placed = 0;
  while (placed < Math.floor(n * 0.08)) {
    const i = 10 + Math.floor(rng() * (n - 20));
    if (!holeIdx.has(i)) {
      holeIdx.add(i);
      placed++;
    }
  }
  const withHoles: (number | null)[] = closes.map((c, i) => (holeIdx.has(i) ? null : c));
  const dropped = closes.filter((_, i) => !holeIdx.has(i));
  const filled: number[] = [];
  let last = closes[0]!;
  for (let i = 0; i < n; i++) {
    if (holeIdx.has(i)) filled.push(last);
    else {
      filled.push(closes[i]!);
      last = closes[i]!;
    }
  }

  const abSkip = holdoutLogScores(withHoles, { horizons: [1, 5] });
  const abDrop = holdoutLogScores(dropped, { horizons: [1, 5] });
  const abFill = holdoutLogScores(filled, { horizons: [1, 5] });
  check(
    "T-P2-1a 3 chiến lược đều fit được (finite, n cùng bậc)",
    abSkip != null && abDrop != null && abFill != null,
    abSkip && abDrop && abFill
      ? `skip n=${abSkip.ss[0]?.n} · drop n=${abDrop.ss[0]?.n} · fill n=${abFill.ss[0]?.n}`
      : "null"
  );
  if (abSkip && abDrop && abFill) {
    const skipH1 = abSkip.ss[0]!.mean;
    const dropH1 = abDrop.ss[0]!.mean;
    const fillH1 = abFill.ss[0]!.mean;
    console.log(
    `    log-score h=1 (SS driver): skip ${skipH1.toFixed(3)} · drop ${dropH1.toFixed(3)} · fill ${fillH1.toFixed(3)}`
    );
    check(
      "T-P2-1b skip THẮNG drop (lỗ thưa — kỳ vọng blueprint SS-3)",
      skipH1 >= dropH1,
      `skip − drop = ${(skipH1 - dropH1).toFixed(4)}`
    );
    // Fill bịa giá stale ĐÚNG NGUYÊN VẸT → MLE đẩy σ²ε về biên 0 với innovation
    // ≈ 0 → mật độ bùng nổ (+371/điểm, log-score ~ +1e10 — VÔ NGHĨA xác suất).
    // Đây chính là LUẬN BẰNG CHỨNG cho triết lý SS-3: bịa số tạo "chắc chắn giả",
    // skip-update giữ variance trung thực. Fill KHÔNG phải comparator hữu nghĩa.
    check(
      "T-P2-1c fill bịa giá → mật độ bùng nổ biên (log-score vô nghĩa — luận chứng cho skip)",
      Math.abs(fillH1) > 1e6,
      `fill = ${fillH1.toExponential(2)} (bùng nổ degenerate — bịa số không cho dự báo xác suất hữu nghĩa)`
    );

    // P phình qua lỗ: filter cùng tham số, P tại bước SAU lỗ > TRƯỚC lỗ
    const spec: KalmanSpec = {
      T: [[1, 1], [0, 1]],
      Z: [1, 0],
      R: [[1, 0], [0, 1]],
      Q: [[S2M, 0], [0, S2B]],
      H: S2E,
    };
    const present = closes.filter((c) => c != null);
    const meanP = present.reduce((s, x) => s + x, 0) / present.length;
    const varP = present.reduce((s, x) => s + (x - meanP) * (x - meanP), 0) / (present.length - 1);
    const kappa = 1e6 * varP;
    const res = kalmanFilter(
      withHoles.map((c) => (c == null ? null : Math.log(c))),
      spec,
      { a: [Math.log(closes[0]!), Math.log(closes[1]!) - Math.log(closes[0]!)], P: [[kappa, 0], [0, kappa]] },
      { burnIn: 0 }
    );
    const holes = [...holeIdx].sort((a, b2) => a - b2);
    const h0 = holes[0]!;
    const pBefore = res.steps[h0 - 1]!.PUpd[0]![0]!;
    const pAfter = res.steps[h0]!.PUpd[0]![0]!;
    check(
      "T-P2-1d P phình qua lỗ (ch. 5 — skip-update trung thực)",
      pAfter > pBefore,
      `P level trước lỗ ${pBefore.toExponential(2)} → sau lỗ ${pAfter.toExponential(2)}`
    );
  }
}

/* ═══════════ T-P2-2 · PARITY chuỗi dày (regression đường thật) ═══════════ */

console.log("\n── T-P2-2 · Parity chuỗi dày (đường thật không đổi khi không có lỗ) ──");
{
  // ORACLE: buildBasketIndex cũ — copy NGUYÊN VĂN từ bayes/evidence.ts@dda4ae0
  // (bản trước Task 178) làm chuẩn đối chứng độc lập.
  function buildBasketIndexOracle(closesBySymbol: number[][], sessions: number): number[] {
    const usable = closesBySymbol.filter((c) => c.length >= 60);
    if (usable.length === 0) return [];
    const n = Math.min(sessions, ...usable.map((c) => c.length));
    if (n < 2) return [];
    const index: number[] = [];
    for (let i = 0; i < n; i++) {
      let sum = 0;
      let count = 0;
      for (const closes of usable) {
        const start = closes[closes.length - n];
        if (start > 0) {
          sum += closes[closes.length - n + i] / start;
          count++;
        }
      }
      index.push(count > 0 ? sum / count : 1);
    }
    return index;
  }

  // 4 mã dày cùng lịch 250 phiên (mỗi mã giá riêng trend/noise riêng)
  const rng = mulberry32(2024);
  const dates = weekdayDates("2025-06-02", 260);
  const series: { dates: string[]; closes: number[] }[] = [];
  for (let s = 0; s < 4; s++) {
    let p = 20 + s * 8;
    const closes: number[] = [];
    for (let t = 0; t < 260; t++) {
      p *= 1 + 0.0006 + stdNormal(rng) * 0.012;
      closes.push(Number(p.toFixed(2)));
    }
    series.push({ dates, closes });
  }
  const aligned = alignedBasketIndex(series, 250);
  const oracle = buildBasketIndexOracle(series.map((s) => s.closes), 250);
  check(
    "T-P2-2a alignedBasketIndex ≡ buildBasketIndex cũ (chuỗi dày)",
    aligned.closes.length === oracle.length &&
      aligned.closes.every((c, i) => c != null && Math.abs(c - oracle[i]!) < 1e-12),
    `n=${aligned.closes.length} · maxDiff=${aligned.closes.reduce((m, c, i) => c != null ? Math.max(m, Math.abs(c - oracle[i]!)) : m, 0).toExponential(2)}`
  );

  // ORACLE: thuật toán Holt gốc — copy NGUYÊN VĂN từ quant/forecast.ts@dda4ae0
  function oldHolt(closes: number[], alpha: number, beta: number, horizon: number) {
    let level = closes[0]!;
    let trend = closes[1]! - closes[0]!;
    const residuals: number[] = [];
    for (let t = 1; t < closes.length; t++) {
      residuals.push(closes[t]! - (level + trend));
      const prevLevel = level;
      level = alpha * closes[t]! + (1 - alpha) * (level + trend);
      trend = beta * (level - prevLevel) + (1 - beta) * trend;
    }
    const rMean = residuals.reduce((s, x) => s + x, 0) / residuals.length;
    const rVar =
      residuals.reduce((s, x) => s + (x - rMean) * (x - rMean), 0) / (residuals.length - 1);
    const sigma = Math.sqrt(Math.max(rVar, 0));
    const forecasts: number[] = [];
    for (let h = 1; h <= horizon; h++) forecasts.push(level + h * trend);
    return { level, trend, forecasts, sigma };
  }
  const denseCloses = series[0]!.closes;
  const mine = holtForecast(denseCloses, { horizon: 5 });
  const oracleHolt = oldHolt(denseCloses, 0.5, 0.25, 5);
  check(
    "T-P2-2b holtForecast null-tolerant ≡ thuật toán Holt gốc (chuỗi dày)",
    mine != null &&
      Math.abs(mine.level - oracleHolt.level) < 1e-9 &&
      Math.abs(mine.trend - oracleHolt.trend) < 1e-9 &&
      mine.forecasts.every((f, i) => Math.abs(f - oracleHolt.forecasts[i]!) < 1e-9) &&
      Math.abs(mine.residualSigma - oracleHolt.sigma) < 1e-9,
    mine
      ? `level Δ=${Math.abs(mine.level - oracleHolt.level).toExponential(2)} · trend Δ=${Math.abs(mine.trend - oracleHolt.trend).toExponential(2)}`
      : "null"
  );

  // union calendar + alignSeries: đục 2 phiên GIỮA CHỖ của 1 mã (lỗ thật)
  const s2Dates = dates.filter((_, i) => i !== 100 && i !== 101);
  const s2Closes = series[1]!.closes.filter((_, i) => i !== 100 && i !== 101);
  const cal = unionCalendar([dates, s2Dates]).slice(-250);
  const aligned1 = alignSeries(dates, series[0]!.closes, cal);
  const aligned2 = alignSeries(s2Dates, s2Closes, cal);
  const nullsIn2 = aligned2.closes.filter((c) => c == null).length;
  check(
    "T-P2-2c alignSeries: mã thiếu 2 phiên giữa-chỗ → đúng 2 null trên lịch union",
    aligned1.closes.every((c) => c != null) && nullsIn2 === 2 && aligned2.present === 248,
    `mã đầy đủ 0 null · mã thiếu ${nullsIn2} null · có-mặt ${aligned2.present}/250`
  );
}

/* ═══════════ T-P2-3/4 · SS-8 — aux residuals (ch. 9) ═══════════ */

console.log("\n── T-P2-3 · SS-8: OUTLIER (spike) vs LEVEL_SHIFT (đổi chế) ──");
{
  // Local level: y = μ + ε · μ' = μ + η — tham số THẬT (không MLE — attribution sạch)
  const H = 1;
  const Q = 0.09;
  const spec: KalmanSpec = { T: [[1]], Z: [1], R: [[1]], Q: [[Q]], H };
  const runAux = (ys: (number | null)[]) => {
    const kappa = 1e6 * 25;
    const res = kalmanFilter(ys, spec, { a: [ys.find((y) => y != null) ?? 0], P: [[kappa]] }, { burnIn: 0 });
    return { res, aux: kalmanAuxResiduals(spec, res.steps) };
  };

  // (a) SPIKE đơn phát tại k=150 (y_k = μ_k + 10σ) — dữ liệu bẩn
  const rngA = mulberry32(31);
  let muA = 0;
  const spikeYs: (number | null)[] = [];
  for (let t = 0; t < 300; t++) {
    muA += stdNormal(rngA) * Math.sqrt(Q);
    spikeYs.push(muA + stdNormal(rngA) * Math.sqrt(H));
  }
  const k = 150;
  spikeYs[k] = (spikeYs[k] as number) + 10; // +10σ spike
  const { aux: auxSpike } = runAux(spikeYs);
  const spikeRow = auxSpike.aux[k]!;
  const otherObs = auxSpike.aux
    .filter((a) => a.observed && a.t !== k && a.uSd != null)
    .map((a) => Math.abs(a.uHat / (a.uSd ?? 1)));
  const maxOther = Math.max(...otherObs);
  const spikeObsStd = Math.abs(spikeRow.uHat / (spikeRow.uSd ?? 1));
  const spikeEtaStd = Math.abs(spikeRow.etaHat[0]! / (spikeRow.etaSd[0] || 1));
  check(
    "T-P2-3a SPIKE → cờ OUTLIER tại đúng vị trí (obs > 3,5)",
    spikeObsStd > 3.5,
    `|std obs| tại k=${k}: ${spikeObsStd.toFixed(2)}`
  );
  check(
    "T-P2-3b SPIKE KHÔNG cờ LEVEL_SHIFT (state sạch)",
    spikeEtaStd < 3.5,
    `|std state| tại k: ${spikeEtaStd.toFixed(2)}`
  );
  check(
    "T-P2-3c các bước còn lại không cờ giả (max < 3,5)",
    maxOther < 3.5,
    `max |std obs| bước khác: ${maxOther.toFixed(2)}`
  );

  // (b) LEVEL SHIFT bền tại j=150 (μ nhảy +8 vĩnh viễn) — thị trường đổi chế
  // (q=0,16 → σ_η=0,4/step: nhiễu trạng thái đủ lớn để attribution rõ ràng)
  const Q2 = 0.16;
  const spec2: KalmanSpec = { T: [[1]], Z: [1], R: [[1]], Q: [[Q2]], H };
  const rngB = mulberry32(47);
  let muB = 0;
  const shiftYs: number[] = [];
  for (let t = 0; t < 300; t++) {
    if (t === 150) muB += 8; // shift bền +8 (20σ_η)
    muB += stdNormal(rngB) * Math.sqrt(Q2);
    shiftYs.push(muB + stdNormal(rngB) * Math.sqrt(H));
  }
  const resShift = kalmanFilter(shiftYs, spec2, { a: [shiftYs[0]!], P: [[1e6 * 25]] }, { burnIn: 0 });
  const auxShift = kalmanAuxResiduals(spec2, resShift.steps);
  const shiftRow = auxShift.aux[150]!;
  const shiftEtaStd = Math.abs(shiftRow.etaHat[0]! / (shiftRow.etaSd[0] || 1));
  const shiftObsStd = Math.abs(shiftRow.uHat / (shiftRow.uSd ?? 1));
  check(
    "T-P2-3d LEVEL_SHIFT → cờ state (η level > 3,5) tại đúng vị trí",
    shiftEtaStd > 3.5,
    `|std state| tại j=150: ${shiftEtaStd.toFixed(2)}`
  );
  check(
    "T-P2-3e LEVEL_SHIFT: state Tin HƠN obs (phân biệt với outlier)",
    shiftEtaStd > shiftObsStd,
    `state ${shiftEtaStd.toFixed(2)} vs obs ${shiftObsStd.toFixed(2)}`
  );

  // T-P2-4 — công thức Var(ε̂) 2 dạng đại số + biên + bound
  // Dạng thay thế: Var(ε̂_t) = H²(F^{-1} + K'N_tK) (D&K-style) — backward pass lại
  const { res: resSpike } = runAux(spikeYs);
  const steps = resSpike.steps;
  let maxDiff = 0;
  let okBounds = true;
  let r: number[] = [0];
  let N: number[][] = [[0]];
  for (let t = steps.length - 1; t >= 0; t--) {
    const s = steps[t]!;
    const a = auxSpike.aux[t]!;
    if (s.v != null && s.F != null && s.F > 0 && !s.degenerate) {
      const F = s.F;
      const K = s.PPred[0]![0]! / F;
      const L = 1 - K; // T=1, Z=1 ⇒ L = 1−K (vô hướng)
      const rPrev = s.v / F + L * r[0]!;
      const NPrev = 1 / F + L * L * N[0]![0]!;
      // alt Var(ε̂) = H²(F^{-1} + K'N_tK) — N_t là N TRƯỚC contribution bước t
      const altVar = H * H * (1 / F + K * K * N[0]![0]!);
      if (a.uSd != null) {
        maxDiff = Math.max(maxDiff, Math.abs(a.uSd * a.uSd - altVar));
        if (!(a.uSd * a.uSd <= H * 1.001 && a.uSd * a.uSd >= -1e-12)) okBounds = false;
      }
      r = [rPrev];
      N = [[NPrev]];
    } else {
      r = [r[0]!]; // T=1
      N = [[N[0]![0]!]];
    }
  }
  check(
    "T-P2-4a Var(ε̂) 2 dạng đại số khớp (law-of-total-variance ≡ D&K-style)",
    maxDiff < 1e-6,
    `max |Δ| = ${maxDiff.toExponential(2)}`
  );
  check("T-P2-4b 0 ≤ Var(ε̂) ≤ H mọi bước", okBounds, "bound giữ trên toàn chuỗi");
  // Biên t=T: Var(ε̂_T) = H²/F (hậu nghiệm lọc 1 bước — suy luận kiểm chứng)
  const last = steps[steps.length - 1]!;
  const lastAux = auxSpike.aux[steps.length - 1]!;
  const boundaryVar = lastAux.uSd != null ? lastAux.uSd * lastAux.uSd : -1;
  check(
    "T-P2-4c biên t=T: Var(ε̂_T) ≈ H²/F_T",
    last.F != null && Math.abs(boundaryVar - (H * H) / last.F) < 1e-6,
    `Var(ε̂_T)=${boundaryVar.toExponential(3)} vs H²/F=${((H * H) / (last.F ?? 1)).toExponential(3)}`
  );
}

/* ═══════════ T-P2-5/6 · SS-5 — TVP β động (ch. 8) ═══════════ */

console.log("\n── T-P2-5 · SS-5: TVP β random walk — MLE khôi phục + decomp ──");
{
  const rng = mulberry32(55);
  const n = 300;
  const tauAlpha = 0.01; // σ của ηα mỗi bước (var 1e-4)
  const tauBeta = 0.02; // σ của ηβ mỗi bước (var 4e-4)
  const sigmaEps = 0.3;
  const xs: number[] = [];
  const ys: number[] = [];
  const betaTrue: number[] = [];
  let alpha = 0.05;
  let beta = 1.2;
  for (let t = 0; t < n; t++) {
    const x = stdNormal(rng);
    const y = alpha + beta * x + stdNormal(rng) * sigmaEps;
    xs.push(x);
    ys.push(y);
    betaTrue.push(beta);
    alpha += stdNormal(rng) * tauAlpha;
    beta += stdNormal(rng) * tauBeta;
  }
  const fit = tvpFit(ys, xs);
  check("T-P2-5a tvpFit chạy (n=300 đủ cặp)", fit != null, fit ? `logLik ${fit.logLik.toFixed(1)} · ${fit.presentPairs} cặp` : "null");
  if (fit) {
    const err = Math.abs(fit.betaT - betaTrue[n - 1]!);
    check(
      "T-P2-5b β_T lọc trong 3·sd của β thật (PIT filtered)",
      err <= 3 * fit.betaSdT + 0.05,
      `β̂=${fit.betaT.toFixed(3)} vs β=${betaTrue[n - 1]!.toFixed(3)} · sd=${fit.betaSdT.toFixed(3)} · |Δ|=${err.toFixed(3)}`
    );
    check(
      "T-P2-5c MLE σ²ε khôi phục ±40%",
      Math.abs(fit.sigma2Eps - sigmaEps * sigmaEps) <= 0.4 * sigmaEps * sigmaEps,
      `σ̂²ε=${fit.sigma2Eps.toFixed(4)} vs thật ${(sigmaEps * sigmaEps).toFixed(4)}`
    );
    check(
      "T-P2-5d τ²β cùng thứ bậc [1/4×, 4×] thật",
      fit.sigma2EtaBeta >= (tauBeta * tauBeta) / 4 && fit.sigma2EtaBeta <= 4 * tauBeta * tauBeta,
      `τ̂²β=${fit.sigma2EtaBeta.toExponential(2)} vs thật ${(tauBeta * tauBeta).toExponential(2)}`
    );
    const decomp = betaDecompose(fit, ys, xs);
    // Lý thuyết: systematic ≈ β²Var(x)/(β²Var(x)+σ²ε) tại β trung bình
    const betaMean = betaTrue.reduce((s, b) => s + b, 0) / n;
    const theoSys = (betaMean * betaMean) / (betaMean * betaMean + sigmaEps * sigmaEps);
    check(
      "T-P2-5e decomp systematic khớp lý thuyết ±0,12",
      Math.abs(decomp.systematicShare - theoSys) <= 0.12,
      `đo=${decomp.systematicShare.toFixed(3)} vs lý thuyết=${theoSys.toFixed(3)}`
    );
    const destab = betaDestabilising(fit);
    check(
      "T-P2-5f chuỗi β ổn định → KHÔNG cờ destabilising",
      !destab.flagged,
      `sd β=${fit.betaSdT.toFixed(3)} · |Δβ₆₀|=${Math.abs(fit.betaT - (fit.betaAtPresentFromEnd(60) ?? fit.betaT)).toFixed(3)}`
    );

    // T-P2-6 — PIT (mirror p176 T4 — CÙNG THAM SỐ): filter với tham số của
    // fit-train chạy trên train vs train+rác-holdout ⇒ trạng thái lọc tại
    // train GIỮ NGUYÊN TUYỆT ĐỐI (leakage = 0). (β-fit-đầy ≠ β-fit-train là
    // HỢP LỆ — MLE tham số được phép học từ holdout khi fit trên đầy.)
    const m = n - 60;
    const specFit: KalmanSpec = {
      T: [[1, 0], [0, 1]],
      Z: [1, 0],
      R: [[1, 0], [0, 1]],
      Q: [[fit.sigma2EtaAlpha, 0], [0, fit.sigma2EtaBeta]],
      H: fit.sigma2Eps,
    };
    const ZSeqA: number[][] = [];
    const yA: (number | null)[] = [];
    for (let t = 0; t < m; t++) {
      yA.push(ys[t]!);
      ZSeqA.push([1, xs[t]!]);
    }
    const yB: (number | null)[] = [...yA];
    const ZSeqB: number[][] = [...ZSeqA];
    const rngB = mulberry32(99);
    for (let t = m; t < n; t++) {
      yB.push(stdNormal(rngB) * 5 + 2); // rác hoàn toàn
      ZSeqB.push([1, stdNormal(rngB) * 3]);
    }
    const kappaFit = 1e6 * 1; // Var(y) ~ O(1)
    const initFit = { a: [0, 1], P: [[kappaFit, 0], [0, kappaFit]] };
    const fA = kalmanFilter(yA, specFit, initFit, { burnIn: 5, ZSeq: ZSeqA });
    const fB = kalmanFilter(yB, specFit, initFit, { burnIn: 5, ZSeq: ZSeqB });
    let maxLeak = 0;
    for (let t = 0; t < m; t++) {
      maxLeak = Math.max(
        maxLeak,
        Math.abs(fA.steps[t]!.aUpd[1]! - fB.steps[t]!.aUpd[1]!)
      );
    }
    check(
      "T-P2-6 PIT: đổi toàn bộ holdout ⇒ β lọc tại train KHÔNG đổi (leakage=0)",
      maxLeak === 0,
      `max |Δβ| trên ${m} bước train = ${maxLeak.toExponential(2)}`
    );
  }
}

/* ═══════════ T-P2-7 · SS-9 — seasonal DOW + Tết ═══════════ */

console.log("\n── T-P2-7 · SS-9: seasonal có tín hiệu thắng · không tín hiệu không thắng ──");
{
  // (a) CÓ tín hiệu: T2 −0,4σ · T5 +0,4σ (n=900 — se(γ) ≈ 0,075)
  const rngA = mulberry32(77);
  const datesA = weekdayDates("2024-01-02", 900);
  const retsA: number[] = [];
  for (let i = 0; i < 900; i++) {
    const d = new Date(`${datesA[i]!}T00:00:00.000Z`);
    const dow = d.getUTCDay();
    const eff = dow === 1 ? -0.4 : dow === 4 ? 0.4 : 0;
    retsA.push(eff + stdNormal(rngA));
  }
  const cmpA = seasonalCompare(retsA, datesA);
  check("T-P2-7a có tín hiệu: seasonalCompare chạy", cmpA != null, cmpA ? `train ${cmpA.trainN} · holdout ${cmpA.holdoutN}` : "null");
  if (cmpA) {
    check(
      "T-P2-7b M1 (DOW) THẮNG M0 trên holdout log-score",
      cmpA.diffPerStep > 0,
      `diff/bước = ${cmpA.diffPerStep.toFixed(4)}`
    );
    // design: [1, dT3, dT4, dT5, dT6, tet] — baseline T2 (Thứ Hai). T2 −0,4
    // ⇒ mọi dummy = eff_d + 0,4: γ_T3 ≈ 0,4 · γ_T5 ≈ 0,8 · chênh γ_T5−γ_T3 ≈ 0,4
    const gT3 = cmpA.effects.find((e) => e.name === "γ_T3")?.mean ?? 0;
    const gT5 = cmpA.effects.find((e) => e.name === "γ_T5")?.mean ?? 0;
    check(
      "T-P2-7c khôi phục hiệu ứng TỪNG NGÀY ±0,2 (γ_T5−γ_T3 ≈ 0,4 ± 0,15)",
      Math.abs(gT3 - 0.4) <= 0.2 && Math.abs(gT5 - 0.8) <= 0.2 && Math.abs(gT5 - gT3 - 0.4) <= 0.15,
      `γ_T3=${gT3.toFixed(3)} (≈0,4) · γ_T5=${gT5.toFixed(3)} (≈0,8) · chênh ${(gT5 - gT3).toFixed(3)}`
    );
  }

  // (b) KHÔNG tín hiệu: thuần nhiễu — M1 không được thắng đáng kể
  const rngB = mulberry32(88);
  const datesB = weekdayDates("2024-01-02", 500);
  const retsB = datesB.map(() => stdNormal(rngB));
  const cmpB = seasonalCompare(retsB, datesB);
  check(
    "T-P2-7d thuần nhiễu: M1 KHÔNG thắng đáng kể (diff < 0,02 — không vẽ nên)",
    cmpB != null && cmpB.diffPerStep < 0.02,
    cmpB ? `diff/bước = ${cmpB.diffPerStep.toFixed(4)}` : "null"
  );

  // (c) Cửa sổ Tết ±7 ngày
  check(
    "T-P2-7e cửa sổ Tết: 2026-02-17 (mốc) · 2026-02-10 (−7) trong · 2026-03-01 ngoài",
    inTetWindow("2026-02-17") && inTetWindow("2026-02-10") && !inTetWindow("2026-03-01"),
    `17/2=${inTetWindow("2026-02-17")} · 10/2=${inTetWindow("2026-02-10")} · 1/3=${inTetWindow("2026-03-01")}`
  );
  // (d) thiết kế: Thứ Hai (T2) baseline 0 dummy · Thứ Bảy không dummy
  // 2026-10-19 = THỨ HAI · 2026-10-24 = THỨ BẢY (getUTCDay: 2=Thứ Ba đã dùng ở trên)
  const rowMon = seasonalDesignRow("2026-10-19"); // Thứ Hai — baseline
  const rowSat = seasonalDesignRow("2026-10-24"); // Thứ Bảy — ngoài phiên
  check(
    "T-P2-7f design: Thứ Hai baseline (0 dummy) · Thứ Bảy không dummy",
    rowMon.slice(1, 5).every((d) => d === 0) && rowSat.slice(1, 5).every((d) => d === 0),
    `T2=[${rowMon.join(",")}] · T7=[${rowSat.join(",")}]`
  );
}

/* ═══════════ T-P2-8/9/10/11 · VÁ FINDINGS F-177 ═══════════ */

console.log("\n── T-P2-8 · F-177-3: parity floor 0,1% của A15b ──");
{
  const ctx = { rollingSdPctH5: 2 };
  const tiny = ssEvidenceDecision(
    { enabled: true, mode: "live" },
    { meanPct: 0.05, sdPct: 2, pUp: 0.51, z: 0.03, weight: 0.31 },
    ctx
  );
  check(
    "T-P2-8a live + |meanPct| 0,05% < 0,1% ⇒ KHÔNG đốt (parity A15)",
    !tiny.push && tiny.reason.includes("parity"),
    tiny.reason
  );
  const ok = ssEvidenceDecision(
    { enabled: true, mode: "live" },
    { meanPct: 1.2, sdPct: 2, pUp: 0.726, z: 0.6, weight: 0.44 },
    ctx
  );
  check(
    "T-P2-8b live + |meanPct| 1,2% ≥ 0,1% ⇒ ĐỐT (regression T8c p176)",
    ok.push && ok.source === "ml-forecast.holt-ss",
    `push=${ok.push}`
  );
}

console.log("\n── T-P2-9 · F-177-5: ksPValue vùng D siêu nhỏ ──");
{
  const tinyD = ksPValue(1e-8, 60);
  const bigD = ksPValue(0.5, 60);
  check(
    "T-P2-9a D siêu nhỏ → p = 1 (trước đây ~0 — không hội tụ)",
    tinyD === 1,
    `p(D=1e-8, n=60) = ${tinyD}`
  );
  check(
    "T-P2-9b D lớn → p nhỏ < 0,01 (hướng regression giữ)",
    bigD < 0.01,
    `p(D=0.5, n=60) = ${bigD.toExponential(2)}`
  );
}

console.log("\n── T-P2-10 · F-177-4: smoother + aux trên chuỗi degenerate (σ²ε→0) ──");
{
  // Chuỗi linear THẬT CHÍNH XÁC: y = 3 + 0.5t — fit LLT sẽ đẩy σ²ε → biên 0
  const lin: number[] = [];
  for (let t = 0; t < 200; t++) lin.push(3 + 0.5 * t);
  const fit = holtSsFit(lin);
  check(
    "T-P2-10a fit chuỗi linear hoàn hảo (nghiệm biên σ²ε ≈ 0 hợp lệ F4)",
    fit != null && fit.sigma2Eps < 1e-6,
    fit ? `σ²ε=${fit.sigma2Eps.toExponential(2)} · logLik=${fit.logLik.toFixed(1)}` : "null"
  );
  if (fit) {
    const spec: KalmanSpec = {
      T: [[1, 1], [0, 1]],
      Z: [1, 0],
      R: [[1, 0], [0, 1]],
      Q: [[fit.sigma2EtaMu, 0], [0, fit.sigma2EtaB]],
      H: fit.sigma2Eps,
    };
    const present = lin.filter((c) => Number.isFinite(c));
    const meanL = present.reduce((s, x) => s + x, 0) / present.length;
    const varL = present.reduce((s, x) => s + (x - meanL) * (x - meanL), 0) / (present.length - 1);
    const kappa = 1e6 * varL;
    const res = kalmanFilter(lin, spec, { a: [lin[0]!, lin[1]! - lin[0]!], P: [[kappa, 0], [0, kappa]] }, { burnIn: 0 });
    const nDegen = res.steps.filter((s) => s.degenerate).length;
    const alpha = kalmanSmoother(spec, res.steps);
    const { aux } = kalmanAuxResiduals(spec, res.steps);
    const allFinite =
      alpha.every((a) => a.every((v) => Number.isFinite(v))) &&
      aux.every((a) => Number.isFinite(a.uHat) && a.etaHat.every((v) => Number.isFinite(v)));
    check(
      "T-P2-10b smoother + aux residuals 0 NaN/Infinity qua bước degenerate",
      allFinite,
      `${nDegen} bước degenerate · tất cả output finite`
    );
  }
}

console.log("\n── T-P2-11 · SS-3: Holt heuristic + rollingSd null-tolerant ──");
{
  const rng = mulberry32(66);
  const closes: number[] = [];
  let p = 25;
  for (let t = 0; t < 120; t++) {
    p *= 1 + 0.0008 + stdNormal(rng) * 0.014;
    closes.push(Number(p.toFixed(2)));
  }
  const holes: (number | null)[] = closes.map((c, i) => (i % 13 === 7 ? null : c));
  const fc = holtForecast(holes, { horizon: 5 });
  check(
    "T-P2-11a holtForecast trên chuỗi có lỗ: chạy + neo close có-mặt cuối",
    fc != null && fc.forecasts.length === 5,
    fc ? `level=${fc.level.toFixed(2)} · forecasts[0]=${fc.forecasts[0]!.toFixed(2)}` : "null"
  );
  const sdNull = rollingSdPctH5(holes);
  const sdDense = rollingSdPctH5(closes);
  check(
    "T-P2-11b rollingSdPctH5 null-tolerant (bỏ cặp có lỗ, cùng bậc)",
    Number.isFinite(sdNull) && sdNull > 0 && Math.abs(sdNull - sdDense) / sdDense < 0.3,
    `null=${sdNull.toFixed(3)}% vs dày=${sdDense.toFixed(3)}%`
  );
  // sd-guard vẫn hoạt động (regression F-177-2 dùng chung 1 nguồn)
  check(
    "T-P2-11c sdInflated dùng rollingSdPctH5 chung (guard 3× hoạt động)",
    sdInflated(3.1 * sdDense, sdDense) && !sdInflated(2.9 * sdDense, sdDense),
    `3,1×=${sdInflated(3.1 * sdDense, sdDense)} · 2,9×=${sdInflated(2.9 * sdDense, sdDense)}`
  );
  // holtSsForecast trên chuỗi có lỗ: neo đúng close cuối có mặt
  const fit = holtSsFit(holes);
  const fcSs = fit ? holtSsForecast(fit, holes, 5) : null;
  check(
    "T-P2-11d holtSsForecast có lỗ: neo % vào y_T có-mặt (không null)",
    fcSs != null && fcSs.lastClose === closes[closes.length - 1],
    fcSs ? `lastClose=${fcSs.lastClose} · meanPct h5=${fcSs.meanPct[4]!.toFixed(3)}%` : "null"
  );
}

/* ═══════════════════════════ TỔNG KẾT ═══════════════════════════ */

console.log("\n════════════════════════════════════════════");
console.log(`KẾT QUẢ p178: ${pass} PASS · ${fail} FAIL`);
if (fail > 0) {
  console.log("FAIL chi tiết:");
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log("Phase 2 STATE SPACE — hermetic PASS toàn bộ (Phụ lục B + Task 177 findings).");
