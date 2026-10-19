/** (Task 144 P2-a) — tách từ src/app/api/agents/run/route.ts (pure move)
 *  Hậu chu kỳ: K1 sandbox auto-convert, quyết định tức thì cổng đồng thuận
 *  (phiên #91), audit log AGENT_RUN_COMPLETED. */

import { db } from "@/lib/db";
// K1 (#87 — AUTONOMY_BLUEPRINT v1.1 §5.3): auto-convert tín hiệu chu kỳ sang sandbox.
import { autoConvertSignalToSandbox } from "@/lib/k-sandbox";
import { autoDecideSignalByConsensus } from "@/lib/signal-execution";
import type { AssignChairmanTasksResult } from "@/lib/k4";
import type { CycleAssessmentSummary } from "@/lib/types";
import type { CycleCreatedSignal } from "./persist";

/**
 * ── K1 (#87 — AUTONOMY_BLUEPRINT v1.1 §5.3): auto-convert CUỐI CHU KỲ ──
 * Điểm ghép DUY NHẤT của sandbox: sau khi mọi tín hiệu đã lưu + mọi wave
 * hoàn tất (chu kỳ kết thúc sạch). Tín hiệu của chu kỳ vừa sinh mà QUA CỔNG
 * ĐỒNG THUẬN B9 → lệnh sandbox (agents tự giao dịch — Q1 §8). KHÔNG đổi
 * Signal.status (2 thế giới độc lập) · idempotent qua marker audit · fail-soft
 * tuyệt đối (lỗi K1 KHÔNG bao giờ làm hỏng chu kỳ 23 agents).
 */
export async function convertCycleSignalToSandbox(signalId: string) {
  return autoConvertSignalToSandbox(signalId).catch((k1err) => {
    console.error("[api/agents/run:k1] auto-convert sandbox fail-soft:", k1err);
    return { converted: 0, orders: [], skipped: [{ reason: "loi-noi-bo (fail-soft)" }] };
  });
}

/**
 * ── PHIÊN #91 (tái triển khai trên #111) — QUYẾT ĐỊNH TỨC THÌ THEO ──
 * CỔNG ĐỒNG THUẬN (thế giới paper). Hiệu lệnh trader: "1 là duyệt, 2 là
 * từ chối — đủ đồng thuận thì duyệt ngay, không đủ thì từ chối ngay".
 * Chạy SAU K1 sandbox auto-convert (sandbox cần status ACTIVE — §5.3 2
 * thế giới độc lập; lệnh sandbox không cản đường duyệt paper nhờ F-207
 * vá #91). Fail-soft: lỗi auto-decision KHÔNG làm hỏng chu kỳ — tín
 * hiệu giữ ACTIVE cho expiry sweep dọn.
 */
export async function autoDecideCycleSignal(signalId: string) {
  return autoDecideSignalByConsensus(signalId).catch((adErr) => {
    console.error("[api/agents/run:#91] auto-decision fail-soft:", adErr);
    return {
      decision: "error" as const,
      ratio: null,
      note: "Lỗi nội bộ auto-decision (fail-soft) — tín hiệu giữ ACTIVE.",
      orderId: undefined,
    };
  });
}

export interface CycleAuditInput {
  cycleDurationMs: number;
  ranCount: number;
  createdMessageCount: number;
  createdSignal: CycleCreatedSignal | null;
  failures: string[];
  strategistRunId: string;
  executionRunId: string;
  k1Sandbox: Awaited<ReturnType<typeof convertCycleSignalToSandbox>> | null;
  autoDecision: Awaited<ReturnType<typeof autoDecideCycleSignal>> | null;
  k4Result: AssignChairmanTasksResult | null;
  assessmentSummary: CycleAssessmentSummary | null;
}

/** ── Cycle-level audit log (AGENT_RUN_COMPLETED — G4) ────────── */
export async function writeCycleAuditLog(input: CycleAuditInput): Promise<void> {
  await db.auditLog.create({
    data: {
      action: "AGENT_RUN_COMPLETED",
      entity: "AgentRun",
      entityId: input.strategistRunId || input.executionRunId || null,
      after: JSON.stringify({
        architecture: "24-agents",
        messages: input.createdMessageCount,
        agentsRan: input.ranCount,
        signal: input.createdSignal?.symbol ?? null,
        order: null, // §4.9 — chu kỳ không còn tự tạo lệnh (lệnh paper chỉ khi trader duyệt)
        durationMs: input.cycleDurationMs,
        failures: input.failures,
        // K1 (#87 §5.3): kết quả auto-convert sandbox của chu kỳ (null khi không
        // có tín hiệu; converted=0 + lý do skip khi chưa kích hoạt/đình chỉ)
        k1Sandbox: input.k1Sandbox
          ? {
              converted: input.k1Sandbox.converted,
              orders: input.k1Sandbox.orders.map((o) => ({
                orderId: o.orderId,
                symbol: o.symbol,
                side: o.side,
                quantity: o.quantity,
              })),
              skipped: input.k1Sandbox.skipped.map((s) => s.reason),
            }
          : null,
        // PHIÊN #91 (tái triển khai trên #111) — kết quả quyết định tức thì
        // theo cổng đồng thuận của tín hiệu chu kỳ (null khi strategist
        // không ra tín hiệu): approved (đủ ≥80% — lệnh đặt được hay không
        // ghi rõ orderCreated) | rejected (HOLD · <80% · guard) |
        // skipped/error (fail-soft hiếm).
        autoDecision: input.autoDecision
          ? {
              decision: input.autoDecision.decision,
              ratio: input.autoDecision.ratio,
              note: input.autoDecision.note,
              orderId: input.autoDecision.orderId ?? null,
            }
          : null,
        // K4 (#94 §7.1): kết quả giao việc của Chủ tịch trong chu kỳ (null khi
        // k4 tắt / Chairman fail; created rỗng khi Chairman không giao việc)
        k4: input.k4Result
          ? {
              assigned: input.k4Result.created.length,
              tasks: input.k4Result.created.map((t) => ({
                agentCode: t.agentCode,
                title: t.title,
                schedule: t.schedule,
              })),
              skipped: input.k4Result.skipped.map((s) => s.reason),
            }
          : null,
        // Phiên #34 — tóm tắt Bộ tổng hợp Bayes của chu kỳ (null khi tổng hợp lỗi)
        assessment: input.assessmentSummary
          ? {
              pUp: Number(input.assessmentSummary.pUp.toFixed(4)),
              marketDirection: input.assessmentSummary.marketDirection,
              evidenceCount: input.assessmentSummary.evidenceCount,
            }
          : null,
      }),
    },
  });
}
