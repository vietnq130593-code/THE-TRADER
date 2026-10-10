/**
 * src/lib/ml/ensemble.ts — ENSEMBLE MLP + LINREG (+ GRU giọng thứ ba GATED).
 *
 * ML Forecast là CỬ TRI THỨ 6 của Hội đồng Nghiên cứu (phiếu bầu theo số
 * đông — đồng thuận 80%): thay vì bằng chứng quant riêng, tín hiệu ML đi vào
 * Bayes ĐÚNG MỘT LẦN qua phiếu `llm-vote:ml-forecast` (evidence.ts đã REPLACE
 * block quant cũ — chống đếm kép T7.5).
 *
 * Công thức (chốt v1.1 sau review 37-REVIEW):
 *   score = 0,7 × (pUp − pDown)  +  0,3 × tanh(z)
 *   pUp/pDown   : MLP serving predictProba trung bình rổ top-10 HOSE-STOCK
 *                 (latestFeatures() — GIỮ NGUYÊN rổ bằng chứng quant #35).
 *   z           : z-score của đại lượng linreg proj₅ = slope×5/last×100 đo
 *                 trên chuỗi rổ equal-weight, cửa sổ 60 phiên trượt.
 *   deadband    : |score| < 0,05 → FLAT.
 *   fallback    : chưa có MlModel serving → linreg thuần (modelVersion null).
 *
 * B3 (#81 — ML_OPS_BLUEPRINT §4, chỉ khi CỔNG B2 PASS): GRU-24 thành giọng
 * thứ ba — score = 0,5×(pUp−pDown)_MLP + 0,2×(pUp−pDown)_GRU + 0,3×tanh(z).
 * Vào ensemble qua 3 LỚP BẢO VỆ:
 *   1. Shadow 60 phiên — GRU predictProba mỗi chu kỳ nhưng KHÔNG vào score;
 *      ghi Brier rolling 60 phiên so MLP cùng chu kỳ (AppSetting "ml-gru").
 *   2. Sau 60 phiên: chỉ khi Brier-shadow ≤ Brier-MLP → lên giọng thứ 3
 *      (trọng số 0,5/0,3/0,2 — điều chỉnh MỘT LẦN khi kích hoạt).
 *   3. Kill-switch 2 tầng — AppSetting "ml-gru" enabled (OFF mặc định) +
 *      tự hạ khi Brier GRU tệ hơn MLP 5 phiên liên tiếp (audit ML_GRU_KILL).
 * Khi KHÔNG có model dl-gru (cổng chưa mở — B4): toàn bộ nhánh GRU nằm im,
 * ensemble ra KẾT QUẢ CŨ 100% (bit-flip test §4 B3 nghiệm thu 4).
 *
 * Deterministic, 0 LLM (~0,3s: loadTopSeries 10 mã + 1 forward MLP × 10).
 */

import { db } from "@/lib/db";
import { latestFeatures, latestFeatureWindows, loadTopSeries } from "@/lib/ml/features";
import { MLP } from "@/lib/ml/nn";
import { GRU } from "@/lib/ml/gru";

/** Deadband FLAT — |score| < 0,05 (B7 v1.1). */
export const ML_ENSEMBLE_DEADBAND = 0.05;
/** Trọng số MLP khi GRU chưa kích hoạt (2 giọng — công thức cũ giữ nguyên). */
const W_MLP = 0.7;
/** Trọng số linreg khi GRU chưa kích hoạt. */
const W_LINREG = 0.3;
/** Trọng số MLP khi GRU ĐÃ kích hoạt (B3: 0,5/0,3/0,2 — đổi MỘT lần). */
const W_MLP_V3 = 0.5;
/** Trọng số linreg khi GRU đã kích hoạt. */
const W_LINREG_V3 = 0.3;
/** Trọng số GRU khi đã kích hoạt (giọng thứ ba). */
const W_GRU = 0.2;
/** Cửa sổ trượt tính proj₅ (phiên). */
const PROJ_WINDOW = 60;
/** Số phiên tối thiểu chuỗi rổ để tính z-score có nghĩa. */
const MIN_PROJ_SAMPLES = 10;
/** Shadow tối thiểu trước khi GRU đủ điều kiện lên giọng (B3: 60 phiên). */
const SHADOW_MIN_SESSIONS = 60;
/** Kill-switch tầng 2 — Brier GRU tệ hơn MLP N phiên liên tiếp → tự hạ. */
const KILL_WORSE_STREAK = 5;
/** Giữ tối đa N phiếu shadow trong AppSetting (rolling 60 + đệm). */
const SHADOW_LOG_CAP = 80;

