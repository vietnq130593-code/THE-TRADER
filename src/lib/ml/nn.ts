/**
 * src/lib/ml/nn.ts — MẠNG NƠ-RON MLP THẬT, KIẾN TRÚC N-LỚP TÙY CHỈNH (#94 · Task 3).
 *
 * Backprop VIẾT TAY (cross-entropy + class-weight 1/freq × trọng số loss từng
 * đầu ra) + tối ưu Adam (β1 0,9 · β2 0,999 · ε 1e-8) + L2 weight-decay (chỉ
 * áp lên W, không áp bias). Khởi tạo He-normal, trọng số lưu Float64Array
 * phẳng để chạy nhanh trên Bun. Kiến trúc mặc định **v2-lag16:
 * 16 → 24 ReLU → 12 ReLU → 3 softmax (747 tham số)** — nhưng giờ mỗi lớp ẩn
 * (1..5 lớp, 2..96 nơ-rôn) có activation riêng relu | tanh | sigmoid.
 *
 * Serialize format MỚI (#94): { arch: "16-24-12-3", activations: ["relu","relu"],
 * blocks: [{W, b} × hidden.length], norm }. `fromJSON` nạp được CẢ HAI định
 * dạng — bản cũ W1/b1/W2/b2/W3/b3 (v8 serving "10-16-8-3", v19+ "16-24-12-3")
 * map thành blocks tương đương với activation relu — bản serving đang chạy
 * không được vỡ (cửa hoán đổi theo cổng B2 giữ nguyên hợp đồng).
 *
 * Quy ước class: 0 = DOWN · 1 = FLAT · 2 = UP. predictProba trả theo thứ tự
 * [pUp, pFlat, pDown] cho dễ dùng phía serving/Bayes. Cut train/val THEO THỜI
 * GIAN (val = block cuối — không leakage tương lai, tỷ lệ tuỳ chỉnh
 * valFraction mặc định 0,2), shuffle chỉ trong train split. Early-stop patience
 * theo valLoss (KHÔNG weighting), khôi phục trọng số tốt nhất.
 *
 * RNG seed cố định (mulberry32, tuỳ chỉnh qua opts.seed mặc định 42) → kết quả
 * huấn luyện deterministic/lặp lại được — metrics trung thực.
 */

/** Tham số chuẩn hoá z-score nhúng vào mô hình khi lưu (weights + norm). */
export interface MlpNorm {
  mean: number[];
  std: number[];
}

/** Metrics huấn luyện — khớp hợp đồng FE DlMlpMetrics. */
export interface MlpMetrics {
  epochs: number;
  samples: number;
  trainAcc: number;
  valAcc: number;
  trainLoss: number;
  valLoss: number;
}

/** Hàm kích hoạt của TỪNG lớp ẩn — relu giữ hành vi trước #94 (mặc định). */
export type MlpActivation = "relu" | "tanh" | "sigmoid";

/** Danh sách activation hợp lệ — validate của tuning.ts/UI dùng lại (một nguồn). */
export const MLP_ACTIVATIONS: readonly MlpActivation[] = ["relu", "tanh", "sigmoid"];

/**
 * Kiến trúc MLP N-layer (#94): hidden 1..5 lớp, mỗi lớp 2..96 nơ-rôn, mỗi lớp
 * một activation riêng. `in` do featureSet quyết định (lag16 = 16), `out` = 3.
 */
export interface MlpArch {
  in: number;
  hidden: number[];
  out: number;
}

/**
 * Kiến trúc v2-lag16 (B1 — ML_OPS_BLUEPRINT §4): IN 16 → 24 ReLU → 12 ReLU →
 * OUT 3 = 24×16+24 + 12×24+12 + 3×12+3 = **747 tham số** (~84 mẫu/tham số
 * danh nghĩa trên 60k mẫu — vùng an toàn so GRU §B3).
 */
export const MLP_ARCH_V2: MlpArch = { in: 16, hidden: [24, 12], out: 3 };

/** Chuỗi arch canonical "in-hidden…-out" (ghi vào weights JSON khi lưu). */
export function mlpArchString(arch: MlpArch): string {
  return `${arch.in}-${arch.hidden.join("-")}-${arch.out}`;
}

