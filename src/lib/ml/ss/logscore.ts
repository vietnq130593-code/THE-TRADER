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

/** Var mẫu (n−1) — helper nội bộ. */
function varOf(xs: number[]): number {
  if (xs.length < 2) return 1e-6;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (xs.length - 1);
  return Number.isFinite(v) && v > 0 ? v : 1e-6;
}

/**
 * Đối chứng A/B trên một cửa sổ closes (PIT-an toàn tuyệt đối: mọi mật độ
 * tại t chỉ dùng dữ liệu ≤ t). Horizons mặc định [1, 5] — 1 bước (calibration
 * tinh nhất) + 5 bước (đúng horizon evidence thật của cả 2 driver).
 * Trả null khi cửa sổ quá ngắn (< 90 phiên sau khi chia).
 */
export function holdoutLogScores(
  closes: number[],
  opts: { trainN?: number; horizons?: number[] } = {}
): HoldoutLogScores | null {
  const n = closes.length;
  if (n < 90) return null;
  const holdoutN = Math.min(60, Math.floor(n / 4));
  const trainN = opts.trainN ?? n - holdoutN;
  if (trainN < 60 || n - trainN < 20) return null;
  const horizons = (opts.horizons ?? [1, 5]).slice().sort((a, b) => a - b);
  const train = closes.slice(0, trainN);

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
  const full = kalmanFilter(closes, spec, {
    a: [train[0], train[1] - train[0]],
    P: [
      [1e6 * Math.max(varOf(train), Number.MIN_VALUE), 0],
      [0, 1e6 * Math.max(varOf(train), Number.MIN_VALUE)],
    ],
  }, { burnIn: 0 });

  const ssScores: DriverLogScore[] = horizons.map((h) => {
    let sum = 0;
    let cnt = 0;
    if (h === 1) {
      for (let t = trainN; t < n; t++) {
        const s = full.steps[t];
        if (s.v != null && s.F != null) {
          sum += logNormalDensity(closes[t], s.aPred[0], s.F);
          cnt++;
        }
      }
    } else {
      for (let t = trainN; t <= n - 1 - h; t++) {
        const s = full.steps[t];
        const pts = kalmanForecast(spec, s.aUpd, s.PUpd, h);
        const p = pts[pts.length - 1];
        if (p) {
          sum += logNormalDensity(closes[t + h], p.mean, p.variance);
          cnt++;
        }
      }
    }
    return { h, n: cnt, sum, mean: meanOf(sum, cnt) };
  });

  /* ── Driver CŨ: Holt heuristic qua train (σ đóng băng) + xuyên holdout ── */
  // residualSigma từ train (đóng băng — cùng kỷ luật freeze như driver mới).
  let level = train[0];
  let trend = train[1] - train[0];
  const residuals: number[] = [];
  for (let t = 1; t < trainN; t++) {
    residuals.push(train[t] - (level + trend));
    const prevLevel = level;
    level = OLD_ALPHA * train[t] + (1 - OLD_ALPHA) * (level + trend);
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
    const prevLevel = level;
    level = OLD_ALPHA * closes[t] + (1 - OLD_ALPHA) * (level + trend);
    trend = OLD_BETA * (level - prevLevel) + (1 - OLD_BETA) * trend;
  }

  const holtScores: DriverLogScore[] = horizons.map((h) => {
    let sum = 0;
    let cnt = 0;
    if (h === 1) {
      for (let t = trainN; t < n; t++) {
        const st = statesHoldout[t - trainN]; // trạng thái TRƯỚC khi thấy y_t
        const pred = st.level + st.trend;
        sum += logNormalDensity(closes[t], pred, sigma2Floor);
        cnt++;
      }
    } else {
      for (let t = trainN; t <= n - 1 - h; t++) {
        // Dự báo h-bước từ trạng thái SAU khi thấy y_t: statesHoldout[t+1−trainN]
        // là trạng thái sau cập nhật y_t (trạng thái trước y_{t+1}).
        const st = statesHoldout[t - trainN + 1] ?? statesHoldout[statesHoldout.length - 1];
        const pred = st.level + h * st.trend;
        const varH = sigma2Floor * h; // hàm ý từ CI80 heuristic: σ·√h ⇒ var σ²·h
        sum += logNormalDensity(closes[t + h], pred, varH);
        cnt++;
      }
    }
    return { h, n: cnt, sum, mean: meanOf(sum, cnt) };
  });

  return { trainN, holdoutN: n - trainN, ss: ssScores, holt: holtScores, ssFit: fit };
}
