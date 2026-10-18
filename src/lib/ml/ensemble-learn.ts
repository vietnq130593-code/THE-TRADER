/**
 * src/lib/ml/ensemble-learn.ts — F-07 (#129 — AI_ENGINEER_REVIEW_BRAIN §3 F-07)
 * META-LEARNER TRỌNG SỐ ENSEMBLE HỌC TỪ D-LEDGER (thay hardcode 0,7/0,3).
 *
 * Triết lý kế thừa Bandit: "uy tín cử tri phải học" → tỉ lệ GIỌNG NÓI trong
 * ml-forecast cũng phải học. Nguồn dữ liệu = chính D-LEDGER phiếu bầu:
 *   • Khi cast: evidence.ts ghi vector giọng nói {pUpMlp, pDownMlp, pFlatMlp,
 *     zLinreg, gru?} vào MarketAssessment.detail.agentVotes[ml-forecast].meta.
 *   • Khi settle: bandit.ts chép vector + realizedDir vào BanditEvent.meta.
 *   • Phiếu đã settle ≥ 60 (cold-start) → học logistic softmax 3 lớp:
 *         P(dir | voice) qua đặc trưng [1, pUp−pDown, tanh(z)] — softmax
 *         tuyến tính theo trọng số w (ridge λ=0,5 — chống overfit giọng yếu),
 *         walk-forward 70/30 THEO THỜI GIAN (val = block cuối).
 *   • AUDIT 137 B14 — artifact được kiểm định = artifact được deploy: gate
 *     chấm Brier của CHÍNH công thức serving (score = wMlp·mlpDiff +
 *     wLinreg·tanh(z) → pf mapping) với cặp scalar rút từ w, so với fixed
 *     0,7/0,3 cùng công thức; chỉ bật khi thắng fixed − deadband 0,05·Brier
 *     (đặc tả F-07 mục 3); ngược lại giữ hardcode + whyRejected (N6).
 *     Trước đây gate chấm softmax(w·x) đầy đủ — mô hình KHÔNG BAO GIỜ deploy,
 *     “pass” không chứng minh gì cho cặp trọng số thật.
 *
 * Kill-switch: xoá AppSetting "ml-ensemble-weights" → ensemble fallback
 * fixed TỨC THÌ (mlForecastEnsemble đọc thiếu → dùng hằng số module).
 *
 * 0 LLM · thuần TypeScript · deterministic (seed cố định SGD).
 */

import { db } from "@/lib/db";

/** AppSetting key của trọng số đã học (F-07 — kill-switch xoá key này). */
export const ENSEMBLE_WEIGHTS_SETTING_KEY = "ml-ensemble-weights";
/** Số phiếu settle tối thiểu trước khi học (cold-start giữ hardcode). */
export const ENSEMBLE_LEARN_MIN_VOTES = 60;
/** Ridge λ (đặc tả F-07 mục 2). */
export const ENSEMBLE_LEARN_RIDGE = 0.5;
/** Deadband: learned phải thắng fixed ≥ 0,05 × Brier fixed. */
export const ENSEMBLE_LEARN_DEADBAND_FACTOR = 0.05;
/** Trọng số fixed để so (phải khớp ensemble.ts W_MLP/W_LINREG 2 giọng). */
export const FIXED_WEIGHTS = { mlp: 0.7, linreg: 0.3 } as const;

/** Trọng số đã học lưu AppSetting "ml-ensemble-weights". */
export interface EnsembleWeightsSetting {
  source: "learned" | "rejected";
  /** Trọng số MLP (giọng 1) — chỉ dùng khi source=learned. */
  wMlp: number;
  /** Trọng số linreg (giọng 2). */
  wLinreg: number;
  /** Số phiếu có voice vector dùng train. */
  nVotes: number;
  /** Brier val của softmax(w·x) đầy đủ — CHỈ CHẨN ĐOÁN (không phải artifact
   *  deploy; AUDIT 137 B14 giữ làm tham khảo). */
  valBrier: number | null;
  /** AUDIT 137 B14 — Brier val của CHÍNH công thức deploy (cặp scalar
   *  wMlp/wLinreg → score → pf mapping) — số gate so với fixed. */
  valBrierDeployed?: number | null;
  /** Brier val của trọng số fixed trên cùng split (đối chứng). */
  valBrierFixed: number | null;
  /** Lý do giữ fixed khi rejected (whyRejected — N6 trung thực). */
  whyRejected?: string;
  trainedAt: string;
}

