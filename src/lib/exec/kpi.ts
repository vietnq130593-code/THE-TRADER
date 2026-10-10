/**
 * src/lib/exec/kpi.ts — KPI vận hành nhóm Điều hành & Thực thi (E-P0-5,
 * EXECUTION_OPS_BLUEPRINT v1.1 §4) — funnel tín hiệu→duyệt→lệnh→khớp trong
 * cửa sổ 30 ngày [DA tr1: Conversion Rate · Churn Rate · AOV · DA D10
 * value_counts/groupby].
 *
 * §6.5 KPI KHÔNG VANITY — mô tả, không phán xét: conversion thấp không đồng
 * nghĩa xấu (trader có thể đúng khi từ chối) [DA tr18-20 tips]. HOLD không
 * vào funnel (không thể chuyển lệnh) — đếm riêng để minh bạch.
 */

import { db } from "@/lib/db";

export interface ExecKpiFunnel {
  /** Tín hiệu BUY/SELL sinh trong window (HOLD đếm riêng holdCount). */
  signals: number;
  /** Đã duyệt → lệnh (ACTED — trader APPROVE/convert). */
  approved: number;
  /** Lệnh gắn tín hiệu ACTED của window (đường phê duyệt — “funnel phê duyệt”
   *  §2 D1). Fixbug #71 F-701-02: trước đây đếm MỌI lệnh order.createdAt∈window
   *  → trộn 2 cohorts (lệnh thủ công/seed/đường cũ làm bước 3 > bước 2).
   *  Giờ neo về 1 cohort: lệnh chỉ vào funnel khi gắn tín hiệu actionable
   *  ACTED của window; lệnh còn lại đếm riêng ordersOutOfFunnel. */
  ordersCreated: number;
  /** Lệnh của cohort đã khớp toàn phần. */
  ordersFilled: number;
  /** E-P1-2 (v1.2): số TÍN HIỆU cohort có ≥1 lệnh (TWAP 1 duyệt = N lệnh con —
   *  bước funnel theo tín hiệu giữ tính đơn điệu; ordersCreated là số LÁT thật). */
  approvedWithOrders: number;
  /** E-P1-2: số tín hiệu cohort có MỌI lệnh con đã FILLED (kế hoạch thực thi
   *  trọn vẹn — tách lát coi là khớp khi đủ cả N lát, không phải 1 lát). */
  signalsFullyFilled: number;
  /** Lệnh tạo trong window KHÔNG từ phễu phê duyệt window (thủ công/seed/
   *  đường cũ) — hiển thị chip riêng để trung thực, không trộn vào funnel. */
  ordersOutOfFunnel: number;
  /** Tín hiệu hết hạn chưa duyệt (churn — [DA tr1]). */
  expired: number;
  /** Tín hiệu GIỮ sinh trong window (ngoài funnel). */
  holdCount: number;
}

export interface ExecKpiSlippage {
  n: number;
  minPct: number;
  p25Pct: number;
  medianPct: number;
  p75Pct: number;
  maxPct: number;
  /** Mẫu thô (giới hạn 100 điểm gần nhất) cho UI vẽ box plot. */
  valuesPct: number[];
}

export interface ExecKpi {
  window: { days: number; from: string; to: string };
  funnel: ExecKpiFunnel;
  /** % duyệt = approved / signals (null khi chưa có tín hiệu — trung thực). */
  approvePct: number | null;
  /** % khớp = ordersFilled / ordersCreated. */
  fillPct: number | null;
  /** "Churn" ≡ tín hiệu EXPIRED chưa duyệt / signals [DA tr1]. */
  churnPct: number | null;
  /** Tín hiệu bị trader từ chối (REJECTED). */
  rejected: number;
  /** AOV — giá trị lệnh khớp trung bình (VND). */
  aovVnd: number | null;
  /** Phân bố lệch giá khớp vs giá đặt của lệnh FILLED [DA D5 box]. */
  slippage: ExecKpiSlippage | null;
  /** Trạng thái tín hiệu window (donut/value_counts [DA D10]). */
  signalStatusCounts: Record<string, number>;
  note: string;
}

/** Quantile kiểu Pandas (linear interpolation) [DA D2]. */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const pct = (num: number, den: number): number | null =>
  den > 0 ? Math.round((num / den) * 1000) / 10 : null;

