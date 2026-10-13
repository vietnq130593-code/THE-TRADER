/**
 * src/lib/agent-roster.ts — DANH SÁCH 23 AGENTS của The Trader.
 *
 * Mở rộng từ pipeline 5 agent (Gen-2) lên kiến trúc 23 thành phần Gen-1
 * (DESIGN.md §4.1 — 4 dịch vụ S + 19 agent A), giữ nguyên 5 agent pipeline
 * hiện có làm lõi ra quyết định:
 *
 *   ── NHÓM 1 · research (5) — Hội đồng Nghiên cứu ──────────────────────
 *      market-analyst (A2) · fair-value (A3) · news-sentiment (A4) ·
 *      liquidity (A5) · ml-forecast (A15)
 *   ── NHÓM 2 · control (3) — Ủy ban Kiểm soát (quyền VETO) ─────────────
 *      risk-manager (A6) · exposure (A7) · compliance (A8)
 *   ── NHÓM 3 · executive (4) — Ban Điều hành & Thực thi ────────────────
 *      portfolio-strategist (A1, Chủ tịch) · execution-manager (A10) ·
 *      settlement (A11) · cash-management (A12)
 *   ── NHÓM 4 · platform (4) — Nền tảng Dữ liệu ─────────────────────────
 *      data-collector (S0) · notification-officer (S1) ·
 *      feature-store (S2) · data-integrity (A9)
 *   ── NHÓM 5 · ml (7) — Phòng Học máy ──────────────────────────────────
 *      learning-rag (A13) · backtest (A14) · rl-gym (S3) ·
 *      rl-policy (A16) · dl-trainer (A17) · rl-trainer (A18) ·
 *      model-registry (A19)
 *
 * `kind`:
 *  - "llm"     — chu kỳ gọi model LLM (space-bunny-free qua Opencode Zen,
 *                hoặc GLM-4.6 trong sandbox) → prompt trong agent-context.ts
 *  - "service" — chạy deterministic từ DB (0 chi phí LLM, ~1-2s) →
 *                hàm trong agent-service-runs.ts
 *
 * File này là THUẦN DỮ LIỆU (không import gì) — dùng chung bởi:
 * prisma/seed.ts · prisma/expand-agents.ts · API routes · UI.
 */

export type AgentGroup = "research" | "control" | "executive" | "platform" | "ml";

export type AgentKind = "llm" | "service";

export interface RosterEntry {
  /** Slug duy nhất — khóa `Agent.code` trong DB. */
  code: string;
  /** Tên hiển thị. */
  name: string;
  /** Giá trị enum AgentRole trong DB. */
  role: string;
  /** Nhóm điều phối chu kỳ + hiển thị UI. */
  group: AgentGroup;
  /** Cách chạy trong chu kỳ: LLM hay dịch vụ deterministic. */
  kind: AgentKind;
  /** Mã thành phần kiến trúc Gen-1 (A1–A19, S0–S3). */
  gen1: string;
  /** Chức danh ngắn hiển thị dưới tên (UI). */
  title: string;
  /** Mô tả đầy đủ. */
  description: string;
  /** Config JSON mặc định (Agent.config). */
  config: Record<string, unknown>;
}

export const AGENT_GROUPS: {
  id: AgentGroup;
  label: string;
  description: string;
}[] = [
  {
    id: "research",
    label: "Hội đồng Nghiên cứu",
    description: "Các nhà phân tích chuyên sâu cung cấp tín hiệu đầu vào cho Chủ tịch",
  },
  {
    id: "control",
    label: "Ủy ban Kiểm soát",
    description: "Giữ quyền VETO — rủi ro, phơi nhiễm, tuân thủ",
  },
  {
    id: "executive",
    label: "Ban Điều hành",
    description: "Tổng hợp, ra tín hiệu và thực thi sau phê duyệt",
  },
  {
    id: "platform",
    label: "Nền tảng Dữ liệu",
    description: "Thu thập, chuẩn hoá và kiểm định chất lượng dữ liệu",
  },
  {
    id: "ml",
    label: "Phòng Học máy",
    description: "Backtest, dự báo, môi trường giả lập & vòng đời mô hình",
  },
];

