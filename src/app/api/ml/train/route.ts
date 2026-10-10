import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  buildTrainingSet,
  loadTopSeries,
  trainingWindowDigest,
  ML_FEATURE_COUNT,
  ML_HORIZON_DAYS,
  standardize,
  type TrainingSetWithSeries,
  type TrainingWindowMeta,
} from "@/lib/ml/features";
import { MLP } from "@/lib/ml/nn";
import { buildBasket, policyStance, trainQTable } from "@/lib/ml/rl";
import { settlePendingRewards } from "@/lib/ml/bandit";

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
 * cố định, KHÔNG đổi tên trường.
 *
 * A4 serving-swap guard: bản dl-mlp mới chỉ lên "serving" khi valAcc ≥ bản
 * serving hiện tại (nguyên tắc §1.5 — mô hình dưới ngưỡng không lên serving);
 * thua → lưu "archived", giữ bản cũ serving, response kèm promoted:false.
 * rl-q giữ hành vi cũ (luôn serving). Không có bản serving trước đó → promote.
 */
const COOLDOWN_MS = 60_000;
let lastTrainAt = 0;
/** F-612R-06 — 1 train chạy tại 1 thời điểm (pattern F-441-01). */
let inFlight = false;

/** Tỷ lệ TRAIN split theo thời gian — PHẢI khớp VAL_FRACTION=0.2 của nn.ts
 *  fit (cut 80/20, val = block cuối): featureHist A3 tính trên ĐÚNG phần
 *  80% đầu mà mô hình đã học (không lẫn val block). */
const TRAIN_FRACTION = 0.8;

/** Meta lưu MlModel.meta (JSON string) — TrainingWindowMeta P1-2 + featureHist
 *  A3 (#79). rl-q không có featureHist (chỉ dl-mlp). */
interface MlModelMeta extends TrainingWindowMeta {
  /** A3 (#79) — histogram đặc trưng RAW của TRAIN split: edges[d] = 9 điểm cắt
   *  quantile 10%..90% tăng dần · train[d] = 10 tỷ lệ bucket (tổng = 1). */
  featureHist?: { edges: number[][]; train: number[][] };
}

