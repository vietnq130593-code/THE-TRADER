/**
 * src/lib/ml/nn.ts — MẠNG NƠ-RON MLP THẬT, KIẾN TRÚC THAM SỐ HOÁ (B1 #81).
 *
 * Backprop VIẾT TAY (cross-entropy + class-weight 1/freq) + tối ưu Adam
 * (β1 0,9 · β2 0,999 · ε 1e-8). Khởi tạo He-normal, trọng số lưu Float64Array
 * phẳng để chạy nhanh trên Bun. Kiến trúc mặc định **v2-lag16: 16 → 24 ReLU →
 * 12 ReLU → 3 softmax (747 tham số)** — ML_OPS_BLUEPRINT §4 B1; `fromJSON`
 * nạp đúng arch ghi trong weights JSON (bản v8 serving "10-16-8-3" vẫn đọc
 * được — tương thích ngược qua cửa hoán đổi theo cổng B2).
 *
 * Quy ước class: 0 = DOWN · 1 = FLAT · 2 = UP. predictProba trả theo thứ tự
 * [pUp, pFlat, pDown] cho dễ dùng phía serving/Bayes. Cut 80/20 THEO THỜI GIAN
 * (val = block cuối — không leakage tương lai), shuffle chỉ trong train split.
 * Early-stop patience theo valLoss, khôi phục trọng số tốt nhất.
 *
 * RNG seed cố định (mulberry32) → kết quả huấn luyện deterministic/lặp lại
 * được — metrics trung thực, không "may rủi" từng lần train.
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

/** Kiến trúc MLP — tham số hoá B1 (#81), không còn hardcode 10-16-8-3. */
export interface MlpArch {
  in: number;
  h1: number;
  h2: number;
  out: number;
}

/**
 * Kiến trúc v2-lag16 (B1 — ML_OPS_BLUEPRINT §4): IN 16 → H1 24 → H2 12 →
 * OUT 3 = 24×16+24 + 12×24+12 + 3×12+3 = **747 tham số** (~84 mẫu/tham số
 * danh nghĩa trên 60k mẫu — vùng an toàn so GRU §B3).
 */
export const MLP_ARCH_V2: MlpArch = { in: 16, h1: 24, h2: 12, out: 3 };

/** Chuỗi arch canonical "in-h1-h2-out" (ghi vào weights JSON khi lưu). */
export function mlpArchString(arch: MlpArch): string {
  return `${arch.in}-${arch.h1}-${arch.h2}-${arch.out}`;
}

/** Parse "in-h1-h2-out" → MlpArch; throw khi sai format (fromJSON dùng). */
export function parseMlpArch(s: string): MlpArch {
  const parts = s.split("-");
  if (parts.length !== 4) throw new Error(`arch MLP sai định dạng: "${s}"`);
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new Error(`arch MLP sai số: "${s}"`);
  }
  return { in: nums[0], h1: nums[1], h2: nums[2], out: nums[3] };
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

/** Mô hình MLP — dùng như class: new MLP() → fit → predictProba. */
export class MLP {
  private readonly arch: MlpArch;
  // Trọng số phẳng: W1[H1×IN], b1[H1], W2[H2×H1], b2[H2], W3[OUT×H2], b3[OUT]
  private W1: Float64Array;
  private b1: Float64Array;
  private W2: Float64Array;
  private b2: Float64Array;
  private W3: Float64Array;
  private b3: Float64Array;
  /** Chuẩn hoá z-score đặc trưng (set sau khi fit trên X đã chuẩn hoá). */
  norm: MlpNorm | null = null;

  constructor(arch: MlpArch = MLP_ARCH_V2, seed: number = RNG_SEED) {
    this.arch = arch;
    const { in: IN, h1: H1, h2: H2, out: OUT } = arch;
    const rng = mulberry32(seed);
    const init = (rows: number, cols: number, fanIn: number) => {
      const arr = new Float64Array(rows * cols);
      const scale = Math.sqrt(2 / fanIn); // He initialization (ReLU)
      for (let i = 0; i < arr.length; i++) arr[i] = (rng() * 2 - 1) * scale;
      return arr;
    };
    this.W1 = init(H1, IN, IN);
    this.b1 = new Float64Array(H1);
    this.W2 = init(H2, H1, H1);
    this.b2 = new Float64Array(H2);
    this.W3 = init(OUT, H2, H2);
    this.b3 = new Float64Array(OUT);
  }

  /** Số tham số khả huấn luyện (metrics/nghiệm thu ghi rõ). */
  get paramCount(): number {
    const { in: IN, h1: H1, h2: H2, out: OUT } = this.arch;
    return H1 * IN + H1 + H2 * H1 + H2 + OUT * H2 + OUT;
  }