/** Kết quả ensemble — dùng cho runMlForecast + phiếu bầu evidence.ts. */
export interface MlEnsembleResult {
  direction: "UP" | "DOWN" | "FLAT";
  /** score = 0,7×(pUp−pDown) + 0,3×tanh(z) (hoặc 0,5/0,2/0,3 khi GRU bật);
   *  null khi fallback linreg thuần. */
  score: number | null;
  /** z-score của proj₅ (đại lượng linreg) — null khi thiếu dữ liệu chuỗi. */
  z: number | null;
  /** proj₅ phiên cuối của rổ (%) — đại lượng linreg thô. */
  lastProj: number | null;
  /** Trung bình xác suất MLP trên rổ (Σ=1); null khi fallback. */
  pUp: number | null;
  pDown: number | null;
  pFlat: number | null;
  /** max(pUp, pDown, pFlat) — BanditEvent.confidence (đầu vào Brier B8). */
  confidence: number;
  /** null = fallback linreg (chưa có MlModel serving). */
  modelVersion: number | null;
  /** Số mã trong rổ có đủ dữ liệu. */
  basketSize: number;
  /** Ghi chú 1 dòng (drivers + prompt). */
  note: string;
  /** B3 (#81) — version GRU khi giọng thứ ba đang PHỤC VỤ (null = không có). */
  gruVersion: number | null;
}

/** Hồi quy tuyến tính: slope chuỗi ys (bản nội bộ — không phụ thuộc module khác). */
function linregSlope(ys: number[]): number {
  const n = ys.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (ys[i] - yMean);
    den += (i - xMean) ** 2;
  }
  return den > 0 ? num / den : 0;
}

function meanOf(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

function stdOf(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = meanOf(xs);
  return Math.sqrt(meanOf(xs.map((x) => (x - m) * (x - m))));
}

/* ─────────────── B3 · trạng thái GRU trong AppSetting "ml-gru" ─────────────── */

/** Một phiếu shadow (dự báo rổ 1 phiên — chấm điểm 5 phiên sau). */
interface ShadowPrediction {
  /** Ngày phiên dự báo (YYYY-MM-DD của bar cuối rổ). */
  date: string;
  /** Xác suất GRU trung bình rổ [pUp, pFlat, pDown] — null khi GRU chưa có. */
  gru: [number, number, number] | null;
  /** Xác suất MLP trung bình rổ cùng chu kỳ — null khi MLP fallback. */
  mlp: [number, number, number] | null;
  /** Đã chấm chưa (settled thì loại khỏi pending). */
  settled?: boolean;
  /** Brier GRU/MLP khi chấm — dùng cho report đối chiếu. */
  gruBrier?: number;
  mlpBrier?: number;
}

/** Trạng thái GRU (kill-switch tầng 1 + shadow rolling). */
interface GruSetting {
  /** Kill-switch tầng 1 — OFF mặc định (B3). */
  enabled: boolean;
  shadow: {
    /** Số phiên đã chấm (rolling tổng). */
    settled: number;
    /** Brier trung bình rolling của GRU (từ các phiên đã chấm). */
    gruBrier: number | null;
    /** Brier trung bình rolling của MLP cùng chu kỳ. */
    mlpBrier: number | null;
    /** Brier GRU tệ hơn MLP N phiên liên tiếp — đủ 5 → tự hạ. */
    consecutiveWorse: number;
    /** Thời điểm kích hoạt giọng thứ 3 (null = chưa từng). */
    activatedAt: string | null;
    /** Log phiếu pending (chưa đủ 5 phiên tương lai). */
    pending: ShadowPrediction[];
  };
  updatedAt: string;
}

const GRU_SETTING_DEFAULT: GruSetting = {
  enabled: false,
  shadow: {
    settled: 0,
    gruBrier: null,
    mlpBrier: null,
    consecutiveWorse: 0,
    activatedAt: null,
    pending: [],
  },
  updatedAt: "",
};

async function readGruSetting(): Promise<GruSetting> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: "ml-gru" } });
    if (!row) return { ...GRU_SETTING_DEFAULT };
    const g = JSON.parse(row.value) as Partial<GruSetting>;
    const sh = (g.shadow ?? {}) as Partial<GruSetting["shadow"]>;
    return {
      enabled: g.enabled === true,
      shadow: {
        settled: typeof sh.settled === "number" ? sh.settled : 0,
        gruBrier: typeof sh.gruBrier === "number" ? sh.gruBrier : null,
        mlpBrier: typeof sh.mlpBrier === "number" ? sh.mlpBrier : null,
        consecutiveWorse: typeof sh.consecutiveWorse === "number" ? sh.consecutiveWorse : 0,
        activatedAt: typeof sh.activatedAt === "string" ? sh.activatedAt : null,
        pending: Array.isArray(sh.pending) ? sh.pending.slice(-SHADOW_LOG_CAP) : [],
      },
      updatedAt: typeof g.updatedAt === "string" ? g.updatedAt : "",
    };
  } catch {
    return { ...GRU_SETTING_DEFAULT };
  }
}

