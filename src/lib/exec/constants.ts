/**
 * src/lib/exec/constants.ts — MỘT NGUỒN DUY NHẤT cho biểu phí/thuế & tham số
 * thực thi của nhóm Điều hành & Thực thi (EXECUTION_OPS_BLUEPRINT v1.1 E-P0-1).
 *
 * ⚠️ BỐI CẢNH RA ĐỜI (REV-2 review #69 — điều kiện bắt buộc #2 của trader):
 * Trước E-P0-1, biểu phí sống ở **3 nơi với 2 đơn vị khác nhau**:
 *   1. `market/tick/route.ts:60-61`  — FEE_RATE=0.0015 / TAX_RATE=0.001 (fraction)
 *   2. `signal-execution.ts:391`     — literal `0.0015` (fraction)
 *   3. `agent-roster.ts:227` (A11)   — config `{feePct: 0.15, taxSellPct: 0.1}` (PERCENT)
 * Đổi biểu phí phải sửa 3 chỗ; ai chuyển nhầm percent↔fraction sẽ lệch 100×
 * và KHÔNG có gì báo lỗi — lớp bug "1 sự thật N nguồn" (cùng họ G2/G3
 * DATA_PLATFORM_BLUEPRINT §0.4).
 *
 * Sau E-P0-1: cả 3 nơi cùng import hằng số từ module này. Module đọc roster
 * config A11 (percent) → chuyển fraction đúng MỘT chỗ, kèm GUARD BIÊN:
 * sai đơn vị (lệch 100×) nổ NGAY lúc import chứ không chạy im lặng.
 *
 * Quy ước đơn vị (nhất quán toàn module "exec"):
 *   - `*Rate`  = FRACTION 0..1 (0.0015 = 0,15%) — nhân thẳng vào notional
 *   - `*Pct`   = PERCENT 0..100 (0.15 = 0,15%)  — chỉ dùng hiển thị/config
 */

import { ROSTER_BY_CODE } from "@/lib/agent-roster";

/** Biên an toàn của rate fraction (0, 0.01] — phí/thuế môi giới VN thực tế
 *  0,05%–0,5%: sai đơn vị percent↔fraction sẽ rơi ra ngoài biên này. */
const RATE_FRACTION_MAX = 0.01;

export const FEE_RATE_FALLBACK_PCT = 0.15; // % — dùng khi roster config thiếu/không phải số
export const TAX_SELL_RATE_FALLBACK_PCT = 0.1; // % — thuế TNCN bán (chỉ lệnh BÁN)

/** Chuyển percent → fraction kèm guard biên — điểm chuyển đổi ĐƠN NHẤT.
 *  Ném Error rõ ràng khi giá trị nằm ngoài biên an toàn (phát hiện sai đơn vị
 *  lệch 100× ngay lúc import thay vì sai phí âm thầm từng fill). */
export function pctToFractionGuarded(pct: number, name: string): number {
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
    throw new Error(
      `[exec/constants] ${name}=${pct} không hợp lệ (percent 0..100) — kiểm tra config roster A11`
    );
  }
  const fraction = pct / 100;
  if (fraction > RATE_FRACTION_MAX) {
    throw new Error(
      `[exec/constants] ${name}: fraction ${fraction} vượt biên an toàn ≤ ${RATE_FRACTION_MAX} — nghi ngờ sai đơn vị percent↔fraction (lệch 100×): giá trị config = ${pct}`
    );
  }
  return fraction;
}

interface FeeTaxConfigRaw {
  feePct?: unknown;
  taxSellPct?: unknown;
}

function readRatePct(
  cfg: FeeTaxConfigRaw | undefined,
  key: "feePct" | "taxSellPct",
  fallbackPct: number
): number {
  const v = cfg?.[key];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallbackPct;
}

