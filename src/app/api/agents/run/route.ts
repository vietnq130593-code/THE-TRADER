import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";
import { updateAgentHealth } from "@/lib/health";
import { callLlmWithRetry, estimateTokens, llmCostUsd } from "@/lib/llm";
import { reapStaleAgentRuns } from "@/lib/agent-ratelimit";
import { expireDueSignals } from "@/lib/signal-execution";
import {
  ROLE_PROMPTS,
  buildMarketBlock,
  buildNewsBlock,
  buildFlowsBlock,
  buildOpenSignalsBlock,
  buildValuationBlock,
  buildLiquidityBlock,
  buildPortfolioWeightsBlock,
} from "@/lib/agent-context";
import { AGENT_ROSTER } from "@/lib/agent-roster";
// E-P1-1 (EXECUTION_OPS_BLUEPRINT v1.2): parse khối đề xuất phân bổ của Chủ tịch.
import {
  parseAllocationProposal,
  bumpAllocationParseFail,
  formatAllocationForMessage,
  type AllocationProposal,
} from "@/lib/exec/allocation";
import {
  runServiceAgent,
  type ServiceRunContext,
  type ServiceRunResult,
} from "@/lib/agent-service-runs";
import {
  dataQualityPromptBlock,
  extractVerdict,
  type DataQualityVerdict,
} from "@/lib/data-quality";
import { buildEvidenceBundle, type LlmVoteInput } from "@/lib/bayes/evidence";
import { synthesizeMarketAssessment } from "@/lib/bayes/synthesis";
import { saveMarketAssessment, attachCycleRunId, attachRiskQuantKelly } from "@/lib/bayes/persist";
import { maybeAutoEnableConsensus } from "@/lib/consensus";
import {
  runRiskQuantEngine,
  toRiskQuantView,
  attachKellyHint,
  type RiskQuantResult,
} from "@/lib/risk/engine";
import { fractionalKelly, alignedCouncilP, type CouncilVote } from "@/lib/risk/sizing";
import type { CycleAssessmentSummary, MarketAssessmentView } from "@/lib/types";

export const dynamic = "force-dynamic";
// 300s: 6 LLM tuần tự × timeout 45s (llm.ts) + 17 service ~0.5s + biên độ —
// trước đây 120s dễ bị kill giữa chu kỳ nếu gateway LLM đình trệ (AUD-CODE #8)
export const maxDuration = 300;

/**
 * POST /api/agents/run — chu kỳ phân tích đầy đủ 23 AGENTS, 6 ĐỢT (phiên #34):
 *
 *  ĐỢT A · Nền tảng dữ liệu (4 service — 0 LLM, 3 nhịp con §3.3 — #57):
 *    nhịp 1: S0 data-collector ∥ S2 feature-store → nhịp 2: A9 data-integrity
 *    (6 phép kiểm → DataQualityVerdict; SEVERE → RiskAlert ack) → nhịp 3: S1
 *    notification-officer (digest có dòng chất lượng dữ liệu — P0-7). Verdict
 *    ≠ PASS → khối TÍNH TRẠNG DỮ LIỆU vào prompt nghiên cứu + Chủ tịch (P0-4).
 *  ĐỢT B · Hội đồng Nghiên cứu + Phòng Học máy:
 *    service song song (8): ml-forecast · backtest · learning-rag · rl-gym ·
 *    rl-policy · dl-trainer · rl-trainer · model-registry
 *    LLM tuần tự (4): market-analyst · fair-value · news-sentiment · liquidity
 *    (mỗi agent LLM trả thêm assessment JSON {direction, confidence, evidence})
 *  ĐỢT C · Ủy ban Kiểm soát (VETO): risk-manager (LLM) + exposure · compliance
 *    (service, chạy song song với risk-manager)
 *  ĐỢT D · BỘ TỔNG HỢP BAYES (mới — phiên #34, 0 LLM ~1-2s): buildEvidenceBundle
 *    (breadth/lexicon tin 24h/flows/Holt/regime + assessment JSON của 5 agent
 *    LLM) → synthesizeMarketAssessment (log-odds 3 bậc nhân quả) → lưu bảng
 *    MarketAssessment. Lỗi tổng hợp KHÔNG làm hỏng chu kỳ (log + bỏ qua).
 *  ĐỢT E · Chủ tịch Hội đồng: portfolio-strategist (LLM) tổng hợp TOÀN BỘ
 *    báo cáo 20 agents + khối "BỘ TỔNG HỢP BAYES" (con số định lượng — phải
 *    nhất quán) → MỘT tín hiệu
 *  ĐỢT F · Thực thi & hậu cần: execution-manager (ghi nhận tín hiệu, KHÔNG tự
 *    tạo lệnh — chờ trader phê duyệt §4.5/§4.9) + settlement · cash-management
 *
 *  LLM provider: src/lib/llm.ts — Opencode Zen space-bunny-free khi có key
 *  (chạy được ngoài sandbox, free-tier $0), GLM-4.6 khi trong sandbox.
 *  Service agents deterministic từ DB — không tốn tokens.
 */

/** F-203 (audit 19-b): rate-limit chu kỳ — chống spam chi phí LLM không giới hạn. */
const CYCLE_COOLDOWN_MS = 60_000;
let lastCycleStartedAt = 0;

// ── Sơ đồ đợt (tất cả code đều nằm trong AGENT_ROSTER 23 agents) ──
// Đợt A chia 3 nhịp con (§3.3 — #57): WAVE_A_BEAT1 ∥ → A9 → S1 (đọc verdict)
const WAVE_A_CODES = ["data-collector", "notification-officer", "feature-store", "data-integrity"] as const;
const WAVE_B_SERVICE_CODES = [
  "ml-forecast", "backtest", "learning-rag", "rl-gym",
  "rl-policy", "dl-trainer", "rl-trainer", "model-registry",
] as const;
const WAVE_B_LLM_CODES = ["market-analyst", "fair-value", "news-sentiment", "liquidity"] as const;
const WAVE_C_LLM_CODES = ["risk-manager"] as const;
const WAVE_C_SERVICE_CODES = ["exposure", "compliance"] as const;
const CHAIRMAN_CODE = "portfolio-strategist";
const WAVE_E_SERVICE_CODES = ["settlement", "cash-management"] as const;
const EXECUTOR_CODE = "execution-manager";
const ALL_CODES = AGENT_ROSTER.map((a) => a.code);

function round100(v: number): number {
  return Math.max(0, Math.round(v / 100) * 100);
}

/** Robustly extract the first JSON object from an LLM response. */
function parseJsonBlock<T extends Record<string, unknown>>(raw: string): Partial<T> | null {
  const text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const brace = candidate.match(/\{[\s\S]*\}/);
  if (!brace) return null;
  try {
    return JSON.parse(brace[0]) as Partial<T>;
  } catch {
    return null;
  }
}

