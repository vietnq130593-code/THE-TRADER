/**
 * src/lib/ml/multitask.ts — F-09 (#129 — AI_ENGINEER_REVIEW_BRAIN §3 F-09)
 * MLP ĐA NHIỆM: backbone dùng chung + 3 ĐẦU RA (hướng · biên độ · biến động).
 *
 * ⛔ KHOÁ (AUDIT 137 B7 — Task 138-b): head mag/vol SAI TOÁN đã chứng minh bằng
 * numerical gradient-check trên chính class này — gradient thật của bm[0] là
 * −2,09e-2 trong khi code tính −5,23e-2 (thiếu hệ số ×0,1 của chuỗi
 * tanh(0,1·s)); ReLU gate kiểm nhầm tầng h2 (backbone) thay vì pre-activation
 * Wm·h2+bm của head; lớp ra 4→1 không tồn tại (placeholder `(x >= 0 ? 1 : 1)`
 * là no-op — nhánh chết). VIẾT LẠI HEAD là điều kiện mở khoá. Route
 * /api/ml/train target "dl-mtl" đã GUARD 400 (audit 137 B7) — file này giữ
 * nguyên để đọc/nghiên cứu, KHÔNG xoá (bản dl-mtl cũ trong MlModel vẫn parse
 * được nếu cần truy vết). Giảm nhẹ: dl-mtl là shadow, chưa từng serving.
 *
 * Kỳ vọng chủ sở hữu "biến động tài chính" cần ĐO ĐỘ LỚN — hiện hệ thống chỉ
 * dự báo hướng 3 lớp. Thiết kế theo đặc tả F-09:
 *   • backbone: in → h1 (ReLU) → h2 (ReLU) — thông tin chia sẻ giữa 3 tác vụ;
 *   • head hướng:  h2 → 8 (ReLU) → 3 softmax (0=DOWN · 1=FLAT · 2=UP);
 *   • head biên độ: h2 → 4 (ReLU) → 1 tanh (±, scale labelRichAt.mag);
 *   • head biến động: h2 → 4 (ReLU) → 1 softplus/2 (≥ 0, scale labelRichAt.vol);
 *   • Loss = CE(class-weight như nn.ts) + 0,3·MSE_mag + 0,3·MSE_vol
 *     (trọng số theo đặc tả — CE giữ vai trò chủ đạo, 2 head phụ trợ).
 *
 * Vào sweep như ỨNG VIÊN (N3): lưu kind "dl-mtl" status archived (shadow —
 * metrics trong meta gồm MAE vol vs baseline vol20 lịch sử); lên serving chỉ
 * khi sweep gate quyết (đặc tả gate F-09: "MAE vol tốt hơn baseline vol20 ≥
 * 10% mới bật kênh sizing"). Backbone deterministic seed 42 — cùng dữ liệu
 * cùng kết quả (kỷ luật trung thực số liệu của hệ thống).
 *
 * 0 dependency ngoài nn.ts (mượn Adam/softmax chuẩn qua cài đặt riêng gọn —
 * không sửa class MLP đang serving v8).
 */

import { MLP, MLP_ARCH_V2, type MlpNorm } from "@/lib/ml/nn";
import { type RichLabel } from "@/lib/ml/features";

/** Trọng số loss phụ (đặc tả F-09: CE + 0,3·MSE_mag + 0,3·MSE_vol). */
export const MT_W_MAG = 0.3;
export const MT_W_VOL = 0.3;
/** Kiến trúc backbone mặc định (in theo featureSet: 16 v2-lag16 · 24 v3-macro). */
export const MT_ARCH = { hidden: [24, 12], dirHead: 8, magHead: 4, volHead: 4 } as const;
/** Seed cố định — deterministic. */
const MT_SEED = 42;
const MT_LR = 0.01;
const MT_BATCH = 32;
const MT_EPOCHS = 60;
const MT_PATIENCE = 12;
/** AUDIT 137 B1 — export cho train route tính nTrain chuẩn hoá khớp cut
 *  fit() của multitask (Math.floor(n * (1 − MT_VAL_FRACTION)) — multitask.ts
 *  không có opts.valFraction nên đây là nguồn duy nhất của biên). */
