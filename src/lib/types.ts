/** Shared API payload types (JSON over the wire — all BigInt already Number). */

export interface QuoteRow {
  symbol: string;
  name: string;
  sector: string;
  market: string;
  /** B13 — loại tài sản (STOCK/ETF/INDEX…) để group bảng giá theo sàn/loại. */
  type: string;
  /** B13 — đơn vị hiển thị (VND/USD/HKD) — index điểm, QT cents (UnitSpec §3.2). */
  currency: string;
  last: number;
  /** PHASE3 B3 §5.2 — cao/thấp phiên hiện tại (cột mở rộng bảng giá). */
  high: number | null;
  low: number | null;
  change: number;
  changePct: number;
  volume: number;
  bidPrice: number | null;
  askPrice: number | null;
  bidVolume: number | null;
  askVolume: number | null;
  refPrice: number | null;
  ceilingPrice: number | null;
  floorPrice: number | null;
  tradedAt: string;
}

export interface MarketSummary {
  indexLevel: number;
  avgChangePct: number;
  advancing: number;
  declining: number;
  unchanged: number;
  count: number;
  totalVolume: number;
  totalValue: number;
  topGainer: { symbol: string; changePct: number; last: number } | null;
  topLoser: { symbol: string; changePct: number; last: number } | null;
}

export interface QuotesResponse {
  quotes: QuoteRow[];
  summary: MarketSummary;
  /** S4 stale marking — có từ Giai đoạn 2 */
  meta?: { mode: string; asOf: string };
}

export interface BarPoint {
  date: string; // yyyy-MM-dd
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  value: number;
  sma20: number | null;
}

export interface BarsResponse {
  symbol: string;
  name: string;
  days: number;
  last: number;
  change: number;
  changePct: number;
  bars: BarPoint[];
}

export interface PortfolioPosition {
  symbol: string;
  name: string;
  sector: string;
  quantity: number;
  avgPrice: number;
  last: number;
  refPrice: number | null;
  changePct: number;
  marketValue: number;
  costBasis: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  realizedPnl: number;
}

export interface PortfolioResponse {
  account: {
    broker: string;
    accountNumber: string;
    accountType: string;
    cashBalance: number;
    equity: number;
    marginUsed: number;
    currency: string;
    status: string;
  };
  positions: PortfolioPosition[];
  totals: {
    totalMarketValue: number;
    totalCostBasis: number;
    totalUnrealizedPnl: number;
    totalUnrealizedPnlPct: number;
    totalRealizedPnl: number;
    totalEquity: number;
    dayChangePct: number;
  };
}

export interface OrderRow {
  id: string;
  symbol: string;
  name: string;
  side: "BUY" | "SELL";
  type: string;
  quantity: number;
  price: number | null;
  filledQuantity: number;
  avgFillPrice: number | null;
  status: string;
  fee: number;
  note: string | null;
  createdAt: string;
  submittedAt: string | null;
  filledAt: string | null;
}

export interface TradeRow {
  id: string;
  symbol: string;
  name: string;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  value: number;
  fee: number;
  tax: number;
  executedAt: string;
}

export interface AgentTaskRow {
  id: string;
  agentCode: string;
  agentName: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  createdAt: string;
}

export interface AgentCard {
  id: string;
  code: string;
  name: string;
  role: string;
  roleLabel: string;
  /** Mở rộng 23 agents — nhóm điều phối & hiển thị (agent-roster.ts). */
  group: string;
  groupLabel: string;
  description: string;
  model: string;
  status: string;
  healthScore: number;
  lastRunAt: string | null;
  config: Record<string, unknown> | null;
  pendingTaskCount: number;
  lastRun: {
    taskStatus: string;
    startedAt: string;
    durationMs: number | null;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
  } | null;
  /** PHASE3 B2 §4.2 — stats chi phí/độ tin cậy mỗi agent. */
  stats: AgentStats;
}

