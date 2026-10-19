/** (Task 144 P2-a) — tách từ src/app/api/agents/run/route.ts (pure move)
 *  Dựng prompt context chu kỳ: snapshot 7 khối, RAG L1/L2, XREL, risk-quant
 *  (CRB-0), prompt 5 agent nghiên cứu + risk-manager + Chủ tịch. */

import {
  ROLE_PROMPTS,
  buildMarketBlock,
  buildNewsBlock,
  buildFlowsBlock,
  buildOpenSignalsBlock,
  buildValuationBlock,
  buildLiquidityBlock,
  buildMacroBlock,
  buildPortfolioWeightsBlock,
  buildIntlReferenceBlock,
  type MarketSnapshot,
} from "@/lib/agent-context";
// #106 C-VISION — tầm nhìn toàn cục hội đồng cho Chủ tịch (wave E)
import { buildCouncilVisionBlock } from "@/lib/council/vision";
import { AGENT_ROSTER } from "@/lib/agent-roster";
// L1 (ML_LEARNING_BLUEPRINT §2 — phiên #83): BM25 RAG — truy hồi tri thức
// broadcast/tin cũ tiêm prompt 5 agent nghiên cứu + Chủ tịch + RetrievalLog.
import { retrieveForCycle } from "@/lib/ml/rag";
import { retrieveForCycleL2 } from "@/lib/ml/l2";
// M2 (M2_RELATION_BLUEPRINT — phiên #103, cơ chế số 2): quan hệ thị trường
// đã học (lead-lag 750 phiên) tiêm prompt market-analyst · news-sentiment · Chủ tịch.
import { buildXrelPromptBlock } from "@/lib/ml/xrel";
import { runRiskQuantEngine, type RiskQuantResult } from "@/lib/risk/engine";
import { buildK4ChairmanPromptBlock, type K4Stored } from "@/lib/k4";
import type { ServiceRunResult } from "@/lib/agent-service-runs";
import type { MarketAssessmentView } from "@/lib/types";
import { WAVE_B_SERVICE_CODES } from "./prepare";
import type { AgentAnalysis, ControlVerdicts } from "./agent-loop";

/**
 * Khối prompt "BỘ TỔNG HỢP BAYES" cho Chủ tịch (phiên #34 — Đợt E):
 * pUp/pDown/pFlat %, marketDirection, confidence, disagreement, 3 driver mạnh
 * nhất, top-3 mã theo |pUp − pDown| kèm pUp% + forecast CI, forecast5d, veto.
 */
