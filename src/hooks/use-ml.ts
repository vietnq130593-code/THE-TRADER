"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

/** vi-VN, 1 chữ số thập phân — dùng cho giây/thời lượng toast. */
const nf1 = new Intl.NumberFormat("vi-VN", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/**
 * Phiên #35 (Task 35-FE) — data hooks cho card "Học máy & Học tăng cường"
 * trong workspace Tổng hợp (synthesis).
 *
 * - useMlStatus: GET /api/ml/status — trạng thái 3 mô hình học thật
 *   (MLP dự báo 5 phiên · Q-learning gym · Bandit Thompson sampling).
 *   Refetch mỗi 30 giây; lỗi 404 (backend 35-ML chưa merge) KHÔNG retry —
 *   UI render empty-state "Đang chờ backend học máy" và tự lành khi API lên.
 * - useTrainMl: POST /api/ml/train {target} — huấn luyện lại;
 *   429 cooldown đọc header Retry-After để toast đúng số giây phải đợi.
 *
 * Hợp đồng theo spec 35-ML; types đặt tại chỗ vì src/lib/types.ts do
 * subagent backend sở hữu (FE không sửa). Mọi trường đều optional-tolerant:
 * dlMlp/rlQ có thể null khi chưa train.
 */

/** Query key dùng chung cho mọi query trạng thái học máy trên UI. */
export const ML_STATUS_QUERY_KEY = ["ml-status"] as const;

/** Target huấn luyện — "all" (MLP + Q-learning) hoặc từng mô hình. */
export type MlTrainTarget = "all" | "dl-mlp" | "rl-q";

/* ─────────────────── Types (hợp đồng GET /api/ml/status) ─────────────────── */

export interface DlMlpMetrics {
  epochs: number;
  /** Số mẫu huấn luyện (định dạng vi-VN trên UI). */
  samples: number;
  /** 0..1 — UI ×100 thành %. */
  trainAcc: number;
  /** 0..1 — UI ×100 thành % (xanh ≥50% / đỏ <50%). */
  valAcc: number;
  trainLoss: number;
  valLoss: number;
  /** Horizon dự báo (phần) — thường 5. */
  horizonDays: number;
  /** Số đặc trưng đầu vào. */
  features: number;
  /** Mã đóng góp mạnh nhất vào dự báo (max 8 chip trên UI). */
  topSymbols: string[];
}

export interface RlQMetrics {
  episodes: number;
  /** ε cuối cùng sau decay (0..1). */
  epsilonEnd: number;
  /** Phần thưởng trung bình 50 episode cuối (có dấu) — W4 (#165): số
   *  in-training trên TRAIN split (Q-table không nhìn đoạn holdout). */
  avgRewardLast50: number;
  states: number;
  actions: number;
  /** Stance hiện tại của chính sách: "tăng" | "giữ" | "giảm". */
  stance: string;
  /** 0..1 — tỷ lệ phơi nhiễm rủi ro hiện tại. */
  exposure: number;
  /** Q-value lớn nhất (có dấu). */
  qMax: number;
  /** W4 (#165) — kiểm định ngoài mẫu (walk-forward tách thời gian);
   *  null/undefined = bản train trước W4 hoặc dữ liệu tối thiểu. */
  holdout?: RlQHoldoutMetrics | null;
}

/** W4 (#165) — kiểm định ngoài mẫu của Q-table (mirror QHoldoutResult rl.ts). */
export interface RlQHoldoutMetrics {
  /** Số phiên cuối giữ ra khỏi train. */
  bars: number;
  /** Số bước đánh giá trên đoạn giữ-ra. */
  steps: number;
  /** Phần thưởng trung bình mỗi bước của chính sách greedy argmax Q. */
  avgRewardPerStep: number;
  /** Baseline đo trên CÙNG đoạn (per-step). */
  baselines: { hold50: number; buyHold: number; cash: number };
  /** avgRewardPerStep − giữ 50% (dương = thắng baseline). */
  edgeVsHold50: number;
  /** avgRewardPerStep − mua-giữ (dương = thắng baseline). */
  edgeVsBuyHold: number;
}

export interface BanditArm {
  agentCode: string;
  name: string;
  alpha: number;
  beta: number;
  pulls: number;
  /** Số "thắng" tích luỹ (reward liên tục, không nhất thiết nguyên). */
  wins: number;
  /** Trung bình posterior Beta(α+1, β+1) — 0..1. */
  posteriorMean: number;
  /** F-15 (#129): Wilson CI 95% của tỉ lệ thắng (pulls=0 → [0,1]). */
  wilsonLow?: number;
  wilsonHigh?: number;
  /** F-13 (#129): posterior theo regime hiện tại (null = bảng chung). */
  regimePosteriorMean?: number | null;
}

export interface MlModelStatus<TMetrics> {
  version: number;
  /** "serving" | "training" | … (UI map, không đoán cứng). */
  status: string;
  trainedAt: string;
  /** B1 (#81) — nhãn bộ đặc trưng (v1-lag10 / v2-lag16); API cũ thiếu →
   *  undefined (UI hiển thị trung thực theo mặc định). */
  featureSet?: string;
  /** F-18B (#132) — arch-string bản serving ("10-16-8-3") từ weights JSON;
   *  undefined khi weights không parse được (UI ẩn badge — không phóng đo). */
  archString?: string;
  metrics: TMetrics;
  /** W5 (#163) — note giải thích metrics.valAcc là số selection (thiên lệch
   *  lên). Additive: API cũ thiếu → UI chỉ hiện holdout khi có. */
  metricsNote?: string;
  /** W5 (#163) — số ngoài mẫu khi bản serving lên qua cổng sweep; null khi
   *  lên qua train tay (không có số trung thực ngoài mẫu để báo). */
  holdout?: MlHoldoutMetrics | null;
}

/** W5 (#163) — metrics ngoài mẫu của bản serving (AuditLog ML_SWEEP_SWAP). */
export interface MlHoldoutMetrics {
  /** Số mẫu holdout walk-forward. */
  size: number;
  dateFrom: string | null;
  dateTo: string | null;
  /** valAcc đo trên holdout — trung thực ngoài mẫu. */
  valAcc: number;
  /** Brier trên holdout (nhỏ = tốt). */
  brier: number | null;
  sweepRunId: string | null;
}

/** W3 (#164) — trạng thái cơ chế auto-retrain theo PSI (GET /api/ml/status). */
export interface MlAutoRetrainStatus {
  /** Kill-switch AppSetting "ml-psi-retrain" (mặc định BẬT khi chưa có key). */
  enabled: boolean;
  /** Ngưỡng PSI kích hoạt (0,25 — "dịch-chuyển" A3). */
  psiWarn: number;
  /** Cooldown giữa 2 lần trigger (giờ). */
  cooldownHours: number;
  /** Lần trigger gần nhất (ISO) — null = chưa từng. */
  lastAt: string | null;
  /** trained-promoted | trained-not-promoted | no-new-window | … */
  lastOutcome: string | null;
  /** Mô tả lịch engine (chỉ hiển thị). */
  schedule: string;
}

export interface MlStatusResponse {
  /** null khi chưa huấn luyện lần nào. */
  dlMlp: MlModelStatus<DlMlpMetrics> | null;
  /** null khi chưa huấn luyện lần nào. */
  rlQ: MlModelStatus<RlQMetrics> | null;
  bandit: { arms: BanditArm[]; lastSettleAt: string | null } | null;
  /** Số phiếu LLM chờ kết toán reward. */
  pendingSettles: number;
  /** W3 (#164) — trạng thái cơ chế auto-retrain theo PSI (BẬT mặc định;
  *  additive — FE cũ bỏ qua). */
  autoRetrain?: MlAutoRetrainStatus | null;
  /** B2 (#81) — verdict cổng bằng chứng chuỗi (additive; chưa đo →
   *  available:false + reason). */
  gate?: MlGateStatus;
  /** B3/B4 (#81) — trạng thái GRU giọng thứ ba (null khi chưa từng train). */
  gru?: MlGruStatus | null;
  /** L1 (#83) — thống kê RAG BM25 (corpus + 30 ngày RetrievalLog). */
  rag?: MlRagStatus | null;
  /** Task 142 (F-24 §6) — L2 tri thức dài hạn (corpus tuyển + vector NIM +
   *  đồ thị thực thể). Additive — FE cũ bỏ qua. */
  l2?: MlL2Status | null;
  /** #83 — số liệu bảng intraday 5-phút (tiến độ cổng "Lớp chuỗi đầy đủ"). */
  intraday?: MlIntradayStatus | null;
  /** C2-pipeline (#99 — ML_AUTOML_BLUEPRINT §5.1/Q4): tiến độ cổng dữ liệu
   *  "tin tức → đặc trưng v3-news22" (phiên có tin PIT /60 + coverage
   *  lexicon) — additive, FE cũ bỏ qua. */
  newsGate?: MlNewsGateStatus | null;
}

/* ───── C2-pipeline — cổng dữ liệu tin tức → đặc trưng (#99) ───── */

export interface MlNewsGateSourceCoverage {
  source: string;
  news: number;
  hit: number;
  /** 0..1 — tỉ lệ tin có ≥ 1 hit lexicon trong nguồn. */
  coverage: number;
}

export interface MlNewsGateStatus {
  available: boolean;
  reason?: string;
  totalNews: number;
  /** Số phiên giao dịch (T2–T6) có ≥ 1 tin biết trước đóng cửa — PIT-strict. */
  sessionsWithNews: number;
  /** 60 — ngưỡng cổng dữ liệu trước khi train đặc trưng news (§5.1). */
  sessionsRequired: number;
  /** true khi đủ 60 phiên — điều kiện CẦN, chưa tự train gì (còn gate-news §5.3). */
  readyToTrain: boolean;
  /** 0..1 — % tin có ≥ 1 hit lexicon (~75 thuật ngữ tài chính VN). */
  coveragePercent: number;
  hitTitles: number;
  measuredTitles: number;
  perSource: MlNewsGateSourceCoverage[];
  firstNewsAt: string | null;
  lastNewsAt: string | null;
  measuredAt: string;
}

/* ───── L1 RAG + Intraday 5-phút (#83 — ML_LEARNING/ML_OPS_BLUEPRINT) ───── */

/** Field `rag` của /api/ml/status — cổng L3 đo trên 30 ngày RetrievalLog. */
export interface MlRagStatus {
  corpusMessages: number;
  corpusNews: number;
  retrievals30d: number;
  usedInPrompt30d: number;
  usageRate30d: number | null;
  lastRetrievalAt: string | null;
}

/** Field `l2` của /api/ml/status (Task 142 — F-24 §6) — kho tri thức dài hạn. */
export interface MlL2Status {
  chunks: number;
  byRefTable: Record<string, number>;
  vectorCoverage: { withVector: number; bm25Only: number };
  entities: { total: number; byType: Record<string, number> };
  edges: { cooccur: number; marketRelation: number };
  retrievals30d: number;
  usedInPrompt30d: number;
  usageRate30d: number | null;
  lastRetrievalAt: string | null;
  pending: number;
  embedModel: string;
  dim: number;
}

/** Field `intraday` của /api/ml/status — bar 5-phút gom từ tick S4. */
export interface MlIntradayStatus {
  bars: number;
  symbols: number;
  tradingDays: number;
  lastDayBars: number;
  lastBarAt: string | null;
  simulated: number;
  realtime: number;
}

/* ───── Cổng bằng chứng B2 + GRU B3 (ML_OPS_BLUEPRINT §4 — #81) ───── */

/** Field `gate` của /api/ml/status — mirror hợp đồng route. */
export type MlGateStatus =
  | { available: false; reason?: string }
  | {
      available: true;
      verdict: "PASS" | "FAIL";
      measuredAt: string;
      windowHash: string;
      deltaBrier: { mean: number; ciLow: number; ciHigh: number };
      newFeaturesSignificant: number;
      passedVia: "deltabrier" | "rankic" | null;
      swappedServing: boolean;
    };

/** Field `gru` của /api/ml/status — null khi chưa từng train dl-gru. */
export interface MlGruStatus {
  version: number;
  status: string;
  trainedAt: string;
  valAcc: number | null;
  params: number | null;
  window: number | null;
  enabled: boolean;
  shadowSettled: number;
  gruBrier: number | null;
  mlpBrier: number | null;
  consecutiveWorse: number;
}

/* ─────────────────── Types (hợp đồng POST /api/ml/train) ─────────────────── */

/** Response train — dlMlp/rlQ là BẢN METRICS (không bọc version/status).
 *  A4 (phiên #79) — serving-swap guard trả thêm trường tuỳ chọn promoted
 *  (false = valAcc bản mới thua bản serving → lưu archived, KHÔNG thay mô
 *  hình đang phục vụ). F-801-03 (Fixbug #80): UI đọc để toast trung thực.
 *  F-B811-01 (Fixbug-B #81): thêm promotionReason — promoted=false giờ có
 *  2 đường (thua valAcc baseline HOẶC khác featureSet khi cổng B2 chưa mở),
 *  toast phải nói đúng LÝ DO THẬT thay vì đoán từ phép so số. */
export interface MlTrainResponse {
  ok: boolean;
  trained: string[];
  durationMs: number;
  dlMlp: DlMlpMetrics | null;
  rlQ: RlQMetrics | null;
  /** false = bản mới không lên serving. */
  promoted?: boolean;
  /** valAcc bản serving TRƯỚC khi train (null = chưa có bản nào). */
  servingValAcc?: number | null;
  /** valAcc bản vừa train. */
  newValAcc?: number;
  /** "valacc" = thua baseline (A4) · "featureset-gate" = khác bộ đặc trưng,
   *  cổng B2 chưa mở (B1 #81) · "first" = chưa có bản trước. */
  promotionReason?: "valacc" | "featureset-gate" | "first";
  /** #94 — cấu hình MLP THẾT SỰ áp dụng cho bản vừa train (F-MLP-01 · fixbug
   *  FB-4B: FE đưa arch vào toast để trader thấy đúng kiến trúc đã dùng —
   *  tránh tưởng train bằng bản nháp chưa lưu). Tolerant khi backend cũ thiếu. */
  appliedTuning?: {
    arch: string;
    activations: string[];
    lossWeights: [number, number, number];
    lr: number;
    batchSize: number;
    maxEpochs: number;
    patience: number;
    l2: number;
    valFraction: number;
    seed: number;
  };
}

/* ─────────────────── Fetch helpers ─────────────────── */

/** Lỗi API học máy — giữ status để UI phân nhánh 404 (chờ backend) vs lỗi khác. */
export class MlApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "MlApiError";
    this.status = status;
  }
}

