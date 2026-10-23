/**
 * src/lib/bayes/evidence.ts — XÂY BỘ BẰNG CHỨNG TỪ DB (phiên #34 · mở rộng B5 #38).
 *
 * buildEvidenceBundle() đọc dữ liệu THẬT trong Supabase (215k bar EOD VNDIRECT
 * đa sàn HOSE/HNX/UPCOM/ETF/INDEX, quotes, NewsItem RSS, flows) và tính toàn bộ
 * bằng chứng 3 bậc + tiên nghiệm base-rate — deterministic, 0 LLM, ~1–2s.
 * KHÔNG tạo side-effect mới ngoài markSource của flows (idempotent).
 *
 * B5 — MULTI-SEGMENT (§3.4 MARKET_EXPANSION_BLUEPRINT): bộ bằng chứng được
 * PHÂN ĐOẠN theo 5 segment VN (HOSE-STOCK top-10 · HNX-STOCK top-5 ·
 * UPCOM-STOCK top-3 · ETF ≤10 · INDEX 4 mã) — mỗi segment có prior + bằng
 * chứng riêng; synthesis.ts chạy engine per-segment rồi hợp thành composite
 * trọng số (ADTV thật + INDEX 0,05/index). Phiếu LLM + lexicon tin + flows
 * (thị trường-wide) gán cho segment chính VN-HOSE-STOCK như §3.4.
 *
 * Chu kỳ 23 agents truyền llmVotes (assessment JSON mới của LLM research +
 * risk) → được ƯU TIÊN hơn tin broadcast 24h trong DB.
 *
 * Gán tác giả bằng chứng theo đúng mối: breadth/regime → Market Analyst (A2) ·
 * z-score dải giá → Fair Value Analyst (A3) · lexicon tin → News & Sentiment
 * (A4) · flows → Liquidity Analyst (A5) · Holt → ML Forecast (A15) · đặc trưng
 * kỹ thuật → Feature Store (S2) · prior base-rate → Backtest Officer (A14).
 */

import { db } from "@/lib/db";
import { ROSTER_BY_CODE } from "@/lib/agent-roster";
import { getForeignFlows } from "@/lib/flows";
import { getConsensusSetting } from "@/lib/consensus";
import { pctChange, rsi } from "@/lib/indicators";
import { classifyRegime } from "@/lib/quant/regime";
import { holtForecastPct } from "@/lib/quant/forecast";
// Task 176 — STATE_SPACE_BLUEPRINT Phase 1: driver holt-ss (A15b) bóng/live.
import {
  getSsShadowSetting,
  sdInflated,
  ssEvidenceDecision,
  zWeight,
  type SsEvidenceDecision,
  type SsShadowSetting,
} from "@/lib/ml/ss/shadow";
import { aggregateSentiment } from "@/lib/quant/sentiment";
import { historicalBaseRates, zscore } from "@/lib/quant/statistics";
import { loadSegmentBaskets, loadTopSeries, latestFeatureSnapshot, type SegmentBasket } from "@/lib/ml/features";
import { mlForecastEnsemble } from "@/lib/ml/ensemble";
// F-13 (#129): posterior contextual theo regime thị trường hiện tại.
import { posteriorByCodeForCycle } from "@/lib/ml/bandit";
import { buildBasket, parseQTable, policyStance } from "@/lib/ml/rl";
import type {
  AgentVote,
  BayesEvidence,
  BayesPrior,
  BayesVeto,
  MarketFeature,
  SegmentInput,
  SectorFeature,
  SymbolEvidence,
  SymbolFeature,
  SynthesisInput,
} from "@/lib/bayes/types";
/** 6 agent LLM có phiếu assessment: 5 nghiên cứu (kể cả A20 macro-economist #126) + risk-manager. */
export const LLM_VOTE_CODES = [
  "market-analyst",
  "fair-value",
  "news-sentiment",
  "liquidity",
  "macro-economist",
  "risk-manager",
] as const;

/** Phiếu LLM do chu kỳ truyền vào (assessment JSON mới nhất — ưu tiên). */
export interface LlmVoteInput {
  code: string;
  direction: "UP" | "DOWN" | "FLAT";
  confidence: number;
  evidence?: string[];
}

/** Tuỳ chọn build bundle. */
export interface BuildEvidenceOptions {
  /** Phiếu assessment của chu kỳ (nếu có — phủ dữ liệu DB 24h). */
  llmVotes?: LlmVoteInput[];
  /** Trạng thái VETO từ Ủy ban Kiểm soát của chu kỳ. */
  veto?: BayesVeto;
  /** Phiên #51 — CRB: bằng chứng quant của Ủy ban Kiểm soát Định lượng
   *  (source "quant-tail:*"/"quant-drift:*") — vào Bayes đúng MỘT lần với
   *  source riêng (T7.5 §0.6 — KHÔNG thêm cử tri thứ 7 cho cổng đồng thuận). */
  quantEvidence?: BayesEvidence[];
}

/** Số phiên lấy cho mỗi mã (base-rate 250 + biên an toàn). */
const BARS_PER_SYMBOL = 260;
/** Số phiên base-rate tiên nghiệm. */
const PRIOR_SESSIONS = 250;
/** Số mã xây bằng chứng symbol-level (top thanh khoản ADTV HOSE). */
const TOP_SYMBOL_COUNT = 10;
/** Số tin RSS tối đa chấm lexicon 24h. */
const NEWS_MAX_ITEMS = 60;
/** §3.4 — trọng số composite cố định cho mỗi index (không đo được ADTV VND). */
const INDEX_COMPOSITE_WEIGHT = 0.05;

/* ─────────────────────────── Hàm chính ─────────────────────────── */

/**
 * Đọc DB + tính toàn bộ đầu vào cho synthesizeMarketAssessment().
 * Không bao giờ ném lỗi do thiếu dữ liệu — chỉ bỏ bằng chứng thiếu nền tảng.
 */