function buildBayesPromptBlock(view: MarketAssessmentView): string {
  const fmt = (n: number) => `${(n * 100).toFixed(1).replace(".", ",")}%`;
  const driverLines = view.drivers
    .filter((d) => d.deltaLogOdds !== 0)
    .slice(0, 3)
    .map(
      (d, i) =>
        `${i + 1}) ${d.agentName} (${d.source}): ${d.direction} — ${d.note} [Δlog-odds ${d.deltaLogOdds > 0 ? "+" : ""}${d.deltaLogOdds}]`
    );
  const topSymbols = [...view.symbols]
    .sort((a, b) => Math.abs(b.pUp - b.pDown) - Math.abs(a.pUp - a.pDown))
    .slice(0, 3)
    .map(
      (s) =>
        `${s.symbol} (pTăng ${fmt(s.pUp)}${s.forecast ? `, dự báo 5 phiên ${s.forecast.expectedPct >= 0 ? "+" : ""}${s.forecast.expectedPct}% · CI ${s.forecast.lowPct}%…${s.forecast.highPct}%` : ""})`
    );
  // B5 — khối ĐA THỊ TRƯỜNG (1 dòng/segment, gọn — §3.4)
  const segmentLines = (view.segments ?? [])
    .filter((s) => s.segment !== "VN-COMPOSITE")
    .map(
      (s) =>
        `- ${s.label}: TĂNG ${fmt(s.pUp)} · GIẢM ${fmt(s.pDown)} · NGANG ${fmt(s.pFlat)} (${s.symbolCount} mã)${s.note ? ` — ${s.note.split(" — ")[1] ?? ""}` : ""}`
    );
  // B9 — khối CỔNG ĐỒNG THUẬN 80% (7 cử tri — chairman bắt buộc tôn trọng; #126 thêm A20 macro-economist)
  const c = view.consensus;
  const consensusLines = c
    ? [
        "",
        "CỔNG ĐỒNG THUẬN 80% (7 cử tri nghiên cứu — BẮT BUỘC TÔN TRỌNG khi ra tín hiệu):",
        `- Tally: ${c.tally.map((t) => `${t.agentName} → ${t.direction} (w ${t.weight.toFixed(2)})`).join(" · ")}`,
        `- Tỉ lệ trọng số số đông: ${(c.ratio * 100).toFixed(1).replace(".", ",")}% → ${c.gateLabel}`,
        c.gate === "CONSENSUS"
          ? "- Đạt đồng thuận ≥ 80%: tín hiệu MUA/BÁN được phép đưa ra (nếu posterior đạt stance)."
          : `- CHƯA đạt đồng thuận 80%: ${c.shadow ? "hiện shadow-mode — hãy tự giác chỉ đưa tín hiệu GIỮ vì cổng sẽ chặn cứng khi bật enforcement" : "enforcement ĐANG BẬT — tín hiệu MUA/BÁN sẽ bị hệ thống hạ về GIỮ"}.`,
        "- VETO Ủy ban Kiểm soát vẫn TUYỆT ĐỐI — vượt mọi cấp cổng.",
      ]
    : [];
  return [
    "BỘ TỔNG HỢP BAYES (con số định lượng — hãy nhất quán với các con số này khi ra tín hiệu):",
    `- Xác suất thị trường 5 phiên tới (COMPOSITE VN — hợp thành theo trọng số ADTV thật + 0,05/index): TĂNG ${fmt(view.pUp)} · GIẢM ${fmt(view.pDown)} · ĐI NGANG ${fmt(view.pFlat)} → hướng ${view.marketDirection}`,
    ...(segmentLines.length > 1 ? ["", "ĐA THỊ TRƯỜNG (posterior từng phân đoạn):", ...segmentLines] : []),
    ...consensusLines,
    `- Độ tin cậy mô hình: ${fmt(view.confidence)} · Mức bất đồng agents: ${fmt(view.disagreement)}`,
    `- Driver mạnh nhất: ${driverLines.length ? driverLines.join(" ; ") : "(không có)"}`,
    `- Top cơ hội/rủi ro theo |pTăng − pGiảm|: ${topSymbols.length ? topSymbols.join(" ; ") : "(không có)"}`,
    view.forecast5d
      ? `- Dự báo rổ 5 phiên (Holt): ${view.forecast5d.expectedPct >= 0 ? "+" : ""}${view.forecast5d.expectedPct}% (CI80 ${view.forecast5d.lowPct}%…${view.forecast5d.highPct}%)`
      : "- Dự báo rổ 5 phiên: (chưa đủ dữ liệu)",
    `- VETO: ${view.veto.blocked ? `ĐANG CHẶN — ${view.veto.reason}` : "không có"}`,
  ].join("\n");
}

/**
 * Phiên #51 — CRB v1.1 §6: khối QUANT Ủy ban Kiểm soát Định lượng cho prompt
 * Chủ tịch — hạn mức động (ràng buộc tín hiệu MUA), rủi ro đuôi, CUSUM, và
 * dòng Kelly ¼ THAM MƯU (hệ thống tự tính gợi ý khi tín hiệu có target/stop).
 */
