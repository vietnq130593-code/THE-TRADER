import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";
import { banditSnapshot, pendingSettleCount } from "@/lib/ml/bandit";
// L1 + Intraday (#83 — additive fields `rag` + `intraday`): thống kê truy hồi
// RAG (cổng L3) + số liệu bảng intraday 5-phút (cổng "Lớp chuỗi đầy đủ").
import { ragStats } from "@/lib/ml/rag";
import { intradayStats } from "@/lib/intraday";
import {
  featureAt,
  loadTopSeries,
  ML_WARMUP_BARS,
  rollingFeatures,
} from "@/lib/ml/features";
import {
  bucketProportions,
  featureName,
  psi,
  PSI_WARN,
  psiLevel,
  type PsiLevel,
} from "@/lib/ml/psi";

export const dynamic = "force-dynamic";

/**
 * GET /api/ml/status (phiên #35 — Task 35-ML) — trạng thái 3 mô hình học
 * thật: MLP dl-mlp + Q-learning rl-q (bảng MlModel, bản serving mới nhất)
 * + 5 arm Thompson sampling (BanditArm) + số phiếu chờ kết toán reward.
 * Chưa từng train → dlMlp/rlQ null (FE render empty-state). Deterministic,
 * 0 LLM, ~3-5 truy vấn nhẹ.
 *
 * A3 (phiên #79 — ML_OPS_BLUEPRINT §3): thêm field `drift` — PSI so phân phối
 * 10 đặc trưng 30 PHIÊN GẦN ĐÂY (pooled rổ top-20) với histogram lúc train
 * (MlModel.meta.featureHist do route train ghi). Bản serving chưa có
 * featureHist (v8 train trước A3) → `drift.available=false` TRUNG THỰC —
 * sẽ tự có sau lần train kế tiếp. Đo drift nằm SAU TTL cache module 15s
 * (cùng kỷ luật snapCache bandit #64 — UI poll 30s nên cache hấp thụ 1/2
 * request); KHÔNG thêm query khi chưa có histogram (chỉ JSON.parse meta).
 *
 * B1/B2/B3 (#81 — ML_OPS_BLUEPRINT §4): thêm 3 field additive:
 *  - `dlMlp.featureSet` — nhãn bộ đặc trưng bản serving (v1-lag10 / v2-lag16)
 *  - `gate` — verdict cổng bằng chứng B2 (đọc AppSetting "ml-gate" — 0 query
 *    thêm khi chưa đo); kèm ΔBrier CI + rank-IC để FE hiển thị trung thực
 *  - `gru` — trạng thái GRU giọng thứ ba (kind dl-gru, shadow AppSetting
 *    "ml-gru") — null khi chưa từng train (cổng chưa mở).
 */

type DlMlpMetricsRow = {
  epochs: number;
  samples: number;
  trainAcc: number;
  valAcc: number;
  trainLoss: number;
  valLoss: number;
  horizonDays?: number;
  features?: number;
  topSymbols?: string[];
};

type RlQMetricsRow = {
  episodes: number;
  epsilonEnd: number;
  avgRewardLast50: number;
  states: number;
  actions: number;
  stance?: string;
  exposure: number;
  qMax: number;
};

/** Parse metrics JSON của MlModel — null khi JSON hỏng/thiếu trường số. */
function parseMetrics<T extends Record<string, unknown>>(
  json: string,
  numberFields: string[]
): T | null {
  try {
    const m = JSON.parse(json) as Record<string, unknown>;
    for (const f of numberFields) {
      if (typeof m[f] !== "number" || !Number.isFinite(m[f] as number)) return null;
    }
    return m as T;
  } catch {
    return null;
  }
}

/* ─────────────────── A3 · PSI drift (ML_OPS_BLUEPRINT §3) ─────────────────── */

