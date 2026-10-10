/**
 * src/lib/exec/plan.ts — ExecutionPlan hợp đồng E-P0-2
 * (EXECUTION_OPS_BLUEPRINT v1.1 §3.2/§4): kế hoạch thực thi đi kèm lệnh
 * NGAY KHI trader APPROVE/convert — P0 style=SINGLE (1 lát đúng hiện trạng),
 * slippageBudgetPct từ config A10, deadlineTicks theo REV-7.
 *
 * Nguyên tắc bất khả xâm phạm §6.1: plan chỉ sinh SAU APPROVE — builder duy nhất
 * được gọi từ createPaperOrderFromSignal (đường lệnh đã duyệt); chu kỳ KHÔNG
 * tự sinh plan. Lưu tại `Order.note` dạng JSON (chọn mặc định §7.1 — E-P1-2
 * v1.2 GIỮ note JSON: mỗi Order con tự chứa sub-plan riêng, không cần bảng riêng).
 *
 * E-P1-2 (v1.2): thêm style=TWAP — khi khối lượng lệnh gốc > 1% ADTV-20 phiên,
 * APPROVE sinh NHIỀU Order con (mỗi Order con 1 plan con, lát seq kích hoạt
 * sau afterTick tick phiên). Fill engine chỉ khớp Order con tới lượt lát
 * (guard afterTick) — chu kỳ vẫn KHÔNG tự đặt lệnh.
 *
 * Hạn chờ (REV-7): deadlineTicks chỉ đếm tick TRONG phiên liên tục HOSE
 * 09:15–11:30 + 13:00–14:45 (bỏ nghỉ trưa, T7/CN, ngày lễ theo vn-calendar) —
 * 1440 tick @10s ≈ đúng 1 phiên giao dịch. Ngoài MARKET_STRICT_SESSION, tick
 * chạy 24/7 (simulator) — khi đó "tick phiên tương đương" vẫn tính theo cửa
 * sổ phiên thật: lệnh đợi lâu hơn bằng wall-clock nhưng hạn语义 không đổi.
 */

import {
  PLAN_SLICE_COUNT,
  PLAN_SLIPPAGE_BUDGET_PCT,
  PLAN_ORDER_TYPE,
  DEFAULT_DEADLINE_TICKS,
  TWAP_ADTV_TRIGGER_PCT,
} from "@/lib/exec/constants";
import { isTradingDay } from "@/lib/market-session";

// PLAN_SLICE_COUNT được tiêu thụ bởi src/lib/exec/twap.ts (E-P1-2) — re-export
// để mọi consumer plan đều thấy tham số tách lát từ MỘT nguồn (E-P0-1 tinh thần).
export { PLAN_SLICE_COUNT };

/** Một lát cắt của plan (P0: đúng 1 lát; P1 TWAP: nhiều lát afterTick). */
export interface PlanSlice {
  seq: number;
  quantity: number;
  price: number;
  afterTick: number;
}

/** Thông tin TWAP của plan con (E-P1-2) — chỉ có khi style=TWAP. */
export interface PlanTwapMeta {
  /** Tổng số lát của kế hoạch cha (bao gồm mọi Order con). */
  totalSlices: number;
  /** Tín hiệu gốc sinh ra kế hoạch (audit truy nguồn). */
  signalId: string;
  /** Notional lệnh GỐC phần trăm ADTV-20 lúc quyết định tách (minh bạch lý do). */
  notionalPctAdtv: number;
  /** ADTV-20 phiên (VND) lúc quyết định tách. */
  adtvVnd: number;
}

/** Hợp đồng ExecutionPlan §3.2 — serialize vào Order.note.
 *  SINGLE: 1 plan = 1 Order nguyên khối (P0 — đúng hiện trạng engine).
 *  TWAP:   1 phê duyệt = nhiều Order con, mỗi Order con 1 plan con có
 *          slices[0].afterTick = lượt kích hoạt lát (E-P1-2). */
export interface ExecutionPlan {
  v: 1;
  kind: "ExecutionPlan";
  orderId: string;
  style: "SINGLE" | "TWAP";
  slices: PlanSlice[];
  slippageBudgetPct: number;
  deadlineTicks: number;
  orderType: string;
  sizing: "nav5pct" | "budget50m";
  humanNote: string;
  rationale: string;
  createdAt: string;
  /** Siêu dữ liệu TWAP (E-P1-2) — chỉ có khi style=TWAP. */
  twap?: PlanTwapMeta;
}