/**
 * Parse "in-hidden…-out" → MlpArch. Chuỗi 3..7 phần nguyên dương (đầu vào −
 * 1..5 lớp ẩn − đầu ra): "16-8-3" (1 lớp ẩn) · "16-24-12-3" (2 lớp, giữ
 * nguyên nghĩa bản cũ) · "16-24-12-8-3" (3 lớp). Throw khi sai format —
 * fromJSON dùng để chặn JSON hỏng.
 */
export function parseMlpArch(s: string): MlpArch {
  const parts = s.split("-");
  if (parts.length < 3 || parts.length > 7) {
    throw new Error(`arch MLP sai định dạng (cần 3..7 phần, nhận ${parts.length}): "${s}"`);
  }
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new Error(`arch MLP sai số: "${s}"`);
  }
  return { in: nums[0], hidden: nums.slice(1, -1), out: nums[nums.length - 1] };
}

/**
 * Chuẩn hoá mảng activation về đúng độ dài lớp ẩn: thiếu →補 "relu" (giữ hành
 * vi bản cũ), thừa → cắt. Giá trị lạ → "relu" (fail-safe phục vụ serving).
 * Nhận `unknown` — từJSON có thể thiếu/trống/bất kỳ kiểu gì.
 */
export function normalizeActivations(acts: unknown, hiddenCount: number): MlpActivation[] {
  const out: MlpActivation[] = [];
  const src = Array.isArray(acts) ? (acts as unknown[]) : [];
  for (let i = 0; i < hiddenCount; i++) {
    const v = src[i];
    out.push(v === "tanh" || v === "sigmoid" || v === "relu" ? v : "relu");
  }
  return out;
}

const ADAM_B1 = 0.9;
const ADAM_B2 = 0.999;
const ADAM_EPS = 1e-8;
const LEARNING_RATE = 0.01;
const BATCH_SIZE = 32;
const MAX_EPOCHS = 60;
const PATIENCE = 12;
const VAL_FRACTION = 0.2;
const RNG_SEED = 42;
const L2 = 0;
const LOSS_WEIGHTS: readonly [number, number, number] = [1, 1, 1];

/**
 * Tuỳ chọn huấn luyện MLP (#89 + #94). Mặc định từng trường = hằng số phía
 * trên — không truyền thì hành vi GIỮ NGUYÊN như trước #94 (deterministic,
 * seed 42, valFraction 0,2, không L2, lossWeights đều 1).
 */
export interface MlpFitOptions {
  learningRate?: number;
  batchSize?: number;
  maxEpochs?: number;
  patience?: number;
  /** Nhân với class-weight tự động 1/tần suất — thứ tự class [DOWN, FLAT, UP]. */
  lossWeights?: readonly [number, number, number];
  /** Weight-decay L2 — áp CHỈ lên W, không áp bias. */
  l2?: number;
  /** Tỷ lệ val (block cuối, cut theo thời gian) — 0,1..0,4 hợp lý. */
  valFraction?: number;
  /** Seed RNG (init + shuffle) — deterministic khi cố định. */
  seed?: number;
}

/** Mặc định fit — nguồn sự thật duy nhất cho ml/tuning.ts (không copy số). */
export const MLP_FIT_DEFAULTS: Readonly<Required<MlpFitOptions>> = {
  learningRate: LEARNING_RATE,
  batchSize: BATCH_SIZE,
  maxEpochs: MAX_EPOCHS,
  patience: PATIENCE,
  lossWeights: [...LOSS_WEIGHTS] as [number, number, number],
  l2: L2,
  valFraction: VAL_FRACTION,
  seed: RNG_SEED,
};

/** RNG mulberry32 — deterministic, đủ tốt cho init/shuffle/ε-greedy. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Softmax ổn định số học (trừ max trước khi mũ hoá). */
function softmax(z: Float64Array): Float64Array {
  let max = -Infinity;
  for (let i = 0; i < z.length; i++) if (z[i] > max) max = z[i];
  let sum = 0;
  const out = new Float64Array(z.length);
  for (let i = 0; i < z.length; i++) {
    out[i] = Math.exp(z[i] - max);
    sum += out[i];
  }
  for (let i = 0; i < z.length; i++) out[i] /= sum;
  return out;
}