/** Hợp đồng cốt meta.featureHist — route train (79-A1A4) ghi, route này CHỈ ĐỌC:
 * edges[d] = điểm cắt tăng dần (9 cắt → 10 bucket) · train[d] = tỷ lệ bucket
 * lúc train (tổng ≈ 1). Số chiều theo edges.length — hôm nay 10, B1 có thể 16
 * (code theo length, không hardcode 10). */
interface FeatureHist {
  edges: number[][];
  train: number[][];
}

/** Một chiều đặc trưng trong payload drift. */
interface DriftDim {
  name: string;
  psi: number;
  level: PsiLevel;
}

/** Field `drift` trong payload — unavailable kèm reason trung thực. */
type DriftPayload =
  | { available: false; reason: string }
  | {
      available: true;
      /** Ngày phiên cuối của cửa sổ đo (YYYY-MM-DD). */
      asOf: string;
      /** Số mẫu pooled (mã × phiên) — kèm n theo nguyên tắc §1.4. */
      samples: number;
      dims: DriftDim[];
      maxPsi: number;
      maxDim: string;
      retrainRecommended: boolean;
    };

/** Reason chuẩn khi serving chưa có histogram (bản train trước A3). */
const DRIFT_NO_HISTOGRAM =
  "chưa có histogram — sẽ có sau lần train kế tiếp";

function driftUnavailable(reason: string): DriftPayload {
  return { available: false, reason };
}

/** Kiểm tra shape featureHist chặt (9 cắt tăng dần · train tổng ≈ 1 bucket)
 * — meta sai shape coi như chưa có, không đo PSI trên số rác. */
function parseFeatureHist(metaJson: string): FeatureHist | null {
  try {
    const m = JSON.parse(metaJson) as { featureHist?: unknown } | null;
    const fh = m?.featureHist;
    if (fh == null || typeof fh !== "object") return null;
    const { edges, train } = fh as { edges?: unknown; train?: unknown };
    if (!Array.isArray(edges) || !Array.isArray(train)) return null;
    if (edges.length === 0 || edges.length !== train.length) return null;
    const isNum = (v: unknown): v is number =>
      typeof v === "number" && Number.isFinite(v);
    for (let d = 0; d < edges.length; d++) {
      const e = edges[d];
      const t = train[d];
      if (!Array.isArray(e) || !Array.isArray(t)) return null;
      if (e.length === 0 || t.length !== e.length + 1) return null;
      if (!e.every(isNum) || !t.every(isNum)) return null;
      for (let i = 1; i < e.length; i++) {
        if (!(e[i] > e[i - 1])) return null; // điểm cắt phải tăng dần
      }
    }
    return { edges, train };
  } catch {
    return null;
  }
}

/* Perf — TTL cache 15s cùng kỷ luật snapCache bandit (#64): drift chỉ đổi khi
 * có bar EOD mới (15:45 ICT hằng ngày) hoặc train lại (đổi version) — cache
 * keyed theo version+trainedAt của bản serving, stale tối đa 15s; UI poll
 * 30s/lần nên cache hấp thụ 1/2 request. Drift nằm TRONG payload trả về,
 * không tính ngoài cache. */
let driftCache: { at: number; key: string; value: DriftPayload } | null = null;
const DRIFT_TTL_MS = 15_000;

/** Số phiên gần đây lấy mẫu (pooled (mã × phiên) — mỗi cặp = 1 mẫu). */
const DRIFT_SESSIONS = 30;
/** Rổ đo drift — cùng rổ train/serving (P0-2 · B5 HOSE-STOCK). */
const DRIFT_TOP_N = 20;
/** Cửa sổ nạp chuỗi: cần ≥ warmup 60 + 30 phiên đo ≈ 90 PHIÊN ≈ 131 ngày
 * lịch — spec ghi sinceDays 90 (ngày lịch ≈ 62 phiên, KHÔNG đủ warmup),
 * dùng 200 ngày lịch (≈138 phiên, đủ biên lễ/T6-CN). */