export async function buildEvidenceBundle(
  options: BuildEvidenceOptions = {}
): Promise<SynthesisInput> {
  const veto: BayesVeto = options.veto ?? { blocked: false, reason: null };
  const marketEvidence: BayesEvidence[] = [];
  const symbolEvidence: SymbolEvidence[] = [];
  // Phiên #51 — CRB: bằng chứng quant vào segment chính VN-HOSE-STOCK (một
  // lần, source riêng — T7.5). Lọc chặt nguồn bắt đầu "quant-" để chống đếm
  // kép nếu caller truyền trùng.
  const quantEvidence = (options.quantEvidence ?? []).filter(
    (e) => typeof e.source === "string" && e.source.startsWith("quant-")
  );

  /* ── 1. Rổ 5 segment VN — load MỘT LẦN, phân đoạn in-memory (B5) ────── */
  const baskets = await loadSegmentBaskets(BARS_PER_SYMBOL);
  const hose = baskets.find((b) => b.segment === "VN-HOSE-STOCK") ?? emptyBasket("VN-HOSE-STOCK");
  const hnx = baskets.find((b) => b.segment === "VN-HNX-STOCK") ?? emptyBasket("VN-HNX-STOCK");
  const upcom = baskets.find((b) => b.segment === "VN-UPCOM-STOCK") ?? emptyBasket("VN-UPCOM-STOCK");
  const etf = baskets.find((b) => b.segment === "VN-ETF") ?? emptyBasket("VN-ETF");
  const idx = baskets.find((b) => b.segment === "VN-INDEX") ?? emptyBasket("VN-INDEX");

  // Segment chính HOSE-STOCK — continuation chuỗi lịch sử #34: mọi số liệu
  // breadth/regime/sectors/prior tính trên TOÀN BỘ HOSE-STOCK quoted (30 mã).
  const hoseQuoted = hose.quoted;
  const hoseBasket = hose.symbols;

  const advancing = hoseQuoted.filter((q) => q.changePct > 0).length;
  const declining = hoseQuoted.filter((q) => q.changePct < 0).length;
  const unchanged = hoseQuoted.filter((q) => q.changePct === 0).length;
  const totalQuoted = hoseQuoted.length;
  const breadth = totalQuoted > 0 ? (advancing - declining) / totalQuoted : 0;

  /* ── 2. TIÊN NGHIỆM BẬC 0 — base-rate 250 phiên thật (per-segment B5) ── */
  const prior = buildPrior(hoseQuoted.map((s) => s.closes), "HOSE");

  /* ── 3. BẰNG CHỨNG BẬC 1 · SEGMENT CHÍNH VN-HOSE-STOCK ──────────────── */

  // 3a. Breadth (tăng/giảm toàn rổ HOSE)
  if (totalQuoted >= 5 && breadth !== 0) {
    const lr = Math.min(2.2, Math.max(1, 1 + 0.6 * Math.abs(breadth)));
    marketEvidence.push({
      source: "market-breadth",
      agentName: "Market Analyst",
      gen1: "A2",
      level: "market",
      direction: breadth > 0 ? "UP" : "DOWN",
      likelihoodRatio: lr,
      weight: 0.7,
      note: `${advancing} mã tăng / ${declining} mã giảm HOSE (breadth ${(breadth >= 0 ? "+" : "") + breadth.toFixed(2)})`,
    });
  }

  // 3b. Lexicon cảm xúc tin tức 24h (thị trường-wide VN — gán HOSE segment §3.4)
  const since24h = new Date(Date.now() - 24 * 3_600_000);
  const newsItems = await db.newsItem.findMany({
    where: { publishedAt: { gte: since24h } },
    orderBy: { publishedAt: "desc" },
    take: NEWS_MAX_ITEMS,
    select: { title: true, summary: true },
  });
  const newsAgg = aggregateSentiment(newsItems);
  if (newsItems.length > 0 && Math.abs(newsAgg.score) > 0.05) {
    const lr = Math.min(2.5, Math.exp(1.1 * Math.abs(newsAgg.score)));
    marketEvidence.push({
      source: "news-lexicon",
      agentName: "News & Sentiment",
      gen1: "A4",
      level: "market",
      direction: newsAgg.score > 0 ? "UP" : "DOWN",
      likelihoodRatio: lr,
      weight: 0.6,
      note: `Lexicon ${newsItems.length} tin 24h: score ${(newsAgg.score >= 0 ? "+" : "") + newsAgg.score.toFixed(2)} (${newsAgg.bullishCount} tăng cảm tính / ${newsAgg.bearishCount} giảm cảm tính)`,
    });
  }

  // 3c. Dòng khối ngoại ròng (flows simulated — giảm trọng số tin cậy)
  const flows = await getForeignFlows().catch(() => null);
  const flowTotal = flows ? flows.totalBuy + flows.totalSell : 0;
  if (flows && flowTotal > 0 && flows.totalNet !== 0) {
    const ratio = Math.min(1, Math.abs(flows.totalNet) / flowTotal);
    const lr = Math.min(1.8, 1 + 0.8 * ratio);
    marketEvidence.push({
      source: "foreign-flows",
      agentName: "Liquidity Analyst",
      gen1: "A5",
      level: "market",
      direction: flows.totalNet > 0 ? "UP" : "DOWN",
      likelihoodRatio: lr,
      weight: 0.5,
      note: `Khối ngoại ròng ${(flows.totalNet >= 0 ? "+" : "") + (flows.totalNet / 1e9).toFixed(1)} tỷ ₫ (${flows.mode === "live" ? "nguồn ngoài" : "mô phỏng deterministic"})`,
    });
  }

  // 3d. Holt basket forecast + regime trên rổ top-10 HOSE equal-weight
  // STATE_SPACE_BLUEPRINT (Task 176 · SS-1 quy tắc 6): A15 heuristic giữ nguyên
  // khi A/B bóng holt-ss chưa thắng log-score 14 ngày; mode "live" (sau
  // SS_AB_VERDICT thắng) hoán đổi evidence sang A15b ml-forecast.holt-ss +
  // TẮT driver cũ (không dual-live — 2 driver cùng closes sống song song trong
  // Bayes = đếm kép thông tin trend). Kill-switch off ⇒ nguyên văn đường cũ.
  const basketCloses = buildBasketIndex(hoseBasket.map((s) => s.closes), PRIOR_SESSIONS);
  const ssSetting = await getSsShadowSetting();
  const ssSwapped = await pushHoltSsEvidence(marketEvidence, ssSetting, basketCloses);
  if (!ssSwapped) {
    const basketForecast = holtForecastPct(basketCloses, { horizon: 5 });
    if (basketForecast && Math.abs(basketForecast.expectedPct) >= 0.1) {
      const strength = Math.min(1, Math.abs(basketForecast.expectedPct) / 1.5);
      const lr = Math.min(1.9, 1 + 0.9 * strength);
      marketEvidence.push({
        source: "ml-forecast.holt-basket",
        agentName: "ML Forecast",
        gen1: "A15",
        level: "market",
        direction: basketForecast.expectedPct > 0 ? "UP" : "DOWN",
        likelihoodRatio: lr,
        weight: 0.65,
        note: `Holt rổ HOSE 5 phiên: ${(basketForecast.expectedPct >= 0 ? "+" : "") + basketForecast.expectedPct.toFixed(2)}% (CI80 ${basketForecast.lowPct.toFixed(2)}%…${basketForecast.highPct.toFixed(2)}%)`,
      });
    }
  }
  const regime = classifyRegime(basketCloses);
  if (regime.regime === "BULL_TREND" || regime.regime === "BEAR_TREND") {
    marketEvidence.push({
      source: "regime",
      agentName: "Market Analyst",
      gen1: "A2",
      level: "market",
      direction: regime.regime === "BULL_TREND" ? "UP" : "DOWN",
      likelihoodRatio: 1.5,
      weight: 0.6,
      note: `Chế độ ${regime.label} (SMA20 ${regime.sma20 != null ? Math.round(regime.sma20 * 100) / 100 : "—"} vs SMA50 ${regime.sma50 != null ? Math.round(regime.sma50 * 100) / 100 : "—"} của rổ HOSE)`,
    });
  }

  /* ── 3e. (phiên #51 — CRB) Bằng chứng quant Ủy ban Kiểm soát Định lượng ──
   * HS-CVaR/HHI/P(vi phạm)/CUSUM — vào segment chính MỘT LẦN với source
   * "quant-tail:*"/"quant-drift:*" riêng (T7.5 §0.6 — không trùng phiếu
   * llm-vote của 6 cử tri, không thêm cử tri thứ 7 cho cổng 80%). */
  marketEvidence.push(...quantEvidence);

  /* ── 4. Phiếu LLM (chu kỳ ưu tiên, fallback DB 24h) → evidence + votes ── */
  const votes = await resolveLlmVotes(options.llmVotes);
  // B7 — thêm code ml-forecast vào stats (cử tri thứ 6 cần healthScore/successRate)
  const voteStats = await loadVoteAgentStats([...votes.map((v) => v.code), "ml-forecast"]);
  // (phiên #35) Posterior Thompson sampling BanditArm — nhân vào weight phiếu:
  // agent bầu đúng hướng giá thực tế nhiều → posteriorMean cao → tin hơn.
  // B7: đọc LUÔN (kể cả không có phiếu LLM) vì cử tri thứ 6 ml-forecast cần
  // posteriorMean arm của mình (Beta(1,1) → 0,5 khi arm chưa tồn tại).
  // F-13 (#129): posterior CONTEXTUAL — regime hiện tại đủ pulls ở arm thì
  // dùng posterior regime, ngược lại bảng chung (posteriorByCodeForCycle —
  // một nguồn sự thật regime-aware, thay map alpha/beta phẳng cũ).
  const posteriorByCode = await posteriorByCodeForCycle().catch(
    () => new Map<string, number>()
  );
  const agentVotes: AgentVote[] = [];
  for (const v of votes) {
    const roster = ROSTER_BY_CODE.get(v.code);
    const stats = voteStats.get(v.code);
    const agentName = roster?.name ?? stats?.name ?? v.code;
    const gen1 = roster?.gen1 ?? "—";
    const successRate = stats?.successRate ?? 0;
    const healthScore = stats?.healthScore ?? 80;
    const confidence = Math.max(0, Math.min(1, v.confidence));
    // B9 — weight tally cổng đồng thuận (§3.5): trùng công thức weight bằng chứng
    const voteWeight = Math.min(
      1,
      Math.max(0.3, (healthScore / 100) * (posteriorByCode.get(v.code) ?? 1))
    );

    agentVotes.push({ code: v.code, agentName, gen1, direction: v.direction, confidence, successRate, weight: voteWeight });

    // Assessment của LLM là bằng chứng thị trường (direction = quan điểm chung)
    const lr = Math.min(2.0, 1 + 0.8 * confidence);
    const firstNote = (v.evidence ?? []).filter((e) => e.trim()).slice(0, 1)[0];
    marketEvidence.push({
      source: `llm-vote:${v.code}`,
      agentName,
      gen1,
      level: "market",
      direction: v.direction,
      likelihoodRatio: lr,
      weight: voteWeight,
      note: `${agentName} đánh giá ${v.direction === "UP" ? "TĂNG" : v.direction === "DOWN" ? "GIẢM" : "ĐI NGANG"} (tin cậy ${confidence.toFixed(2)})${firstNote ? ` — ${firstNote}` : ""}`,
    });
  }

  /* ── 4b. (B7) CỬ TRI THỨ 6 — ml-forecast ensemble MLP+linreg ──────────
   * REPLACE bằng chứng quant `mlp-forecast (MLP 10→16→8→3)` cũ: cùng tín
   * hiệu ML giờ vào Bayes ĐÚNG MỘT LẦN qua phiếu bầu (chống đếm kép T7.5 —
   * KHÔNG đồng thời tồn tại source quant cũ và llm-vote:ml-forecast). */
  const mlEns = await mlForecastEnsemble().catch(() => null);
  if (mlEns) {
    const rosterMl = ROSTER_BY_CODE.get("ml-forecast");
    const statsMl = voteStats.get("ml-forecast");
    const agentNameMl = rosterMl?.name ?? "ML Forecast";
    const gen1Ml = rosterMl?.gen1 ?? "A15";
    const healthMl = statsMl?.healthScore ?? 80;
    const mlDiff =
      mlEns.pUp != null && mlEns.pDown != null
        ? Math.abs(mlEns.pUp - mlEns.pDown)
        : 0.3 * mlEns.confidence; // fallback linreg — LR khiêm tốn
    // B9 — weight tally (§3.5, trùng weight bằng chứng; Beta(1,1) → 0,5 khi chưa có arm)
    const mlVoteWeight = Math.min(
      1,
      Math.max(0.3, (healthMl / 100) * (posteriorByCode.get("ml-forecast") ?? 0.5))
    );

    agentVotes.push({
      code: "ml-forecast",
      agentName: agentNameMl,
      gen1: gen1Ml,
      direction: mlEns.direction,
      confidence: mlEns.confidence, // = max(pUp,pDown,pFlat) — BanditEvent Brier (B8)
      successRate: statsMl?.successRate ?? 0,
      weight: mlVoteWeight, // B9 — trùng weight bằng chứng (đã điền ở trên)
      // F-07 (#129): vector giọng nói tại thời điểm cast — settle chép vào
      // BanditEvent.meta → ensemble-learn học trọng số từ D-LEDGER.
      meta: {
        pUp: mlEns.pUp,
        pDown: mlEns.pDown,
        pFlat: mlEns.pFlat,
        z: mlEns.z,
        score: mlEns.score,
        weightsSource: mlEns.weightsSource,
        modelVersion: mlEns.modelVersion,
        servingFeatureSet: mlEns.servingFeatureSet,
        calibrated: mlEns.calibrated,
      },
    });
    marketEvidence.push({
      source: "llm-vote:ml-forecast",
      agentName: agentNameMl,
      gen1: gen1Ml,
      level: "market",
      direction: mlEns.direction,
      likelihoodRatio: Math.min(2.0, 1 + 0.8 * mlDiff),
      // BanditArm ml-forecast chưa có track record → Beta(1,1) posteriorMean 0,5
      // (cold-start khiêm tốn — B7 spec); arm đã có dữ liệu → posteriorMean thật.
      weight: mlVoteWeight,
      note: mlEns.note,
    });
  }

  /* ── 5. BẰNG CHỨNG BẬC 3 · symbol top ADTV HOSE (rổ segment chính) ──── */
  const topSymbols = hoseBasket.slice(0, TOP_SYMBOL_COUNT);

  const symbolFeatures: SymbolFeature[] = [];
  for (const s of topSymbols) {
    const closes = s.closes;
    const volumes = s.volumes;
    const last = s.last || (closes.length ? closes[closes.length - 1] : 0);
    if (!last || closes.length < 30) continue;

    // P0-3 (phiên #57 — FEATURECONTRACT): SMA/RSI/MACD/MOM5/KL-TL20 tính qua
    // `latestFeatureSnapshot` (ml/features.ts — nơi tính duy nhất) — RSI14 đây
    // == RSI14 S2 broadcast == RSI14 bảng chỉ báo prompt (nghiệm thu P0-3);
    // nhãn evidence feature-store.* giờ XỨNG ĐÁNH (trước đây evidence tự tính).
    const snap = latestFeatureSnapshot(closes, volumes);
    const rsi14 = snap?.rsi14 ?? null;
    const z90 = closes.length >= 30 ? zscore(last, closes.slice(-90)) : null;
    const macdHist = snap?.macdHist ?? null;
    const volRatio = snap?.volRatio20 ?? null;
    const momentum5d = snap?.mom5Pct ?? null;
    const forecast = holtForecastPct(closes, { horizon: 5 });

    // 5a. RSI14 — quá bán/quá mua
    if (rsi14 != null) {
      if (rsi14 < 30) {
        symbolEvidence.push({
          source: "feature-store.rsi",
          agentName: "Feature Store",
          gen1: "S2",
          level: "symbol",
          symbol: s.symbol,
          direction: "UP",
          likelihoodRatio: 1.7,
          weight: 0.6,
          note: `RSI14 ${rsi14.toFixed(0)} — quá bán`,
        });
      } else if (rsi14 > 70) {
        symbolEvidence.push({
          source: "feature-store.rsi",
          agentName: "Feature Store",
          gen1: "S2",
          level: "symbol",
          symbol: s.symbol,
          direction: "DOWN",
          likelihoodRatio: 1.5,
          weight: 0.6,
          note: `RSI14 ${rsi14.toFixed(0)} — quá mua`,
        });
      }
    }

    // 5b. z-score dải định giá 90 phiên (A3 Fair Value)
    if (z90 != null) {
      if (z90 < -1.5) {
        symbolEvidence.push({
          source: "fair-value.zscore",
          agentName: "Fair Value Analyst",
          gen1: "A3",
          level: "symbol",
          symbol: s.symbol,
          direction: "UP",
          likelihoodRatio: 1.5,
          weight: 0.6,
          note: `z90 ${z90.toFixed(2)} — thấp hơn dải định giá 90 phiên`,
        });
      } else if (z90 > 1.5) {
        symbolEvidence.push({
          source: "fair-value.zscore",
          agentName: "Fair Value Analyst",
          gen1: "A3",
          level: "symbol",
          symbol: s.symbol,
          direction: "DOWN",
          likelihoodRatio: 1.5,
          weight: 0.6,
          note: `z90 ${z90.toFixed(2)} — cao hơn dải định giá 90 phiên`,
        });
      }
    }

    // 5c. MACD histogram
    if (macdHist != null && macdHist !== 0) {
      symbolEvidence.push({
        source: "feature-store.macd",
        agentName: "Feature Store",
        gen1: "S2",
        level: "symbol",
        symbol: s.symbol,
        direction: macdHist > 0 ? "UP" : "DOWN",
        likelihoodRatio: 1.25,
        weight: 0.5,
        note: `MACD histogram ${macdHist > 0 ? "dương" : "âm"} (${macdHist.toFixed(0)})`,
      });
    }

    // 5d. Khối lượng xác nhận hướng giá
    const priceDir =
      s.changePct !== 0
        ? s.changePct > 0
          ? "UP"
          : "DOWN"
        : momentum5d != null && momentum5d !== 0
          ? momentum5d > 0
            ? "UP"
            : "DOWN"
          : "FLAT";
    if (volRatio != null && volRatio >= 1.2 && priceDir !== "FLAT") {
      symbolEvidence.push({
        source: "feature-store.volume",
        agentName: "Feature Store",
        gen1: "S2",
        level: "symbol",
        symbol: s.symbol,
        direction: priceDir,
        likelihoodRatio: 1.3,
        weight: 0.55,
        note: `KL ${volRatio.toFixed(2)}× TB20 kết hợp giá ${s.changePct >= 0 ? "+" : ""}${s.changePct.toFixed(2)}% — dòng tiền xác nhận`,
      });
    }

    // 5e. Momentum 5 phiên
    if (momentum5d != null && Math.abs(momentum5d) > 0.3) {
      symbolEvidence.push({
        source: "feature-store.momentum",
        agentName: "Feature Store",
        gen1: "S2",
        level: "symbol",
        symbol: s.symbol,
        direction: momentum5d > 0 ? "UP" : "DOWN",
        likelihoodRatio: 1.2,
        weight: 0.5,
        note: `Momentum 5 phiên ${(momentum5d >= 0 ? "+" : "") + momentum5d.toFixed(2)}%`,
      });
    }

    // 5f. Holt forecast từng mã (LR theo |expected|/sigma, cap 1.8)
    if (forecast && Math.abs(forecast.expectedPct) >= 0.1) {
      const sigmaFloor = Math.max(forecast.sigmaPct, 0.05); // chống chia ~0 chuỗi phẳng
      const zStat = Math.min(1.6, Math.abs(forecast.expectedPct) / sigmaFloor);
      symbolEvidence.push({
        source: "ml-forecast.holt",
        agentName: "ML Forecast",
        gen1: "A15",
        level: "symbol",
        symbol: s.symbol,
        direction: forecast.expectedPct > 0 ? "UP" : "DOWN",
        likelihoodRatio: Math.min(1.8, 1 + 0.5 * zStat),
        weight: 0.6,
        note: `Holt 5 phiên ${(forecast.expectedPct >= 0 ? "+" : "") + forecast.expectedPct.toFixed(2)}% (${zStat.toFixed(1)}σ)`,
      });
    }

    symbolFeatures.push({
      symbol: s.symbol,
      name: s.name,
      sector: s.sector,
      last,
      changePct: s.changePct,
      zScore: z90,
      rsi14,
      momentum5d,
      adtvVnd: s.adtvVnd,
      forecast: forecast
        ? {
            horizonDays: 5,
            expectedPct: forecast.expectedPct,
            lowPct: forecast.lowPct,
            highPct: forecast.highPct,
          }
        : null,
    });
  }

  /* ── 6. (phiên #35 · B7 REPLACE) Bằng chứng học máy — CHỈ còn rl-policy ──
   * Block (a) `mlp-forecast (MLP 10→16→8→3)` đã bị REPLACE bằng phiếu cử tri
   * thứ 6 ở mục 4b (llm-vote:ml-forecast) — giữ lại (b) rl-policy nguyên vẹn. */
  try {
    const mlModels = await db.mlModel.findMany({
      where: { kind: { in: ["rl-q"] }, status: "serving" },
    });
    const rlModel = mlModels.find((m) => m.kind === "rl-q");

    // rl-policy: policyStance từ Q-table + rổ top-10 HOSE-STOCK THEO QUOTE VOLUME
    // (loadTopSeries(10) — CÙNG rổ với lúc train trong /api/ml/train, để
    // stance hiển thị ở status và stance trong bằng chứng Bayes KHÔNG lệch nhau)
    if (rlModel) {
      const qTable = parseQTable(rlModel.weights);
      const rlSeries = await loadTopSeries(10);
      const basket = buildBasket(rlSeries.map((s) => s.closes));
      const stance = policyStance(qTable, basket, 0.5);
      marketEvidence.push({
        source: "rl-policy (Q-learning 48×3)",
        agentName: "RL Policy",
        gen1: "A16",
        level: "market",
        direction: stance.stance === "tăng" ? "UP" : stance.stance === "giảm" ? "DOWN" : "FLAT",
        likelihoodRatio: stance.stance === "giữ" ? 1.0 : 1.4,
        weight: 0.5,
        note: `Q-learning v${rlModel.version} khuyến nghị ${stance.stance} phơi nhiễm (exposure ${(stance.exposure * 100).toFixed(0)}%, Q-max ${stance.qMax.toFixed(2)})`,
      });
    }
  } catch {
    // mô hình hỏng/thiếu dữ liệu → im lặng bỏ qua, 4 bậc gốc không bị ảnh hưởng
  }

  /* ── 7. BẰNG CHỨNG BẬC 1 · CÁC SEGMENT PHỤ (B5 §3.4) ────────────────── */
  const segments: SegmentInput[] = [
    {
      segment: "VN-HOSE-STOCK",
      label: hose.label,
      symbolCount: hoseBasket.length,
      prior,
      evidence: marketEvidence,
      compositeWeight: hose.adtvVnd ?? 0,
    },
  ];

  // 7a. VN-HNX-STOCK — breadth segment · Holt · RSI basket
  {
    const ev: BayesEvidence[] = [];
    pushBreadthSegment(ev, hnx, "HNX");
    pushHoltSegment(ev, hnx, "HNX");
    pushRsiSegment(ev, hnx, "HNX");
    segments.push({
      segment: "VN-HNX-STOCK",
      label: hnx.label,
      symbolCount: hnx.symbols.length,
      prior: buildPrior(hnx.symbols.map((s) => s.closes), "HNX"),
      evidence: ev,
      compositeWeight: hnx.adtvVnd ?? 0,
    });
  }

  // 7b. VN-UPCOM-STOCK — Holt · RSI basket
  {
    const ev: BayesEvidence[] = [];
    pushHoltSegment(ev, upcom, "UPCOM");
    pushRsiSegment(ev, upcom, "UPCOM");
    segments.push({
      segment: "VN-UPCOM-STOCK",
      label: upcom.label,
      symbolCount: upcom.symbols.length,
      prior: buildPrior(upcom.symbols.map((s) => s.closes), "UPCOM"),
      evidence: ev,
      compositeWeight: upcom.adtvVnd ?? 0,
    });
  }

  // 7c. VN-ETF — breadth ETF · Holt
  {
    const ev: BayesEvidence[] = [];
    pushBreadthSegment(ev, etf, "ETF");
    pushHoltSegment(ev, etf, "ETF");
    segments.push({
      segment: "VN-ETF",
      label: etf.label,
      symbolCount: etf.symbols.length,
      prior: buildPrior(etf.symbols.map((s) => s.closes), "ETF"),
      evidence: ev,
      compositeWeight: etf.adtvVnd ?? 0,
    });
  }

  // 7d. VN-INDEX — động lượng index · RSI index (§3.4)
  {
    const ev: BayesEvidence[] = [];
    const vnindex = idx.symbols.find((s) => s.symbol === "VNINDEX");
    if (vnindex && vnindex.closes.length >= 6) {
      const mom5 = pctChange(vnindex.closes[vnindex.closes.length - 6], vnindex.closes[vnindex.closes.length - 1]);
      if (Math.abs(mom5) > 1) {
        ev.push({
          source: "index.momentum",
          agentName: "Market Analyst",
          gen1: "A2",
          level: "market",
          direction: mom5 > 0 ? "UP" : "DOWN",
          likelihoodRatio: 1.15,
          weight: 0.6,
          note: `VN-Index động lượng 5 phiên ${(mom5 >= 0 ? "+" : "") + mom5.toFixed(2)}%`,
        });
      }
      const rsiIdx = rsi(vnindex.closes, 14);
      if (rsiIdx != null) {
        if (rsiIdx < 30) {
          ev.push({
            source: "index.rsi",
            agentName: "Market Analyst",
            gen1: "A2",
            level: "market",
            direction: "UP",
            likelihoodRatio: 1.2,
            weight: 0.6,
            note: `RSI14 VN-Index ${rsiIdx.toFixed(0)} — quá bán`,
          });
        } else if (rsiIdx > 70) {
          ev.push({
            source: "index.rsi",
            agentName: "Market Analyst",
            gen1: "A2",
            level: "market",
            direction: "DOWN",
            likelihoodRatio: 1.2,
            weight: 0.6,
            note: `RSI14 VN-Index ${rsiIdx.toFixed(0)} — quá mua`,
          });
        }
      }
    }
    segments.push({
      segment: "VN-INDEX",
      label: idx.label,
      symbolCount: idx.symbols.length,
      prior: buildPrior(idx.symbols.map((s) => s.closes), "INDEX"),
      evidence: ev,
      compositeWeight: idx.symbols.length * INDEX_COMPOSITE_WEIGHT,
    });
  }

  /* ── 7e. (B13) SEGMENT INTERNATIONAL — ^GSPC · ^HSI (tham khảo, KHÔNG vào
   * composite VN — thiết kế tách bạch T13.3): động lượng 5 phiên LR 1,15 khi
   * |mom| > 1% + RSI14 LR 1,2 khi < 30 / > 70; weight 0,4 (mờ hơn bằng chứng VN). */
  {
    const intlSymbols = ["^GSPC", "^HSI"];
    const intlRows = await db.instrument
      .findMany({
        where: { isActive: true, market: { in: ["US", "HK"] }, symbol: { in: intlSymbols } },
        select: { id: true, symbol: true },
      })
      .catch(() => [] as { id: string; symbol: string }[]);
    if (intlRows.length > 0) {
      const intlBars = await db.bar
        .findMany({
          where: { instrumentId: { in: intlRows.map((r) => r.id) }, date: { gte: new Date(Date.now() - 180 * 86_400_000) } },
          orderBy: [{ instrumentId: "asc" }, { date: "asc" }],
          select: { instrumentId: true, close: true },
        })
        .catch(() => [] as { instrumentId: string; close: number }[]);
      const closesById = new Map<string, number[]>();
      for (const b of intlBars) {
        if (!(b.close > 0)) continue;
        const arr = closesById.get(b.instrumentId) ?? [];
        arr.push(b.close);
        closesById.set(b.instrumentId, arr);
      }
      const intlCloses = intlRows
        .map((r) => ({ symbol: r.symbol, closes: (closesById.get(r.id) ?? []).slice(-70) }))
        .filter((s) => s.closes.length >= 20);

      const ev: BayesEvidence[] = [];
      for (const s of intlCloses) {
        const short = s.symbol === "^GSPC" ? "S&P 500" : s.symbol === "^HSI" ? "HSI" : s.symbol;
        const mom5 = s.closes.length >= 6 ? pctChange(s.closes[s.closes.length - 6], s.closes[s.closes.length - 1]) : null;
        if (mom5 != null && Math.abs(mom5) > 1) {
          ev.push({
            source: `intl.momentum:${s.symbol}`,
            agentName: "Market Analyst",
            gen1: "A2",
            level: "market",
            direction: mom5 > 0 ? "UP" : "DOWN",
            likelihoodRatio: 1.15,
            weight: 0.4,
            note: `Quốc tế: ${short} ${mom5 >= 0 ? "+" : ""}${mom5.toFixed(2)}% 5 phiên — ảnh hưởng tâm lý VN`,
          });
        }
        const rsiIntl = rsi(s.closes, 14);
        if (rsiIntl != null && (rsiIntl < 30 || rsiIntl > 70)) {
          ev.push({
            source: `intl.rsi:${s.symbol}`,
            agentName: "Market Analyst",
            gen1: "A2",
            level: "market",
            direction: rsiIntl < 30 ? "UP" : "DOWN",
            likelihoodRatio: 1.2,
            weight: 0.4,
            note: `RSI14 ${short} ${rsiIntl.toFixed(0)} — ${rsiIntl < 30 ? "quá bán" : "quá mua"}`,
          });
        }
      }
      segments.push({
        segment: "INTERNATIONAL",
        label: "Quốc tế (S&P 500 · HSI — tham khảo)",
        symbolCount: intlCloses.length,
        prior: buildPrior(intlCloses.map((s) => s.closes), "QT"),
        evidence: ev,
        compositeWeight: 0, // §3.4: INTERNATIONAL KHÔNG vào composite VN
      });
    }
  }

  /* ── 8. Bậc 2 · số liệu nền nhóm ngành (HOSE-STOCK quoted — continuation) ── */
  const sectorAgg = new Map<string, { count: number; momSum: number; momCount: number }>();
  for (const s of hoseQuoted) {
    const key = s.sector;
    const agg = sectorAgg.get(key) ?? { count: 0, momSum: 0, momCount: 0 };
    agg.count++;
    if (s.closes.length >= 6) {
      const mom = pctChange(s.closes[s.closes.length - 6], s.closes[s.closes.length - 1]);
      agg.momSum += mom;
      agg.momCount++;
    }
    sectorAgg.set(key, agg);
  }
  const sectors: SectorFeature[] = [...sectorAgg.entries()]
    .map(([sector, a]) => ({
      sector,
      symbolCount: a.count,
      avgMomentum5d: a.momCount > 0 ? a.momSum / a.momCount : 0,
    }))
    .sort((a, b) => b.symbolCount - a.symbolCount);

  /* ── 9. Lồng ghép context thị trường (HOSE-STOCK — continuation #34) ──── */
  const market: MarketFeature = {
    advancing,
    declining,
    unchanged,
    regime: regime.label,
    netForeignFlowVnd: flows ? flows.totalNet : null,
    newsSentimentScore: newsItems.length > 0 ? newsAgg.score : null,
    breadth,
  };

  /* ── 10. B9 — đọc AppSetting consensus.enforce (shadow/enforce) ─────── */
  const consensusSetting = await getConsensusSetting().catch(() => ({ enforce: false, autoEnableAfter: 10 }));

  return {
    prior,
    marketEvidence,
    symbolEvidence,
    agentVotes,
    segments,
    veto,
    consensusEnforce: consensusSetting.enforce,
    context: {
      market,
      symbols: symbolFeatures,
      sectors,
    },
  };
}