/** Kích hoạt lớp ẩn theo loại. */
function activate(kind: MlpActivation, z: number): number {
  switch (kind) {
    case "tanh":
      return Math.tanh(z);
    case "sigmoid":
      return 1 / (1 + Math.exp(-z));
    default: // relu
      return z > 0 ? z : 0;
  }
}

/**
 * Đạo hàm activation tính từ GIÁ TRỊ SAU kích hoạt a (không cần z):
 * relu: a>0?1:0 (a = max(0,z)) · tanh: 1−a² · sigmoid: a(1−a).
 */
function actDerivFromOut(kind: MlpActivation, a: number): number {
  switch (kind) {
    case "tanh":
      return 1 - a * a;
    case "sigmoid":
      return a * (1 - a);
    default: // relu
      return a > 0 ? 1 : 0;
  }
}

/** Cache forward — activation từng lớp ẩn + xác suất softmax đầu ra. */
interface MlpForwardCache {
  a: Float64Array[];
  p: Float64Array;
}

/** Mô hình MLP — dùng như class: new MLP() → fit → predictProba. */
export class MLP {
  private readonly arch: MlpArch;
  /** Activation TỪNG lớp ẩn — độ dài = hidden.length. */
  readonly activations: MlpActivation[];
  /** Trọng số phẳng Ws[l][to×from] (row-major) + bias bs[l] — l chạy trên lớp ẩn. */
  private Ws: Float64Array[];
  private bs: Float64Array[];
  /** Chuẩn hoá z-score đặc trưng (set sau khi fit trên X đã chuẩn hoá). */
  norm: MlpNorm | null = null;

  constructor(
    arch: MlpArch = MLP_ARCH_V2,
    activations?: readonly MlpActivation[],
    seed: number = RNG_SEED
  ) {
    // Guard kiến trúc — 1..5 lớp ẩn, mỗi lớp ≥ 1 nơ-rôn (parseMlpArch đã ép
    // chuỗi arch; đây chặn caller dựng object tay).
    if (
      !Array.isArray(arch.hidden) ||
      arch.hidden.length < 1 ||
      arch.hidden.length > 5 ||
      arch.hidden.some((h) => !Number.isInteger(h) || h < 1) ||
      !Number.isInteger(arch.in) ||
      arch.in < 1 ||
      !Number.isInteger(arch.out) ||
      arch.out < 1
    ) {
      throw new Error(
        `arch MLP không hợp lệ: in=${arch.in} hidden=[${arch.hidden?.join(",")}] out=${arch.out}`
      );
    }
    this.arch = arch;
    this.activations = normalizeActivations(activations ?? [], arch.hidden.length);
    const rng = mulberry32(seed);
    // He initialization — mọi activation (đơn giản, deterministic).
    const init = (rows: number, cols: number) => {
      const arr = new Float64Array(rows * cols);
      const scale = Math.sqrt(2 / cols); // fanIn = cols
      for (let i = 0; i < arr.length; i++) arr[i] = (rng() * 2 - 1) * scale;
      return arr;
    };
    this.Ws = [];
    this.bs = [];
    let from = arch.in;
    for (const h of arch.hidden) {
      this.Ws.push(init(h, from));
      this.bs.push(new Float64Array(h));
      from = h;
    }
    // Khối RA (softmax) — Ws/bs chỉ số L (cuối) — cùng mảng với các lớp ẩn.
    this.Ws.push(init(arch.out, from));
    this.bs.push(new Float64Array(arch.out));
  }

  /** Số tham số khả huấn luyện (metrics/nghiệm thu ghi rõ). */
  get paramCount(): number {
    let count = 0;
    let from = this.arch.in;
    for (const h of this.arch.hidden) {
      count += h * from + h;
      from = h;
    }
    count += this.arch.out * from + this.arch.out;
    return count;
  }

  /** Chuỗi arch "in-hidden…-out" của bản này. */
  get archString(): string {
    return mlpArchString(this.arch);
  }