function buildQuantChairmanBlock(rq: RiskQuantResult): string {
  const fmt1 = (n: number) => n.toFixed(1).replace(".", ",");
  const fmt2 = (n: number) => n.toFixed(2).replace(".", ",");
  // Fixbug #52-F3: hệ số hiển thị phải là hệ số HỢP NHẤT (vol × learning,
  // kẹp [0,6 · 1,15]) — dyn = tĩnh × hợp nhất. Nếu chỉ ghi vol.mult thì khi
  // CRB-7 learning siết (mult_ℓ < 1) số học trong prompt tự mâu thuẫn.
  const mergedPos =
    rq.staticMaxPositionPct > 0 ? rq.dynMaxPositionPct / rq.staticMaxPositionPct : 1;
  const mergedSec =
    rq.staticMaxSectorPct > 0 ? rq.dynMaxSectorPct / rq.staticMaxSectorPct : 1;
  const mergedNote =
    Math.abs(mergedSec - mergedPos) > 0.005
      ? ` · hệ số ngành ${fmt2(mergedSec)} = vol ${fmt2(rq.vol.mult)} × learning ${fmt2(rq.limits.sector.mult)}`
      : "";
  const lines = [
    "ỦY BAN KIỂM SOÁT ĐỊNH LƯỢNG — KHỐI QUANT (CRB v1.1 · deterministic):",
    `- Hạn mức động: vị thế tối đa ${fmt1(rq.dynMaxPositionPct)}% NAV · ngành ${fmt1(rq.dynMaxSectorPct)}% (tĩnh ${fmt1(rq.staticMaxPositionPct)}/${fmt1(rq.staticMaxSectorPct)}% × hệ số hợp nhất ${fmt2(mergedPos)} = vol ${fmt2(rq.vol.mult)} × learning ${fmt2(rq.limits.position.mult)}${mergedNote}${mergedPos > 1 + 1e-9 ? " — nới theo biến động thấp" : ""}) — tín hiệu MUA không được vượt hạn mức này.`,
    `- Rủi ro đuôi 5 phiên: VaR95 ${rq.tail.var95Pct.toFixed(2).replace(".", ",")}% · CVaR95 ${rq.tail.cvar95Pct.toFixed(2).replace(".", ",")}% NAV${rq.mc.paths > 0 ? ` · Monte Carlo ${rq.mc.paths.toLocaleString("vi-VN")} path: P(chạm DD 15%) = ${fmt1(rq.mc.pDd * 100)}%` : ""}.`,
  ];
  if (rq.pBreach != null) {
    lines.push(
      `- P(vi phạm hạn mức trong 5 phiên): ${fmt1(rq.pBreach * 100)} (logistic CRB-6, AUC ${fmt1(rq.logit.auc * 100)}).`
    );
  }
  if (rq.drift.alarm) {
    lines.push(
      `- CUSUM: TRÔI DỆT XUỐNG phát hiện sớm${rq.drift.sessionsToDd != null ? ` — theo trend hiện tại còn ~${rq.drift.sessionsToDd} phiên tới DD 15%` : ""}.`
    );
  }
  if (rq.proxyMode) {
    lines.push("- LƯU Ý: số đo trên rổ proxy top-10 thanh khoản (danh mục chưa đủ dữ liệu — proxyMode).");
  }
  lines.push(
    "- Kelly ¼ (CHỈ THAM MƯU): nếu đưa tín hiệu MUA/BÁN kèm targetPrice/stopLoss hợp lệ, hệ thống tính gợi ý tỷ trọng tối đa từ bandit posterior cử tri đồng hướng + chặn hạn mức động — KHÔNG tự đặt khối lượng (trader phê duyệt bắt buộc)."
  );
  return lines.join("\n");
}

/** Các khối context dùng chung dựng 1 lần đầu chu kỳ (snapshot + RAG + XREL). */
export interface CycleContextBlocks {
  market: MarketSnapshot;
  marketBlock: string;
  newsBlock: string;
  flowsBlock: string;
  openSignalsBlock: string;
  valuationBlock: string;
  liquidityBlock: string;
  macroBlock: string;
  ragBlock: string | null;
  l2Block: string | null;
  xrelBlock: string | null;
}