/* ─────────────────────────── Tiện ích nội bộ ─────────────────────────── */

/** Basket rỗng an toàn khi DB chưa có dữ liệu segment. */
function emptyBasket(segment: string): SegmentBasket {
  return {
    segment: segment as SegmentBasket["segment"],
    label: segment,
    symbols: [],
    quoted: [],
    adtvVnd: null,
  };
}

/** Tiên nghiệm base-rate 250 phiên từ chuỗi closes của segment. */
function buildPrior(closesBySymbol: number[][], label: string): BayesPrior {
  const usable = closesBySymbol.filter((c) => c.length >= 30);
  const baseRates = historicalBaseRates(usable.length > 0 ? usable : closesBySymbol, {
    sessions: PRIOR_SESSIONS,
  });
  return {
    pUp: baseRates.pUp,
    pDown: baseRates.pDown,
    pFlat: baseRates.pFlat,
    baseRateNote: `Tần suất lịch sử ${PRIOR_SESSIONS} phiên (${label}): ${(baseRates.pUp * 100).toFixed(1).replace(".", ",")}% tăng / ${(baseRates.pDown * 100).toFixed(1).replace(".", ",")}% giảm / ${(baseRates.pFlat * 100).toFixed(1).replace(".", ",")}% đi ngang (${baseRates.sampleCount.toLocaleString("vi-VN")} quan sát mã×phiên)`,
  };
}