const DRIFT_LOOKBACK_DAYS = 200;
/** Nguyên tắc §1.4 — n < 30 hiển thị "chưa đủ mẫu", không đo PSI rác. */
const DRIFT_MIN_SAMPLES = 30;

/**
 * Đo PSI: nạp rổ top-20 (O(N) loadTopSeries + rollingFeatures — FeatureContract
 * P0-3, không đường tính thứ 2) → featureAt cho 30 phiên cuối của các ngày
 * chung rổ (distinct dates, lấy 30 cuối) → bin theo edges → so histogram
 * train. Fail-soft: lỗi DB/đo → available:false + reason, KHÔNG 500 route.
 */
async function computeDrift(hist: FeatureHist): Promise<DriftPayload> {
  const series = await loadTopSeries(DRIFT_TOP_N, {
    sinceDays: DRIFT_LOOKBACK_DAYS,
  });
  if (series.length === 0) {
    return driftUnavailable("rổ thanh khoản trống — chưa đo được drift");
  }

  // Distinct dates của rổ (union) → 30 phiên cuối làm mốc lấy mẫu pooled.
  const allDates = new Set<string>();
  for (const s of series) {
    for (const b of s.bars) allDates.add(b.date.toISOString().slice(0, 10));
  }
  const recent = [...allDates].sort().slice(-DRIFT_SESSIONS);
  if (recent.length === 0) {
    return driftUnavailable("không có bar EOD gần đây");
  }
  const recentSet = new Set(recent);

  // Pooled samples: mỗi cặp (mã, phiên trong 30 cuối) đủ warmup = 1 mẫu raw.
  const perDim: number[][] = [];
  let samples = 0;
  for (const s of series) {
    if (s.closes.length < ML_WARMUP_BARS) continue;
    const roll = rollingFeatures(s.closes, s.volumes);
    for (let t = ML_WARMUP_BARS - 1; t < s.closes.length; t++) {
      if (!recentSet.has(s.bars[t].date.toISOString().slice(0, 10))) continue;
      const x = featureAt(roll, t);
      if (x == null) continue;
      samples++;
      for (let d = 0; d < x.length; d++) {
        (perDim[d] ??= []).push(x[d]);
      }
    }
  }
  if (samples < DRIFT_MIN_SAMPLES) {
    return driftUnavailable(
      `chưa đủ mẫu đo drift (n=${samples} < ${DRIFT_MIN_SAMPLES})`
    );
  }

  // PSI từng chiều — số chiều theo edges.length (10 hôm nay · 16 sau B1).
  const dims: DriftDim[] = [];
  const nDims = Math.min(hist.edges.length, perDim.length);
  let maxPsi = 0;
  let maxDim = featureName(0);
  let retrainRecommended = false;
  for (let d = 0; d < nDims; d++) {
    const pNew = bucketProportions(perDim[d] ?? [], hist.edges[d]);
    const v = psi(pNew, hist.train[d] ?? []);
    dims.push({ name: featureName(d), psi: v, level: psiLevel(v) });
    if (v > maxPsi) {
      maxPsi = v;
      maxDim = featureName(d);
    }
    if (v >= PSI_WARN) retrainRecommended = true;
  }

  return {
    available: true,
    asOf: recent[recent.length - 1],
    samples,
    dims,
    maxPsi,
    maxDim,
    retrainRecommended,
  };
}

/**
 * Drift cho bản serving dl-mlp: chưa có featureHist → unavailable trung thực
 * (0 query thêm). Có → đo (TTL cache 15s keyed theo version+trainedAt —
 * train mới tự vô hiệu hoá cache). Lỗi đo nuốt thành reason (fail-soft §1.6).
 */
