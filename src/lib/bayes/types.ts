/**
 * src/lib/bayes/types.ts — KIỂU NỘI BỘ của Bộ tổng hợp Bayes (phiên #34).
 *
 * KHÔNG sửa src/lib/types.ts (hợp đồng READ-ONLY) — mọi kiểu công khai
 * (MarketAssessmentView, BayesDriver, SymbolAssessment…) đã được import từ
 * đó. File này chỉ định nghĩa bằng chứng / đầu vào của engine.
 */

import type { MarketAssessmentView, RiskQuantView } from "@/lib/types";

/** Hướng quan điểm mà một bằng chứng ủng hộ. */
export type EvidenceDirection = "UP" | "DOWN" | "FLAT";

/**
 * MỘT bằng chứng nhân quả — đóng góp vào log-odds posterior.
 *  - likelihoodRatio (LR) > 0; LR = 1 là vô thông tin; LR > 1 ủng hộ direction.
 *    Được kẹp vào [0.5, 3.0] trong engine.
 *  - weight ∈ 0..1 (độ tin cậy nguồn), kẹp [0.3, 1.0].
 *  - Δlog-odds đóng góp = weight × ln(LR) theo direction.
 */
export interface BayesEvidence {
  /** Nguồn phát sinh, vd "market-breadth" | "news-lexicon" | "feature-store.rsi". */
  source: string;
  /** Tên agent chịu trách nhiệm (hiển thị drivers). */
  agentName: string;
  /** Mã thành phần Gen-1 của agent (A2/A4/A15/S2…). */
  gen1: string;
  /** Bậc nhân quả: thị trường hay cổ phiếu. */
  level: "market" | "symbol";
  /** Bắt buộc với level = "symbol". */
  symbol?: string;
  direction: EvidenceDirection;
  likelihoodRatio: number;
  weight: number;
  /** Ghi chú ngắn con số nền tảng (hiển thị narrative + UI). */
  note: string;
}

/** Bằng chứng cấp cổ phiếu (Bậc 3). */
export interface SymbolEvidence extends BayesEvidence {
  level: "symbol";
  symbol: string;
}

/** Phiếu quan điểm có trọng số của một agent (dùng đo DISAGREEMENT + cổng B9). */
export interface AgentVote {
  /** Agent code, vd "market-analyst" | "ml-forecast" (cử tri thứ 6 — B7). */
  code: string;
  agentName: string;
  gen1: string;
  direction: EvidenceDirection;
  /** 0..1 — độ tự tin của agent trong assessment. */
  confidence: number;
  /** 0..1 — tỉ lệ run COMPLETED lịch sử của agent (đo từ AgentRun). */
  successRate: number;
  /** B9 — trọng số tally cổng đồng thuận = clamp(healthScore/100 × posteriorMean
   *  bandit, 0.3, 1) — TRÙNG công thức weight bằng chứng llm-vote (evidence.ts điền). */
  weight?: number;
  /** F-07 (#129) — vector giọng nói tại thời điểm cast (chỉ ml-forecast:
   *  {pUp, pDown, pFlat, z, score, weightsSource}) — bandit settle chép vào
   *  BanditEvent.meta làm input cho ensemble-learn meta-learner. */
  meta?: Record<string, unknown>;
}

/** Tiên nghiệm base-rate lịch sử (Bậc 0). */
export interface BayesPrior {
  pUp: number;
  pDown: number;
  pFlat: number;
  baseRateNote: string;
}

/** Trạng thái VETO của Ủy ban Kiểm soát (truyền từ chu kỳ vào synthesis). */
export interface BayesVeto {
  blocked: boolean;
  reason: string | null;
}

/** Số liệu nền một mã (đưa thẳng vào SymbolAssessment sau posterior). */
export interface SymbolFeature {
  symbol: string;
  name: string;
  sector: string;
  last: number;
  changePct: number;
  zScore: number | null;
  rsi14: number | null;
  momentum5d: number | null;
  /** ADTV 20 phiên (₫) — vừa là trọng số forecast5d vừa là tiêu chí chọn top. */
  adtvVnd: number;
  /** Dự báo Holt 5 phiên (%) kèm CI80; null khi không đủ dữ liệu. */
  forecast: { horizonDays: number; expectedPct: number; lowPct: number; highPct: number } | null;
}

/** Số liệu nền thị trường (khối `market` của MarketAssessmentView). */
export interface MarketFeature {
  advancing: number;
  declining: number;
  unchanged: number;
  /** Chế độ thị trường (label tiếng Việt từ classifyRegime). */
  regime: string;
  netForeignFlowVnd: number | null;
  newsSentimentScore: number | null;
  /** Breadth = (tăng − giảm) / tổng, −1..+1. */
  breadth: number;
}

/** Số liệu nền một nhóm ngành (Bậc 2). */
export interface SectorFeature {
  sector: string;
  symbolCount: number;
  /** Momentum 5 phiên trung bình của các mã trong ngành (%). */
  avgMomentum5d: number;
}

/** B5 — đầu vào posterior RIÊNG của một phân đoạn thị trường (§3.4). */
export interface SegmentInput {
  /** "VN-HOSE-STOCK" | "VN-HNX-STOCK" | "VN-UPCOM-STOCK" | "VN-ETF" | "VN-INDEX" | "INTERNATIONAL". */
  segment: string;
  /** Nhãn tiếng Việt. */
  label: string;
  /** Số mã có dữ liệu trong rổ segment. */
  symbolCount: number;
  /** Tiên nghiệm base-rate đo từ chuỗi rổ segment đó. */
  prior: BayesPrior;
  /** Bằng chứng Bậc 1 RIÊNG của segment (breadth/Holt/RSI segment…). */
  evidence: BayesEvidence[];
  /** Trọng số composite: ADTV VND thật (stock/ETF) · 0,05×số index · 0 khi rỗng.
   *  INTERNATIONAL = 0 (tham khảo, KHÔNG vào composite VN — B13). */
  compositeWeight: number;
}

/** Dữ liệu hiển thị/phụ — engine đọc để lắp MarketAssessmentView. */
export interface SynthesisContext {
  market: MarketFeature;
  /** Top thanh khoản (sắp theo ADTV giảm dần). */
  symbols: SymbolFeature[];
  sectors: SectorFeature[];
}

/** Đầu vào đầy đủ của Bộ tổng hợp Bayes. */
export interface SynthesisInput {
  prior: BayesPrior;
  /** Bằng chứng Bậc 1 (thị trường) — gồm cả phiếu assessment của LLM agents. */
  marketEvidence: BayesEvidence[];
  /** Bằng chứng Bậc 3 (cổ phiếu). */
  symbolEvidence: SymbolEvidence[];
  /** Phiếu agents (5 LLM + ml-forecast) — DISAGREEMENT + cổng đồng thuận B9. */
  agentVotes: AgentVote[];
  veto: BayesVeto;
  /** B5 — đầu vào per-segment cho posterior phân đoạn + composite VN. */
  segments?: SegmentInput[];
  /** B9 — AppSetting consensus.enforce (false = shadow-mode: cổng tính nhưng KHÔNG chặn). */
  consensusEnforce?: boolean;
  /** Phiên #51 — CRB: khối quant Ủy ban Kiểm soát Định lượng (lưu detail.riskQuant). */
  riskQuant?: RiskQuantView | null;
  /** Số liệu nền cho khối hiển thị (market/sectors/symbols). */
  context: SynthesisContext;
}

/** Đầu ra engine — khớp 100% MarketAssessmentView (id/createdAt do persist điền). */
export type SynthesisOutput = MarketAssessmentView;
