/**
 * src/lib/ml/gru.ts — GRU-24 GIỌNG THỨ BA (B3 — ML_OPS_BLUEPRINT §4, phiên #81).
 *
 * GATED + kill-switch: chỉ được train/serve khi CỔNG BẰNG CHỨNG B2 PASS
 * (AppSetting "ml-gate" verdict PASS) — vào ensemble qua 3 lớp bảo vệ
 * (shadow 60 phiên → Brier ≤ MLP → kill-switch 2 tầng, xem ensemble.ts).
 * Khi cổng KHÔNG mở, file này là code nằm chờ (B4 — "không phải bây giờ ≠
 * không bao giờ"), 0 dòng nào tự kích hoạt.
 *
 * Kiến trúc [DL — chương RNN/LSTM, GRU 2 cổng gọn hơn LSTM ~25% tham số]:
 *   input 16 đặc trưng × window 20 phiên (t−19..t)
 *   → GRU cell 24 unit (z update · r reset — chống vanishing gradient window 20)
 *   → dense 8 ReLU → softmax 3 class (DOWN/FLAT/UP)
 * Tham số: Wz,Wr,Wh [24×16] + Uz,Ur,Uh [24×24] + bz,br,bh [24] + dense
 *   (8×24+8) + out (3×8+3) = 3×(384+576+24) + 227 = **3.179** (ghi rõ meta
 *   khi train — blueprint ước "~2,6k", số chính xác là 3.179).
 * Train: Adam viết tay như nn.ts (β1 0,9 · β2 0,999 · ε 1e-8, LR 0,005 —
 *   thấp hơn MLP vì BPTT nhiễu hơn) · batch 32 · ≤60 epoch · patience 12 ·
 *   dropout input 0,2 · class-weight 1/freq · cut 80/20 THEO THỜI GIAN ·
 *   seed 43 (khác MLP seed 42).
 * Quy ước class/predictProba giống nn.ts: 0=DOWN · 1=FLAT · 2=UP nội bộ,
 * predictProba trả [pUp, pFlat, pDown].
 *
 * Float64Array phẳng, 0 dependency — cùng phong cách nn.ts. Deterministic
 * (mulberry32 seed cố định): 2 lần train cùng windowHash → cùng metrics.
 */

import type { MlpNorm } from "@/lib/ml/nn";

/** Kiến trúc GRU (B3 cố định — đổi phải train lại từ đầu). */
export interface GruArch {
  /** Số chiều đặc trưng mỗi bước thời gian (v2-lag16). */
  in: number;
  /** Số unit GRU (24). */
  h: number;
  /** Số lớp dense ẩn sau GRU (8 ReLU). */
  d: number;
  /** Số class đầu ra (3). */
  out: number;
  /** Độ dài cửa sổ chuỗi (20 phiên). */
  window: number;
}

/** Arch chuẩn B3: 16 × window 20 → GRU 24 → dense 8 → softmax 3. */
export const GRU_ARCH: GruArch = { in: 16, h: 24, d: 8, out: 3, window: 20 };

/** Metrics huấn luyện GRU — khớp meta lưu MlModel khi train. */
export interface GruMetrics {
  epochs: number;
  samples: number;
  trainAcc: number;
  valAcc: number;
  trainLoss: number;
  valLoss: number;
  params: number;
  window: number;
}

const ADAM_B1 = 0.9;
const ADAM_B2 = 0.999;
const ADAM_EPS = 1e-8;
const LEARNING_RATE = 0.005; // thấp hơn MLP 0,01 — BPTT nhiễu hơn (B3)
const BATCH_SIZE = 32;
const MAX_EPOCHS = 60;
const PATIENCE = 12;
const VAL_FRACTION = 0.2; // PHẢI khớp nn.ts — val block cùng mẫu cho paired Brier
const RNG_SEED = 43; // khác MLP (42) — B3
const INPUT_DROPOUT = 0.2; // dropout input 0,2 (chỉ khi train)

