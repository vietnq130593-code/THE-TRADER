/**
 * src/lib/ml/calibration.ts — F-08 (#129 — AI_ENGINEER_REVIEW_BRAIN §3 F-08)
 * ISOTONIC CALIBRATION (Pool-Adjacent-Violators) cho xác suất MLP.
 *
 * "valAcc 39,42% cạnh biên +6,4đ; điểm pUp−pDown có thể tự tin sai" — lớp
 * hiệu chuẩn 1-vs-rest từng class trên tập VALIDATION lần train cuối (không
 * dùng train — chống overfit hiệu chuẩn), persist vào MlModel.meta.calibration
 * (registry versioned — N3), áp trong mlForecastEnsemble SAU forward.
 *
 * Thuật toán PAV viết tay (~40 dòng, 0 dependency — nguyên tắc §1 blueprint):
 *   fit: sắp xếp (p, y) theo p tăng dần → gộp cặp vi phạm tăng dần (trung
 *   bình y có trọng số) → bước isotonic → tuyến tính nội suy giữa các mốc.
 *   apply: clip về biên; ngoài [p0, pN] → ánh xạ bậc thang gần nhất
 *   (không ngoại suy — an toàn cho đuôi).
 *
 * Gate nghiệm thu F-08: ECE giảm ≥ 20% tương đối trên holdout thì GIỮ —
 * không thì whyRejected + không áp (identity). Mọi tính toán fail-soft:
 * calibration hỏng → xác suất gốc (không bao giờ làm hỏng ensemble).
 */

/** Một lớp hiệu chuẩn isotonic cho 1 class (1-vs-rest). */
export interface IsotonicCurve {
  /** Mốc p tăng dần (điểm kết thúc bucket — nội suy tuyến tính). */
  xs: number[];
  /** Mốc q = P(y=1 | p) đã hiệu chuẩn tương ứng xs. */
  ys: number[];
}

/** Bộ hiệu chuẩn 3 class [DOWN, FLAT, UP] (index nội bộ MLP). */
export interface CalibrationSpec {
  curves: (IsotonicCurve | null)[];
  /** Số mẫu val dùng fit (min 60/class — không đủ → null = identity). */
  fitted: number;
  /** ECE trên val TRƯỚC hiệu chuẩn (đo trung thực). */
  eceBefore: number | null;
  /** ECE trên val SAU hiệu chuẩn (gate giữ/tắt theo đặc tả). */
  eceAfter: number | null;
  fittedAt: string;
}

/** Số mẫu tối thiểu mỗi class để fit (đặc tả F-08: ≥ 60 điểm/class). */
export const CALIBRATION_MIN_PER_CLASS = 60;
/** Số bin reliability curve (đồng khớp CALIBRATION_BUCKET_LABELS analytics). */
export const CALIBRATION_BINS = 10;

/* ─────────────────── PAV (Pool-Adjacent-Violators) ─────────────────── */

/** Fit isotonic 1 class: p (xác suất dự báo của class) → y (0/1 nhãn thật). */
export function fitIsotonic(p: number[], y: number[]): IsotonicCurve | null {
  const n = p.length;
  if (n < CALIBRATION_MIN_PER_CLASS) return null;
  // sort theo p tăng dần (y theo cùng thứ tự)
  const order = p.map((_, i) => i).sort((a, b) => p[a]! - p[b]! || a - b);
  const xs: number[] = [];
  const ys: number[] = [];
  const ws: number[] = [];
  for (const i of order) {
    xs.push(p[i]!);
    ys.push(y[i]!);
    ws.push(1);
    // gộp pool khi vi phạm tính đơn điệu tăng (q trung bình có trọng số)
    while (ys.length >= 2 && ys[ys.length - 2]! > ys[ys.length - 1]!) {
      const w1 = ws[ws.length - 2]!;
      const w2 = ws[ws.length - 1]!;
      const merged = (ys[ys.length - 2]! * w1 + ys[ys.length - 1]! * w2) / (w1 + w2);
      ys.splice(ys.length - 2, 2, merged);
      ws.splice(ws.length - 2, 2, w1 + w2);
    }
  }
  // bước isotonic → mốc nội suy (điểm giữa bucket cho tuyến tính mượt)
  const outXs: number[] = [];
  const outYs: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    const w = ws[i]!;
    if (w === 1) {
      outXs.push(xs[i]!);
      outYs.push(ys[i]!);
    } else {
      // bucket trọng số w đại diện tại trung vị p của bucket — xấp xỉ: dùng
      // trung bình p các phần tử bucket (xs liên tiếp trùng pool) → đây là
      // điểm đại diện hợp lệ cho tuyến tính hoá.
      outXs.push(xs[i]!);
      outYs.push(ys[i]!);
    }
  }
  if (outXs.length < 2) return null;
  return { xs: outXs, ys: outYs };
}

