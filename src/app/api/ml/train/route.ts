import { NextResponse } from "next/server";
// F-00 (#129): audit ML_TRAIN_AUTO (đường engine force=false).
import { db } from "@/lib/db";
import {
  buildTrainingSet,
  loadTopSeries,
  trainingWindowDigest,
  ML_FEATURE_COUNT,
  ML_FEATURE_SET,
  ML_HORIZON_DAYS,
  type TrainingSetWithSeries,
} from "@/lib/ml/features";
import { GRU } from "@/lib/ml/gru";
import { buildTrainingSequences, ML_GRU_WINDOW } from "@/lib/ml/features";
import { buildBasket, policyStance, trainQTable, regimeBitsOf } from "@/lib/ml/rl";
// F-09 (#129): MLP đa nhiệm 3 đầu ra (hướng + biên độ + biến động).
import { MultitaskMLP } from "@/lib/ml/multitask";
import { standardize } from "@/lib/ml/features";
import { settlePendingRewards } from "@/lib/ml/bandit";
// C1/F2 (#99 — ML_AUTOML_BLUEPRINT §0.9-F2): toàn bộ bộ train + lưu dl-mlp +
// guards A4/B1 + mutex/cooldown F-612R-06 trích sang lib — route và sweep route
// cùng MỘT nguồn (chia sẻ mutex + đánh version). Extraction là PURE REFACTOR:
// mọi hành vi HTTP dưới đây giữ NGUYÊN như bản battle-tested #35→#94.
import {
  clearTrainCooldown,
  gateVerdictOf,
  markTrainAttempt,
  recentWindowHashesOf,
  releaseTrainLock,
  trainCooldownState,
  trainDlMlp,
  tryAcquireTrainLock,
  saveModel,
  TRAIN_FRACTION,
  type AppliedMlpTuning,
  type DlMlpPromotion,
  type TrainedDlMlpMetrics,
} from "@/lib/ml/train-mlp";
// F-18 (#131): featureSet của tập train engine theo ml-tuning (NAS auto-promote).
import { readEffectiveMlTuning } from "@/lib/ml/tuning";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const runtime = "nodejs";

/**
 * POST /api/ml/train (phiên #35 — Task 35-ML) — huấn luyện MÔ HÌNH THẬT
 * trên dữ liệu EOD Supabase: MLP backprop+Adam (dl-mlp) + Q-learning tabular
 * 48×3 (rl-q). Trước khi train luôn kết toán bandit (settlePendingRewards —
 * nhanh, 0 LLM). Hai train chạy TUẦN TỰ (không Promise.all — tránh ép CPU
 * đè nhau), mỗi cái gói try/catch để hỏng cái này không chặn cái kia.
 *
 * Versioning: updateMany bản serving cùng kind → archived, create version
 * max+1 (weights = JSON mạng/Q-table, featureNorm = z-score, metrics JSON).
 * Cooldown in-memory → 429 kèm Retry-After (pattern synthesize #34).
 *
 * F-612R-06/#61 (Vòng 2): cooldown 10s cũ NGẮN HƠN thời lượng train thật
 * (~12s đo #60) + không mutex → POST thứ 2 lọt vào giữa chừng: nextVersion
 * (max+1) + archive + create là 3 await rời → 2 hàng (kind,version) trùng +
 * 2 hàng serving cùng lúc; archive xong rồi create fail → kind KHÔNG còn
 * serving (ensemble âm thầm fallback linreg). Giờ: cooldown 60s + mutex
 * in-flight + saveModel trong MỘT $transaction.
 *
 * A4 (#79 — ML_OPS_BLUEPRINT §3, duyệt phiên #79 Q2): retrain định kỳ Chủ
 * nhật 04:00 ICT gọi với body {"force": false} — skip-guard windowHash: cùng
 * cửa sổ dữ liệu với bản dl-mlp đang serving HOẶC bản vừa train gần nhất
 * (không có bar mới) → KHÔNG train (fast path, $0). Body mặc định (rỗng/không
 * force) = force true — nút bấm thủ công giữ nguyên hành vi cũ. Cooldown +
 * mutex áp dụng cho CẢ HAI đường.
 *
 * A3 (#79 — featureHist hợp đồng cốt với agent PSI): lúc lưu bản dl-mlp mới,
 * meta thêm histogram 10 bucket × 10 chiều từ đặc trưng RAW (KHÔNG
 * z-chuẩn-hoá) của TRAIN split — shape {edges: number[][], train: number[][]}
 * cố định, KHÔNG đổi tên trường. (Nay trong lib train-mlp.ts.)
 *
 * A4 serving-swap guard: bản dl-mlp mới chỉ lên "serving" khi valAcc ≥ bản
 * serving hiện tại (nguyên tắc §1.5 — mô hình dưới ngưỡng không lên serving);
 * thua → lưu "archived", giữ bản cũ serving, response kèm promoted:false.
 * rl-q giữ hành vi cũ (luôn serving). Không có bản serving trước đó → promote.
 *
 * B1 (#81 — ML_OPS_BLUEPRINT §4): train trên bộ v2-lag16 (16 chiều) — meta
 * ghi featureSet "v2-lag16". Serving-swap guard mở rộng: bản mới khác
 * featureSet với bản serving (v8-lag10) chỉ được promote khi CỔNG B2
 * (AppSetting "ml-gate") verdict PASS — "serving vẫn là v8 cho tới khi cổng
 * B2 xử quyết". Skip-guard A4 so hash VÀ featureSet (hash không đổi khi đổi
 * bộ đặc trưng — cùng dữ liệu, khác đặc trưng).
 *
 * B3 (#81): target "dl-gru" — CHỈ chạy khi cổng B2 PASS (AppSetting ml-gate
 * verdict === "PASS"), lưu kind "dl-gru" status "archived" (shadow — lên
 * ensemble qua 3 lớp bảo vệ trong ensemble.ts, không bao giờ serving trực
 * tiếp). Cổng chưa mở → 400 trung thực kèm số liệu cổng.
 *
 * C1 (#99): mutex + cooldown sống trong lib train-mlp.ts — sweep route
 * (/api/ml/sweep).serialise qua CÙNG mutex/cooldown nên train tay khi sweep
 * đang chạy → 429 (không bao giờ 2 hàng trùng version).
 */

