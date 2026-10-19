/** (Task 144 P2-a) — tách từ src/app/api/agents/run/route.ts (pure move)
 *  Vòng chạy agent: parse JSON/assessment LLM, service agent, Đợt A/B/C,
 *  verdict VETO, phiếu Bayes, và chu kỳ Chủ tịch (¼-Kelly tham mưu). */

import { db } from "@/lib/db";
import { callLlmWithRetry, estimateTokens } from "@/lib/llm";
import { ROLE_PROMPTS, type MarketSnapshot } from "@/lib/agent-context";
import { runServiceAgent, type ServiceRunContext, type ServiceRunResult } from "@/lib/agent-service-runs";
import { extractVerdict, type DataQualityVerdict } from "@/lib/data-quality";
// E-P1-1 (EXECUTION_OPS_BLUEPRINT v1.2): parse khối đề xuất phân bổ của Chủ tịch.
import {
  parseAllocationProposal,
  bumpAllocationParseFail,
  formatAllocationForMessage,
  type AllocationProposal,
} from "@/lib/exec/allocation";
import { attachKellyHint, type RiskQuantResult } from "@/lib/risk/engine";
import { fractionalKelly, alignedCouncilP, type CouncilVote } from "@/lib/risk/sizing";
import { attachCycleRunId, attachRiskQuantKelly } from "@/lib/bayes/persist";
import type { LlmVoteInput } from "@/lib/bayes/evidence";
import type { MarketAssessmentView } from "@/lib/types";
import { persistRun, persistMessage } from "./persist";
import {
  CHAIRMAN_CODE,
  WAVE_B_SERVICE_CODES,
  WAVE_B_LLM_CODES,
  WAVE_C_LLM_CODES,
  WAVE_C_SERVICE_CODES,
  type CycleAgentRow,
} from "./prepare";

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