/** RNG mulberry32 — giống nn.ts (deterministic). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

/** Trung gian forward 1 mẫu — giữ mọi activation để BPTT dùng lại. */
interface GruForwardCache {
  /** [W][H] cổng update z_t (sau sigmoid). */
  z: Float64Array[];
  /** [W][H] cổng reset r_t (sau sigmoid). */
  r: Float64Array[];
  /** [W][H] ứng viên h̃_t (sau tanh). */
  hHat: Float64Array[];
  /** [W+1][H] trạng thái ẩn — h[0] = 0 (khởi tạo), h[t+1] = h_t. */
  h: Float64Array[];
  /** [W][IN] input mỗi bước SAU dropout (train) — backward dùng đúng mask. */
  x: Float64Array[];
  /** [D] dense ReLU. */
  d: Float64Array;
  /** [OUT] softmax. */
  p: Float64Array;
}

export class GRU {
  private readonly arch: GruArch;
  // Trọng số phẳng
  private Wz: Float64Array; // [H×IN]
  private Wr: Float64Array; // [H×IN]
  private Wh: Float64Array; // [H×IN]
  private Uz: Float64Array; // [H×H]
  private Ur: Float64Array; // [H×H]
  private Uh: Float64Array; // [H×H]
  private bz: Float64Array; // [H]
  private br: Float64Array; // [H]
  private bh: Float64Array; // [H]
  private Wd: Float64Array; // [D×H]
  private bd: Float64Array; // [D]
  private Wo: Float64Array; // [OUT×D]
  private bo: Float64Array; // [OUT]
  /** z-score theo chiều đặc trưng (áp cho MỌI bước của cửa sổ). */
  norm: MlpNorm | null = null;

  constructor(arch: GruArch = GRU_ARCH, seed: number = RNG_SEED) {
    this.arch = arch;
    const { in: IN, h: H, d: D, out: OUT } = arch;
    const rng = mulberry32(seed);
    // He-normal cho ma trận (ReLU/tanh vùng hoạt động tuyến tính giữa),
    // bias khởi 0 (quy ước GRU chuẩn — bias thực học nhanh)
    const init = (rows: number, cols: number, fanIn: number) => {
      const arr = new Float64Array(rows * cols);
      const scale = Math.sqrt(2 / fanIn);
      for (let i = 0; i < arr.length; i++) arr[i] = (rng() * 2 - 1) * scale;
      return arr;
    };
    this.Wz = init(H, IN, IN);
    this.Wr = init(H, IN, IN);
    this.Wh = init(H, IN, IN);
    this.Uz = init(H, H, H);
    this.Ur = init(H, H, H);
    this.Uh = init(H, H, H);
    this.bz = new Float64Array(H);
    this.br = new Float64Array(H);
    this.bh = new Float64Array(H);
    this.Wd = init(D, H, H);
    this.bd = new Float64Array(D);
    this.Wo = init(OUT, D, D);
    this.bo = new Float64Array(OUT);
  }

  /** Số tham số khả huấn luyện (3.179 với arch chuẩn B3). */
  get paramCount(): number {
    const { in: IN, h: H, d: D, out: OUT } = this.arch;
    return 3 * (H * IN + H * H + H) + D * H + D + OUT * D + OUT;
  }

  /** Chuỗi arch canonical "gru{in}-{h}w{window}" (JSON + fromJSON check). */
  get archString(): string {
    const { in: IN, h: H, window: W } = this.arch;
    return `gru${IN}-${H}w${W}`;
  }

