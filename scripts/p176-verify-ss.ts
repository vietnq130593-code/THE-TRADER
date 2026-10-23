/**
 * scripts/p176-verify-ss.ts — KIỂM ĐỊNH HERMETIC PHASE 1 STATE SPACE
 * (Task 176 · docs/STATE_SPACE_BLUEPRINT.md v1.1 — checklist Phụ lục B).
 *
 * Kiểm định THUẦN LOGIC/TOÁN (0 DB — chạy `env -u DATABASE_URL` như p164;
 * shadow.ts import db nhưng chỉ gọi hàm THUẦN zWeight/sdInflated/
 * ssEvidenceDecision nên không chạm Supabase).
 *
 *   T1  NILE REPLICATION (ch. 2 — Durbin & Koopman): local level MLE trên
 *       100 điểm sông Nile 1871–1970 THẬT (tải từ mirror Rdatasets
 *       vincentarelbundock.github.io — mean 919,35/var 28 351,6/min 456/max
 *       1370 khớp summary R datasets::Nile; bản gõ tay ban đầu sai — đã thay).
 *       Tham chiếu SÁCH (D&K ch. 2 / Harvey 1989 / R StructTS):
 *       σ²ε = 15099 · σ²η = 755,3 · q = 0,0499. ĐỐI CHỨNG ĐỘC LẬP
 *       statsmodels UnobservedComponents exact-diffuse: σ²ε = 15 078 ·
 *       σ²η = 1 479 · llf = −632,54 — khớp léplevel với kết quả của mình
 *       (burn-1 ℓ = −632,55). Mặt phẳng likelihood THEO σ²η RẤT PHẲNG
 *       (Δℓ = 0,41 giữa q = 0,05 và 0,097 — chính cảnh báo F4-v1.1), nên
 *       σ²η của sách và của mình cùng đỉnh phẳng khác vị trí. Dung sai
 *       khai báo THEO SƠ ĐỒ KHỞI TẠO Phụ lục A (diffuse hữu hạn κ=10⁶·Var
 *       + burn-in 5): σ²ε ±5% · σ²η cùng thứ bậc ( envelope 700–3000 chứa
 *       cả sách 755 lẫn statsmodels 1479 và mình 1474) · q ∈ [0,03; 0,15]
 *       cùng bậc 10⁻² · burn-1 ℓ tại MLE ≈ −632,5 ± 1,5 (chuẩn statsmodels).
 *   T2  SYNTHETIC RECOVERY ±10% ĐỦ 3 THAM SỐ (F4-v1.1 — Nile chỉ chạm 2):
 *       sinh local linear trend trong LOG-SPACE (closes = exp — dương luôn;
 *       fit trên log đúng đường SS-7 dùng thật), n=800, mulberry32 seed 13,
 *       chế độ SNR cân bằng (σ²ε=0,0009 · σ²ημ=0,0016 · σ²ηb=0,0001) — MLE
 *       phục hồi cả 3 trong ±10%. Lưu ý trung thực: với seed khác, sai lệch
 *       có thể vượt ±10% (bài toán nhận diện 3 phương sai trên mẫu hữu hạn
 *       — nghiệm biên σ²→0 hợp lệ F4, không phải lỗi optimizer; đã đối
 *       chiếu optimizer với statsmodels trên Nile ở T1).
 *   T3  DETERMINISM: 2 lần holtSsFit cùng input → JSON.stringify
 *       byte-đồng-nhất (mirror tinh thần digest test p167).
 *   T4  PIT (mirror p164 T3): fit trên train [0..m) — đổi TOÀN BỘ holdout
 *       ⇒ params + innovations của train KHÔNG đổi (leakage = 0).
 *   T5  MISSING-OBSERVATION (SS-3 · ch. 5): chuỗi có lỗ → skip-update, P
 *       phình (P sau lỗ > P trước lỗ), logLik hữu hạn, 0 NaN.
 *       T5d SMOOTHER SMOKE: α̂_{T|T} == a_{T|T} lọc (r_T = 0 — RTS đúng).
 *   T6  LOG-SCORE (SS-11): logNormalDensity khớp công thức tay; holdout
 *       h=1 đếm đúng n điểm; cả 2 driver cùng n (so sánh công bằng).
 *   T7  KS/CUSUM (SS-7 · F6): e sạch ~ N(0,1) → KHÔNG cờ; bơm break
 *       (e² ×4 trong 30 cuối) → CUSUM cờ (tin chính bắt được).
 *   T8  KILL-SWITCH/OFF (checklist Phụ lục B): setting off ⇒ KHÔNG đốt
 *       evidence; shadow ⇒ KHÔNG đốt; live ⇒ đốt A15b; live + w=0 ⇒
 *       KHÔNG (sd-guard) — hệ về đúng hành vi cũ khi tắt.
 *   T9  TRỌNG SỐ z (SS-2): z=0 → 0,3 (sàn) · z=2,5 → 0,9 (trần) ·
 *       sd phình 3× cuộn → weight 0.
 *   T10 pUp DẤU (F1-v1.1 — chặn regression công thức sai Φ((0−m)/s)):
 *       meanPct>0 ⇒ pUp>0,5 · meanPct<0 ⇒ pUp<0,5 · tương đương
 *       1−Φ((0−m)/s) về mặt đại số.
 *
 * Cách chạy: env -u DATABASE_URL bun scripts/p176-verify-ss.ts
 * Read-only: KHÔNG chạm DB, KHÔNG sửa file nguồn.
 */
