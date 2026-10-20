/**
 * src/lib/ml/rl.ts — Q-LEARNING TABULAR THẬT trên rổ top-10 thanh khoản
 * (phiên #35). Không dùng thư viện — bảng Q 96 trạng thái × 3 hành động khi có
 * regimeBits VNINDEX (F-13 #129; 48 trạng thái legacy khi thiếu — tương thích
 * Q-table v13 cũ), cập nhật Q[s,a] += α(r + γ·maxQ[s'] − Q[s,a]).
 *
 * AUDIT 137 B2 — công thức index 96-state đã vá thiếu ngoặc (xem stateIndexAt):
 * 36/96 trạng thái hiệu dụng trước vá; verify scripts/p137-verify-rl-states.ts.
 *
 * W4 (#165 · review #162): HOLDOUT WALK-FORWARD — train chỉ trên đoạn ĐẦU
 * [0, m) của chuỗi rổ (m = n − H, H = qHoldoutBars(n)); đoạn CUỐI [m, n) giữ
 * ra làm holdout: chính sách greedy argmax Q đánh giá trên đó (ε=0, KHÔNG
 * cập nhật Q) cùng công thức reward, so 3 baseline cùng đoạn (giữ 50% ·
 * mua-giữ 100% · cash 0%). avgRewardLast50 giờ là số in-training trên TRAIN
 * split — số ngoài mẫu nằm ở holdout (mirror kỷ luật MLP sweep audit 137 B4:
 * cut theo THỜI GIAN, không xáo trộn; holdout chỉ đo, không dùng chọn lựa
 * nên không tạo selection bias). opts.holdout=0 / không truyền → hành vi cũ
 * (train toàn chuỗi, không field holdout) — additive.
 *
 * State 48 = xu hướng (SMA20>SMA50 ? 1:0) × 4 bucket RSI rổ (<30/30-50/
 * 50-70/≥70) × mom5 (≥0 ? 1:0) × 3 bucket phơi nhiễm (0 / 0,5 / 1)
 *       = 2×4×2×3. Hành động 0/1/2 = giảm/hold/tăng exposure (±0,5, clamp
 * 0..1). Reward = exposure×ret(t+1) − 0,001×|Δexposure| (phạt giao dịch).
 *
 * Episode: random start trong chuỗi rổ, ~230 bước; 300 episode; ε-greedy
 * khám phá 1,0 → 0,05 (decay ×0,99/episode); α=0,1 · γ=0,95. RNG seed
 * cố định → deterministic. policyStance() tính state HIỆN TẠI rồi argmax Q.
 */

/** Kết quả kiểm định ngoài mẫu W4 (#165) — đoạn holdout [m, n) của chuỗi rổ. */
export interface QHoldoutResult {
  /** Số phiên giữ ra khỏi train (H = n − m). */
  bars: number;
  /** Số bước đánh giá (t ∈ [m, n−1) — mỗi bước có retNext). */
  steps: number;
  /** Phần thưởng trung bình MỖI BƯỚC của chính sách greedy argmax Q. */
  avgRewardPerStep: number;
  /** Baseline đo trên CÙNG đoạn holdout (per-step, cùng công thức reward):
   *  hold50 = giữ exposure 0,5 suốt · buyHold = mua-giữ exposure 1 · cash = 0. */
  baselines: { hold50: number; buyHold: number; cash: number };
  /** avgRewardPerStep − baselines.hold50 (dương = thắng "giữ nửa"). */
  edgeVsHold50: number;
  /** avgRewardPerStep − baselines.buyHold (dương = thắng mua-giữ). */
  edgeVsBuyHold: number;
}

/** Kết quả huấn luyện Q-table. */
export interface QTrainResult {
  qTable: number[][]; // [48][3] hoặc [96][3]
  episodes: number;
  epsilonEnd: number;
  avgRewardFirst50: number;
  avgRewardLast50: number;
  states: number;
  actions: number;
  /** W4 (#165) — undefined khi holdout tắt (hành vi cũ / dữ liệu tối thiểu). */
  holdout?: QHoldoutResult;
}