export const MT_VAL_FRACTION = 0.2;
/** RNG mulberry32 (cùng nn.ts — tái lập được). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Nhãn giàu cho 1 mẫu (mirror features.ts RichLabel — x do caller giữ). */
export type RichSample = RichLabel;

/** Mạng đa nhiệm — dùng như class: new MultitaskMLP(in) → fit → predict. */
export class MultitaskMLP {
  readonly inputSize: number;
  /** W1/b1: in→h1 · W2/b2: h1→h2 · 3 head: Wd/bd (dir) · Wm/bm (mag) · Wv/bv (vol). */
  private W1: Float64Array;
  private b1: Float64Array;
  private W2: Float64Array;
  private b2: Float64Array;
  private Wd: Float64Array;
  private bd: Float64Array;
  private Wm: Float64Array;
  private bm: Float64Array;
  private Wv: Float64Array;
  private bv: Float64Array;
  norm: MlpNorm | null = null;

  constructor(inputSize: number, seed = MT_SEED) {
    this.inputSize = inputSize;
    const rng = mulberry32(seed);
    const init = (rows: number, cols: number) => {
      const arr = new Float64Array(rows * cols);
      const scale = Math.sqrt(2 / cols);
      for (let i = 0; i < arr.length; i++) arr[i] = (rng() * 2 - 1) * scale;
      return arr;
    };
    const [h1, h2] = MT_ARCH.hidden;
    this.W1 = init(h1, inputSize);
    this.b1 = new Float64Array(h1);
    this.W2 = init(h2, h1);
    this.b2 = new Float64Array(h2);
    this.Wd = init(MT_ARCH.dirHead, h2);
    this.bd = new Float64Array(MT_ARCH.dirHead);
    this.Wm = init(MT_ARCH.magHead, h2);
    this.bm = new Float64Array(MT_ARCH.magHead);
    this.Wv = init(MT_ARCH.volHead, h2);
    this.bv = new Float64Array(MT_ARCH.volHead);
  }

  get paramCount(): number {
    return (
      this.W1.length + this.b1.length +
      this.W2.length + this.b2.length +
      this.Wd.length + this.bd.length +
      this.Wm.length + this.bm.length +
      this.Wv.length + this.bv.length
    );
  }

  /** Forward 1 mẫu (đã chuẩn hoá) → {h2, dirLogit[3], mag, vol}. */
  private forward(x: readonly number[]) {
    const [h1s, h2s] = MT_ARCH.hidden;
    const h1 = new Float64Array(h1s);
    for (let j = 0; j < h1s; j++) {
      let s = this.b1[j]!;
      const off = j * this.inputSize;
      for (let k = 0; k < this.inputSize; k++) s += this.W1[off + k]! * (x[k] ?? 0);
      h1[j] = s > 0 ? s : 0;
    }
    const h2 = new Float64Array(h2s);
    for (let j = 0; j < h2s; j++) {
      let s = this.b2[j]!;
      const off = j * h1s;
      for (let k = 0; k < h1s; k++) s += this.W2[off + k]! * h1[k]!;
      h2[j] = s > 0 ? s : 0;
    }
    const dirLogit = new Float64Array(3);
    for (let c = 0; c < 3; c++) {
      let s = this.bd[c]!;
      const off = c * h2s;
      for (let k = 0; k < h2s; k++) s += this.Wd[off + k]! * h2[k]!;
      dirLogit[c] = s;
    }
    let mag = 0;
    {
      const acts: number[] = [];
      for (let j = 0; j < MT_ARCH.magHead; j++) {
        let s = this.bm[j]!;
        const off = j * h2s;
        for (let k = 0; k < h2s; k++) s += this.Wm[off + k]! * h2[k]!;
        acts.push(s > 0 ? s : 0);
      }
      let s = 0;
      for (let j = 0; j < acts.length; j++) s += acts[j]! * (this.bm[j]! >= 0 ? 1 : 1); // placeholder linear
      mag = Math.tanh(s * 0.1);
    }
    let vol = 0;
    {
      const acts: number[] = [];
      for (let j = 0; j < MT_ARCH.volHead; j++) {
        let s = this.bv[j]!;
        const off = j * h2s;
        for (let k = 0; k < h2s; k++) s += this.Wv[off + k]! * h2[k]!;
        acts.push(s > 0 ? s : 0);
      }
      let s = 0;
      for (const a of acts) s += a;
      vol = Math.log1p(Math.exp(s * 0.1)) / 2; // softplus/2 ≥ 0
    }
    return { h1, h2, dirLogit, mag, vol };
  }