  /**
   * Forward 1 cửa sổ (đã chuẩn hoá từng bước). Trả cache đầy đủ để BPTT.
   * dropout != null → áp inverted-dropout input (chỉ đường train).
   */
  private forwardWindow(
    window: number[][],
    cache: GruForwardCache,
    dropoutRng: (() => number) | null
  ): void {
    const { in: IN, h: H, d: D, out: OUT, window: W } = this.arch;
    if (window.length !== W) {
      throw new Error(`GRU window ${window.length} bước ≠ arch ${W}`);
    }
    const { Wz, Wr, Wh, Uz, Ur, Uh, bz, br, bh, Wd, bd, Wo, bo } = this;
    const hPrev = cache.h[0]; // = 0
    for (let t = 0; t < W; t++) {
      // Dropout input (inverted — giữ kỳ vọng): mask 0 với xác suất p,
      // scale 1/(1−p) khi giữ. Backward dùng ĐÚNG x đã mask trong cache.
      const raw = window[t];
      if (raw.length !== IN) throw new Error(`GRU input ${raw.length} chiều ≠ arch ${IN}`);
      const x = cache.x[t];
      for (let k = 0; k < IN; k++) {
        const keep = dropoutRng == null || dropoutRng() >= INPUT_DROPOUT;
        x[k] = keep ? raw[k] / (1 - INPUT_DROPOUT) : 0;
      }
      const prev = t === 0 ? hPrev : cache.h[t];
      const z = cache.z[t];
      const r = cache.r[t];
      const hHat = cache.hHat[t];
      const hNext = cache.h[t + 1];
      // z_t = σ(Wz·x + Uz·h_prev + bz)
      for (let j = 0; j < H; j++) {
        let s = bz[j];
        const offI = j * IN;
        const offR = j * H;
        for (let k = 0; k < IN; k++) s += Wz[offI + k] * x[k];
        for (let k = 0; k < H; k++) s += Uz[offR + k] * prev[k];
        z[j] = 1 / (1 + Math.exp(-s));
      }
      // r_t = σ(Wr·x + Ur·h_prev + br)
      for (let j = 0; j < H; j++) {
        let s = br[j];
        const offI = j * IN;
        const offR = j * H;
        for (let k = 0; k < IN; k++) s += Wr[offI + k] * x[k];
        for (let k = 0; k < H; k++) s += Ur[offR + k] * prev[k];
        r[j] = 1 / (1 + Math.exp(-s));
      }
      // h̃_t = tanh(Wh·x + Uh·(r ⊙ h_prev) + bh)
      for (let j = 0; j < H; j++) {
        let s = bh[j];
        const offI = j * IN;
        const offR = j * H;
        for (let k = 0; k < IN; k++) s += Wh[offI + k] * x[k];
        for (let k = 0; k < H; k++) s += Uh[offR + k] * r[k] * prev[k];
        hHat[j] = Math.tanh(s);
      }
      // h_t = (1−z) ⊙ h_prev + z ⊙ h̃
      for (let j = 0; j < H; j++) {
        hNext[j] = (1 - z[j]) * prev[j] + z[j] * hHat[j];
      }
    }
    // dense ReLU trên h cuối → softmax
    const hLast = cache.h[W];
    const dd = cache.d;
    for (let j = 0; j < D; j++) {
      let s = bd[j];
      const off = j * H;
      for (let k = 0; k < H; k++) s += Wd[off + k] * hLast[k];
      dd[j] = s > 0 ? s : 0;
    }
    const z3 = new Float64Array(OUT);
    for (let j = 0; j < OUT; j++) {
      let s = bo[j];
      const off = j * D;
      for (let k = 0; k < D; k++) s += Wo[off + k] * dd[k];
      z3[j] = s;
    }
    cache.p = softmax(z3);
  }

  /** Tạo cache rỗng tái sử dụng (không alloc trong vòng train). */
  private makeCache(): GruForwardCache {
    const { in: IN, h: H, d: D, out: OUT, window: W } = this.arch;
    return {
      z: Array.from({ length: W }, () => new Float64Array(H)),
      r: Array.from({ length: W }, () => new Float64Array(H)),
      hHat: Array.from({ length: W }, () => new Float64Array(H)),
      h: Array.from({ length: W + 1 }, () => new Float64Array(H)),
      x: Array.from({ length: W }, () => new Float64Array(IN)),
      d: new Float64Array(D),
      p: new Float64Array(OUT),
    };
  }