/** PHASE3_BLUEPRINT §4.2 — thống kê vận hành mỗi agent (GET /api/agents). */
export interface AgentStats {
  runCount: number;
  /** COMPLETED / tổng run (0 khi chưa có run nào). */
  successRate: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
  lastError: string | null;
  /** Số tin chat 1-1 (broadcast=false) của agent. */
  chatCount: number;
}

/** Tổng chi phí AI cả đội (footer chip + workspace Đội Agent). */
export interface AgentsTotals {
  runCount: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
}

/** Provider LLM đang chạy — nguồn duy nhất cho chip/tooltip model trên UI. */
export interface LlmInfo {
  provider: "zai" | "opencode-zen";
  model: string;
  modelLabel: string;
  free: boolean;
  priceInMtOk: number;
  priceOutMtOk: number;
  runsOutsideSandbox: boolean;
}

export interface AgentsResponse {
  agents: AgentCard[];
  tasks: AgentTaskRow[];
  /** PHASE3 B2: tổng hợp chi phí AI toàn đội (§5.5 — chip chi phí AI). */
  totals: AgentsTotals;
  /** Provider LLM runtime (Opencode Zen space-bunny-free khi có key, GLM-4.6 trong sandbox). */
  llm: LlmInfo;
}

export interface AgentMessageRow {
  id: string;
  fromAgent: { code: string; name: string; role: string } | null;
  toAgent: { code: string; name: string } | null;
  broadcast: boolean;
  /** PHASE3 B2 §4.1 — AGENT | USER (chat 1-1 lưu từAgentId = agent sở hữu thread). */
  direction: "AGENT" | "USER";
  content: string;
  reasoning: string | null;
  sentiment: string | null;
  createdAt: string;
}

/** PHASE3_BLUEPRINT §4.2 — dòng AgentRun trong hồ sơ chi tiết agent. */
export interface AgentRunRow {
  id: string;
  taskStatus: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  error: string | null;
}

/** Tin chat 1-1 trong thread của agent (broadcast=false). */
export interface AgentChatMessageRow {
  id: string;
  direction: "AGENT" | "USER";
  content: string;
  createdAt: string;
}

/** PHASE3_BLUEPRINT §4.2 — GET /api/agents/[id] hồ sơ chi tiết. */
export interface AgentDetailResponse {
  agent: AgentCard;
  runs: AgentRunRow[];
  tasks: AgentTaskRow[];
  /** Thread chat 1-1 (broadcast=false, asc). */
  chat: AgentChatMessageRow[];
  /** 20 tin broadcast gần nhất (desc). */
  broadcastFeed: AgentMessageRow[];
  /** Tín hiệu mở của agent này (status ACTIVE). */
  signals: SignalRow[];
}

/** PHASE3_BLUEPRINT §4.3 — POST /api/agents/[id]/run (chạy riêng 1 agent). */
export interface AgentSingleRunResponse {
  agent: { id: string; code: string; name: string };
  message: {
    id: string;
    content: string;
    reasoning: string | null;
    sentiment: string | null;
  } | null;
  run: {
    id: string;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    durationMs: number | null;
    taskStatus: string;
  };
}

/** PHASE3_BLUEPRINT §4.4 — POST /api/agents/[id]/chat (chat trực tiếp). */
export interface AgentChatResponse {
  userMessage: AgentChatMessageRow;
  reply: AgentChatMessageRow | null;
  run: {
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    durationMs: number | null;
  } | null;
  threadLength: number;
  /** Lỗi SDK → 200 kèm reply null + error VN (tin user đã lưu không mất). */
  error?: string;
}

/** PHASE3_BLUEPRINT §4.5 — POST /api/signals/[id]/decision. */
export interface SignalDecisionResponse {
  signal: SignalRow;
  /** Chỉ có khi APPROVE thành công. */
  order: {
    id: string;
    symbol: string;
    side: "BUY" | "SELL";
    quantity: number;
    price: number | null;
    status: string;
  } | null;
  /** E-P1-2 (fixbug #73): đầy đủ Order con khi TWAP tách lát (mỗi con 1 plan). */
  orders?: Array<{
    id: string;
    symbol: string;
    side: "BUY" | "SELL";
    type: string;
    quantity: number;
    price: number | null;
    status: string;
    createdAt: string;
    plan?: string;
  }>;
  /** E-P1-2: mô tả quyết định tách — null/undefined khi SINGLE. */
  twap?: {
    style: "TWAP";
    sliceCount: number;
    totalQuantity: number;
    adtvVnd: number;
    notionalPctAdtv: number;
    triggerPct: number;
  } | null;
}

