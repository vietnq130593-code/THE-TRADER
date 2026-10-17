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
 *
 * FIX #130 (fixbug Task 129): bản cũ gộp pool bằng splice trên ys/ws nhưng
 * KHÔNG splice xs → xs.length ≠ ys.length sau lần gộp đầu tiên → vòng xuất
 * mốc duyệt theo xs.length đọc ys[i] = undefined → curve chứa undefined →
 * applyCalibration ra NaN (sum = undefined + … = NaN, NaN <= 0 là false nên
 * đi thẳng vào phép chia) → eceOf tính b = Math.floor(NaN × 10) = NaN →
 * bins[NaN] = undefined → "TypeError: Cannot read properties of undefined
 * (reading 'confSum')" → F-08 chết ngầm ở MỌI lượt train (fail-soft identity
 * + spam console). Bản mới viết lại PAV bằng POOL đối tượng + 5 tầng phòng
 * hộ NaN/undefined (fitIsotonic · fitCalibration · applyIsotonic ·
 * applyCalibration · eceOf · parseCalibration).
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

/**
 * Fit isotonic 1 class: p (xác suất dự báo của class) → y (0/1 nhãn thật).
 *
 * FIX #130: PAV bằng POOL đối tượng {sumY, w, sumP} — mỗi pool giữ tổng nhãn,
 * số mẫu và tổng p của chuỗi mẫu đã gộp; không còn ba mảng song song để lệch
 * độ dài. Mỗi pool xuất đúng 1 mốc: x = p trung bình pool, q = y trung bình
 * pool (bucket đại diện tại trung bình p — đúng như thiết kế tuyến tính hoá).
 */
export function fitIsotonic(p: number[], y: number[]): IsotonicCurve | null {
  const n = p.length;
  if (n < CALIBRATION_MIN_PER_CLASS) return null;
  // sort theo p tăng dần (y theo cùng thứ tự)
  const order = p.map((_, i) => i).sort((a, b) => p[a]! - p[b]! || a - b);
  type Pool = { sumY: number; w: number; sumP: number };
  const pools: Pool[] = [];
  for (const i of order) {
    const pi = p[i]!;
    const yi = y[i]!;
    const last = pools[pools.length - 1];
    if (last && last.sumY / last.w > yi) {
      // mẫu mới vi phạm đơn điệu với pool cuối → gộp vào pool cuối…
      last.sumY += yi;
      last.w += 1;
      last.sumP += pi;
      // …pool gộp xong có thể vẫn lớn hơn pool TRƯỚC nó → gộp tiếp (cascade)
      while (pools.length >= 2) {
        const a = pools[pools.length - 2]!;
        const b = pools[pools.length - 1]!;
        if (a.sumY / a.w <= b.sumY / b.w) break;
        a.sumY += b.sumY;
        a.w += b.w;
        a.sumP += b.sumP;
        pools.pop();
      }
    } else {
      pools.push({ sumY: yi, w: 1, sumP: pi });
    }
  }
  // mỗi pool → 1 mốc isotonic
  const outXs: number[] = [];
  const outYs: number[] = [];
  for (const pool of pools) {
    outXs.push(pool.sumP / pool.w);
    outYs.push(pool.sumY / pool.w);
  }
  if (outXs.length < 2) return null;
  return { xs: outXs, ys: outYs };
}

/**
 * Áp 1 curve isotonic cho 1 xác suất (clip + tuyến tính, không ngoại suy).
 * FIX #130: p không hữu hạn → trả nguyên p; curve lệch độ dài xs/ys → identity.
 */