  /**
   * BPTT 1 mẫu → cộng dồn gradient vào grads (đã nhân class-weight/bs).
   * Công thức chuẩn GRU (nguồn [DL] chương RNN — đạo hàm chuỗi qua 4 đường
   * về h_prev: trực tiếp (1−z), qua r⊙h_prev, qua pre-sigmoid r, qua
   * pre-sigmoid z).
   */
  private backwardWindow(
    cache: GruForwardCache,
    label: number,
    cw: number,
    grads: Float64Array[]
  ): void {
    const { in: IN, h: H, d: D, out: OUT, window: W } = this.arch;
    const [gWz, gWr, gWh, gUz, gUr, gUh, gbz, gbr, gbh, gWd, gbd, gWo, gbo] = grads;
    const { Uz, Ur, Uh, Wd, Wo } = this;

    // Lớp softmax + dense
    const dz3 = new Float64Array(OUT);
    for (let c = 0; c < OUT; c++) dz3[c] = (cache.p[c] - (c === label ? 1 : 0)) * cw;
    const dd = new Float64Array(D);
    for (let j = 0; j < OUT; j++) {
      const dv = dz3[j];
      gbo[j] += dv;
      const off = j * D;
      for (let k = 0; k < D; k++) {
        gWo[off + k] += dv * cache.d[k];
        dd[k] += Wo[off + k] * dv;
      }
    }
    for (let k = 0; k < D; k++) if (cache.d[k] <= 0) dd[k] = 0; // ReLU gate

    // dense → h cuối
    const dhLast = new Float64Array(H);
    for (let j = 0; j < D; j++) {
      const dv = dd[j];
      gbd[j] += dv;
      const off = j * H;
      for (let k = 0; k < H; k++) {
        gWd[off + k] += dv * cache.h[W][k];
        dhLast[k] += Wd[off + k] * dv;
      }
    }

    // BPTT qua W bước GRU
    let dhNext = dhLast;
    const dhPrevAcc = new Float64Array(H);
    const da = new Float64Array(H); // gradient pre-activation h̃
    const drh = new Float64Array(H); // gradient (r ⊙ h_prev)
    const dzPre = new Float64Array(H); // gradient pre-sigmoid z
    const drPre = new Float64Array(H); // gradient pre-sigmoid r
    const dzTotal = new Float64Array(H);
    for (let t = W - 1; t >= 0; t--) {
      const x = cache.x[t];
      const z = cache.z[t];
      const r = cache.r[t];
      const hHat = cache.hHat[t];
      const prev = cache.h[t];
      const dh = dhNext;

      // h_t = (1−z)⊙h_prev + z⊙h̃
      dzTotal.fill(0);
      for (let j = 0; j < H; j++) {
        dzTotal[j] = (hHat[j] - prev[j]) * dh[j]; // → z_t
        da[j] = z[j] * dh[j]; // → h̃_t
        dhPrevAcc[j] = (1 - z[j]) * dh[j]; // đường trực tiếp
      }
      // h̃ = tanh(a) → da
      for (let j = 0; j < H; j++) da[j] *= 1 - hHat[j] * hHat[j];
      // a = Wh·x + Uh·(r⊙h_prev) + bh
      drh.fill(0);
      for (let j = 0; j < H; j++) {
        const dv = da[j];
        gbh[j] += dv;
        const offI = j * IN;
        const offR = j * H;
        for (let k = 0; k < IN; k++) gWh[offI + k] += dv * x[k];
        for (let k = 0; k < H; k++) {
          gUh[offR + k] += dv * r[k] * prev[k];
          drh[k] += Uh[offR + k] * dv;
        }
      }
      // (r ⊙ h_prev): đường về r và về h_prev
      drPre.fill(0);
      for (let j = 0; j < H; j++) {
        drPre[j] = drh[j] * prev[j];
        dhPrevAcc[j] += drh[j] * r[j];
      }
      // r = σ(pre): drPre → pre (nhân r(1−r))
      for (let j = 0; j < H; j++) drPre[j] *= r[j] * (1 - r[j]);
      for (let j = 0; j < H; j++) {
        const dv = drPre[j];
        gbr[j] += dv;
        const offI = j * IN;
        const offR = j * H;
        for (let k = 0; k < IN; k++) gWr[offI + k] += dv * x[k];
        for (let k = 0; k < H; k++) gUr[offR + k] += dv * prev[k];
      }
      // Ur·h_prev: đường về h_prev
      for (let j = 0; j < H; j++) {
        const dv = drPre[j];
        const offR = j * H;
        for (let k = 0; k < H; k++) dhPrevAcc[k] += Ur[offR + k] * dv;
      }
      // z = σ(pre): dzTotal → pre (nhân z(1−z))
      dzPre.fill(0);
      for (let j = 0; j < H; j++) dzPre[j] = dzTotal[j] * z[j] * (1 - z[j]);
      for (let j = 0; j < H; j++) {
        const dv = dzPre[j];
        gbz[j] += dv;
        const offI = j * IN;
        const offR = j * H;
        for (let k = 0; k < IN; k++) gWz[offI + k] += dv * x[k];
        for (let k = 0; k < H; k++) gUz[offR + k] += dv * prev[k];
      }
      // Uz·h_prev: đường về h_prev
      for (let j = 0; j < H; j++) {
        const dv = dzPre[j];
        const offR = j * H;
        for (let k = 0; k < H; k++) dhPrevAcc[k] += Uz[offR + k] * dv;
      }

      dhNext = Float64Array.from(dhPrevAcc);
      dhPrevAcc.fill(0);
    }
  }