async function fetchMlStatus(): Promise<MlStatusResponse> {
  const res = await fetch("/api/ml/status", { cache: "no-store" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new MlApiError(
      body?.error ?? `Không tải được trạng thái học máy (${res.status})`,
      res.status
    );
  }
  return (await res.json()) as MlStatusResponse;
}

export function isMlNotFound(error: unknown): boolean {
  return error instanceof MlApiError && error.status === 404;
}

/* ─────────────────── Queries ─────────────────── */

export function useMlStatus() {
  return useQuery({
    queryKey: ML_STATUS_QUERY_KEY,
    queryFn: fetchMlStatus,
    staleTime: 15_000,
    // Tự làm mới mỗi 30s — mô hình có thể được train/settle ở nơi khác.
    refetchInterval: 30_000,
    // 404 = backend 35-ML chưa merge: KHÔNG retry (tránh spam request),
    // refetchInterval vẫn polling để tự hiển thị khi API lên.
    retry: (failureCount, error) => {
      if (isMlNotFound(error)) return false;
      return failureCount < 2;
    },
  });
}

/* ─────────────────── #89 — Kiến trúc (GET /api/ml/architecture) ─────────────────── */

export const ML_ARCHITECTURE_QUERY_KEY = ["ml-architecture"] as const;

export interface MlDbFieldInfo {
  name: string;
  type: string;
  relation: boolean;
  attrs: string;
}

export interface MlDbModelInfo {
  name: string;
  group: string;
  fields: MlDbFieldInfo[];
  relations: string[];
  indexes: string[];
  rowCount: number | null;
}

export interface MlDbArchitecture {
  totalModels: number;
  totalEnums: number;
  approximate: boolean;
  countedAt: string;
  groups: { id: string; label: string; models: string[] }[];
  models: MlDbModelInfo[];
}

export interface MlLayerSpec {
  name: string;
  units: number;
  activation: string;
  params: number;
  note: string;
}

/** Hàm kích hoạt của TỪNG lớp ẩn MLP (#94) — relu giữ hành vi bản cũ. */
export type MlActivation = "relu" | "tanh" | "sigmoid";

export interface MlMlpArchInfo {
  version: number | null;
  trainedAt: string | null;
  featureSet: string;
  archString: string;
  /** #94 — arch N-layer: in → hidden[1..5] → out. */
  arch: { in: number; hidden: number[]; out: number };
  /** #94 — activation TỪNG lớp ẩn của bản serving (đúng độ dài hidden). */
  activations: MlActivation[];
  paramCount: number;
  layers: MlLayerSpec[];
  featureNames: string[];
  outputLabels: string[];
  /** #94 — trọng số theo khối W+b (số khối = hidden.length + 1, khối cuối là ra).
   *  API đã map định dạng cũ W1..b3 thành blocks tương đương. */
  weights: { blocks: { W: number[]; b: number[] }[] } | null;
}

export interface MlGruArchInfo {
  version: number | null;
  trainedAt: string | null;
  status: string | null;
  valAcc: number | null;
  arch: { in: number; h: number; d: number; out: number; window: number };
  paramCount: number;
  layers: MlLayerSpec[];
  note: string;
}

export interface MlEnsembleInfo {
  deadband: number;
  twoVoice: { mlp: number; linreg: number };
  threeVoice: { mlp: number; gru: number; linreg: number };
}

export interface MlPipelineItem {
  label: string;
  value: string;
}

export interface MlPipelineStage {
  id: string;
  title: string;
  items: MlPipelineItem[];
}

/** #94 — cấu hình MLP ĐANG CHỈNH (hiệu lực từ AppSetting ml-tuning — KHÔNG
 *  phải bản serving): arch N-layer + activation từng lớp + trọng số loss từng
 *  đầu ra [DOWN, FLAT, UP] + hyper huấn luyện. Trình chỉnh sửa kiến trúc ANN
 *  (tab Mạng thần kinh) khởi tạo draft local từ đây.
 *  F-18 (#131): + featureSet (16/24 chiều) + source (champion NAS đồng bộ). */
export interface MlArchDraft {
  arch: { in: number; hidden: number[]; out: number };
  archString: string;
  activations: MlActivation[];
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
  /** F-18 (#131): bộ đặc trưng của draft ("v2-lag16" 16 chiều | "v3-macro" 24 chiều). */
  featureSet?: string;
  /** F-18 (#131): nguồn gốc thiết lập — champion NAS sweep đồng bộ tự động
   *  (null = trader tự chỉnh / chưa từng đồng bộ). UI hiển thị banner nguồn. */
  source?: {
    at: string;
    runId: string;
    tag: string;
    arch: string;
    modelVersion?: number;
  } | null;
}

export interface MlArchitectureResponse {
  db: MlDbArchitecture;
  mlp: MlMlpArchInfo | null;
  gru: MlGruArchInfo;
  ensemble: MlEnsembleInfo;
  pipeline: MlPipelineStage[];
  features: { setLabel: string; count: number; horizonDays: number; names: string[] };
  /** #94 — null khi DB lỗi (fail-soft, UI dùng mặc định code). */
  draft: MlArchDraft | null;
}

async function fetchMlArchitecture(): Promise<MlArchitectureResponse> {
  const res = await fetch("/api/ml/architecture", { cache: "no-store" });
  if (!res.ok) {
    throw new MlApiError(
      `Không tải được kiến trúc học máy (${res.status})`,
      res.status
    );
  }
  return (await res.json()) as MlArchitectureResponse;
}

export function useMlArchitecture() {
  return useQuery({
    queryKey: ML_ARCHITECTURE_QUERY_KEY,
    queryFn: fetchMlArchitecture,
    staleTime: 60_000,
    refetchInterval: 120_000,
    retry: (failureCount) => failureCount < 2,
  });
}

/* ─────────────────── #89 — Tinh chỉnh (GET/POST /api/ml/tuning) ─────────────────── */

export const ML_TUNING_QUERY_KEY = ["ml-tuning"] as const;

/** #94 — MLP tuning v2: kiến trúc N-layer + lossWeights + hyper mới.
 *  hidden/activations/lossWeights chỉnh qua trình chỉnh sửa kiến trúc ANN
 *  (tab Mạng thần kinh); hyper số chỉnh ở tab Tinh chỉnh. */
export interface MlTuningMlp {
  /** Số nơ-rôn TỪNG lớp ẩn (1..5 lớp, 2..96 nơ-rôn). */
  hidden: number[];
  /** Activation TỪNG lớp ẩn — cùng độ dài hidden. */
  activations: MlActivation[];
  /** Trọng số loss từng đầu ra [DOWN, FLAT, UP] — nhân class-weight 1/tần suất. */
  lossWeights: [number, number, number];
  epochs: number;
  patience: number;
  batchSize: number;
  lr: number;
  /** L2 weight-decay (chỉ áp W). */
  l2: number;
  /** Tỷ lệ tập xác thực (block cuối). */
  valFraction: number;
  /** Seed RNG deterministic. */
  seed: number;
}

export interface MlTuningRag {
  topK: number;
  k1: number;
  b: number;
  wRecency: number;
}

export interface MlTuningFieldSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  integer: boolean;
  unit?: string;
  hint: string;
}