/** Khuyến nghị chính sách tại thời điểm hiện tại. */
export interface PolicyStance {
  stance: "tăng" | "giữ" | "giảm";
  exposure: number;
  qMax: number;
  probsSoftmax: number[]; // [giảm, giữ, tăng]
}

const RL_ALPHA = 0.1;
const RL_GAMMA = 0.95;
const RL_EPISODES = 300;
const RL_EPS_START = 1.0;
const RL_EPS_DECAY = 0.99;
const RL_EPS_MIN = 0.05;
const RL_STEPS = 230;
const RL_EXPOSURE_STEP = 0.5;
const RL_TRANSACTION_COST = 0.001;
const RL_STATES = 48;
/** F-13 (#129): bảng 96 trạng thái (thêm bit regime VNINDEX). */
export const RL_STATES_V2 = 96;
const RL_ACTIONS = 3;
const RL_RNG_SEED = 123;
/** Nhiệt độ softmax khi diễn giải Q thành xác suất (nhỏ = quyết đoán hơn). */
const RL_SOFTMAX_TEMP = 0.25;

/* ───────────── W4 (#165) — holdout walk-forward ───────────── */

/** Số phiên giữ ra khỏi train: 10% chuỗi (min 60 · max 200); n < 400 → 0
 *  (dữ liệu tối thiểu — holdout TẮT trung thực, mirror hành vi sweep khi
 *  n − H < 650 thì H co về 0). Train luôn còn ≥ 300 phiên khi H > 0. */
export function qHoldoutBars(n: number): number {
  if (!Number.isFinite(n) || n < 400) return 0;
  return Math.min(200, Math.max(60, Math.floor(n * 0.1)));
}

/** H ≥ 30 mới đánh giá holdout (steps = H−1 ≥ 29 đủ có ý nghĩa; H nhỏ hơn →
 *  coi như tắt — trung thực hơn là báo số trên vài bước). */
const Q_HOLDOUT_MIN_BARS = 30;
/** Sàn số phiên train khi caller truyền holdout tay quá tham (giữ ≥ 300). */
const Q_TRAIN_MIN_BARS = 300;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Rổ equal-weight: mỗi mã chuẩn hoá close[0] = 1 (cửa sổ `window` phiên
 * cuối, căn theo mã ngắn nhất) rồi lấy trung bình. Trả chuỗi rổ hoặc []
 * khi không đủ dữ liệu.
 */
