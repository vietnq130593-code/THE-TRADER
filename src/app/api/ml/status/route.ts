import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";
import { banditSnapshot, pendingSettleCount } from "@/lib/ml/bandit";
// L1 + Intraday (#83 — additive fields `rag` + `intraday`): thống kê truy hồi
// RAG (cổng L3) + số liệu bảng intraday 5-phút (cổng "Lớp chuỗi đầy đủ").
import { ragStats } from "@/lib/ml/rag";
// Task 142 (F-24 §6) — thống kê lớp L2 tri thức dài hạn (fail-soft như rag)
import { l2Stats } from "@/lib/ml/l2";
import { intradayStats } from "@/lib/intraday";
// C2-pipeline (#99 — ML_AUTOML_BLUEPRINT §5.1/Q4): tiến độ cổng dữ liệu
// "tin tức → đặc trưng v3-news22" — đo từ NewsItem (PIT-strict), TTL cache 60s.
import { newsCoverageReport } from "@/lib/ml/news-coverage";
// W3 (#164) — logic đo PSI trích sang lib drift.ts: route status và route
// psi-retrain (auto-retrain có guard) dùng CHUNG một phép đo + TTL cache 15s
// (pure refactor — hành vi GET này giữ nguyên như #79/#137-B9).
import { driftForServing } from "@/lib/ml/drift";
// W3 (#164) — trạng thái cơ chế auto-retrain theo PSI (kill-switch + audit
// gần nhất) hiển thị cùng drift cho FE.
import {
  PSI_RETRAIN_AUDIT_ACTION,
  PSI_RETRAIN_COOLDOWN_HOURS,
  PSI_RETRAIN_SETTING_KEY,
} from "@/lib/ml/psi-retrain";
import { PSI_WARN } from "@/lib/ml/psi";
// F-18B (#132): đọc arch-string thật của bản serving từ weights JSON — dùng
// chung parser chuẩn với /api/ml/architecture (nn.ts) thay vì đoán.
import { mlpArchString, parseMlpArch } from "@/lib/ml/nn";

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

/* ───────── W5 (#163 · review #162) — HOLDOUT CỦA BẢN SERVING ───────────── */

/** Metrics ngoài mẫu của bản serving khi nó được thăng cấp qua sweep —AuditLog
 *  ML_SWEEP_SWAP.after JSON ghi {promotedVersion, holdout: {size, dateFrom,
 *  dateTo, championAcc, championBrier}}. Bản lên serving qua train tay
 *  (serving-swap guard) không có số này → null + metricsNote giải thích. */
interface HoldoutPayload {
  /** Số mẫu holdout walk-forward (cùng cut thời gian — audit 137 B4). */
  size: number;
  dateFrom: string | null;
  dateTo: string | null;
  /** valAcc đo trên holdout — SỐ TRUNG THỰC ngoài mẫu (khác metrics.valAcc
 *  post-selection phía trên). */
  valAcc: number;
  /** Brier trên holdout (càng nhỏ càng tốt). */
  brier: number | null;
  /** Id đợt sweep thăng cấp bản này (truy vết SweepRun). */
  sweepRunId: string | null;
}

/** Note chuẩn W5 — giải thích bản chất số metrics.valAcc đang hiển thị. */
const METRICS_NOTE_SELECTION =
  "valAcc/valLoss là số SELECTION (early-stop + chọn kiến trúc trên cùng val block — thiên lệch LÊN so với khả năng ngoài mẫu). Số ngoài mẫu trung thực nằm ở holdout khi bản serving được thăng cấp qua cổng sweep.";

/** Tìm holdout cho version serving: quét 20 AuditLog ML_SWEEP_SWAP gần nhất,
 *  parse after JSON, khớp promotedVersion. Fail-soft tuyệt đối: lỗi parse/DB
 *  → null (hiển thị note selection, không bịa số holdout). */