export const AGENT_ROSTER: RosterEntry[] = [
  // ══════════════ NHÓM 1 · research — Hội đồng Nghiên cứu (5) ══════════════
  {
    code: "market-analyst",
    name: "Market Analyst",
    role: "MARKET_ANALYST",
    group: "research",
    kind: "llm",
    gen1: "A2",
    title: "Scanner thị trường",
    description:
      "Phân tích kỹ thuật & vi mô: xu hướng giá, khối lượng, động lượng, hỗ trợ/kháng cự trên dữ liệu OHLCV của HOSE/HNX.",
    config: { lookbackDays: 90, indicators: ["SMA20", "SMA50", "RSI14", "MACD", "BOLL"], weight: 0.35 },
  },
  {
    code: "fair-value",
    name: "Fair Value Analyst",
    role: "FAIR_VALUE",
    group: "research",
    kind: "llm",
    gen1: "A3",
    title: "Định giá hợp lý",
    description:
      "Định giá hợp lý từng mã theo dải giá lịch sử 90 phiên (z-price band, tương quan SMA) và cảnh báo lệch giá lớn nhất.",
    config: { bandDays: 90, zThreshold: 1.5, weight: 0.15 },
  },
  {
    code: "news-sentiment",
    name: "News & Sentiment",
    role: "NEWS_SENTIMENT",
    group: "research",
    kind: "llm",
    gen1: "A4",
    title: "Cảm xúc thị trường",
    description:
      "Đọc tin tức tài chính Việt Nam & quốc tế, chấm điểm cảm xúc (bullish/bearish/neutral) và cảnh báo sự kiện bất thường.",
    config: { sources: ["cafef", "vneconomy", "reuters"], languages: ["vi", "en"], weight: 0.2 },
  },
  {
    code: "liquidity",
    name: "Liquidity Analyst",
    role: "LIQUIDITY",
    group: "research",
    kind: "llm",
    gen1: "A5",
    title: "Thanh khoản",
    description:
      "Phân tích thanh khoản giao dịch: KL/TL trung bình, chênh lệch bid-ask, dòng khối ngoại và khả năng hấp thụ lệnh lớn.",
    config: { avgWindow: 20, minAdtvShares: 300000, weight: 0.1 },
  },
  {
    code: "ml-forecast",
    name: "ML Forecast",
    role: "ML_FORECAST",
    group: "research",
    kind: "service",
    gen1: "A15",
    title: "Dự báo ML",
    description:
      "Mô hình dự báo xu hướng ngắn hạn 5 phiên bằng hồi quy tuyến tính trên chuỗi đóng cửa — chạy dịch vụ, không tốn LLM.",
    config: { horizonDays: 5, lookbackDays: 30, topN: 5 },
  },

  // ══════════════ NHÓM 2 · control — Ủy ban Kiểm soát (3, VETO) ══════════════
  {
    code: "risk-manager",
    name: "Risk Manager",
    role: "RISK_MANAGER",
    group: "control",
    kind: "llm",
    gen1: "A6",
    title: "Rủi ro danh mục · VETO",
    description:
      "Giám sát giới hạn rủi ro: drawdown danh mục, tỷ trọng ngành, bet sizing, stop-loss và tuân thủ quy định giao dịch.",
    config: { maxDrawdownPct: 15, maxSectorWeightPct: 40, maxPositionPct: 25, dailyLossLimitVnd: 50000000 },
  },
  {
    code: "exposure",
    name: "Exposure Officer",
    role: "EXPOSURE",
    group: "control",
    kind: "service",
    gen1: "A7",
    title: "Phơi nhiễm · VETO",
    description:
      "Kiểm tra phơi nhiễm danh mục theo ngành và mã riêng lẻ so hạn mức — dịch vụ deterministic, giữ quyền VETO.",
    config: { maxSectorWeightPct: 40, maxPositionPct: 25 },
  },
  {
    code: "compliance",
    name: "Compliance Officer",
    role: "COMPLIANCE",
    group: "control",
    kind: "service",
    gen1: "A8",
    title: "Tuân thủ · VETO",
    description:
      "Đối chiếu chế độ giao dịch (paper/live), phiên thị trường và biên margin trước khi tín hiệu được trình duyệt.",
    config: { requireApproval: true, marginRoomMinVnd: 0 },
  },

  // ══════════════ NHÓM 3 · executive — Ban Điều hành (4) ══════════════
  {
    code: "portfolio-strategist",
    name: "Portfolio Strategist",
    role: "PORTFOLIO_STRATEGIST",
    group: "executive",
    kind: "llm",
    gen1: "A1",
    title: "Chủ tịch Hội đồng",
    description:
      "Tổng hợp tín hiệu từ toàn bộ Hội đồng Nghiên cứu & Ủy ban Kiểm soát, phân bổ danh mục theo phong cách cân bằng rủi ro-lợi nhuận.",
    config: { targetPositions: 8, rebalanceThresholdPct: 5, style: "balanced", council: "23-agent" },
  },
  {
    code: "execution-manager",
    name: "Execution Manager",
    role: "EXECUTION_MANAGER",
    group: "executive",
    kind: "service",
    gen1: "A10",
    title: "Thực thi lệnh",
    description:
      "Ghi nhận tín hiệu chờ phê duyệt, thực thi lệnh qua API VNDIRECT khi được duyệt: tách lệnh (TWAP/VWAP), theo dõi khớp và báo cáo sau giao dịch.",
    config: { sliceCount: 3, maxSlippagePct: 0.5, orderType: "LIMIT" },
  },
  {
    code: "settlement",
    name: "Settlement Officer",
    role: "SETTLEMENT",
    group: "executive",
    kind: "service",
    gen1: "A11",
    title: "Thanh toán bù trừ",
    description:
      "Đối chiếu khớp lệnh, phí môi giới & thuế TNCN 0,1% trên giao dịch bán — báo cáo sau mỗi chu kỳ.",
    config: { taxSellPct: 0.1, feePct: 0.15 },
  },
  {
    code: "cash-management",
    name: "Cash Manager",
    role: "CASH_MANAGEMENT",
    group: "executive",
    kind: "service",
    gen1: "A12",
    title: "Quản lý dòng tiền",
    description:
      "Theo dõi số dư tiền mặt, biên margin và sức mua ước tính — đề xuất hạn mức cho lệnh tiếp theo.",
    config: { marginRoomMinVnd: 500000000, buyingPowerFactor: 0.5 },
  },

  // ══════════════ NHÓM 4 · platform — Nền tảng Dữ liệu (4) ══════════════
  {
    code: "data-collector",
    name: "Data Collector",
    role: "DATA_COLLECTOR",
    group: "platform",
    kind: "service",
    gen1: "S0",
    title: "Thu thập dữ liệu",
    description:
      "Đồng bộ báo giá realtime, nến lịch sử, tin tức RSS và dòng khối ngoại vào kho dữ liệu trung tâm.",
    config: { tickIntervalSec: 10, barsDays: 90, newsFeeds: 5 },
  },
  {
    code: "notification-officer",
    name: "Notification Officer",
    role: "NOTIFICATION_OFFICER",
    group: "platform",
    kind: "service",
    gen1: "S1",
    title: "Thông báo",
    description:
      "Tổng hợp tín hiệu chờ phê duyệt, cảnh báo rủi ro chưa xử lý và lỗi agent — bản tin ngắn mỗi chu kỳ.",
    config: { digestMaxItems: 5 },
  },
  {
    code: "feature-store",
    name: "Feature Store",
    role: "FEATURE_STORE",
    group: "platform",
    kind: "service",
    gen1: "S2",
    title: "Kho đặc trưng",
    description:
      "Tính toán & phục vụ đặc trưng giao dịch (SMA, RSI, KL/TL tương đối, động lượng 5 phiên) cho các agent nghiên cứu.",
    config: { features: ["SMA20", "SMA50", "RSI14", "VOLRATIO20", "MOM5"], topN: 10 },
  },
  {
    code: "data-integrity",
    name: "Data Integrity",
    role: "DATA_INTEGRITY",
    group: "platform",
    kind: "service",
    gen1: "A9",
    title: "Toàn vẹn dữ liệu",
    description:
      "Kiểm định độ tươi & độ phủ dữ liệu: tuổi báo giá, số phiên nến, độ trễ tin tức — cảnh báo stale trước khi agent phân tích.",
    config: { quoteMaxAgeMin: 30, barsExpected: 90, newsMaxAgeH: 24 },
  },

  // ══════════════ NHÓM 5 · ml — Phòng Học máy (7) ══════════════
  {
    code: "learning-rag",
    name: "Learning & RAG",
    role: "LEARNING_RAG",
    group: "ml",
    kind: "service",
    gen1: "A13",
    title: "Học tích luỹ",
    description:
      "Tích luỹ ký ức phân tích: lưu trữ tin broadcast của cả đội làm ngữ cảnh truy hồi (RAG) cho các chu kỳ sau.",
    config: { memoryWindow: 500, retrievalTopK: 8 },
  },
  {
    code: "backtest",
    name: "Backtest Officer",
    role: "BACKTEST",
    group: "ml",
    kind: "service",
    gen1: "A14",
    title: "Kiểm định lịch sử",
    description:
      "Đo hiệu quả chiến lược tham chiếu trên 90 phiên: lợi nhuận, độ biến động, drawdown tối đa của rổ VN30.",
    config: { lookbackDays: 90, strategy: "equal-weight-hold" },
  },
  {
    code: "rl-gym",
    name: "RL Gym",
    role: "RL_GYM",
    group: "ml",
    kind: "service",
    gen1: "S3",
    title: "Môi trường giả lập",
    description:
      "Vận hành môi trường giả lập giao dịch (gym) trên dữ liệu lịch sử — nơi huấn luyện & đánh giá chính sách RL an toàn.",
    config: { episodes: 0, stateFeatures: 12, actionSpace: ["buy", "hold", "sell"] },
  },
  {
    code: "rl-policy",
    name: "RL Policy",
    role: "RL_POLICY",
    group: "ml",
    kind: "service",
    gen1: "A16",
    title: "Chính sách RL",
    description:
      "Theo dõi trạng thái chính sách RL đang phục vụ (epsilon khám phá, lần cập nhật cuối) và mức độ sẵn sàng triển khai.",
    config: { epsilon: 0.15, policyVersion: "v0" },
  },
  {
    code: "dl-trainer",
    name: "DL Trainer",
    role: "DL_TRAINER",
    group: "ml",
    kind: "service",
    gen1: "A17",
    title: "Huấn luyện DL",
    description:
      "Quản lý job huấn luyện mô hình học sâu (dự báo giá) — trạng thái, epoch, bước tiếp theo.",
    config: { activeJobs: 0, epochsPerRun: 50 },
  },
  {
    code: "rl-trainer",
    name: "RL Trainer",
    role: "RL_TRAINER",
    group: "ml",
    kind: "service",
    gen1: "A18",
    title: "Huấn luyện RL",
    description:
      "Quản lý vòng huấn luyện củng cố (số episode, phần thưởng tích luỹ) trong RL Gym trước khi lên bệ kiểm định.",
    config: { episodesPerRun: 100, rewardTarget: 0.0 },
  },
  {
    code: "model-registry",
    name: "Model Registry",
    role: "MODEL_REGISTRY",
    group: "ml",
    kind: "service",
    gen1: "A19",
    title: "Đăng ký mô hình",
    description:
      "Sổ đăng ký mô hình đang phục vụ: LLM backbone, bộ chỉ báo kỹ thuật và các mô hình dự báo — kèm phiên bản & trạng thái.",
    config: { registryVersion: "2025.1" },
  },
];

