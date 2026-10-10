/**
 * src/lib/exec/allocation.ts — E-P1-1 (EXECUTION_OPS_BLUEPRINT v1.1 §4,
 * triển khai v1.2): A1 khối "đề xuất phân bổ danh mục".
 *
 * Chủ tịch (portfolio-strategist) trình 2 lớp từ P1:
 *  (a) giữ nguyên tín hiệu JSON hiện tại (không đổi);
 *  (b) thêm khối `allocation` — bảng tỷ trọng {symbol, currentPct, targetPct,
 *      action} theo `targetPositions=8` + ngưỡng `rebalanceThresholdPct=5%`
 *      [MATH H1 Ridge L2 — phạt mềm: chỉ đề xuất hành động khi lệch vượt ngưỡng,
 *      không bán tái cấu trúc đột ngột].
 *
 * CHỈ THAM MƯU (§7.4 mặc định trader duyệt): narrative + bảng tỷ trọng trong
 * output Chủ tịch — KHÔNG push vào prompt các chu kỳ sau, KHÔNG tự sinh lệnh.
 *
 * Parse an toàn (E-P1-1 spec): bảng sai format → bỏ qua + ghi parse-fail
 * (drift metric cho E-P2-1 — AppSetting counter, không sập chu kỳ).
 *
 * G5 được đóng: config roster A1 `targetPositions`/`rebalanceThresholdPct`/
 * `style` lần đầu có consumer (đọc từ đây — 1 nguồn).
 */

import { db } from "@/lib/db";
import { ROSTER_BY_CODE } from "@/lib/agent-roster";

// ── Config A1 — nguồn đơn từ roster (E-P1-1: config "phân bổ danh mục"
//    hữu danh vô thực từ §0.1 giờ có consumer thật) ──

const a1Cfg = ROSTER_BY_CODE.get("portfolio-strategist")?.config as
  | { targetPositions?: unknown; rebalanceThresholdPct?: unknown; style?: unknown }
  | undefined;

function readPositiveInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : fallback;
}
function readThresholdPct(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 50 ? v : fallback;
}

/** Số vị thế mục tiêu của danh mục (config A1 targetPositions — mặc định 8). */
export const ALLOCATION_TARGET_POSITIONS = readPositiveInt(a1Cfg?.targetPositions, 8);
/** Ngưỡng lệch tỷ trọng mới đề xuất hành động (PERCENT — config A1, mặc định 5). */
export const ALLOCATION_REBALANCE_THRESHOLD_PCT = readThresholdPct(
  a1Cfg?.rebalanceThresholdPct,
  5
);
/** Phong cách cân bằng của Chủ tịch (config A1 style — mời vào prompt làm định hướng). */
export const ALLOCATION_STYLE =
  typeof a1Cfg?.style === "string" && a1Cfg.style.trim() ? a1Cfg.style.trim() : "balanced";

/** AppSetting key đếm parse-fail khối allocation (drift metric — E-P2-1 sau). */
export const ALLOCATION_PARSE_FAIL_KEY = "exec.chairman.allocationParseFail";

// ── Hợp đồng dữ liệu ──

/** Một dòng đề xuất phân bổ của Chủ tịch. */
export interface AllocationRow {
  symbol: string;
  /** Tỷ trọng hiện tại % NAV (LLM điền từ block DANH MỤC của prompt). */
  currentPct: number;
  /** Tỷ trọng mục tiêu % NAV. */
  targetPct: number;
  /** MUA | BÁN | GIỮ (chuẩn hoá từ output LLM). */
  action: "MUA" | "BÁN" | "GIỮ";
}

/** Khối allocation parsed an toàn — null khi LLM không trả hoặc sai format. */
export interface AllocationProposal {
  narrative: string;
  rows: AllocationRow[];
}

function isFinitePct(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;
}

/**
 * Parse khối `allocation` từ JSON output của Chủ tịch — AN TOÀN:
 *  - Sai format / thiếu trường → null (không throw, không sập chu kỳ);
 *  - Symbol chuẩn hoá uppercase, bỏ dòng rác;
 *  - action chỉ nhận MUA/BÁN/GIỮ (xấp xỉ: BUY/SELL/HOLD/KEEP cũng chuẩn hoá);
 *  - Giới hạn ALLOCATION_TARGET_POSITIONS dòng (8) — LLM nói nhiều thì cắt;
 *  - Caller tự ghi parse-fail counter khi muốn đo drift.
 */