  /** Số chiều đầu vào của arch (caller kiểm tương thích featureSet). */
  get inputSize(): number {
    return this.arch.in;
  }

  /** Forward 1 mẫu (đã chuẩn hoá) → softmax 3 class [DOWN, FLAT, UP]. */
  private forward(x: readonly number[], cache: MlpForwardCache): void {
    const { in: IN, hidden, out: OUT } = this.arch;
    let input: readonly number[] | Float64Array = x;
    for (let l = 0; l < hidden.length; l++) {
      const to = hidden[l];
      const from = l === 0 ? IN : hidden[l - 1];
      const W = this.Ws[l];
      const b = this.bs[l];
      const a = cache.a[l];
      for (let j = 0; j < to; j++) {
        let s = b[j];
        const off = j * from;
        for (let k = 0; k < from; k++) s += W[off + k] * input[k];
        a[j] = activate(this.activations[l], s);
      }
      input = a;
    }
    const zOut = new Float64Array(OUT);
    const L = hidden.length; // ≥ 1 (guard constructor)
    const from = hidden[L - 1];
    const W = this.Ws[L];
    const b = this.bs[L];
    for (let j = 0; j < OUT; j++) {
      let s = b[j];
      const off = j * from;
      for (let k = 0; k < from; k++) s += W[off + k] * input[k];
      zOut[j] = s;
    }
    cache.p = softmax(zOut);
  }

