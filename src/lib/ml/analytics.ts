/**
 * src/lib/ml/analytics.ts — A2 (ML_OPS_BLUEPRINT v1.1 §3): thống kê kiểm định
 * cho vòng học bandit — Wilson 95% CI · Brier Murphy decomposition ·
 * calibration bucket 5 mức · posterior trajectory · agent × regime.
 *
 * HẤP THỤ L2 đã duyệt #51 (ML_LEARNING_BLUEPRINT) + [DA] Statistics/
 * Confidence (Wilson cho tỉ lệ nhị phân) + [ML] Evaluation Metrics (Brier
 * Murphy decomposition). Nguyên tắc §1.4: mọi chỉ số kèm n + CI; n < 30 →
 * "chưa đủ mẫu" (insufficient).
 *
 * TOÀN BỘ hàm thuần — 0 DB, 0 LLM, 0 dependency. Route /api/ml/analytics
 * nạp dữ liệu rồi gọi các hàm này.
 *
 * ── Semantics outcome (A2 — ghi rõ để đối chiếu) ─────────────────────────
 * BanditEvent.reward của Thompson sampling KHÔNG nhị phân: vote đúng hướng
 * → 1, sai → 0, FLAT khớp → 0,7, FLAT lệch → 0,2 (bandit.ts:279-282).
 * Để tính Brier/calibration (chuẩn nhị phân Murphy) ta NHỊ PHÂN HOÁ:
 *     outcome o = reward >= 0.5 ? 1 : 0
 * (reward ≥ 0,5 = "phiếu kể như đúng" — cùng ngưỡng STREAK_REWARD_MIN của
 * scorecard B8). p = BanditEvent.confidence (độ tin cậy khai báo lúc cast).
 * Hit-rate/arm KHÔNG nhị phân hoá (wins/pulls = mean reward — giữ nguyên
 * semantics scorecard B8 hiện có).
 *
 * ── Murphy decomposition — lưu ý toán học quan trọng ─────────────────────
 * Bất đẳng thức BS = REL − RES + UNC chỉ ĐÚNG ĐẲNG THỨC khi dự báo trong
 * mỗi bucket là HẰNG (Murphy 1973 phân hoạch theo GIÁ TRỊ dự báo riêng
 * biệt). Confidence khai báo là số liên tục → khi gom 5 bucket, giá trị
 * p trong bucket dao động. Vì vậy phân rã trả về:
 *   • brier       — BS của dự báo ĐÃ LƯỢNG TỬ HOÁ theo bucket
 *                   (mean (p̄_k − o)²): THỎA ĐÚNG ĐẲNG THỨC
 *                   brier = reliability − resolution + uncertainty
 *                   (chênh lệch chỉ do sai số浮 điểm — residual ≈ 1e-16).
 *   • brierRaw    — BS thô theo confidence gốc (mean (p − o)²) — metric
 *                   hiển thị chính (đồng nhất cột Brier scorecard B8 sau
 *                   nhị phân hoá). brierRaw − brier = độ lệch lượng tử
 *                   hoá (within-bucket refinement), có thể ≠ 0.
 */

import type { MarketRegime } from "@/lib/quant/regime";
import { classifyRegime } from "@/lib/quant/regime";

/* ══════════════════════ Wilson 95% CI cho tỉ lệ ══════════════════════ */

/** Khoảng tin cậy Wilson: {lo, hi} — cùng thang với p̂ (0..1). */
export interface WilsonInterval {
  lo: number;
  hi: number;
}

/**
 * Wilson score interval cho tỉ lệ nhị phân [DA Statistics/Confidence]:
 *   (p̂ + z²/2n ± z·√(p̂(1−p̂)/n + z²/4n²)) / (1 + z²/n)
 * Chuẩn hơn normal approximation ở n nhỏ/p̂ gần 0 hoặc 1.
 * n ≤ 0 hoặc p̂ ngoài [0,1] → ném lỗi (caller giữ nguyên trung thực).
 */