/** Tính KPI nhóm executive trong cửa sổ `days` ngày gần nhất. */
export async function computeExecKpi(days = 30): Promise<ExecKpi> {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);

  const [signals, orders] = await Promise.all([
    db.signal.findMany({
      where: { createdAt: { gte: from, lt: to } },
      select: { id: true, direction: true, status: true },
    }),
    db.order.findMany({
      where: { createdAt: { gte: from, lt: to } },
      select: {
        status: true,
        quantity: true,
        price: true,
        avgFillPrice: true,
        signalId: true,
      },
    }),
  ]);

  const actionable = signals.filter((s) => s.direction === "BUY" || s.direction === "SELL");
  const signalStatusCounts: Record<string, number> = {};
  for (const s of signals) {
    signalStatusCounts[s.status] = (signalStatusCounts[s.status] ?? 0) + 1;
  }

  const approved = actionable.filter((s) => s.status === "ACTED").length;
  const expired = actionable.filter((s) => s.status === "EXPIRED").length;
  const rejected = actionable.filter((s) => s.status === "REJECTED").length;

  // ── F-701-02 (fixbug #71): neo cohort phễu phê duyệt ──
  // Funnel = cohort tín hiệu actionable sinh trong window: lệnh chỉ được tính
  // ở bước 3/4 khi gắn (signalId) với tín hiệu ACTED của chính cohort đó —
  // giữ funnel ĐƠN ĐIỆU theo 1 dòng thời gian phê duyệt. Lệnh tạo trong window
  // nhưng không từ phễu (thủ công/seed/đường cũ/tín hiệu trước window) không
  // biến mất — đếm riêng ordersOutOfFunnel và UI hiển thị chip minh bạch.
  const approvedSignalIds = new Set(
    actionable.filter((s) => s.status === "ACTED").map((s) => s.id)
  );
  const funnelOrders = orders.filter(
    (o) => o.signalId != null && approvedSignalIds.has(o.signalId)
  );
  const ordersCreated = funnelOrders.length;
  const ordersFilled = funnelOrders.filter((o) => o.status === "FILLED");
  const ordersOutOfFunnel = orders.length - ordersCreated;

  // E-P1-2 (v1.2): funnel bước 3/4 neo theo TÍN HIỆU (giữ đơn điệu khi TWAP
  // 1 duyệt sinh N lệnh con) — approvedWithOrders = distinct tín hiệu cohort
  //  có ≥1 lệnh; signalsFullyFilled = tín hiệu có MỌI lệnh con FILLED (kế
  //  hoạch thực thi trọn vẹn).
  const ordersBySignal = new Map<string, typeof funnelOrders>();
  for (const o of funnelOrders) {
    if (o.signalId == null) continue;
    const arr = ordersBySignal.get(o.signalId) ?? [];
    arr.push(o);
    ordersBySignal.set(o.signalId, arr);
  }
  const approvedWithOrders = ordersBySignal.size;
  const signalsFullyFilled = [...ordersBySignal.values()].filter(
    (arr) => arr.length > 0 && arr.every((o) => o.status === "FILLED")
  ).length;

  // AOV — notional lệnh khớp (avgFillPrice × quantity)
  const filledNotionals = ordersFilled
    .filter((o) => o.avgFillPrice != null)
    .map((o) => o.avgFillPrice! * o.quantity);
  const aovVnd =
    filledNotionals.length > 0
      ? Math.round(filledNotionals.reduce((s, v) => s + v, 0) / filledNotionals.length)
      : null;

  // Slippage: lệch giá khớp vs giá đặt của lệnh FILLED (engine LIMIT khớp tại
  // giá đặt → thường 0; khác 0 = dấu bất thường đáng nhìn [DA D5/D8])
  const slipSamples = ordersFilled
    .filter((o) => o.price != null && o.avgFillPrice != null && o.price > 0)
    .map((o) => Math.round(((o.avgFillPrice! - o.price!) / o.price!) * 10000) / 100);
  slipSamples.sort((a, b) => a - b);
  const slippage: ExecKpiSlippage | null =
    slipSamples.length > 0
      ? {
          n: slipSamples.length,
          minPct: slipSamples[0],
          p25Pct: Math.round(quantile(slipSamples, 0.25) * 100) / 100,
          medianPct: Math.round(quantile(slipSamples, 0.5) * 100) / 100,
          p75Pct: Math.round(quantile(slipSamples, 0.75) * 100) / 100,
          maxPct: slipSamples[slipSamples.length - 1],
          valuesPct: slipSamples.slice(-100),
        }
      : null;

  return {
    window: { days, from: from.toISOString(), to: to.toISOString() },
    funnel: {
      signals: actionable.length,
      approved,
      ordersCreated,
      ordersFilled: ordersFilled.length,
      approvedWithOrders,
      signalsFullyFilled,
      ordersOutOfFunnel,
      expired,
      holdCount: signals.length - actionable.length,
    },
    approvePct: pct(approved, actionable.length),
    fillPct: pct(ordersFilled.length, ordersCreated),
    churnPct: pct(expired, actionable.length),
    rejected,
    aovVnd,
    slippage,
    signalStatusCounts,
    note: "KPI mô tả, không phán xét (§6.5) — conversion thấp không đồng nghĩa xấu; trader có thể đúng khi từ chối.",
  };
}