  /**
   * Huấn luyện trên X ĐÃ CHUẨN HOÁ (caller dùng standardize trước).
   * Cross-entropy có class-weight w_c = (N/3)/N_c × lossWeights[c] (1/tần suất
   * × tuỳ chỉnh đầu ra, thứ tự [DOWN, FLAT, UP]) — val loss KHÔNG weighting
   * để so sánh epoch ↔ epoch công bằng. L2 (opts.l2) áp CHỈ lên W. Cut
   * train/val theo THỜI GIAN với tỷ lệ opts.valFraction (val = block cuối).
   * Xếp độ dài theo cột arch.in (bản lag16 16 chiều — caller cùng featureSet).
   */
  fit(X: number[][], y: number[], opts: MlpFitOptions = {}): MlpMetrics {
    const { in: IN, hidden, out: OUT } = this.arch;
    const n = X.length;
    if (n < OUT * 10) throw new Error(`MLP fit cần ≥ ${OUT * 10} mẫu, nhận ${n}`);
    for (const row of X) {
      if (row.length !== IN) {
        throw new Error(`MLP fit nhận vector ${row.length} chiều ≠ arch ${IN} (featureSet lệch?)`);
      }
    }
    // #94 — hyper do caller truyền (tab Tinh chỉnh + trình chỉnh sửa kiến trúc)
    // hoặc mặc định module; seed điều khiển shuffle (độc lập init constructor).
    const lr = opts.learningRate ?? LEARNING_RATE;
    const batchSize = Math.max(1, Math.round(opts.batchSize ?? BATCH_SIZE));
    const maxEpochs = Math.max(1, Math.round(opts.maxEpochs ?? MAX_EPOCHS));
    const patience = Math.max(1, Math.round(opts.patience ?? PATIENCE));
    const l2 = Math.max(0, opts.l2 ?? L2);
    const valFraction = Math.min(0.5, Math.max(0.05, opts.valFraction ?? VAL_FRACTION));
    const seed = Math.max(0, Math.round(opts.seed ?? RNG_SEED));
    const lossW = opts.lossWeights ?? LOSS_WEIGHTS;
    const rng = mulberry32(seed + 7);

    // Class-weight 1/freq × lossWeights (mất class → weight 1)
    const counts = [0, 0, 0];
    for (const label of y) counts[label]++;
    const weights = counts.map((c, i) => (c > 0 ? (n / 3 / c) * (lossW[i] ?? 1) : lossW[i] ?? 1));

    // Cut theo THỜI GIAN với tỷ lệ valFraction — val là block cuối
    const nTrain = Math.floor(n * (1 - valFraction));
    const trainIdx: number[] = [];
    for (let i = 0; i < nTrain; i++) trainIdx.push(i);
    const valIdx: number[] = [];
    for (let i = nTrain; i < n; i++) valIdx.push(i);

    // Adam state cho từng khối tham số: [W0..WL-1, b0..bL-1] + khối ra.
    // Quy ước blocks: 0..hidden.length-1 = W ẩn, hidden.length..2L-1 = b ẩn,
    // 2L = W ra, 2L+1 = b ra (paramCount blocks = 2L + 2).
    const L = hidden.length;
    const params: Float64Array[] = [];
    for (let l = 0; l < L; l++) params.push(this.Ws[l]);
    for (let l = 0; l < L; l++) params.push(this.bs[l]);
    params.push(this.Ws[L]); // W ra
    params.push(this.bs[L]); // b ra
    const grads = params.map((p) => new Float64Array(p.length));
    const m = params.map((p) => new Float64Array(p.length));
    const v = params.map((p) => new Float64Array(p.length));
    let adamStep = 0;

    // Cache forward + gradient trung gian (tái sử dụng — không alloc trong loop)
    const cache: MlpForwardCache = {
      a: hidden.map((h) => new Float64Array(h)),
      p: new Float64Array(OUT),
    };
    const dzOut = new Float64Array(OUT);
    const delta = new Float64Array(Math.max(...hidden, OUT));
    const deltaNext = new Float64Array(Math.max(...hidden, OUT));

    const snapshot = () => params.map((p) => p.slice());
    let bestValLoss = Infinity;
    let bestWeights = snapshot();
    let stale = 0;
    let epochsRan = 0;

    for (let epoch = 1; epoch <= maxEpochs; epoch++) {
      epochsRan = epoch;
      // Shuffle CHỈ trong train split (Fisher-Yates)
      for (let i = trainIdx.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [trainIdx[i], trainIdx[j]] = [trainIdx[j], trainIdx[i]];
      }

      for (let start = 0; start < trainIdx.length; start += batchSize) {
        const end = Math.min(trainIdx.length, start + batchSize);
        const bs = end - start;
        for (const g of grads) g.fill(0);

        for (let bi = start; bi < end; bi++) {
          const i = trainIdx[bi];
          const x = X[i];
          this.forward(x, cache);

          // Gradient cross-entropy lớp ra (class-weight × lossWeights, mean batch)
          const cw = weights[y[i]] / bs;
          dzOut.fill(0);
          for (let c = 0; c < OUT; c++) dzOut[c] = (cache.p[c] - (c === y[i] ? 1 : 0)) * cw;
          delta.set(dzOut);

          // Backward từ lớp ra xuống lớp ẩn đầu — l = L là KHỐI RA.
          for (let l = L; l >= 0; l--) {
            const to = l === L ? OUT : hidden[l];
            const from = l === 0 ? IN : l === L ? hidden[L - 1] : hidden[l - 1];
            const prev: readonly number[] | Float64Array = l === 0 ? x : cache.a[l - 1];
            const gW = grads[l === L ? 2 * L : l]; // W của lớp l (ra = 2L)
            const gb = grads[l === L ? 2 * L + 1 : L + l]; // b của lớp l (ra = 2L+1)
            for (let j = 0; j < to; j++) {
              const d = delta[j];
              gb[j] += d;
              const off = j * from;
              for (let k = 0; k < from; k++) gW[off + k] += d * prev[k];
            }
            if (l > 0) {
              // Truyền delta về activation output lớp l-1 rồi nhân đạo hàm.
              deltaNext.fill(0);
              const W = this.Ws[l];
              for (let j = 0; j < to; j++) {
                const d = delta[j];
                const off = j * from;
                for (let k = 0; k < from; k++) deltaNext[k] += W[off + k] * d;
              }
              const actPrev = this.activations[l - 1];
              const aPrev = cache.a[l - 1];
              for (let k = 0; k < from; k++) {
                deltaNext[k] *= actDerivFromOut(actPrev, aPrev[k]);
              }
              delta.set(deltaNext.subarray(0, from));
            }
          }
        }

        // Cập nhật Adam trên mọi khối — L2 áp CHỈ lên W (không áp bias).
        adamStep++;
        const lrT =
          lr * Math.sqrt(1 - Math.pow(ADAM_B2, adamStep)) / (1 - Math.pow(ADAM_B1, adamStep));
        for (let pi = 0; pi < params.length; pi++) {
          const p = params[pi];
          const g = grads[pi];
          const mm = m[pi];
          const vv = v[pi];
          const isWeight = pi < L || pi === 2 * L; // W ẩn + W ra
          for (let k = 0; k < p.length; k++) {
            const gk = isWeight ? g[k] + l2 * p[k] : g[k];
            mm[k] = ADAM_B1 * mm[k] + (1 - ADAM_B1) * gk;
            vv[k] = ADAM_B2 * vv[k] + (1 - ADAM_B2) * gk * gk;
            p[k] -= (lrT * mm[k]) / (Math.sqrt(vv[k]) + ADAM_EPS);
          }
        }
      }

      // Đánh giá val loss (KHÔNG class-weight) + accuracy 2 split mỗi epoch
      let valLoss = 0;
      for (const i of valIdx) {
        this.forward(X[i], cache);
        valLoss += -Math.log(Math.max(cache.p[y[i]], 1e-12));
      }
      valLoss /= Math.max(1, valIdx.length);
      if (valLoss < bestValLoss - 1e-6) {
        bestValLoss = valLoss;
        bestWeights = snapshot();
        stale = 0;
      } else {
        stale++;
        if (stale >= patience) break; // early-stop theo valLoss
      }
    }

    // Khôi phục trọng số tốt nhất (theo valLoss)
    for (let pi = 0; pi < params.length; pi++) params[pi].set(bestWeights[pi]);

    // Metrics cuối cùng trên split train (weighted loss) + val (CE thường)
    const evalSplit = (idx: number[], weighted: boolean): { acc: number; loss: number } => {
      let correct = 0;
      let loss = 0;
      for (const i of idx) {
        this.forward(X[i], cache);
        const label = y[i];
        let arg = 0;
        for (let c = 1; c < OUT; c++) if (cache.p[c] > cache.p[arg]) arg = c;
        if (arg === label) correct++;
        loss += -Math.log(Math.max(cache.p[label], 1e-12)) * (weighted ? weights[label] : 1);
      }
      return idx.length > 0 ? { acc: correct / idx.length, loss: loss / idx.length } : { acc: 0, loss: 0 };
    };
    const trainEval = evalSplit(trainIdx, true);
    const valEval = evalSplit(valIdx, false);

    return {
      epochs: epochsRan,
      samples: n,
      trainAcc: Number(trainEval.acc.toFixed(4)),
      valAcc: Number(valEval.acc.toFixed(4)),
      trainLoss: Number(trainEval.loss.toFixed(4)),
      valLoss: Number(valEval.loss.toFixed(4)),
    };
  }