export interface AgentRunResult {
  id: string;
  taskStatus: string;
  durationMs: number | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  error: string | null;
}

/** Response of the full multi-agent cycle — POST /api/agents/run (blueprint §5.2).
 *  Mở rộng 23 agents: thêm `waves` tổng kết các đợt đã chạy. */
export interface RunCycleResponse {
  runId: string | null;
  messages: AgentMessageRow[];
  signals: {
    id: string;
    symbol: string;
    direction: "BUY" | "SELL" | "HOLD";
    score: number;
    confidence: string;
    rationale: string;
    targetPrice: number | null;
    stopLoss: number | null;
    takeProfit: number | null;
    expiresAt: string | null;
  }[];
  order: {
    id: string;
    symbol: string;
    side: "BUY" | "SELL";
    quantity: number;
    price: number | null;
    status: string;
  } | null;
  failures: string[];
  durationMs: number;
  /** Mở rộng 23 agents — tổng kết các đợt chu kỳ. */
  waves?: {
    architecture: string;
    agentsRan: number;
    platform: number;
    researchAndMl: number;
    control: number;
    executive: number;
  };
  /** Phiên #34 — tóm tắt Bộ tổng hợp Bayes chạy giữa Ủy ban Kiểm soát và Chủ tịch. */
  assessment?: CycleAssessmentSummary | null;
}

/** Back-compat alias (older single-agent response shape). */
export type RunAgentResponse = RunCycleResponse;

export interface WatchlistResponse {
  watchlist: {
    id: string;
    name: string;
    isDefault: boolean;
    count: number;
    quotes: QuoteRow[];
  };
}

export interface SignalRow {
  id: string;
  symbol: string;
  name: string;
  direction: "BUY" | "SELL" | "HOLD";
  confidence: string;
  score: number;
  rationale: string;
  targetPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  agentName: string | null;
  agentCode: string | null;
  actedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  /** PHASE3 B2 §4.1 — ACTIVE | ACTED | REJECTED | EXPIRED. */
  status: string;
  rejectedAt: string | null;
  rejectNote: string | null;
}

export interface RiskAlertRow {
  id: string;
  severity: string;
  code: string;
  message: string;
  metricKey: string | null;
  metricValue: number | null;
  threshold: number | null;
  createdAt: string;
}

/* ═══════════════ Giai đoạn 2 (S4/S5/S6 + realtime) ═══════════════ */

export interface NewsItemRow {
  id: string;
  title: string;
  summary: string | null;
  url: string;
  source: string;
  category: string | null;
  publishedAt: string;
  fetchedAt: string;
}

/** P2-2/#62 — độ tin cậy tích luỹ per-feed (tỉ lệ parse lỗi/tin trùng). */
export interface FeedReliabilityRow {
  runs: number;
  okRuns: number;
  itemsSeen: number;
  parsed: number;
  parseSkipped: number;
  duplicates: number;
  added: number;
  updated: number;
  lastOkAt: string | null;
  lastError: string | null;
}

export interface NewsResponse {
  items: NewsItemRow[];
  meta: {
    total: number;
    mode: string;
    lastSuccessAt: string | null;
    stale: boolean;
    ageMinutes: number | null;
    providers: string[];
    /** P2-2 — reliability tích luỹ per-feed. */
    reliability: Record<string, FeedReliabilityRow>;
    /** P2-2 — kết quả lần crawl cuối (per-feed items/skipped/duplicates). */
    feeds: {
      name: string;
      ok: boolean;
      items: number;
      skipped?: number;
      duplicates?: number;
    }[];
  };
}

