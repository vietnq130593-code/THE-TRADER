/**
 * src/lib/exec/twap.ts — E-P1-2 (EXECUTION_OPS_BLUEPRINT v1.1 §4, triển khai
 * v1.2): TWAP tách lát THẬT cho lệnh lớn.
 *
 * Quyết định tách (đúng nguyên văn spec): khi khối lượng lệnh (notional VND)
 * > 1% ADTV-20 phiên [tư duy A5 Liquidity] → tách thành `sliceCount` lát LIMIT
 * (mỗi lát bội lot 100 — F-202) rải đều `afterTick` trong hạn chờ plan.
 * Mỗi lát là MỘT Order con riêng (E-P1-2a: "sinh nhiều Order con khi APPROVE,
 * mỗi Order 1 plan con") — fill engine khớp từng Order con như lệnh riêng
 * (claim per-lát AUD-CODE #2 giữ nguyên), chỉ khi tới lượt lát (E-P1-2b).
 *
 * Toán tách lát là SỐ HỌC THUẦN (§2.7 P1 — không cần scipy): chia đều theo lot,
 * phần dư lot dồn cho các lát ĐẦU (lát đầu luôn ≥ lát sau — đi sớm volume lớn
 * hơn chút, đúng tinh thần TWAP chia đều thời gian). afterTick rải đều:
 * spacing = floor(deadlineTicks / sliceCount) — lát 1 chạy ngay (afterTick 0),
 * lát cuối kích hoạt trước hạn chờ chung (deadline − spacing ≥ 0) để còn cửa khớp.
 *
 * An toàn §6.1 giữ nguyên: hàm này CHỈ được gọi từ createPaperOrderFromSignal
 * (SAU APPROVE) — không nơi khác (exec-verify E2 kiểm).
 */

import { db } from "@/lib/db";
import {
  PLAN_SLICE_COUNT,
  DEFAULT_DEADLINE_TICKS,
  TWAP_ADTV_TRIGGER_PCT,
  TWAP_ADTV_SESSIONS,
} from "@/lib/exec/constants";

/** Kết quả đo ADTV-20 phiên của 1 mã (VND/phiên). */
export interface Adtv20 {
  adtvVnd: number;
  sessions: number;
}

/** ADTV-20 phiên EOD của mã — mean(Bar.value) 20 bar cuối (trước ngày query).
 *  F-73A-07 (fixbug #73): trả 0 khi CHƯA ĐỦ 20 bar (mã mới/query thiếu) —
 *  ADTV-k (k<20) là nhiễu cho ngưỡng 1%, caller đi SINGLE an toàn. */
export async function adtv20For(instrumentId: string, now = new Date()): Promise<Adtv20> {
  const cutoff = new Date(now.getTime() - (TWAP_ADTV_SESSIONS * 2 + 20) * 86_400_000);
  const bars = await db.bar.findMany({
    where: { instrumentId, date: { gte: cutoff, lt: now } },
    orderBy: { date: "desc" },
    take: TWAP_ADTV_SESSIONS,
    select: { value: true },
  });
  const values = bars
    .map((b) => (b.value != null ? Number(b.value) : NaN))
    .filter((v) => Number.isFinite(v) && v > 0);
  if (values.length === 0) return { adtvVnd: 0, sessions: 0 };
  // F-73A-07: ADTV-k (k<20) là nhiễu cho ngưỡng 1% — trả 0, caller đi SINGLE an toàn.
  if (values.length < TWAP_ADTV_SESSIONS) return { adtvVnd: 0, sessions: values.length };
  return {
    adtvVnd: values.reduce((s, v) => s + v, 0) / values.length,
    sessions: values.length,
  };
}

/** True khi lệnh đủ LỚN để phải tách TWAP: notional > 1% ADTV-20
 *  (TWAP_ADTV_TRIGGER_PCT). ADTV=0 (chưa đủ bar) → false — không tách mù. */
export function shouldTwap(notionalVnd: number, adtvVnd: number): boolean {
  if (adtvVnd <= 0 || notionalVnd <= 0) return false;
  return notionalVnd > (TWAP_ADTV_TRIGGER_PCT / 100) * adtvVnd;
}

/** Một lát của kế hoạch TWAP (trước khi biết orderId — buildTwapChildPlan
 *  cần orderId nên lat này chỉ mang khối lượng + lịch). */
export interface TwapSliceDraft {
  seq: number;
  quantity: number;
  afterTick: number;
}

/** Chia khối lượng thành `sliceCount` lát bội lot 100 (phần dư dồn lát đầu).
 *  Hợp đồng (F-73A-06 fixbug #73): `quantity` PHẢI là bội 100 — vi phạm (có phần
 *  dư lot) nghĩa là caller sai upstream, trả null thay vì nuốt dư im lặng.
 *  Trả null khi KHÔNG nên tách: quantity ≤ 0 / không bội 100 / sliceCount < 2 /
 *  quantity < sliceCount×100 (không đủ 1 lot/lát). */
export function draftTwapSlices(quantity: number, sliceCount: number): TwapSliceDraft[] | null {
  // F-73A-06: nuốt phần dư lot là bug — caller sai hợp đồng thì từ chối
  if (sliceCount < 2 || quantity <= 0 || quantity % 100 !== 0) return null;
  if (quantity < sliceCount * 100) return null;
  const lots = Math.floor(quantity / 100); // đã bảo đảm ≥ sliceCount
  const baseLots = Math.floor(lots / sliceCount);
  let remainderLots = lots - baseLots * sliceCount;
  if (baseLots < 1) return null;
  // Rải đều afterTick trong hạn chờ: spacing tick phiên giữa các lát.
  const spacing = Math.max(1, Math.floor(DEFAULT_DEADLINE_TICKS / sliceCount));
  const slices: TwapSliceDraft[] = [];
  let seq = 1;
  let remainingLots = lots;
  for (let i = 0; i < sliceCount; i++) {
    // Lát đầu nhận phần dư (nhiều lot hơn một chút); lát sau đều nhau.
    let takeLots = baseLots + (remainderLots > 0 ? 1 : 0);
    if (remainderLots > 0) remainderLots--;
    // Lát cuối: nhận hết lot còn dôi (phòng làm tròn) để Σ = lots.
    if (i === sliceCount - 1) takeLots = remainingLots;
    remainingLots -= takeLots;
    if (takeLots <= 0) continue; // sliceCount > lots đã chặn ở trên — phòng hoá
    slices.push({
      seq,
      quantity: takeLots * 100,
      afterTick: (seq - 1) * spacing,
    });
    seq++;
  }
  return slices.length >= 2 ? slices : null;
}

/** Quyết định tách hoàn chỉnh cho 1 lệnh đã duyệt — dùng trong
 *  createPaperOrderFromSignal. Trả null → đi đường SINGLE cũ (P0 behavior). */
export function decideTwap(input: {
  quantity: number;
  price: number;
  adtvVnd: number;
  sliceCount?: number;
}): TwapSliceDraft[] | null {
  const notional = input.quantity * input.price;
  if (!shouldTwap(notional, input.adtvVnd)) return null;
  return draftTwapSlices(
    input.quantity,
    input.sliceCount ?? PLAN_SLICE_COUNT
  );
}

/** Notional lệnh gốc phần trăm ADTV-20 (làm tròn 2 số lẻ) — ghi vào plan
 *  meta để audit "vì sao tách" minh bạch. */
export function notionalPctAdtv(notionalVnd: number, adtvVnd: number): number {
  if (adtvVnd <= 0) return 0;
  return Number(((notionalVnd / adtvVnd) * 100).toFixed(2));
}