export function applyIsotonic(curve: IsotonicCurve | null, p: number): number {
  if (curve == null || !Number.isFinite(p)) return p;
  const { xs, ys } = curve;
  if (xs.length === 0 || xs.length !== ys.length) return p;
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

/** Clamp về [0,1] an toàn NaN (NaN/Infinity → 0 — không cho rác đi tiếp). */
function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/**
 * Fit bộ hiệu chuẩn 3 class trên tập validation: probs[i] = [pDown, pFlat,
 * pUp] (THỨ TỰ CLASS NỘI BỘ MLP), labels[i] ∈ {0,1,2}. Trả spec (curve null
 * = class đó identity — không đủ mẫu). Fail-soft toàn phần.
 *
 * FIX #130: lọc mẫu không hữu hạn + clamp [0,1] TRƯỚC khi fit — NaN đi qua
 * Math.max/Math.min vẫn là NaN (so sánh với NaN luôn false) nên bản cũ cho
 * rác đi thẳng vào PAV rồi lan xuống ECE.
 */
export function fitCalibration(
  probs: readonly (readonly number[])[],
  labels: readonly number[]
): CalibrationSpec {
  // F-130 — làm sạch đầu vào
  const clean: { p: [number, number, number]; y: number }[] = [];
  for (let i = 0; i < probs.length; i++) {
    const pr = probs[i]!;
    const c0 = pr[0] ?? NaN;
    const c1 = pr[1] ?? NaN;
    const c2 = pr[2] ?? NaN;
    const y = labels[i] ?? NaN;
    if (Number.isFinite(c0) && Number.isFinite(c1) && Number.isFinite(c2) && Number.isFinite(y)) {
      clean.push({ p: [clamp01(c0), clamp01(c1), clamp01(c2)], y });
    }
  }
  const safeProbs = clean.map((c) => c.p);
  const safeLabels = clean.map((c) => c.y);
  const curves: (IsotonicCurve | null)[] = [null, null, null];
  let fitted = 0;
  for (let c = 0; c < 3; c++) {
    const p = safeProbs.map((pr) => pr[c]!);
    const y = safeLabels.map((l) => (l === c ? 1 : 0));
    const curve = fitIsotonic(p, y);
    curves[c] = curve;
    if (curve) fitted = Math.max(fitted, safeLabels.length);
  }
  const eceBefore = eceOf(safeProbs, safeLabels);
  const calibrated = safeProbs.map((pr) =>
    applyCalibration({ curves, fitted, eceBefore: null, eceAfter: null, fittedAt: "" }, pr)
  );
  const eceAfter = eceOf(calibrated, safeLabels);
  return {
    curves,
    fitted,
    eceBefore,
    eceAfter,
    fittedAt: new Date().toISOString(),
  };
}

/**
 * Áp cả 3 curve + TÁI CHUẨN HOÁ Σ = 1 (isotonic mỗi class độc lập).
 * FIX #130: kết quả không hữu hạn (curve rác từ meta hỏng) → trả xác suất
 * GỐC (identity) thay vì NaN — calibration không bao giờ làm hỏng ensemble.
 */
export function applyCalibration(spec: CalibrationSpec | null, pr: readonly number[]): number[] {
  if (spec == null) return [...pr];
  const raw = [
    applyIsotonic(spec.curves[0] ?? null, pr[0] ?? 0),
    applyIsotonic(spec.curves[1] ?? null, pr[1] ?? 0),
    applyIsotonic(spec.curves[2] ?? null, pr[2] ?? 0),
  ];
  const sum = raw[0]! + raw[1]! + raw[2]!;
  if (!Number.isFinite(sum) || sum <= 0) {
    // đều 0 (hiếm) → phân bố đều trung tính thay vì NaN
    return [1 / 3, 1 / 3, 1 / 3];
  }
  const out = raw.map((v) => v / sum);
  if (out.some((v) => !Number.isFinite(v) || v < 0)) return [...pr];
  return out;
}

/**
 * ECE (Expected Calibration Error) 10 bin — trung thực trước/sau.
 * FIX #130: bỏ qua mẫu conf không hữu hạn + chặn bin index [0,9] HAI PHÍA —
 * NaN/âm làm bins[NaN]/bins[-1] undefined → TypeError 'confSum' (bug gốc).
 */
function eceOf(
  probs: readonly (readonly number[])[],
  labels: readonly number[]
): number | null {
  const n = probs.length;
  if (n === 0) return null;
  const bins = new Array(CALIBRATION_BINS)
    .fill(null)
    .map(() => ({ confSum: 0, accSum: 0, n: 0 }));
  let used = 0;
  for (let i = 0; i < n; i++) {
    const pr = probs[i]!;
    const label = labels[i]!;
    // confidence + argmax theo class nội bộ [DOWN, FLAT, UP]
    let arg = 0;
    for (let c = 1; c < 3; c++) if ((pr[c] ?? 0) > (pr[arg] ?? 0)) arg = c;
    const conf = Math.max(0, Math.min(1, pr[arg] ?? 0));
    if (!Number.isFinite(conf)) continue; // mẫu rác → không vào ECE
    const b = Math.max(0, Math.min(CALIBRATION_BINS - 1, Math.floor(conf * CALIBRATION_BINS)));
    const bin = bins[b]!;
    bin.confSum += conf;
    bin.accSum += arg === label ? 1 : 0;
    bin.n++;
    used++;
  }
  if (used === 0) return null;
  let ece = 0;
  for (const bin of bins) {
    if (bin.n === 0) continue;
    ece += (bin.n / used) * Math.abs(bin.accSum / bin.n - bin.confSum / bin.n);
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
      // FIX #130: curve rác (chứa null/NaN do lỗi PAV bản cũ) → null (identity)
      const finite =
        ic.xs.every((v) => typeof v === "number" && Number.isFinite(v)) &&
        ic.ys.every((v) => typeof v === "number" && Number.isFinite(v));
      return finite && ic.xs.length === ic.ys.length && ic.xs.length >= 2
        ? { xs: ic.xs, ys: ic.ys }
        : null;
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
