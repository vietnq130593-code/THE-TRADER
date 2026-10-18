/**
 * scripts/p137-reset-risk-prior.ts (Task 138-a · F-23 P0 world-context) —
 * RESET TRẠNG THÁI NHIỄM C1 sau khi vá world-context cho risk/scenario engine.
 *
 * AUDIT 137 C1: Beta CRB-7 `risk-quant-limits` đã nhiễm do engine đo NHẦM thế
 * giới (positions sandbox + cash paper → breach giả mỗi chu kỳ → α tăng
 * 9-20×). Sau fix world-context phải reset về prior Beta(1,99) — nếu không,
 * learning tiếp tục siết trên quá khứ sai (nợ kỹ thuật #8 của audit C).
 *
 *  (a) Đọc + in AppSetting `risk-quant-limits` TRƯỚC (bằng chứng nhiễm).
 *  (b) Reset key về prior — dùng `resetRiskQuantLimits()` của chính engine
 *      (CRB-7.4 "nút reset thủ công": ghi prior Beta(1,99) + AuditLog
 *      RISK_QUANT_LIMITS_RESET minh bạch; hiệu quả như xoá key vì
 *      parseLimits(null) cũng fallback cùng prior).
 *  (c) Ack các RiskAlert EXEC_RECONCILE_MISMATCH chưa ack (alert giả C2 —
 *      Trade sandbox rơi vào window paper; 14-10 & 16-10 đã nổ thật, có thêm
 *      bản 11-10 cùng họ "0 giao dịch" sau write ngoài fill-engine).
 *  (d) In xác minh SAU reset (limits về prior + 0 alert chưa ack).
 *
 * Chạy: env -u DATABASE_URL bun scripts/p137-reset-risk-prior.ts
 */
import { db } from "../src/lib/db";
import {
  RISK_QUANT_SETTING_KEY,
  resetRiskQuantLimits,
} from "../src/lib/risk/engine";

const fmtLimits = (raw: string | null): string => {
  if (raw == null) return "(key KHÔNG tồn tại — engine fallback prior Beta(1,99))";
  try {
    const p = JSON.parse(raw) as Record<string, { alpha?: unknown; beta?: unknown }>;
    const one = (k: string): string => {
      const o = p[k] ?? {};
      return `α=${String(o.alpha)} β=${String(o.beta)}`;
    };
    return (
      `sector ${one("sector")} · position ${one("position")} · ` +
      `dd ${one("dd")} · dailyLoss ${one("dailyLoss")}`
    );
  } catch {
    return `(JSON không parse được: ${raw.slice(0, 80)}…)`;
  }
};

async function main(): Promise<void> {
  console.log("════ P137 RESET RISK PRIOR — world-context C1 (audit 137) ════");

  /* ── (a) TRƯỚC: đọc AppSetting risk-quant-limits ── */
  const before = await db.appSetting.findUnique({ where: { key: RISK_QUANT_SETTING_KEY } });
  console.log(`[a] AppSetting "${RISK_QUANT_SETTING_KEY}" TRƯỚC reset:`);
  console.log(`    ${fmtLimits(before?.value ?? null)}`);

  /* ── (b) Reset về prior Beta(1,99) + AuditLog (resetRiskQuantLimits CRB-7.4) ── */
  await resetRiskQuantLimits();
  console.log(`[b] Đã reset "${RISK_QUANT_SETTING_KEY}" về prior Beta(1,99) (resetRiskQuantLimits + AuditLog RISK_QUANT_LIMITS_RESET).`);

  /* ── (c) Ack các RiskAlert EXEC_RECONCILE_MISMATCH CHƯA ack (alert giả C2) ── */
  const unacked = await db.riskAlert.findMany({
    where: { code: "EXEC_RECONCILE_MISMATCH", acknowledgedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, createdAt: true, message: true },
  });
  if (unacked.length === 0) {
    console.log("[c] Không có RiskAlert EXEC_RECONCILE_MISMATCH nào chưa ack.");
  } else {
    const now = new Date();
    const res = await db.riskAlert.updateMany({
      where: { id: { in: unacked.map((a) => a.id) } },
      data: { acknowledgedAt: now },
    });
    console.log(`[c] Đã ack ${res.count} RiskAlert EXEC_RECONCILE_MISMATCH (acknowledgedAt = ${now.toISOString()}):`);
    for (const a of unacked) {
      console.log(`    · ${a.createdAt.toISOString()} — ${a.message.slice(0, 120)}…`);
    }
  }

  /* ── (d) SAU: xác minh ── */
  const after = await db.appSetting.findUnique({ where: { key: RISK_QUANT_SETTING_KEY } });
  console.log(`[d] AppSetting "${RISK_QUANT_SETTING_KEY}" SAU reset:`);
  console.log(`    ${fmtLimits(after?.value ?? null)}`);
  const remain = await db.riskAlert.count({
    where: { code: "EXEC_RECONCILE_MISMATCH", acknowledgedAt: null },
  });
  console.log(`[d] EXEC_RECONCILE_MISMATCH chưa ack còn lại: ${remain}`);
  const priorOk =
    after?.value != null &&
    (() => {
      try {
        const p = JSON.parse(after.value as string) as Record<string, { alpha?: number; beta?: number }>;
        return Object.values(p).every((o) => o.alpha === 1 && o.beta === 99);
      } catch {
        return false;
      }
    })();
  console.log(
    `\nKẾT QUẢ: ${priorOk && remain === 0 ? "PASS — prior Beta(1,99) đã đặt lại + alert giả đã ack." : "FAIL — kiểm tra thủ công."}`
  );
  if (!priorOk) process.exitCode = 1;
}

main()
  .catch((e: unknown) => {
    console.error("FAIL:", e);
    process.exit(1);
  })
  .finally(() => {
    void db.$disconnect();
  });