  /** Gắn z-score norm (sau fit trên X đã chuẩn hoá) để predictProba tự áp. */
  setNorm(norm: MlpNorm): void {
    this.norm = norm;
  }

  /**
   * Xác suất 3 class cho 1 vector đặc trưng RAW (tự áp norm nếu có — norm theo
   * arch.in chiều, vector dài hơn tự cắt an toàn). Trả [pUp, pFlat, pDown] —
   * lưu ý mapping ngược với class index nội bộ.
   */
  predictProba(x: number[]): [number, number, number] {
    const input = this.norm ? this.applyNormInternal(x) : x;
    const cache: MlpForwardCache = {
      a: this.arch.hidden.map((h) => new Float64Array(h)),
      p: new Float64Array(this.arch.out),
    };
    this.forward(input, cache);
    return [cache.p[2], cache.p[1], cache.p[0]]; // [UP, FLAT, DOWN]
  }

  /** Dự đoán hàng loạt (raw features — norm tự áp). Trả [pUp,pFlat,pDown][]. */
  predictBatch(X: number[][]): [number, number, number][] {
    return X.map((x) => this.predictProba(x));
  }

  private applyNormInternal(x: number[]): number[] {
    const { mean, std } = this.norm as MlpNorm;
    return x.map((v, j) => (v - (mean[j] ?? 0)) / ((std[j] ?? 1) || 1));
  }