export interface MlTuningResponse {
  saved: {
    mlp?: Partial<MlTuningMlp>;
    rag?: Partial<MlTuningRag>;
    updatedAt?: string;
  };
  effective: { mlp: MlTuningMlp; rag: MlTuningRag };
  defaults: { mlp: MlTuningMlp; rag: MlTuningRag };
  ranges: { mlp: MlTuningFieldSpec[]; rag: MlTuningFieldSpec[] };
  updatedAt: string | null;
}

export interface MlTuningSaveResponse extends MlTuningResponse {
  ok: boolean;
  applied: string[];
  error?: string;
  fields?: string[];
}

export interface MlTuningSaveInput {
  mlp?: Partial<MlTuningMlp>;
  rag?: Partial<MlTuningRag>;
  resetMlp?: boolean;
  resetRag?: boolean;
  gruEnabled?: boolean;
  resetBandit?: boolean;
}

async function fetchMlTuning(): Promise<MlTuningResponse> {
  const res = await fetch("/api/ml/tuning", { cache: "no-store" });
  if (!res.ok) {
    throw new MlApiError(`Không tải được cấu hình tinh chỉnh (${res.status})`, res.status);
  }
  return (await res.json()) as MlTuningResponse;
}

export function useMlTuning() {
  return useQuery({
    queryKey: ML_TUNING_QUERY_KEY,
    queryFn: fetchMlTuning,
    staleTime: 30_000,
    retry: (failureCount) => failureCount < 2,
  });
}

