/**
 * src/lib/exec/committed.ts — A12 CommittedCashView (E-P0-4,
 * EXECUTION_OPS_BLUEPRINT v1.1 §3.2/§4) — sức mua KỂ CẢ cam kết tiềm năng.
 *
 * ⚠️ ĐIỀU KIỆN BẮT BUỘC #1 CỦA TRADER (REV-1 review #69):
 * committed = Σ sizing nav5pct của tín hiệu ACTIVE (ước tính) **+ Σ notional
 * còn lại của Order PENDING/PARTIALLY_FILLED**. Bản v1.0 của blueprint chỉ đếm
 * tín hiệu ACTIVE — tín hiệu APPROVE rời tập ACTIVE ĐÚNG LÚC lệnh PENDING sinh
 * → mù đúng chỗ cam kết thật. Đọc từ chính Order ((quantity − filledQuantity) ×
 * price) nên tự nhiên phủ cả 2 đường sizing nav5pct (decision) lẫn budget50m
 * (convert) — không cần suy ngược signal đã đi đường nào.
 *
 * KHÔNG CHẶN (§6.4/§6.7): chỉ tham mưu + nhãn "ước tính nội bộ" — trader tự
 * quyết. committedBuyingPower âm → badge cảnh báo (mặc định §7.3), không
 * RiskAlert ack-bắt-buộc.
 */

import { db } from "@/lib/db";
import { FEE_RATE, TAX_RATE, POSITION_SIZE_PCT } from "@/lib/exec/constants";

/** Đầu vào từ snapshot danh mục (agent-service-runs portfolioSnapshot). */
export interface CommittedViewInput {
  cash: number;
  equity: number;
  marginUsed: number;
  buyingPowerFactor: number;
  marginRoomMinVnd: number;
}

/** Hợp đồng CommittedCashView §3.2 (v1.1 — có pendingOrders). */
export interface CommittedCashView {
  cash: number;
  equity: number;
  marginUsed: number;
  buyingPower: number;
  /** Tổng cam kết (BUY) + dòng vào tiềm năng (SELL) — quy ước hiển thị. */
  committedNotional: number;
  /** Tiền SẼ RA nếu mọi cam kết BUY thực hiện (kèm phí ước tính). */
  committedBuyNotional: number;
  /** Tiền SẼ VÀO nếu mọi lệnh SELL đang chờ khớp (đã trừ phí + thuế). */
  committedSellInflow: number;
  /** Sức mua còn lại sau cam kết — badge cảnh báo khi âm. */
  committedBuyingPower: number;
  activeSignals: number;
  activeBuySignals: number;
  pendingOrders: number;
  pendingBuyOrders: number;
  tight: boolean;
  committedTight: boolean;
  label: string;
}

/**
 * Tính CommittedCashView. Mọi con số là ƯỚC TÍNH NỘI BỘ:
 *  - tín hiệu ACTIVE: mỗi tín hiệu BUY ≈ equity × POSITION_SIZE_PCT (nav5pct
 *    — đường decision; đường convert budget50m chỉ khác khi trader chọn
 *    convert tay, khi đó lệnh PENDING đo trực tiếp đã phủ);
 *  - lệnh PENDING/PARTIALLY_FILLED: notional còn lại THẬT từ chính Order.
 */