  /**
   * Serialize trọng số + norm + arch + activations → chuỗi JSON lưu cột
   * MlModel.weights. Format MỚI #94: blocks[{W, b} × hidden.length] (khối ra
   * là blocks cuối). fromJSON nạp lại đúng từng byte.
   */
  toJSON(): string {
    const L = this.arch.hidden.length;
    const blocks: { W: number[]; b: number[] }[] = [];
    for (let l = 0; l <= L; l++) {
      blocks.push({
        W: Array.from(this.Ws[l]),
        b: Array.from(this.bs[l]),
      });
    }
    return JSON.stringify({
      arch: this.archString,
      activations: this.activations,
      blocks,
      norm: this.norm,
    });
  }

  /**
   * Nạp mô hình từ JSON — HIỂU CẢ HAI định dạng:
   *  (1) MỚI #94: { arch, activations, blocks: [{W, b}…] } — số blocks =
   *      hidden.length + 1 (kể khối ra).
   *  (2) CŨ (≤ #89): { arch, W1, b1, W2, b2, W3, b3 } — 2 lớp ẩn relu
   *      (v8 serving "10-16-8-3" hay v2 "16-24-12-3") → map thành blocks
   *      tương đương. Bản serving đang chạy không được vỡ.
   * Throw khi JSON hỏng/sai kiến trúc (đủ/thiếu khối trọng số).
   */
  static fromJSON(json: string): MLP {
    const raw = JSON.parse(json) as {
      arch?: string;
      activations?: unknown;
      blocks?: unknown;
      W1?: number[];
      b1?: number[];
      W2?: number[];
      b2?: number[];
      W3?: number[];
      b3?: number[];
      norm?: MlpNorm | null;
    };
    const arch = parseMlpArch(raw.arch ?? "");
    const activations = normalizeActivations(raw.activations, arch.hidden.length);
    const mlp = new MLP(arch, activations, 1); // init tạm — ghi đè bằng trọng số JSON
    const copy = (src: number[] | undefined, len: number, name: string): Float64Array => {
      if (!Array.isArray(src) || src.length !== len) {
        throw new Error(`MLP weights thiếu ${name} (arch ${mlpArchString(arch)})`);
      }
      return Float64Array.from(src);
    };

    if (Array.isArray(raw.blocks)) {
      // Format MỚI — blocks.length phải = hidden.length + 1 (kể khối ra).
      const L = arch.hidden.length;
      const blocks = raw.blocks as { W?: number[]; b?: number[] }[];
      if (blocks.length !== L + 1) {
        throw new Error(
          `MLP weights blocks ${blocks.length} khối ≠ arch ${L + 1} (hidden ${L} + ra 1)`
        );
      }
      let from = arch.in;
      for (let l = 0; l <= L; l++) {
        const to = l === L ? arch.out : arch.hidden[l];
        mlp.Ws[l] = copy(blocks[l].W, to * from, `blocks[${l}].W`);
        mlp.bs[l] = copy(blocks[l].b, to, `blocks[${l}].b`);
        from = to;
      }
    } else {
      // Format CŨ W1..b3 — chính xác 2 lớp ẩn (bản trước #94).
      if (arch.hidden.length !== 2) {
        throw new Error(
          `MLP weights định dạng cũ W1..b3 nhưng arch ${mlpArchString(arch)} có ${arch.hidden.length} lớp ẩn`
        );
      }
      const { in: IN, hidden, out: OUT } = arch;
      const [H1, H2] = hidden;
      mlp.Ws[0] = copy(raw.W1, H1 * IN, "W1");
      mlp.bs[0] = copy(raw.b1, H1, "b1");
      mlp.Ws[1] = copy(raw.W2, H2 * H1, "W2");
      mlp.bs[1] = copy(raw.b2, H2, "b2");
      mlp.Ws[2] = copy(raw.W3, OUT * H2, "W3");
      mlp.bs[2] = copy(raw.b3, OUT, "b3");
    }
    mlp.norm = raw.norm ?? null;
    return mlp;
  }
}