export interface NewsIngestResponse {
  added: number;
  updated: number;
  total: number;
  mode: string;
  feeds: {
    name: string;
    ok: boolean;
    items: number;
    error?: string;
    skipped?: number;
    duplicates?: number;
  }[];
  ingestedAt: string;
  /** P2-2 — reliability sau lần chạy này. */
  reliability?: Record<string, FeedReliabilityRow>;
}

export interface FlowsItem {
  symbol: string;
  netValue: number;
}

export interface FlowsResponse {
  mode: string;
  asOf: string;
  totalNet: number;
  totalBuy: number;
  totalSell: number;
  topNet: FlowsItem[];
  topSell: FlowsItem[];
  note: string;
}

export interface SourceStatusUI {
  key: string;
  label: string;
  mode: string;
  stale: boolean;
  ageMinutes: number | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  providers: string[];
  updatedAt: string;
}

export interface SystemStatusResponse {
  sources: SourceStatusUI[];
  trading: {
    live: boolean;
    configured: boolean;
    mode: string;
    label: string;
  };
  market: {
    phase: string;
    phaseLabel: string;
    inSession: boolean;
    strictSession: boolean;
  };
  counts: {
    news: number;
    signals: number;
    orders: number;
    agentMessages: number;
  };
  escalatedAlerts: number;
  serverTime: string;
}

export interface WatchlistToggleResponse {
  symbol: string;
  inWatchlist: boolean;
  count: number;
}

/* ═══════════════ Phiên #34 — Module Cài đặt + Bộ tổng hợp Bayes ═══════════════ */

/** Chế độ nguồn dữ liệu thị trường (env MARKET_DATA_MODE có thể bị AppSetting ghi đè). */
export type MarketDataMode = "real-eod" | "realtime-vndirect" | "simulated";

/** GET /api/settings — secrets đã mask (4 ký tự đầu + ····). */
export interface VndirectSettings {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accountNumber: string;
  /** Đã nhập đủ credential để bật realtime chưa. */
  configured: boolean;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
}

/** P2-1/#62 — kênh thông báo S1 (webhook/email, pending-egress). */
export interface NotifySettingsView {
  enabled: boolean;
  webhookUrl: string;
  emailTo: string;
  pendingCount: number;
  sentCount: number;
  lastSentAt: string | null;
}

/** P2-4/#62 — lịch nghỉ lễ VN: overlay runtime + ngày lễ sắp tới. */
export interface VnHolidaysView {
  extra: string[];
  remove: string[];
  upcoming: { date: string; name: string; source: "static" | "overlay-extra" }[];
}

export interface SettingsResponse {
  vndirect: VndirectSettings;
  marketData: {
    mode: MarketDataMode;
    /** Mode thực tế sau fallback (vd: realtime-vndirect nhưng credential hỏng → real-eod). */
    effectiveMode: MarketDataMode;
    strictSession: boolean;
    eodSyncAt: string;
    /** Lần fetch realtime cuối có OK không (null = chưa từng fetch). */
    realtimeOk: boolean | null;
    lastRealtimeAt: string | null;
  };
  /** P2-1 — kênh thông báo S1 + trạng thái outbox. */
  notify: NotifySettingsView;
  /** P2-4 — lịch nghỉ lễ VN (overlay + sắp tới). */
  vnHolidays: VnHolidaysView;
  llm: LlmInfo;
  risk: {
    maxSectorWeightPct: number;
    maxPositionPct: number;
    maxDrawdownPct: number;
    /** Fixbug #52-F5 — trạng thái Beta CRB-7 cho UI Cài đặt (nút reset). */
    riskQuantLimits: RiskQuantLimitView[];
  };
  bayes: {
    enabled: boolean;
    lastAssessmentAt: string | null;
  };
  updatedAt: string;
}

