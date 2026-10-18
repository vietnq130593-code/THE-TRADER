/**
 * scripts/p139-purge-risk-snapshots.ts (Task 139 · F-23 P4 ops) — PURGE
 * RiskQuantSnapshot NHIỄM C1 theo khuyến nghị vận hành của AUDIT 137 §8.
 *
 * Bối cảnh: trước khi Task 138-a vá world-context, risk engine đo NHẦM thế
 * giới (vị thế sandbox TCB+VIC+VPB + cash paper 0) → chuỗi snapshot
 * nav=29.720.000, proxy=false là "lịch sử NAV paper" GIẢ. Beta dd (CRB-7)
 * học drawdown trên chuỗi này — 7 bản nhiễm còn nằm trong cửa sổ học 400
 * ngày (~66 ngày nữa mới tự lọt ra) → siết hạn mức VETO một chiều theo dữ
 * liệu sai thêm 2 tháng. Purge = cắt ngay chuỗi giả, Beta dd học tiếp trên
 * dữ liệu thật.
 *
 * Tiêu chí xoá: nav = 29.720.000 ĐÚNG (chỉ có thể là 3 vị thế sandbox +
 * cash 0 — paper rỗng thật luôn cho nav=0/proxy=true; nav số nguyên VND
 * trùng ngẫu nhiên với tổ sandbox là vô lý thực tế).
 *
 * (a) Đếm + in các bản nhiễm (bằng chứng TRƯỚC).
 * (b) Xoá + AuditLog RISK_QUANT_SNAPSHOT_PURGE before/after minh bạch.
 * (c) In xác minh SAU (0 bản nav=29.720.000 còn lại + tổng snapshot còn).
 *
 * Idempotent: chạy lần nữa → (a) đếm 0, (b) xoá 0, không tạo audit rỗng.
 * Chạy: env -u DATABASE_URL bun scripts/p139-purge-risk-snapshots.ts
 */
import { db } from "../src/lib/db";

/** Nav "3 vị thế sandbox + cash paper 0" — dấu vân tay nhiễm C1. */
const CONTAMINATED_NAV = 29_720_000;

async function main(): Promise<void> {
  console.log("════ P139 PURGE RiskQuantSnapshot nhiễm C1 (audit 137 §8 khuyến nghị) ════");

  /* ── (a) TRƯỚC: đếm + liệt kê bản nhiễm ── */
  const contaminated = await db.riskQuantSnapshot.findMany({
    where: { nav: CONTAMINATED_NAV },
    orderBy: { createdAt: "asc" },
    select: { id: true, createdAt: true, nav: true, proxyMode: true },
  });
  const totalBefore = await db.riskQuantSnapshot.count();
  console.log(
    `[a] TRƯỚC: ${contaminated.length}/${totalBefore} snapshot có nav=${CONTAMINATED_NAV.toLocaleString("vi-VN")}₫ (dấu vân tay sandbox-nhiễm):`
  );
  for (const s of contaminated) {
    console.log(
      `    ${s.createdAt.toISOString()} · nav=${s.nav.toLocaleString("vi-VN")}₫ · proxyMode=${s.proxyMode}`
    );
  }

  if (contaminated.length === 0) {
    console.log("[b] Không còn bản nhiễm — idempotent, thoát (0 xoá, 0 audit).");
    return;
  }

  /* ── (b) Xoá chuỗi giả + AuditLog ── */
  const deleted = await db.riskQuantSnapshot.deleteMany({
    where: { nav: CONTAMINATED_NAV },
  });
  try {
    await db.auditLog.create({
      data: {
        action: "RISK_QUANT_SNAPSHOT_PURGE",
        entity: "RiskQuantSnapshot",
        entityId: null,
        before: JSON.stringify({
          contaminatedNav: CONTAMINATED_NAV,
          count: contaminated.length,
          ids: contaminated.map((s) => s.id),
          createdAts: contaminated.map((s) => s.createdAt.toISOString()),
          reason:
            "AUDIT 137 C1/§8 — snapshot ghi bởi risk engine trước fix world-context (Task 138-a): đo nhầm vị thế sandbox vào NAV paper; Beta dd học drawdown trên chuỗi giả này ~66 ngày còn lại trong cửa sổ 400",
        }),
        after: JSON.stringify({
          deleted: deleted.count,
          remainingTotal: totalBefore - deleted.count,
          at: new Date().toISOString(),
        }),
      },
    });
  } catch (auditErr) {
    console.error("[b] AuditLog RISK_QUANT_SNAPSHOT_PURGE lỗi (xoá đã xong, chỉ audit fail-soft):", auditErr);
  }
  console.log(`[b] Đã xoá ${deleted.count} snapshot nhiễm + AuditLog RISK_QUANT_SNAPSHOT_PURGE.`);

  /* ── (c) SAU: xác minh ── */
  const remainingContaminated = await db.riskQuantSnapshot.count({
    where: { nav: CONTAMINATED_NAV },
  });
  const totalAfter = await db.riskQuantSnapshot.count();
  console.log(
    `[c] SAU: ${remainingContaminated} bản nhiễm còn lại · tổng ${totalAfter} snapshot (từ ${totalBefore}) — ${
      remainingContaminated === 0 ? "PASS ✓" : "FAIL ✗ (kiểm tra tay!)"
    }`
  );
}

main()
  .catch((err) => {
    console.error("LỖI chặn:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void db.$disconnect();
  });