/** Đọc + guard cấu hình phí/thuế từ roster A11 (percent domain). */
export function getExecFeeTaxConfig(): {
  feeRate: number;
  taxSellRate: number;
  feePct: number;
  taxSellPct: number;
  source: "roster" | "fallback";
} {
  const cfg = ROSTER_BY_CODE.get("settlement")?.config as FeeTaxConfigRaw | undefined;
  const feePct = readRatePct(cfg, "feePct", FEE_RATE_FALLBACK_PCT);
  const taxSellPct = readRatePct(cfg, "taxSellPct", TAX_SELL_RATE_FALLBACK_PCT);
  const fromRoster =
    cfg != null && (typeof cfg.feePct === "number" || typeof cfg.taxSellPct === "number");
  return {
    feeRate: pctToFractionGuarded(feePct, "feePct"),
    taxSellRate: pctToFractionGuarded(taxSellPct, "taxSellPct"),
    feePct,
    taxSellPct,
    source: fromRoster ? "roster" : "fallback",
  };
}

// ── Hằng số dùng trực tiếp (tính 1 lần lúc import — roster là dữ liệu tĩnh) ──

const feeTax = getExecFeeTaxConfig();

/** Phí môi giới 0,15% × notional (fraction 0.0015) — F-201. */
export const FEE_RATE = feeTax.feeRate;
/** Thuế TNCN 0,1% chỉ lệnh BÁN (fraction 0.001) — tick route + reconciliation. */
export const TAX_RATE = feeTax.taxSellRate;

// ── Tham số thực thi A10 (E-P0-2 — config roster có consumer từ P0) ──

const execCfg = ROSTER_BY_CODE.get("execution-manager")?.config as
  | { sliceCount?: unknown; maxSlippagePct?: unknown; orderType?: unknown }
  | undefined;

function readPositiveInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : fallback;
}
function readSlippagePct(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 5 ? v : fallback;
}

/** Số lát cắt mặc định khi tách lệnh (TWAP — P1; P0 luôn 1 lát SINGLE). */
export const PLAN_SLICE_COUNT = readPositiveInt(execCfg?.sliceCount, 3);
/** Ngân sách trượt giá tối đa (PERCENT — 0.5% theo config A10 maxSlippagePct). */
export const PLAN_SLIPPAGE_BUDGET_PCT = readSlippagePct(execCfg?.maxSlippagePct, 0.5);
/** Loại lệnh plan khai báo — P0 cố định LIMIT (đúng hành vi engine hiện tại:
 *  chỉ khớp lệnh LIMIT theo điều kiện giá). F-701-04 (fixbug #71): trước đây
 *  là ternary đọc config A10 `orderType` nhưng cả 2 nhánh đều "LIMIT" (đồng vị,
 *  đọc mà không tiêu thụ) — config này sẽ được tiêu thụ THẬT khi E-P1-2 thêm
 *  TWAP/MARKET; tới lúc đó mới mở khoá theo config. */
export const PLAN_ORDER_TYPE = "LIMIT";

/**
 * Hạn chờ khớp mặc định của ExecutionPlan — 1440 tick.
 * REV-7 (v1.1): `deadlineTicks` chỉ đếm tick TRONG phiên liên tục
 * (09:15–11:30 + 13:00–14:45 ≈ 4h = 1440 tick @10s ≈ đúng 1 phiên giao dịch).
 */
export const DEFAULT_DEADLINE_TICKS = 1440;

// ── E-P1-2 (EXECUTION_OPS_BLUEPRINT v1.1 §4 — TWAP tách lát thật) ──────────
// Ngưỡng kích hoạt TWAP theo [tư duy A5 Liquidity — MATH H7 ε-tolerance]:
// khối lượng lệnh (notional) > 1% ADTV-20 phiên → tách sliceCount lát LIMIT
// rải đều afterTick trong hạn chờ plan (mỗi lát bội lot 100 — F-202).

/** Ngưỡng phần trăm ADTV-20 để kích hoạt TWAP (PERCENT — 1%). */
export const TWAP_ADTV_TRIGGER_PCT = 1;
/** Số phiên EOD tính ADTV cho ngưỡng TWAP. */
export const TWAP_ADTV_SESSIONS = 20;

// ── Sizing A12/tín hiệu (E-P0-4 — cùng nguồn cho fill + committed view) ──

/** Sizing 5% NAV cho lệnh từ phê duyệt tín hiệu (nav5pct — run route cũ). */
export const POSITION_SIZE_PCT = 0.05;