async function writeGruSetting(value: GruSetting): Promise<void> {
  const json = JSON.stringify({
    ...value,
    shadow: { ...value.shadow, pending: value.shadow.pending.slice(-SHADOW_LOG_CAP) },
    updatedAt: new Date().toISOString(),
  });
  await db.appSetting.upsert({
    where: { key: "ml-gru" },
    create: { key: "ml-gru", value: json },
    update: { value: json },
  });
}

/** Brier multi-class: Σ_c (p_c − onehot_c)². */
function brierOf(p: readonly [number, number, number], label: 0 | 1 | 2): number {
  const onehot = label === 0 ? [0, 0, 1] : label === 1 ? [0, 1, 0] : [1, 0, 0]; // [UP, FLAT, DOWN]
  let s = 0;
  for (let c = 0; c < 3; c++) s += (p[c] - onehot[c]) ** 2;
  return s;
}

/** Nhãn hướng từ realised return 5 phiên (cùng ngưỡng ML_LABEL_THRESHOLD). */
function labelOfRet(ret: number): 0 | 1 | 2 {
  if (ret > 0.005) return 2;
  if (ret < -0.005) return 0;
  return 1;
}

/** Mutex nhẹ chống 2 chu kỳ ghi shadow chồng nhau (mlForecastEnsemble có thể
 *  được evidence + synthesize gọi gần đồng thời). */
let shadowInFlight = false;

/**
 * B3 shadow — chạy MỖI chu kỳ khi có model dl-gru (bất kể enabled — layer 1):
 *  1. Settle các phiếu cũ đã đủ 5 phiên tương lai (so Brier GRU vs MLP cùng
 *     phiên — realised từ chuỗi rổ hiện tại) → rolling + consecutiveWorse.
 *  2. Ghi phiếu shadow HÔM NAY (1 phiên — 1 dòng, không trùng ngày).
 *  3. Kill-switch tầng 2: enabled && consecutiveWorse ≥ 5 → tự hạ + audit.
 *  Fail-soft tuyệt đối: mọi lỗi nuốt thành log — KHÔNG bao giờ làm hỏng
 *  ensemble chính (nguyên tắc §1.6).
 */