/** PUT /api/settings — trường nào omit thì giữ nguyên; chuỗi rỗng "" nghĩa là xoá. */
export interface UpdateSettingsPayload {
  vndirect?: {
    consumerKey?: string;
    consumerSecret?: string;
    accessToken?: string;
    accountNumber?: string;
  };
  marketData?: { mode?: MarketDataMode };
  /** P2-1/#62 — cấu hình kênh thông báo S1 (webhook/email). */
  notify?: {
    enabled?: boolean;
    webhookUrl?: string;
    emailTo?: string;
  };
  /** P2-4/#62 — overlay lịch nghỉ lễ VN (mảng truyền thì thay, omit giữ). */
  vnHolidays?: {
    extra?: string[];
    remove?: string[];
  };
  /** Phiên #51 — CRB-7: reset Beta limit-learning về prior Beta(1,99) (ghi AuditLog). */
  riskQuantReset?: boolean;
}

/** POST /api/settings/test — kiểm tra kết nối VNDIRECT (dùng creds vừa nhập hoặc đã lưu). */
export interface SettingsTestResponse {
  ok: boolean;
  message: string;
  details: {
    authTried: boolean;
    authOk: boolean;
    authMessage: string | null;
    finfoOk: boolean;
    finfoMessage: string | null;
    latencyMs: number;
    sampleQuote: { symbol: string; last: number; changePct: number } | null;
  };
}

/**
 * Fixbug #52-F5 — trạng thái 1 giới hạn CRB-7 (Beta-Bernoulli posterior vi
 * phạm) hiển thị ở Cài đặt + phục vụ nút reset về prior Beta(1,99).
 */
export interface RiskQuantLimitView {
  key: "sector" | "position" | "dd" | "dailyLoss";
  /** α = số lần vi phạm quan sát + prior 1. */
  alpha: number;
  /** β = số lần KHÔNG vi phạm quan sát + prior 99. */
  beta: number;
  /** Posterior mean Beta(α+1, β+1) — P(vi phạm) ước lượng. */
  posteriorMean: number;
  /** Hệ số siết một chiều mult_ℓ ∈ [0,75 · 1] (CRB-7). */
  mult: number;
}

/** Một bằng chứng trong mô hình nhân quả Bayes — đóng góp vào log-odds posterior. */
export interface BayesDriver {
  /** Nguồn phát sinh: "feature-store.rsi" | "news-lexicon" | "market-analyst" | "ml-forecast"… */
  source: string;
  agentName: string;
  gen1: string;
  /** Bậc nhân quả: thị trường hay cổ phiếu. */
  level: "market" | "symbol";
  symbol: string | null;
  direction: "UP" | "DOWN" | "FLAT";
  /** Độ tin cậy nguồn 0..1 (healthScore/successRate của agent hoặc confidence thuật toán). */
  weight: number;
  /** Likelihood ratio P(E|H)/P(E|¬H). */
  likelihoodRatio: number;
  /** Đóng góp vào log-odds = weight × ln(LR) — key sắp xếp drivers. */
  deltaLogOdds: number;
  note: string;
}

/** Dự đoán một mã sau bước nhân quả: thị trường → ngành → cổ phiếu. */
export interface SymbolAssessment {
  symbol: string;
  name: string;
  sector: string;
  last: number;
  changePct: number;
  pUp: number;
  pDown: number;
  pFlat: number;
  stance: "BUY" | "SELL" | "HOLD";
  zScore: number | null;
  rsi14: number | null;
  momentum5d: number | null;
  /** Dự báo định lượng (Holt) kèm khoảng tin cậy %. */
  forecast: {
    horizonDays: number;
    expectedPct: number;
    lowPct: number;
    highPct: number;
  } | null;
  drivers: string[];
}

/** Đơn vị giá lưu DB (Int) theo (market, instrumentType) — Bảng tra
 *  UnitSpec §3.2 MARKET_EXPANSION_BLUEPRINT là SINGLE SOURCE OF TRUTH:
 *  STOCK/ETF VN lưu VND nguyên (nguồn nghìn VND ×1000, bội 100) ·
 *  INDEX lưu điểm×100 (nguồn điểm thô ×100, KHÔNG round100, KHÔNG ×1000) ·
 *  STOCK/ETF QT lưu cents USD/HKD (nguồn thô ×100) · INDEX QT điểm×100 ·
 *  BOND (khi có nguồn) % mệnh giá ×100. */