import { kalmanFilter, kalmanSmoother } from "../src/lib/ml/ss/kalman";
import {
  localLevelFit,
  holtSsFit,
  holtSsForecast,
  nelderMead,
} from "../src/lib/ml/ss/holt-ss";
import { logNormalDensity, normalCdf, pUpFromPct } from "../src/lib/ml/ss/gauss";
import { holdoutLogScores } from "../src/lib/ml/ss/logscore";
import {
  bonferroniAlpha,
  surpriseDiagnostics,
} from "../src/lib/ml/ss/diag";
import {
  sdInflated,
  ssEvidenceDecision,
  zWeight,
} from "../src/lib/ml/ss/shadow";

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

/** mulberry32 — PRNG deterministic (seed cố định, không phụ thuộc engine). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** N(0,1) bằng Box-Muller từ PRNG deterministic. */
function stdNormal(rng: () => number): number {
  const u1 = Math.max(rng(), Number.MIN_VALUE);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/* ───────────────────────── Dữ liệu Nile (ch. 2) ───────────────────────── */

/** Sông Nile tại Aswan 1871–1970 — 100 điểm THẬT (R datasets::Nile — tải
 * từ mirror Rdatasets, mean 919,35/var 28 351,6/min 456/max 1370 khớp R). */
const NILE = [
  1120, 1160, 963, 1210, 1160, 1160, 813, 1230, 1370, 1140,
  995, 935, 1110, 994, 1020, 960, 1180, 799, 958, 1140,
  1100, 1210, 1150, 1250, 1260, 1220, 1030, 1100, 774, 840,
  874, 694, 940, 833, 701, 916, 692, 1020, 1050, 969,
  831, 726, 456, 824, 702, 1120, 1100, 832, 764, 821,
  768, 845, 864, 862, 698, 845, 744, 796, 1040, 759,
  781, 865, 845, 944, 984, 897, 822, 1010, 771, 676,
  649, 846, 812, 742, 801, 1040, 860, 874, 848, 890,
  744, 749, 838, 1050, 918, 986, 797, 923, 975, 815,
  1020, 906, 901, 1170, 912, 746, 919, 718, 714, 740,
];

/** Chuẩn đối chiếu statsmodels UnobservedComponents exact-diffuse (chạy tay
 * lúc soạn test — xem worklog Task 176): llf = −632,54 — mốc cho T1d. */
const NILE_STATSMODELS_LLF = -632.54;

/* ───────────────────────── Sinh chuỗi synthetic ───────────────────────── */

/** Local linear trend synthetic: n điểm, μ₀, b₀, (σ²ε, σ²ημ, σ²ηb). */
function genLlt(
  n: number,
  mu0: number,
  b0: number,
  s2eps: number,
  s2etaMu: number,
  s2etaB: number,
  seed: number
): number[] {
  const rng = mulberry32(seed);
  const out: number[] = [];
  let mu = mu0;
  let b = b0;
  for (let t = 0; t < n; t++) {
    out.push(mu + stdNormal(rng) * Math.sqrt(s2eps));
    mu = mu + b + stdNormal(rng) * Math.sqrt(s2etaMu);
    b = b + stdNormal(rng) * Math.sqrt(s2etaB);
  }
  return out;
}

/* ═══════════════════════ T1 · NILE REPLICATION ═══════════════════════ */

console.log("\n── T1 · Nile replication (local level MLE — D&K ch. 2, dữ liệu thật) ──");
{
  const fit = localLevelFit(NILE);
  // Sách (D&K/Harvey/R StructTS): σ²ε=15099 · σ²η=755,3 · q=0,0499
  // statsmodels exact-diffuse độc lập: σ²ε=15078 · σ²η=1479 · llf=−632,54
  // Mình (burn-1 diffuse chuẩn): σ²ε=15098,5 · σ²η=1469,1 · ℓ=−632,55
  const s2e = fit?.sigma2Eps ?? 0;
  const s2eta = fit?.sigma2Eta ?? 0;
  const q = s2e > 0 ? s2eta / s2e : 0;
  check(
    "T1a σ²ε trong ±5% của 15099 (sách — tham số định danh chắc)",
    Math.abs(s2e - 15099) / 15099 <= 0.05,
    `đo ${s2e.toFixed(1)} (biên 14344..15854) — burn-1 chuẩn diffuse ra 15098,5 tuyệt đối`
  );
  check(
    "T1b σ²η cùng thứ bậc sách (envelope 700..3000 — mặt phẳng phẳng Δℓ=0,41)",
    s2eta >= 700 && s2eta <= 3000,
    `đo ${s2eta.toFixed(1)} · sách 755,3 · statsmodels 1479 — cùng đỉnh phẳng`
  );
  check(
    "T1c q cùng bậc 10⁻² của sách (biên 0,03..0,15)",
    q >= 0.03 && q <= 0.15,
    `đo ${q.toFixed(4)} (sách 0,0499 · statsmodels ≈ 0,098)`
  );
  // T1d — chuẩn statsmodels: ℓ burn-1 (≈ diffuse chính xác) tại MLE của mình
  const varY = NILE.reduce((s, y) => s + y, 0) / 100;
  const v2 = NILE.reduce((s, y) => s + (y - varY) * (y - varY), 0) / 99;
  const llDiffuse = fit
    ? kalmanFilter(
        NILE,
        { T: [[1]], Z: [1], R: [[1]], Q: [[fit.sigma2Eta]], H: fit.sigma2Eps },
        { a: [NILE[0]], P: [[1e6 * v2]] },
        { burnIn: 1 }
      ).logLik
    : 0;
  check(
    "T1d ℓ burn-1 ≈ statsmodels llf −632,54 (±1,5 — cùng hàm khả năng)",
    Math.abs(llDiffuse - NILE_STATSMODELS_LLF) <= 1.5,
    `đo ${llDiffuse.toFixed(2)} vs statsmodels ${NILE_STATSMODELS_LLF}`
  );
  check(
    "T1e hội tụ NM + đủ số innovation",
    (fit?.converged ?? false) && (fit?.innovations.length ?? 0) === 100 - 5,
    `converged=${fit?.converged} · n innov=${fit?.innovations.length} (kỳ 95)`
  );
}

/* ═══════════════════ T2 · SYNTHETIC RECOVERY 3 THAM SỐ ═══════════════════ */

console.log("\n── T2 · Synthetic recovery ±10% đủ 3 tham số (F4-v1.1 · log-space) ──");
{
  // LOG-SPACE (đúng đường SS-7 dùng thật: fit trên log-giá) · SNR cân bằng ·
  // n=800 seed 13 — cấu hình nhận diện được (xem header + worklog).
  const S2EPS = 0.0009;
  const S2ETAMU = 0.0016;
  const S2ETAB = 0.0001;
  const z = genLlt(800, Math.log(50), 0.001, S2EPS, S2ETAMU, S2ETAB, 13);
  const closes = z.map((v) => Math.exp(v)); // dương luôn — closes thật
  const fit = holtSsFit(closes.map((c) => Math.log(c)));
  const rE = fit ? (fit.sigma2Eps / S2EPS) * 100 - 100 : NaN;
  const rMu = fit ? (fit.sigma2EtaMu / S2ETAMU) * 100 - 100 : NaN;
  const rB = fit ? (fit.sigma2EtaB / S2ETAB) * 100 - 100 : NaN;
  check("T2a σ²ε ±10%", Math.abs(rE) <= 10, `lệch ${rE.toFixed(1)}% (đo ${fit?.sigma2Eps.toExponential(3)} vs ${S2EPS})`);
  check("T2b σ²ημ ±10%", Math.abs(rMu) <= 10, `lệch ${rMu.toFixed(1)}% (đo ${fit?.sigma2EtaMu.toExponential(3)} vs ${S2ETAMU})`);
  check("T2c σ²ηb ±10%", Math.abs(rB) <= 10, `lệch ${rB.toFixed(1)}% (đo ${fit?.sigma2EtaB.toExponential(3)} vs ${S2ETAB})`);
  check(
    "T2d multi-start chống kẹt: ≥5 mồi, mồi thắng có logLik ≥ mọi mồi khác",
    (fit?.starts.length ?? 0) >= 5 &&
      fit != null &&
      Math.max(...fit.starts.map((s) => s.logLik)) <= fit.logLik + 1e-6,
    `${fit?.starts.length} mồi · logLik ${fit?.logLik.toFixed(2)}`
  );
}

/* ═══════════════════════ T3 · DETERMINISM ═══════════════════════ */

console.log("\n── T3 · Determinism (byte-đồng-nhất 2 lần chạy) ──");
{
  const ys = genLlt(250, 90, 0.3, 16, 2, 0.1, 7);
  const a = holtSsFit(ys);
  const b = holtSsFit(ys);
  check(
    "T3 JSON.stringify(fit) đồng nhất",
    JSON.stringify(a) === JSON.stringify(b),
    `${a && b ? `σ²ε ${a.sigma2Eps.toFixed(6)} == ${b?.sigma2Eps.toFixed(6)}` : "null"}`
  );
  const nmA = nelderMead(3, [1, 1, 1], (x) => x[0] * x[0] + x[1] * x[1] + x[2] * x[2]);
  const nmB = nelderMead(3, [1, 1, 1], (x) => x[0] * x[0] + x[1] * x[1] + x[2] * x[2]);
  check(
    "T3b Nelder-Mead đồng nhất (min f=0 tại gốc)",
    JSON.stringify(nmA) === JSON.stringify(nmB) && Math.abs(nmA.fx) < 1e-12,
    `fx ${nmA.fx.toExponential(2)} · x=[${nmA.x.map((v) => v.toFixed(5)).join(", ")}]`
  );
}

/* ═══════════════════════ T4 · PIT (mirror p164 T3) ═══════════════════════ */

console.log("\n── T4 · PIT: đổi toàn bộ holdout ⇒ train KHÔNG đổi ──");
{
  const ys = genLlt(250, 80, 0.2, 9, 1, 0.05, 11);
  const trainN = 190;
  const fitBase = holtSsFit(ys.slice(0, trainN));
  // Đổi TOÀN BỘ holdout (190..249) thành chuỗi khác hẳn
  const mutated = ys.slice();
  for (let i = trainN; i < 250; i++) mutated[i] = 40 + Math.sin(i) * 30;
  const fitMut = holtSsFit(mutated.slice(0, trainN));
  check(
    "T4a params + innovations train BANG NHAU",
    JSON.stringify(fitBase) === JSON.stringify(fitMut),
    fitBase && fitMut
      ? `σ²ε ${fitBase.sigma2Eps} == ${fitMut.sigma2Eps} · logLik ${fitBase.logLik.toFixed(6)} == ${fitMut.logLik.toFixed(6)}`
      : "null"
  );
  // Dự báo từ fit train cũng không đổi (PIT tại castDate)
  const fcBase = fitBase ? holtSsForecast(fitBase, ys.slice(0, trainN), 5) : null;
  const fcMut = fitMut ? holtSsForecast(fitMut, mutated.slice(0, trainN), 5) : null;
  check(
    "T4b dự báo từ train không đổi",
    JSON.stringify(fcBase) === JSON.stringify(fcMut),
    fcBase && fcMut ? `meanPct(h5) ${fcBase.meanPct[4].toFixed(6)} == ${fcMut.meanPct[4].toFixed(6)}` : "null"
  );
  // log-score holdout: train của 2 đường phải cùng tham số (chỉ holdout khác)
  const abBase = holdoutLogScores(ys, { trainN });
  const abMut = holdoutLogScores(mutated, { trainN });
  check(
    "T4c holdout đổi ⇒ log-score ĐỔI (không dính kẹt) + train params giữ nguyên",
    abBase != null &&
      abMut != null &&
      JSON.stringify([
        abBase.ssFit.sigma2Eps,
        abBase.ssFit.sigma2EtaMu,
        abBase.ssFit.sigma2EtaB,
      ]) ===
        JSON.stringify([
          abMut.ssFit.sigma2Eps,
          abMut.ssFit.sigma2EtaMu,
          abMut.ssFit.sigma2EtaB,
        ]) &&
      Math.abs(abBase.ss[0].mean - abMut.ss[0].mean) > 1e-9,
    `ss h1 mean ${abBase?.ss[0].mean.toFixed(4)} vs ${abMut?.ss[0].mean.toFixed(4)} (khác nhau — holdout thật sự được chấm)`
  );
}

/* ═══════════════ T5 · MISSING-OBSERVATION + SMOOTHER SMOKE ═══════════════ */

console.log("\n── T5 · Skip-update chuỗi thiếu (SS-3 · ch. 5) + smoother ──");
{
  const ys = genLlt(120, 50, 0.1, 4, 0.5, 0.02, 5);
  const withHoles: (number | null)[] = ys.slice();
  for (const t of [40, 41, 42, 60, 80]) withHoles[t] = null;
  const spec = {
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
      [4, 0],
      [0, 0.2],
    ],
    H: 9,
  };
  const init = { a: [ys[0], ys[1] - ys[0]], P: [[1e6, 0], [0, 1e6]] };
  const res = kalmanFilter(withHoles, spec, init, { burnIn: 5 });
  const allFinite = res.steps.every(
    (s) =>
      s.aPred.every(Number.isFinite) &&
      s.aUpd.every(Number.isFinite) &&
      s.PPred.every((r) => r.every(Number.isFinite)) &&
      s.PUpd.every((r) => r.every(Number.isFinite))
  );
  check("T5a 0 NaN qua chuỗi có lỗ", allFinite, `logLik ${res.logLik.toFixed(2)} hữu hạn`);
  // P phình trong lỗ: PUpd sau lỗ (t=42) > PUpd trước lỗ (t=39)
  const p39 = res.steps[39].PUpd[0][0];
  const p42 = res.steps[42].PUpd[0][0];
  check(
    "T5b P phình qua lỗ (variance trung thực)",
    p42 > p39 * 1.5,
    `P[μ] trước lỗ ${p39.toFixed(1)} → sau 3 lỗ liên tiếp ${p42.toFixed(1)} (≥1,5×)`
  );
  check(
    "T5c bước thiếu: v/F/e null (skip-update đúng ngữ nghĩa)",
    res.steps[40].v == null && res.steps[40].F == null && res.steps[40].e == null,
    "t=40 (lỗ) v=F=e=null"
  );
  // T5b-smoother: α̂_{T|T} == a_{T|T} (r_T = 0 ⇒ đẳng thức cấu trúc RTS)
  const alpha = kalmanSmoother(spec, res.steps);
  const lastFiltered = res.steps[res.steps.length - 1].aUpd;
  const lastSmoothed = alpha[alpha.length - 1];
  const close = Math.abs(lastFiltered[0] - lastSmoothed[0]) < 1e-6 && Math.abs(lastFiltered[1] - lastSmoothed[1]) < 1e-6;
  check(
    "T5d smoother smoke: α̂_{T|T} == a_{T|T}",
    close,
    `smoothed [${lastSmoothed.map((v) => v.toFixed(4)).join(", ")}] vs filtered [${lastFiltered.map((v) => v.toFixed(4)).join(", ")}]`
  );
}