async function shadowTick(
  gruModel: { version: number; weights: string } | null,
  basket: number[],
  basketDates: string[],
  mlpProbs: [number, number, number] | null,
  gruProbs: [number, number, number] | null
): Promise<void> {
  if (gruModel == null) return; // cổng chưa mở — 0 side-effect (bit-flip)
  if (shadowInFlight) return;
  shadowInFlight = true;
  try {
    const setting = await readGruSetting();
    let changed = false;
    const dateIndex = new Map<string, number>();
    basketDates.forEach((d, i) => dateIndex.set(d, i));

    // ── 1. Settle phiếu đủ 5 phiên tương lai ──
    const stillPending: ShadowPrediction[] = [];
    const { gruBrier, mlpBrier } = setting.shadow;
    let settled = setting.shadow.settled;
    let consecutiveWorse = setting.shadow.consecutiveWorse;
    let gruBrierSum: number | null = gruBrier != null ? gruBrier * settled : null;
    let mlpBrierSum: number | null = mlpBrier != null ? mlpBrier * settled : null;
    for (const pred of setting.shadow.pending) {
      const idx = dateIndex.get(pred.date);
      if (idx == null || idx + 5 >= basket.length) {
        stillPending.push(pred); // chưa đủ 5 phiên tương lai — giữ lại
        continue;
      }
      const ret = basket[idx + 5] / basket[idx] - 1;
      const label = labelOfRet(ret);
      if (pred.gru != null) {
        const b = brierOf(pred.gru, label);
        gruBrierSum = (gruBrierSum ?? 0) + b;
        pred.gruBrier = Number(b.toFixed(4));
      }
      if (pred.mlp != null) {
        const b = brierOf(pred.mlp, label);
        mlpBrierSum = (mlpBrierSum ?? 0) + b;
        pred.mlpBrier = Number(b.toFixed(4));
      }
      if (pred.gru != null && pred.mlp != null) {
        consecutiveWorse = (pred.gruBrier ?? 0) > (pred.mlpBrier ?? 0) ? consecutiveWorse + 1 : 0;
      }
      settled++;
      changed = true;
    }
    const nextPending: ShadowPrediction[] = [...stillPending];

    // ── 2. Ghi phiếu hôm nay (1 dòng/ngày phiên — theo bar cuối rổ) ──
    const today = basketDates.length > 0 ? basketDates[basketDates.length - 1] : null;
    if (today != null && !nextPending.some((p) => p.date === today)) {
      nextPending.push({ date: today, gru: gruProbs, mlp: mlpProbs });
      changed = true;
    }

    if (!changed) return;

    let enabled = setting.enabled;
    // ── 3. Kill-switch tầng 2: tệ hơn 5 phiên liên tiếp → tự hạ ──
    if (enabled && consecutiveWorse >= KILL_WORSE_STREAK) {
      enabled = false;
      console.warn(
        `[ml/ensemble] kill-switch GRU tầng 2: Brier tệ hơn MLP ${consecutiveWorse} phiên liên tiếp — tự hạ (audit ML_GRU_KILL)`
      );
      try {
        await db.auditLog.create({
          data: {
            action: "ML_GRU_KILL",
            entity: "MlModel",
            entityId: gruModel.version.toString(),
            after: JSON.stringify({
              reason: "brier-worse-5-consecutive",
              consecutiveWorse,
              gruBrier: gruBrierSum != null && settled > 0 ? gruBrierSum / settled : null,
              mlpBrier: mlpBrierSum != null && settled > 0 ? mlpBrierSum / settled : null,
              at: new Date().toISOString(),
            }),
          },
        });
      } catch (auditErr) {
        console.error("[ml/ensemble] ghi audit ML_GRU_KILL lỗi (bỏ qua):", auditErr);
      }
    }

    await writeGruSetting({
      enabled,
      shadow: {
        settled,
        gruBrier: gruBrierSum != null && settled > 0 ? Number((gruBrierSum / settled).toFixed(4)) : gruBrier,
        mlpBrier: mlpBrierSum != null && settled > 0 ? Number((mlpBrierSum / settled).toFixed(4)) : mlpBrier,
        consecutiveWorse,
        activatedAt: setting.shadow.activatedAt,
        pending: nextPending.slice(-SHADOW_LOG_CAP),
      },
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[ml/ensemble] shadowTick lỗi (fail-soft, bỏ qua):", err);
  } finally {
    shadowInFlight = false;
  }
}

/**
 * Tính ensemble ML Forecast. Trả null khi không đủ dữ liệu nền (rổ trống) —
 * module đọc (evidence/runMlForecast) phải bỏ phiếu im lặng, KHÔNG throw.
 */
export async function mlForecastEnsemble(): Promise<MlEnsembleResult | null> {
  /* ── 1. Phần linreg: rổ top-10 HOSE equal-weight → chuỗi proj₅ trượt ── */
  const series = await loadTopSeries(10);
  const usable = series.filter((s) => s.closes.length >= PROJ_WINDOW + MIN_PROJ_SAMPLES);
  if (usable.length === 0) return null;

  const m = Math.min(...usable.map((s) => s.closes.length));
  // Chuẩn hoá mỗi mã = 1.0 tại phiên đầu cửa sổ rồi lấy trung bình (equal-weight)
  const basket: number[] = [];
  const basketDates: string[] = [];
  for (let i = 0; i < m; i++) {
    let sum = 0;
    let cnt = 0;
    for (const s of usable) {
      const start = s.closes[s.closes.length - m];
      if (start > 0) {
        sum += s.closes[s.closes.length - m + i] / start;
        cnt++;
      }
    }
    basket.push(cnt > 0 ? sum / cnt : 1);
    // Ngày phiên của index i — lấy từ mã đầu tiên đủ dài (các mã cùng khung
    // phiên EOD HOSE; sai lệnh ngày lễ giữa các mã không ảnh hưởng logic 5 phiên)
    basketDates.push(usable[0].bars[usable[0].bars.length - m + i].date.toISOString().slice(0, 10));
  }

  // proj₅ trượt trên cửa sổ 60 phiên: slope×5/last×100
  const projs: number[] = [];
  for (let i = PROJ_WINDOW - 1; i < basket.length; i++) {
    const win = basket.slice(i - PROJ_WINDOW + 1, i + 1);
    const last = basket[i];
    if (last > 0) projs.push((linregSlope(win) * 5) / last * 100);
  }
  const lastProj = projs.length > 0 ? projs[projs.length - 1] : null;
  const projMean = meanOf(projs);
  const projStd = stdOf(projs);
  const z =
    projs.length >= MIN_PROJ_SAMPLES && projStd > 0 && lastProj != null
      ? (lastProj - projMean) / projStd
      : null;

  /* ── 2. Phần MLP: MlModel serving → predictProba rổ top-10 ── */
  const model = await db.mlModel.findFirst({
    where: { kind: "dl-mlp", status: "serving" },
    select: { version: true, weights: true },
  });
  let pUp: number | null = null;
  let pDown: number | null = null;
  let pFlat: number | null = null;
  let mlpProbs: [number, number, number] | null = null;
  if (model) {
    try {
      const mlp = MLP.fromJSON(model.weights);
      const feats = await latestFeatures();
      if (feats.length > 0) {
        const probs = feats.map((f) => mlp.predictProba(f.x)); // [pUp, pFlat, pDown]
        let up = 0;
        let flat = 0;
        let down = 0;
        for (const p of probs) {
          up += p[0];
          flat += p[1];
          down += p[2];
        }
        const total = up + flat + down; // tái chuẩn hoá chống trôi Σ≠1
        if (total > 0) {
          pUp = up / total;
          pFlat = flat / total;
          pDown = down / total;
          mlpProbs = [pUp, pFlat, pDown];
        }
      }
    } catch {
      // mô hình hỏng → fallback linreg im lặng
    }
  }

  /* ── 2b. B3: GRU giọng thứ ba (GATED — chỉ khi model dl-gru tồn tại) ── */
  const gruModel = await db.mlModel
    .findFirst({
      where: { kind: "dl-gru" },
      orderBy: { version: "desc" },
      select: { version: true, weights: true },
    })
    .catch(() => null);
  let gruProbs: [number, number, number] | null = null;
  let gruActive = false;
  let gruVersion: number | null = null;
  if (gruModel) {
    gruVersion = gruModel.version;
    try {
      // Shadow tick TRƯỚC (settle phiếu cũ — có thể tự hạ kill-switch) rồi
      // đọc lại enabled để quyết định giọng thứ ba trong CHÍNH chu kỳ này.
      const gru = GRU.fromJSON(gruModel.weights);
      const windows = await latestFeatureWindows();
      if (windows.length > 0) {
        const probs = windows.map((w) => gru.predictProba(w.x));
        let up = 0;
        let flat = 0;
        let down = 0;
        for (const p of probs) {
          up += p[0];
          flat += p[1];
          down += p[2];
        }
        const total = up + flat + down;
        if (total > 0) gruProbs = [up / total, flat / total, down / total];
      }
      await shadowTick(gruModel, basket, basketDates, mlpProbs, gruProbs);
      const setting = await readGruSetting();
      gruActive =
        setting.enabled &&
        setting.shadow.settled >= SHADOW_MIN_SESSIONS &&
        setting.shadow.gruBrier != null &&
        setting.shadow.mlpBrier != null &&
        setting.shadow.gruBrier <= setting.shadow.mlpBrier &&
        gruProbs != null;
    } catch (err) {
      // GRU hỏng → giọng thứ ba tắt im lặng, ensemble 2 giọng như cũ
      console.error("[ml/ensemble] GRU giọng thứ ba lỗi (fail-soft, bỏ qua):", err);
      gruActive = false;
    }
  }

  /* ── 3. Ensemble score + deadband FLAT ── */
  let score: number | null = null;
  let direction: "UP" | "DOWN" | "FLAT";
  if (pUp != null && pDown != null) {
    const wMlp = gruActive ? W_MLP_V3 : W_MLP;
    const wLin = gruActive ? W_LINREG_V3 : W_LINREG;
    score =
      wMlp * (pUp - pDown) +
      (gruActive && gruProbs != null ? W_GRU * (gruProbs[0] - gruProbs[2]) : 0) +
      (z != null ? wLin * Math.tanh(z) : 0);
    direction =
      Math.abs(score) < ML_ENSEMBLE_DEADBAND ? "FLAT" : score > 0 ? "UP" : "DOWN";
  } else {
    // Fallback linreg thuần — ngưỡng ±1% như công thức runMlForecast #35
    direction =
      lastProj != null
        ? lastProj > 1
          ? "UP"
          : lastProj < -1
            ? "DOWN"
            : "FLAT"
        : "FLAT";
  }

  const confidence =
    pUp != null && pDown != null && pFlat != null
      ? Math.max(pUp, pDown, pFlat)
      : 0.5; // fallback linreg — tự tin khiêm tốn

  const parts: string[] = [];
  if (pUp != null && pDown != null) {
    parts.push(`MLP v${model?.version} pUp ${(pUp * 100).toFixed(1)}% / pDown ${(pDown * 100).toFixed(1)}%`);
  } else {
    parts.push(`linreg fallback (chưa có MlModel serving)`);
  }
  if (gruActive && gruProbs != null) {
    parts.push(
      `GRU v${gruVersion} pUp ${(gruProbs[0] * 100).toFixed(1)}% / pDown ${(gruProbs[2] * 100).toFixed(1)}% (trọng số 0,5/0,3/0,2)`
    );
  }
  if (z != null) parts.push(`z=${z.toFixed(2)}`);
  if (lastProj != null) parts.push(`proj₅ ${lastProj >= 0 ? "+" : ""}${lastProj.toFixed(2)}%`);
  if (score != null) parts.push(`score ${score >= 0 ? "+" : ""}${score.toFixed(3)} (deadband ±0,05)`);
  const note = `Ensemble MLP+linreg${gruActive ? "+GRU" : ""} top-${usable.length} HOSE: ${parts.join(" · ")} → ${direction === "UP" ? "TĂNG" : direction === "DOWN" ? "GIẢM" : "ĐI NGANG"}`;

  return {
    direction,
    score,
    z,
    lastProj,
    pUp,
    pDown,
    pFlat,
    confidence,
    modelVersion: model?.version ?? null,
    basketSize: usable.length,
    note,
    gruVersion: gruActive ? gruVersion : null,
  };
}