export function parseAllocationProposal(raw: unknown): AllocationProposal | null {
  if (raw == null || typeof raw !== "object") return null;
  const obj = raw as {
    narrative?: unknown;
    rows?: unknown;
    table?: unknown;
  };
  const rowsRaw = Array.isArray(obj.rows) ? obj.rows : Array.isArray(obj.table) ? obj.table : null;
  if (!rowsRaw) return null;

  const rows: AllocationRow[] = [];
  for (const r of rowsRaw) {
    if (r == null || typeof r !== "object") continue;
    const row = r as { symbol?: unknown; currentPct?: unknown; targetPct?: unknown; action?: unknown };
    if (typeof row.symbol !== "string") continue;
    const symbol = row.symbol.trim().toUpperCase();
    if (!/^[A-Z0-9]{2,10}$/.test(symbol)) continue;
    if (!isFinitePct(row.currentPct) || !isFinitePct(row.targetPct)) continue;
    const actionRaw =
      typeof row.action === "string" ? row.action.trim().toUpperCase() : "";
    const action: AllocationRow["action"] =
      actionRaw === "MUA" || actionRaw === "BUY"
        ? "MUA"
        : actionRaw === "BÁN" || actionRaw === "SELL"
          ? "BÁN"
          : "GIỮ";
    rows.push({
      symbol,
      currentPct: Number(row.currentPct),
      targetPct: Number(row.targetPct),
      action,
    });
    if (rows.length >= ALLOCATION_TARGET_POSITIONS) break;
  }
  if (rows.length === 0) return null;

  const narrative =
    typeof obj.narrative === "string" && obj.narrative.trim()
      ? obj.narrative.trim().slice(0, 500)
      : "";
  return { narrative, rows };
}

/** Đếm parse-fail (drift metric E-P2-1) — AppSetting counter, fail-soft. */
export async function bumpAllocationParseFail(): Promise<void> {
  try {
    // F-73A-11: đọc Number trực tiếp — value hỏng (không parse được) → NaN →
    // reset 1 thay vì JSON.parse throw làm counter đóng băng im lặng. Ghi chuỗi
    // số thô (Number() lẫn JSON.parse() đọc lại được cả hai định dạng cũ/mới).
    const row = await db.appSetting.findUnique({
      where: { key: ALLOCATION_PARSE_FAIL_KEY },
    });
    const cur = row ? Number(row.value) : 0;
    const next = Number.isFinite(cur) && cur > 0 ? Math.round(cur) + 1 : 1;
    await db.appSetting.upsert({
      where: { key: ALLOCATION_PARSE_FAIL_KEY },
      create: { key: ALLOCATION_PARSE_FAIL_KEY, value: String(next) },
      update: { value: String(next) },
    });
  } catch {
    // fail-soft: drift counter không được làm sập chu kỳ Chairman
  }
}

/** Đọc counter parse-fail (hiển thị/kiểm định) — 0 khi chưa có. */
export async function readAllocationParseFail(): Promise<number> {
  try {
    // F-73A-11: Number trực tiếp — value hỏng → NaN → || 0 (không throw).
    const row = await db.appSetting.findUnique({
      where: { key: ALLOCATION_PARSE_FAIL_KEY },
    });
    return row ? Number(row.value) || 0 : 0;
  } catch {
    return 0;
  }
}

/** Format khối phân bổ thành text đính kèm message Chủ tịch (narrative + bảng). */
export function formatAllocationForMessage(a: AllocationProposal): string {
  const fmtPct = (n: number) => `${n.toFixed(1).replace(".", ",")}%`;
  const table = a.rows
    .map((r) => `${r.symbol}: ${fmtPct(r.currentPct)} → ${fmtPct(r.targetPct)} (${r.action})`)
    .join(" · ");
  const head =
    "ĐỀ XUẤT PHÂN BỔ DANH MỤC (tham mưu theo mục tiêu " +
    `${ALLOCATION_TARGET_POSITIONS} vị thế · ngưỡng tái cân bằng ${ALLOCATION_REBALANCE_THRESHOLD_PCT}% ` +
    "— phạt mềm L2, không tự sinh lệnh):";
  return [head, a.narrative, table].filter(Boolean).join("\n");
}