async function driftForServing(dlRow: {
  version: number;
  trainedAt: Date;
  meta: string | null;
} | null): Promise<DriftPayload> {
  if (!dlRow || !dlRow.meta) return driftUnavailable(DRIFT_NO_HISTOGRAM);
  const hist = parseFeatureHist(dlRow.meta);
  if (!hist) return driftUnavailable(DRIFT_NO_HISTOGRAM);

  const key = `${dlRow.version}:${dlRow.trainedAt.getTime()}`;
  const now = Date.now();
  if (
    driftCache &&
    driftCache.key === key &&
    now - driftCache.at < DRIFT_TTL_MS
  ) {
    return driftCache.value;
  }

  let value: DriftPayload;
  try {
    value = await computeDrift(hist);
  } catch (err) {
    console.error("[api/ml/status] drift measurement failed:", err);
    value = driftUnavailable(
      `lỗi khi đo drift — ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`
    );
  }
  driftCache = { at: now, key, value };
  return value;
}

/* ───────── B2/B3 · Cổng bằng chứng + GRU (đọc AppSetting, additive) ───────── */

/** Field `gate` — unavailable kèm reason trung thực (chưa chạy script đo). */
type GatePayload =
  | { available: false; reason: string }
  | {
      available: true;
      verdict: "PASS" | "FAIL";
      measuredAt: string;
      windowHash: string;
      /** CI 95% của ΔBrier = Brier(v2-lag16) − Brier(v8-lag10) trên val block
       *  cùng windowHash (paired bootstrap 1.000×). Âm = v2 thắng. */
      deltaBrier: { mean: number; ciLow: number; ciHigh: number };
      /** Số đặc trưng mới (6) đạt |rank-IC| ≥ 0,02 với CI loại trừ 0. */
      newFeaturesSignificant: number;
      /** Quy tắc mở: "deltabrier" (ΔBrier CI < 0) | "rankic" (≥3/6 đặc trưng
       *  mới có ý nghĩa) — null khi FAIL. */
      passedVia: "deltabrier" | "rankic" | null;
      /** Có hoán đổi serving v2-lag16 sau verdict không. */
      swappedServing: boolean;
    };

const GATE_NO_MEASUREMENT =
  "chưa đo — chạy scripts/ml-evidence-gate.ts sau khi bản v2-lag16 được huấn luyện";

/** Đọc AppSetting "ml-gate" (ghi bởi scripts/ml-evidence-gate.ts) — tolerant:
 *  thiếu key / JSON hỏng / sai shape → unavailable + reason, KHÔNG 500. */
async function gatePayload(): Promise<GatePayload> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: "ml-gate" } });
    if (!row) return { available: false, reason: GATE_NO_MEASUREMENT };
    const g = JSON.parse(row.value) as Record<string, unknown>;
    const verdict = g.verdict === "PASS" || g.verdict === "FAIL" ? g.verdict : null;
    if (verdict == null) return { available: false, reason: GATE_NO_MEASUREMENT };
    const db_ = g.deltaBrier as { mean?: unknown; ciLow?: unknown; ciHigh?: unknown } | undefined;
    const num = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) ? v : null;
    const mean = num(db_?.mean);
    const ciLow = num(db_?.ciLow);
    const ciHigh = num(db_?.ciHigh);
    if (mean == null || ciLow == null || ciHigh == null) {
      return { available: false, reason: "meta cổng thiếu số liệu ΔBrier — chạy lại script đo" };
    }
    const passedVia =
      g.passedVia === "deltabrier" || g.passedVia === "rankic" ? g.passedVia : null;
    return {
      available: true,
      verdict,
      measuredAt: typeof g.measuredAt === "string" ? g.measuredAt : "",
      windowHash: typeof g.windowHash === "string" ? g.windowHash : "",
      deltaBrier: { mean, ciLow, ciHigh },
      newFeaturesSignificant:
        typeof g.newFeaturesSignificant === "number" && Number.isFinite(g.newFeaturesSignificant)
          ? g.newFeaturesSignificant
          : 0,
      passedVia,
      swappedServing: g.swappedServing === true,
    };
  } catch {
    return { available: false, reason: GATE_NO_MEASUREMENT };
  }
}