/** Vector giọng nói 1 phiếu (parse từ BanditEvent.meta). */
interface VoiceVector {
  pUp: number;
  pDown: number;
  pFlat: number;
  z: number | null;
  /** Giá trị pUp−pDown đã hiệu chuẩn? — mặc định false (phiếu cũ). */
  realizedDir: number; // 0=DOWN · 1=FLAT · 2=UP
  castAt: Date;
}

/** Parse meta JSON của BanditEvent → VoiceVector (null khi thiếu/hỏng). */
function parseVoice(meta: string | null | undefined): VoiceVector | null {
  if (!meta) return null;
  try {
    const m = JSON.parse(meta) as Record<string, unknown>;
    const voice = (m.voice ?? m) as Record<string, unknown>;
    // FIX #130: null/undefined phải bị loại (Number(null) = 0 "hữu hạn" —
    // phiếu fallback linreg có pUp/pDown/pFlat null sẽ lọt vào làm rác [0,0,0])
    const pUp = voice.pUp == null ? NaN : Number(voice.pUp);
    const pDown = voice.pDown == null ? NaN : Number(voice.pDown);
    const pFlat = voice.pFlat == null ? NaN : Number(voice.pFlat);
    const realized = m.realizedDir ?? voice.realizedDir;
    const dir = realized === "UP" ? 2 : realized === "DOWN" ? 0 : realized === "FLAT" ? 1 : -1;
    if (!Number.isFinite(pUp) || !Number.isFinite(pDown) || !Number.isFinite(pFlat) || dir < 0) {
      return null;
    }
    return {
      pUp,
      pDown,
      pFlat,
      z: Number.isFinite(Number(voice.z)) ? Number(voice.z) : null,
      realizedDir: dir,
      castAt: new Date(0),
    };
  } catch {
    return null;
  }
}

/** Đặc trưng tuyến tính của 1 phiếu: [1 (bias), mlpDiff, linregSignal]. */
function voiceFeatures(v: VoiceVector): number[] {
  return [1, v.pUp - v.pDown, v.z != null ? Math.tanh(v.z) : 0];
}

/** Softmax 3 lớp từ điểm tuyến tính w·x. */
function softmax3(z: number[]): number[] {
  const m = Math.max(...z);
  const e = z.map((v) => Math.exp(v - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}

/** Brier multi-class (class [DOWN, FLAT, UP]). */
function brier3(probs: number[], label: number): number {
  let s = 0;
  for (let c = 0; c < 3; c++) {
    const onehot = c === label ? 1 : 0;
    s += (probs[c]! - onehot) ** 2;
  }
  return s;
}

/** Đọc AppSetting trọng số — null = chưa từng học (cold-start fixed). */
export async function readEnsembleWeights(): Promise<EnsembleWeightsSetting | null> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: ENSEMBLE_WEIGHTS_SETTING_KEY } });
    if (!row) return null;
    const parsed = JSON.parse(row.value) as Partial<EnsembleWeightsSetting>;
    if (typeof parsed.source !== "string") return null;
    return {
      source: parsed.source === "learned" ? "learned" : "rejected",
      wMlp: typeof parsed.wMlp === "number" ? parsed.wMlp : FIXED_WEIGHTS.mlp,
      wLinreg: typeof parsed.wLinreg === "number" ? parsed.wLinreg : FIXED_WEIGHTS.linreg,
      nVotes: typeof parsed.nVotes === "number" ? parsed.nVotes : 0,
      valBrier: typeof parsed.valBrier === "number" ? parsed.valBrier : null,
      valBrierDeployed: typeof parsed.valBrierDeployed === "number" ? parsed.valBrierDeployed : null,
      valBrierFixed: typeof parsed.valBrierFixed === "number" ? parsed.valBrierFixed : null,
      whyRejected: typeof parsed.whyRejected === "string" ? parsed.whyRejected : undefined,
      trainedAt: typeof parsed.trainedAt === "string" ? parsed.trainedAt : "",
    };
  } catch {
    return null;
  }
}

/**
 * Huấn luyện meta-learner từ D-LEDGER — gọi sau sweep Chủ nhật (F-07 mục 4)
 * hoặc tay qua POST /api/ml/ensemble-learn. Trạng thái:
 *   • < 60 phiếu có voice → KHÔNG ghi AppSetting (cold-start giữ fixed).
 *   • Học xong mà valBrier không thắng fixed quá deadband → ghi
 *     source="rejected" + whyRejected (UI hiển thị đúng lý do).
 *   • Thắng → ghi source="learned" (ensemble tự đổi trọng số chu kỳ kế).
 */