/** Lý do đi SINGLE thay vì tách TWAP (F-73A-13 fixbug #73) — rationale plan
 *  phải nói đúng lý do THẬT của con đường an toàn, không gộp chung một câu:
 *  - under-threshold:    notional ≤ ngưỡng TWAP_ADTV_TRIGGER_PCT% ADTV-20;
 *  - adtv-unavailable:   không đo được ADTV-20 (lỗi query hoặc chưa đủ 20 bar —
 *                        F-73A-07) → fail-soft §6.6 đi đường an toàn;
 *  - insufficient-lots:  khối lượng không đủ ≥ sliceCount lot cho mỗi lát. */
export type SinglePlanReason = "under-threshold" | "adtv-unavailable" | "insufficient-lots";

/** Sinh plan JSON cho lệnh (P0 luôn 1 lát SINGLE — đúng hành vi engine hiện tại).
 *  F-73A-13: `singleReason` nói đúng lý do không tách (mặc định under-threshold). */
export function buildExecutionPlan(input: {
  orderId: string;
  quantity: number;
  price: number;
  sizing: "nav5pct" | "budget50m";
  humanNote: string;
  createdAt?: Date;
  singleReason?: SinglePlanReason;
}): ExecutionPlan {
  // F-73A-13: rationale theo lý do thật — hằng ngưỡng interpolate từ nguồn đơn.
  const deadlineTail = `hạn chờ ${DEFAULT_DEADLINE_TICKS} tick trong phiên (~1 phiên giao dịch)`;
  const reason = input.singleReason ?? "under-threshold";
  const rationale =
    reason === "adtv-unavailable"
      ? "1 lệnh LIMIT nguyên khối — không đo được ADTV-20 (lỗi query hoặc chưa đủ 20 bar) " +
        "nên không tách lát (fail-soft §6.6 — đi đường an toàn); " +
        deadlineTail
      : reason === "insufficient-lots"
        ? "1 lệnh LIMIT nguyên khối — khối lượng không đủ ≥ sliceCount lot cho mỗi lát " +
          "nên không tách (E-P1-2); " +
          deadlineTail
        : "1 lệnh LIMIT nguyên khối — notional ≤ ngưỡng " +
          `${TWAP_ADTV_TRIGGER_PCT}% ADTV-20 nên không tách lát (E-P1-2); ` +
          deadlineTail;
  return {
    v: 1,
    kind: "ExecutionPlan",
    orderId: input.orderId,
    style: "SINGLE",
    slices: [{ seq: 1, quantity: input.quantity, price: input.price, afterTick: 0 }],
    slippageBudgetPct: PLAN_SLIPPAGE_BUDGET_PCT,
    deadlineTicks: DEFAULT_DEADLINE_TICKS,
    orderType: PLAN_ORDER_TYPE,
    sizing: input.sizing,
    humanNote: input.humanNote,
    rationale,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
  };
}

/** Sinh plan CON style=TWAP cho 1 Order con của kế hoạch tách lát (E-P1-2). */
export function buildTwapChildPlan(input: {
  orderId: string;
  seq: number;
  quantity: number;
  price: number;
  afterTick: number;
  sizing: "nav5pct" | "budget50m";
  humanNote: string;
  twap: PlanTwapMeta;
  createdAt?: Date;
}): ExecutionPlan {
  return {
    v: 1,
    kind: "ExecutionPlan",
    orderId: input.orderId,
    style: "TWAP",
    slices: [
      {
        seq: input.seq,
        quantity: input.quantity,
        price: input.price,
        afterTick: input.afterTick,
      },
    ],
    slippageBudgetPct: PLAN_SLIPPAGE_BUDGET_PCT,
    deadlineTicks: DEFAULT_DEADLINE_TICKS,
    orderType: PLAN_ORDER_TYPE,
    sizing: input.sizing,
    humanNote: input.humanNote,
    rationale:
      `TWAP lát ${input.seq}/${input.twap.totalSlices} — lệnh gốc ` +
      `${input.twap.notionalPctAdtv.toFixed(2).replace(".", ",")}% ADTV-20 ` +
      `(${Math.round(input.twap.adtvVnd).toLocaleString("vi-VN")} ₫/phiên) vượt ngưỡng 1% → tách đều; ` +
      `lát kích hoạt sau ${input.afterTick} tick phiên; hạn chờ chung ${DEFAULT_DEADLINE_TICKS} tick phiên`,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    twap: input.twap,
  };
}

/** Đóng gói plan thành chuỗi Order.note (JSON compact). */
export function planToNote(plan: ExecutionPlan): string {
  return JSON.stringify(plan);
}

/** Parse plan từ Order.note — null khi note không phải plan (chuỗi cũ/thường). */
export function parseExecutionPlan(note: string | null | undefined): ExecutionPlan | null {
  if (!note) return null;
  const trimmed = note.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const raw = JSON.parse(trimmed) as Partial<ExecutionPlan>;
    if (
      raw.kind !== "ExecutionPlan" ||
      raw.v !== 1 ||
      typeof raw.deadlineTicks !== "number" ||
      raw.deadlineTicks <= 0 ||
      !Array.isArray(raw.slices) ||
      raw.slices.length === 0
    ) {
      return null;
    }
    return raw as ExecutionPlan;
  } catch {
    return null;
  }
}