/**
 * Trích trường "assessment" từ JSON response LLM (phiên #34):
 * {direction: UP|DOWN|FLAT, confidence: 0..1, evidence: [chuỗi ngắn]}.
 * Parse thất bại → fallback từ sentiment (bullish→UP 0.6, bearish→DOWN 0.6,
 * neutral→FLAT 0.6); không có gì → null (agent không tham gia phiếu).
 */
function parseAssessment(
  parsed: Record<string, unknown> | null | undefined,
  sentiment: AgentAnalysis["sentiment"]
): AgentAssessment | null {
  const raw = parsed?.assessment;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const a = raw as Record<string, unknown>;
    const dir = typeof a.direction === "string" ? a.direction.trim().toUpperCase() : "";
    if (dir === "UP" || dir === "DOWN" || dir === "FLAT") {
      const confNum = Number(a.confidence);
      const confidence = Number.isFinite(confNum) ? Math.max(0, Math.min(1, confNum)) : 0.6;
      const evidence = Array.isArray(a.evidence)
        ? a.evidence
            .filter((e): e is string => typeof e === "string" && e.trim().length > 0)
            .slice(0, 5)
            .map((e) => e.trim().slice(0, 120))
        : [];
      return { direction: dir, confidence, evidence };
    }
  }
  if (sentiment === "bullish") return { direction: "UP", confidence: 0.6, evidence: [] };
  if (sentiment === "bearish") return { direction: "DOWN", confidence: 0.6, evidence: [] };
  if (sentiment === "neutral") return { direction: "FLAT", confidence: 0.6, evidence: [] };
  return null;
}

interface AgentAnalysis {
  content: string;
  reasoning: string;
  sentiment: "bullish" | "bearish" | "neutral" | null;
  /** Phiên #34 — assessment JSON có cấu trúc từ LLM (bằng chứng cho Bộ tổng hợp Bayes). */
  assessment: AgentAssessment | null;
}

/** Assessment định lượng của agent LLM (đầu vào Bayes evidence). */
interface AgentAssessment {
  direction: "UP" | "DOWN" | "FLAT";
  confidence: number;
  evidence: string[];
}

interface StrategistSignal {
  symbol: string;
  direction: "BUY" | "SELL" | "HOLD";
  confidence: "LOW" | "MEDIUM" | "HIGH";
  score: number;
  rationale: string;
  targetPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
}

interface StrategistResult {
  summary: string;
  recommendation: string;
  confidence: "LOW" | "MEDIUM" | "HIGH";
  signal: StrategistSignal | null;
  /** E-P1-1: khối đề xuất phân bổ danh mục (narrative + bảng) — chỉ tham mưu. */
  allocation: AllocationProposal | null;
}

/** Persist an agent run + restore agent status + update health. */
async function persistRun(
  agentId: string,
  success: boolean,
  startedAt: number,
  tokensIn: number,
  tokensOut: number,
  output: string | null,
  error: string | null
): Promise<{ id: string; durationMs: number }> {
  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt;
  const run = await db.agentRun.create({
    data: {
      agentId,
      taskStatus: success ? "COMPLETED" : "FAILED",
      startedAt: new Date(startedAt),
      finishedAt,
      durationMs,
      tokensIn,
      tokensOut,
      costUsd: llmCostUsd(tokensIn, tokensOut), // space-bunny-free = $0; GLM-4.6 sandbox tính thật
      output,
      error,
    },
  });
  await db.agent.update({
    where: { id: agentId },
    data: { status: success ? "IDLE" : "ERROR", lastRunAt: finishedAt },
  });
  await updateAgentHealth(agentId, success, durationMs, run.id); // F-113: loại run vừa tạo khỏi P50
  return { id: run.id, durationMs };
}