async function holdoutForServing(version: number | null): Promise<HoldoutPayload | null> {
  if (version == null) return null;
  try {
    const rows = await db.auditLog.findMany({
      where: { action: "ML_SWEEP_SWAP" },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { after: true },
    });
    for (const row of rows) {
      if (!row.after) continue;
      try {
        const a = JSON.parse(row.after) as Record<string, unknown>;
        if (a.promotedVersion !== version) continue;
        const h = a.holdout as Record<string, unknown> | undefined;
        if (
          !h ||
          typeof h.size !== "number" ||
          !Number.isFinite(h.size) ||
          typeof h.championAcc !== "number" ||
          !Number.isFinite(h.championAcc)
        ) {
          continue; // sweep cũ không lưu holdout → tiếp tục tìm (không phóng đo)
        }
        const brier =
          typeof h.championBrier === "number" && Number.isFinite(h.championBrier)
            ? h.championBrier
            : null;
        return {
          size: h.size,
          dateFrom: typeof h.dateFrom === "string" ? h.dateFrom : null,
          dateTo: typeof h.dateTo === "string" ? h.dateTo : null,
          valAcc: h.championAcc,
          brier,
          sweepRunId: typeof a.sweepRunId === "string" ? a.sweepRunId : null,
        };
      } catch {
        continue; // JSON hỏng của 1 dòng → thử dòng kế
      }
    }
    return null;
  } catch {
    return null;
  }
}

/* ───────── W3 (#164) — trạng thái auto-retrain theo PSI (additive) ───────── */

/** Field `autoRetrain` — cơ chế W3: PSI ≥ 0,25 → engine :3003 đôn đốc
 *  POST /api/ml/psi-retrain (5 guard — xem lib psi-retrain.ts). FE hiển thị
 *  trạng thái bật/tắt + lần trigger gần nhất ngay dưới khối drift. */
interface AutoRetrainPayload {
  enabled: boolean;
  psiWarn: number;
  cooldownHours: number;
  lastAt: string | null;
  lastOutcome: string | null;
  /** Lịch engine (doc/hiển thị — không phải cấu hình chạy được). */
  schedule: string;
}

const AUTO_RETRAIN_SCHEDULE =
  "engine :3003 — T2–T6 từ 17:00 ICT sau EOD-sync, nhịp check 15 phút";

/** Đọc AppSetting ml-psi-retrain + AuditLog ML_PSI_RETRAIN gần nhất (2 query
 *  nhẹ, fail-soft null — FE ẩn khối, KHÔNG bịa trạng thái). */