export type UnitKind = "VND" | "INDEX_POINT" | "CENTS" | "BOND_PCT";

/** Quy tắc biến đổi giá của một tổ hợp (market × instrumentType). */
export interface UnitSpec {
  kind: UnitKind;
  /** Hệ số nhân khi ingest từ giá thô của nguồn (1000 | 100). */
  multiplier: number;
  /** Làm tròn bội số sau nhân (100 = bội 100₫ như Q1; 1 = nguyên). */
  roundTo: number;
  /** Cận giá hợp lệ SAU biến đổi — ngoài cận bị skip + đếm skipped. */
  minPrice: number;
  maxPrice: number;
  /** true = neo Quote có trần/sàn ±7% (chỉ STOCK/ETF VN); INDEX/quốc tế null. */
  hasPriceBand: boolean;
  /** Bước giá tối thiểu (đơn vị DB) tính spread quote (0,1 điểm index = 10). */
  tickUnit: number;
}

/** B5 — posterior một phân đoạn thị trường (multi-segment Bayes §3.4). */
export interface SegmentAssessment {
  /** "VN-HOSE-STOCK" | "VN-HNX-STOCK" | "VN-UPCOM-STOCK" | "VN-ETF" | "VN-INDEX" | "VN-COMPOSITE" | "INTERNATIONAL". */
  segment: string;
  /** Nhãn tiếng Việt hiển thị. */
  label: string;
  /** Số instrument có dữ liệu trong rổ segment. */
  symbolCount: number;
  pUp: number;
  pDown: number;
  pFlat: number;
  marketDirection: "BULLISH" | "BEARISH" | "NEUTRAL";
  /** Trọng số trong composite VN (ADTV thật; INDEX cố định 0,05/index; INTERNATIONAL = null). */
  compositeWeight: number | null;
  /** 1 dòng tổng hợp cho chairman prompt + UI. */
  note: string;
}

/** B9 — phiếu bầu trong tally cổng đồng thuận. */
export interface ConsensusVote {
  code: string;
  agentName: string;
  gen1: string;
  direction: "UP" | "DOWN" | "FLAT";
  /** w = clamp(healthScore/100 × posteriorMean bandit, 0.3, 1). */
  weight: number;
  /** "llm" = 5 agent nghiên cứu | "ml" = ml-forecast ensemble. */
  model: "llm" | "ml";
}

/** B9 — snapshot cổng đồng thuận 6 cử tri (lưu trong detail.consensus). */
export interface ConsensusSnapshot {
  /** consensusRatio = max_d S(d) / Σw (0..1). */
  ratio: number;
  /** CONSENSUS (≥0,80) | WEAK_MAJORITY ([0,50·0,80)) | NO_CONSENSUS (<0,50) | pool < 4 cử tri. */
  gate: "CONSENSUS" | "WEAK_MAJORITY" | "NO_CONSENSUS";
  /** Nhãn tiếng Việt hiển thị. */
  gateLabel: string;
  tally: ConsensusVote[];
  /** Số cử tri có mặt (pool < 4 → fail-safe NO_CONSENSUS). */
  present: number;
  /** Shadow-mode (consensus.enforce=false): cổng tính nhưng KHÔNG chặn. */
  shadow: boolean;
  /** true = nếu enforce thì tín hiệu direction ≠ hướng số đông sẽ bị chặn. */
  wouldBlock: boolean;
  /** Câu giải thích (narrative + chairman prompt). */
  note: string;
}

/**
 * Phiên #51 — CRB (CONTROL_RISK_QUANT_BLUEPRINT v1.1 §7): khối QUANT của
 * Ủy ban Kiểm soát Định lượng nhúng trong MarketAssessment.detail.riskQuant
 * (additive — row cũ không có → undefined, UI xử lý null).
 */
