import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { mlpArchString, normalizeActivations, parseMlpArch, type MlpActivation } from "@/lib/ml/nn";
import { readEffectiveMlTuning } from "@/lib/ml/tuning";
import { GRU_ARCH } from "@/lib/ml/gru";
import { ENSEMBLE_WEIGHTS, ML_ENSEMBLE_DEADBAND } from "@/lib/ml/ensemble";
// F-07/F-08 (#129): nguồn trọng số học từ D-LEDGER + trạng thái calibration.
import { readEnsembleWeights } from "@/lib/ml/ensemble-learn";
import { FEATURE_NAMES } from "@/lib/ml/psi";
import { ML_FEATURE_COUNT, ML_FEATURE_SET, ML_HORIZON_DAYS } from "@/lib/ml/features";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/ml/architecture (phiên #89 — tab "Mạng thần kinh" + "Dữ liệu &
 * kiến trúc" của module Học máy). MỘT endpoint bốn phần:
 *
 *   db       — parse prisma/schema.prisma lúc runtime (model + trường + quan
 *              hệ + index) + đếm dòng CHÍNH XÁC mỗi bảng (một truy vấn UNION
 *              ALL; fallback pg_stat_user_tables ≈; cùng fallback null) —
 *              UI hiển thị kiến trúc database THẬT đang chạy, không copy tay.
 *   mlp      — arch + trọng số THẬT của bản dl-mlp serving (parse weights
 *              JSON theo format MỚI blocks #94 lẫn CŨ W1..b3 → layers[]
 *              động đúng số lớp + activation từng lớp + paramCount tính
 *              từ blocks thật).
 *   gru      — arch tĩnh GRU-24 (GRU_ARCH) + bản dl-gru mới nhất (shadow).
 *   ensemble — trọng số 2/3 giọng + deadband (ENSEMBLE_WEIGHTS — một nguồn).
 *   pipeline — 8 chặng dòng chảy dữ liệu (nguồn → lưu trữ → đặc trưng → mô
 *              hình → ensemble → bandit → tổng hợp → quyết định) kèm số
 *              dòng sống lấy từ phần db.
 *   draft    — #94: arch + activations + lossWeights + hyper HIỆU LỰC từ
 *              readEffectiveMlTuning (AppSetting ml-tuning) — cấu hình ĐANG
 *              CHỈNH cho trình chỉnh sửa kiến trúc (không phải serving).
 *              Draft KHÔNG nằm trong cache 60s — luôn tươi sau mỗi lần lưu.
 *
 * Cache in-memory 60s (parse schema + đếm dòng không cần mỗi request).
 * Fail-soft từng phần: db lỗi → models rỗng + approximate:false; MLP không
 * có bản serving HOẶC weights/arch rác (F-MLP-03 · fixbug FB-4B) → mlp:null
 * (UI empty-state trung thực).
 */

/* ─────────────────── Nhóm model (phân loại hiển thị) ─────────────────── */

const MODEL_GROUPS: { id: string; label: string; models: string[] }[] = [
  {
    id: "market",
    label: "Dữ liệu thị trường",
    models: [
      "Instrument", "Quote", "Bar", "IntradayBar", "ForeignFlow",
      "CorporateEvent", "FinancialFundamental", "NewsItem", "DataSourceStatus",
    ],
  },
  {
    id: "agents",
    label: "Agent & chu kỳ",
    models: ["Agent", "AgentRun", "AgentTask", "AgentMessage", "Watchlist", "WatchlistItem"],
  },
  {
    id: "trading",
    label: "Giao dịch",
    models: ["Signal", "Order", "Position", "Trade", "BrokerAccount", "CashSnapshot", "RiskAlert"],
  },
  {
    id: "ml",
    label: "Học máy & tổng hợp",
    models: [
      "MlModel", "BanditArm", "BanditEvent", "RetrievalLog",
      "MarketAssessment", "RiskQuantSnapshot", "FeatureValue",
    ],
  },
  {
    id: "ops",
    label: "Hệ thống",
    models: ["User", "AppSetting", "AuditLog", "DataQualityReport", "NotificationOutbox"],
  },
];

function groupOfModel(name: string): string {
  for (const g of MODEL_GROUPS) if (g.models.includes(name)) return g.id;
  return "ops"; // model mới chưa phân nhóm → "Hệ thống"
}

/* ─────────────────── Parse prisma/schema.prisma ─────────────────── */

interface ParsedField {
  name: string;
  type: string;
  attrs: string;
  relation: boolean;
}
interface ParsedModel {
  name: string;
  fields: ParsedField[];
  relations: string[];
  indexes: string[];
}

function parsePrismaSchema(raw: string): { models: ParsedModel[]; enumCount: number } {
  const models: ParsedModel[] = [];
  const modelRegex = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let m: RegExpExecArray | null;
  const names = new Set<string>();
  const rawModels: { name: string; body: string }[] = [];
  while ((m = modelRegex.exec(raw)) !== null) {
    rawModels.push({ name: m[1], body: m[2] });
    names.add(m[1]);
  }
  for (const rm of rawModels) {
    const fields: ParsedField[] = [];
    const relations = new Set<string>();
    const indexes: string[] = [];
    for (const line of rm.body.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("//")) continue;
      if (trimmed.startsWith("@@")) {
        indexes.push(trimmed);
        continue;
      }
      const fm = /^(\w+)\s+([\w\[\]?]+)(.*)$/.exec(trimmed);
      if (!fm) continue;
      const [, fname, ftype, rest] = fm;
      const baseType = ftype.replace(/[\[\]?]/g, "");
      const isRelation = names.has(baseType);
      fields.push({ name: fname, type: ftype, attrs: rest.trim(), relation: isRelation });
      if (isRelation) relations.add(baseType);
    }
    models.push({ name: rm.name, fields, relations: [...relations], indexes });
  }
  const enumCount = (raw.match(/^enum\s+\w+\s*\{/gm) ?? []).length;
  return { models, enumCount };
}

/* ─────────────────── Đếm dòng (chính xác → ≈ → null) ─────────────────── */

type RowCounts = Map<string, number>;

async function countRowsExact(modelNames: string[]): Promise<RowCounts | null> {
  if (modelNames.length === 0) return new Map();
  try {
    const selects = modelNames
      .map((n) => `SELECT '${n.replace(/'/g, "''")}' AS name, COUNT(*)::int AS count FROM "${n.replace(/"/g, '""')}"`)
      .join(" UNION ALL ");
    const rows = (await db.$queryRawUnsafe(selects)) as { name: string; count: number }[];
    return new Map(rows.map((r) => [r.name, Number(r.count)]));
  } catch (err) {
    console.error("[api/ml/architecture] countRowsExact lỗi, fallback pg_stat:", err);
    return null;
  }
}

async function countRowsApprox(): Promise<RowCounts | null> {
  try {
    const rows = (await db.$queryRawUnsafe(
      "SELECT relname AS name, n_live_tup::int AS count FROM pg_stat_user_tables"
    )) as { name: string; count: number }[];
    return new Map(rows.map((r) => [r.name, Number(r.count)]));
  } catch {
    return null;
  }
}

/* ─────────────────── Trọng số MLP serving (cho sơ đồ mạng) ─────────────────── */

/** Một khối trọng số W + b (format MỚI #94 — số khối = hidden + khối ra). */
interface MlpWeightBlock {
  W: number[];
  b: number[];
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

async function buildMlpInfo(): Promise<{
  version: number | null;
  trainedAt: string | null;
  featureSet: string;
  archString: string;
  arch: { in: number; hidden: number[]; out: number };
  activations: MlpActivation[];
  paramCount: number;
  layers: { name: string; units: number; activation: string; params: number; note: string }[];
  featureNames: string[];
  outputLabels: string[];
  weights: { blocks: MlpWeightBlock[] } | null;
} | null> {
  let row: { version: number; trainedAt: Date; weights: string; meta: string | null } | null = null;
  try {
    row = await db.mlModel.findFirst({
      where: { kind: "dl-mlp", status: "serving" },
      orderBy: { version: "desc" },
      select: { version: true, trainedAt: true, weights: true, meta: true },
    });
  } catch {
    return null;
  }
  if (!row) return null;

  let featureSet = "v1-lag10";
  try {
    const meta = row.meta ? (JSON.parse(row.meta) as { featureSet?: unknown }) : null;
    if (meta && typeof meta.featureSet === "string") featureSet = meta.featureSet;
  } catch {
    // meta hỏng → mặc định trung thực
  }

  // #94 — nạp CẢ HAI định dạng weights: blocks (mới) hoặc W1..b3 (cũ, 2 lớp
  // ẩn relu) → map thành blocks tương đương. Serving v8/v19 không vỡ.
  // F-MLP-03 (fixbug FB-4B): weights JSON hỏng HOẶC arch-string không parse
  // được → trả null cho CẢ phần mlp (UI empty-state trung thực) — KHÔNG giữ
  // arch mặc định 10-16-8-3 sai sự thật cho bản serving rác.
  let w: {
    arch?: string;
    activations?: unknown;
    blocks?: unknown;
    W1?: number[];
    b1?: number[];
    W2?: number[];
    b2?: number[];
    W3?: number[];
    b3?: number[];
  };
  try {
    w = JSON.parse(row.weights) as typeof w;
  } catch {
    return null; // weights không phải JSON hợp lệ → mlp:null trung thực
  }
  let arch: { in: number; hidden: number[]; out: number };
  try {
    // Thiếu arch (bản cực cũ không có chuỗi) → mặc định v8 10-16-8-3; arch
    // CÓ nhưng rác → parseMlpArch throw → mlp:null (không phóng đo).
    arch = typeof w.arch === "string" ? parseMlpArch(w.arch) : { in: 10, hidden: [16, 8], out: 3 };
  } catch {
    return null; // arch-string rác → mlp:null (F-MLP-03)
  }
  const activations: MlpActivation[] = normalizeActivations(w.activations, arch.hidden.length);
  let blocks: MlpWeightBlock[] | null = null;
  if (Array.isArray(w.blocks)) {
    const parsedBlocks = (w.blocks as { W?: unknown; b?: unknown }[]).map((bk) => ({
      W: (Array.isArray(bk.W) ? bk.W : []).map(round3),
      b: (Array.isArray(bk.b) ? bk.b : []).map(round3),
    }));
    // Chỉ nhận blocks khi đúng số khối (hidden + 1) — sai thì bỏ, tính arch.
    blocks = parsedBlocks.length === arch.hidden.length + 1 ? parsedBlocks : null;
  } else if (
    // F-MLP-04 (fixbug FB-4B): kiểm ĐỦ 6 mảng W1,b1,W2,b2,W3,b3 như nn.ts
    // fromJSON — thiếu W2/b2 → weights null (không chấp nhận khối giữa rỗng).
    Array.isArray(w.W1) &&
    Array.isArray(w.b1) &&
    Array.isArray(w.W2) &&
    Array.isArray(w.b2) &&
    Array.isArray(w.W3) &&
    Array.isArray(w.b3)
  ) {
    // Định dạng CŨ W1..b3 (trước #94) — chính xác 2 lớp ẩn relu.
    if (arch.hidden.length === 2) {
      blocks = [
        { W: w.W1.map(round3), b: w.b1.map(round3) },
        { W: w.W2.map(round3), b: w.b2.map(round3) },
        { W: w.W3.map(round3), b: w.b3.map(round3) },
      ];
    }
  }

  // paramCount tính TỪ BLOCKS THẬT (đúng từng khối W+b); thiếu blocks → công thức arch.
  let paramCount = 0;
  if (blocks != null) {
    paramCount = blocks.reduce((sum, bk) => sum + bk.W.length + bk.b.length, 0);
  } else {
    let from = arch.in;
    for (const h of arch.hidden) {
      paramCount += h * from + h;
      from = h;
    }
    paramCount += arch.out * from + arch.out;
  }

  // Bảng lớp DỘNG theo số lớp ẩn — activation từng lớp lấy từ weights JSON.
  const actLabel: Record<MlpActivation, string> = { relu: "ReLU", tanh: "tanh", sigmoid: "sigmoid" };
  const layers: { name: string; units: number; activation: string; params: number; note: string }[] = [
    {
      name: "Lớp vào",
      units: arch.in,
      activation: "—",
      params: 0,
      note: `${arch.in} đặc trưng z-score (rổ top-20 thanh khoản)`,
    },
  ];
  let from = arch.in;
  arch.hidden.forEach((h, i) => {
    layers.push({
      name: `Lớp ẩn ${i + 1}`,
      units: h,
      activation: actLabel[activations[i] ?? "relu"],
      params: h * from + h,
      note: `He-init · W${i + 1}·a${i} + b${i + 1}`,
    });
    from = h;
  });
  layers.push({
    name: "Lớp ra",
    units: arch.out,
    activation: "softmax",
    params: arch.out * from + arch.out,
    note: "3 lớp: Giảm · Đi ngang · Tăng",
  });

  return {
    version: row.version,
    trainedAt: row.trainedAt.toISOString(),
    featureSet,
    archString: mlpArchString(arch),
    arch,
    activations,
    paramCount,
    layers,
    featureNames: FEATURE_NAMES.slice(0, arch.in),
    outputLabels: ["Giảm", "Đi ngang", "Tăng"],
    weights: blocks != null ? { blocks } : null,
  };
}

async function buildGruInfo(): Promise<{
  version: number | null;
  trainedAt: string | null;
  status: string | null;
  valAcc: number | null;
  arch: { in: number; h: number; d: number; out: number; window: number };
  paramCount: number;
  layers: { name: string; units: number; activation: string; params: number; note: string }[];
  note: string;
}> {
  const { in: IN, h: H, d: D, out: OUT, window } = GRU_ARCH;
  const gates = 3 * (H * IN + H * H + H);
  const dense = D * H + D;
  const outLayer = OUT * D + OUT;
  let version: number | null = null;
  let trainedAt: string | null = null;
  let status: string | null = null;
  let valAcc: number | null = null;
  try {
    const row = await db.mlModel.findFirst({
      where: { kind: "dl-gru" },
      orderBy: { version: "desc" },
      select: { version: true, trainedAt: true, status: true, metrics: true },
    });
    if (row) {
      version = row.version;
      trainedAt = row.trainedAt.toISOString();
      status = row.status;
      try {
        const m = JSON.parse(row.metrics) as { valAcc?: unknown };
        if (typeof m.valAcc === "number") valAcc = m.valAcc;
      } catch {
        // metrics hỏng → null
      }
    }
  } catch {
    // DB lỗi → arch tĩnh vẫn trả
  }
  return {
    version,
    trainedAt,
    status,
    valAcc,
    arch: GRU_ARCH,
    paramCount: gates + dense + outLayer,
    layers: [
      {
        name: "Chuỗi vào",
        units: window * IN,
        activation: "—",
        params: 0,
        note: `${window} phiên × ${IN} đặc trưng (z-score theo chiều đặc trưng)`,
      },
      {
        name: "Tế bào GRU",
        units: H,
        activation: "sigmoid ×2 · tanh",
        params: gates,
        note: `3 cổng z/r/h — W[U·h + W·x] viết tay BPTT`,
      },
      {
        name: "Dense",
        units: D,
        activation: "ReLU",
        params: dense,
        note: "Wd·h + bd",
      },
      {
        name: "Lớp ra",
        units: OUT,
        activation: "softmax",
        params: outLayer,
        note: "3 lớp: Giảm · Đi ngang · Tăng",
      },
    ],
    note:
      version == null
        ? "Chưa từng train — GRU bị khoá theo cổng bằng chứng B2 (ML_OPS_BLUEPRINT §4 B3)."
        : "Shadow — chỉ lên giọng thứ ba khi đủ 60 phiên + Brier ≤ MLP (3 lớp bảo vệ trong ensemble.ts).",
  };
}

/* ─────────────────── Cache + handler ─────────────────── */

interface ArchCacheEntry {
  at: number;
  data: unknown;
}
let archCache: ArchCacheEntry | null = null;
const ARCH_CACHE_MS = 60_000;

async function buildArchitecture(): Promise<Record<string, unknown>> {
  // 1) Parse schema + đếm dòng (2 bước fallback).
  let models: ParsedModel[] = [];
  let enumCount = 0;
  try {
    const raw = await fs.readFile(path.join(process.cwd(), "prisma", "schema.prisma"), "utf8");
    const parsed = parsePrismaSchema(raw);
    models = parsed.models;
    enumCount = parsed.enumCount;
  } catch (err) {
    console.error("[api/ml/architecture] đọc schema.prisma lỗi:", err);
  }
  let exact = models.length > 0 ? await countRowsExact(models.map((m) => m.name)) : null;
  let approximate = false;
  if (exact == null) {
    exact = await countRowsApprox();
    approximate = exact != null;
  }
  const counts = exact ?? new Map<string, number>();
  if (exact == null) approximate = false; // không có gì để hiển thị số dòng

  const countOf = (name: string): number | null => (exact == null ? null : (counts.get(name) ?? 0));

  // F-07/F-08 (#129): đọc nguồn trọng số học + calibration bản serving
  // (fail-soft — 2 giá trị chỉ phục vụ hiển thị trung thực).
  const ensembleWeights = await readEnsembleWeights().catch(() => null);
  let servingCalibration = "identity (chưa fit — bản serving trước #129)";
  try {
    const serving = await db.mlModel.findFirst({
      where: { kind: "dl-mlp", status: "serving" },
      orderBy: { version: "desc" },
      select: { meta: true },
    });
    if (serving?.meta) {
      const meta = JSON.parse(serving.meta) as {
        calibration?: {
          eceBefore?: number | null;
          eceAfter?: number | null;
          whyRejected?: string;
        };
      };
      if (meta.calibration) {
        servingCalibration =
          meta.calibration.whyRejected != null
            ? `identity — bị từ chối: ${meta.calibration.whyRejected}`
            : `isotonic (ECE ${(meta.calibration.eceBefore ?? "?")} → ${(meta.calibration.eceAfter ?? "?")})`;
      }
    }
  } catch {
    // meta hỏng → giữ nhãn identity trung thực
  }

  const dbPart = {
    totalModels: models.length,
    totalEnums: enumCount,
    approximate,
    countedAt: new Date().toISOString(),
    groups: MODEL_GROUPS,
    models: models
      .map((m) => ({
        name: m.name,
        group: groupOfModel(m.name),
        fields: m.fields.map((f) => ({
          name: f.name,
          type: f.type,
          relation: f.relation,
          attrs: f.attrs,
        })),
        relations: m.relations,
        indexes: m.indexes,
        rowCount: countOf(m.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };

  // 2) MLP + GRU + ensemble (song song, mỗi cái fail-soft riêng).
  const [mlp, gru] = await Promise.all([buildMlpInfo().catch(() => null), buildGruInfo()]);

  // 3) Pipeline 8 chặng — số dòng sống từ counts.
  const nf = (v: number | null): string =>
    v == null ? "—" : `${v.toLocaleString("vi-VN")} dòng`;
  const latestOf = async (kind: string): Promise<{ version: number; status: string } | null> => {
    try {
      return await db.mlModel.findFirst({
        where: { kind },
        orderBy: { version: "desc" },
        select: { version: true, status: true },
      });
    } catch {
      return null;
    }
  };
  const [dlMlp, dlGru, rlQ] = await Promise.all([
    latestOf("dl-mlp"),
    latestOf("dl-gru"),
    latestOf("rl-q"),
  ]);

  const pipeline = [
    {
      id: "sources",
      title: "1 · Nguồn dữ liệu",
      items: [
        { label: "VNDIRECT EOD", value: "REST · đồng bộ 15:45 ICT mỗi phiên" },
        { label: "Tick giá 10s", value: "trong phiên — mô phỏng quanh ref EOD thật / realtime finmo" },
        { label: "Tin tức RSS", value: "ingest 15 phút/lần" },
        { label: "Chu kỳ agent", value: "23 agents · nhịp K2 (AppSetting k-run)" },
      ],
    },
    {
      id: "storage",
      title: "2 · Kho lưu trữ (Supabase Postgres)",
      items: [
        { label: "Bar (EOD)", value: nf(countOf("Bar")) },
        { label: "IntradayBar (5-phút)", value: nf(countOf("IntradayBar")) },
        { label: "NewsItem", value: nf(countOf("NewsItem")) },
        { label: "AgentMessage", value: nf(countOf("AgentMessage")) },
      ],
    },
    {
      id: "features",
      title: "3 · Đặc trưng (features.ts)",
      items: [
        { label: `featureAt()`, value: `${ML_FEATURE_COUNT} chiều · ${ML_FEATURE_SET} · rổ top-20` },
        { label: "standardize()", value: "z-score theo TRAIN split (chặn leakage tương lai)" },
        { label: "trainingWindowDigest()", value: "windowHash SHA-256 PIT — skip-guard trùng cửa sổ" },
      ],
    },
    {
      id: "models",
      title: "4 · Mô hình (MlModel)",
      items: [
        {
          label: "dl-mlp (MLP)",
          value: dlMlp ? `v${dlMlp.version} · ${dlMlp.status}` : "chưa train",
        },
        {
          label: "dl-gru (GRU-24)",
          value: dlGru ? `v${dlGru.version} · ${dlGru.status} (shadow)` : "chưa train — cổng B2",
        },
        { label: "rl-q (Q-learning)", value: rlQ ? `v${rlQ.version} · ${rlQ.status}` : "chưa train" },
        { label: "linreg (hồi quy)", value: "tính tại chỗ trong ensemble — không lưu DB" },
      ],
    },
    {
      id: "forecast",
      title: "5 · Dự báo ensemble",
      items: [
        {
          label: "mlForecastEnsemble()",
          value: `2 giọng: 0,7·MLP + 0,3·linreg · 3 giọng (khi GRU bật): 0,5/0,2/0,3`,
        },
        // F-07 (#129): nguồn trọng số hiệu lực — learned (từ D-LEDGER) hay fixed.
        {
          label: "Nguồn trọng số (F-07)",
          value:
            ensembleWeights == null
              ? "fixed 0,7/0,3 (chưa từng học — cold-start)"
              : ensembleWeights.source === "learned"
                ? `HỌC TỪ D-LEDGER: wMlp ${ensembleWeights.wMlp} · wLinreg ${ensembleWeights.wLinreg} (valBrier ${ensembleWeights.valBrier} vs fixed ${ensembleWeights.valBrierFixed} · n=${ensembleWeights.nVotes})`
                : `fixed 0,7/0,3 — learned bị TỪ CHỐI: ${ensembleWeights.whyRejected ?? "chưa thắng deadband"}`,
        },
        // F-08 (#129): isotonic calibration của bản serving.
        {
          label: "Hiệu chuẩn xác suất (F-08)",
          value: servingCalibration,
        },
        { label: "deadband", value: `|điểm| < ${ML_ENSEMBLE_DEADBAND.toString().replace(".", ",")} → Đi ngang` },
        { label: "PSI drift", value: "so histogram đặc trưng 30 phiên — đề xuất train lại khi ≥ 0,25" },
      ],
    },
    {
      id: "weights",
      title: "6 · Trọng số phiếu (Bandit)",
      items: [
        { label: "Thompson sampling", value: "6 arm Beta(α+1, β+1) — hậu nghiệm agent đúng hướng" },
        { label: "settlePendingRewards()", value: "kết toán 5 phiên ± 0,5% rổ top-10" },
        { label: "BanditEvent", value: nf(countOf("BanditEvent")) },
      ],
    },
    {
      id: "synthesis",
      title: "7 · Tổng hợp Bayes",
      items: [
        { label: "MarketAssessment", value: nf(countOf("MarketAssessment")) },
        { label: "prior → posterior", value: "CĐTT cập nhật theo bằng chứng mỗi chu kỳ" },
        { label: "RAG L1 (RetrievalLog)", value: nf(countOf("RetrievalLog")) },
      ],
    },
    {
      id: "decision",
      title: "8 · Quyết định & thực thi",
      items: [
        { label: "Signal", value: nf(countOf("Signal")) },
        { label: "Order", value: nf(countOf("Order")) },
        { label: "Trade", value: nf(countOf("Trade")) },
        { label: "K1 sandbox", value: "tín hiệu CONSENSUS → lệnh thử nghiệm (tài khoản sandbox)" },
      ],
    },
  ];

  return {
    db: dbPart,
    mlp,
    gru,
    ensemble: {
      deadband: ML_ENSEMBLE_DEADBAND,
      twoVoice: ENSEMBLE_WEIGHTS.twoVoice,
      threeVoice: ENSEMBLE_WEIGHTS.threeVoice,
      // F-07 (#129): nguồn trọng số đang phục vụ + AppSetting learned đầy đủ
      // (nn-tab hiển thị bảng so sánh — "Công khai" đặc tả F-07 mục 5).
      weightsSource: ensembleWeights?.source === "learned" ? "learned" : "fixed",
      learned: ensembleWeights,
    },
    pipeline,
    features: {
      setLabel: ML_FEATURE_SET,
      count: ML_FEATURE_COUNT,
      horizonDays: ML_HORIZON_DAYS,
      names: FEATURE_NAMES,
    },
  };
}

/* ─────────────────── Draft #94 — cấu hình đang chỉnh (ngoài cache) ─────────────────── */

/**
 * Arch + activations + lossWeights + hyper HIỆU LỰC từ readEffectiveMlTuning
 * (AppSetting ml-tuning) — trình chỉnh sửa kiến trúc ANN ở tab Mạng thần kinh
 * khởi tạo draft local từ đây. ĐÂY LÀ CẤU HÌNH ĐANG CHỈNH, không phải serving.
 */
async function buildArchDraft(): Promise<{
  arch: { in: number; hidden: number[]; out: number };
  archString: string;
  activations: MlpActivation[];
  lossWeights: [number, number, number];
  hyper: {
    epochs: number;
    patience: number;
    batchSize: number;
    lr: number;
    l2: number;
    valFraction: number;
    seed: number;
  };
}> {
  const tuning = await readEffectiveMlTuning(); // fail-soft → mặc định module
  const arch = { in: ML_FEATURE_COUNT, hidden: tuning.mlp.hidden, out: 3 };
  return {
    arch,
    archString: mlpArchString(arch),
    activations: tuning.mlp.activations,
    lossWeights: tuning.mlp.lossWeights,
    hyper: {
      epochs: tuning.mlp.epochs,
      patience: tuning.mlp.patience,
      batchSize: tuning.mlp.batchSize,
      lr: tuning.mlp.lr,
      l2: tuning.mlp.l2,
      valFraction: tuning.mlp.valFraction,
      seed: tuning.mlp.seed,
    },
  };
}

export async function GET() {
  let base: Record<string, unknown>;
  if (archCache && Date.now() - archCache.at < ARCH_CACHE_MS) {
    base = archCache.data as Record<string, unknown>;
  } else {
    try {
      base = (await buildArchitecture()) as Record<string, unknown>;
      archCache = { at: Date.now(), data: base };
    } catch (err) {
      console.error("[api/ml/architecture] GET lỗi:", err);
      return NextResponse.json(
        { error: "Không dựng được kiến trúc hệ thống học máy." },
        { status: 500 }
      );
    }
  }
  // Draft #94 LUÔN tươi (ngoài cache 60s) — trình chỉnh sửa kiến trúc cần
  // phản ánh AppSetting ml-tuning ngay sau khi Lưu, không đợi cache hết hạn.
  const draft = await buildArchDraft().catch(() => null);
  return NextResponse.json({ ...base, draft });
}