/**
 * ── 1. Snapshot + RAG L1/L2 + XREL — dựng 1 lần/chu kỳ (PHASE3_BLUEPRINT
 * §4.6). heartbeat (AUDIT 137 A4) gọi sau wave snapshot giữ agent tươi cho
 * watchdog trong lúc RAG/L2 (tự chữa ≤12s) chạy.
 */
export async function buildCycleContextBlocks(
  heartbeat: () => Promise<unknown>
): Promise<CycleContextBlocks> {
  // #126 A20: thêm buildMacroBlock (bảng điều khiển vĩ mô 3 lớp — tự
  // khai báo lỗi bên trong nên KHÔNG bọc .catch thêm ở đây).
  const [market, newsBlock, flowsBlock, openSignalsBlock, valuationBlock, liquidityBlock, macroBlock] =
    await Promise.all([
      buildMarketBlock(),
      buildNewsBlock(),
      buildFlowsBlock(),
      buildOpenSignalsBlock(),
      buildValuationBlock(),
      buildLiquidityBlock(),
      buildMacroBlock(),
    ]);
  // AUDIT 137 A4 — heartbeat sau wave (xem helper heartbeatRunningAgents)
  await heartbeat();
  const marketBlock = market.block;

  // ── L1 (#83) — TRÍ THỨC TRUY HỒI (RAG): 1 lần/chu kỳ ──
  // Sau snapshot (query cần tín hiệu mở + top mover), TRƯỚC dựng prompt.
  // Fail-soft tuyệt đối: lỗi rag → block=null → prompt y như trước L1.
  const rag = await retrieveForCycle(true).catch((ragErr) => {
    console.error("[api/agents/run] RAG L1 lỗi (chu kỳ chạy không RAG):", ragErr);
    return null;
  });
  const ragBlock = rag?.block ?? null;
  if (rag && ragBlock) {
    console.log(
      `[rag] L1 truy hồi ${rag.hits.length}/${rag.corpusSize} docs · query ${rag.queryTokens.length} token · block ${ragBlock.length} ký tự (~${Math.round(ragBlock.length / 2.5)} token) · log ${rag.logId ?? "(lỗi ghi)"}`
    );
  }

  // ── L2 (Task 142 · F-24 §6) — TRI THỨC DÀI HẠN: 1 lần/chu kỳ ──
  // Corpus tuyển nhiều tuần + hybrid BM25+vector NIM + đồ thị thực thể;
  // tự chữa index ≤32 doc mới bên trong. Fail-soft 2 tầng (NIM → BM25;
  // DB → null) — chu kỳ KHÔNG bao giờ bị chặn vì L2. Thứ tự sau L1,
  // trước XREL — đúng tầng thiết kế (nóng → dài hạn → quan hệ đo được).
  const l2 = await retrieveForCycleL2(true).catch((l2Err) => {
    console.error("[api/agents/run] RAG L2 lỗi (chu kỳ chạy không khối dài hạn):", l2Err);
    return null;
  });
  const l2Block = l2?.block ?? null;
  if (l2 && l2Block) {
    console.log(
      `[rag] L2 truy hồi ${l2.hits.length}/${l2.corpusSize} chunks · vector ${l2.vectorUsed ? "NIM 2048d" : "BM25-only (fail-soft)"} · đồ thị ${l2.graphLines.length} dòng · block ${l2Block.length} ký tự (~${Math.round(l2Block.length / 2.5)} token) · log ${l2.logId ?? "(lỗi ghi)"}`
    );
  }

  // ── M2 (#103) — QUAN HỆ THỊ TRƯỜNG ĐÃ HỌC (XREL): 1 lần/chu kỳ ──
  // Lead-lag + xác suất điều kiện hồi cứu (750 phiên) tiêm cho A2 · A4 ·
  // Chủ tịch. Fail-soft như RAG L1; cache in-process 60s nên ~0 chi phí DB.
  const xrelBlock = await buildXrelPromptBlock().catch((xrelErr) => {
    console.error("[api/agents/run] XREL M2 lỗi (chu kỳ chạy không khối quan hệ):", xrelErr);
    return null;
  });

  return {
    market,
    marketBlock,
    newsBlock,
    flowsBlock,
    openSignalsBlock,
    valuationBlock,
    liquidityBlock,
    macroBlock,
    ragBlock,
    l2Block,
    xrelBlock,
  };
}