/** Quantile nội suy tuyến tính (type 7 — R default) trên mảng ĐÃ sort tăng dần. */
function quantileSorted(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const h = (n - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/** A3 (#79) — featureHist từ đặc trưng RAW của TRAIN split (80% đầu theo thời
 *  gian, cùng cut với nn.ts). Bucket j: (edges[j-1], edges[j]] — giá trị bằng
 *  điểm cắt rơi bucket dưới; bucket cuối (edges[8], +∞). Tỷ lệ tổng = 1 đúng. */
function computeFeatureHist(X: number[][]): { edges: number[][]; train: number[][] } {
  const nTrain = Math.floor(X.length * TRAIN_FRACTION);
  const edges: number[][] = [];
  const train: number[][] = [];
  for (let d = 0; d < ML_FEATURE_COUNT; d++) {
    const vals: number[] = [];
    for (let i = 0; i < nTrain; i++) vals.push(X[i][d]);
    vals.sort((a, b) => a - b);
    const cuts: number[] = [];
    for (let k = 1; k <= 9; k++) cuts.push(quantileSorted(vals, k / 10));
    edges.push(cuts);
    const counts = new Array<number>(10).fill(0);
    for (const v of vals) {
      let bucket = 9;
      for (let k = 0; k < 9; k++) {
        if (v <= cuts[k]) {
          bucket = k;
          break;
        }
      }
      counts[bucket]++;
    }
    train.push(counts.map((c) => (nTrain > 0 ? c / nTrain : 0)));
  }
  return { edges, train };
}

type MlTrainTarget = "all" | "dl-mlp" | "rl-q";

/** Metrics trả về FE — khớp DlMlpMetrics trong src/hooks/use-ml.ts. */
interface TrainedDlMlpMetrics {
  epochs: number;
  samples: number;
  trainAcc: number;
  valAcc: number;
  trainLoss: number;
  valLoss: number;
  horizonDays: number;
  features: number;
  topSymbols: string[];
}

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

/** Version kế tiếp của một kind (max mọi status + 1). */
async function nextVersion(kind: string): Promise<number> {
  const agg = await db.mlModel.aggregate({ _max: { version: true }, where: { kind } });
  return (agg._max.version ?? 0) + 1;
}

/** Lưu model mới: archive bản serving cũ + create version mới — MỘT
 *  $transaction (F-612R-06: archive xong create fail trước đây để kind
 *  KHÔNG còn bản serving nào — ensemble âm thầm xuống linreg).
 *  P1-2 (#60): meta = JSON TrainingWindowMeta (window-hash SHA-256 + biên
 *  ngày train) — null giữ cho model không có window (gọi trực tiếp).
 *  A4 (#79) opts.promote=false: bản mới lưu "archived", KHÔNG đụng bản
 *  serving hiện tại (serving-swap guard — where version:-1 không match gì).
 *  Mặc định promote=true = hành vi cũ (rl-q luôn đi đường này). */
async function saveModel(
  kind: string,
  weights: string,
  featureNorm: string | null,
  metrics: Record<string, unknown>,
  meta: MlModelMeta | null = null,
  opts: { promote?: boolean } = {}
): Promise<number> {
  const promote = opts.promote !== false;
  const version = await nextVersion(kind);
  // F-612R-06 — array-form $transaction: [updateMany(BatchPayload), create(MlModel)]
  // — lấy phần tử THỨ HAI (model mới), phần tử đầu là số dòng archive.
  const [, created] = await db.$transaction([
    db.mlModel.updateMany({
      where: promote ? { kind, status: "serving" } : { kind, status: "serving", version: -1 },
      data: { status: "archived" },
    }),
    db.mlModel.create({
      data: {
        kind,
        version,
        status: promote ? "serving" : "archived",
        weights,
        featureNorm,
        metrics: JSON.stringify(metrics),
        ...(meta ? { meta: JSON.stringify(meta) } : {}),
      },
    }),
  ]);
  return created.version;
}

/** Kết quả guard hoán đổi serving (A4 #79) — trả ra response. */
interface DlMlpPromotion {
  promoted: boolean;
  /** valAcc bản serving TRƯỚC khi train (null = chưa có bản serving nào). */
  servingValAcc: number | null;
  newValAcc: number;
}

/** Đọc valAcc bản serving hiện tại của một kind (metrics JSON từ DB).
 *  null khi chưa có bản serving hoặc metrics không đọc được valAcc. */
async function servingValAccOf(kind: string): Promise<number | null> {
  const serving = await db.mlModel.findFirst({
    where: { kind, status: "serving" },
    orderBy: { version: "desc" },
    select: { metrics: true },
  });
  if (!serving?.metrics) return null;
  try {
    const m = JSON.parse(serving.metrics) as { valAcc?: unknown };
    return typeof m.valAcc === "number" && Number.isFinite(m.valAcc) ? m.valAcc : null;
  } catch {
    return null;
  }
}

/** Đọc windowHash bản serving + bản MỚI NHẤT (max version, mọi status) của
 *  một kind (meta JSON từ DB). A4 (#79) skip-guard khớp CẢ HAI: (1) bản
 *  serving — spec A4.2 "không có bar mới so bản đang phục vụ"; (2) bản vừa
 *  train gần nhất — nghiệm thu #79: lần gọi thứ hai phải skip KỂ CẢ khi bản
 *  vừa train không được promote (retrain cùng cửa sổ là deterministic — cùng
 *  seed ra cùng kết quả, chỉ phí CPU + dồn version trùng windowHash).
 *  null khi chưa có bản / meta hỏng / thiếu hash (model train trước P1-2). */
async function recentWindowHashesOf(
  kind: string
): Promise<{ serving: string | null; latest: string | null }> {
  const read = (meta: string | null): string | null => {
    if (!meta) return null;
    try {
      const m = JSON.parse(meta) as { windowHash?: unknown };
      return typeof m.windowHash === "string" ? m.windowHash : null;
    } catch {
      return null;
    }
  };
  const [serving, latest] = await Promise.all([
    db.mlModel.findFirst({
      where: { kind, status: "serving" },
      orderBy: { version: "desc" },
      select: { meta: true },
    }),
    db.mlModel.findFirst({
      where: { kind },
      orderBy: { version: "desc" },
      select: { meta: true },
    }),
  ]);
  return { serving: read(serving?.meta ?? null), latest: read(latest?.meta ?? null) };
}

/**
 * Train MLP 10→16→8→3 trên top-20 thanh khoản: buildTrainingSet → cap 60k
 * mẫu gần nhất → z-score → fit (Adam, early-stop) → topSymbols theo độ tách
 * pUp−pDown của mô hình trên từng mã → lưu MlModel kind dl-mlp.
 * A3 (#79): meta thêm featureHist (đặc trưng RAW TRAIN split — hợp đồng với
 * PSI). A4 (#79): serving-swap guard valAcc. `prebuilt` = tập đã build từ
 * skip-guard (F-611-01: digest hash CHÍNH chuỗi đã train — không nạp lại).
 */
async function trainDlMlp(
  prebuilt?: TrainingSetWithSeries
): Promise<{ metrics: TrainedDlMlpMetrics; promotion: DlMlpPromotion }> {
  const set = prebuilt ?? (await buildTrainingSet(20));
  if (set.X.length < 600) {
    throw new Error(`chỉ có ${set.X.length} mẫu huấn luyện (cần ≥ 600) — kiểm tra dữ liệu EOD`);
  }
  // P1-2 — digest cửa sổ train TRÊN CHÍNH chuỗi dữ liệu vừa dùng (tái lập PIT).
  // F-611-01/#61: buildTrainingSet giờ TRẢ KÈM series nó đã nạp — digest hash
  // trên chuỗi ĐÓ (trước đây loadTopSeries LẦN THỨ HAI độc lập: bar đổi giữa 2
  // lượt nạp (eod-sync/corporate adjust chạy nền) → window-hash mô tả sai cửa
  // sổ đã train — phá đúng cái PIT P1-2 xây ra; đồng thời đỡ 1 lượt nạp DB đầy).
  const windowMeta = trainingWindowDigest(set.series, { samples: set.X.length });
  // A3 (#79) — histogram đặc trưng RAW của TRAIN split (đồng bộ meta PSI)
  const featureHist = computeFeatureHist(set.X);
  const { mean, std, Xstd } = standardize(set.X);
  const mlp = new MLP();
  const fit = mlp.fit(Xstd, set.y);
  mlp.setNorm({ mean, std });

  // topSymbols: mã nào dự báo tách bạch nhất (mean |pUp − pDown| trên mẫu của mã)
  const preds = mlp.predictBatch(set.X);
  const bySymbol = new Map<string, { sum: number; n: number }>();
  set.symbols.forEach((sym, i) => {
    const agg = bySymbol.get(sym) ?? { sum: 0, n: 0 };
    agg.sum += Math.abs(preds[i][0] - preds[i][2]);
    agg.n++;
    bySymbol.set(sym, agg);
  });
  const topSymbols = [...bySymbol.entries()]
    .map(([symbol, a]) => ({ symbol, sep: a.sum / a.n }))
    .sort((a, b) => b.sep - a.sep)
    .slice(0, 8)
    .map((r) => r.symbol);

  const metrics: TrainedDlMlpMetrics = {
    epochs: fit.epochs,
    samples: fit.samples,
    trainAcc: fit.trainAcc,
    valAcc: fit.valAcc,
    trainLoss: fit.trainLoss,
    valLoss: fit.valLoss,
    horizonDays: ML_HORIZON_DAYS,
    features: ML_FEATURE_COUNT,
    topSymbols,
  };
  // A4 (#79) serving-swap guard: đọc valAcc bản serving HIỆN TẠI (trước khi
  // saveModel thay đổi status) — mới ≥ cũ (hoặc chưa có bản nào) → promote
  // như cũ; mới < cũ → lưu "archived", bản cũ giữ serving (§1.5: mô hình dưới
  // ngưỡng không lên serving).
  const servingValAcc = await servingValAccOf("dl-mlp");
  const promoted = servingValAcc == null || fit.valAcc >= servingValAcc;
  await saveModel(
    "dl-mlp",
    mlp.toJSON(),
    JSON.stringify({ mean, std }),
    { ...metrics },
    { ...windowMeta, featureHist },
    { promote: promoted }
  );
  return {
    metrics,
    promotion: { promoted, servingValAcc, newValAcc: fit.valAcc },
  };
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
  const q = trainQTable(closes);
  const basket = buildBasket(closes);
  const stance = policyStance(q.qTable, basket, 0.5);
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

export async function POST(req: Request) {
  // F-612R-06/#61 (Vòng 2) — cooldown check TRƯỚC mutex (429/400 sớm không cắm cờ)
  const now = Date.now();
  const sinceLast = now - lastTrainAt;
  if (sinceLast < COOLDOWN_MS) {
    const retryAfterSeconds = Math.ceil((COOLDOWN_MS - sinceLast) / 1000);
    return NextResponse.json(
      {
        error: `Huấn luyện vừa chạy cách đây ${Math.floor(sinceLast / 1000)}s. Vui lòng đợi ${retryAfterSeconds}s rồi thử lại.`,
        retryAfterSeconds,
      },
      { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } }
    );
  }
  if (inFlight) {
    return NextResponse.json(
      { error: "Huấn luyện đang chạy (mutex F-612R-06) — vui lòng đợi hoàn tất." },
      { status: 429, headers: { "Retry-After": "30" } }
    );
  }
  inFlight = true;
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
  if (target !== "all" && target !== "dl-mlp" && target !== "rl-q") {
    return NextResponse.json(
      { error: `target "${target}" không hợp lệ (all | dl-mlp | rl-q).` },
      { status: 400 }
    );
  }

  lastTrainAt = now;
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
    let dlPromotion: DlMlpPromotion | null = null;

    // A4 (#79) — skip-guard windowHash (force=false): build tập train TRƯỚC
    // khi train tốn kém, so hash với bản dl-mlp đang serving VÀ bản vừa train
    // gần nhất — bằng nhau (không có bar mới) → trả fast-path KHÔNG train.
    // Tập đã build được TÁI SỬ DỤNG cho trainDlMlp khi hash khác (F-611-01:
    // digest đúng chuỗi đã train). Cooldown + mutex đã chặn ở trên — hai đường
    // đi chung một cửa an toàn.
    let prebuilt: TrainingSetWithSeries | null = null;
    if (force === false) {
      const set = await buildTrainingSet(20);
      const windowMeta = trainingWindowDigest(set.series, { samples: set.X.length });
      const { serving: servingHash, latest: latestHash } = await recentWindowHashesOf("dl-mlp");
      const matched =
        servingHash != null && servingHash === windowMeta.windowHash
          ? "serving"
          : latestHash != null && latestHash === windowMeta.windowHash
            ? "latest"
            : null;
      if (matched != null) {
        console.log(
          `[api/ml/train] A4 skip-guard: windowHash unchanged (khớp bản ${matched} — ${windowMeta.windowHash.slice(0, 12)}…) — không train`
        );
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
        const { metrics, promotion } = await trainDlMlp(prebuilt ?? undefined);
        dlMlp = metrics;
        dlPromotion = promotion;
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

    const durationMs = Date.now() - started;

    // Toàn bộ fail → 500 thật (cho phép retry ngay)
    if (trained.length === 0) {
      lastTrainAt = 0;
      return NextResponse.json(
        { ok: false, trained, durationMs, error: errors.join("; ") || "Huấn luyện thất bại." },
        { status: 500 }
      );
    }

    const payload: Record<string, unknown> = { ok: true, trained, durationMs, dlMlp, rlQ };
    // A4 (#79) — kết quả serving-swap guard (chỉ khi dl-mlp được train)
    if (dlPromotion) {
      payload.promoted = dlPromotion.promoted;
      payload.servingValAcc = dlPromotion.servingValAcc;
      payload.newValAcc = dlPromotion.newValAcc;
    }
    if (errors.length > 0) payload.error = errors.join("; "); // 1 cái fail không chặn cái kia
    return NextResponse.json(payload);
  } catch (err) {
    // Cho phép retry ngay khi lỗi ngoài dự kiến (không giữ cooldown vô ích)
    lastTrainAt = 0;
    console.error("[api/ml/train] POST failed:", err);
    return NextResponse.json(
      { ok: false, error: "Huấn luyện thất bại (lỗi dữ liệu đầu vào). Vui lòng thử lại." },
      { status: 500 }
    );
  }
  } finally {
    // F-612R-06 — mutex nhả ở MỌI đường thoát (400 sớm · 500 · thành công)
    inFlight = false;
  }
}