type MlTrainTarget = "all" | "dl-mlp" | "rl-q" | "dl-gru" | "dl-mtl";

/** Metrics trả về FE — khớp RlQMetrics trong src/hooks/use-ml.ts. */
interface TrainedRlQMetrics {
  episodes: number;
  epsilonEnd: number;
  avgRewardLast50: number;
  states: number;
  actions: number;
  stance: string;
  exposure: number;
  qMax: number;
}

/** Metrics GRU trả về — kind dl-gru (B3 #81). */
interface TrainedGruMetrics {
  epochs: number;
  samples: number;
  trainAcc: number;
  valAcc: number;
  trainLoss: number;
  valLoss: number;
  params: number;
  window: number;
  horizonDays: number;
  features: number;
}

/**
 * B3 (#81) — Train GRU-24 (giọng thứ ba) trên top-20 thanh khoản: chuỗi 20
 * phiên × 16 đặc trưng → lưu kind "dl-gru" status "archived" (SHADOW — lên
 * ensemble qua 3 lớp bảo vệ trong ensemble.ts, không bao giờ serving trực
 * tiếp). Caller (POST) đã chặn khi cổng B2 chưa PASS.
 */
async function trainDlGru(): Promise<TrainedGruMetrics> {
  const set = await buildTrainingSequences(20);
  if (set.X.length < 600) {
    throw new Error(
      `chỉ có ${set.X.length} mẫu chuỗi GRU (cần ≥ 600) — kiểm tra dữ liệu EOD`
    );
  }
  const windowMeta = trainingWindowDigest(set.series, {
    samples: set.X.length,
    featureCount: ML_FEATURE_COUNT,
  });
  // Chuẩn hoá theo chiều đặc trưng trên TRAIN split (áp cho MỌI bước) —
  // dùng cùng cut 80/20 thời gian như fit().
  const nTrain = Math.floor(set.X.length * TRAIN_FRACTION);
  const mean = new Array<number>(ML_FEATURE_COUNT).fill(0);
  const std = new Array<number>(ML_FEATURE_COUNT).fill(1);
  for (let i = 0; i < nTrain; i++) {
    for (let t = 0; t < ML_GRU_WINDOW; t++) {
      for (let j = 0; j < ML_FEATURE_COUNT; j++) mean[j] += set.X[i][t][j];
    }
  }
  const cells = nTrain * ML_GRU_WINDOW;
  for (let j = 0; j < ML_FEATURE_COUNT; j++) mean[j] /= Math.max(1, cells);
  for (let j = 0; j < ML_FEATURE_COUNT; j++) {
    let v = 0;
    for (let i = 0; i < nTrain; i++) {
      for (let t = 0; t < ML_GRU_WINDOW; t++) {
        const d = set.X[i][t][j] - mean[j];
        v += d * d;
      }
    }
    v /= Math.max(1, cells);
    std[j] = v > 0 ? Math.sqrt(v) : 1;
  }
  const Xstd = set.X.map((win) =>
    win.map((step) => step.map((v, j) => (v - mean[j]) / std[j]))
  );

  const gru = new GRU();
  const fit = gru.fit(Xstd, set.y);
  gru.setNorm({ mean, std });

  const metrics: TrainedGruMetrics = {
    epochs: fit.epochs,
    samples: fit.samples,
    trainAcc: fit.trainAcc,
    valAcc: fit.valAcc,
    trainLoss: fit.trainLoss,
    valLoss: fit.valLoss,
    params: fit.params,
    window: fit.window,
    horizonDays: ML_HORIZON_DAYS,
    features: ML_FEATURE_COUNT,
  };
  await saveModel(
    "dl-gru",
    gru.toJSON(),
    JSON.stringify({ mean, std }),
    { ...metrics },
    { ...windowMeta, featureSet: ML_FEATURE_SET, window: ML_GRU_WINDOW },
    { promote: false } // shadow — KHÔNG bao giờ serving trực tiếp (B3)
  );
  return metrics;
}