/**
 * ── 2. Role prompts cho các agent LLM (dựng SAU đợt A — để tiêm cờ A9) ─
 * P0-4 §3.3 + chốt 8-1b: verdict ≠ PASS → khối "TÍNH TRẠNG DỮ LIỆU" vào
 * prompt 5 agent nghiên cứu LLM + Chủ tịch (ml-forecast là service — 6
 * agent nghiên cứu đủ phủ). PASS → không tiêm (tiết kiệm token).
 */
export function buildResearchPrompts(
  blocks: CycleContextBlocks,
  dqPromptBlock: string | null
): Record<string, { system: string; user: string }> {
  const prompts: Record<string, { system: string; user: string }> = {
    "market-analyst": {
      system: ROLE_PROMPTS["market-analyst"].system,
      user: [blocks.marketBlock, blocks.flowsBlock, ...(blocks.ragBlock ? [blocks.ragBlock] : []), ...(blocks.l2Block ? [blocks.l2Block] : []), ...(blocks.xrelBlock ? [blocks.xrelBlock] : []), ...(dqPromptBlock ? [dqPromptBlock] : [])].join("\n\n"),
    },
    "fair-value": {
      system: ROLE_PROMPTS["fair-value"].system,
      user: [blocks.marketBlock, blocks.valuationBlock, ...(blocks.ragBlock ? [blocks.ragBlock] : []), ...(blocks.l2Block ? [blocks.l2Block] : []), ...(dqPromptBlock ? [dqPromptBlock] : [])].join("\n\n"),
    },
    "news-sentiment": {
      system: ROLE_PROMPTS["news-sentiment"].system,
      user: [blocks.marketBlock, blocks.newsBlock, blocks.flowsBlock, ...(blocks.ragBlock ? [blocks.ragBlock] : []), ...(blocks.l2Block ? [blocks.l2Block] : []), ...(blocks.xrelBlock ? [blocks.xrelBlock] : []), ...(dqPromptBlock ? [dqPromptBlock] : [])].join("\n\n"),
    },
    liquidity: {
      system: ROLE_PROMPTS["liquidity"].system,
      user: [blocks.marketBlock, blocks.liquidityBlock, ...(blocks.ragBlock ? [blocks.ragBlock] : []), ...(blocks.l2Block ? [blocks.l2Block] : []), ...(dqPromptBlock ? [dqPromptBlock] : [])].join("\n\n"),
    },
    "macro-economist": {
      // #126 A20 — bảng điều khiển vĩ mô 3 lớp (lớp 1-2-3) + dòng khối ngoại
      // + XREL (lead-lag quốc tế→VN). Macro block đã chứa tin vĩ mô RSS riêng.
      system: ROLE_PROMPTS["macro-economist"].system,
      user: [blocks.macroBlock, blocks.flowsBlock, ...(blocks.ragBlock ? [blocks.ragBlock] : []), ...(blocks.l2Block ? [blocks.l2Block] : []), ...(blocks.xrelBlock ? [blocks.xrelBlock] : []), ...(dqPromptBlock ? [dqPromptBlock] : [])].join("\n\n"),
    },
    // risk-manager KHÔNG build ở đây — prompt cần khối QUANT của
    // RiskQuantEngine (chạy sau đợt B, trước đợt C — phiên #51 CRB §2)
  };
  return prompts;
}

export interface RiskQuantStep {
  riskQuant: RiskQuantResult | null;
  mlForecastDirection: "UP" | "DOWN" | "FLAT" | null;
}