  /**
   * Huấn luyện trên X ĐÃ CHUẨN HOÁ (caller standardize theo chiều, áp mọi
   * bước). Cross-entropy class-weight 1/freq (giống nn.ts), val loss KHÔNG
   * weighting. Cut 80/20 theo thời gian — val block cùng mẫu với MLP
   * (paired Brier so trực tiếp).
   */
  fit(X: number[][][], y: number[]): GruMetrics {
    const { in: IN, window: W, out: OUT } = this.arch;
    const n = X.length;
    if (n < OUT * 10) throw new Error(`GRU fit cần ≥ ${OUT * 10} mẫu, nhận ${n}`);
    for (const win of X) {
      if (win.length !== W) throw new Error(`GRU fit nhận window ${win.length} ≠ ${W}`);
      for (const step of win) {
        if (step.length !== IN) {
          throw new Error(`GRU input ${step.length} chiều ≠ arch ${IN} (featureSet lệch?)`);
        }
      }
    }
    const rng = mulberry32(RNG_SEED + 11); // dropout mask + shuffle

    const counts = [0, 0, 0];
    for (const label of y) counts[label]++;
    const weights = counts.map((c) => (c > 0 ? n / 3 / c : 1));

    const nTrain = Math.floor(n * (1 - VAL_FRACTION));
    const trainIdx: number[] = [];
    for (let i = 0; i < nTrain; i++) trainIdx.push(i);
    const valIdx: number[] = [];
    for (let i = nTrain; i < n; i++) valIdx.push(i);

    const params = [
      this.Wz, this.Wr, this.Wh,
      this.Uz, this.Ur, this.Uh,
      this.bz, this.br, this.bh,
      this.Wd, this.bd,
      this.Wo, this.bo,
    ];
    const grads = params.map((p) => new Float64Array(p.length));
    const m = params.map((p) => new Float64Array(p.length));
    const v = params.map((p) => new Float64Array(p.length));
    let adamStep = 0;

    const cache = this.makeCache();
    const snapshot = () => params.map((p) => p.slice());
    let bestValLoss = Infinity;
    let bestWeights = snapshot();
    let stale = 0;
    let epochsRan = 0;

    for (let epoch = 1; epoch <= MAX_EPOCHS; epoch++) {
      epochsRan = epoch;
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
          this.forwardWindow(X[i], cache, rng); // dropout BẬT khi train
          this.backwardWindow(cache, y[i], weights[y[i]] / bs, grads);
        }
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

      // Val loss (KHÔNG class-weight, KHÔNG dropout) + early-stop patience 12
      let valLoss = 0;
      for (const i of valIdx) {
        this.forwardWindow(X[i], cache, null);
        valLoss += -Math.log(Math.max(cache.p[y[i]], 1e-12));
      }
      valLoss /= Math.max(1, valIdx.length);
      if (valLoss < bestValLoss - 1e-6) {
        bestValLoss = valLoss;
        bestWeights = snapshot();
        stale = 0;
      } else {
        stale++;
        if (stale >= PATIENCE) break;
      }
    }