/**
 * Train Q-learning 48×3 trên rổ top-10 thanh khoản → lưu MlModel kind rl-q
 * (weights = Q-table JSON; metrics kèm stance/exposure/qMax hiện tại).
 */
async function trainRlQ(): Promise<TrainedRlQMetrics> {
  const series = await loadTopSeries(10);
  const closes = series.map((s) => s.closes);
  if (series.length < 5 || Math.min(...closes.map((c) => c.length)) < 80) {
    throw new Error("rổ top-10 không đủ dữ liệu (≥ 80 phiên/mã) để train Q-learning");
  }
  // P1-2 — digest rổ Q-learning (tái lập PIT — cùng hàm với dl-mlp)
  const windowMeta = trainingWindowDigest(series);
  // F-13 (#129)(c): bit regime VNINDEX (SMA50 vs SMA200 từng phiên) → Q-table
  // 96 trạng thái thay 48 — "chính sách 1 bộ cho mọi chế độ là sai về kinh tế
  // học". Fail-soft: không tải được VNINDEX → bảng 48 legacy như cũ.
  let regimeBits: number[] | undefined;
  try {
    const vnindexInst = await db.instrument.findFirst({
      where: { symbol: "VNINDEX", isActive: true },
      select: { id: true },
    });
    if (vnindexInst) {
      const vnindexBars = await db.bar.findMany({
        where: { instrumentId: vnindexInst.id },
        orderBy: { date: "asc" },
        select: { close: true },
      });
      const vnindexCloses = vnindexBars.map((b) => b.close).filter((c) => c > 0);
      const basketProbe = buildBasket(closes);
      regimeBits = regimeBitsOf(vnindexCloses, basketProbe.length);
    }
  } catch (err) {
    console.error("[api/ml/train] regimeBits VNINDEX lỗi (fail-soft → 48-state):", err);
  }
  const q = trainQTable(closes, regimeBits ? { regimeBits } : {});
  const basket = buildBasket(closes);
  const stance = policyStance(q.qTable, basket, 0.5, regimeBits?.[regimeBits.length - 1]);
  const metrics: TrainedRlQMetrics = {
    episodes: q.episodes,
    epsilonEnd: q.epsilonEnd,
    avgRewardLast50: q.avgRewardLast50,
    states: q.states,
    actions: q.actions,
    stance: stance.stance,
    exposure: stance.exposure,
    qMax: stance.qMax,
  };
  await saveModel("rl-q", JSON.stringify({ qTable: q.qTable }), null, { ...metrics }, windowMeta);
  return metrics;
}

/**
 * F-09 (#129) — Train MLP ĐA NHIỆM (kind "dl-mtl", status archived — shadow:
 * lên serving chỉ qua sweep gate như ứng viên, đặc tả F-09 gate MAE vol ≥ 10%
 * so baseline vol20). Backbone 16→24→12 + 3 head (dir 8→3 · mag 4→1 · vol
 * 4→1); Loss CE + 0,3·MSE_mag + 0,3·MSE_vol; nhãn giàu từ labelRichAt.
 */