export function wilson(pHat: number, n: number, z = 1.96): WilsonInterval {
  if (!(n > 0)) throw new Error(`wilson: n phải > 0 (nhận ${n})`);
  if (!(pHat >= 0 && pHat <= 1)) {
    throw new Error(`wilson: pHat ngoài [0,1] (nhận ${pHat})`);
  }
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = pHat + z2 / (2 * n);
  const margin =
    z * Math.sqrt((pHat * (1 - pHat)) / n + z2 / (4 * n * n));
  // Kẹp [0,1]: p̂ ∈ {0,1} có thể sinh sai số浮 điểm −2e-17 ở biên — khoảng
  // Wilson toán học luôn nằm trong [0,1] nên kẹp chỉ xoá nhiễu số học.
  return {
    lo: Math.max(0, (center - margin) / denom),
    hi: Math.min(1, (center + margin) / denom),
  };
}

/* ═════════════════ Brier + Murphy decomposition + calibration ═════════ */

/** Một mẫu Brier: p = confidence khai báo (0..1) · o = outcome nhị phân 0/1. */
export interface BrierEntry {
  p: number;
  o: 0 | 1;
}

/** 5 bucket calibration theo spec A2 (ML_OPS_BLUEPRINT §3 A2.2). */
const BUCKET_EDGES = [0.4, 0.55, 0.7, 0.85] as const;

/** Nhãn hiển thị từng bucket (số thập phân kiểu vi-VN). */
export const CALIBRATION_BUCKET_LABELS = [
  "≤ 0,40",
  "0,40–0,55",
  "0,55–0,70",
  "0,70–0,85",
  "> 0,85",
] as const;

/** Bucket của một confidence: 0..4 — p ≤ 0,4 → 0 · … · p > 0,85 → 4. */
export function bucketIndexOf(p: number): number {
  let idx = 0;
  for (const edge of BUCKET_EDGES) {
    if (p > edge) idx++;
  }
  return idx;
}

/** Phân rã Murphy: REL − RES + UNC (đẳng thức đúng — xem doc-file đầu). */
export interface BrierDecomposition {
  /** Số mẫu có cả confidence + outcome. */
  n: number;
  /** BS của dự báo lượng tử hoá theo bucket — thoả ĐÚNG ĐẲNG THỨC dưới. */
  brier: number;
  /** BS thô theo confidence gốc (mean (p−o)²) — metric hiển thị chính. */
  brierRaw: number;
  /** Σ n_k/N·(meanP_k − meanO_k)² — thấp = khai báo khớp thực tế. */
  reliability: number;
  /** Σ n_k/N·(meanO_k − overallO)² — cao = bucket phân biệt được đúng/sai. */
  resolution: number;
  /** overallO·(1−overallO) — độ khó nội tại của outcome. */
  uncertainty: number;
  /** brier − (reliability − resolution + uncertainty) — chỉ sai số浮 điểm. */
  residual: number;
  /** Tỉ lệ outcome = 1 trên toàn bộ mẫu. */
  overallOutcome: number;
}

/**
 * Murphy decomposition trên 5 bucket confidence (spec A2):
 *   reliability = Σ n_k/N·(meanP_k − meanO_k)²
 *   resolution  = Σ n_k/N·(meanO_k − overallO)²
 *   uncertainty = overallO·(1−overallO)
 *   brier       = mean (p̄_k − o)²  (lượng tử hoá — đẳng thức đúng)
 *   brierRaw    = mean (p − o)²     (confidence gốc)
 * Trả null khi rỗng (chưa có mẫu — UI trung thực "—").
 */
export function brierDecomposition(entries: BrierEntry[]): BrierDecomposition | null {
  if (entries.length === 0) return null;
  const n = entries.length;
  const overallO = entries.reduce((s, e) => s + e.o, 0) / n;

  // Thống kê từng bucket (mọi bucket đều có mặt — n_k = 0 khi rỗng)
  const sumP = new Array<number>(5).fill(0);
  const sumO = new Array<number>(5).fill(0);
  const counts = new Array<number>(5).fill(0);
  for (const e of entries) {
    const k = bucketIndexOf(e.p);
    sumP[k] += e.p;
    sumO[k] += e.o;
    counts[k]++;
  }

  let reliability = 0;
  let resolution = 0;
  let brier = 0; // BS lượng tử hoá: mean (p̄_k − o_i)²
  let brierRaw = 0;
  for (let k = 0; k < 5; k++) {
    if (counts[k] === 0) continue;
    const meanP = sumP[k] / counts[k];
    const meanO = sumO[k] / counts[k];
    const w = counts[k] / n;
    reliability += w * (meanP - meanO) * (meanP - meanO);
    resolution += w * (meanO - overallO) * (meanO - overallO);
    // BS lượng tử hoá: mọi mẫu trong bucket dùng p̄_k
    brier += w * (meanP - meanO) * (meanP - meanO); // = w·(p̄_k−ō_k)² phần REL
    brier += w * meanO * (1 - meanO); // + phần quan sát trong bucket
  }
  for (const e of entries) {
    brierRaw += (e.p - e.o) * (e.p - e.o);
  }
  brierRaw /= n;

  const uncertainty = overallO * (1 - overallO);
  const residual = brier - (reliability - resolution + uncertainty);
  return {
    n,
    brier,
    brierRaw,
    reliability,
    resolution,
    uncertainty,
    residual,
    overallOutcome: overallO,
  };
}