/** Map code → entry (tiện tra cứu). */
export const ROSTER_BY_CODE: ReadonlyMap<string, RosterEntry> = new Map(
  AGENT_ROSTER.map((a) => [a.code, a])
);

/** Danh sách code theo kind. */
export const LLM_AGENT_CODES = AGENT_ROSTER.filter((a) => a.kind === "llm").map((a) => a.code);
export const SERVICE_AGENT_CODES = AGENT_ROSTER.filter(
  (a) => a.kind === "service"
).map((a) => a.code);

/** Nhãn tiếng Việt cho role (API dùng cho roleLabel — import thay vì hardcode UI). */
export const ROLE_LABELS: Record<string, string> = {
  MARKET_ANALYST: "Phân tích thị trường",
  NEWS_SENTIMENT: "Tin tức & cảm xúc",
  RISK_MANAGER: "Quản trị rủi ro",
  PORTFOLIO_STRATEGIST: "Chiến lược danh mục",
  EXECUTION_MANAGER: "Thực thi lệnh",
  DATA_COLLECTOR: "Thu thập dữ liệu",
  NOTIFICATION_OFFICER: "Thông báo",
  FEATURE_STORE: "Kho đặc trưng",
  RL_GYM: "Môi trường giả lập",
  FAIR_VALUE: "Định giá hợp lý",
  LIQUIDITY: "Thanh khoản",
  EXPOSURE: "Phơi nhiễm danh mục",
  COMPLIANCE: "Tuân thủ",
  DATA_INTEGRITY: "Toàn vẹn dữ liệu",
  SETTLEMENT: "Thanh toán bù trừ",
  CASH_MANAGEMENT: "Quản lý dòng tiền",
  LEARNING_RAG: "Học tích luỹ",
  BACKTEST: "Kiểm định lịch sử",
  ML_FORECAST: "Dự báo ML",
  RL_POLICY: "Chính sách RL",
  DL_TRAINER: "Huấn luyện DL",
  RL_TRAINER: "Huấn luyện RL",
  MODEL_REGISTRY: "Đăng ký mô hình",
};

/** Nhãn tiếng Việt cho nhóm agent (UI + API groupLabel). */
export const GROUP_LABELS: Record<AgentGroup, string> = {
  research: "Hội đồng Nghiên cứu",
  control: "Ủy ban Kiểm soát · VETO",
  executive: "Ban Điều hành",
  platform: "Nền tảng Dữ liệu",
  ml: "Phòng Học máy",
};

/** F-1113-05 (fixbug #111 — dọn trùng lặp): thứ tự nhóm hiển thị MỘT nguồn,
 *  derive trực tiếp từ AGENT_GROUPS (không thể lệch) — thay 2 bản copy
 *  GROUP_ORDER rải ở agents-workspace.tsx + agent-system-brief.tsx. */
export const AGENT_GROUP_ORDER: readonly AgentGroup[] = AGENT_GROUPS.map((g) => g.id);