  /** Chuỗi arch "in-h1-h2-out" của bản này. */
  get archString(): string {
    return mlpArchString(this.arch);
  }

  /** Số chiều đầu vào của arch (caller kiểm tương thích featureSet). */
  get inputSize(): number {
    return this.arch.in;
  }

  /** Forward 1 mẫu (đã chuẩn hoá) → softmax 3 class [DOWN, FLAT, UP]. */
  private forward(x: number[], cache: { h1: Float64Array; h2: Float64Array; p: Float64Array }): void {
    const { in: IN, h1: H1, h2: H2, out: OUT } = this.arch;
    const { W1, b1, W2, b2, W3, b3 } = this;
    const h1 = cache.h1;
    for (let j = 0; j < H1; j++) {
      let s = b1[j];
      const off = j * IN;
      for (let k = 0; k < IN; k++) s += W1[off + k] * x[k];
      h1[j] = s > 0 ? s : 0; // ReLU
    }
    const h2 = cache.h2;
    for (let j = 0; j < H2; j++) {
      let s = b2[j];
      const off = j * H1;
      for (let k = 0; k < H1; k++) s += W2[off + k] * h1[k];
      h2[j] = s > 0 ? s : 0; // ReLU
    }
    const z3 = new Float64Array(OUT);
    for (let j = 0; j < OUT; j++) {
      let s = b3[j];
      const off = j * H2;
      for (let k = 0; k < H2; k++) s += W3[off + k] * h2[k];
      z3[j] = s;
    }
    cache.p = softmax(z3);
  }