export interface RiskQuantView {
  proxyMode: boolean;
  volEwmaAnnPct: number;
  volRatio: number;
  /** Hệ số hạn mức HỢP NHẤT áp cho vị thế = dynMax/static (vol × learning,
   * kẹp [0,6 · 1,15]) — fixbug #52-F4 (trước đây là vol.mult thuần). */
  mult: number;
  dynMaxPositionPct: number;
  dynMaxSectorPct: number;
  staticMaxPositionPct: number;
  staticMaxSectorPct: number;
  var95Pct: number;
  cvar95Pct: number;
  var95Vnd: number;
  mcPDd: number;
  mcLoss5Pct: number;
  hhiSector: number;
  hhiPosition: number;
  effSectors: number;
  effBets: number;
  avgCorr: number;
  cusumS: number;
  cusumAlarm: boolean;
  pBreach5d: number | null;
  kellyHint: number | null;
  alerts: { severity: string; code: string; message: string }[];
  notes: string[];
}

/** Bộ tổng hợp Bayes — khung nhìn đầy đủ cho UI module Tổng hợp. */
export interface MarketAssessmentView {
  id: string;
  createdAt: string;
  source: "cycle" | "manual";
  cycleRunId: string | null;
  pUp: number;
  pDown: number;
  pFlat: number;
  marketDirection: "BULLISH" | "BEARISH" | "NEUTRAL";
  confidence: number;
  disagreement: number;
  evidenceCount: number;
  prior: {
    pUp: number;
    pDown: number;
    pFlat: number;
    baseRateNote: string;
  };
  /** Drivers sắp xếp theo |deltaLogOdds| giảm dần. */
  drivers: BayesDriver[];
  /** Bậc 2 — posterior theo nhóm ngành. */
  sectors: {
    sector: string;
    symbolCount: number;
    avgMomentum5d: number;
    pUp: number;
    stance: "UP" | "DOWN" | "FLAT";
  }[];
  /** Bậc 3 — posterior từng mã (top thanh khoản, sắp theo |pUp − pDown| giảm dần). */
  symbols: SymbolAssessment[];
  market: {
    advancing: number;
    declining: number;
    unchanged: number;
    regime: string;
    netForeignFlowVnd: number | null;
    newsSentimentScore: number | null;
    /** Breadth = (tăng − giảm) / tổng, −1..+1. */
    breadth: number;
  };
  /** Dự báo rổ 5 phiên (% expected + khoảng tin cậy). */
  forecast5d: { expectedPct: number; lowPct: number; highPct: number } | null;
  veto: { blocked: boolean; reason: string | null };
  /** Tường thuật tiếng Việt tự sinh từ posterior. */
  narrative: string;
  /** Các agent có bằng chứng được dùng trong lần tổng hợp này. */
  agentsConsidered: string[];
  /** B5 — posterior theo phân đoạn thị trường (6 segment + composite); undefined ở row cũ. */
  segments?: SegmentAssessment[];
  /** B9 — cổng đồng thuận 6 cử tri tại assessment này; null/undefined ở row cũ. */
  consensus?: ConsensusSnapshot | null;
  /** Phiên #51 — CRB: khối quant Ủy ban Kiểm soát Định lượng; null/undefined ở row cũ. */
  riskQuant?: RiskQuantView | null;
}

/** GET /api/assessment — bản mới nhất + lịch sử (30 bản gần nhất). */
export interface AssessmentResponse {
  assessment: MarketAssessmentView | null;
  history: {
    createdAt: string;
    pUp: number;
    pDown: number;
    pFlat: number;
    marketDirection: string;
    confidence: number;
  }[];
}

/** Tóm tắt assessment nhúng vào response chu kỳ POST /api/agents/run. */
export interface CycleAssessmentSummary {
  id: string;
  pUp: number;
  pDown: number;
  pFlat: number;
  marketDirection: string;
  confidence: number;
  disagreement: number;
  evidenceCount: number;
  narrative: string;
}
