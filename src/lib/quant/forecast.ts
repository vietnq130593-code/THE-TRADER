/**
 * src/lib/quant/forecast.ts — DỰ BÁO HOLT'S LINEAR TREND (double exponential
 * smoothing) — thuật toán định lượng THẬT cho Bộ tổng hợp Bayes (phiên #34).
 *
 * Pure function, không DB. Công thức chuẩn Holt:
 *   l_t = α·y_t + (1−α)·(l_{t−1} + b_{t−1})        (level)
 *   b_t = β·(l_t − l_{t−1}) + (1−β)·b_{t−1}          (trend)
 *   ŷ_{t+h} = l_t + h·b_t                              (dự báo h bước)
 *
 * residualSigma đo bằng dự đoán 1-BƯỚC-LÙI trên lịch sử: pred_t = l_{t−1} + b_{t−1}
 * so với y_t thực tế — không "nhìn trước" nên không đánh lừa độ chính xác.
 *
 * CI80 = forecast ± 1.2816 × residualSigma × √h (z80 hai phía ~1.2816).
 */

import { stdev } from "@/lib/quant/statistics";

/** Tuỳ chọn dự báo Holt. */
export interface HoltOptions {
  /** Hệ số làm mượt level (0..1); mặc định 0.5 — cân bằng phản ứng/nhiễu. */
  alpha?: number;
  /** Hệ số làm mượt trend (0..1); mặc định 0.25. */
  beta?: number;
  /** Số phiên dự báo trước; mặc định 5. */
  horizon?: number;
}

/** Kết quả dự báo Holt. */
export interface HoltForecast {
  /** Level cuối cùng (ước lượng giá "gốc" hiện tại). */
  level: number;
  /** Trend cuối (độ dốc trung bình mỗi phiên, cùng đơn vị giá). */
  trend: number;
  /** Dự báo h = 1..horizon phiên tới (giá). */
  forecasts: number[];
  /** Độ lệch chuẩn residual 1-bước (đơn vị giá); chuỗi phẳng → cực nhỏ. */
  residualSigma: number;
  /** Khoảng tin cậy 80% mỗi bước dự báo (cùng chiều dài forecasts). */
  ci80: { low: number[]; high: number[] };
}

/** z hai phía 80% ≈ 1.2816 (chuẩn CI80 của dự báo). */
const Z80 = 1.2816;

/** Sàn residual để chia/so sánh không nổ Infinity khi chuỗi phẳng hoàn toàn. */
const RESIDUAL_FLOOR = 1e-6;

/**
 * Holt's linear trend forecast trên chuỗi close tăng dần theo thời gian.
 * Trả về null khi chuỗi < 3 điểm hoặc chứa giá không hợp lệ (≤ 0 / NaN).
 * SS-3 (Task 178 — STATE_SPACE_BLUEPRINT ch. 5): chấp nhận null (phiên
 * thiếu/mã treo) — BỎ cập nhật Holt (level/trend giữ nguyên, không bịa số);
 * neo % vào quan sát CÓ MẶT cuối. Chuỗi dày giữ NGUYÊN VĂN kết quả cũ
 * (regression p178 T-P2-2 — đường A15 không đổi hành vi khi không có lỗ).
 */
export function holtForecast(closes: (number | null)[], options: HoltOptions = {}): HoltForecast | null {
  const alpha = Math.min(1, Math.max(0.05, options.alpha ?? 0.5));
  const beta = Math.min(1, Math.max(0.01, options.beta ?? 0.25));
  const horizon = Math.max(1, Math.min(30, Math.round(options.horizon ?? 5)));
  const n = closes.length;
  let present = 0;
  for (const c of closes) {
    if (c == null) continue; // SS-3: phiên thiếu — hợp lệ
    if (!Number.isFinite(c) || c <= 0) return null;
    present++;
  }
  if (present < 3) return null;

  // Khởi tạo từ 2 quan sát CÓ MẶT đầu tiên (SS-3)
  let first: number | null = null;
  let second: number | null = null;
  for (const c of closes) {
    if (c != null) {
      if (first == null) first = c;
      else {
        second = c;
        break;
      }
    }
  }
  if (first == null || second == null) return null;

  // Khởi tạo: level = giá đầu, trend = chênh lệch 2 phiên đầu
  let level = first;
  let trend = second - first;
  const residuals: number[] = [];
  let seenFirst = false;
  for (let t = 0; t < n; t++) {
    const y = closes[t];
    if (y == null) continue; // SS-3 skip-update — level/trend giữ nguyên
    if (!seenFirst) {
      seenFirst = true; // quan sát CÓ MẶT đầu tiên đã dùng để khởi tạo — không push residual (khớp vòng t=1..n−1 của bản gốc)
      continue;
    }
    // Dự đoán 1-bước-lùi: dùng trạng thái (level, trend) TRƯỚC khi thấy y_t
    const oneStepPred = level + trend;
    residuals.push(y - oneStepPred);
    // Cập nhật Holt chuẩn
    const prevLevel = level;
    level = alpha * y + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
  }

  // Chuỗi phẳng: residual ≈ 0 → sàn residualSigma cực nhỏ để CI không âm vô lý
  // nhưng vẫn chia được ở caller (|expected|/sigma). Chuỗi giá nguyên VND,
  // nhiễu làm tròn thực tế ≥ vài đồng nên floor 1e-6 đủ an toàn.
  const residualSigma = Math.max(stdev(residuals), RESIDUAL_FLOOR);

  const forecasts: number[] = [];
  const low: number[] = [];
  const high: number[] = [];
  for (let h = 1; h <= horizon; h++) {
    const f = level + h * trend;
    const margin = Z80 * residualSigma * Math.sqrt(h);
    forecasts.push(f);
    low.push(f - margin);
    high.push(f + margin);
  }

  return { level, trend, forecasts, residualSigma, ci80: { low, high } };
}

/**
 * Quy đổi dự báo Holt sang % so giá hiện tại (dùng cho Bayes evidence).
 * Trả về null khi không đủ dữ liệu dự báo.
 */
export interface HoltPctForecast {
  /** % kỳ vọng sau horizon phiên (so với giá close cuối). */
  expectedPct: number;
  /** % cận dưới CI80 sau horizon phiên. */
  lowPct: number;
  /** % cận trên CI80 sau horizon phiên. */
  highPct: number;
  /** residualSigma quy sang % giá (1 bước) — dùng đo chất lượng mô hình. */
  sigmaPct: number;
}

export function holtForecastPct(closes: (number | null)[], options: HoltOptions = {}): HoltPctForecast | null {
  const horizon = Math.max(1, Math.min(30, Math.round(options.horizon ?? 5)));
  const fc = holtForecast(closes, options);
  if (!fc) return null;
  // SS-3: neo % vào quan sát CÓ MẶT cuối (null cuối không được biến neo thành null)
  let last = 0;
  for (let i = closes.length - 1; i >= 0; i--) {
    const c = closes[i];
    if (c != null && Number.isFinite(c)) {
      last = c;
      break;
    }
  }
  if (last <= 0) return null;
  const h = Math.min(horizon, fc.forecasts.length) - 1;
  const expectedPct = ((fc.forecasts[h] - last) / last) * 100;
  const lowPct = ((fc.ci80.low[h] - last) / last) * 100;
  const highPct = ((fc.ci80.high[h] - last) / last) * 100;
  return { expectedPct, lowPct, highPct, sigmaPct: (fc.residualSigma / last) * 100 };
}