  /**
   * Huấn luyện trên X ĐÃ CHUẨN HOÁ (caller dùng standardize trước).
   * Cross-entropy có class-weight w_c = (N/3)/N_c (1/tần suất, chuẩn hoá
   * mean 1) — val loss KHÔNG weighting để so sánh epoch ↔ epoch công bằng.
   * Xếp độ dài theo cột arch.in (bản lag16 16 chiều — caller cùng featureSet).
   */
  fit(X: number[][], y: number[]): MlpMetrics {
    const { in: IN, h1: H1, h2: H2, out: OUT } = this.arch;
    const n = X.length;
    if (n < OUT * 10) throw new Error(`MLP fit cần ≥ ${OUT * 10} mẫu, nhận ${n}`);
    for (const row of X) {
      if (row.length !== IN) {
        throw new Error(`MLP fit nhận vector ${row.length} chiều ≠ arch ${IN} (featureSet lệch?)`);
      }
    }
    const rng = mulberry32(RNG_SEED + 7);

    // Class-weight 1/freq (mất class → weight 1)
    const counts = [0, 0, 0];
    for (const label of y) counts[label]++;
    const weights = counts.map((c) => (c > 0 ? n / 3 / c : 1));

    // Cut 80/20 theo THỜI GIAN — val là block cuối
    const nTrain = Math.floor(n * (1 - VAL_FRACTION));
    const trainIdx: number[] = [];
    for (let i = 0; i < nTrain; i++) trainIdx.push(i);
    const valIdx: number[] = [];
    for (let i = nTrain; i < n; i++) valIdx.push(i);

    // Adam state cho từng khối tham số
    const params = [this.W1, this.b1, this.W2, this.b2, this.W3, this.b3];
    const grads = params.map((p) => new Float64Array(p.length));
    const m = params.map((p) => new Float64Array(p.length));
    const v = params.map((p) => new Float64Array(p.length));
    let adamStep = 0;

    // Cache forward + gradient trung gian (tái sử dụng — không alloc trong loop)
    const cache = { h1: new Float64Array(H1), h2: new Float64Array(H2), p: new Float64Array(OUT) };
    const dh1 = new Float64Array(H1);
    const dh2 = new Float64Array(H2);
    const dz3 = new Float64Array(OUT);

    const snapshot = () => params.map((p) => p.slice());
    let bestValLoss = Infinity;
    let bestWeights = snapshot();
    let stale = 0;
    let epochsRan = 0;

    for (let epoch = 1; epoch <= MAX_EPOCHS; epoch++) {
      epochsRan = epoch;
      // Shuffle CHỈ trong train split (Fisher-Yates)
      for (let i = trainIdx.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [trainIdx[i], trainIdx[j]] = [trainIdx[j], trainIdx[i]];
      }

      for (let start = 0; start < trainIdx.length; start += BATCH_SIZE) {
        const end = Math.min(trainIdx.length, start + BATCH_SIZE);
        const bs = end - start;
        for (const g of grads) g.fill(0);

        for (let bi = start; bi < end; bi++) {
          const i = trainIdx[bi];
          const x = X[i];
          this.forward(x, cache);
          const { h1, h2, p } = cache;

          // Gradient cross-entropy (có class-weight), mean theo batch
          const cw = weights[y[i]] / bs;
          dz3.fill(0);
          for (let c = 0; c < OUT; c++) dz3[c] = (p[c] - (c === y[i] ? 1 : 0)) * cw;

          // Lớp 3: dW3 = dz3·h2ᵀ, dh2 = W3ᵀ·dz3
          const gW3 = grads[4];
          const gb3 = grads[5];
          dh2.fill(0);
          for (let j = 0; j < OUT; j++) {
            const d = dz3[j];
            gb3[j] += d;
            const off = j * H2;
            for (let k = 0; k < H2; k++) {
              gW3[off + k] += d * h2[k];
              dh2[k] += this.W3[off + k] * d;
            }
          }
          // ReLU gate lớp 2
          for (let k = 0; k < H2; k++) if (h2[k] <= 0) dh2[k] = 0;

          // Lớp 2: dW2 = dh2·h1ᵀ, dh1 = W2ᵀ·dh2
          const gW2 = grads[2];
          const gb2 = grads[3];
          dh1.fill(0);
          for (let j = 0; j < H2; j++) {
            const d = dh2[j];
            gb2[j] += d;
            const off = j * H1;
            for (let k = 0; k < H1; k++) {
              gW2[off + k] += d * h1[k];
              dh1[k] += this.W2[off + k] * d;
            }
          }
          for (let k = 0; k < H1; k++) if (h1[k] <= 0) dh1[k] = 0;

          // Lớp 1: dW1 = dh1·xᵀ
          const gW1 = grads[0];
          const gb1 = grads[1];
          for (let j = 0; j < H1; j++) {
            const d = dh1[j];
            gb1[j] += d;
            const off = j * IN;
            for (let k = 0; k < IN; k++) gW1[off + k] += d * x[k];
          }
        }

        // Cập nhật Adam trên mọi khối tham số
        adamStep++;
        const lrT =
          LEARNING_RATE * Math.sqrt(1 - Math.pow(ADAM_B2, adamStep)) / (1 - Math.pow(ADAM_B1, adamStep));
        for (let pi = 0; pi < params.length; pi++) {
          const p = params[pi];
          const g = grads[pi];
          const mm = m[pi];
          const vv = v[pi];
          for (let k = 0; k < p.length; k++) {
            mm[k] = ADAM_B1 * mm[k] + (1 - ADAM_B1) * g[k];
            vv[k] = ADAM_B2 * vv[k] + (1 - ADAM_B2) * g[k] * g[k];
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
        if (stale >= PATIENCE) break; // early-stop theo valLoss
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
    const cache = {
      h1: new Float64Array(this.arch.h1),
      h2: new Float64Array(this.arch.h2),
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

  /** Serialize trọng số + norm + arch → chuỗi JSON lưu cột MlModel.weights. */
  toJSON(): string {
    return JSON.stringify({
      arch: this.archString,
      W1: Array.from(this.W1),
      b1: Array.from(this.b1),
      W2: Array.from(this.W2),
      b2: Array.from(this.b2),
      W3: Array.from(this.W3),
      b3: Array.from(this.b3),
      norm: this.norm,
    });
  }

  /** Nạp mô hình từ JSON (arch + weights + norm). Throw khi JSON hỏng/sai
   *  kiến trúc — đọc đúng arch ghi trong JSON (v8 "10-16-8-3" hay v2
   *  "16-24-12-3" đều nạp được — B1 tương thích ngược). */
  static fromJSON(json: string): MLP {
    const raw = JSON.parse(json) as {
      arch?: string;
      W1?: number[];
      b1?: number[];
      W2?: number[];
      b2?: number[];
      W3?: number[];
      b3?: number[];
      norm?: MlpNorm | null;
    };
    const arch = parseMlpArch(raw.arch ?? "");
    const { in: IN, h1: H1, h2: H2, out: OUT } = arch;
    const mlp = new MLP(arch, 1); // init tạm — ghi đè bằng trọng số JSON
    const copy = (src: number[] | undefined, len: number, name: string): Float64Array => {
      if (!Array.isArray(src) || src.length !== len) throw new Error(`MLP weights thiếu ${name} (arch ${mlpArchString(arch)})`);
      return Float64Array.from(src);
    };
    mlp.W1 = copy(raw.W1, H1 * IN, "W1");
    mlp.b1 = copy(raw.b1, H1, "b1");
    mlp.W2 = copy(raw.W2, H2 * H1, "W2");
    mlp.b2 = copy(raw.b2, H2, "b2");
    mlp.W3 = copy(raw.W3, OUT * H2, "W3");
    mlp.b3 = copy(raw.b3, OUT, "b3");
    mlp.norm = raw.norm ?? null;
    return mlp;
  }
}