async function persistMessage(
  agentId: string,
  content: string,
  reasoning: string | null,
  sentiment: string | null
) {
  return db.agentMessage.create({
    data: {
      fromAgentId: agentId,
      broadcast: true,
      direction: "AGENT", // PHASE3_BLUEPRINT §4.1 — tin chu kỳ luôn do agent phát
      content,
      reasoning: reasoning || null,
      sentiment: sentiment ?? null,
    },
  });
}

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
  // B9 — khối CỔNG ĐỒNG THUẬN 80% (6 cử tri — chairman bắt buộc tôn trọng)
  const c = view.consensus;
  const consensusLines = c
    ? [
        "",
        "CỔNG ĐỒNG THUẬN 80% (6 cử tri nghiên cứu — BẮT BUỘC TÔN TRỌNG khi ra tín hiệu):",
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

export async function POST() {
  // F-203 (audit 19-b): guard 60s giữa 2 chu kỳ — trả 429 kèm thời gian chờ còn lại
  const now = Date.now();
  const sinceLast = now - lastCycleStartedAt;
  if (sinceLast < CYCLE_COOLDOWN_MS) {
    return NextResponse.json(
      {
        error: `Chu kỳ agent trước đó chạy cách đây ${Math.floor(sinceLast / 1000)}s. Vui lòng đợi thêm chút để tránh tốn chi phí LLM.`,
        retryAfterSeconds: Math.ceil((CYCLE_COOLDOWN_MS - sinceLast) / 1000),
      },
      // F-210b (audit 19-b): header chuẩn Retry-After để client backoff đúng
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil((CYCLE_COOLDOWN_MS - sinceLast) / 1000)),
        },
      }
    );
  }

  const cycleStart = Date.now();

  // AUD-CODE #5 + #3: watchdog dọn run/agent kẹt RUNNING (> 5 phút) TRƯỚC khi
  // load — agent kẹt do crash cũ không được phép chặn chu kỳ vĩnh viễn
  await reapStaleAgentRuns();

  // ── Load toàn bộ 23 agents ───────────────────────────────────────
  const agents = await db.agent.findMany({
    where: { code: { in: ALL_CODES } },
    select: { id: true, code: true, config: true, healthScore: true, status: true },
  });
  const byCode = new Map(agents.map((a) => [a.code, a]));
  const missing = ALL_CODES.filter((c) => !byCode.get(c));
  if (missing.length > 0) {
    // AUD-CODE #10: KHÔNG set cooldown khi fail sớm ở bước validate —
    // user không phải chờ 60s vô ích vì lỗi cấu hình (thiếu agent)
    return NextResponse.json(
      {
        error: `Thiếu agent trong hệ thống: ${missing.join(", ")}. Chạy "bun prisma/expand-agents.ts" để đồng bộ roster 23 agents.`,
      },
      { status: 404 }
    );
  }

  // AUD-CODE #3: guard chồng lấn — chu kỳ không đè lên single-run đang chạy
  // (status đã load SAU khi watchdog dọn nên không có giả âm/ giả dương)
  const runningAgents = agents.filter((a) => a.status === "RUNNING");
  if (runningAgents.length > 0) {
    return NextResponse.json(
      {
        error: `Có ${runningAgents.length} agent đang chạy lẻ (${runningAgents
          .map((a) => a.code)
          .slice(0, 3)
          .join(", ")}…). Chờ hoàn tất hoặc thử lại sau — tránh chạy chồng lẫn tốn 2× chi phí LLM.`,
        retryAfterSeconds: 60,
      },
      { status: 409, headers: { "Retry-After": "60" } }
    );
  }

  // AUD-CODE #1 (P1): sweep tín hiệu hết hạn trước mỗi chu kỳ — prompt Chủ tịch
  // và notification-officer chỉ thấy tín hiệu còn hạn
  await expireDueSignals();

  // AUD-CODE #10: cooldown chỉ tính từ lúc chu kỳ THẬT SỰ bắt đầu (qua validate)
  lastCycleStartedAt = now;

  // Mark every agent RUNNING while the cycle executes
  await db.agent.updateMany({
    where: { id: { in: agents.map((a) => a.id) } },
    data: { status: "RUNNING" },
  });

  // Kết quả phân tích theo code (đưa vào digest cho Chủ tịch)
  const analyses = new Map<string, AgentAnalysis>();
  const createdMessages: {
    id: string;
    fromAgentId: string;
    content: string;
    reasoning: string | null;
    sentiment: string | null;
  }[] = [];
  const failures: string[] = [];

  /** Chạy + persist MỘT service agent (deterministic) — trả về result để đọc verdict VETO.
   *  ctx (phiên #51 — CRB): truyền kết quả RiskQuantEngine (exposure A7 đọc
   *  hạn mức động). ctx (P0-7 — #57): truyền verdict A9 cho S1 (đợt A nhịp 3). */
  async function runOneServiceAgent(
    code: string,
    ctx?: ServiceRunContext
  ): Promise<ServiceRunResult | null> {
    const agent = byCode.get(code)!;
    const startedAt = Date.now();
    try {
      const result: ServiceRunResult = await runServiceAgent(code, ctx);
      await persistRun(
        agent.id,
        true,
        startedAt,
        0,
        0,
        JSON.stringify(result.output),
        null
      );
      const message = await persistMessage(agent.id, result.content, result.reasoning, result.sentiment);
      createdMessages.push({
        id: message.id,
        fromAgentId: agent.id,
        content: result.content,
        reasoning: result.reasoning || null,
        sentiment: result.sentiment,
      });
      analyses.set(code, {
        content: result.content,
        reasoning: result.reasoning,
        sentiment: result.sentiment,
        assessment: null, // service agents không có assessment JSON (phiên #34)
      });
      return result;
    } catch (err) {
      failures.push(code);
      console.error(`[api/agents/run] service agent ${code} failed:`, err);
      await persistRun(
        agent.id,
        false,
        startedAt,
        0,
        0,
        null,
        err instanceof Error ? err.message : "Lỗi dịch vụ."
      ).catch(() => undefined);
      return null;
    }
  }

  try {
    // ── 1. Snapshot — builder dùng chung (PHASE3_BLUEPRINT §4.6) ────
    const [market, newsBlock, flowsBlock, openSignalsBlock, valuationBlock, liquidityBlock] =
      await Promise.all([
        buildMarketBlock(),
        buildNewsBlock(),
        buildFlowsBlock(),
        buildOpenSignalsBlock(),
        buildValuationBlock(),
        buildLiquidityBlock(),
      ]);
    const marketBlock = market.block;

    // ══ ĐỢT A · Nền tảng dữ liệu — 3 NHỊP CON (§3.3 blueprint v1.1 — #57) ══
    // Tránh phụ thuộc vòng trong cùng đợt song song: nhịp 1: S0 ∥ S2 →
    // nhịp 2: A9 (readiness do chính A9 tính qua FeatureContract — cùng thư
    // viện với S2 nên cùng số, KHÔNG phụ thuộc output S2 cùng chu kỳ) →
    // nhịp 3: S1 (đọc verdict A9 VỪA LƯU cùng chu kỳ — P0-7). Verdict A9 +
    // readiness S2 được lưu TRƯỚC khi Wave B bắt đầu.
    await Promise.all(
      (["data-collector", "feature-store"] as const).map((code) => runOneServiceAgent(code))
    );
    const dqRun = await runOneServiceAgent("data-integrity");
    const dqVerdict: DataQualityVerdict | null = dqRun ? extractVerdict(dqRun.output) : null;
    await runOneServiceAgent("notification-officer", { dataQuality: dqVerdict });

    // ── 2. Role prompts cho các agent LLM (dựng SAU đợt A — để tiêm cờ A9) ─
    // P0-4 §3.3 + chốt 8-1b: verdict ≠ PASS → khối "TÍNH TRẠNG DỮ LIỆU" vào
    // prompt 4 agent nghiên cứu LLM + Chủ tịch (ml-forecast là service — 5
    // agent nghiên cứu đủ phủ). PASS → không tiêm (tiết kiệm token).
    const dqPromptBlock =
      dqVerdict && dqVerdict.level !== "PASS" ? dataQualityPromptBlock(dqVerdict) : null;
    const prompts: Record<string, { system: string; user: string }> = {
      "market-analyst": {
        system: ROLE_PROMPTS["market-analyst"].system,
        user: [marketBlock, flowsBlock, ...(dqPromptBlock ? [dqPromptBlock] : [])].join("\n\n"),
      },
      "fair-value": {
        system: ROLE_PROMPTS["fair-value"].system,
        user: [marketBlock, valuationBlock, ...(dqPromptBlock ? [dqPromptBlock] : [])].join("\n\n"),
      },
      "news-sentiment": {
        system: ROLE_PROMPTS["news-sentiment"].system,
        user: [marketBlock, newsBlock, flowsBlock, ...(dqPromptBlock ? [dqPromptBlock] : [])].join("\n\n"),
      },
      liquidity: {
        system: ROLE_PROMPTS["liquidity"].system,
        user: [marketBlock, liquidityBlock, ...(dqPromptBlock ? [dqPromptBlock] : [])].join("\n\n"),
      },
      // risk-manager KHÔNG build ở đây — prompt cần khối QUANT của
      // RiskQuantEngine (chạy sau đợt B, trước đợt C — phiên #51 CRB §2)
    };

    // ══ ĐỢT B · Nghiên cứu + Học máy ═══════════════════════════════
    // Service agents (8) song song trước — nhanh, 0 LLM. Giữ kết quả để
    // đọc direction ml-forecast (cử tri thứ 6 — đầu vào votes cho Kelly CRB-9)
    const waveBServiceResults = await Promise.all(
      WAVE_B_SERVICE_CODES.map((code) => runOneServiceAgent(code))
    );

    // LLM research agents (4) tuần tự — tôn trọng rate-limit gateway
    for (const code of WAVE_B_LLM_CODES) {
      const agent = byCode.get(code)!;
      const startedAt = Date.now();
      try {
        const { raw, tokensIn, tokensOut } = await callLlmWithRetry(
          prompts[code].system,
          prompts[code].user
        );
        const parsed = parseJsonBlock<{
          content: unknown;
          reasoning: unknown;
          sentiment: unknown;
          assessment: unknown;
        }>(raw);
        const content =
          typeof parsed?.content === "string" && parsed.content.trim()
            ? parsed.content.trim()
            : raw.trim();
        const reasoning =
          typeof parsed?.reasoning === "string" ? parsed.reasoning.trim() : "";
        const sentimentRaw =
          typeof parsed?.sentiment === "string" ? parsed.sentiment.toLowerCase() : "";
        const sentiment: AgentAnalysis["sentiment"] =
          sentimentRaw === "bullish" || sentimentRaw === "bearish" || sentimentRaw === "neutral"
            ? (sentimentRaw as AgentAnalysis["sentiment"])
            : null;
        // Phiên #34 — assessment JSON làm bằng chứng Bayes (fallback từ sentiment)
        const assessment = parseAssessment(parsed, sentiment);

        await persistRun(
          agent.id,
          true,
          startedAt,
          tokensIn,
          tokensOut,
          JSON.stringify({ content, reasoning, sentiment, assessment }),
          null
        );
        const message = await persistMessage(agent.id, content, reasoning, sentiment);
        createdMessages.push({
          id: message.id,
          fromAgentId: agent.id,
          content,
          reasoning: reasoning || null,
          sentiment,
        });
        analyses.set(code, { content, reasoning, sentiment, assessment });
      } catch (err) {
        failures.push(code);
        console.error(`[api/agents/run] agent ${code} failed:`, err);
        await persistRun(
          agent.id,
          false,
          startedAt,
          estimateTokens(prompts[code].system + prompts[code].user),
          0,
          null,
          err instanceof Error ? err.message : "Lỗi không xác định."
        ).catch(() => undefined);
      }
    }

    // Cả 4 agent nghiên cứu LLM đều lỗi → không thể tổng hợp
    if (WAVE_B_LLM_CODES.every((c) => failures.includes(c))) {
      // F-205 (audit 19-b): không để các agent sau kẹt RUNNING khi chu kỳ bỏ cuộc sớm
      await db.agent
        .updateMany({
          where: { code: { in: ALL_CODES.filter((c) => !failures.includes(c) && !analyses.has(c)) } },
          data: { status: "IDLE" },
        })
        .catch(() => undefined);
      return NextResponse.json(
        {
          error:
            "Cả 4 agent nghiên cứu (Market/Fair Value/News/Liquidity) đều lỗi lúc này (mô hình AI không phản hồi). Vui lòng thử lại sau ít phút.",
          failures,
        },
        { status: 502 }
      );
    }

    // ══ [CRB-0] RISKQUANT ENGINE (phiên #51 — CONTROL_RISK_QUANT_BLUEPRINT v1.1 §2) ══
    // Chạy TRƯỚC đợt C: (a) risk-manager LLM cần con số định lượng trong prompt;
    // (b) exposure A7 cần hạn mức ĐỘNG (CRB-1 hai chiều × CRB-7 hợp nhất min);
    // (c) deterministic ~1s — không phụ thuộc đầu ra LLM. Engine lỗi → giữ hạn
    // mức tĩnh như trước khi có engine (fail-safe §0.1 — VETO vẫn luật cứng).
    // Direction cử tri thứ 6 (ml-forecast) — dùng cho votes engine + Kelly CRB-9
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

    // Prompt risk-manager (A6) — có khối QUANT từ engine (điểm nối §3 CRB v1.1)
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
    prompts["risk-manager"] = {
      system: ROLE_PROMPTS["risk-manager"].system,
      user: [marketBlock, flowsBlock, ...(quantPromptBlock ? [quantPromptBlock] : [])].join("\n\n"),
    };

    // ══ ĐỢT C · Ủy ban Kiểm soát (VETO) — risk LLM + 2 service ═════
    const controlResults = await Promise.all([
      (async () => {
        const code = "risk-manager";
        const agent = byCode.get(code)!;
        const startedAt = Date.now();
        try {
          const { raw, tokensIn, tokensOut } = await callLlmWithRetry(
            prompts[code].system,
            prompts[code].user
          );
          const parsed = parseJsonBlock<{
            content: unknown;
            reasoning: unknown;
            assessment: unknown;
          }>(raw);
          const content =
            typeof parsed?.content === "string" && parsed.content.trim()
              ? parsed.content.trim()
              : raw.trim();
          const reasoning =
            typeof parsed?.reasoning === "string" ? parsed.reasoning.trim() : "";
          // Phiên #34 — risk-manager cũng trả assessment (phiếu cho Bayes)
          const assessment = parseAssessment(parsed, null);
          await persistRun(
            agent.id,
            true,
            startedAt,
            tokensIn,
            tokensOut,
            JSON.stringify({ content, reasoning, assessment }),
            null
          );
          const message = await persistMessage(agent.id, content, reasoning, null);
          createdMessages.push({
            id: message.id,
            fromAgentId: agent.id,
            content,
            reasoning: reasoning || null,
            sentiment: null,
          });
          analyses.set(code, { content, reasoning, sentiment: null, assessment });
        } catch (err) {
          failures.push(code);
          console.error(`[api/agents/run] agent ${code} failed:`, err);
          await persistRun(
            agent.id,
            false,
            startedAt,
            estimateTokens(prompts[code].system + prompts[code].user),
            0,
            null,
            err instanceof Error ? err.message : "Lỗi không xác định."
          ).catch(() => undefined);
        }
      })(),
      ...WAVE_C_SERVICE_CODES.map((code) => runOneServiceAgent(code, { riskQuant })),
    ]);

    // ══ AUD-CODE #6: ENFORCE VETO — Ủy ban Kiểm soát có quyền phủ quyết THẠT ══
    // Trước đây verdict "VETO" của exposure/compliance chỉ là text trong digest —
    // Chủ tịch (LLM) có thể bỏ qua. Giờ ràng buộc cứng đúng kiến trúc Gen-1 §4.1:
    //  - exposure VETO (danh mục vượt hạn mức) → chặn tín hiệu MUA (tăng phơi nhiễm);
    //  - compliance VETO (biên margin âm / mode chưa cấu hình) → chặn MỌI tín hiệu mới.
    const controlOutputs = WAVE_C_SERVICE_CODES.map(
      (code, i) => ({ code, result: controlResults[i + 1] }) // index 0 = risk-manager
    );
    const vetoExposure = controlOutputs.some(
      (c) =>
        c.code === "exposure" &&
        typeof c.result?.output?.verdict === "string" &&
        (c.result.output.verdict as string).startsWith("VETO")
    );
    const vetoCompliance = controlOutputs.some(
      (c) =>
        c.code === "compliance" &&
        typeof c.result?.output?.verdict === "string" &&
        (c.result.output.verdict as string).startsWith("VETO")
    );
    const vetoBlocked = vetoExposure || vetoCompliance;

    // ══ ĐỢT D · BỘ TỔNG HỢP BAYES (phiên #34 — 0 LLM, deterministic ~1-2s) ══
    // Sau Ủy ban Kiểm soát, TRƯỚC Chủ tịch: tổng hợp mọi bằng chứng định lượng
    // (breadth/lexicon/flows/Holt/regime + assessment JSON của 5 agent LLM +
    // bằng chứng quant CRB) theo log-odds 3 bậc nhân quả → posterior + drivers
    // + narrative → lưu bảng MarketAssessment. Lỗi tổng hợp KHÔNG được làm hỏng
    // chu kỳ (spec #34): log + assessment = null, Chủ tịch vẫn đọc digest như cũ.
    let assessmentSummary: CycleAssessmentSummary | null = null;
    let bayesView: MarketAssessmentView | null = null;
    // Phiếu LLM 5 cử tri — dùng cho Bayes (llm-vote) + Kelly CRB-9 (hướng đồng thuận)
    const llmVotes: LlmVoteInput[] = [...WAVE_B_LLM_CODES, ...WAVE_C_LLM_CODES].flatMap(
      (code) => {
        const an = analyses.get(code);
        if (!an?.assessment) return [];
        return [
          {
            code,
            direction: an.assessment.direction,
            confidence: an.assessment.confidence,
            evidence: an.assessment.evidence,
          },
        ];
      }
    );
    try {
      const bundle = await buildEvidenceBundle({
        llmVotes,
        veto: vetoBlocked
          ? {
              blocked: true,
              reason: vetoCompliance
                ? "Compliance A8 VETO — biên margin/chế độ giao dịch hiện không đạt"
                : "Exposure A7 VETO — danh mục vượt hạn mức phơi nhiễm",
            }
          : { blocked: false, reason: null },
        // Phiên #51 — CRB §0.6/T7.5: bằng chứng quant vào Bayes ĐÚNG MỘT LẦN
        // (source quant-tail:/quant-drift: — không thêm cử tri thứ 7 cổng 80%)
        quantEvidence: riskQuant?.ok ? riskQuant.evidence : undefined,
      });
      // CRB §7: khối quant vào detail.riskQuant của assessment (UI Tổng hợp)
      if (riskQuant?.ok) {
        bundle.riskQuant = toRiskQuantView(riskQuant);
      }
      const draft = synthesizeMarketAssessment(bundle);
      bayesView = await saveMarketAssessment(bundle, draft, { source: "cycle" });
      // B9 — shadow log "đã-sẽ-chặn" + auto-enable enforcement sau ≥10 chu kỳ
      // shadow (user duyệt trước + tái xác nhận dải 50–79,9% = HOLD cứng — #38)
      if (bayesView.consensus) {
        if (bayesView.consensus.wouldBlock) {
          console.log(
            `[consensus] shadow: ĐÃ-SẼ-CHẶN — gate ${bayesView.consensus.gate} · ratio ${(bayesView.consensus.ratio * 100).toFixed(1)}% · ${bayesView.consensus.present}/6 cử tri — tín hiệu mới sẽ bị ép GIỮ khi bật enforcement`
          );
        }
        try {
          const autoRes = await maybeAutoEnableConsensus();
          if (autoRes.reason) console.log(`[consensus] ${autoRes.reason}`);
        } catch {
          // AppSetting lỗi → giữ shadow, không làm hỏng chu kỳ
        }
      }
      assessmentSummary = {
        id: bayesView.id,
        pUp: bayesView.pUp,
        pDown: bayesView.pDown,
        pFlat: bayesView.pFlat,
        marketDirection: bayesView.marketDirection,
        confidence: bayesView.confidence,
        disagreement: bayesView.disagreement,
        evidenceCount: bayesView.evidenceCount,
        narrative: bayesView.narrative,
      };
    } catch (bayesErr) {
      console.error(
        "[api/agents/run] Bộ tổng hợp Bayes lỗi (chu kỳ tiếp tục, không assessment):",
        bayesErr
      );
      assessmentSummary = null;
      bayesView = null;
    }

    // ══ ĐỢT E · Chủ tịch Hội đồng — tổng hợp 20 agents + Bayes ══════
    const digestLines = AGENT_ROSTER.filter((a) => analyses.has(a.code)).map((a) => {
      const an = analyses.get(a.code)!;
      const truncated =
        an.content.length > 160 ? `${an.content.slice(0, 160).trimEnd()}…` : an.content;
      return `- ${a.name} (${a.gen1}): ${truncated}`;
    });
    const strategistAgent = byCode.get(CHAIRMAN_CODE)!;
    const vetoNotice = vetoBlocked
      ? [
          "RÀNG BUỘC CỨNG TỪ ỦY BAN KIỂM SOÁT (VETO — bắt buộc tuân thủ):",
          vetoExposure
            ? "- Exposure A7 đã VETO: danh mục vượt hạn mức ngành/vị thế — KHÔNG được đưa tín hiệu MUA mới; chỉ được GIỮ hoặc BÁN để cắt tỷ trọng."
            : "",
          vetoCompliance
            ? "- Compliance A8 đã VETO: biên margin/chế độ giao dịch hiện không đạt — KHÔNG được đưa bất kỳ tín hiệu mới nào (direction phải là HOLD)."
            : "",
          "Hệ thống sẽ tự động hạ tầm tín hiệu vi phạm về HOLD — hãy phân tích theo giới hạn này.",
        ].filter(Boolean)
      : [];

    // E-P1-1: block tỷ trọng danh mục hiện tại — dữ liệu chuẩn cho khối
    // đề xuất phân bổ của Chủ tịch (currentPct không bịa — đo từ DB).
    const portfolioWeightsBlock = await buildPortfolioWeightsBlock().catch(() => null);

    const strategistUserPrompt = [
      [marketBlock, newsBlock, flowsBlock, valuationBlock, liquidityBlock].join("\n\n"),
      `TÍN HIỆU ĐANG MỞ:\n${openSignalsBlock}`,
      // P0-4 §3.3 — cờ chất lượng dữ liệu A9 cho Chủ tịch (8-1b: DEGRADED →
      // cờ prompt; SEVERE → cờ + RiskAlert ack-bắt-buộc; KHÔNG hard-stop)
      ...(dqPromptBlock ? ["", dqPromptBlock] : []),
      // Phiên #34 — khối Bayes: con số định lượng, Chủ tịch PHẢI nhất quán
      ...(bayesView ? ["", buildBayesPromptBlock(bayesView)] : []),
      // Phiên #51 — CRB v1.1 §6: khối QUANT + gợi ý Kelly ¼ (chỉ tham mưu)
      ...(riskQuant?.ok ? ["", buildQuantChairmanBlock(riskQuant)] : []),
      // E-P1-1 — tỷ trọng hiện tại cho khối đề xuất phân bổ
      ...(portfolioWeightsBlock ? ["", portfolioWeightsBlock] : []),
      "",
      `BÁO CÁO TỪ ${digestLines.length} AGENTS CỦA HỘI ĐỒNG (để tổng hợp):`,
      ...digestLines,
      ...(vetoNotice.length > 0 ? ["", ...vetoNotice] : []),
      "",
      "Hãy tổng hợp toàn bộ, đưa ra MỘT tín hiệu theo đúng định dạng JSON đã yêu cầu, kèm khối allocation (đề xuất phân bổ danh mục — chỉ tham mưu).",
    ].join("\n");

    const strategistStart = Date.now();
    let strategist: StrategistResult | null = null;
    let strategistRunId = "";
    // CRB-9 — kellyHint của chu kỳ (null = bỏ/skip — tham mưu)
    let kellyHintF: number | null = null;
    try {
      const { raw, tokensIn, tokensOut } = await callLlmWithRetry(
        ROLE_PROMPTS[CHAIRMAN_CODE].system,
        strategistUserPrompt
      );
      const parsed = parseJsonBlock<{
        summary: unknown;
        recommendation: unknown;
        confidence: unknown;
        signal: unknown;
        allocation: unknown;
      }>(raw);
      const summary =
        typeof parsed?.summary === "string" && parsed.summary.trim()
          ? parsed.summary.trim()
          : raw.trim();
      const recommendation =
        typeof parsed?.recommendation === "string" ? parsed.recommendation.trim() : "";
      const confidenceRaw =
        typeof parsed?.confidence === "string" ? parsed.confidence.toUpperCase() : "MEDIUM";
      const confidence: StrategistResult["confidence"] =
        confidenceRaw === "HIGH" || confidenceRaw === "LOW" ? confidenceRaw : "MEDIUM";

      let signal: StrategistSignal | null = null;
      const s = parsed?.signal as Partial<StrategistSignal> | null | undefined;
      if (s && typeof s.symbol === "string" && typeof s.direction === "string") {
        const direction =
          s.direction === "BUY" || s.direction === "SELL" || s.direction === "HOLD"
            ? s.direction
            : "HOLD";
        const score = Math.max(0, Math.min(100, Number(s.score ?? 50) || 0));
        const conf: StrategistSignal["confidence"] =
          typeof s.confidence === "string" &&
          ["LOW", "MEDIUM", "HIGH"].includes(s.confidence)
            ? (s.confidence as StrategistSignal["confidence"])
            : confidence;
        signal = {
          symbol: s.symbol.trim().toUpperCase(),
          direction,
          confidence: conf,
          score,
          rationale:
            typeof s.rationale === "string" && s.rationale.trim()
              ? s.rationale.trim()
              : recommendation || summary,
          targetPrice:
            s.targetPrice != null && Number.isFinite(Number(s.targetPrice))
              ? round100(Number(s.targetPrice))
              : null,
          stopLoss:
            s.stopLoss != null && Number.isFinite(Number(s.stopLoss))
              ? round100(Number(s.stopLoss))
              : null,
          takeProfit:
            s.takeProfit != null && Number.isFinite(Number(s.takeProfit))
              ? round100(Number(s.takeProfit))
              : null,
        };
      }

      // ── E-P1-1: parse khối allocation (đề xuất phân bổ) — AN TOÀN ──
      // Sai format/null → allocation=null + đếm parse-fail (drift metric,
      // fail-soft — không sập chu kỳ Chủ tịch). Chỉ giữ ≤ 8 dòng chuẩn hoá.
      let allocation: AllocationProposal | null = null;
      try {
        allocation = parseAllocationProposal(parsed?.allocation);
        if (parsed?.allocation != null && allocation == null) {
          await bumpAllocationParseFail();
        }
      } catch (allocErr) {
        console.error("[agents/run:allocation]", allocErr);
      }

      strategist = { summary, recommendation, confidence, signal, allocation };

      // ══ Phiên #51 — CRB-9 · ¼-KELLY (TUYỆT ĐỐI THAM MƯU) ══════════════
      // Tính gợi ý tỷ trọng cho tín hiệu MUA/BÁN từ bandit posterior cử tri
      // ĐỒNG HƯỚNG + hệ số thưởng:rủi (target/stop vs giá hiện tại), chặn hạn
      // mức ĐỘNG — chỉ nhúng vào rationale + UI, KHÔNG tự đặt khối lượng.
      try {
        const sig = strategist.signal;
        if (
          riskQuant?.ok &&
          sig &&
          (sig.direction === "BUY" || sig.direction === "SELL")
        ) {
          const entryInstrumentId = market.instrumentIdBySymbol.get(sig.symbol);
          const entryRow = entryInstrumentId
            ? await db.instrument
                .findFirst({
                  where: { id: entryInstrumentId },
                  select: { quotes: { orderBy: { tradedAt: "desc" }, take: 1, select: { last: true } } },
                })
                .catch(() => null)
            : null;
          const entry = entryRow?.quotes[0]?.last ?? 0;
          if (entry > 0) {
            const kellyVotes: CouncilVote[] = [
              ...llmVotes.map((v) => ({ code: v.code, direction: v.direction })),
              ...(mlForecastDirection
                ? [{ code: "ml-forecast", direction: mlForecastDirection }]
                : []),
            ];
            const kellyP = alignedCouncilP(
              riskQuant.arms,
              kellyVotes,
              sig.direction === "BUY" ? "UP" : "DOWN"
            );
            const hint = fractionalKelly({
              direction: sig.direction,
              entry,
              targetPrice: sig.targetPrice,
              stopLoss: sig.stopLoss,
              p: kellyP,
              dynMaxPositionPct: riskQuant.dynMaxPositionPct,
            });
            if (!hint.skipped && hint.f > 0) {
              kellyHintF = hint.f;
              sig.rationale = `${sig.rationale} [${hint.note}]`;
            }
          }
        }
      } catch (kellyErr) {
        console.error("[risk-quant] Kelly CRB-9 lỗi (tham mưu — bỏ qua):", kellyErr);
      }
      // Gắn kellyHint vào snapshot + assessment detail (CRB-9 — tham mưu)
      if (riskQuant?.ok) {
        await attachKellyHint(riskQuant.snapshotId, kellyHintF);
        await attachRiskQuantKelly(bayesView?.id, kellyHintF);
      }

      const run = await persistRun(
        strategistAgent.id,
        true,
        strategistStart,
        tokensIn,
        tokensOut,
        // E-P1-1: output JSON chứa cả khối allocation (đầy đủ trong AgentRun).
        JSON.stringify({ summary, recommendation, confidence, signal, allocation }),
        null
      );
      strategistRunId = run.id;
      // Phiên #34 — gắn AgentRun id của Chủ tịch vào assessment Bayes của chu kỳ
      if (bayesView) {
        await attachCycleRunId(bayesView.id, run.id).catch(() => undefined);
      }
      // E-P1-1: message Chủ tịch = summary + khối ĐỀ XUẤT PHÂN BỔ (narrative +
      // bảng tỷ trọng) — §7.4 mặc định "chỉ narrative + bảng" trong output,
      // trader đọc trực tiếp ở luồng tin nhắn; KHÔNG push prompt chu kỳ sau.
      const messageContent =
        strategist.allocation
          ? `${summary}\n\n${formatAllocationForMessage(strategist.allocation)}`
          : summary;
      const message = await persistMessage(
        strategistAgent.id,
        messageContent,
        recommendation || null,
        confidence === "HIGH" ? "bullish" : confidence === "LOW" ? "neutral" : "neutral"
      );
      createdMessages.push({
        id: message.id,
        fromAgentId: strategistAgent.id,
        content: messageContent,
        reasoning: recommendation || null,
        sentiment: confidence === "HIGH" ? "bullish" : "neutral",
      });
    } catch (strategistErr) {
      console.error("[api/agents/run] strategist failed:", strategistErr);
      failures.push(CHAIRMAN_CODE);
      await persistRun(
        strategistAgent.id,
        false,
        strategistStart,
        estimateTokens(ROLE_PROMPTS[CHAIRMAN_CODE].system + strategistUserPrompt),
        0,
        null,
        strategistErr instanceof Error ? strategistErr.message : "Lỗi tổng hợp."
      ).catch(() => undefined);
    }

    // ══ ĐỢT F · Thực thi & hậu cần ═════════════════════════════════
    // Execution Manager — ghi nhận tín hiệu, chờ phê duyệt (PHASE3_BLUEPRINT
    // §4.5/§4.9): chu kỳ KHÔNG tự tạo Order — tín hiệu BUY/SELL giữ status
    // ACTIVE, trader phê duyệt/từ chối qua POST /api/signals/[id]/decision.
    const executorAgent = byCode.get(EXECUTOR_CODE)!;
    let createdSignal: {
      id: string;
      symbol: string;
      direction: string;
      score: number;
      confidence: string;
    } | null = null;
    let executionRunId = "";
    let signalExpiresAt: Date | null = null;

    const validInstrumentId = strategist?.signal
      ? market.instrumentIdBySymbol.get(strategist.signal.symbol)
      : undefined;

    if (strategist?.signal && validInstrumentId) {
      const sig = strategist.signal;
      // AUD-CODE #6: VETO hard-enforce — tín hiệu vi phạm bị hạ tầm về HOLD
      // (exposure chặn MUA / compliance chặn mọi hướng mới) kèm lý do gián tiếp
      let vetoedBy: string | null = null;
      if (vetoBlocked && sig.direction !== "HOLD") {
        vetoedBy = vetoCompliance
          ? "Compliance A8 VETO — biên margin/chế độ giao dịch hiện không đạt"
          : "Exposure A7 VETO — danh mục vượt hạn mức phơi nhiễm, chỉ chấp nhận SELL hoặc HOLD";
        if (!vetoCompliance && sig.direction === "SELL") {
          // Exposure chỉ chặn MUA (SELL giảm phơi nhiễm → được phép)
        } else {
          sig.rationale = `[BỊ ỦY BAN KIỂM SOÁT PHỦ QUYẾT → hạ về GIỮ] ${vetoedBy}. Đề xuất gốc bị chặn. ${sig.rationale}`;
          sig.direction = "HOLD";
          sig.targetPrice = null;
          sig.stopLoss = null;
          sig.takeProfit = null;
        }
      }
      const expiresAt = new Date(Date.now() + 3 * 86_400_000);
      signalExpiresAt = expiresAt;

      const signalRow = await db.signal.create({
        data: {
          instrumentId: validInstrumentId,
          direction: sig.direction,
          confidence: sig.confidence,
          score: sig.score,
          rationale: sig.rationale,
          agentId: strategistAgent.id,
          targetPrice: sig.direction === "HOLD" ? null : sig.targetPrice,
          stopLoss: sig.direction === "BUY" ? sig.stopLoss : null,
          takeProfit: sig.direction === "BUY" ? sig.takeProfit : null,
          // B9 — SNAPSHOT cổng đồng thuận lúc Chủ tịch SINH tín hiệu: gate bind
          // theo assessment TẠO RA tín hiệu — convert ở chu kỳ sau KHÔNG bị đánh
          // giá lại bằng consensus mới hơn (ổn định + kiểm chứng theo tín hiệu)
          consensusGate: bayesView?.consensus?.gate ?? null,
          consensusRatio: bayesView?.consensus?.ratio ?? null,
          expiresAt,
          status: "ACTIVE", // chờ phê duyệt của trader (mặc định schema)
        },
      });
      createdSignal = {
        id: signalRow.id,
        symbol: sig.symbol,
        direction: sig.direction,
        score: sig.score,
        confidence: sig.confidence,
      };
      // Audit đổi từ SIGNAL_APPROVED → SIGNAL_CREATED (§4.5: phê duyệt là việc của trader)
      await db.auditLog.create({
        data: {
          action: "SIGNAL_CREATED",
          entity: "Signal",
          entityId: signalRow.id,
          after: JSON.stringify({
            symbol: sig.symbol,
            direction: sig.direction,
            score: sig.score,
          }),
        },
      });

      // Nội dung execution manager: ghi nhận tín hiệu — KHÔNG tự đặt lệnh
      let executionContent: string;
      let executionReasoning: string;
      let execOutput: Record<string, unknown>;
      if (sig.direction !== "HOLD") {
        executionContent = `Nhận tín hiệu ${sig.direction === "BUY" ? "MUA" : "BÁN"} ${sig.symbol} (điểm ${sig.score}/100, tin cậy ${sig.confidence}) từ Chủ tịch Hội đồng sau khi hội đủ báo cáo của ${digestLines.length} agents. Đã ghi nhận tín hiệu — chờ phê duyệt của trader (nút Phê duyệt/từ chối ở luồng tin nhắn hoặc tab Tín hiệu).`;
        executionReasoning =
          "Tín hiệu ghi nhận ở trạng thái ACTIVE — chờ trader phê duyệt trước khi tạo lệnh.";
        execOutput = { signalId: signalRow.id, awaitingApproval: true };
      } else {
        executionContent = vetoedBy
          ? `Tín hiệu ${sig.symbol} bị Ủy ban Kiểm soát PHỦ QUYẾT (${vetoedBy}) — hạ về GIỮ, không trình lệnh mới. Điểm ${sig.score}/100.`
          : `Nhận tín hiệu GIỮ ${sig.symbol} (điểm ${sig.score}/100). Không tạo lệnh mới (tín hiệu GIỮ).`;
        executionReasoning = vetoedBy
          ? "VETO hard-enforce (AUD-CODE #6): tín hiệu vi phạm bị hạ về HOLD."
          : "Tín hiệu GIỮ — không tạo lệnh.";
        execOutput = { signalId: signalRow.id, direction: "HOLD", vetoed: Boolean(vetoedBy) };
      }

      const execStart = Date.now();
      const execRun = await persistRun(
        executorAgent.id,
        true,
        execStart,
        0,
        0,
        JSON.stringify(execOutput),
        null
      );
      executionRunId = execRun.id;
      const execMessage = await persistMessage(
        executorAgent.id,
        executionContent,
        executionReasoning,
        null
      );
      createdMessages.push({
        id: execMessage.id,
        fromAgentId: executorAgent.id,
        content: executionContent,
        reasoning: executionReasoning,
        sentiment: null,
      });
    } else {
      // No valid signal — record a no-op execution run
      // AUD-CODE #13: nói rõ vì sao (Chủ tịch không ra tín hiệu / mã hallucinate)
      const execStart = Date.now();
      const noSignalReason = strategist?.signal
        ? `invalid-symbol:${strategist.signal.symbol}`
        : "no-signal";
      const execRun = await persistRun(
        executorAgent.id,
        true,
        execStart,
        0,
        0,
        JSON.stringify({ action: "noop", reason: noSignalReason }),
        null
      );
      executionRunId = execRun.id;
      if (strategist?.signal && !validInstrumentId) {
        // Chairman hallucinate mã ngoài bảng giá — ghi rõ để trader biết
        const warnMessage = await persistMessage(
          executorAgent.id,
          `Chủ tịch Hội đồng đề xuất mã ${strategist.signal.symbol} không có trong bảng instrument — tín hiệu bị bỏ qua (no fabrication). Đề nghị Chủ tịch chỉ chọn mã trong danh mục VN30 đang theo dõi.`,
          "Mã không hợp lệ — từ chối ghi nhận tín hiệu.",
          null
        );
        createdMessages.push({
          id: warnMessage.id,
          fromAgentId: executorAgent.id,
          content: warnMessage.content,
          reasoning: warnMessage.reasoning,
          sentiment: null,
        });
      }
    }

    // Settlement + Cash Management (service, song song)
    await Promise.all(WAVE_E_SERVICE_CODES.map((code) => runOneServiceAgent(code)));

    // ── Cycle-level audit log ──────────────────────────────────────
    const cycleDurationMs = Date.now() - cycleStart;
    const ranCount = analyses.size + (strategist ? 1 : 0) + (executionRunId ? 1 : 0);
    await db.auditLog.create({
      data: {
        action: "AGENT_RUN_COMPLETED",
        entity: "AgentRun",
        entityId: strategistRunId || executionRunId || null,
        after: JSON.stringify({
          architecture: "23-agents",
          messages: createdMessages.length,
          agentsRan: ranCount,
          signal: createdSignal?.symbol ?? null,
          order: null, // §4.9 — chu kỳ không còn tự tạo lệnh
          durationMs: cycleDurationMs,
          failures,
          // Phiên #34 — tóm tắt Bộ tổng hợp Bayes của chu kỳ (null khi tổng hợp lỗi)
          assessment: assessmentSummary
            ? {
                pUp: Number(assessmentSummary.pUp.toFixed(4)),
                marketDirection: assessmentSummary.marketDirection,
                evidenceCount: assessmentSummary.evidenceCount,
              }
            : null,
        }),
      },
    });

    // ── Response (shape per TECHNICAL_BLUEPRINT §4) ────────────────
    const messageRows = await db.agentMessage.findMany({
      where: { id: { in: createdMessages.map((m) => m.id) } },
      include: { fromAgent: { select: { code: true, name: true, role: true } } },
      orderBy: { createdAt: "asc" },
    });

    return NextResponse.json(
      toPlain({
        runId: strategistRunId || executionRunId || null,
        messages: messageRows,
        signals: createdSignal
          ? [
              {
                ...createdSignal,
                rationale: strategist?.signal?.rationale ?? "",
                targetPrice: strategist?.signal?.targetPrice ?? null,
                stopLoss: strategist?.signal?.stopLoss ?? null,
                takeProfit: strategist?.signal?.takeProfit ?? null,
                expiresAt: signalExpiresAt,
              },
            ]
          : [],
        order: null, // giữ trường cho client cũ — lệnh chỉ tạo khi trader phê duyệt
        failures,
        durationMs: cycleDurationMs,
        // Mở rộng 23 agents — tổng kết các đợt đã chạy
        waves: {
          architecture: "23-agents",
          agentsRan: ranCount,
          platform: WAVE_A_CODES.length,
          researchAndMl: WAVE_B_SERVICE_CODES.length + WAVE_B_LLM_CODES.length,
          control: WAVE_C_LLM_CODES.length + WAVE_C_SERVICE_CODES.length,
          // AUD-CODE #11: đếm động theo run thật — không hardcode khi strategist fail
          executive:
            (strategist ? 1 : 0) +
            (executionRunId ? 1 : 0) +
            WAVE_E_SERVICE_CODES.length,
        },
        // Phiên #34 — tóm tắt Bộ tổng hợp Bayes (đợt D) chạy giữa Control & Chủ tịch
        assessment: assessmentSummary,
      })
    );
  } catch (err) {
    // Absolute last-resort guard — never crash the app
    console.error("[api/agents/run] unexpected error:", err);
    try {
      await db.agent.updateMany({
        where: { id: { in: agents.map((a) => a.id) } },
        data: { status: "ERROR" },
      });
    } catch {
      // swallow — logging already happened
    }
    return NextResponse.json(
      { error: "Chu kỳ phân tích gặp lỗi không mong muốn. Vui lòng thử lại." },
      { status: 500 }
    );
  }
}