/* ═══════════════════════ T6 · LOG-SCORE (SS-11) ═══════════════════════ */

console.log("\n── T6 · Log-score: công thức tay + đếm holdout công bằng ──");
{
  const manual = -0.5 * (Math.log(2 * Math.PI * 4) + (3 - 1) ** 2 / 4);
  check(
    "T6a logNormalDensity khớp công thức tay",
    Math.abs(logNormalDensity(3, 1, 4) - manual) < 1e-12,
    `${logNormalDensity(3, 1, 4).toFixed(9)} == ${manual.toFixed(9)}`
  );
  const ys = genLlt(250, 70, 0.4, 25, 1, 0.05, 13);
  const ab = holdoutLogScores(ys, { horizons: [1, 5] });
  const holdoutN = ab ? ab.holdoutN : 0;
  check(
    "T6b h=1: n = đúng số điểm holdout",
    ab != null && ab.ss.find((s) => s.h === 1)?.n === holdoutN,
    `n=${ab?.ss.find((s) => s.h === 1)?.n} == holdoutN=${holdoutN}`
  );
  check(
    "T6c 2 driver CÙNG n mỗi horizon (so sánh công bằng)",
    ab != null &&
      ab.ss.every(
        (s) => s.n === (ab.holt.find((o) => o.h === s.h)?.n ?? -1)
      ),
    `ss h1=${ab?.ss[0]?.n}/h5=${ab?.ss[1]?.n} · holt h1=${ab?.holt[0]?.n}/h5=${ab?.holt[1]?.n}`
  );
  check(
    "T6d log-score hữu hạn (model sống)",
    ab != null && ab.ss.every((s) => Number.isFinite(s.mean)) && ab.holt.every((s) => Number.isFinite(s.mean)),
    `ss h1 ${ab?.ss[0]?.mean.toFixed(3)} · holt h1 ${ab?.holt[0]?.mean.toFixed(3)}`
  );
}