/** Một dòng bảng calibration 5 bucket. */
export interface CalibrationBucket {
  label: string;
  n: number;
  /** TB confidence khai báo trong bucket — null khi bucket rỗng. */
  meanConfidence: number | null;
  /** TB outcome (tỉ lệ đúng nhị phân) — null khi bucket rỗng. */
  meanOutcome: number | null;
  /** Wilson 95% CI của meanOutcome — null khi bucket rỗng. */
  wilson: WilsonInterval | null;
}

/**
 * Bảng calibration 5 bucket: confidence khai báo vs tỉ lệ đúng thực tế
 * (kèm Wilson CI của meanOutcome — outcome nhị phân nên Wilson chuẩn xác).
 * Luôn trả đủ 5 dòng (n=0 → các giá trị null) cho UI ổn định.
 */
export function calibrationBuckets(entries: BrierEntry[]): CalibrationBucket[] {
  const sumP = new Array<number>(5).fill(0);
  const sumO = new Array<number>(5).fill(0);
  const counts = new Array<number>(5).fill(0);
  for (const e of entries) {
    const k = bucketIndexOf(e.p);
    sumP[k] += e.p;
    sumO[k] += e.o;
    counts[k]++;
  }
  return CALIBRATION_BUCKET_LABELS.map((label, k) => {
    const n = counts[k];
    if (n === 0) {
      return { label, n, meanConfidence: null, meanOutcome: null, wilson: null };
    }
    const meanConfidence = sumP[k] / n;
    const meanOutcome = sumO[k] / n;
    return {
      label,
      n,
      meanConfidence,
      meanOutcome,
      wilson: wilson(meanOutcome, n),
    };
  });
}

/* ═════════════════════════ Per-arm analytics ═════════════════════════ */

/** Ngưỡng pulls đủ mẫu cho mọi metric tỉ lệ (nguyên tắc §1.4 — CLT n≥30). */
export const MIN_SAMPLES = 30;

/** Thống kê một arm bandit cho payload A2 (spec §3 A2.1). */
export interface ArmAnalytics {
  code: string;
  pulls: number;
  /** Σ reward (FLAT khớp = 0,7 — thập phân, không phải số lần đúng nguyên). */
  wins: number;
  alpha: number;
  beta: number;
  /** (alpha+1)/(alpha+beta+2) — KHỚP banditSnapshot (bandit.ts:376). */
  posteriorMean: number;
  /** wins/pulls = mean reward — null khi pulls = 0. */
  hitRate: number | null;
  /** Wilson 95% CI trên hitRate — null khi pulls = 0.
   * LƯU Ý: wins là Σreward (FLAT 0,7/0,2) nên pHat không nhị phân thuần —
   * Wilson ở đây là xấp xỉ hợp lý (spec A2 hiển thị CI kèm hit-rate). */
  wilson: WilsonInterval | null;
  /** pulls < 30 → UI "chưa đủ mẫu". */
  insufficient: boolean;
}

/**
 * Dựng ArmAnalytics từ dòng BanditArm (thuần — route nạp rồi gọi).
 * alpha/beta mặc định 1/1 (prior Beta(1,1)) khi arm chưa tồn tại.
 */
export function buildArmAnalytics(arm: {
  agentCode: string;
  alpha?: number;
  beta?: number;
  pulls?: number;
  wins?: number;
}): ArmAnalytics {
  const alpha = arm.alpha ?? 1;
  const beta = arm.beta ?? 1;
  const pulls = arm.pulls ?? 0;
  const wins = arm.wins ?? 0;
  const posteriorMean = (alpha + 1) / (alpha + beta + 2);
  const hitRate = pulls > 0 ? wins / pulls : null;
  return {
    code: arm.agentCode,
    pulls,
    wins,
    alpha,
    beta,
    posteriorMean,
    hitRate,
    wilson: hitRate != null ? wilson(hitRate, pulls) : null,
    insufficient: pulls < MIN_SAMPLES,
  };
}