/** Breadth segment: (tăng − giảm)/tổng trên toàn bộ quoted của segment. */
function pushBreadthSegment(ev: BayesEvidence[], basket: SegmentBasket, label: string): void {
  const quoted = basket.quoted;
  if (quoted.length < 3) return;
  const adv = quoted.filter((q) => q.changePct > 0).length;
  const dec = quoted.filter((q) => q.changePct < 0).length;
  const br = (adv - dec) / quoted.length;
  if (br === 0) return;
  ev.push({
    source: `segment-breadth:${label.toLowerCase()}`,
    agentName: "Market Analyst",
    gen1: "A2",
    level: "market",
    direction: br > 0 ? "UP" : "DOWN",
    likelihoodRatio: Math.min(2.0, Math.max(1, 1 + 0.6 * Math.abs(br))),
    weight: 0.6,
    note: `${label}: ${adv} mã tăng / ${dec} mã giảm (breadth ${(br >= 0 ? "+" : "") + br.toFixed(2)})`,
  });
}

/** Holt forecast trên basket index equal-weight của segment. */
function pushHoltSegment(ev: BayesEvidence[], basket: SegmentBasket, label: string): void {
  const closes = buildBasketIndex(basket.symbols.map((s) => s.closes), PRIOR_SESSIONS);
  const f = holtForecastPct(closes, { horizon: 5 });
  if (!f || Math.abs(f.expectedPct) < 0.1) return;
  const strength = Math.min(1, Math.abs(f.expectedPct) / 1.5);
  ev.push({
    source: `segment-holt:${label.toLowerCase()}`,
    agentName: "ML Forecast",
    gen1: "A15",
    level: "market",
    direction: f.expectedPct > 0 ? "UP" : "DOWN",
    likelihoodRatio: Math.min(1.8, 1 + 0.9 * strength),
    weight: 0.6,
    note: `Holt rổ ${label} 5 phiên: ${(f.expectedPct >= 0 ? "+" : "") + f.expectedPct.toFixed(2)}%`,
  });
}