/**
 * ══ [CRB-0] RISKQUANT ENGINE (phiên #51 — CONTROL_RISK_QUANT_BLUEPRINT v1.1 §2) ══
 * Chạy TRƯỚC đợt C: (a) risk-manager LLM cần con số định lượng trong prompt;
 * (b) exposure A7 cần hạn mức ĐỘNG (CRB-1 hai chiều × CRB-7 hợp nhất min);
 * (c) deterministic ~1s — không phụ thuộc đầu ra LLM. Engine lỗi → giữ hạn
 * mức tĩnh như trước khi có engine (fail-safe §0.1 — VETO vẫn luật cứng).
 * Direction cử tri thứ 6 (ml-forecast) — dùng cho votes engine + Kelly CRB-9
 */
export async function runRiskQuantForCycle(
  waveBServiceResults: (ServiceRunResult | null)[]
): Promise<RiskQuantStep> {
  const mlForecastIdx = WAVE_B_SERVICE_CODES.indexOf("ml-forecast");
  const mlForecastDirRaw =
    mlForecastIdx >= 0
      ? (waveBServiceResults[mlForecastIdx]?.output as { ensemble?: { direction?: unknown } })
          ?.ensemble?.direction
      : undefined;
  // Fixbug #59: annotate union tường minh — TS không tự narrow `unknown`
  // qua chuỗi ===  (để suy luận rộng thành string làm kellyVotes sai kiểu
  // CouncilVote; runtime đã validate đủ — cast sau kiểm tra là an toàn).
  const mlForecastDirection: "UP" | "DOWN" | "FLAT" | null =
    mlForecastDirRaw === "UP" || mlForecastDirRaw === "DOWN" || mlForecastDirRaw === "FLAT"
      ? (mlForecastDirRaw as "UP" | "DOWN" | "FLAT")
      : null;
  let riskQuant: RiskQuantResult | null = null;
  try {
    riskQuant = await runRiskQuantEngine();
    if (riskQuant.ok) {
      console.log(
        `[risk-quant] snapshot ${riskQuant.snapshotId} · proxy=${riskQuant.proxyMode} · vol×${riskQuant.vol.volRatio.toFixed(2)} mult=${riskQuant.vol.mult.toFixed(2)} → hạn động ${riskQuant.dynMaxPositionPct.toFixed(1)}/${riskQuant.dynMaxSectorPct.toFixed(1)}% · CVaR95(5p) ${riskQuant.tail.cvar95Pct.toFixed(2)}% · alerts=${riskQuant.alerts.length} · evidence=${riskQuant.evidence.length} · ${riskQuant.durationMs}ms`
      );
    }
  } catch (quantErr) {
    console.error("[risk-quant] engine lỗi — chu kỳ tiếp tục hạn mức tĩnh:", quantErr);
    riskQuant = null;
  }
  return { riskQuant, mlForecastDirection };
}

/** Prompt risk-manager (A6) — có khối QUANT từ engine (điểm nối §3 CRB v1.1). */
export function buildRiskManagerPrompt(
  blocks: CycleContextBlocks,
  riskQuant: RiskQuantResult | null
): { system: string; user: string } {
  const quantPromptBlock =
    riskQuant?.ok && riskQuant.promptLines.length > 0
      ? [
          "KHỐI QUANT ỦY BAN KIỂM SOÁT ĐỊNH LƯỢNG (CRB v1.1 — deterministic: EWMA/VaR/CVaR/Monte Carlo/HHI/CUSUM):",
          ...riskQuant.promptLines,
          riskQuant.proxyMode
            ? "- LƯU Ý: danh mục chưa đủ dữ liệu — số đo trên rổ proxy top-10 thanh khoản (proxyMode, không phải NAV thật)."
            : "",
        ]
          .filter(Boolean)
          .join("\n")
      : null;
  return {
    system: ROLE_PROMPTS["risk-manager"].system,
    user: [blocks.marketBlock, blocks.flowsBlock, ...(blocks.ragBlock ? [blocks.ragBlock] : []), ...(blocks.l2Block ? [blocks.l2Block] : []), ...(quantPromptBlock ? [quantPromptBlock] : [])].join("\n\n"),
  };
}