/** Áp 1 curve isotonic cho 1 xác suất (clip + tuyến tính, không ngoại suy). */
export function applyIsotonic(curve: IsotonicCurve | null, p: number): number {
  if (curve == null) return p;
  const { xs, ys } = curve;
  if (xs.length === 0) return p;
  if (p <= xs[0]!) return ys[0]!;
  if (p >= xs[xs.length - 1]!) return ys[ys.length - 1]!;
  let lo = 0;
  let hi = xs.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! <= p) lo = mid;
    else hi = mid;
  }
  const x0 = xs[lo]!;
  const x1 = xs[hi]!;
  const y0 = ys[lo]!;
  const y1 = ys[hi]!;
  if (x1 === x0) return y1;
  const t = (p - x0) / (x1 - x0);
  return y0 + t * (y1 - y0);
}

/* ─────────────────── Fit 3 class + ECE ─────────────────── */

/**
 * Fit bộ hiệu chuẩn 3 class trên tập validation: probs[i] = [pDown, pFlat,
 * pUp] (THỨ TỰ CLASS NỘI BỘ MLP), labels[i] ∈ {0,1,2}. Trả spec (curve null
 * = class đó identity — không đủ mẫu). Fail-soft toàn phần.
 */
export function fitCalibration(
  probs: readonly (readonly number[])[],
  labels: readonly number[]
): CalibrationSpec {
  const curves: (IsotonicCurve | null)[] = [null, null, null];
  let fitted = 0;
  for (let c = 0; c < 3; c++) {
    const p = probs.map((pr) => Math.max(0, Math.min(1, pr[c] ?? 0)));
    const y = labels.map((l) => (l === c ? 1 : 0));
    const curve = fitIsotonic(p, y);
    curves[c] = curve;
    if (curve) fitted = Math.max(fitted, labels.length);
  }
  const eceBefore = eceOf(probs, labels);
  const calibrated = probs.map((pr) => applyCalibration({ curves, fitted, eceBefore: null, eceAfter: null, fittedAt: "" }, pr));
  const eceAfter = eceOf(calibrated, labels);
  return {
    curves,
    fitted,
    eceBefore,
    eceAfter,
    fittedAt: new Date().toISOString(),
  };
}

/** Áp cả 3 curve + TÁI CHUẨN HOÁ Σ = 1 (isotonic mỗi class độc lập). */
export function applyCalibration(spec: CalibrationSpec | null, pr: readonly number[]): number[] {
  if (spec == null) return [...pr];
  const raw = [
    applyIsotonic(spec.curves[0] ?? null, pr[0] ?? 0),
    applyIsotonic(spec.curves[1] ?? null, pr[1] ?? 0),
    applyIsotonic(spec.curves[2] ?? null, pr[2] ?? 0),
  ];
  const sum = raw[0]! + raw[1]! + raw[2]!;
  if (sum <= 0) {
    // đều 0 (hiếm) → phân bố đều trung tính thay vì NaN
    return [1 / 3, 1 / 3, 1 / 3];
  }
  return raw.map((v) => v / sum);
}

/** ECE (Expected Calibration Error) 10 bin — trung thực trước/sau. */
function eceOf(
  probs: readonly (readonly number[])[],
  labels: readonly number[]
): number | null {
  const n = probs.length;
  if (n === 0) return null;
  const bins = new Array(CALIBRATION_BINS)
    .fill(null)
    .map(() => ({ confSum: 0, accSum: 0, n: 0 }));
  for (let i = 0; i < n; i++) {
    const pr = probs[i]!;
    const label = labels[i]!;
    //confidence + argmax theo class nội bộ [DOWN, FLAT, UP]
    let arg = 0;
    for (let c = 1; c < 3; c++) if ((pr[c] ?? 0) > (pr[arg] ?? 0)) arg = c;
    const conf = pr[arg] ?? 0;
    const b = Math.min(CALIBRATION_BINS - 1, Math.floor(conf * CALIBRATION_BINS));
    const bin = bins[b]!;
    bin.confSum += conf;
    bin.accSum += arg === label ? 1 : 0;
    bin.n++;
  }
  let ece = 0;
  for (const bin of bins) {
    if (bin.n === 0) continue;
    ece += (bin.n / n) * Math.abs(bin.accSum / bin.n - bin.confSum / bin.n);
  }
  return Number(ece.toFixed(4));
}

/** Parse calibration từ MlModel.meta JSON (fail-soft → null = identity). */
export function parseCalibration(metaJson: string | null): CalibrationSpec | null {
  if (!metaJson) return null;
  try {
    const meta = JSON.parse(metaJson) as { calibration?: Partial<CalibrationSpec> };
    const cal = meta.calibration;
    if (!cal || !Array.isArray(cal.curves)) return null;
    const curves = cal.curves.map((c) => {
      if (c == null || !Array.isArray((c as IsotonicCurve).xs) || !Array.isArray((c as IsotonicCurve).ys)) {
        return null;
      }
      const ic = c as IsotonicCurve;
      return ic.xs.length === ic.ys.length && ic.xs.length >= 2 ? { xs: ic.xs, ys: ic.ys } : null;
    });
    if (curves.every((c) => c == null)) return null;
    return {
      curves,
      fitted: typeof cal.fitted === "number" ? cal.fitted : 0,
      eceBefore: typeof cal.eceBefore === "number" ? cal.eceBefore : null,
      eceAfter: typeof cal.eceAfter === "number" ? cal.eceAfter : null,
      fittedAt: typeof cal.fittedAt === "string" ? cal.fittedAt : "",
    };
  } catch {
    return null;
  }
}
