/**
 * src/lib/ml/ss/logscore.ts — SS-11 · LOG PREDICTIVE DENSITY (cổng chấm model).
 *
 * STATE_SPACE_BLUEPRINT SS-11 + quy tắc 6 (A/B SHADOW): mọi driver dự báo
 * chấm trên holdout bằng log-score LS = Σ ln N(y_actual | model) — kéo dài
 * prediction error decomposition ra NGOÀI MẪU. Đây là thước "calibration +
 * sharpness" chuẩn — khắc phục hạn chế valAcc post-selection (W5 review #162).
 *
 * GIAO THỨC ĐỐI CHỨNG A/B (14 ngày bóng — driver mới holt-ss vs driver cũ
 * holt heuristic, CÙNG dữ liệu, CÙNG kỷ luật freeze):
 *   1. Chia cửa sổ: train = closes[0..trainN−1] · holdout = phần cuối.
 *   2. Driver MỚI: holtSsFit trên train (tham số ĐÓNG BĂNG — quy tắc 3 Phần
 *      IV: fit trong train window, giữ nguyên cho eval/holdout) → filter
 *      TIẾP qua holdout với tham số đóng băng → mật độ 1-bước N(ŷ_t, F_t)
 *      tại mỗi t holdout (PIT: dùng dữ liệu ≤ t−1); h-bước: dự báo từ trạng
 *      thái lọc tại t, realised y_{t+h}.
 *   3. Driver CŨ: holtForecast α=0,5/β=0,25 trên train (residualSigma đóng
 *      băng từ train) → đệ quy Holt TIẾP qua holdout (cùng PIT) → mật độ
 *      1-bước N(pred_t, σ²_res); h-bước sd = σ_res·√h (hàm ý từ CI80 heuristic
 *      Z80·σ√h của quant/forecast.ts — predictive density ngầm của driver cũ).
 *   4. So mean log-score từng horizon — mới ≥ cũ mới đủ điều kiện hoán đổi
 *      evidence (quy tắc 6: hết 14 ngày, chỉ khi thắng).
 *
 * Pure function — scripts/p176 T6 kiểm toán tay + T4 PIT (đổi toàn bộ
 * holdout ⇒ đầu ra train không đổi).
 */

import { kalmanFilter, kalmanForecast, type KalmanSpec } from "@/lib/ml/ss/kalman";
import { holtSsFit, type HoltSsFit } from "@/lib/ml/ss/holt-ss";
import { logNormalDensity } from "@/lib/ml/ss/gauss";

/** Log-score một driver ở một horizon. */
export interface DriverLogScore {
  /** Horizon (1 hoặc 5 phiên). */
  h: number;
  /** Số điểm holdout đánh giá được. */
  n: number;
  /** Σ ln N(y; ŷ, F). */
  sum: number;
  /** sum/n — trung bình (so sánh A/B dùng cái này). */
  mean: number;
}

/** Kết quả đối chứng một cửa sổ. */
export interface HoldoutLogScores {
  /** Số phiên train (tham số đóng băng ở đây). */
  trainN: number;
  /** Số phiên holdout. */
  holdoutN: number;
  /** Driver mới ml-forecast.holt-ss. */
  ss: DriverLogScore[];
  /** Driver cũ ml-forecast.holt-basket (heuristic α/β cứng). */
  holt: DriverLogScore[];
  /** Fit đầy đủ của driver mới trên train (audit + tái tạo). */
  ssFit: HoltSsFit;
}

/** Hệ số Holt của driver cũ — giữ NGUYÊN quant/forecast.ts (α=0,5/β=0,25). */
const OLD_ALPHA = 0.5;
const OLD_BETA = 0.25;

function meanOf(sum: number, n: number): number {
  return n > 0 ? sum / n : 0;
}