/* ══════════════ Payload hợp đồng /api/ml/analytics (route + UI) ═══════ */

/** Arm + tên hiển thị (route ghép từ ROSTER_BY_CODE). */
export interface AnalyticsArm extends ArmAnalytics {
  name: string;
}

/** Brier một arm (nhị phân hoá) — null khi arm chưa có cặp confidence+reward. */
export interface ArmBrier {
  code: string;
  brier: number | null;
  /** Số mẫu có confidence + reward (đầu vào Brier của arm). */
  n: number;
}

/** Trajectory một arm. */
export interface ArmTrajectory {
  code: string;
  name: string;
  points: TrajectoryPoint[];
}

/** Một ô bảng agent × regime. */
export interface RegimeCell {
  /** Mean reward các phiếu cast trong regime này — null khi n=0. */
  hitRate: number | null;
  n: number;
  /** n < 30 → UI hiển thị "—" + tooltip "chưa đủ mẫu". */
  insufficient: boolean;
}

/** 4 regime cố định theo thứ tự hiển thị. */
export const REGIME_ORDER: MarketRegime[] = [
  "BULL_TREND",
  "BEAR_TREND",
  "SIDEWAYS",
  "VOLATILE",
];

/** Bảng agent × regime: 6 dòng arm × 4 cột regime. */
export interface RegimeTable {
  regimes: MarketRegime[];
  labels: Record<MarketRegime, string>;
  rows: { code: string; name: string; cells: Record<MarketRegime, RegimeCell> }[];
  /** true = đã xác định regime được cho từng phiếu (có event + chuỗi basket). */
  available: boolean;
}

/** Shape GET /api/ml/analytics — hợp đồng UI (tab "Hiệu năng & calibration"). */
export interface AnalyticsPayload {
  ok: true;
  generatedAt: string;
  arms: AnalyticsArm[];
  brier: {
    /** Brier thô (nhị phân hoá) trên toàn bộ phiếu có confidence — null khi 0 mẫu. */
    overall: number | null;
    decomposition: BrierDecomposition | null;
    arms: ArmBrier[];
  };
  calibration: CalibrationBucket[];
  trajectory: ArmTrajectory[];
  regimeTable: RegimeTable;
  /** Tổng BanditEvent đã settle (reward != null). */
  totalSettled: number;
}

/* ═══════════════════════ Posterior trajectory ═══════════════════════ */

/** Số điểm trajectory giữ tối đa mỗi arm (~1 năm settle hằng ngày). */
export const TRAJECTORY_MAX_POINTS = 250;

/** Một điểm trajectory: posteriorMean tích luỹ ngay sau settle đó. */
export interface TrajectoryPoint {
  /** ISO string của settledAt (chuẩn hoá sau toPlain). */
  settledAt: string;
  posteriorMean: number;
}

/** Event settle tối thiểu để dựng trajectory. */
export interface TrajectoryEvent {
  settledAt: Date | string;
  reward: number;
}

/**
 * Trajectory posterior Beta từng arm theo timeline settle: khởi từ prior
 * Beta(1,1), sau MỖI phiếu settle: alpha += reward, beta += 1−reward
 * (đúng cập nhật của settlePendingRewards — bandit.ts:303-311), điểm =
 * (alpha+1)/(alpha+beta+2). Cuối chuỗi khớp BanditArm hiện tại khi mọi
 * event đều nằm trong truy vấn. Giữ tối đa TRAJECTORY_MAX_POINTS điểm
 * CUỐI (điểm cũ nhất bỏ — đủ xem xu hướng "từng tốt rồi sa sút" spec A2.3).
 */