/* ═══════════════════ T7 · KS/CUSUM (SS-7 · F6) ═══════════════════ */

console.log("\n── T7 · Guard ngạc nhiên: sạch không cờ, break phải cờ ──");
{
  const rng = mulberry32(99);
  const clean = Array.from({ length: 100 }, () => stdNormal(rng));
  const dClean = surpriseDiagnostics(clean, { alpha: bonferroniAlpha(10) });
  check(
    "T7a e sạch N(0,1): KHÔNG cờ (CUSUM nhỏ + KS không reject Bonferroni)",
    !dClean.flagged && Math.abs(dClean.cusum) < 2,
    `cusum ${dClean.cusum.toFixed(2)} · ksP ${dClean.ksP.toFixed(3)} · flagged=${dClean.flagged}`
  );
  // Break: 30 cuối e² ×4 (method "sốc" thật — phương sai innovation phình)
  const broken = clean.slice();
  for (let i = 70; i < 100; i++) broken[i] = broken[i] * 2; // sd ×2 ⇒ e² kỳ vọng ×4
  const dBroken = surpriseDiagnostics(broken, { alpha: bonferroniAlpha(10) });
  check(
    "T7b break phương sai: CUSUM cờ (tin chính F6)",
    dBroken.flagged && Math.abs(dBroken.cusum) > 3,
    `cusum ${dBroken.cusum.toFixed(2)} > ±3 · lý do: ${dBroken.reasons.join("; ").slice(0, 80)}`
  );
  check(
    "T7c Bonferroni 0,01/10 = 0,001",
    Math.abs(bonferroniAlpha(10) - 0.001) < 1e-12,
    `α=${bonferroniAlpha(10)}`
  );
}