export function useSaveMlTuning() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: MlTuningSaveInput): Promise<MlTuningSaveResponse> => {
      const res = await fetch("/api/ml/tuning", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = (await res.json().catch(() => null)) as MlTuningSaveResponse | null;
      if (!res.ok || data == null || data.ok !== true) {
        const fieldList = data?.fields?.length ? ` (${data.fields.join("; ")})` : "";
        throw new MlApiError(
          (data?.error ?? `Không lưu được cấu hình tinh chỉnh (${res.status})`) + fieldList,
          res.status
        );
      }
      return data;
    },
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ML_TUNING_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ML_STATUS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ML_ARCHITECTURE_QUERY_KEY });
      toast.success("Đã lưu cấu hình tinh chỉnh", {
        description: res.applied.length > 0 ? `Áp dụng: ${res.applied.join(" · ")}` : undefined,
      });
    },
    onError: (err: Error) => {
      toast.error(err.message || "Không lưu được cấu hình tinh chỉnh.");
    },
  });
}

/* ─────────────────── #89 — Kết toán reward ngay (POST /api/ml/settle) ─────────────────── */

export function useSettleMl() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (): Promise<{ settled: number; votes: number; durationMs: number }> => {
      const res = await fetch("/api/ml/settle", { method: "POST" });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; settled?: number; votes?: number; durationMs?: number; error?: string }
        | null;
      if (!res.ok || data == null || data.ok !== true) {
        throw new MlApiError(data?.error ?? `Kết toán thất bại (${res.status})`, res.status);
      }
      return {
        settled: data.settled ?? 0,
        votes: data.votes ?? 0,
        durationMs: data.durationMs ?? 0,
      };
    },
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ML_STATUS_QUERY_KEY });
      toast.success(
        `Kết toán reward: ${res.settled} assessment · ${res.votes} phiếu`,
        {
          description:
            res.durationMs > 0
              ? `Hoàn tất trong ${nf1.format(res.durationMs / 1000)}s — phiếu đủ 5 phiên được tích lũy vào posterior Beta.`
              : "Phiếu đủ 5 phiên được tích lũy vào posterior Beta.",
        }
      );
    },
    onError: (err: Error) => {
      toast.error(err.message || "Không kết toán được reward.");
    },
  });
}

