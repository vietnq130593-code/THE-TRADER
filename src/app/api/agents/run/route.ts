import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";
import { assignChairmanTasks, type AssignChairmanTasksResult } from "@/lib/k4";
import { dataQualityPromptBlock, type DataQualityVerdict } from "@/lib/data-quality";
import {
  ALL_CODES,
  CHAIRMAN_CODE,
  WAVE_A_CODES,
  WAVE_B_LLM_CODES,
  WAVE_B_SERVICE_CODES,
  WAVE_C_LLM_CODES,
  WAVE_C_SERVICE_CODES,
  WAVE_E_SERVICE_CODES,
  checkAndClaimCycleCooldown,
  prepareCycle,
  restoreCycleCooldown,
} from "@/lib/agents-run/prepare";
import {
  buildChairmanUserPrompt,
  buildCycleContextBlocks,
  buildResearchPrompts,
  buildRiskManagerPrompt,
  runRiskQuantForCycle,
} from "@/lib/agents-run/context-build";
import {
  buildLlmVotes,
  runChairmanCycle,
  runOneServiceAgent,
  runWaveA,
  runWaveBLlmAgents,
  runWaveBServices,
  runWaveC,
  type CycleRunState,
} from "@/lib/agents-run/agent-loop";
import {
  heartbeatRunningAgentsFor,
  persistSignalAndExecution,
  runBayesSynthesis,
} from "@/lib/agents-run/persist";
import {
  autoDecideCycleSignal,
  convertCycleSignalToSandbox,
  writeCycleAuditLog,
} from "@/lib/agents-run/finalize";

export const dynamic = "force-dynamic";
// 300s: 6 LLM tuần tự × timeout 45s (llm.ts) + 17 service ~0.5s + biên độ —
// trước đây 120s dễ bị kill giữa chu kỳ nếu gateway LLM đình trệ (AUD-CODE #8)
export const maxDuration = 300;

/**
 * POST /api/agents/run — chu kỳ phân tích đầy đủ 24 AGENTS, 6 ĐỢT (phiên #34 + #126):
 *
 *  ĐỢT A · Nền tảng dữ liệu (4 service — 0 LLM, 3 nhịp con §3.3 — #57):
 *    nhịp 1: S0 data-collector ∥ S2 feature-store → nhịp 2: A9 data-integrity
 *    (6 phép kiểm → DataQualityVerdict; SEVERE → RiskAlert ack) → nhịp 3: S1
 *    notification-officer (digest có dòng chất lượng dữ liệu — P0-7). Verdict
 *    ≠ PASS → khối TÍNH TRẠNG DỮ LIỆU vào prompt nghiên cứu + Chủ tịch (P0-4).
 *  ĐỢT B · Hội đồng Nghiên cứu + Phòng Học máy:
 *    service song song (8): ml-forecast · backtest · learning-rag · rl-gym ·
 *    rl-policy · dl-trainer · rl-trainer · model-registry
 *    LLM tuần tự (5): market-analyst · fair-value · news-sentiment · liquidity
 *    · macro-economist (#126 A20 — bảng điều khiển vĩ mô 3 lớp)
 *    (mỗi agent LLM trả thêm assessment JSON {direction, confidence, evidence})
 *  ĐỢT C · Ủy ban Kiểm soát (VETO): risk-manager (LLM) + exposure · compliance
 *    (service, chạy song song với risk-manager)
 *  ĐỢT D · BỘ TỔNG HỢP BAYES (mới — phiên #34, 0 LLM ~1-2s): buildEvidenceBundle
 *    (breadth/lexicon tin 24h/flows/Holt/regime + assessment JSON của 6 agent
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
 *
 *  (Task 144 P2-a) Thân chu kỳ tách thuần (pure move) sang src/lib/agents-run/:
 *  prepare (cổng cooldown + pre-cycle) · context-build (snapshot + RAG L1/L2 +
 *  XREL + prompt nghiên cứu/risk-manager/Chủ tịch) · agent-loop (đợt A/B/C +
 *  Chủ tịch LLM) · persist (AgentRun/AgentMessage + Bayes + Đợt F) · finalize
 *  (K1 sandbox + quyết định #91 + audit log). buildPortfolioWeightsBlock() và
 *  parseAllocationProposal/bumpAllocationParseFail giờ chạy trong
 *  context-build.ts/agent-loop.ts qua các bước dưới — hành vi giữ nguyên.
 */