// ── Đếm tick trong phiên (REV-7) ────────────────────────────────────────────

/** Giây từ nửa đêm VN — các cửa sổ phiên liên tục HOSE (giờ VN). */
const MORNING = { openSec: 9 * 3600 + 15 * 60, closeSec: 11 * 3600 + 30 * 60 };
const AFTERNOON = { openSec: 13 * 3600, closeSec: 14 * 3600 + 45 * 60 };

/** Tick interval mặc định của engine (ms) — đọc env TICK_MS như tick route. */
function tickMs(): number {
  const ms = Number(process.env.TICK_MS ?? 10_000);
  return Number.isFinite(ms) && ms >= 1_000 ? ms : 10_000;
}

/** Mili-giây giao [from, now] rơi TRONG phiên liên tục của các ngày giao dịch —
 *  duyệt từng ngày (tối đa ~n ngày + 1), bỏ nghỉ trưa/T7/CN/lễ (isTradingDay). */
export function inSessionElapsedMs(from: Date, now: Date): number {
  if (now <= from) return 0;
  let total = 0;
  const cursor = new Date(from);
  // Đẩy cursor tới đầu ngày (VN = UTC+7) để duyệt nguyên ngày.
  const vnOffsetMs = 7 * 3_600_000;
  const dayStartOf = (d: Date) => {
    const vn = new Date(d.getTime() + vnOffsetMs);
    vn.setUTCHours(0, 0, 0, 0);
    return new Date(vn.getTime() - vnOffsetMs);
  };
  let day = dayStartOf(cursor);
  const lastDay = dayStartOf(now);
  while (day <= lastDay) {
    if (isTradingDay(day)) {
      for (const w of [MORNING, AFTERNOON]) {
        const ws = new Date(day.getTime() + w.openSec * 1000);
        const we = new Date(day.getTime() + w.closeSec * 1000);
        const lo = Math.max(ws.getTime(), from.getTime());
        const hi = Math.min(we.getTime(), now.getTime());
        if (hi > lo) total += hi - lo;
      }
    }
    day = new Date(day.getTime() + 86_400_000);
  }
  return total;
}

/** Số tick PHIÊN tương đương đã trôi qua từ thời điểm tạo lệnh (REV-7). */
export function inSessionElapsedTicks(from: Date, now: Date): number {
  return Math.floor(inSessionElapsedMs(from, now) / tickMs());
}

/** True khi lệnh đã vượt hạn chờ của plan (đếm tick phiên). */
export function planDeadlineExceeded(plan: ExecutionPlan, createdAt: Date, now: Date): boolean {
  return inSessionElapsedTicks(createdAt, now) >= plan.deadlineTicks;
}

/** E-P1-2: True khi LÁT của plan đủ điều kiện kích hoạt — số tick phiên đã trôi
 *  kể từ lúc tạo lệnh ≥ afterTick của lát đầu (lát 1 afterTick=0 → luôn eligible,
 *  đúng hành vi SINGLE cũ; lát TWAP sau chờ tới lượt rải đều). */
export function planSliceEligible(plan: ExecutionPlan, createdAt: Date, now: Date): boolean {
  const afterTick = plan.slices[0]?.afterTick ?? 0;
  if (afterTick <= 0) return true;
  return inSessionElapsedTicks(createdAt, now) >= afterTick;
}

/** Mô tả ngắn plan cho UI/audit (không cần parse lại nơi khác). */
export function describeExecutionPlan(plan: ExecutionPlan): string {
  const slice = plan.slices[0];
  if (plan.style === "TWAP") {
    const t = plan.twap;
    return (
      `Plan TWAP lát ${slice?.seq ?? "?"}/${t?.totalSlices ?? "?"}: ${slice?.quantity ?? "?"} cp @${slice?.price ?? "?"} ` +
      `sau ${slice?.afterTick ?? "?"} tick phiên · trượt ≤${plan.slippageBudgetPct}% · hạn ${plan.deadlineTicks} tick phiên` +
      (t ? ` · lệnh gốc ${t.notionalPctAdtv.toFixed(2).replace(".", ",")}% ADTV-20` : "")
    );
  }
  return `Plan SINGLE: ${plan.slices.length} lát × ${slice?.quantity ?? "?"} cp @${slice?.price ?? "?"} · trượt ≤${plan.slippageBudgetPct}% · hạn ${plan.deadlineTicks} tick phiên`;
}