/** RSI14 trên basket index equal-weight của segment (quá bán/quá mua). */
function pushRsiSegment(ev: BayesEvidence[], basket: SegmentBasket, label: string): void {
  const closes = buildBasketIndex(basket.symbols.map((s) => s.closes), PRIOR_SESSIONS);
  const r = rsi(closes, 14);
  if (r == null) return;
  if (r < 30) {
    ev.push({
      source: `segment-rsi:${label.toLowerCase()}`,
      agentName: "Feature Store",
      gen1: "S2",
      level: "market",
      direction: "UP",
      likelihoodRatio: 1.5,
      weight: 0.55,
      note: `RSI14 rổ ${label} ${r.toFixed(0)} — quá bán`,
    });
  } else if (r > 70) {
    ev.push({
      source: `segment-rsi:${label.toLowerCase()}`,
      agentName: "Feature Store",
      gen1: "S2",
      level: "market",
      direction: "DOWN",
      likelihoodRatio: 1.4,
      weight: 0.55,
      note: `RSI14 rổ ${label} ${r.toFixed(0)} — quá mua`,
    });
  }
}

/** Basket index equal-weight: mỗi mã chuẩn hoá = 1 tại phiên đầu rồi lấy TB.
 * Export từ Task 176 — src/lib/ml/ss/shadow.ts tái dùng CÙNG phép dựng rổ
 * cho A/B bóng (một nguồn sự thật, tránh 2 đường dựng rổ lệch nhau). */