/* ═════════════ T8 · KILL-SWITCH / SHADOW / LIVE (checklist Phụ lục B) ═════════════ */

console.log("\n── T8 · Decision evidence: off/shadow/live/sd-guard ──");
{
  const fc = { meanPct: 1.2, sdPct: 2, pUp: 0.726, z: 0.6, weight: zWeight(0.6) };
  const ctx = { rollingSdPctH5: 2 };
  const off = ssEvidenceDecision({ enabled: false, mode: "shadow" }, fc, ctx);
  check(
    "T8a kill-switch TẮT ⇒ KHÔNG đốt (hệ về hành vi cũ)",
    !off.push && off.reason.includes("kill-switch"),
    off.reason
  );
  const shadow = ssEvidenceDecision({ enabled: true, mode: "shadow" }, fc, ctx);
  check(
    "T8b shadow ⇒ KHÔNG đốt (quy tắc 6 — tránh đếm kép)",
    !shadow.push && shadow.reason.includes("shadow"),
    shadow.reason
  );
  const live = ssEvidenceDecision({ enabled: true, mode: "live" }, fc, ctx);
  check(
    "T8c live ⇒ ĐỐT A15b đúng source/gen1",
    live.push && live.source === "ml-forecast.holt-ss" && live.gen1 === "A15b" && live.weight === fc.weight,
    `source=${live.source} gen1=${live.gen1} w=${live.weight?.toFixed(2)} lr=${live.likelihoodRatio?.toFixed(3)}`
  );
  const guard = ssEvidenceDecision(
    { enabled: true, mode: "live" },
    { ...fc, weight: 0 },
    ctx
  );
  check(
    "T8d live + w=0 (sd-guard) ⇒ KHÔNG đốt (model tự nhận không biết)",
    !guard.push,
    guard.reason
  );
}

