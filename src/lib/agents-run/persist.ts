/** (Task 144 P2-a) — tách từ src/app/api/agents/run/route.ts (pure move)
 *  Persist chu kỳ: AgentRun/AgentMessage broadcast + heartbeat watchdog +
 *  Bộ tổng hợp Bayes (Đợt D) + ghi tín hiệu & execution-manager (Đợt F). */

import { db } from "@/lib/db";
import { llmCostUsd } from "@/lib/llm";
import { updateAgentHealth } from "@/lib/health";
import { buildEvidenceBundle, type LlmVoteInput } from "@/lib/bayes/evidence";
import { synthesizeMarketAssessment } from "@/lib/bayes/synthesis";
import { saveMarketAssessment } from "@/lib/bayes/persist";
import { maybeAutoEnableConsensus } from "@/lib/consensus";
import { toRiskQuantView, type RiskQuantResult } from "@/lib/risk/engine";
import type { MarketSnapshot } from "@/lib/agent-context";
import type { CycleAssessmentSummary, MarketAssessmentView } from "@/lib/types";
import { EXECUTOR_CODE, type CycleAgentRow } from "./prepare";
import type { ControlVerdicts, CycleRunState, StrategistResult } from "./agent-loop";

/** Persist an agent run + restore agent status + update health. */
export async function persistRun(
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

export async function persistMessage(
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
 * AUDIT 137 A4 — heartbeat: chạm updatedAt các agent còn RUNNING sau mỗi
 * wave → watchdog 5' chỉ dọn chu kỳ THẬT SỰ chết im (không phải chu kỳ dài).
 * Không có heartbeat, chu kỳ LLM xấu nhất (45s × 4 retry × 8 cuộc gọi tuần
 * tự > 5 phút) làm agent còn xếp hàng bị releaseStuckRunningAgents reset
 * IDLE giữa chừng → chu kỳ/single-run mới chạy chồng (double LLM, 2 Signal).
 * persistRun đã tự chạm updatedAt từng agent HOÀN TẤT — heartbeat lo phần
 * agent CHƯA chạy (vẫn RUNNING từ mốc claim đầu chu kỳ).
 */
export function heartbeatRunningAgentsFor(agents: CycleAgentRow[]) {
  return () =>
    db.agent
      .updateMany({
        where: { id: { in: agents.map((a) => a.id) }, status: "RUNNING" },
        data: { updatedAt: new Date() },
      })
      .catch(() => undefined);
}

export interface BayesSynthesisResult {
  assessmentSummary: CycleAssessmentSummary | null;
  bayesView: MarketAssessmentView | null;
}

/**
 * ══ ĐỢT D · BỘ TỔNG HỢP BAYES (phiên #34 — 0 LLM, deterministic ~1-2s) ══
 * Sau Ủy ban Kiểm soát, TRƯỚC Chủ tịch: tổng hợp mọi bằng chứng định lượng
 * (breadth/lexicon/flows/Holt/regime + assessment JSON của 5 agent LLM +
 * bằng chứng quant CRB) theo log-odds 3 bậc nhân quả → posterior + drivers
 * + narrative → lưu bảng MarketAssessment. Lỗi tổng hợp KHÔNG được làm hỏng
 * chu kỳ (spec #34): log + assessment = null, Chủ tịch vẫn đọc digest như cũ.
 */
export async function runBayesSynthesis(
  llmVotes: LlmVoteInput[],
  veto: ControlVerdicts,
  riskQuant: RiskQuantResult | null
): Promise<BayesSynthesisResult> {
  let assessmentSummary: CycleAssessmentSummary | null = null;
  let bayesView: MarketAssessmentView | null = null;
  try {
    const bundle = await buildEvidenceBundle({
      llmVotes,
      // AUDIT 137 A3 — thêm nhánh controlUnavailable: control agent lỗi cũng
      // vào veto block của Bayes (đúng nguyên tắc "engine lỗi → fallback
      // VETO-cứng") để Chủ tịch + digest UI Tổng hợp THẤY trạng thái chặn.
      veto: veto.vetoBlocked || veto.controlUnavailable
        ? {
            blocked: true,
            reason: veto.vetoCompliance
              ? "Compliance A8 VETO — biên margin/chế độ giao dịch hiện không đạt"
              : veto.controlUnavailable
                ? `Ủy ban Kiểm soát chưa kiểm định chu kỳ này (agent ${veto.controlMissing.join(", ")} lỗi) — fail-safe hạ GIỮ theo nguyên tắc VETO-cứng`
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
          `[consensus] shadow: ĐÃ-SẼ-CHẶN — gate ${bayesView.consensus.gate} · ratio ${(bayesView.consensus.ratio * 100).toFixed(1)}% · ${bayesView.consensus.present}/7 cử tri — tín hiệu mới sẽ bị ép GIỮ khi bật enforcement`
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
  return { assessmentSummary, bayesView };
}

/** Tín hiệu của chu kỳ trả về client (hình gốc từ route.ts). */
export interface CycleCreatedSignal {
  id: string;
  symbol: string;
  direction: string;
  score: number;
  confidence: string;
}

export interface ExecutionWaveResult {
  createdSignal: CycleCreatedSignal | null;
  executionRunId: string;
  signalExpiresAt: Date | null;
}

/**
 * ══ ĐỢT F · Thực thi & hậu cần ═════════════════════════════════
 * Execution Manager — ghi nhận tín hiệu, chờ phê duyệt (PHASE3_BLUEPRINT
 * §4.5/§4.9): chu kỳ KHÔNG tự tạo Order — tín hiệu BUY/SELL giữ status
 * ACTIVE, trader phê duyệt/từ chối qua POST /api/signals/[id]/decision.
 */
export async function persistSignalAndExecution(
  state: CycleRunState,
  strategist: StrategistResult | null,
  strategistAgent: CycleAgentRow,
  market: MarketSnapshot,
  digestLines: string[],
  veto: ControlVerdicts,
  bayesView: MarketAssessmentView | null
): Promise<ExecutionWaveResult> {
  const executorAgent = state.byCode.get(EXECUTOR_CODE)!;
  let createdSignal: CycleCreatedSignal | null = null;
  let executionRunId = "";
  let signalExpiresAt: Date | null = null;

  const validInstrumentId = strategist?.signal
    ? market.instrumentIdBySymbol.get(strategist.signal.symbol)
    : undefined;

  if (strategist?.signal && validInstrumentId) {
    const sig = strategist.signal;
    // AUD-CODE #6: VETO hard-enforce — tín hiệu vi phạm bị hạ tầm về HOLD
    // (exposure chặn MUA / compliance chặn mọi hướng mới) kèm lý do gián tiếp
    // AUDIT 137 A3 — thêm controlUnavailable: control agent lỗi (result
    // null) cũng hạ GIỮ và chặn cả BUY lẫn SELL như compliance — kiểm soát
    // biến margin/phơi nhiễm chưa biết thì KHÔNG tạo tín hiệu mới (fail-closed,
    // không còn kẽ 'verdict.startsWith("VETO") không match → mua thẳng').
    let vetoedBy: string | null = null;
    if ((veto.vetoBlocked || veto.controlUnavailable) && sig.direction !== "HOLD") {
      vetoedBy = veto.vetoCompliance
        ? "Compliance A8 VETO — biên margin/chế độ giao dịch hiện không đạt"
        : veto.controlUnavailable
          ? `Ủy ban Kiểm soát chưa kiểm định chu kỳ này (agent ${veto.controlMissing.join(", ")} lỗi) — fail-safe hạ GIỮ theo nguyên tắc VETO-cứng`
          : "Exposure A7 VETO — danh mục vượt hạn mức phơi nhiễm, chỉ chấp nhận SELL hoặc HOLD";
      if (!veto.vetoCompliance && !veto.controlUnavailable && sig.direction === "SELL") {
        // Exposure chỉ chặn MUA (SELL giảm phơi nhiễm → được phép);
        // controlUnavailable/compliance chặn CẢ SELL (biến margin chưa biết
        // thì không tạo tín hiệu mới theo bất kỳ hướng nào).
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
        // F-151-2 (Task 152): mốc cắt lỗ/chốt lời lưu cho CẢ MUA lẫn BÁN — với
        // SELL đây là mốc của CHÍNH quyết định bán (stop = giá vượt LÊN làm vô
        // hiệu hoá kèo bán · take = mục tiêu GIẢM). Chairman parse + Kelly hint
        // (agent-loop CRB-9) vốn đã dùng stopLoss cho SELL — trước đây persist
        // bỏ chữ khiến D-LEDGER không hậu kiểm được "đáng lẽ chặn lỗ ở đâu".
        stopLoss: sig.direction === "HOLD" ? null : sig.stopLoss,
        takeProfit: sig.direction === "HOLD" ? null : sig.takeProfit,
        // B9 — SNAPSHOT cổng đồng thuận lúc Chủ tịch SINH tín hiệu: gate bind
        // theo assessment TẠO RA tín hiệu — convert ở chu kỳ sau KHÔNG bị đánh
        // giá lại bằng consensus mới hơn (ổn định + kiểm chứng theo tín hiệu)
        consensusGate: bayesView?.consensus?.gate ?? null,
        consensusRatio: bayesView?.consensus?.ratio ?? null,
        // F-151-1 (Task 152) — bind luôn HƯỚNG SỐ ĐÔNG của snapshot: auto-decision
        // + convert + K1 chỉ duyệt lệnh khi dominant khớp hướng tín hiệu
        // (SELL ↔ DOWN · BUY ↔ UP) — đóng kẽ "đồng thuận đi ngang vẫn duyệt BÁN".
        consensusDominant: bayesView?.consensus?.dominant ?? null,
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
      executionContent = `Nhận tín hiệu ${sig.direction === "BUY" ? "MUA" : "BÁN"} ${sig.symbol} (điểm ${sig.score}/100, tin cậy ${sig.confidence}) từ Chủ tịch Hội đồng sau khi hội đủ báo cáo của ${digestLines.length} agents. Tín hiệu sẽ được QUYẾT ĐỊNH TỨC THÌ theo cổng đồng thuận ở cuối chu kỳ (phiên #91 — quy tắc 1 duyệt · 2 từ chối): đủ đồng thuận ≥80% → duyệt ngay thành lệnh giấy 5% NAV; không đủ → từ chối ngay. Kết quả hiện ở tab Tín hiệu.`;
      executionReasoning =
        "Tín hiệu quyết định tức thì theo cổng đồng thuận B9 (≥80% duyệt ngay, <80% từ chối ngay) — không còn trạng thái chờ tay (phiên #91).";
      execOutput = { signalId: signalRow.id, autoDecisionPending: true };
    } else {
      executionContent = vetoedBy
        ? `Tín hiệu ${sig.symbol} bị Ủy ban Kiểm soát PHỦ QUYẾT (${vetoedBy}) — hạ về GIỮ, không trình lệnh mới. Điểm ${sig.score}/100. Tự đóng bằng từ chối có lý do ở cuối chu kỳ.`
        : `Nhận tín hiệu GIỮ ${sig.symbol} (điểm ${sig.score}/100). Không tạo lệnh — sẽ tự đóng bằng từ chối có lý do ở cuối chu kỳ (phiên #91: 1 duyệt · 2 từ chối, không treo chờ).`;
      executionReasoning = vetoedBy
        ? "VETO hard-enforce (AUD-CODE #6): tín hiệu vi phạm bị hạ về HOLD."
        : "Tín hiệu GIỮ — không tạo lệnh, tự đóng có lý do cuối chu kỳ (#91).";
      execOutput = { signalId: signalRow.id, direction: "HOLD", vetoed: Boolean(vetoedBy), autoDecisionPending: true };
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
    state.createdMessages.push({
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
        `Chủ tịch Hội đồng đề xuất mã ${strategist.signal.symbol} không có trong vũ trụ giao dịch (bảng chỉ báo CP/ETF Việt Nam) — tín hiệu bị bỏ qua (no fabrication). Đề nghị Chủ tịch chỉ chọn mã Việt Nam trong bảng chỉ báo: chính sách Hội đồng chỉ đầu tư tại thị trường VN, thị trường quốc tế chỉ tham chiếu.`,
        "Mã không hợp lệ — từ chối ghi nhận tín hiệu.",
        null
      );
      state.createdMessages.push({
        id: warnMessage.id,
        fromAgentId: executorAgent.id,
        content: warnMessage.content,
        reasoning: warnMessage.reasoning,
        sentiment: null,
      });
    }
  }

  return { createdSignal, executionRunId, signalExpiresAt };
}