/* ─────────────────── Mutation ─────────────────── */

export function useTrainMl() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (target: MlTrainTarget): Promise<MlTrainResponse> => {
      const res = await fetch("/api/ml/train", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target }),
      });
      const data = (await res.json().catch(() => null)) as
        | (MlTrainResponse & { error?: string })
        | null;
      // Tolerant: lỗi có thể đến từ HTTP status, body {error} hoặc {ok:false}.
      if (!res.ok || data == null || data.ok === false || data.error != null) {
        if (res.status === 429) {
          // Cooldown — đọc Retry-After (giây) nếu có.
          const headerSecs = Number(res.headers.get("retry-after"));
          const secs =
            Number.isFinite(headerSecs) && headerSecs > 0 ? Math.ceil(headerSecs) : null;
          throw new MlApiError(
            secs != null
              ? `Mô hình đang trong thời gian chờ (cooldown) — thử lại sau khoảng ${secs} giây.`
              : (data?.error ??
                "Mô hình đang trong thời gian chờ (cooldown). Vui lòng đợi rồi thử lại."),
            429
          );
        }
        throw new MlApiError(
          data?.error ?? `Huấn luyện thất bại (${res.status})`,
          res.status
        );
      }
      return data;
    },
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ML_STATUS_QUERY_KEY });
      // F-MLP-07 (fixbug FB-4B): sơ đồ serving trên tab Mạng thần kinh đọc từ
      // /api/ml/architecture — không invalidate thì stale ≤60-120s sau train.
      void queryClient.invalidateQueries({ queryKey: ML_ARCHITECTURE_QUERY_KEY });

      // Toast với số liệu THẬT từ response (tolerant — backend có thể thiếu field).
      const trained = Array.isArray(res.trained) ? res.trained : [];
      const secs =
        typeof res.durationMs === "number" && res.durationMs > 0
          ? `${nf1.format(res.durationMs / 1000)}s`
          : null;
      const valAccPct =
        res.dlMlp?.valAcc != null && Number.isFinite(res.dlMlp.valAcc)
          ? `${(res.dlMlp.valAcc * 100).toFixed(1).replace(".", ",")}%`
          : null;
      const episodes = res.rlQ?.episodes ?? null;

      // F-801-03 (Fixbug #80) + F-B811-01 (Fixbug-B #81): serving-swap guard —
      // promoted=false nghĩa là bản vừa train KHÔNG thay mô hình đang phục vụ.
      // Toast phải nói đúng LÝ DO (backend gửi promotionReason — tolerant khi
      // backend cũ chưa có trường thì fallback so số như F-801-03).
      const pct = (v: number | null | undefined): string | null =>
        typeof v === "number" && Number.isFinite(v)
          ? `${(v * 100).toFixed(1).replace(".", ",")}%`
          : null;
      let notServing: string | null = null;
      if (res.promoted === false) {
        if (res.promotionReason === "featureset-gate") {
          notServing =
            "Bản mới KHÔNG lên serving — cổng bằng chứng B2 chưa mở cho bộ đặc trưng v2-lag16 (giữ bản v1-lag10 đang phục vụ).";
        } else if (res.promotionReason === "first") {
          notServing = "Bản mới KHÔNG lên serving — chưa có bản serving trước đó để so.";
        } else {
          const np = pct(res.newValAcc ?? null);
          const sp = pct(res.servingValAcc ?? null);
          notServing =
            np != null && sp != null
              ? `Bản mới KHÔNG lên serving — valAcc ${np} < bản đang phục vụ ${sp} (giữ bản cũ, nguyên tắc §1.5).`
              : "Bản mới KHÔNG lên serving (valAcc thấp hơn bản đang phục vụ) — giữ bản cũ.";
        }
      }

      // F-MLP-01 (fixbug FB-4B): arch THẬT đã áp dụng từ response — trader
      // nhìn toast biết ngay train bằng arch nào (bản lưu, không phải nháp).
      const appliedArch =
        typeof res.appliedTuning?.arch === "string" ? res.appliedTuning.arch : null;

      const title =
        valAccPct != null && episodes != null
          ? `Đã huấn luyện MLP (valAcc ${valAccPct}) + Q-learning (${episodes} episodes)${secs ? ` trong ${secs}` : ""}`
          : valAccPct != null
            ? `Đã huấn luyện MLP (valAcc ${valAccPct})${secs ? ` trong ${secs}` : ""}`
            : episodes != null
              ? `Đã huấn luyện Q-learning (${episodes} episodes)${secs ? ` trong ${secs}` : ""}`
              : `Đã huấn luyện mô hình học máy${secs ? ` trong ${secs}` : ""}`;

      toast.success(title, {
        description:
          [
            trained.length > 0 ? `Mục tiêu: ${trained.join(", ")}` : null,
            appliedArch != null ? `Arch đã áp dụng: ${appliedArch}` : null,
            notServing,
          ]
            .filter((part): part is string => part != null)
            .join(" · ") || undefined,
      });
    },
    onError: (err: Error) => {
      toast.error(err.message || "Không huấn luyện được mô hình.");
    },
  });
}