export function buildBasket(closesBySymbol: number[][], window = 1000): number[] {
  const usable = closesBySymbol.filter((c) => c.length >= 60);
  if (usable.length === 0) return [];
  const n = Math.min(window, ...usable.map((c) => c.length));
  if (n < 60) return [];
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

/** Chuỗi chỉ báo rổ cần cho state (sma20/sma50/rsi14/mom5/retNext) O(N).
 *  AUDIT 137 B2 — export type cho script verify enumeration 96 trạng thái
 *  (scripts/p137-verify-rl-states.ts) — additive, không đổi call-site nào. */
export interface BasketStats {
  sma20: (number | null)[];
  sma50: (number | null)[];
  rsi14: (number | null)[];
  mom5: (number | null)[];
  retNext: (number | null)[];
}

function basketStats(b: number[]): BasketStats {
  const n = b.length;
  const sma20: (number | null)[] = new Array(n).fill(null);
  const sma50: (number | null)[] = new Array(n).fill(null);
  const rsi14: (number | null)[] = new Array(n).fill(null);
  const mom5: (number | null)[] = new Array(n).fill(null);
  const retNext: (number | null)[] = new Array(n).fill(null);

  let s20 = 0;
  for (let i = 0; i < n; i++) {
    s20 += b[i];
    if (i >= 20) s20 -= b[i - 20];
    if (i >= 19) sma20[i] = s20 / 20;
  }
  let s50 = 0;
  for (let i = 0; i < n; i++) {
    s50 += b[i];
    if (i >= 50) s50 -= b[i - 50];
    if (i >= 49) sma50[i] = s50 / 50;
  }
  // RSI14 Wilder trên rổ
  if (n >= 15) {
    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= 14; i++) {
      const d = b[i] - b[i - 1];
      if (d > 0) gains += d;
      else losses -= d;
    }
    let avgGain = gains / 14;
    let avgLoss = losses / 14;
    for (let i = 14; i < n; i++) {
      if (i > 14) {
        const d = b[i] - b[i - 1];
        avgGain = (avgGain * 13 + Math.max(d, 0)) / 14;
        avgLoss = (avgLoss * 13 + Math.max(-d, 0)) / 14;
      }
      if (avgGain === 0 && avgLoss === 0) rsi14[i] = null;
      else if (avgLoss === 0) rsi14[i] = 100;
      else rsi14[i] = 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  for (let i = 5; i < n; i++) mom5[i] = b[i] / b[i - 5] - 1;
  for (let i = 0; i < n - 1; i++) retNext[i] = b[i + 1] / b[i] - 1;
  return { sma20, sma50, rsi14, mom5, retNext };
}

/**
 * Chỉ số trạng thái tại phiên i với mức phơi nhiễm cho trước:
 *   48-state (legacy): ((trend×4 + rsiBucket)×2 + mom)×3 + exposureBucket.
 *   F-13 (#129) 96-state: thêm bit regime VNINDEX (SMA50 vs SMA200 —
 *   BULL=1/BEAR=0) làm CHỐ ĐẦU: ((regime×2 + trend)×4 + rsiBucket)×2 + mom)×3
 *   + exposureBucket — "chính sách 1 bộ cho mọi chế độ là sai về kinh tế học".
 * regimeBits == null → bảng 48 legacy (tương thích Q-table v13 đang serving).
 */
export function stateIndexAt(
  st: BasketStats,
  i: number,
  exposure: number,
  regimeBit?: number
): number {
  const sma20 = st.sma20[i];
  const sma50 = st.sma50[i];
  const trend = sma20 != null && sma50 != null && sma20 > sma50 ? 1 : 0;
  const rsi = st.rsi14[i];
  const rsiBucket = rsi == null ? 2 : rsi < 30 ? 0 : rsi < 50 ? 1 : rsi < 70 ? 2 : 3;
  const mom = (st.mom5[i] ?? 0) >= 0 ? 1 : 0;
  const expBucket = exposure < 0.25 ? 0 : exposure <= 0.75 ? 1 : 2;
  if (regimeBit == null) {
    return ((trend * 4 + rsiBucket) * 2 + mom) * 3 + expBucket;
  }
  // AUDIT 137 B2 — thiếu cặp ngoặc quanh "... + mom" trước ×3: bản cũ
  // `A*2 + mom*3 + exp` chỉ sinh 36/96 index duy nhất (60 va chạm, max 35 —
  // enumeration chạy thật), 60 hàng Q-table chết. Công thức ĐÚNG theo comment
  // mô tả ở trên (regime làm CHỐ ĐẦU): ((regime×2+trend)×4+rsi)×2+mom)×3+exp
  // — 2×2×4×2×3 = 96 index duy nhất 0..95 (verify scripts/p137-verify-rl-states.ts).
  return ((((regimeBit ? 2 : 0) + trend) * 4 + rsiBucket) * 2 + mom) * 3 + expBucket;
}

/**
 * Huấn luyện Q-table trên rổ top-10. Nhận ma trận closes từng mã (tự build
 * rổ) hoặc chuỗi rổ đã chuẩn hoá sẵn. ε-greedy 1,0→0,05, 300 episode ×
 * ~230 bước random start.
 *
 * W4 (#165): opts.holdout = số phiên CUỐI giữ ra khỏi train (qHoldoutBars
 * của caller) — episode chỉ start/end trong [warmup, m−1], Bellman clamp
 * sNext vào m−1 (Q-table KHÔNG bao giờ nhìn đoạn [m, n)); sau train đánh
 * giá chính sách greedy trên holdout kèm 3 baseline cùng đoạn. Không truyền
 * / truyền 0 → hành vi cũ nguyên vẹn (train toàn chuỗi, không field holdout).
 */
export function trainQTable(
  closesTop10: number[][] | number[],
  opts: { regimeBits?: number[]; holdout?: number } = {}
): QTrainResult {
  const basket = Array.isArray(closesTop10[0])
    ? buildBasket(closesTop10 as number[][])
    : (closesTop10 as number[]);
  if (basket.length < 80) {
    throw new Error(`Q-learning cần rổ ≥ 80 phiên, nhận ${basket.length}`);
  }
  const st = basketStats(basket);
  const n = basket.length;
  // W4 (#165) — cut theo thời gian: m = n − H; defensive clamp giữ train
  // ≥ 300 phiên khi caller truyền H tay quá tham (qHoldoutBars đã đúng nên
  // đường thường không chạm, chỉ chống số rác).
  let holdoutBars =
    opts.holdout != null && Number.isFinite(opts.holdout) && opts.holdout > 0
      ? Math.floor(opts.holdout)
      : 0;
  if (holdoutBars > 0 && n - holdoutBars < Q_TRAIN_MIN_BARS) {
    holdoutBars = Math.max(0, n - Q_TRAIN_MIN_BARS);
  }
  const m = n - holdoutBars; // episode chỉ sống trong [0, m)
  // F-13 (#129): regimeBits cùng độ dài basket (bit VNINDEX SMA50/SMA200) →
  // bảng 96 trạng thái; thiếu → bảng 48 legacy (tương thích serving v13).
  const useRegime =
    opts.regimeBits != null &&
    opts.regimeBits.length >= basket.length &&
    basket.length >= 200; // cần SMA200 của VNINDEX có nghĩa
  const states = useRegime ? RL_STATES_V2 : RL_STATES;
  const regimeBits = useRegime ? opts.regimeBits! : null;
  const qTable: number[][] = Array.from({ length: states }, () => [0, 0, 0]);
  const rng = mulberry32(RL_RNG_SEED);

  let epsilon = RL_EPS_START;
  const episodeRewards: number[] = [];
  const warmup = 60; // cần sma50/rsi14/mom5 đủ dữ liệu

  for (let ep = 0; ep < RL_EPISODES; ep++) {
    // Random start trong [warmup, m−2]; số bước ≤ 230 (hoặc tới biên train)
    const start = warmup + Math.floor(rng() * Math.max(1, m - 1 - warmup));
    const end = Math.min(m - 1, start + RL_STEPS);
    let exposure = 0.5;
    let totalReward = 0;

    for (let t = start; t < end; t++) {
      const s = stateIndexAt(st, t, exposure, regimeBits != null ? regimeBits[t] : undefined);
      // ε-greedy: khám phá ngẫu nhiên hay khai thác argmax Q
      const action =
        rng() < epsilon
          ? Math.floor(rng() * RL_ACTIONS)
          : qTable[s].indexOf(Math.max(...qTable[s]));

      const newExposure = Math.max(
        0,
        Math.min(1, exposure + (action - 1) * RL_EXPOSURE_STEP)
      );
      const ret = st.retNext[t] ?? 0;
      const reward = exposure * ret - RL_TRANSACTION_COST * Math.abs(newExposure - exposure);
      // W4 (#165): sNext clamp vào m−1 — Bellman không nhìn xuyên qua biên
      // train (đoạn holdout [m, n) hoàn toàn ngoài tầm Q-table).
      const sNext = stateIndexAt(
        st,
        Math.min(t + 1, m - 1),
        newExposure,
        regimeBits != null ? regimeBits[Math.min(t + 1, m - 1)] : undefined
      );
      const maxNext = Math.max(...qTable[sNext]);
      // Cập nhật Bellman: Q ← Q + α(r + γ·maxQ[s'] − Q)
      qTable[s][action] += RL_ALPHA * (reward + RL_GAMMA * maxNext - qTable[s][action]);
      exposure = newExposure;
      totalReward += reward;
    }
    episodeRewards.push(totalReward);
    epsilon = Math.max(RL_EPS_MIN, epsilon * RL_EPS_DECAY);
  }

  const meanSlice = (from: number, to: number): number => {
    const slice = episodeRewards.slice(from, to);
    return slice.length > 0 ? slice.reduce((s, r) => s + r, 0) / slice.length : 0;
  };
  const first50 = meanSlice(0, 50);
  const last50 = meanSlice(RL_EPISODES - 50, RL_EPISODES);

  // W4 (#165) — đánh giá ngoài mẫu trên holdout [m, n): chính sách GREEDY
  // argmax Q (ε=0), KHÔNG cập nhật Q — thuần đo; cùng công thức reward như
  // train. Baseline đo trên CHÍNH đoạn đó: hold50 (giữ 0,5) · buyHold
  // (mua-giữ 1,0) · cash (0). Holdout chỉ ĐO — không dùng để chọn siêu tham
  // số nên không tạo selection bias (mirror kỷ luật MLP sweep audit 137 B4).
  let holdout: QHoldoutResult | undefined;
  if (holdoutBars >= Q_HOLDOUT_MIN_BARS) {
    let exposure = 0.5;
    let policyTotal = 0;
    let steps = 0;
    let retSum = 0;
    for (let t = m; t < n - 1; t++) {
      const ret = st.retNext[t] ?? 0;
      retSum += ret;
      const s = stateIndexAt(
        st,
        t,
        exposure,
        regimeBits != null ? regimeBits[t] : undefined
      );
      const action = qTable[s].indexOf(Math.max(...qTable[s]));
      const newExposure = Math.max(
        0,
        Math.min(1, exposure + (action - 1) * RL_EXPOSURE_STEP)
      );
      policyTotal +=
        exposure * ret - RL_TRANSACTION_COST * Math.abs(newExposure - exposure);
      exposure = newExposure;
      steps++;
    }
    if (steps > 0) {
      const avgPolicy = policyTotal / steps;
      const buyHold = retSum / steps; // exposure 1 suốt — không cost giao dịch
      const hold50 = 0.5 * buyHold;
      holdout = {
        bars: holdoutBars,
        steps,
        avgRewardPerStep: Number(avgPolicy.toFixed(6)),
        baselines: {
          hold50: Number(hold50.toFixed(6)),
          buyHold: Number(buyHold.toFixed(6)),
          cash: 0,
        },
        edgeVsHold50: Number((avgPolicy - hold50).toFixed(6)),
        edgeVsBuyHold: Number((avgPolicy - buyHold).toFixed(6)),
      };
    }
  }

  return {
    qTable,
    episodes: RL_EPISODES,
    epsilonEnd: Number(epsilon.toFixed(4)),
    avgRewardFirst50: Number(first50.toFixed(4)),
    avgRewardLast50: Number(last50.toFixed(4)),
    states,
    actions: RL_ACTIONS,
    ...(holdout != null ? { holdout } : {}),
  };
}

/**
 * Chính sách tại THỜI ĐIỂM HIỆN TẠI: tính state từ dữ liệu rổ mới nhất +
 * exposure hiện tại → argmax Q → khuyến nghị tăng/giữ/giảm, mức exposure
 * mới, Q-max và xác suất softmax (nhiệt độ 0,25) của 3 hành động.
 */
export function policyStance(
  qTable: number[][],
  basket: number[],
  exposure = 0.5,
  regimeBit?: number
): PolicyStance {
  const last = basket.length - 1;
  // F-13 (#129): chấp nhận cả bảng 48 (legacy v13) lẫn 96 (regime-aware).
  if (
    basket.length < 60 ||
    (qTable.length !== RL_STATES && qTable.length !== RL_STATES_V2)
  ) {
    return { stance: "giữ", exposure, qMax: 0, probsSoftmax: [1 / 3, 1 / 3, 1 / 3] };
  }
  const st = basketStats(basket);
  // Bảng 96 bắt buộc regimeBit; bảng 48 bỏ qua (legacy) — trung thực tương thích.
  const s = stateIndexAt(
    st,
    last,
    exposure,
    qTable.length === RL_STATES_V2 ? (regimeBit ?? 0) : undefined
  );
  const q = qTable[s];
  const action = q.indexOf(Math.max(...q)); // 0 giảm · 1 giữ · 2 tăng
  const newExposure = Math.max(0, Math.min(1, exposure + (action - 1) * RL_EXPOSURE_STEP));
  // Softmax có nhiệt độ — Q chênh lệch nhỏ (~0,01-0,1) cần khuếch đại vừa đủ
  const exps = q.map((v) => Math.exp(v / RL_SOFTMAX_TEMP));
  const sum = exps.reduce((a, b) => a + b, 0);
  const probsSoftmax = sum > 0 ? exps.map((e) => Number((e / sum).toFixed(4))) : [1 / 3, 1 / 3, 1 / 3];
  const stance: PolicyStance["stance"] = action === 2 ? "tăng" : action === 0 ? "giảm" : "giữ";
  return {
    stance,
    exposure: Number(newExposure.toFixed(2)),
    qMax: Number(Math.max(...q).toFixed(4)),
    probsSoftmax,
  };
}

/** Parse Q-table từ cột MlModel.weights (kind rl-q). */
export function parseQTable(weightsJson: string): number[][] {
  const raw = JSON.parse(weightsJson) as { qTable?: number[][] };
  // F-13 (#129): bảng 48 (legacy) hoặc 96 (regime-aware) đều hợp lệ.
  if (
    !Array.isArray(raw.qTable) ||
    (raw.qTable.length !== RL_STATES && raw.qTable.length !== RL_STATES_V2)
  ) {
    throw new Error("Q-table hỏng (cần 48 hoặc 96 trạng thái)");
  }
  return raw.qTable.map((row) => (Array.isArray(row) ? row.map(Number) : []));
}

/**
 * F-13 (#129): chuỗi bit regime VNINDEX (SMA50 vs SMA200 tại từng phiên,
 * 1 = BULL) căn theo độ dài rổ — caller truyền chuỗi closes VNINDEX đủ dài;
 * trả mảng bit cùng độ dài basket (session cuối căn theo chuỗi VNINDEX).
 */
export function regimeBitsOf(vnindexCloses: number[], basketLength: number): number[] {
  const n = vnindexCloses.length;
  const bits: number[] = new Array(basketLength).fill(0);
  if (n < 200) return bits; // SMA200 chưa có nghĩa → toàn 0 (trung tính)
  // SMA200 trượt trên chuỗi VNINDEX
  let s200 = 0;
  let s50 = 0;
  const sma200: (number | null)[] = new Array(n).fill(null);
  const sma50: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    s200 += vnindexCloses[i]!;
    if (i >= 200) s200 -= vnindexCloses[i - 200]!;
    if (i >= 199) sma200[i] = s200 / 200;
    s50 += vnindexCloses[i]!;
    if (i >= 50) s50 -= vnindexCloses[i - 50]!;
    if (i >= 49) sma50[i] = s50 / 50;
  }
  const bitAt = (i: number): number => {
    const a = sma50[i];
    const b = sma200[i];
    return a != null && b != null && b > 0 && a > b ? 1 : 0;
  };
  // căn ĐUÔI chuỗi (basket = N phiên cuối): bit[j] ứng phiên vnindex[n − basketLength + j]
  for (let j = 0; j < basketLength; j++) {
    const idx = n - basketLength + j;
    bits[j] = idx >= 0 ? bitAt(idx) : 0;
  }
  return bits;
}