export function buildBasketIndex(closesBySymbol: number[][], sessions: number): number[] {
  const usable = closesBySymbol.filter((c) => c.length >= 60);
  if (usable.length === 0) return [];
  const n = Math.min(sessions, ...usable.map((c) => c.length));
  if (n < 2) return [];
  const index: number[] = [];
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let count = 0;
    for (const closes of usable) {
      const start = closes[closes.length - n];
      if (start > 0) {
        sum += closes[closes.length - n + i] / start;
        count++;
      }
    }
    index.push(count > 0 ? sum / count : 1);
  }
  return index;
}

/**
 * Task 176 (SS-1 quy tắc 6) — đẩy evidence A15b ml-forecast.holt-ss khi và
 * chỉ khi A/B bóng đã THẮNG log-score 14 ngày (mode "live" + kill-switch bật).
 * Trả true khi ĐÃ đẩy (caller tắt driver cũ — không dual-live). Shadow/off
 * ⇒ false + nguyên văn đường A15 heuristic cũ (checklist Phụ lục B: hash cũ
 * ≡ hành vi cũ khi tắt kill-switch). sd phình (SS-2) ⇒ false — model tự nhận
 * "tôi không biết", evidence im lặng trung thực thay vì đốt số liệu rác.
 */
async function pushHoltSsEvidence(
  marketEvidence: BayesEvidence[],
  setting: SsShadowSetting,
  basketCloses: number[]
): Promise<boolean> {
  if (!setting.enabled || setting.mode !== "live" || basketCloses.length < 60) return false;
  const fit = holtSsFit(basketCloses);
  if (!fit) return false;
  const fc = holtSsForecast(fit, basketCloses, 5);
  if (!fc) return false;
  const hIdx = 4; // h=5
  // Guard sd cuộn SS-2 (mirror lib shadow.ts — cùng công thức, tính tại đây
  // vì evidence chạy mỗi chu kỳ không đợi settle)
  const rets: number[] = [];
  for (let i = 0; i + 5 < basketCloses.length; i++) {
    if (basketCloses[i] > 0) {
      rets.push(((basketCloses[i + 5] - basketCloses[i]) / basketCloses[i]) * 100);
    }
  }
  const rMean = rets.reduce((s, x) => s + x, 0) / Math.max(1, rets.length);
  const rVar =
    rets.length > 1
      ? rets.reduce((s, x) => s + (x - rMean) * (x - rMean), 0) / (rets.length - 1)
      : 0;
  const rollingSd = Math.sqrt(Math.max(rVar, 0));
  const sd5 = fc.sdPct[hIdx];
  const z5 = fc.z[hIdx];
  const decision: SsEvidenceDecision = ssEvidenceDecision(
    setting,
    {
      meanPct: fc.meanPct[hIdx],
      sdPct: sd5,
      pUp: fc.pUp,
      z: z5,
      weight: sdInflated(sd5, rollingSd) ? 0 : zWeight(z5),
    },
    { rollingSdPctH5: rollingSd }
  );
  if (!decision.push || decision.source == null || decision.gen1 == null) return false;
  marketEvidence.push({
    source: decision.source,
    agentName: "ML Forecast",
    gen1: decision.gen1,
    level: "market",
    direction: decision.direction ?? "UP",
    likelihoodRatio: decision.likelihoodRatio ?? 1,
    weight: decision.weight ?? 0.65,
    note: `Holt-SS rổ HOSE 5 phiên (MLE): ${fc.meanPct[hIdx] >= 0 ? "+" : ""}${fc.meanPct[hIdx].toFixed(2)}% ± sd ${sd5.toFixed(2)}% · pUp ${(fc.pUp != null ? fc.pUp * 100 : 0).toFixed(1)}% · trọng số z ${(decision.weight ?? 0).toFixed(2)} (σ²ε ${fit.sigma2Eps.toExponential(2)} · logLik ${fit.logLik.toFixed(1)})`,
  });
  return true;
}

