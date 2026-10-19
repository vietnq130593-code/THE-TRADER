/** (Task 144 P2-b) — tách từ src/lib/agent-context.ts (pure move)
 *  E-P1-1 (EXECUTION_OPS_BLUEPRINT v1.2): block TỶ TRỌNG DANH MỤC —
 *  buildPortfolioWeightsBlock. */

import { db } from "@/lib/db";

/**
 * E-P1-1 (EXECUTION_OPS_BLUEPRINT v1.2): block TỶ TRỌNG DANH MỤC hiện tại
 * cho prompt Chủ tịch — dữ liệu chuẩn để LLM điền `allocation.rows[].currentPct`
 * không bịa (mọi con số prompt đều đo từ Position × giá / equity F-102).
 * Gồm: từng vị thế mở (symbol, %NAV) + dòng tiền mặt (%NAV) — đúng cấu trúc
 * mà khối đề xuất phân bổ của A1 cần đối chiếu.
 */
export async function buildPortfolioWeightsBlock(): Promise<string> {
  // F-73A-08: lọc theo tài khoản sống — không trộn vị thế của tài khoản khác/
  // đã soft-delete (mọi consumer khác đều lọc brokerAccountId).
  // K1 (#87 — P0 quarantine §5.1): đường paper loại trừ sandbox.
  const account = await db.brokerAccount.findFirst({
    where: { deletedAt: null, accountType: { not: "sandbox" } },
    select: { id: true, cashBalance: true },
  });
  if (!account) {
    return [
      "TỶ TRỌNG DANH MỤC HIỆN TẠI (%NAV — dữ liệu chuẩn cho khối đề xuất phân bổ):",
      "- (không có tài khoản sống — không đo được tỷ trọng)",
    ].join("\n");
  }
  const positions = await db.position.findMany({
    where: { brokerAccountId: account.id, status: "OPEN" },
    select: {
      quantity: true,
      avgPrice: true,
      instrument: {
        select: {
          symbol: true,
          quotes: { orderBy: { tradedAt: "desc" }, take: 1, select: { last: true } },
        },
      },
    },
  });
  const cash = Number(account.cashBalance);
  const rows = positions.map((p) => {
    const last = p.instrument.quotes[0]?.last ?? p.avgPrice;
    return { symbol: p.instrument.symbol, mv: last * p.quantity };
  });
  const positionsMv = rows.reduce((s, r) => s + r.mv, 0);
  const equity = cash + positionsMv;
  const lines = [`- TIỀN MẶT: ${Math.round(cash).toLocaleString("vi-VN")} ₫ (~${equity > 0 ? ((cash / equity) * 100).toFixed(1) : "0"}% NAV)`];
  for (const r of rows.sort((a, b) => b.mv - a.mv)) {
    lines.push(
      `- ${r.symbol}: ${Math.round(r.mv).toLocaleString("vi-VN")} ₫ (~${equity > 0 ? ((r.mv / equity) * 100).toFixed(1) : "0"}% NAV)`
    );
  }
  return [
    "TỶ TRỌNG DANH MỤC HIỆN TẠI (%NAV — dữ liệu chuẩn cho khối đề xuất phân bổ):",
    ...(lines.length > 1 ? lines : ["- (danh mục trống — toàn tiền mặt)"]),
  ].join("\n");
}