export async function POST() {
  // F-203 (audit 19-b): guard 60s giữa 2 chu kỳ — trả 429 kèm thời gian chờ còn lại
  const gate = checkAndClaimCycleCooldown();
  if (!gate.allowed) {
    return NextResponse.json(
      {
        error: `Chu kỳ agent trước đó chạy cách đây ${gate.sinceLastSeconds}s. Vui lòng đợi thêm chút để tránh tốn chi phí LLM.`,
        retryAfterSeconds: gate.retryAfterSeconds,
      },
      // F-210b (audit 19-b): header chuẩn Retry-After để client backoff đúng
      {
        status: 429,
        headers: {
          "Retry-After": String(gate.retryAfterSeconds),
        },
      }
    );
  }

  // F-1091-02 (fixbug api #109 — P1): CLAIM cooldown ĐỒNG BỘ ngay sau check.
  // Pattern cũ (check → 2+ await reap/findMany → set ở dưới) để cửa sổ
  // TOCTOU: engine tick + click tay cùng lúc đều qua check rồi chạy chu kép
  // (2× chi phí LLM + trùng Signal/AgentMessage/AgentRun). Không còn await
  // nào giữa check và claim → yêu cầu concurrent thứ 2 dính 429 ngay.
  // Thất bại validate sớm / lỗi DB TRƯỚC khi chu kỳ thật sự chạy → TRẢ LẠI mốc
  // cũ (giữ nguyên nghĩa AUD-CODE #10: fail sớm không bắt user chờ 60s).
  const prevCycleStartedAt = gate.prevCycleStartedAt;

  const cycleStart = Date.now();

  // F-1091-03 (fixbug api #109): pre-cycle (reap/findMany/updateMany) gói
  // trong prepareCycle — mọi đường fail (404/409/500) trả response JSON đúng
  // shape { error } + rollback cooldown như cũ.
  const prep = await prepareCycle();
  if (!prep.ok) {
    restoreCycleCooldown(prevCycleStartedAt);
    return prep.response;
  }
  const { agents, byCode, k4 } = prep;

  // Trạng thái dùng chung chu kỳ: phân tích theo code (đưa vào digest cho
  // Chủ tịch) + tin broadcast đã tạo + agent fail (AUDIT 137 A4 heartbeat
  // ở persist.ts heartbeatRunningAgentsFor).
  const state: CycleRunState = {
    byCode,
    analyses: new Map(),
    createdMessages: [],
    failures: [],
  };
  const heartbeatRunningAgents = heartbeatRunningAgentsFor(agents);

  try {
    // ── 1. Snapshot 7 khối + RAG L1/L2 + XREL (context-build.ts) ──
    const blocks = await buildCycleContextBlocks(heartbeatRunningAgents);

    // ══ ĐỢT A · Nền tảng dữ liệu — 3 nhịp con (agent-loop.ts) ══
    const dqVerdict: DataQualityVerdict | null = await runWaveA(state, heartbeatRunningAgents);

    // P0-4 §3.3 + chốt 8-1b: verdict ≠ PASS → khối "TÍNH TRẠNG DỮ LIỆU" vào
    // prompt 5 agent nghiên cứu LLM + Chủ tịch (ml-forecast là service — 6
    // agent nghiên cứu đủ phủ). PASS → không tiêm (tiết kiệm token).
    const dqPromptBlock =
      dqVerdict && dqVerdict.level !== "PASS" ? dataQualityPromptBlock(dqVerdict) : null;
    const prompts = buildResearchPrompts(blocks, dqPromptBlock);

    // ══ ĐỢT B · Nghiên cứu + Học máy ═══════════════════════════════
    const waveBServiceResults = await runWaveBServices(state, heartbeatRunningAgents);
    await runWaveBLlmAgents(state, prompts, heartbeatRunningAgents);

    // Cả 5 agent nghiên cứu LLM đều lỗi → không thể tổng hợp
    if (WAVE_B_LLM_CODES.every((c) => state.failures.includes(c))) {
      // F-205 (audit 19-b): không để các agent sau kẹt RUNNING khi chu kỳ bỏ cuộc sớm
      await db.agent
        .updateMany({
          where: { code: { in: ALL_CODES.filter((c) => !state.failures.includes(c) && !state.analyses.has(c)) } },
          data: { status: "IDLE" },
        })
        .catch(() => undefined);
      return NextResponse.json(
        {
          error:
            "Cả 5 agent nghiên cứu (Market/Fair Value/News/Liquidity/Macro Economist) đều lỗi lúc này (mô hình AI không phản hồi). Vui lòng thử lại sau ít phút.",
          failures: state.failures,
        },
        { status: 502 }
      );
    }

    // ══ [CRB-0] RISKQUANT ENGINE (context-build.ts) + prompt risk-manager ══
    const { riskQuant, mlForecastDirection } = await runRiskQuantForCycle(waveBServiceResults);
    prompts["risk-manager"] = buildRiskManagerPrompt(blocks, riskQuant);

    // ══ ĐỢT C · Ủy ban Kiểm soát (VETO) + trích verdict (agent-loop.ts) ══
    const veto = await runWaveC(state, prompts, riskQuant);
    // AUDIT 137 A4 — heartbeat sau đợt C (Ủy ban Kiểm soát, trước Chủ tịch)
    await heartbeatRunningAgents();

    // ══ ĐỢT D · BỘ TỔNG HỢP BAYES (persist.ts runBayesSynthesis) ══
    // Phiếu LLM 5 cử tri — dùng cho Bayes (llm-vote) + Kelly CRB-9 (hướng đồng thuận)
    const llmVotes = buildLlmVotes(state.analyses);
    const { assessmentSummary, bayesView } = await runBayesSynthesis(llmVotes, veto, riskQuant);

    // ══ ĐỢT E · Chủ tịch Hội đồng — tổng hợp 20 agents + Bayes ══════
    const strategistAgent = state.byCode.get(CHAIRMAN_CODE)!;
    const { userPrompt: strategistUserPrompt, digestLines } = await buildChairmanUserPrompt(blocks, {
      analyses: state.analyses,
      k4,
      dqPromptBlock,
      bayesView,
      riskQuant,
      veto,
    });
    const { strategist, strategistRunId, strategistRaw } = await runChairmanCycle(
      state,
      strategistAgent,
      strategistUserPrompt,
      blocks.market,
      llmVotes,
      mlForecastDirection,
      riskQuant,
      bayesView
    );
    // AUDIT 137 A4 — heartbeat sau Chủ tịch (ranh giới wave rõ: đợt E sắp bắt
    // đầu, cuộc gọi LLM dài nhất đã kết thúc)
    await heartbeatRunningAgents();

    // ── K4 (#94 — AUTONOMY_BLUEPRINT §7.1): Chủ tịch GIAO VIỆC ──────────────
    // Sau khi Chairman chạy xong (có output thô) và TRƯỚC Đợt F: parse
    // assignTasks từ output → validate từng nhiệm vụ → tạo AgentTask
    // createdByAgentId = Chủ tịch. TUYỆT ĐỐI fail-soft: JSON rác → 0 nhiệm vụ,
    // chu kỳ vẫn COMPLETED (dữ liệu đầu vào phải chịu được — §7.1). Chairman
    // fail (không output) → không giao. k4 tắt → bỏ hẳn (0 hiệu ứng).
    let k4Result: AssignChairmanTasksResult | null = null;
    if (k4.enabled && strategistRaw) {
      k4Result = await assignChairmanTasks(strategistRaw, {
        chairmanAgentId: strategistAgent.id,
        k4,
        now: new Date(cycleStart),
      });
    }

    // ══ ĐỢT F · Thực thi & hậu cần (persist.ts persistSignalAndExecution) ══
    const { createdSignal, executionRunId, signalExpiresAt } = await persistSignalAndExecution(
      state,
      strategist,
      strategistAgent,
      blocks.market,
      digestLines,
      veto,
      bayesView
    );

    // Settlement + Cash Management (service, song song)
    await Promise.all(WAVE_E_SERVICE_CODES.map((code) => runOneServiceAgent(state, code)));
    // AUDIT 137 A4 — heartbeat sau đợt E (wave Promise.all cuối cùng)
    await heartbeatRunningAgents();

    // ── K1 (#87): auto-convert CUỐI CHU KỲ (finalize.ts — fail-soft) ──
    const k1Sandbox = createdSignal ? await convertCycleSignalToSandbox(createdSignal.id) : null;

    // ── PHIÊN #91: quyết định tức thì theo cổng đồng thuận (finalize.ts) ──
    const autoDecision = createdSignal ? await autoDecideCycleSignal(createdSignal.id) : null;

    // ── Cycle-level audit log (finalize.ts) ─────────────────────────
    const cycleDurationMs = Date.now() - cycleStart;
    const ranCount = state.analyses.size + (strategist ? 1 : 0) + (executionRunId ? 1 : 0);
    await writeCycleAuditLog({
      cycleDurationMs,
      ranCount,
      createdMessageCount: state.createdMessages.length,
      createdSignal,
      failures: state.failures,
      strategistRunId,
      executionRunId,
      k1Sandbox,
      autoDecision,
      k4Result,
      assessmentSummary,
    });

    // ── Response (shape per TECHNICAL_BLUEPRINT §4) ────────────────
    const messageRows = await db.agentMessage.findMany({
      where: { id: { in: state.createdMessages.map((m) => m.id) } },
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
        order: null, // giữ trường cho client cũ — lệnh paper chỉ tạo khi trader phê duyệt
        // K1 (#87): lệnh sandbox tự sinh từ tín hiệu chu kỳ này (world riêng —
        // không phải "order" paper; client hiển thị qua khối K1/Thử nghiệm)
        k1Sandbox,
        // PHIÊN #91 (tái triển khai): quyết định tức thì của tín hiệu chu kỳ
        // theo cổng đồng thuận (approved/rejected/skipped/error + note).
        autoDecision,
        // K4 (#94 §7.1): nhiệm vụ Chủ tịch giao trong chu kỳ này (null khi k4
        // tắt — UI khối Ban Điều hành đọc chi tiết từ GET /api/k4).
        k4: k4Result,
        failures: state.failures,
        durationMs: cycleDurationMs,
        // Mở rộng 23 agents — tổng kết các đợt đã chạy
        waves: {
          architecture: "24-agents",
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