async function autoRetrainPayload(): Promise<AutoRetrainPayload | null> {
  try {
    const [settingRow, auditRow] = await Promise.all([
      db.appSetting.findUnique({ where: { key: PSI_RETRAIN_SETTING_KEY } }),
      db.auditLog.findFirst({
        where: { action: PSI_RETRAIN_AUDIT_ACTION },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true, after: true },
      }),
    ]);
    let enabled = true; // thiếu key → BẬT (lý do tồn tại của W3)
    if (settingRow) {
      try {
        const s = JSON.parse(settingRow.value) as { enabled?: unknown };
        enabled = s.enabled !== false;
      } catch {
        // JSON hỏng → giữ BẬT (không bịa TẮT)
      }
    }
    let lastOutcome: string | null = null;
    if (auditRow?.after) {
      try {
        const a = JSON.parse(auditRow.after) as { outcome?: unknown };
        if (typeof a.outcome === "string") lastOutcome = a.outcome;
      } catch {
        // after hỏng → null trung thực
      }
    }
    return {
      enabled,
      psiWarn: PSI_WARN,
      cooldownHours: PSI_RETRAIN_COOLDOWN_HOURS,
      lastAt: auditRow ? auditRow.createdAt.toISOString() : null,
      lastOutcome,
      schedule: AUTO_RETRAIN_SCHEDULE,
    };
  } catch {
    return null;
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
    // W5 (#163) — holdout của bản serving (fail-soft; null khi lên serving
    // qua train tay — metricsNote luôn giải thích).
    const holdoutPromise = dlRowPromise
      .then((dlRow) => holdoutForServing(dlRow?.version ?? null))
      .catch(() => null);

    const [dlRow, rlRow, bandit, pendingSettles, drift, holdout, gate, gru, rag, intraday, newsGate, l2, autoRetrain] = await Promise.all([
      dlRowPromise,
      db.mlModel.findFirst({
        where: { kind: "rl-q", status: "serving" },
        orderBy: { version: "desc" },
      }),
      banditSnapshot(),
      pendingSettleCount(),
      driftPromise,
      holdoutPromise,
      gatePayload(),
      gruPayload(),
      // #83 — fail-soft nội bộ (lỗi DB → số 0 trung thực, không chặn status)
      ragStats().catch(() => null),
      intradayStats().catch(() => null),
      // C2-pipeline (#99) — fail-soft như rag/intraday (available:false + reason)
      newsCoverageReport(),
      // Task 142 — fail-soft như rag (FE cũ bỏ qua field l2)
      l2Stats().catch(() => null),
      // W3 (#164) — trạng thái auto-retrain theo PSI (fail-soft null)
      autoRetrainPayload(),
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

    // F-18B (#132) — archString bản serving ("10-16-8-3") từ weights JSON,
    // fail-soft: weights/arch không parse được → undefined (FE ẩn badge,
    // KHÔNG phóng đo). Câu hỏi chủ sở hữu: "ML dự báo 5 phiên có số nơ-rôn
    // khác hẳn kiến trúc ANN trình chỉnh sửa" — giờ Tổng quan + Bench serving
    // đều hiện arch thật để đối chiếu cùng một nguồn sự thật.
    const dlArchString = (() => {
      if (!dlRow?.weights) return undefined;
      try {
        const w = JSON.parse(dlRow.weights) as { arch?: unknown };
        if (typeof w.arch !== "string") {
          // Bản cực cũ không ghi arch-string (trước #94) → undefined trung thực
          // (FE ẩn badge) — không phóng đo 10-16-8-3 như architecture route.
          return undefined;
        }
        return mlpArchString(parseMlpArch(w.arch));
      } catch {
        return undefined;
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
              // F-18B (#132) — additive: FE cũ bỏ qua, FE mới hiện badge arch.
              archString: dlArchString,
              metrics: {
                ...dlMetrics,
                horizonDays: dlMetrics.horizonDays ?? 5,
                features: dlMetrics.features ?? 10,
                topSymbols: Array.isArray(dlMetrics.topSymbols)
                  ? dlMetrics.topSymbols
                  : [],
              },
              // W5 (#163) — additive: FE cũ bỏ qua; FE mới hiện số ngoài mẫu
              // holdout khi có + luôn hiện note giải thích thiên lệch selection.
              metricsNote: METRICS_NOTE_SELECTION,
              holdout,
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
      // W3 (#164) — additive: trạng thái auto-retrain theo PSI (FE mới đọc,
      // FE cũ bỏ qua — hiển thị cùng khối drift).
      autoRetrain,
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
      // Task 142 (F-24 §6) — L2 tri thức dài hạn: additive, FE cũ bỏ qua.
      l2: l2
        ? {
            chunks: l2.chunks,
            byRefTable: l2.byRefTable,
            vectorCoverage: l2.vectorCoverage,
            entities: l2.entities,
            edges: l2.edges,
            retrievals30d: l2.retrievals30d,
            usedInPrompt30d: l2.usedInPrompt30d,
            usageRate30d: l2.usageRate30d,
            lastRetrievalAt: l2.lastRetrievalAt,
            pending: l2.pending,
            embedModel: l2.embedModel,
            dim: l2.dim,
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
      // C2-pipeline (#99 — ML_AUTOML_BLUEPRINT §5.1) — additive: tiến độ cổng
      // dữ liệu tin tức → đặc trưng (phiên có tin PIT /60 + coverage lexicon).
      // FE mới đọc (tab Dữ liệu), FE cũ bỏ qua — tự chín theo crawler 15 phút.
      newsGate,
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