async function trainDlMtl(): Promise<{
  epochs: number;
  samples: number;
  valAcc: number;
  valLoss: number;
  maeMag: number;
  maeVol: number;
  maeVolBaseline: number;
  volEdgePct: number | null;
  params: number;
}> {
  const set = await buildTrainingSet(20, { richLabels: true });
  if (set.X.length < 600 || !set.rich || set.rich.length !== set.X.length) {
    throw new Error(
      `chỉ có ${set.X.length} mẫu đa nhiệm (cần ≥ 600) — kiểm tra dữ liệu EOD`
    );
  }
  const windowMeta = trainingWindowDigest(set.series, { samples: set.X.length });
  const { mean, std, Xstd } = standardize(set.X);
  const mtl = new MultitaskMLP(set.X[0].length);
  const fit = mtl.fit(Xstd, set.rich);
  mtl.setNorm({ mean, std });
  const volEdgePct =
    fit.maeVolBaseline > 0
      ? Number((((fit.maeVolBaseline - fit.maeVol) / fit.maeVolBaseline) * 100).toFixed(2))
      : null;
  const metrics = {
    ...fit,
    volEdgePct,
    params: mtl.paramCount,
  };
  await saveModel(
    "dl-mtl",
    mtl.toJSON(),
    JSON.stringify({ mean, std }),
    { ...metrics },
    {
      ...windowMeta,
      featureSet: set.featureSet,
      // F-09 — meta mở rộng (MlModelMeta cho phép trường tuỳ chọn qua cast)
      ...({ task: "multitask", note: "F-09 shadow — lên serving qua sweep gate (MAE vol ≥ 10% so baseline)" } as Record<string, unknown>),
    },
    { promote: false } // shadow — KHÔNG serving trực tiếp (đúng N3)
  );
  return metrics;
}