    for (let pi = 0; pi < params.length; pi++) params[pi].set(bestWeights[pi]);

    const evalSplit = (idx: number[], weighted: boolean): { acc: number; loss: number } => {
      let correct = 0;
      let loss = 0;
      for (const i of idx) {
        this.forwardWindow(X[i], cache, null);
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
      params: this.paramCount,
      window: W,
    };
  }

  /** Gắn z-score (theo chiều đặc trưng — áp MỌI bước của cửa sổ). */
  setNorm(norm: MlpNorm): void {
    this.norm = norm;
  }

  /**
   * Xác suất 3 class cho 1 cửa sổ RAW (tự áp norm mỗi bước).
   * Trả [pUp, pFlat, pDown] — mapping ngược class index như nn.ts.
   */
  predictProba(window: number[][]): [number, number, number] {
    const { in: IN } = this.arch;
    const input = window.map((step) =>
      this.norm
        ? step.map((v, j) => (v - (this.norm!.mean[j] ?? 0)) / ((this.norm!.std[j] ?? 1) || 1))
        : step
    );
    if (input.length > 0 && input[0].length !== IN) {
      throw new Error(`GRU predictProba nhận ${input[0].length} chiều ≠ arch ${IN}`);
    }
    const cache = this.makeCache();
    this.forwardWindow(input, cache, null); // serving: KHÔNG dropout
    return [cache.p[2], cache.p[1], cache.p[0]];
  }

  /** Serialize trọng số + norm + arch → JSON lưu MlModel.weights. */
  toJSON(): string {
    return JSON.stringify({
      arch: this.archString,
      window: this.arch.window,
      Wz: Array.from(this.Wz),
      Wr: Array.from(this.Wr),
      Wh: Array.from(this.Wh),
      Uz: Array.from(this.Uz),
      Ur: Array.from(this.Ur),
      Uh: Array.from(this.Uh),
      bz: Array.from(this.bz),
      br: Array.from(this.br),
      bh: Array.from(this.bh),
      Wd: Array.from(this.Wd),
      bd: Array.from(this.bd),
      Wo: Array.from(this.Wo),
      bo: Array.from(this.bo),
      norm: this.norm,
    });
  }

  /** Nạp từ JSON — throw khi arch sai (cùng kỷ luật MLP.fromJSON). */
  static fromJSON(json: string): GRU {
    const raw = JSON.parse(json) as Record<string, unknown> & {
      arch?: string;
      window?: number;
      norm?: MlpNorm | null;
    };
    const archStr = typeof raw.arch === "string" ? raw.arch : "";
    // "gru16-24w20"
    const m = /^gru(\d+)-(\d+)w(\d+)$/.exec(archStr);
    if (!m) throw new Error(`GRU arch "${archStr}" sai định dạng (gru{in}-{h}w{window})`);
    const arch: GruArch = {
      in: Number(m[1]),
      h: Number(m[2]),
      d: 8, // dense ẩn cố định B3 — không nằm trong chuỗi arch
      out: 3,
      window: typeof raw.window === "number" ? raw.window : Number(m[3]),
    };
    const gru = new GRU(arch, 1);
    const { in: IN, h: H, d: D, out: OUT } = arch;
    const copy = (key: string, len: number): Float64Array => {
      const src = raw[key];
      if (!Array.isArray(src) || src.length !== len) {
        throw new Error(`GRU weights thiếu ${key} (arch ${archStr})`);
      }
      return Float64Array.from(src as number[]);
    };
    gru.Wz = copy("Wz", H * IN);
    gru.Wr = copy("Wr", H * IN);
    gru.Wh = copy("Wh", H * IN);
    gru.Uz = copy("Uz", H * H);
    gru.Ur = copy("Ur", H * H);
    gru.Uh = copy("Uh", H * H);
    gru.bz = copy("bz", H);
    gru.br = copy("br", H);
    gru.bh = copy("bh", H);
    gru.Wd = copy("Wd", D * H);
    gru.bd = copy("bd", D);
    gru.Wo = copy("Wo", OUT * D);
    gru.bo = copy("bo", OUT);
    gru.norm = raw.norm ?? null;
    return gru;
  }
}