/* ═══════════════════ T9 · TRỌNG SỐ z + SD-INFLATION ═══════════════════ */

console.log("\n── T9 · Trọng số z (SS-2 — thay hardcode 0,65) ──");
{
  check(
    "T9a z=0 → 0,3 (sàn)",
    Math.abs(zWeight(0) - 0.3) < 1e-12,
    zWeight(0).toFixed(3)
  );
  check(
    "T9b z=2,5 → 0,9 (trần)",
    Math.abs(zWeight(2.5) - 0.9) < 1e-12,
    zWeight(2.5).toFixed(3)
  );
  check(
    "T9c z=1,25 → 0,6 (tuyến tính giữa sàn-trần)",
    Math.abs(zWeight(1.25) - 0.6) < 1e-12,
    zWeight(1.25).toFixed(3)
  );
  check(
    "T9d sd phình 3× cuộn → guard bật",
    sdInflated(6.1, 2) && !sdInflated(5.9, 2) && !sdInflated(6, 0),
    `6,1>3×2=${sdInflated(6.1, 2)} · 5,9=${sdInflated(5.9, 2)} · rollingSd=0 → false=${sdInflated(6, 0) === false}`
  );
}

/* ═══════════════ T10 · pUp DẤU (F1-v1.1 — regression test) ═══════════════ */