  /** Dự báo 1 mẫu RAW (tự áp norm nếu có). */
  predict(x: number[]): { pUp: number; pFlat: number; pDown: number; mag: number; vol: number } {
    const input = this.norm
      ? x.map((v, j) => (v - (this.norm!.mean[j] ?? 0)) / ((this.norm!.std[j] ?? 1) || 1))
      : x;
    const { dirLogit, mag, vol } = this.forward(input);
    // softmax ổn định
    let max = -Infinity;
    for (const z of dirLogit) if (z > max) max = z;
    let sum = 0;
    const e = [0, 1, 2].map((c) => {
      const v = Math.exp(dirLogit[c]! - max);
      sum += v;
      return v;
    });
    const [pDown, pFlat, pUp] = e.map((v) => v / sum);
    return { pUp, pFlat, pDown, mag, vol };
  }

  setNorm(norm: MlpNorm): void {
    this.norm = norm;
  }

  /**
   * Huấn luyện trên X ĐÃ CHUẨN HOÁ + nhãn giàu. CE class-weight 1/freq (như
   * nn.ts) + 0,3·MSE mag + 0,3·MSE vol; Adam; early-stop theo val tổng loss;
   * khôi phục trọng số tốt nhất. Trả metrics {valAcc, valLoss, maeMag,
   * maeVol, maeVolBaseline} — baseline vol20 = |vol̂ − vol| với vol̂ thay bằng
   * std20 quá khứ trung bình của val (đối chứng gate F-09 ≥ 10%).
   */
  fit(X: number[][], labels: RichSample[]): {
    epochs: number;
    samples: number;
    trainAcc: number;
    valAcc: number;
    valLoss: number;
    maeMag: number;
    maeVol: number;
    maeVolBaseline: number;
  } {
    const n = X.length;
    if (n < 30) throw new Error(`MultitaskMLP fit cần ≥ 30 mẫu, nhận ${n}`);
    const [h1s, h2s] = MT_ARCH.hidden;
    // Cut theo thời gian (val = block cuối)
    const nTrain = Math.floor(n * (1 - MT_VAL_FRACTION));
    const counts = [0, 0, 0];
    for (const l of labels) counts[l.dir]++;
    const weights = counts.map((c) => (c > 0 ? n / 3 / c : 1));
    const rng = mulberry32(MT_SEED + 11);
    const params: Float64Array[] = [
      this.W1, this.b1, this.W2, this.b2,
      this.Wd, this.bd, this.Wm, this.bm, this.Wv, this.bv,
    ];
    const grads = params.map((p) => new Float64Array(p.length));
    const m = params.map((p) => new Float64Array(p.length));
    const v = params.map((p) => new Float64Array(p.length));
    let step = 0;
    const B1 = 0.9;
    const B2 = 0.999;
    const snapshot = () => params.map((p) => p.slice());
    let best = Infinity;
    let bestW = snapshot();
    let stale = 0;
    let epochsRan = 0;

    const valLossOf = (): number => {
      let loss = 0;
      for (let i = nTrain; i < n; i++) {
        const f = this.forward(X[i]!);
        const l = labels[i]!;
        // CE
        let max = -Infinity;
        for (const z of f.dirLogit) if (z > max) max = z;
        let sum = 0;
        for (let c = 0; c < 3; c++) {
          const e = Math.exp(f.dirLogit[c]! - max);
          sum += e;
        }
        loss += -Math.log(Math.exp(f.dirLogit[l.dir]! - max) / sum);
        loss += MT_W_MAG * (f.mag - l.mag) ** 2;
        loss += MT_W_VOL * (f.vol - l.vol) ** 2;
      }
      return loss / Math.max(1, n - nTrain);
    };

    for (let epoch = 1; epoch <= MT_EPOCHS; epoch++) {
      epochsRan = epoch;
      const idx: number[] = [];
      for (let i = 0; i < nTrain; i++) idx.push(i);
      for (let i = idx.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [idx[i], idx[j]] = [idx[j]!, idx[i]!];
      }
      for (let start = 0; start < idx.length; start += MT_BATCH) {
        const end = Math.min(idx.length, start + MT_BATCH);
        const bs = end - start;
        for (const g of grads) g.fill(0);
        for (let bi = start; bi < end; bi++) {
          const i = idx[bi]!;
          const x = X[i]!;
          const l = labels[i]!;
          const f = this.forward(x);
          // softmax + CE gradient (class-weight)
          let max = -Infinity;
          for (const z of f.dirLogit) if (z > max) max = z;
          let sum = 0;
          const e = [0, 0, 0];
          for (let c = 0; c < 3; c++) {
            e[c] = Math.exp(f.dirLogit[c]! - max);
            sum += e[c];
          }
          const dLogit = [0, 1, 2].map((c) => (e[c] / sum - (c === l.dir ? 1 : 0)) * (weights[l.dir] / bs));
          // head mag/vol (tanh / softplus-2 đạo hàm xấp xỉ tuyến tính hoá)
          const dMag = ((f.mag - l.mag) * MT_W_MAG * 2) / bs * (1 - f.mag * f.mag);
          const dVol = ((f.vol - l.vol) * MT_W_VOL * 2) / bs * 0.5;
          // backward: heads
          const dH2 = new Float64Array(h2s);
          for (let c = 0; c < 3; c++) {
            const off = c * h2s;
            for (let k = 0; k < h2s; k++) {
              grads[4]![off + k]! += dLogit[c]! * f.h2[k]!;
              dH2[k]! += this.Wd[off + k]! * dLogit[c]!;
            }
            grads[5]![c]! += dLogit[c]!;
          }
          for (let j = 0; j < MT_ARCH.magHead; j++) {
            const off = j * h2s;
            const act = f.h2; // đơn giản hoá: đạo hàm ReLU ~ theo h2 trực tiếp
            for (let k = 0; k < h2s; k++) {
              grads[6]![off + k]! += (dMag / MT_ARCH.magHead) * act[k]!;
              dH2[k]! += this.Wm[off + k]! * (dMag / MT_ARCH.magHead) * (act[k]! > 0 ? 1 : 0);
            }
            grads[7]![j]! += dMag / MT_ARCH.magHead;
          }
          for (let j = 0; j < MT_ARCH.volHead; j++) {
            const off = j * h2s;
            for (let k = 0; k < h2s; k++) {
              grads[8]![off + k]! += (dVol / MT_ARCH.volHead) * f.h2[k]!;
              dH2[k]! += this.Wv[off + k]! * (dVol / MT_ARCH.volHead) * (f.h2[k]! > 0 ? 1 : 0);
            }
            grads[9]![j]! += dVol / MT_ARCH.volHead;
          }
          // backward: backbone
          const dH1 = new Float64Array(h1s);
          for (let j = 0; j < h2s; j++) {
            const off = j * h1s;
            for (let k = 0; k < h1s; k++) {
              grads[2]![off + k]! += dH2[j]! * (f.h2[j]! > 0 ? 1 : 0) * f.h1[k]!;
              dH1[k]! += this.W2[off + k]! * dH2[j]! * (f.h2[j]! > 0 ? 1 : 0);
            }
            grads[3]![j]! += dH2[j]!;
          }
          for (let j = 0; j < h1s; j++) {
            const off = j * this.inputSize;
            for (let k = 0; k < this.inputSize; k++) {
              grads[0]![off + k]! += dH1[j]! * (f.h1[j]! > 0 ? 1 : 0) * (x[k] ?? 0);
            }
            grads[1]![j]! += dH1[j]!;
          }
        }
        // Adam update
        step++;
        const lrT = MT_LR * Math.sqrt(1 - Math.pow(B2, step)) / (1 - Math.pow(B1, step));
        for (let pi = 0; pi < params.length; pi++) {
          const p = params[pi]!;
          const g = grads[pi]!;
          for (let k = 0; k < p.length; k++) {
            const gk = g[k]!;
            m[pi]![k]! = B1 * m[pi]![k]! + (1 - B1) * gk;
            v[pi]![k]! = B2 * v[pi]![k]! + (1 - B2) * gk * gk;
            p[k] -= (lrT * m[pi]![k]!) / (Math.sqrt(v[pi]![k]!) + 1e-8);
          }
        }
      }
      const val = valLossOf();
      if (val < best - 1e-6) {
        best = val;
        bestW = snapshot();
        stale = 0;
      } else {
        stale++;
        if (stale >= MT_PATIENCE) break;
      }
    }
    for (let pi = 0; pi < params.length; pi++) params[pi]!.set(bestW[pi]!);

    // Metrics cuối: valAcc + MAE 2 head phụ + baseline vol (đối chứng gate F-09)
    let correct = 0;
    let maeMag = 0;
    let maeVol = 0;
    let maeVolBase = 0;
    let volMeanTrain = 0;
    for (let i = 0; i < nTrain; i++) volMeanTrain += labels[i]!.vol;
    volMeanTrain /= Math.max(1, nTrain);
    const valN = n - nTrain;
    for (let i = nTrain; i < n; i++) {
      const f = this.forward(X[i]!);
      const l = labels[i]!;
      let arg = 0;
      for (let c = 1; c < 3; c++) if (f.dirLogit[c]! > f.dirLogit[arg]!) arg = c;
      if (arg === l.dir) correct++;
      maeMag += Math.abs(f.mag - l.mag);
      maeVol += Math.abs(f.vol - l.vol);
      maeVolBase += Math.abs(volMeanTrain - l.vol);
    }
    return {
      epochs: epochsRan,
      samples: n,
      trainAcc: 0, // không cần cho gate (giữ 0 trung thực — không tính riêng)
      valAcc: valN > 0 ? Number((correct / valN).toFixed(4)) : 0,
      valLoss: Number(best.toFixed(4)),
      maeMag: valN > 0 ? Number((maeMag / valN).toFixed(4)) : 0,
      maeVol: valN > 0 ? Number((maeVol / valN).toFixed(4)) : 0,
      maeVolBaseline: valN > 0 ? Number((maeVolBase / valN).toFixed(4)) : 0,
    };
  }

  /** Serialize (backbone + 3 head + norm) — lưu MlModel.weights kind dl-mtl. */
  toJSON(): string {
    return JSON.stringify({
      multitask: true,
      inputSize: this.inputSize,
      arch: { ...MT_ARCH, hidden: [...MT_ARCH.hidden] },
      W1: Array.from(this.W1), b1: Array.from(this.b1),
      W2: Array.from(this.W2), b2: Array.from(this.b2),
      Wd: Array.from(this.Wd), bd: Array.from(this.bd),
      Wm: Array.from(this.Wm), bm: Array.from(this.bm),
      Wv: Array.from(this.Wv), bv: Array.from(this.bv),
      norm: this.norm,
    });
  }
}

/** Giữ tương thích tham chiếu arch chuẩn MLP (k docs hiển thị). */
void MLP;
void MLP_ARCH_V2;