export interface ChairmanPromptInput {
  analyses: Map<string, AgentAnalysis>;
  k4: K4Stored;
  dqPromptBlock: string | null;
  bayesView: MarketAssessmentView | null;
  riskQuant: RiskQuantResult | null;
  veto: ControlVerdicts;
}

export interface ChairmanPromptResult {
  userPrompt: string;
  /** Dòng digest 20 agents — tái dùng cho nội dung execution-manager (Đợt F). */
  digestLines: string[];
}

/** ══ ĐỢT E · Chủ tịch Hội đồng — dựng user prompt tổng hợp 20 agents + Bayes ══════ */
export async function buildChairmanUserPrompt(
  blocks: CycleContextBlocks,
  input: ChairmanPromptInput
): Promise<ChairmanPromptResult> {
  const digestLines = AGENT_ROSTER.filter((a) => input.analyses.has(a.code)).map((a) => {
    const an = input.analyses.get(a.code)!;
    const truncated =
      an.content.length > 160 ? `${an.content.slice(0, 160).trimEnd()}…` : an.content;
    return `- ${a.name} (${a.gen1}): ${truncated}`;
  });
  // AUDIT 137 A3 — vetoNotice cũng bật khi control agent lỗi (fail-closed):
  // Chủ tịch phải BIẾT phơi nhiễm/biến margin chưa được kiểm định, không để
  // agent lỗi biến mất khỏi digest như trước (analyses.has bỏ agent fail).
  const vetoNotice = input.veto.vetoBlocked || input.veto.controlUnavailable
    ? [
        "RÀNG BUỘC CỨNG TỪ ỦY BAN KIỂM SOÁT (VETO — bắt buộc tuân thủ):",
        input.veto.vetoExposure
          ? "- Exposure A7 đã VETO: danh mục vượt hạn mức ngành/vị thế — KHÔNG được đưa tín hiệu MUA mới; chỉ được GIỮ hoặc BÁN để cắt tỷ trọng."
          : "",
        input.veto.vetoCompliance
          ? "- Compliance A8 đã VETO: biên margin/chế độ giao dịch hiện không đạt — KHÔNG được đưa bất kỳ tín hiệu mới nào (direction phải là HOLD)."
          : "",
        input.veto.controlUnavailable
          ? `- Ủy ban Kiểm soát CHƯA KIỂM ĐỊNH được chu kỳ này (agent ${input.veto.controlMissing.join(", ")} lỗi chạy — fail-safe audit 137 A3): phơi nhiễm/biến margin chưa rõ — KHÔNG được đưa bất kỳ tín hiệu MUA/BÁN mới nào (direction phải là HOLD).`
          : "",
        "Hệ thống sẽ tự động hạ tầm tín hiệu vi phạm về HOLD — hãy phân tích theo giới hạn này.",
      ].filter(Boolean)
    : [];

  // E-P1-1: block tỷ trọng danh mục hiện tại — dữ liệu chuẩn cho khối
  // đề xuất phân bổ của Chủ tịch (currentPct không bịa — đo từ DB).
  const portfolioWeightsBlock = await buildPortfolioWeightsBlock().catch(() => null);

  // #108 v2.2 — THỊ TRƯỜNG QUỐC TẾ THAM CHIẾU: bảng mã PHI-VN + giá theo
  // đơn vị DB — CHỈ bối cảnh quốc tế (tỷ giá/hàng hoá/cảm xúc qtế đôi lúc
  // ảnh hưởng thị trường VN), KHÔNG đầu tư. Tín hiệu chỉ chọn CP/ETF VN
  // (chính sách trader #108). Fail-soft như RAG/XREL/vision.
  const intlReferenceBlock = await buildIntlReferenceBlock().catch(() => null);

  // #106 C-VISION + #107 — TÀI KHOẢN HỘI ĐỒNG (sandbox K1) + vị thế mọi
  // thị trường + kết quả 7 quyết định gần nhất (D-LEDGER) + ảnh chụp thị
  // trường đa tài sản: Chủ tịch đánh giá TOÀN CỘC lợi ích/tổn thất các quyết
  // định đã đưa ra. Fail-soft như RAG/XREL — 3 đường parity (đây là đường
  // chu kỳ; 2 đường kia ở agent-context.ts single-run + chat).
  const councilVisionBlock = await buildCouncilVisionBlock().catch(() => null);

  const strategistUserPrompt = [
    [blocks.marketBlock, blocks.newsBlock, blocks.flowsBlock, blocks.valuationBlock, blocks.liquidityBlock].join("\n\n"),
    `TÍN HIỆU ĐANG MỞ:\n${blocks.openSignalsBlock}`,
    // L1 (#83) — tri thức truy hồi cho Chủ tịch (ngữ cảnh đối chiếu, không phải bằng chứng)
    ...(blocks.ragBlock ? ["", blocks.ragBlock] : []),
    // L2 (Task 142) — tri thức DÀI HẠN cho Chủ tịch (nhiều tuần + đồ thị — cùng nguyên tắc vô hại hoá)
    ...(blocks.l2Block ? ["", blocks.l2Block] : []),
    // M2 (#103) — quan hệ thị trường đã học cho Chủ tịch (cùng cấp như RAG)
    ...(blocks.xrelBlock ? ["", blocks.xrelBlock] : []),
    // #108 v2.2 — bối cảnh thị trường quốc tế THAM CHIẾU (mã + giá đơn vị DB)
    ...(intlReferenceBlock ? ["", intlReferenceBlock] : []),
    // K4 (#94 — AUTONOMY_BLUEPRINT §7.1): khối GIAO VIỆC — CHỈ khi k4.enabled
    // (tắt → 0 token thêm, prompt y như trước K4). Đặt SAU RAG block đúng
    // thiết kế đã duyệt; yêu cầu Chairman kèm JSON assignTasks cuối output.
    ...(input.k4.enabled ? ["", buildK4ChairmanPromptBlock(input.k4)] : []),
    // P0-4 §3.3 — cờ chất lượng dữ liệu A9 cho Chủ tịch (8-1b: DEGRADED →
    // cờ prompt; SEVERE → cờ + RiskAlert ack-bắt-buộc; KHÔNG hard-stop)
    ...(input.dqPromptBlock ? ["", input.dqPromptBlock] : []),
    // Phiên #34 — khối Bayes: con số định lượng, Chủ tịch PHẢI nhất quán
    ...(input.bayesView ? ["", buildBayesPromptBlock(input.bayesView)] : []),
    // Phiên #51 — CRB v1.1 §6: khối QUANT + gợi ý Kelly ¼ (chỉ tham mưu)
    ...(input.riskQuant?.ok ? ["", buildQuantChairmanBlock(input.riskQuant)] : []),
    // E-P1-1 — tỷ trọng hiện tại cho khối đề xuất phân bổ
    ...(portfolioWeightsBlock ? ["", portfolioWeightsBlock] : []),
    // #106 C-VISION — tầm nhìn toàn cục hội đồng (tài khoản + kết quả quyết định + thí nghiệm)
    ...(councilVisionBlock ? ["", councilVisionBlock] : []),
    "",
    `BÁO CÁO TỪ ${digestLines.length} AGENTS CỦA HỘI ĐỒNG (để tổng hợp):`,
    ...digestLines,
    ...(vetoNotice.length > 0 ? ["", ...vetoNotice] : []),
    "",
    "Hãy tổng hợp toàn bộ, đưa ra MỘT tín hiệu theo đúng định dạng JSON đã yêu cầu, kèm khối allocation (đề xuất phân bổ danh mục — chỉ tham mưu).",
  ].join("\n");

  return { userPrompt: strategistUserPrompt, digestLines };
}