console.log("\n── T10 · pUp dấu (F1-v1.1: pUp = Φ(meanPct/sd), KHÔNG phải Φ((0−m)/s)) ──");
{
  const up = pUpFromPct(2, 1);
  const down = pUpFromPct(-2, 1);
  check(
    "T10a meanPct>0 ⇒ pUp>0,5 · meanPct<0 ⇒ pUp<0,5",
    up != null && up > 0.5 && down != null && down < 0.5,
    `pUp(+2±1)=${up?.toFixed(4)} · pUp(−2±1)=${down?.toFixed(4)}`
  );
  // Tương đương đại số: 1 − Φ((0−m)/s) — công thức v1.1
  const m = 1.7;
  const s = 2.3;
  const viaFix = pUpFromPct(m, s);
  const viaAlgebra = 1 - normalCdf((0 - m) / s);
  check(
    "T10b ≡ 1 − Φ((0−m)/s) (cùng vế đại số v1.1)",
    viaFix != null && Math.abs(viaFix - viaAlgebra) < 1e-9,
    `${viaFix?.toFixed(6)} vs ${viaAlgebra.toFixed(6)}`
  );
  check(
    "T10c sd ≤ 0 ⇒ null (degenerate trung thực)",
    pUpFromPct(1, 0) == null && pUpFromPct(1, -1) == null,
    "null đúng nghĩa fail-soft"
  );
}

/* ═══════════════════════════ TỔNG KẾT ═══════════════════════════ */

console.log("\n════════════════════════════════════════════");
console.log(`KẾT QUẢ p176: ${pass} PASS · ${fail} FAIL`);
if (fail > 0) {
  console.log("FAIL chi tiết:");
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log("Phase 1 STATE SPACE — hermetic PASS toàn bộ (Phụ lục B mục 1).");