/** Var mẫu (n−1) — helper nội bộ. SS-3: lọc null trước khi tính. */
function varOf(xs: (number | null)[]): number {
  const v = xs.filter((x): x is number => x != null && Number.isFinite(x));
  if (v.length < 2) return 1e-6;
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  const out = v.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (v.length - 1);
  return Number.isFinite(out) && out > 0 ? out : 1e-6;
}

/** 2 phần tử CÓ MẶT đầu tiên — khởi tạo Holt/LLT trên chuỗi có lỗ (SS-3). */
function firstTwoPresent(xs: (number | null)[]): { a: number; b: number } | null {
  let a: number | null = null;
  for (const x of xs) {
    if (x != null && Number.isFinite(x)) {
      if (a == null) a = x;
      else return { a, b: x };
    }
  }
  return null;
}

/**
 * Đối chứng A/B trên một cửa sổ closes (PIT-an toàn tuyệt đối: mọi mật độ
 * tại t chỉ dùng dữ liệu ≤ t). Horizons mặc định [1, 5] — 1 bước (calibration
 * tinh nhất) + 5 bước (đúng horizon evidence thật của cả 2 driver).
 * Trả null khi cửa sổ quá ngắn (< 90 phiên sau khi chia).
 * SS-3 (Task 178): closes chấp nhận null (phiên thiếu) — driver mới skip-update
 * (variance phình trung thực), driver cũ bỏ cập nhật Holt (level/trend giữ
 * nguyên) — 2 driver cùng xử lý lỗ trung thực, so sánh công bằng.
 */