/** Phiếu LLM: chu kỳ truyền → dùng luôn; không → đọc tin broadcast 24h. */
async function resolveLlmVotes(llmVotes?: LlmVoteInput[]): Promise<LlmVoteInput[]> {
  if (llmVotes && llmVotes.length > 0) return llmVotes;

  const since24h = new Date(Date.now() - 24 * 3_600_000);
  const messages = await db.agentMessage.findMany({
    where: {
      broadcast: true,
      direction: "AGENT",
      createdAt: { gte: since24h },
      sentiment: { not: null },
      fromAgent: { code: { in: [...LLM_VOTE_CODES] } },
    },
    orderBy: { createdAt: "desc" },
    include: { fromAgent: { select: { code: true } } },
    take: 50,
  });
  const seen = new Set<string>();
  const votes: LlmVoteInput[] = [];
  for (const m of messages) {
    const code = m.fromAgent.code;
    if (seen.has(code)) continue; // chỉ tin MỚI NHẤT mỗi agent
    seen.add(code);
    const sentiment = (m.sentiment ?? "").toLowerCase();
    if (sentiment !== "bullish" && sentiment !== "bearish" && sentiment !== "neutral") continue;
    votes.push({
      code,
      direction: sentiment === "bullish" ? "UP" : sentiment === "bearish" ? "DOWN" : "FLAT",
      confidence: 0.6,
      evidence: [],
    });
  }
  return votes;
}