export async function trainEnsembleWeights(): Promise<{
  ok: boolean;
  nVotes: number;
  outcome: "cold-start" | "learned" | "rejected" | "error";
  setting: EnsembleWeightsSetting | null;
  note: string;
}> {
  try {
    // 1) Đọc phiếu ml-forecast đã settle + có voice vector trong meta
    const events = await db.banditEvent.findMany({
      where: { agentCode: "ml-forecast", settledAt: { not: null } },
      orderBy: { castAt: "asc" },
      select: { meta: true, castAt: true },
      take: 500,
    });
    const voices: VoiceVector[] = [];
    for (const e of events) {
      const v = parseVoice(e.meta);
      if (v == null) continue;
      v.castAt = e.castAt;
      voices.push(v);
    }
    if (voices.length < ENSEMBLE_LEARN_MIN_VOTES) {
      return {
        ok: true,
        nVotes: voices.length,
        outcome: "cold-start",
        setting: null,
        note: `cold-start: ${voices.length}/${ENSEMBLE_LEARN_MIN_VOTES} phiếu có voice vector — giữ trọng số fixed 0,7/0,3 (phiếu mới bắt đầu ghi meta từ #129)`,
      };
    }

    // 2) Walk-forward 70/30 THEO THỜI GIAN (voices đã sort castAt asc)
    const nTrain = Math.floor(voices.length * 0.7);
    const train = voices.slice(0, nTrain);
    const val = voices.slice(nTrain);

    // 3) Logistic softmax 3 lớp — SGD mini-batch, ridge chỉ áp W (không bias),
    //    deterministic seed cố định (mulberry32 local)
    let seed = 129;
    const rng = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const F = 3; // số đặc trưng [bias, mlpDiff, tanh(z)]
    const C = 3; // 3 class
    const w: number[][] = Array.from({ length: C }, () => new Array<number>(F).fill(0));
    const lr = 0.05;
    const epochs = 200;
    const batch = 16;
    for (let ep = 0; ep < epochs; ep++) {
      const order = train.map((_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [order[i], order[j]] = [order[j]!, order[i]!];
      }
      const grads: number[][] = Array.from({ length: C }, () => new Array<number>(F).fill(0));
      for (let b = 0; b < order.length; b += batch) {
        for (const g of grads) g.fill(0);
        const end = Math.min(order.length, b + batch);
        let used = 0;
        for (let k = b; k < end; k++) {
          const v = train[order[k]!]!;
          const x = voiceFeatures(v);
          const probs = softmax3([0, 1, 2].map((c) => w[c]!.reduce((s, wj, j) => s + wj * (x[j] ?? 0), 0)));
          for (let c = 0; c < C; c++) {
            const d = probs[c]! - (c === v.realizedDir ? 1 : 0);
            for (let j = 0; j < F; j++) {
              grads[c]![j]! += d * (x[j] ?? 0);
            }
          }
          used++;
        }
        for (let c = 0; c < C; c++) {
          for (let j = 0; j < F; j++) {
            const ridge = j === 0 ? 0 : ENSEMBLE_LEARN_RIDGE * w[c]![j]!;
            w[c]![j]! -= (lr * (grads[c]![j]! / Math.max(1, used) + ridge)) / 1;
          }
        }
      }
    }

    // 4) AUDIT 137 B14 — RÚT cặp scalar deploy TƯỚC khi chấm gate: wMlp ~
    //    |w của class UP trên đặc trưng mlpDiff|, wLinreg ~ |w trên đặc trưng
    //    tanh(z)| — chuẩn hoá Σ=1. Cặp 2 số VÔ HƯỚNG này mới là thứ được
    //    TRIỂN KHAI vào công thức ensemble serving (softmax đầy đủ không
    //    bao giờ serve).
    const mlpContribution = (Math.abs(w[2]![1]!) + Math.abs(w[0]![1]!)) / 2;
    const linContribution = (Math.abs(w[2]![2]!) + Math.abs(w[0]![2]!)) / 2;
    const total = mlpContribution + linContribution;
    let wMlp: number = FIXED_WEIGHTS.mlp;
    let wLinreg: number = FIXED_WEIGHTS.linreg;
    if (total > 1e-9) {
      wMlp = Number(Math.max(0.1, Math.min(0.9, mlpContribution / total)).toFixed(3));
      wLinreg = Number((1 - wMlp).toFixed(3));
    }

    // 5) Đối chiếu trên CÙNG val split — AUDIT 137 B14: gate so Brier của
    //    CHÍNH công thức deployed (score → pf mapping như baseline fixed)
    //    với cặp (wMlp, wLinreg) vừa rút, so với fixed 0,7/0,3 cùng công
    //    thức. brierLearned (softmax đầy đủ) chỉ còn là số chẩn đoán.
    const brierOfPair = (wM: number, wL: number): number => {
      let b = 0;
      for (const v of val) {
        const score = wM * (v.pUp - v.pDown) + (v.z != null ? wL * Math.tanh(v.z) : 0);
        // fixed: score tổng → map [DOWN, FLAT, UP] qua (1−|score|, ...) heuristic
        const pf = [Math.max(0, -score), Math.max(0, 1 - Math.abs(score)), Math.max(0, score)];
        const pfSum = pf[0]! + pf[1]! + pf[2]!;
        const pfn = pfSum > 0 ? pf.map((p) => p / pfSum) : [1 / 3, 1 / 3, 1 / 3];
        b += brier3(pfn, v.realizedDir);
      }
      return b / val.length;
    };
    let brierLearned = 0;
    for (const v of val) {
      const x = voiceFeatures(v);
      const pl = softmax3([0, 1, 2].map((c) => w[c]!.reduce((s, wj, j) => s + wj * (x[j] ?? 0), 0)));
      brierLearned += brier3(pl, v.realizedDir);
    }
    const valBrier = Number((brierLearned / val.length).toFixed(4));
    const valBrierDeployed = Number(brierOfPair(wMlp, wLinreg).toFixed(4));
    const valBrierFixed = Number(brierOfPair(FIXED_WEIGHTS.mlp, FIXED_WEIGHTS.linreg).toFixed(4));
    const deadband = ENSEMBLE_LEARN_DEADBAND_FACTOR * Math.max(0.1, valBrierFixed);
    // AUDIT 137 B14 — gate trên artifact DEPLOY (cặp scalar + công thức
    // serving thật), không còn trên softmax không bao giờ deploy.
    const beats = valBrierDeployed < valBrierFixed - deadband;

    const setting: EnsembleWeightsSetting = {
      source: beats ? "learned" : "rejected",
      wMlp,
      wLinreg,
      nVotes: voices.length,
      valBrier,
      valBrierDeployed,
      valBrierFixed,
      ...(beats
        ? {}
        : {
            whyRejected: `valBrier deployed ${valBrierDeployed} không thắng fixed ${valBrierFixed} − deadband ${deadband.toFixed(4)} — giữ 0,7/0,3 (AUDIT 137 B14: gate chấm công thức deploy thật, softmax chẩn đoán ${valBrier})`,
          }),
      trainedAt: new Date().toISOString(),
    };
    await db.appSetting.upsert({
      where: { key: ENSEMBLE_WEIGHTS_SETTING_KEY },
      create: { key: ENSEMBLE_WEIGHTS_SETTING_KEY, value: JSON.stringify(setting) },
      update: { value: JSON.stringify(setting) },
    });
    try {
      await db.auditLog.create({
        data: {
          action: "ML_WEIGHTS_SWITCHED",
          entity: "AppSetting",
          entityId: ENSEMBLE_WEIGHTS_SETTING_KEY,
          after: JSON.stringify(setting),
        },
      });
    } catch {
      // audit fail-soft
    }
    return {
      ok: true,
      nVotes: voices.length,
      outcome: beats ? "learned" : "rejected",
      setting,
      note: beats
        ? `learned: wMlp ${wMlp}/wLinreg ${wLinreg} — valBrier deployed ${valBrierDeployed} vs fixed ${valBrierFixed} (n=${voices.length}; softmax chẩn đoán ${valBrier})`
        : `rejected: ${setting.whyRejected ?? ""}`,
    };
  } catch (err) {
    console.error("[ml/ensemble-learn] trainEnsembleWeights lỗi (fail-soft):", err);
    return { ok: false, nVotes: 0, outcome: "error", setting: null, note: err instanceof Error ? err.message : String(err) };
  }
}