export function holdoutLogScores(
  closes: (number | null)[],
  opts: { trainN?: number; horizons?: number[] } = {}
): HoldoutLogScores | null {
  const n = closes.length;
  // Số phiên lịch (kể cả null) phải ≥ 90; số CÓ MẶT cũng ≥ 90 (fit cần dữ liệu)
  const presentCount = closes.filter((c): c is number => c != null && Number.isFinite(c)).length;
  if (n < 90 || presentCount < 90) return null;
  const holdoutN = Math.min(60, Math.floor(n / 4));
  const trainN = opts.trainN ?? n - holdoutN;
  if (trainN < 60 || n - trainN < 20) return null;
  const horizons = (opts.horizons ?? [1, 5]).slice().sort((a, b) => a - b);
  const train = closes.slice(0, trainN);
  const initPair = firstTwoPresent(train);
  if (!initPair) return null;

  /* ── Driver MỚI: fit train + filter xuyên holdout (tham số đóng băng) ── */
  const fit = holtSsFit(train);
  if (!fit) return null;
  const spec: KalmanSpec = {
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
      [fit.sigma2EtaMu, 0],
      [0, fit.sigma2EtaB],
    ],
    H: fit.sigma2Eps,
  };
  // Filter TOÀN chuỗi với tham số đóng băng — innovations holdout là mật độ
  // 1-bước ngoài mẫu (trạng thái tại t−1 chỉ thấy dữ liệu ≤ t−1: PIT).
  // burn-in 0: likelihood này KHÔNG dùng làm mục tiêu tối ưu (fit đã xong với
  // burnIn=5 trên train); đây chỉ lấy mảng trạng thái từng bước.
  const kappa = 1e6 * Math.max(varOf(train), Number.MIN_VALUE);
  const full = kalmanFilter(closes, spec, {
    a: [initPair.a, initPair.b - initPair.a],
    P: [
      [kappa, 0],
      [0, kappa],
    ],
  }, { burnIn: 0 });

  const ssScores: DriverLogScore[] = horizons.map((h) => {
    let sum = 0;
    let cnt = 0;
    if (h === 1) {
      for (let t = trainN; t < n; t++) {
        const s = full.steps[t];
        if (s.v != null && s.F != null) {
          sum += logNormalDensity(closes[t] as number, s.aPred[0], s.F);
          cnt++;
        }
      }
    } else {
      for (let t = trainN; t <= n - 1 - h; t++) {
        const target = closes[t + h];
        if (target == null) continue; // SS-3: mục tiêu thiếu → không chấm
        const s = full.steps[t];
        const pts = kalmanForecast(spec, s.aUpd, s.PUpd, h);
        const p = pts[pts.length - 1];
        if (p) {
          sum += logNormalDensity(target, p.mean, p.variance);
          cnt++;
        }
      }
    }
    return { h, n: cnt, sum, mean: meanOf(sum, cnt) };
  });

  /* ── Driver CŨ: Holt heuristic qua train (σ đóng băng) + xuyên holdout ── */
  // residualSigma từ train (đóng băng — cùng kỷ luật freeze như driver mới).
  // SS-3: y thiếu → BỎ cập nhật Holt (level/trend giữ nguyên — không bịa số).
  let level = initPair.a;
  let trend = initPair.b - initPair.a;
  const residuals: number[] = [];
  for (let t = 1; t < trainN; t++) {
    const y = train[t];
    if (y == null) continue; // skip-update
    // Dự đoán 1-bước-lùi: dùng trạng thái TRƯỚC khi thấy y_t
    residuals.push(y - (level + trend));
    const prevLevel = level;
    level = OLD_ALPHA * y + (1 - OLD_ALPHA) * (level + trend);
    trend = OLD_BETA * (level - prevLevel) + (1 - OLD_BETA) * trend;
  }
  const rMean = residuals.reduce((s, x) => s + x, 0) / Math.max(1, residuals.length);
  const sigma2 =
    residuals.length > 1
      ? residuals.reduce((s, x) => s + (x - rMean) * (x - rMean), 0) / (residuals.length - 1)
      : Math.max(Math.abs(rMean), 1e-6);
  const sigma2Floor = Math.max(sigma2, 1e-6); // sàn như quant/forecast.ts

  // Tiếp đệ quy qua holdout — pred_t = level_{t−1} + trend_{t−1} (PIT).
  // Lưu trạng thái trước từng bước để chấm h-bước từ trạng thái tại t.
  const statesHoldout: { level: number; trend: number }[] = [];
  for (let t = trainN; t < n; t++) {
    statesHoldout.push({ level, trend });
    const y = closes[t];
    if (y == null) continue; // SS-3 skip-update
    const prevLevel = level;
    level = OLD_ALPHA * y + (1 - OLD_ALPHA) * (level + trend);
    trend = OLD_BETA * (level - prevLevel) + (1 - OLD_BETA) * trend;
  }

  const holtScores: DriverLogScore[] = horizons.map((h) => {
    let sum = 0;
    let cnt = 0;
    if (h === 1) {
      for (let t = trainN; t < n; t++) {
        const y = closes[t];
        if (y == null) continue; // SS-3
        const st = statesHoldout[t - trainN]; // trạng thái TRƯỚC khi thấy y_t
        if (!st) continue;
        const pred = st.level + st.trend;
        sum += logNormalDensity(y, pred, sigma2Floor);
        cnt++;
      }
    } else {
      for (let t = trainN; t <= n - 1 - h; t++) {
        const target = closes[t + h];
        if (target == null) continue; // SS-3
        // Dự báo h-bước từ trạng thái SAU khi thấy y_t: statesHoldout[t+1−trainN]
        // là trạng thái sau cập nhật y_t (trạng thái trước y_{t+1}).
        const st = statesHoldout[t - trainN + 1] ?? statesHoldout[statesHoldout.length - 1];
        if (!st) continue;
        const pred = st.level + h * st.trend;
        const varH = sigma2Floor * h; // hàm ý từ CI80 heuristic: σ·√h ⇒ var σ²·h
        sum += logNormalDensity(target, pred, varH);
        cnt++;
      }
    }
    return { h, n: cnt, sum, mean: meanOf(sum, cnt) };
  });

  return { trainN, holdoutN: n - trainN, ss: ssScores, holt: holtScores, ssFit: fit };
}