/** Thông tin vận hành của các agent có phiếu: healthScore + successRate. */
async function loadVoteAgentStats(
  codes: string[]
): Promise<Map<string, { name: string; healthScore: number; successRate: number }>> {
  if (codes.length === 0) return new Map();
  const agents = await db.agent.findMany({
    where: { code: { in: codes } },
    select: { id: true, code: true, name: true, healthScore: true },
  });
  const runs = await db.agentRun.groupBy({
    by: ["agentId", "taskStatus"],
    where: { agentId: { in: agents.map((a) => a.id) } },
    _count: { _all: true },
  });
  const totalById = new Map<string, number>();
  const completedById = new Map<string, number>();
  for (const r of runs) {
    const cnt = r._count._all;
    totalById.set(r.agentId, (totalById.get(r.agentId) ?? 0) + cnt);
    if (r.taskStatus === "COMPLETED") {
      completedById.set(r.agentId, (completedById.get(r.agentId) ?? 0) + cnt);
    }
  }
  const out = new Map<string, { name: string; healthScore: number; successRate: number }>();
  for (const a of agents) {
    const total = totalById.get(a.id) ?? 0;
    const completed = completedById.get(a.id) ?? 0;
    out.set(a.code, {
      name: a.name,
      healthScore: a.healthScore,
      successRate: total > 0 ? completed / total : 0,
    });
  }
  return out;
}