/** Field `gru` — null khi chưa từng train dl-gru (cổng chưa mở, B4 trung thực). */
interface GruPayload {
  version: number;
  status: string;
  trainedAt: string;
  valAcc: number | null;
  params: number | null;
  window: number | null;
  /** AppSetting "ml-gru" — kill-switch tầng 1 (off mặc định) + shadow stats. */
  enabled: boolean;
  shadowSettled: number;
  gruBrier: number | null;
  mlpBrier: number | null;
  /** Brier GRU tệ hơn MLP N phiên liên tiếp — ≥5 tự hạ (kill-switch tầng 2). */
  consecutiveWorse: number;
}

async function gruPayload(): Promise<GruPayload | null> {
  try {
    const row = await db.mlModel.findFirst({
      where: { kind: "dl-gru" },
      orderBy: { version: "desc" },
    });
    if (!row) return null;
    let valAcc: number | null = null;
    let params: number | null = null;
    let window: number | null = null;
    try {
      const m = JSON.parse(row.metrics) as Record<string, unknown>;
      if (typeof m.valAcc === "number") valAcc = m.valAcc;
      if (typeof m.params === "number") params = m.params;
      if (typeof m.window === "number") window = m.window;
    } catch {
      // metrics hỏng → giữ null trung thực
    }
    let enabled = false;
    let shadowSettled = 0;
    let gruBrier: number | null = null;
    let mlpBrier: number | null = null;
    let consecutiveWorse = 0;
    try {
      const setting = await db.appSetting.findUnique({ where: { key: "ml-gru" } });
      if (setting) {
        const g = JSON.parse(setting.value) as Record<string, unknown>;
        enabled = g.enabled === true;
        const sh = g.shadow as Record<string, unknown> | undefined;
        if (sh && typeof sh.settled === "number") shadowSettled = sh.settled;
        if (sh && typeof sh.gruBrier === "number") gruBrier = sh.gruBrier;
        if (sh && typeof sh.mlpBrier === "number") mlpBrier = sh.mlpBrier;
        if (sh && typeof sh.consecutiveWorse === "number") consecutiveWorse = sh.consecutiveWorse;
      }
    } catch {
      // AppSetting hỏng → mặc định off trung thực
    }
    return {
      version: row.version,
      status: row.status,
      trainedAt: row.trainedAt.toISOString(),
      valAcc,
      params,
      window,
      enabled,
      shadowSettled,
      gruBrier,
      mlpBrier,
      consecutiveWorse,
    };
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    // A3: dl-mlp query khởi động TRƯỚC rồi drift nối tiếp (concurrent với 3
    // nhánh còn lại) — khi meta có featureHist, việc đo PSI chạy song song
    // chứ không nối đuôi chuỗi truy vấn; khi chưa có (bản v8) nhánh drift
    // rẻ trả ngay sau khi dl-mlp về → 0 query thêm.
    const dlRowPromise = db.mlModel.findFirst({
      where: { kind: "dl-mlp", status: "serving" },
      orderBy: { version: "desc" },
    });
    const driftPromise = dlRowPromise.then((dlRow) => driftForServing(dlRow));

    const [dlRow, rlRow, bandit, pendingSettles, drift, gate, gru, rag, intraday] = await Promise.all([
      dlRowPromise,
      db.mlModel.findFirst({
        where: { kind: "rl-q", status: "serving" },
        orderBy: { version: "desc" },
      }),
      banditSnapshot(),
      pendingSettleCount(),
      driftPromise,
      gatePayload(),
      gruPayload(),
      // #83 — fail-soft nội bộ (lỗi DB → số 0 trung thực, không chặn status)
      ragStats().catch(() => null),
      intradayStats().catch(() => null),
    ]);

    const dlMetrics = dlRow
      ? parseMetrics<DlMlpMetricsRow>(dlRow.metrics, [
          "epochs", "samples", "trainAcc", "valAcc", "trainLoss", "valLoss",
        ])
      : null;
    const rlMetrics = rlRow
      ? parseMetrics<RlQMetricsRow>(rlRow.metrics, [
          "episodes", "epsilonEnd", "avgRewardLast50", "states", "actions",
          "exposure", "qMax",
        ])
      : null;

    // B1 (#81) — featureSet bản serving từ meta (bản cũ không có → v1-lag10)
    const dlFeatureSet = (() => {
      if (!dlRow?.meta) return "v1-lag10";
      try {
        const m = JSON.parse(dlRow.meta) as { featureSet?: unknown };
        return typeof m.featureSet === "string" ? m.featureSet : "v1-lag10";
      } catch {
        return "v1-lag10";
      }
    })();

    const payload = {
      dlMlp:
        dlRow && dlMetrics
          ? {
              version: dlRow.version,
              status: dlRow.status,
              trainedAt: dlRow.trainedAt.toISOString(),
              featureSet: dlFeatureSet,
              metrics: {
                ...dlMetrics,
                horizonDays: dlMetrics.horizonDays ?? 5,
                features: dlMetrics.features ?? 10,
                topSymbols: Array.isArray(dlMetrics.topSymbols)
                  ? dlMetrics.topSymbols
                  : [],
              },
            }
          : null,
      rlQ:
        rlRow && rlMetrics
          ? {
              version: rlRow.version,
              status: rlRow.status,
              trainedAt: rlRow.trainedAt.toISOString(),
              metrics: {
                ...rlMetrics,
                stance: typeof rlMetrics.stance === "string" ? rlMetrics.stance : "giữ",
              },
            }
          : null,
      bandit: {
        arms: bandit.arms,
        lastSettleAt: bandit.lastSettleAt ? bandit.lastSettleAt.toISOString() : null,
      },
      pendingSettles,
      // A3 — additive field: FE cũ bỏ qua, FE mới (ml-panel badge Drift) đọc.
      drift,
      // B2/B3 (#81) — additive: cổng bằng chứng + GRU (FE mới đọc, FE cũ bỏ qua)
      gate,
      gru,
      // L1 (#83) — additive: RAG corpus + 30 ngày RetrievalLog (cổng L3 đo đây:
      // ≥30 ngày & tỉ lệ dùng ≥10% chu kỳ). FE mới đọc, FE cũ bỏ qua.
      rag: rag
        ? {
            corpusMessages: rag.corpusMessages,
            corpusNews: rag.corpusNews,
            retrievals30d: rag.retrievals30d,
            usedInPrompt30d: rag.usedInPrompt30d,
            usageRate30d: rag.usageRate30d,
            lastRetrievalAt: rag.lastRetrievalAt ? rag.lastRetrievalAt.toISOString() : null,
          }
        : null,
      // Intraday (#83) — additive: số liệu bảng bar 5-phút (tiến độ cổng "Lớp
      // chuỗi đầy đủ" — khi đủ dữ liệu sẽ re-đo cổng bằng chứng B2 cho GRU).
      intraday: intraday
        ? {
            bars: intraday.bars,
            symbols: intraday.symbols,
            tradingDays: intraday.tradingDays,
            lastDayBars: intraday.lastDayBars,
            lastBarAt: intraday.lastBarAt ? intraday.lastBarAt.toISOString() : null,
            simulated: intraday.simulated,
            realtime: intraday.realtime,
          }
        : null,
    };
    return NextResponse.json(toPlain(payload));
  } catch (err) {
    console.error("[api/ml/status] GET failed:", err);
    return NextResponse.json(
      { error: "Không đọc được trạng thái mô hình học máy." },
      { status: 500 }
    );
  }
}