export function posteriorTrajectory(
  events: TrajectoryEvent[]
): TrajectoryPoint[] {
  const sorted = [...events]
    .map((e) => ({
      at: e.settledAt instanceof Date ? e.settledAt.getTime() : new Date(e.settledAt).getTime(),
      reward: e.reward,
    }))
    .sort((a, b) => a.at - b.at);
  let alpha = 1;
  let beta = 1;
  const points: TrajectoryPoint[] = [];
  for (const e of sorted) {
    alpha += e.reward;
    beta += 1 - e.reward;
    points.push({
      settledAt: new Date(e.at).toISOString(),
      posteriorMean: (alpha + 1) / (alpha + beta + 2),
    });
  }
  return points.slice(-TRAJECTORY_MAX_POINTS);
}

/* ═════════════════ Regime tại thời điểm cast (bảng agent × regime) ═══ */

/** Thanh giá tối thiểu {date, close} cho chuỗi basket. */
export interface DatedCloseLite {
  date: Date;
  close: number;
}

/**
 * Basket index equal-weight CÓ NGÀY: mỗi mã chuẩn hoá = close tại phiên
 * ĐẦU của chính nó trong cửa sổ nạp, index(d) = TB các mã có bar tại d —
 * cùng semantics buildBasketIndex của caller hiện có (bayes/evidence.ts
 * :849-868 dùng cho classifyRegime), bổ sung trục ngày để cắt PIT.
 */
export function buildDatedBasketIndex(
  series: DatedCloseLite[][]
): { date: Date; value: number }[] {
  const usable = series.filter((s) => s.length > 0);
  if (usable.length === 0) return [];
  // base của mỗi mã = close tại phiên đầu tiên của nó trong cửa sổ —
  // chuẩn hoá về 1 (cùng semantics regime.ts docstring) rồi trung bình
  const normalizedBySymbol = usable.map((s) => {
    const base = s[0].close > 0 ? s[0].close : 1;
    const m = new Map<string, number>();
    for (const b of s) {
      if (b.close > 0) m.set(b.date.toISOString().slice(0, 10), b.close / base);
    }
    return m;
  });
  // Lịch giao dịch hợp nhất (tăng dần)
  const dateSet = new Set<string>();
  const byDate = new Map<string, Date>();
  for (const bars of usable) {
    for (const b of bars) {
      const iso = b.date.toISOString().slice(0, 10);
      if (!dateSet.has(iso)) {
        dateSet.add(iso);
        byDate.set(iso, b.date);
      }
    }
  }
  const dates = [...dateSet].sort();
  const out: { date: Date; value: number }[] = [];
  for (const iso of dates) {
    let sum = 0;
    let count = 0;
    for (const m of normalizedBySymbol) {
      const v = m.get(iso);
      if (v != null) {
        sum += v;
        count++;
      }
    }
    if (count > 0) out.push({ date: byDate.get(iso) as Date, value: sum / count });
  }
  return out;
}

/**
 * Timeline regime theo NGÀY: key = ISO "YYYY-MM-DD", value = regime tính
 * từ chuỗi basket ĐẾN NGÀY ĐÓ (classifyRegime trên slice — thuần PIT,
 * không nhìn tương lai). Chuỗi < 21 phiên classifyRegime tự trả SIDEWAYS.
 */
export function regimeTimeline(
  basketIndex: { date: Date; value: number }[]
): Map<string, MarketRegime> {
  const timeline = new Map<string, MarketRegime>();
  const closes = basketIndex.map((p) => p.value);
  for (let i = 0; i < basketIndex.length; i++) {
    const iso = basketIndex[i].date.toISOString().slice(0, 10);
    timeline.set(iso, classifyRegime(closes.slice(0, i + 1)).regime);
  }
  return timeline;
}

/**
 * Regime tại một mốc thời gian cast: regime của PHIÊN GIAO DỊCH CUỐI
 * tại/b trước mốc (cùng quy ước castDate của settle — bandit.ts:251; so
 * sánh trực tiếp trên Date nên không lệch múi giờ lưu trữ).
 * Trả null khi chưa có phiên nào tại/b trước mốc (thực tế không xảy ra
 * với chuỗi bar dài) — caller bỏ phiếu đó khỏi bảng agent × regime.
 */
export function regimeAt(
  timeline: Map<string, MarketRegime>,
  sortedDates: Date[],
  castAt: Date
): MarketRegime | null {
  const target = castAt.getTime();
  // binary search: phiên cuối có date ≤ castAt
  let lo = 0;
  let hi = sortedDates.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sortedDates[mid].getTime() <= target) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return null;
  return timeline.get(sortedDates[found].toISOString().slice(0, 10)) ?? null;
}