export async function computeCommittedCashView(
  input: CommittedViewInput
): Promise<CommittedCashView> {
  const now = new Date();

  // ── Tín hiệu ACTIVE (BUY/SELL, chưa hết hạn — sweep đã chạy trước đó,
  //    filter expiresAt phòng tín hiệu chết chưa kịp sweep) ──
  const activeSignals = await db.signal.findMany({
    where: {
      status: "ACTIVE",
      direction: { in: ["BUY", "SELL"] },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { id: true, direction: true, instrumentId: true },
  });
  const activeBuySignals = activeSignals.filter((s) => s.direction === "BUY").length;
  // Mỗi tín hiệu BUY ≈ equity × 5% (nav5pct — ước tính, không cần quote).
  const signalCommittedBuy = activeBuySignals * input.equity * POSITION_SIZE_PCT;

  // ── Lệnh PENDING/PARTIALLY_FILLED — cam kết THẬT (REV-1) ──
  const pendingOrders = await db.order.findMany({
    where: {
      status: { in: ["PENDING", "PARTIALLY_FILLED"] },
      price: { not: null },
      brokerAccountId: { not: null },
    },
    select: { side: true, quantity: true, filledQuantity: true, price: true },
  });
  let orderCommittedBuy = 0; // notional + phí ước tính
  let orderSellInflow = 0; // notional − phí − thuế
  let pendingBuyOrders = 0;
  for (const o of pendingOrders) {
    if (o.price == null) continue;
    const remaining = Math.max(0, o.quantity - o.filledQuantity);
    if (remaining <= 0) continue;
    const notional = remaining * o.price;
    if (o.side === "BUY") {
      pendingBuyOrders++;
      orderCommittedBuy += notional * (1 + FEE_RATE);
    } else {
      orderSellInflow += notional * (1 - FEE_RATE - TAX_RATE);
    }
  }

  // AUD-CODE #15b giữ nguyên: sức mua = cash + GTTH × factor − margin.
  const positionsMv = Math.max(0, input.equity - input.cash);
  const buyingPower = input.cash + positionsMv * input.buyingPowerFactor - input.marginUsed;

  const committedBuyNotional = signalCommittedBuy + orderCommittedBuy;
  const committedBuyingPower = buyingPower - committedBuyNotional;

  return {
    cash: input.cash,
    equity: input.equity,
    marginUsed: input.marginUsed,
    buyingPower,
    committedNotional: committedBuyNotional + orderSellInflow,
    committedBuyNotional,
    committedSellInflow: orderSellInflow,
    committedBuyingPower,
    activeSignals: activeSignals.length,
    activeBuySignals,
    pendingOrders: pendingOrders.length,
    pendingBuyOrders,
    tight: buyingPower < input.marginRoomMinVnd,
    committedTight: committedBuyingPower < input.marginRoomMinVnd,
    label: "ước tính nội bộ — không phải hạn mức thật VNDIRECT",
  };
}

/** Tóm tắt 1 câu cho content ServiceRunResult của A12. */
export function committedViewSummary(v: CommittedCashView): string {
  const vnd = (n: number) => Math.round(n).toLocaleString("vi-VN");
  const parts = [
    `tiền mặt ${vnd(v.cash)} ₫`,
    `NAV ${vnd(v.equity)} ₫`,
    `sức mua ước tính ${vnd(v.buyingPower)} ₫`,
  ];
  if (v.activeSignals > 0 || v.pendingOrders > 0) {
    parts.push(
      `cam kết tiềm năng ${vnd(v.committedBuyNotional)} ₫ (${v.activeBuySignals}/${v.activeSignals} tín hiệu MUA đang mở` +
        `${v.pendingBuyOrders > 0 ? ` + ${v.pendingBuyOrders} lệnh MUA chờ khớp` : ""}` +
        `${v.pendingOrders - v.pendingBuyOrders > 0 ? ` · ${v.pendingOrders - v.pendingBuyOrders} lệnh BÁN chờ → vào ~${vnd(v.committedSellInflow)} ₫` : ""})` +
        ` → sức mua sau cam kết ~${vnd(v.committedBuyingPower)} ₫`
    );
  }
  if (v.committedTight) {
    parts.push("sức mua sau cam kết dưới hạn mức nội bộ — cân nhắc trước khi duyệt tiếp tín hiệu MUA");
  } else if (v.tight) {
    parts.push("sức mua dưới hạn mức nội bộ");
  }
  return `Dòng tiền: ${parts.join(" · ")} (ước tính nội bộ, không phải hạn mức thật VNDIRECT).`;
}