export interface AgentAnalysis {
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

export interface StrategistResult {
  summary: string;
  recommendation: string;
  confidence: "LOW" | "MEDIUM" | "HIGH";
  signal: StrategistSignal | null;
  /** E-P1-1: khối đề xuất phân bổ danh mục (narrative + bảng) — chỉ tham mưu. */
  allocation: AllocationProposal | null;
}

/** Tin broadcast đã tạo trong chu kỳ (đưa vào response). */
export interface CycleCreatedMessage {
  id: string;
  fromAgentId: string;
  content: string;
  reasoning: string | null;
  sentiment: string | null;
}

/** Trạng thái dùng chung một chu kỳ — truyền qua các bước agent-loop/persist. */
export interface CycleRunState {
  byCode: Map<string, CycleAgentRow>;
  /** Kết quả phân tích theo code (đưa vào digest cho Chủ tịch). */
  analyses: Map<string, AgentAnalysis>;
  createdMessages: CycleCreatedMessage[];
  failures: string[];
}

/** Verdict VETO Ủy ban Kiểm soát của chu kỳ (AUD-CODE #6 + AUDIT 137 A3). */
export interface ControlVerdicts {
  vetoExposure: boolean;
  vetoCompliance: boolean;
  vetoBlocked: boolean;
  controlMissing: string[];
  controlUnavailable: boolean;
}

/**
 * Chạy + persist MỘT service agent (deterministic) — trả về result để đọc verdict VETO.
 *  ctx (phiên #51 — CRB): truyền kết quả RiskQuantEngine (exposure A7 đọc
 *  hạn mức động). ctx (P0-7 — #57): truyền verdict A9 cho S1 (đợt A nhịp 3).
 */
export async function runOneServiceAgent(
  state: CycleRunState,
  code: string,
  ctx?: ServiceRunContext
): Promise<ServiceRunResult | null> {
  const agent = state.byCode.get(code)!;
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
    state.createdMessages.push({
      id: message.id,
      fromAgentId: agent.id,
      content: result.content,
      reasoning: result.reasoning || null,
      sentiment: result.sentiment,
    });
    state.analyses.set(code, {
      content: result.content,
      reasoning: result.reasoning,
      sentiment: result.sentiment,
      assessment: null, // service agents không có assessment JSON (phiên #34)
    });
    return result;
  } catch (err) {
    state.failures.push(code);
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

/**
 * ══ ĐỢT A · Nền tảng dữ liệu — 3 NHỊP CON (§3.3 blueprint v1.1 — #57) ══
 * Tránh phụ thuộc vòng trong cùng đợt song song: nhịp 1: S0 ∥ S2 →
 * nhịp 2: A9 (readiness do chính A9 tính qua FeatureContract — cùng thư
 * viện với S2 nên cùng số, KHÔNG phụ thuộc output S2 cùng chu kỳ) →
 * nhịp 3: S1 (đọc verdict A9 VỪA LƯU cùng chu kỳ — P0-7). Verdict A9 +
 * readiness S2 được lưu TRƯỚC khi Wave B bắt đầu. Trả về verdict A9
 * (null khi A9 lỗi) để tiêm cờ chất lượng dữ liệu vào prompt.
 */
export async function runWaveA(
  state: CycleRunState,
  heartbeat: () => Promise<unknown>
): Promise<DataQualityVerdict | null> {
  await Promise.all(
    (["data-collector", "feature-store"] as const).map((code) => runOneServiceAgent(state, code))
  );
  // AUDIT 137 A4 — heartbeat sau wave A (S0 ∥ S2)
  await heartbeat();
  const dqRun = await runOneServiceAgent(state, "data-integrity");
  const dqVerdict: DataQualityVerdict | null = dqRun ? extractVerdict(dqRun.output) : null;
  await runOneServiceAgent(state, "notification-officer", { dataQuality: dqVerdict });
  return dqVerdict;
}

/** ══ ĐỢT B · Nghiên cứu + Học máy — service (8) song song, 0 LLM ════════ */
export async function runWaveBServices(
  state: CycleRunState,
  heartbeat: () => Promise<unknown>
): Promise<(ServiceRunResult | null)[]> {
  // Service agents (8) song song trước — nhanh, 0 LLM. Giữ kết quả để
  // đọc direction ml-forecast (cử tri thứ 6 — đầu vào votes cho Kelly CRB-9)
  const waveBServiceResults = await Promise.all(
    WAVE_B_SERVICE_CODES.map((code) => runOneServiceAgent(state, code))
  );
  // AUDIT 137 A4 — heartbeat sau đợt B service (trước chuỗi LLM tuần tự)
  await heartbeat();
  return waveBServiceResults;
}

// LLM research agents (4) tuần tự — tôn trọng rate-limit gateway (giữ nguyên
// chữ gốc route.ts — thực tế 5 agent: #126 A20 thêm macro-economist).
export async function runWaveBLlmAgents(
  state: CycleRunState,
  prompts: Record<string, { system: string; user: string }>,
  heartbeat: () => Promise<unknown>
): Promise<void> {
  for (const code of WAVE_B_LLM_CODES) {
    const agent = state.byCode.get(code)!;
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
      state.createdMessages.push({
        id: message.id,
        fromAgentId: agent.id,
        content,
        reasoning: reasoning || null,
        sentiment,
      });
      state.analyses.set(code, { content, reasoning, sentiment, assessment });
    } catch (err) {
      state.failures.push(code);
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
    // AUDIT 137 A4 — heartbeat sau TỪNG agent LLM tuần tự: chuỗi 5 cuộc gọi
    // xấu nhất (45s × 4 retry mỗi call) vượt xa 5 phút — heartbeat từng
    // vòng lặp giữ agent còn xếp hàng (Chủ tịch/đợt C/đợt E) tươi cho watchdog.
    await heartbeat();
  }
}

/**
 * ══ ĐỢT C · Ủy ban Kiểm soát (VETO) — risk LLM + 2 service ═════
 * Trả về ControlVerdicts (AUD-CODE #6 ENFORCE VETO + AUDIT 137 A3
 * controlUnavailable fail-closed).
 */
export async function runWaveC(
  state: CycleRunState,
  prompts: Record<string, { system: string; user: string }>,
  riskQuant: RiskQuantResult | null
): Promise<ControlVerdicts> {
  const controlResults = await Promise.all([
    (async () => {
      const code = "risk-manager";
      const agent = state.byCode.get(code)!;
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
        state.createdMessages.push({
          id: message.id,
          fromAgentId: agent.id,
          content,
          reasoning: reasoning || null,
          sentiment: null,
        });
        state.analyses.set(code, { content, reasoning, sentiment: null, assessment });
      } catch (err) {
        state.failures.push(code);
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
    ...WAVE_C_SERVICE_CODES.map((code) => runOneServiceAgent(state, code, { riskQuant })),
  ]);
  // ══ AUD-CODE #6: ENFORCE VETO — Ủy ban Kiểm soát có quyền phủ quyết THẬT ══
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
  // AUDIT 137 A3 — control agent lỗi (result null) → VÀNG fail-safe:
  // không để phơi nhiễm/biến margin CHƯA KIỂM ĐỊNH lọt qua (fail-closed).
  // Trước đây runOneServiceAgent catch → null → verdict.startsWith("VETO")
  // không match → tín hiệu MUA đi thẳng (fail-open) đúng lúc DB/kết nối
  // kém ổn định (= lúc rủi ro cao nhất), agent lỗi còn biến mất khỏi digest.
  const controlMissing = controlOutputs.filter((c) => !c.result).map((c) => c.code);
  const controlUnavailable = controlMissing.length > 0;
  return { vetoExposure, vetoCompliance, vetoBlocked, controlMissing, controlUnavailable };
}

/** Phiếu LLM 5 cử tri — dùng cho Bayes (llm-vote) + Kelly CRB-9 (hướng đồng thuận). */
export function buildLlmVotes(analyses: Map<string, AgentAnalysis>): LlmVoteInput[] {
  return [...WAVE_B_LLM_CODES, ...WAVE_C_LLM_CODES].flatMap((code) => {
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
  });
}

export interface ChairmanOutcome {
  strategist: StrategistResult | null;
  strategistRunId: string;
  strategistRaw: string | null;
}

/**
 * ══ ĐỢT E · Chủ tịch Hội đồng — chạy LLM tổng hợp → MỘT tín hiệu ══════
 * (giữ nguyên thân hàm từ route.ts — parse signal/allocation + ¼-Kelly
 * CRB-9 tham mưu + persistRun/persistMessage).
 */
export async function runChairmanCycle(
  state: CycleRunState,
  strategistAgent: CycleAgentRow,
  strategistUserPrompt: string,
  market: MarketSnapshot,
  llmVotes: LlmVoteInput[],
  mlForecastDirection: "UP" | "DOWN" | "FLAT" | null,
  riskQuant: RiskQuantResult | null,
  bayesView: MarketAssessmentView | null
): Promise<ChairmanOutcome> {
  const strategistStart = Date.now();
  let strategist: StrategistResult | null = null;
  let strategistRunId = "";
  // K4 (#94): output THÔ của Chủ tịch — parse assignTasks sau try/catch (kể
  // cả khi persistMessage lỗi, output LLM vẫn còn để giao việc đúng chỗ).
  let strategistRaw: string | null = null;
  // CRB-9 — kellyHint của chu kỳ (null = bỏ/skip — tham mưu)
  let kellyHintF: number | null = null;
  try {
    const { raw, tokensIn, tokensOut } = await callLlmWithRetry(
      ROLE_PROMPTS[CHAIRMAN_CODE].system,
      strategistUserPrompt
    );
    strategistRaw = raw;
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
      const sigSymbol = s.symbol.trim().toUpperCase();
      // #108 v2.2: tín hiệu chỉ còn mã VN (map loại phi-VN) — làm tròn bội
      // 100₫ như cũ; nhánh Math.round giữ cho mọi symbol lạ khác (phòng
      // thủ — không bao giờ tới tạo lệnh vì map đã chặn).
      const sigInst = await db.instrument
        .findUnique({ where: { symbol: sigSymbol }, select: { market: true } })
        .catch(() => null);
      const isVnInstrument =
        sigInst == null || sigInst.market === "HOSE" || sigInst.market === "HNX" || sigInst.market === "UPCOM";
      const priceRound = (v: number): number =>
        isVnInstrument ? round100(v) : Math.max(1, Math.round(v));
      signal = {
        symbol: sigSymbol,
        direction,
        confidence: conf,
        score,
        rationale:
          typeof s.rationale === "string" && s.rationale.trim()
            ? s.rationale.trim()
            : recommendation || summary,
        targetPrice:
          s.targetPrice != null && Number.isFinite(Number(s.targetPrice))
            ? priceRound(Number(s.targetPrice))
            : null,
        stopLoss:
          s.stopLoss != null && Number.isFinite(Number(s.stopLoss))
            ? priceRound(Number(s.stopLoss))
            : null,
        takeProfit:
          s.takeProfit != null && Number.isFinite(Number(s.takeProfit))
            ? priceRound(Number(s.takeProfit))
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
    state.createdMessages.push({
      id: message.id,
      fromAgentId: strategistAgent.id,
      content: messageContent,
      reasoning: recommendation || null,
      sentiment: confidence === "HIGH" ? "bullish" : "neutral",
    });
  } catch (strategistErr) {
    console.error("[api/agents/run] strategist failed:", strategistErr);
    state.failures.push(CHAIRMAN_CODE);
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
  return { strategist, strategistRunId, strategistRaw };
}