export async function POST(req: Request) {
  // F-612R-06/#61 (Vòng 2) — cooldown check TRƯỚC mutex (429/400 sớm không cắm cờ)
  const now = Date.now();
  const cooldown = trainCooldownState(now);
  if (cooldown.retryAfterSeconds != null) {
    const sinceLast = cooldown.sinceLastMs;
    const retryAfterSeconds = cooldown.retryAfterSeconds;
    return NextResponse.json(
      {
        error: `Huấn luyện vừa chạy cách đây ${Math.floor(sinceLast / 1000)}s. Vui lòng đợi ${retryAfterSeconds}s rồi thử lại.`,
        retryAfterSeconds,
      },
      { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } }
    );
  }
  // C1/F2 (#99): mutex dùng chung với sweep route (lib train-mlp.ts) —
  // tryAcquire check+set một doorway (đúng F-612R-06, message giữ nguyên).
  if (!tryAcquireTrainLock()) {
    return NextResponse.json(
      { error: "Huấn luyện đang chạy (mutex F-612R-06) — vui lòng đợi hoàn tất." },
      { status: 429, headers: { "Retry-After": "30" } }
    );
  }
  try {

  // Body {target, force} — default "all" + force=true (tolerant: body rỗng/JSON
  // hỏng đều dùng mặc định — nút bấm thủ công giữ hành vi cũ; A4 gửi force:false)
  let target: MlTrainTarget = "all";
  let force = true;
  try {
    const body = (await req.json()) as { target?: unknown; force?: unknown } | null;
    if (body && typeof body.target === "string") target = body.target as MlTrainTarget;
    if (body && typeof body.force === "boolean") force = body.force;
  } catch {
    // body rỗng — giữ "all" + force=true
  }
  if (target !== "all" && target !== "dl-mlp" && target !== "rl-q" && target !== "dl-gru" && target !== "dl-mtl") {
    return NextResponse.json(
      { error: `target "${target}" không hợp lệ (all | dl-mlp | rl-q | dl-gru | dl-mtl).` },
      { status: 400 }
    );
  }

  // B3 (#81) — GRU chỉ train khi CỔNG B2 PASS (AppSetting ml-gate). Cổng
  // chưa đo / FAIL → 400 trung thực kèm trạng thái cổng (không "thử cho
  // biết" ngoài cổng — nguyên tắc §1.8/B4).
  if (target === "dl-gru") {
    const gate = await gateVerdictOf();
    if (gate.verdict !== "PASS") {
      return NextResponse.json(
        {
          error:
            gate.verdict === "FAIL"
              ? "Cổng bằng chứng B2 KHÔNG mở (verdict FAIL) — GRU bị khoá theo ML_OPS_BLUEPRINT §4 B3/B4. Chạy lại scripts/ml-evidence-gate.ts khi có dữ liệu mới (mỗi quý hoặc khi bật chuỗi intraday)."
              : "Cổng bằng chứng B2 chưa đo — chạy scripts/ml-evidence-gate.ts trước khi train GRU (ML_OPS_BLUEPRINT §4 B3).",
          gateVerdict: gate.verdict,
          gateMeasuredAt: gate.measuredAt,
        },
        { status: 400 }
      );
    }
  }

  markTrainAttempt(now);
  const started = Date.now();

  try {
    // Luôn kết toán bandit trước train (nhanh, 0 LLM) — best-effort
    try {
      const settled = await settlePendingRewards();
      console.log(
        `[api/ml/train] bandit settle: ${settled.settled} assessment, ${settled.votes} phiếu`
      );
    } catch (settleErr) {
      console.error("[api/ml/train] settlePendingRewards lỗi (bỏ qua, vẫn train):", settleErr);
    }

    const trained: string[] = [];
    const errors: string[] = [];
    let dlMlp: TrainedDlMlpMetrics | null = null;
    let rlQ: TrainedRlQMetrics | null = null;
    let dlGru: TrainedGruMetrics | null = null;
    let dlMtl: Awaited<ReturnType<typeof trainDlMtl>> | null = null;
    let dlPromotion: DlMlpPromotion | null = null;
    let appliedTuning: AppliedMlpTuning | null = null;

    // A4 (#79) — skip-guard windowHash (force=false): build tập train TRƯỚC
    // khi train tốn kém, so hash với bản dl-mlp đang serving VÀ bản vừa train
    // gần nhất — bằng nhau (không có bar mới) → trả fast-path KHÔNG train.
    // Tập đã build được TÁI SỬ DỤNG cho trainDlMlp khi hash khác (F-611-01:
    // digest đúng chuỗi đã train). Cooldown + mutex đã chặn ở trên — hai đường
    // đi chung một cửa an toàn.
    // B1 (#81): hash giống nhau KHÔNG đủ — phải CÙNG featureSet với bộ hiện
    // hành (hash trên bar không đổi khi đổi đặc trưng: latest lag-10 + hash
    // trùng vẫn PHẢI train để có bản lag-16 cho cổng B2; latest lag-16 + hash
    // trùng → skip như cũ).
    let prebuilt: TrainingSetWithSeries | null = null;
    if (force === false) {
      // F-18 (#131): featureSet của tập build theo ml-tuning đang hiệu lực —
      // NAS đã đồng bộ champion v3-macro → đợt train Chủ nhật dựng arch 24
      // chiều đúng champion (hash skip-guard vẫn so trên cùng cửa sổ bar).
      const effective = await readEffectiveMlTuning();
      const set = await buildTrainingSet(20, {
        featureSet: effective.mlp.featureSet === "v3-macro" ? "v3-macro" : undefined,
      });
      const windowMeta = trainingWindowDigest(set.series, { samples: set.X.length });
      const { serving: servingHash, latest: latestHash, latestFeatureSet } =
        await recentWindowHashesOf("dl-mlp");
      const matched =
        servingHash != null && servingHash === windowMeta.windowHash
          ? "serving"
          : latestHash != null && latestHash === windowMeta.windowHash && latestFeatureSet === ML_FEATURE_SET
            ? "latest"
            : null;
      if (matched != null) {
        console.log(
          `[api/ml/train] A4 skip-guard: windowHash unchanged (khớp bản ${matched} — ${windowMeta.windowHash.slice(0, 12)}…) — không train`
        );
        // F-00 (#129): train bị skip-guard chặn VẪN để lại audit "skipped" —
        // im lặng là lỗi giám sát (đặc tả F-00 mục 1: phân biệt chạy-tay).
        try {
          await db.auditLog.create({
            data: {
              action: "ML_TRAIN_AUTO",
              entity: "MlModel",
              entityId: null,
              after: JSON.stringify({
                outcome: "skipped-no-new-window",
                matched,
                windowHash: windowMeta.windowHash,
                durationMs: Date.now() - started,
                note: "A4 Chủ nhật chạy đúng lịch — windowHash không đổi (không có bar mới)",
              }),
            },
          });
        } catch {
          // audit fail-soft
        }
        return NextResponse.json({
          ok: true,
          skipped: true,
          reason: "windowHash unchanged",
          windowHash: windowMeta.windowHash,
          durationMs: Date.now() - started,
        });
      }
      prebuilt = set;
    }

    if (target === "all" || target === "dl-mlp") {
      try {
        const { metrics, promotion, appliedTuning: at } = await trainDlMlp(prebuilt ?? undefined);
        dlMlp = metrics;
        dlPromotion = promotion;
        appliedTuning = at;
        trained.push("dl-mlp");
      } catch (err) {
        console.error("[api/ml/train] trainDlMlp failed:", err);
        errors.push(`MLP: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (target === "all" || target === "rl-q") {
      try {
        rlQ = await trainRlQ();
        trained.push("rl-q");
      } catch (err) {
        console.error("[api/ml/train] trainRlQ failed:", err);
        errors.push(`Q-learning: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (target === "dl-gru") {
      // B3 (#81) — verdict đã chặn ở trên (400 khi chưa PASS); đây là đường
      // train shadow duy nhất (thuần thuật toán, 0 LLM).
      try {
        dlGru = await trainDlGru();
        trained.push("dl-gru");
      } catch (err) {
        console.error("[api/ml/train] trainDlGru failed:", err);
        errors.push(`GRU: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (target === "dl-mtl") {
      // F-09 (#129) — multitask 3 đầu ra (shadow archived, lên serving qua sweep).
      try {
        dlMtl = await trainDlMtl();
        trained.push("dl-mtl");
      } catch (err) {
        console.error("[api/ml/train] trainDlMtl failed:", err);
        errors.push(`MTL: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const durationMs = Date.now() - started;

    // Toàn bộ fail → 500 thật (cho phép retry ngay)
    if (trained.length === 0) {
      clearTrainCooldown();
      return NextResponse.json(
        { ok: false, trained, durationMs, error: errors.join("; ") || "Huấn luyện thất bại." },
        { status: 500 }
      );
    }

    // F-00 (#129): đường ENGINE (force=false) audit ML_TRAIN_AUTO với outcome
    // trained — 2 Chủ nhật liên tiếp có audit là gate nghiệm thu F-00.
    if (force === false) {
      try {
        await db.auditLog.create({
          data: {
            action: "ML_TRAIN_AUTO",
            entity: "MlModel",
            entityId: null,
            after: JSON.stringify({
              outcome: trained.length > 0 ? "trained" : "failed",
              trained,
              errors,
              durationMs: Date.now() - started,
            }),
          },
        });
      } catch {
        // audit fail-soft
      }
    }
    const payload: Record<string, unknown> = { ok: true, trained, durationMs, dlMlp, rlQ, dlGru, dlMtl };
    // A4 (#79) — kết quả serving-swap guard (chỉ khi dl-mlp được train).
    // B1/F-B811-01 (#81): kèm promotionReason để FE nói đúng LÝ DO (valAcc
    // thua baseline ≠ cổng featureSet chưa mở).
    if (dlPromotion) {
      payload.promoted = dlPromotion.promoted;
      payload.servingValAcc = dlPromotion.servingValAcc;
      payload.newValAcc = dlPromotion.newValAcc;
      if (dlPromotion.reason != null) payload.promotionReason = dlPromotion.reason;
    }
    // #89 — cấu hình tinh chỉnh đã áp dụng cho bản MLP vừa train (truy vết).
    if (appliedTuning) payload.appliedTuning = appliedTuning;
    if (errors.length > 0) payload.error = errors.join("; "); // 1 cái fail không chặn cái kia
    return NextResponse.json(payload);
  } catch (err) {
    // Cho phép retry ngay khi lỗi ngoài dự kiến (không giữ cooldown vô ích)
    clearTrainCooldown();
    console.error("[api/ml/train] POST failed:", err);
    return NextResponse.json(
      { ok: false, error: "Huấn luyện thất bại (lỗi dữ liệu đầu vào). Vui lòng thử lại." },
      { status: 500 }
    );
  }
  } finally {
    // F-612R-06 — mutex nhả ở MỌI đường thoát (400 sớm · 500 · thành công)
    releaseTrainLock();
  }
}
