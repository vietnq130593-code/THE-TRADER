/**
 * src/lib/corporate-events.ts — P1-1 (DATA_PLATFORM_BLUEPRINT v1.3 §5):
 * SỰ KIỆN DOANH NGHIỆP + TỰ ĐIỀU CHỈNH split (chốt 8-3b — user chọn TỰ ĐIỀU
 * CHỈNH NGAY kèm AuditLog, khác đề xuất "chỉ cảnh báo" của phiên #54).
 *
 * PHẠM VI TỰ ĐIỀU CHỈNH: CHỈ thị trường VN có dải giá giới hạn (HOSE ±7% ·
 * HNX ±10% · UPCOM ±15% — ETF HOSE ±10%; INDEX/FUND không band → bỏ qua).
 * US/HK KHÔNG BAO GIỜ gap-infer (crash −50%/ngày có thật ở Mỹ) — sự kiện ở
 * đó đến từ parse payload `events` của Yahoo (xem intl-eod.ts — nguồn XÁC
 * ĐỊNH CHÍNH XÁC, không heuristic).
 *
 * ĐIỀU KIỆN TIÊN QUYẾT VN (đòn bẩy an toàn quan trọng nhất — review #56):
 *   gap open[t]/close[t−1] VƯỢT DẢI GIỚI HẠN của sàn (chuyển động thật
 *   không thể > 7/10/15%/ngày → gap lớn hơn chắc chắn artefact điều chỉnh).
 *
 * HEURISTIC MỨC CAO (đủ mới tự sửa — §8-3b):
 *   (1) gap vượt dải (cùng công thức beyondBand trừ biên tick của A9 —
 *       ngày trần THẬT 7,03% do tick không bị tính là event);
 *   (2) volume corroborate: giá trị phiên event ≥ 3× ADTV-45 (bar trước
 *       event — cùng hợp đồng value của topByAdtv);
 *   (3) tỷ số khớp ±1% ở CẢ 2 PHÉP: f_open = open[t]/close[t−1] và
 *       f_close = close[t]/close[t−1] (sự kiện thật dịch CẢ thanh,
 *       bad-tick thường chỉ lệch 1 giá).
 *   (1)+(2)+(3) → AUTO_ADJUSTED; (1)+(2) mà (3) fail → SUSPECTED (ghi
 *   nhận, KHÔNG sửa giá — trung thực); thiếu (2) → không tạo row (A9
 *   outlier đã bắt — không spam bảng sự kiện).
 *
 * HƯỚNG ĐIỀU CHỈNH (sửa ambiguity #56): f = open[t]/close[t−1] — NHÂN
 * CHUỖI TRƯỚC event bằng f (đưa giá cũ về thang mới; f<1 cho cổ thưởng
 * 1,2/1,3/1,5 phổ biến VN). Đồng bộ cả 3 trường:
 *   giá ×f (round bội 100₫) · volume ×(1/f) (round) · value tính lại
 *   = volume_mới × close_mới (chỉ chỉnh giá mà không chỉnh volume thì
 *   ADTV méo — review #56 lỗi thứ 3).
 *
 * LỚP AN TOÀN ĐẢO NGƯỢC:
 *   - AuditLog action CORPORATE_EVENT_AUTO_ADJUSTED chứa đủ pre-values từng
 *     bar (date · OHLCV · value) + ratio + range → đảo ngược bằng 1 script
 *     (scripts/reverse-corporate-event.ts, gọi reverseCorporateEvent()).
 *   - Kill-switch AppSetting "corporate-event-autoadjust" {enabled: boolean}
 *     — tắt toàn cục: scan chỉ ghi SUSPECTED.
 *   - Kill-switch per-event: row CorporateEvent status REVERSED → KHÔNG
 *     bao giờ tự adjust lại (người đã nhìn và đảo ngược — quyết định người).
 *   - Upsert idempotent @@unique([instrumentId, date, kind]) chống trùng.
 *
 * HỘI TỤ (blueprint P1-1): eod-sync upsert đè lookback 10 ngày bằng giá
 * GỐC của nguồn → gap tái xuất → scan tái phát hiện. Chống DOUBLE-APPLY
 * bằng cột PIT lastSyncedAt (P1-2): chỉ nhân f lên các bar trước event có
 * lastSyncedAt > mốc adjustedAt của lần adjust trước (bar do nguồn gửi lại
 * GỐC); bar đã adjust (lastSyncedAt cũ) giữ nguyên. Deep backfill đè toàn
 * bộ → mọi bar trước event có lastSyncedAt mới → nhân f đúng 1 lần trên
 * chuỗi gốc. f mới phải khớp f cũ ±1% — lệch lớn → SUSPECTED (không sửa).
 *
 * Sau AUTO_ADJUSTED: quay lại chạy 6 phép A9 (runDataQualityChecks) —
 * outlier/gap phải sạch ở vùng vừa điều chỉnh (nghiệm thu P1-1).
 *
 * Thuần TypeScript — 0 dependency mới (kỷ luật §6).
 */

import { db } from "@/lib/db";
import { priceBand, beyondBand } from "@/lib/data-quality";
import { invalidateFeatureCache, TOPBYADTV_CACHE_PREFIX } from "@/lib/feature-cache";

/** AppSetting kill-switch key (8-3b — default BẬT). */
export const CE_SETTING_KEY = "corporate-event-autoadjust";

/** Cửa sổ quét theo ngày lịch — 1 quý, khớp OUTLIER_CALENDAR_DAYS của A9. */
const CE_SCAN_WINDOW_DAYS = 92;

/** ADTV-45 phiên — cùng hợp đồng topByAdtv (dated-series.ts). */
const ADTV_SESSIONS = 45;

/** Volume corroborate: giá trị phiên event ≥ 3× ADTV (blueprint P1-1). */
const CE_VOLUME_CORROBORATE = 3;

/** Tỷ số khớp ±1% ở cả 2 phép (mức CAO — §8-3b). */
const CE_RATIO_AGREEMENT_PCT = 1;

/** Bước giá VN = 100 ₫ (round giá sau ×f — như eod-sync roundTo). */
const VN_TICK = 100;

/* ═══════════════════════ Kiểu hợp đồng ═══════════════════════ */

export interface CeCandidate {
  symbol: string;
  instrumentId: string;
  /** Ngày giao dịch ĐẦU TIÊN theo thang MỚI (ex-date — bar t). */
  eventDate: string; // ISO yyyy-mm-dd
  /** f = open[t]/close[t−1] — hệ số nhân chuỗi TRƯỚC event. */
  f: number;
  /** f_close = close[t]/close[t−1] — phép thứ 2 đối chiếu ±1%. */
  fClose: number;
  /** |f_close/f − 1|×100 — độ khớp 2 phép. */
  agreementPct: number;
  /** Gap mở phiên so close hôm trước (%). */
  gapPct: number;
  /** Giá trị phiên event (VND). */
  eventValue: number;
  /** ADTV-45 trước event (VND). */
  adtv: number;
  /** Đủ (1)+(2)+(3) — sẽ AUTO_ADJUSTED; false = SUSPECTED. */
  highConfidence: boolean;
}

export interface CeAdjustment {
  symbol: string;
  eventDate: string;
  kind: "SPLIT" | "BONUS";
  f: number;
  /** Số bar trước event bị nhân f lần này (chống double-apply). */
  barsAdjusted: number;
  auditLogId: string | null;
}

export interface CorporateEventScanResult {
  ranAt: string;
  /** Kill-switch đang bật/tắt. */
  autoAdjustEnabled: boolean;
  /** Số mã VN quét được. */
  scanned: number;
  candidates: CeCandidate[];
  adjusted: CeAdjustment[];
  /** Mã quét LỖI (F-611A-06/#61 — DB lỗi từng mã không bị nuốt im lặng). */
  failures: { symbol: string; error: string }[];
  /** 6 phép A9 chạy lại sau adjust (nghiệm thu P1-1) — null khi không adjust. */
  verdictAfter: { level: string; outlierSymbols: number; splitSuspects: string[] } | null;
  durationMs: number;
}

/* ═══════════════════════ Kill-switch (AppSetting) ═══════════════════════ */

/** Đọc kill-switch — AppSetting "corporate-event-autoadjust" {enabled}. */
export async function isAutoAdjustEnabled(): Promise<boolean> {
  const row = await db.appSetting
    .findUnique({ where: { key: CE_SETTING_KEY } })
    .catch(() => null);
  // Không có row → mặc định BẬT (chốt 8-3b). Mọi trường hợp KHÔNG đọc được
  // (DB lỗi · JSON hỏng) → TẮT (fail-safe — tính năng SỬA GIÁ THẬT phải
  // fail-closed; F-611A-05/#61: trước đây JSON hỏng trả true ngược comment).
  if (!row) return true;
  try {
    const parsed = JSON.parse(row.value) as { enabled?: unknown };
    return parsed.enabled !== false; // {enabled: false} mới tắt
  } catch {
    return false; // JSON hỏng → TẮT (fail-safe — đúng như comment khai báo)
  }
}

/** Đặt kill-switch (route /api/market/corporate-events PUT). */
export async function setAutoAdjustEnabled(enabled: boolean): Promise<void> {
  await db.appSetting.upsert({
    where: { key: CE_SETTING_KEY },
    create: { key: CE_SETTING_KEY, value: JSON.stringify({ enabled }) },
    update: { value: JSON.stringify({ enabled }) },
  });
}

/* ═══════════════════════ Tiện ích ═══════════════════════ */

function roundToTick(v: number): number {
  return Math.round(v / VN_TICK) * VN_TICK;
}

/** Bar row tải từ DB cho scan (đủ trường adjust + PIT). */
interface ScanBar {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  value: bigint | null;
  firstSeenAt: Date;
  lastSyncedAt: Date;
}

/** Tính ADTV-45 (VND) từ value (fallback close×volume) — hợp đồng topByAdtv. */
function adtvOf(bars: ScanBar[], endIndexExclusive: number): number {
  const from = Math.max(0, endIndexExclusive - ADTV_SESSIONS);
  let sum = 0;
  let n = 0;
  for (let i = from; i < endIndexExclusive; i++) {
    const b = bars[i];
    const v = b.value != null ? Number(b.value) : b.close * b.volume;
    if (v > 0) {
      sum += v;
      n++;
    }
  }
  return n > 0 ? sum / n : 0;
}

/* ═══════════════════════ Quét + điều chỉnh ═══════════════════════ */

/**
 * Quét corporate event VN trong cửa sổ 92 ngày và TỰ ĐIỀU CHỈNH khi heuristic
 * mức CAO khớp. Idempotent: gap biến mất sau adjust → lần sau không detect lại;
 * eod-sync đè lookback → gap tái xuất → chỉ adjust bar lastSyncedAt mới.
 *
 * opts.instrumentIds — giới hạn phạm vi (pipeline gọi cho mã vừa sync).
 */
export async function scanCorporateEvents(opts?: {
  instrumentIds?: string[];
}): Promise<CorporateEventScanResult> {
  const startedAt = Date.now();
  const autoAdjustEnabled = await isAutoAdjustEnabled();

  const cutoff = new Date(Date.now() - CE_SCAN_WINDOW_DAYS * 86_400_000);
  // F-611A-06/#61: KHÔNG nuốt lỗi DB ở truy vấn chính (mẫu F-591-02) — lỗi
  // ném lên cho route/pipeline bắt và ghi nhận trung thực.
  const instruments = await db.instrument.findMany({
    where: {
      isActive: true,
      market: { in: ["HOSE", "HNX", "UPCOM"] },
      ...(opts?.instrumentIds ? { id: { in: opts.instrumentIds } } : {}),
    },
    select: { id: true, symbol: true, market: true, type: true },
    orderBy: { symbol: "asc" },
  });

  // Chỉ mã CÓ dải giá (STOCK/ETF — INDEX/FUND không band, không thể gap-infer)
  const eligible = instruments.filter((i) => priceBand(i.market, i.type) != null);

  const candidates: CeCandidate[] = [];
  const adjusted: CeAdjustment[] = [];
  const failures: { symbol: string; error: string }[] = [];

  for (const inst of eligible) {
    const band = priceBand(inst.market, inst.type)!;
    try {
      const bars = await db.bar.findMany({
        where: { instrumentId: inst.id, date: { gte: cutoff } },
        orderBy: { date: "asc" },
        select: {
          date: true, open: true, high: true, low: true, close: true,
          volume: true, value: true, firstSeenAt: true, lastSyncedAt: true,
        },
      });
      if (bars.length < 3) continue;

      for (let t = 1; t < bars.length; t++) {
        const prev = bars[t - 1];
        const cur = bars[t];
        if (!(prev.close > 0) || !(cur.open > 0) || !(cur.close > 0)) continue;
        // (1) ĐIỀU KIỆN TIÊN QUYẾT: gap open/prevClose VƯỢT dải (trừ biên tick)
        if (!beyondBand(cur.open, prev.close, band)) continue;

        const adtv = adtvOf(bars, t);
        const eventValue = cur.value != null ? Number(cur.value) : cur.close * cur.volume;
        // (2) volume corroborate ≥ 3× ADTV — thiếu thì KHÔNG phải event
        // (bad-tick để A9 outlier lo), không tạo row
        if (!(adtv > 0) || eventValue < CE_VOLUME_CORROBORATE * adtv) continue;

        const f = cur.open / prev.close;
        const fClose = cur.close / prev.close;
        const agreementPct = Math.abs(fClose / f - 1) * 100;
        // (3) tỷ số khớp ±1% cả 2 phép
        const highConfidence = agreementPct <= CE_RATIO_AGREEMENT_PCT;

        candidates.push({
          symbol: inst.symbol,
          instrumentId: inst.id,
          eventDate: cur.date.toISOString().slice(0, 10),
          f: Number(f.toFixed(6)),
          fClose: Number(fClose.toFixed(6)),
          agreementPct: Number(agreementPct.toFixed(3)),
          gapPct: Number(((f - 1) * 100).toFixed(2)),
          eventValue,
          adtv: Math.round(adtv),
          highConfidence,
        });

        // Row event hiện có theo (instrumentId, date) — BẤT KỂ kind
        // (F-611A-08/#61: f đổi phía 1 → kind SPLIT↔BONUS lật, tìm theo
        // unique (…,date,kind) cũ sẽ TRƯỢT row và mở hết lớp phòng thủ)
        const existing = await findEventRow(inst.id, cur.date);

        if (highConfidence && autoAdjustEnabled) {
          const res = await applyAutoAdjust(inst, bars, t, f, existing).catch((err) => {
            console.error(`[corporate-events] adjust ${inst.symbol} lỗi:`, err);
            failures.push({
              symbol: inst.symbol,
              error: err instanceof Error ? err.message : String(err),
            });
            return null;
          });
          if (res) adjusted.push(res);
        } else {
          // SUSPECTED — ghi nhận trung thực, KHÔNG sửa giá.
          // F-611A-01/02/#61: KHÔNG BAO GIỜ ghi đè row AUTO_ADJUSTED/REVERSED
          // (demotion phá mốc PIT → double-apply ×f²; xoá quyền quyết định
          // người đã REVERSED). Chỉ tạo row MỚI khi chưa có row nào cho ngày đó.
          if (!existing || existing.status === "SUSPECTED") {
            const kind: "SPLIT" | "BONUS" =
              existing?.kind === "SPLIT" || existing?.kind === "BONUS"
                ? existing.kind
                : f < 1
                  ? "BONUS"
                  : "SPLIT";
            await upsertEventRow(inst, cur.date, kind, f, "SUSPECTED", {
              gapPct: ((f - 1) * 100).toFixed(2),
              agreementPct: agreementPct.toFixed(3),
              eventValue,
              adtv: Math.round(adtv),
              reason: highConfidence
                ? "kill-switch đang TẮT — chỉ ghi nhận, không sửa giá"
                : "tỷ số 2 phép lệch > ±1% — không đủ tin cậy để tự sửa",
            }).catch((err) => {
              failures.push({
                symbol: inst.symbol,
                error: `ghi SUSPECTED: ${err instanceof Error ? err.message : String(err)}`,
              });
            });
          }
        }

        // F-611A-04/#61: chỉ DỪNG quét mã này khi VỪA adjust thật (gap biến mất
        // → scan sau tự sang event kế tiếp). SUSPECTED/REVERSED không sửa giá
        // → gap còn nguyên → TIẾP TỤC quét tìm event khác trong cửa sổ (trước
        // đây break vô điều kiện làm event thật phía sau không bao giờ được thấy).
        if (adjusted.some((a) => a.symbol === inst.symbol)) break;
      }
    } catch (err) {
      // F-611A-06/#61 — lỗi DB từng mã ghi vào failures (không nuốt im lặng)
      failures.push({
        symbol: inst.symbol,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /* Nghiệm thu P1-1: sau AUTO_ADJUSTED → chạy lại 6 phép A9 (outlier/gap
   * phải sạch ở vùng vừa điều chỉnh). Verdict đầy đủ (không chỉ vùng) —
   * đọc như chu kỳ A9 thường để so sánh cùng chuẩn. */
  let verdictAfter: CorporateEventScanResult["verdictAfter"] = null;
  if (adjusted.length > 0) {
    const { runDataQualityChecks } = await import("@/lib/data-quality");
    const v = await runDataQualityChecks().catch(() => null);
    if (v) {
      verdictAfter = {
        level: v.level,
        outlierSymbols: v.summary.outlierSymbols,
        splitSuspects: v.summary.splitSuspects,
      };
    }
  }

  return {
    ranAt: new Date().toISOString(),
    autoAdjustEnabled,
    scanned: eligible.length,
    candidates,
    adjusted,
    failures,
    verdictAfter,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * F-611A-08/#61 — tìm row event theo (instrumentId, date) BẤT KỂ kind, ưu
 * tiên AUTO_ADJUSTED → REVERSED → còn lại (anti kind-flip + đúng lớp phòng
 * thủ kể cả khi f đổi phía 1 làm SPLIT↔BONUS lật nhãn).
 */
async function findEventRow(
  instrumentId: string,
  date: Date
): Promise<{ id: string; kind: string; ratio: number; status: string; updatedAt: Date; detail: string | null } | null> {
  return (
    (await db.corporateEvent.findFirst({
      where: { instrumentId, date, status: "AUTO_ADJUSTED" },
    })) ??
    (await db.corporateEvent.findFirst({
      where: { instrumentId, date, status: "REVERSED" },
    })) ??
    (await db.corporateEvent.findFirst({
      where: { instrumentId, date },
    }))
  );
}

/**
 * ÁP AUTO-ADJUST cho event tại index t của chuỗi bars:
 * nhân f lên toàn bộ bar TRƯỚC event (date < event) — nhưng chỉ bar nào là
 * "GỐC NGUỒN" (lastSyncedAt > mốc adjustedAt của lần adjust trước) hoặc chưa từng
 * adjust (không có row trước đó) — chống double-apply khi eod-sync đè lại
 * lookback. Ghi AuditLog pre-values đủ đảo ngược + upsert CorporateEvent.
 *
 * F-611A-07/#61: TOÀN BỘ (bar updates + AuditLog + CorporateEvent upsert)
 * trong MỘT $transaction — crash giữa chừng không còn để lại chuỗi đã nhân f
 * mà không có row/audit (trước đây audit lỗi bị `.catch(() => null)` nuốt,
 * row ghi auditLogId: null → đảo ngược vĩnh viễn bất khả thi).
 */
async function applyAutoAdjust(
  inst: { id: string; symbol: string },
  bars: ScanBar[],
  eventIndex: number,
  f: number,
  existing?: { id: string; kind: string; ratio: number; status: string; updatedAt: Date; detail: string | null } | null
): Promise<CeAdjustment | null> {
  const eventBar = bars[eventIndex];
  // F-611A-08/#61 — giữ kind của row hiện có (nếu có): f đổi phía 1 không
  // được phép tạo row THỨ HAI cho cùng ngày (unique theo kind sẽ lọt).
  const kind: "SPLIT" | "BONUS" =
    existing?.kind === "SPLIT" || existing?.kind === "BONUS"
      ? existing.kind
      : f < 1
        ? "BONUS"
        : "SPLIT";

  const row = existing ?? (await findEventRow(inst.id, eventBar.date));

  if (row?.status === "REVERSED") {
    // Kill-switch PER-EVENT: người đã đảo ngược — KHÔNG tự adjust lại
    // (trả null — scan không đếm là adjustment, row giữ nguyên REVERSED;
    // F-611A-02/#61: nhánh SUSPECTED giờ cũng không bao giờ ghi đè REVERSED)
    return null;
  }

  // Nếu lần trước đã adjust với ratio khác > ±1% → nguồn đổi số liệu.
  // F-611A-01/#61: KHÔNG demote row AUTO_ADJUSTED → SUSPECTED (demotion xoá
  // mốc PIT → scan sau double-apply ×f²). Giữ nguyên row + ghi cờ drift vào
  // detail + RiskAlert WARNING cho người xem — không sửa giá lần này.
  if (row?.status === "AUTO_ADJUSTED" && row.ratio > 0) {
    if (Math.abs(f / row.ratio - 1) > CE_RATIO_AGREEMENT_PCT / 100) {
      await recordDrift(inst, eventBar.date, kind, f, row.ratio).catch((err) => {
        console.error(`[corporate-events] ghi drift ${inst.symbol} lỗi:`, err);
      });
      return null;
    }
  }

  // Mốc adjustedAt lần trước — nguồn BỀN VỮNG từ detail.adjustedAt (F-611A-01:
  // updatedAt bị bump bởi mọi update — không đáng tin làm mốc PIT; detail
  // adjustedAt ghi đúng thời điểm nhân f lần cuối).
  let prevAdjustedAt: Date | null = null;
  if (row?.status === "AUTO_ADJUSTED") {
    try {
      const d = row.detail ? (JSON.parse(row.detail) as { adjustedAt?: string }) : {};
      prevAdjustedAt = d.adjustedAt ? new Date(d.adjustedAt) : row.updatedAt;
    } catch {
      prevAdjustedAt = row.updatedAt;
    }
    if (Number.isNaN(prevAdjustedAt.getTime())) prevAdjustedAt = row.updatedAt;
  }

  // Vùng cần nhân f: bar TRƯỚC event, nguyên trạng GỐC NGUỒN
  // (lastSyncedAt > prevAdjustedAt) hoặc chưa từng có row adjust
  const targets: ScanBar[] = [];
  for (let i = 0; i < eventIndex; i++) {
    const b = bars[i];
    if (prevAdjustedAt == null || b.lastSyncedAt > prevAdjustedAt) {
      targets.push(b);
    }
  }

  // F-611A-07/#61 — MỘT transaction duy nhất: bar updates + AuditLog +
  // CorporateEvent upsert. Cửa sổ quét 92 ngày ≈ ≤ ~63 phiên VN → tối đa
  // ~62 bar trước event + 2 ghi khác — vừa sức một transaction (chunk 200
  // cũ tách thành 3 transaction rời + audit lỗi bị nuốt → crash giữa chừng
  // để lại chuỗi ×f không có row/audit = bất khả đảo ngược).
  const adjustedAt = new Date();
  const preValues = targets.map((b) => ({
    date: b.date.toISOString().slice(0, 10),
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
    value: b.value != null ? b.value.toString() : null,
  }));

  // Áp: giá ×f (round bội 100₫) · volume ×(1/f) · value tính lại
  const postValues = targets.map((b) => {
    const open = roundToTick(b.open * f);
    const high = roundToTick(b.high * f);
    const low = roundToTick(b.low * f);
    const close = roundToTick(b.close * f);
    const volume = Math.max(0, Math.round(b.volume / f));
    const value = BigInt(volume) * BigInt(close);
    return {
      date: b.date.toISOString().slice(0, 10),
      open,
      high,
      low,
      close,
      volume,
      value: value.toString(),
    };
  });

  const detail = {
    gapPct: ((f - 1) * 100).toFixed(2),
    barsAdjusted: targets.length,
    adjustedAt: adjustedAt.toISOString(),
    auditLogId: null as string | null, // điền sau khi transaction trả về audit id
    reverseBy: "scripts/reverse-corporate-event.ts",
    method: "gap-infer-dchart (VN — vượt dải + 3×ADTV + ±1% 2 phép)",
  };

  // AuditLog — đủ pre-values + ratio + range để đảo ngược bằng 1 script
  // (được build trong callback để dùng tx — F-611R-10 dùng INTERACTIVE
  // transaction vì array-form của Prisma 6.19 không nhận timeout).
  const auditJson = {
    action: "CORPORATE_EVENT_AUTO_ADJUSTED",
    entity: "Bar",
    entityId: inst.id,
    before: JSON.stringify({
      symbol: inst.symbol,
      eventDate: eventBar.date.toISOString().slice(0, 10),
      kind,
      ratio: f,
      range: {
        from: targets.length > 0 ? preValues[0].date : null,
        to: eventBar.date.toISOString().slice(0, 10),
        bars: targets.length,
      },
      bars: preValues,
    }),
    after: JSON.stringify({
      symbol: inst.symbol,
      eventDate: eventBar.date.toISOString().slice(0, 10),
      ratio: f,
      bars: postValues,
      note: "giá ×f · volume ×(1/f) · value = volume×close tính lại — đảo ngược bằng scripts/reverse-corporate-event.ts",
    }),
  };

  // F-611A-07/#61 — MỘT transaction: mọi operation thành công HAY không có gì
  // thay đổi (AuditLog KHÔNG được nuốt lỗi — trước đây .catch(() => null) tạo
  // row AUTO_ADJUSTED auditLogId: null → reverse bất khả thi, giá kẹt ×f).
  // F-611R-10/#61 (Vòng 2): interactive form + timeout 30s — ~64 op tuần tự
  // qua WAN vượt mặc định 5s của Prisma (array-form không hỗ trợ timeout).
  const audit = await db.$transaction(
    async (tx) => {
      for (let i = 0; i < targets.length; i++) {
        await tx.bar.update({
          where: { instrumentId_date: { instrumentId: inst.id, date: targets[i].date } },
          data: {
            open: postValues[i].open,
            high: postValues[i].high,
            low: postValues[i].low,
            close: postValues[i].close,
            volume: postValues[i].volume,
            value: BigInt(postValues[i].value),
            updatedAt: adjustedAt,
          },
        });
      }
      const created = await tx.auditLog.create({ data: auditJson });
      await tx.corporateEvent.upsert({
        where: {
          instrumentId_date_kind: { instrumentId: inst.id, date: eventBar.date, kind },
        },
        create: {
          instrumentId: inst.id,
          date: eventBar.date,
          kind,
          ratio: f,
          status: "AUTO_ADJUSTED",
          source: "gap-infer-dchart",
          detail: JSON.stringify({ ...detail, auditLogId: null }),
        },
        update: {
          ratio: f,
          status: "AUTO_ADJUSTED",
          source: "gap-infer-dchart",
          detail: JSON.stringify({ ...detail, auditLogId: null }),
        },
      });
      return created;
    },
    { timeout: 30_000 }
  );

  // Audit id chỉ biết SAU transaction → 1 update nhẹ gắn auditLogId đúng
  // (không thuộc phạm vi atomic: id chỉ là chỉ mục tra cứu, thiếu nó reverse
  // vẫn tìm được audit qua eventDate/kind — hàm reverse tự quét).
  await db.corporateEvent
    .update({
      where: { instrumentId_date_kind: { instrumentId: inst.id, date: eventBar.date, kind } },
      data: { detail: JSON.stringify({ ...detail, auditLogId: audit.id }) },
    })
    .catch((err) => {
      console.error(`[corporate-events] gắn auditLogId ${inst.symbol} lỗi (không chặn):`, err);
    });

  // P2-3/#62 — value của toàn chuỗi trước event vừa ×f → ADTV/rổ đổi: xoá
  // cache rổ thanh khoản (best-effort, TTL L2 10 phút là lưới sau).
  await invalidateFeatureCache(TOPBYADTV_CACHE_PREFIX);

  return {
    symbol: inst.symbol,
    eventDate: eventBar.date.toISOString().slice(0, 10),
    kind,
    f,
    barsAdjusted: targets.length,
    auditLogId: audit.id,
  };
}

/** Upsert row CorporateEvent (idempotent @@unique [instrumentId, date, kind]). */
async function upsertEventRow(
  inst: { id: string; symbol: string },
  eventDate: Date,
  kind: "SPLIT" | "BONUS" | "DIVIDEND" | "RESTATE",
  ratio: number,
  status: "AUTO_ADJUSTED" | "SUSPECTED" | "REVERSED",
  detail: Record<string, unknown>
): Promise<void> {
  await db.corporateEvent.upsert({
    where: {
      instrumentId_date_kind: { instrumentId: inst.id, date: eventDate, kind },
    },
    create: {
      instrumentId: inst.id,
      date: eventDate,
      kind,
      ratio,
      status,
      source: "gap-infer-dchart",
      detail: JSON.stringify(detail),
    },
    update: {
      ratio,
      status,
      source: "gap-infer-dchart",
      detail: JSON.stringify(detail),
    },
  });
}

/**
 * F-611A-01/#61 — ghi nhận DRIFT ratio (f mới lệch f đã adjust > ±1%)
 * mà KHÔNG demote row AUTO_ADJUSTED: merge cờ drift vào detail (giữ nguyên
 * mọi khoá cũ: adjustedAt/auditLogId/barsAdjusted — mốc PIT chống double-apply)
 * + RiskAlert WARNING để người vận hành thấy nguồn đổi số liệu.
 */
async function recordDrift(
  inst: { id: string; symbol: string },
  eventDate: Date,
  kind: "SPLIT" | "BONUS",
  newF: number,
  previousRatio: number
): Promise<void> {
  const existing = await db.corporateEvent.findUnique({
    where: { instrumentId_date_kind: { instrumentId: inst.id, date: eventDate, kind } },
  });
  let detail: Record<string, unknown> = {};
  try {
    detail = existing?.detail ? (JSON.parse(existing.detail) as Record<string, unknown>) : {};
  } catch {
    detail = {};
  }
  if (!existing) return; // row đã bị xoá giữa chừng — không có gì để ghi drift
  detail.drift = {
    observedAt: new Date().toISOString(),
    newF: Number(newF.toFixed(6)),
    previousRatio,
    note: "f mới lệch f đã adjust > ±1% — nguồn đổi số liệu, KHÔNG sửa giá thêm; cần người kiểm tra (reverse bằng script nếu f cũ đúng)",
  };
  await db.corporateEvent.update({
    where: { id: existing.id },
    data: { detail: JSON.stringify(detail) },
  });
  // F-611R-04/#61 (Vòng 2) — dedupe 24h như mọi sibling alert (crossCheck,
  // flows, raiseSevereAlerts): drift kéo dài (nguồn không hồi) otherwise tạo
  // 1-2 alert/ngày/event tích luỹ vô hạn trong bảng RiskAlert.
  const since24h = new Date(Date.now() - 24 * 3_600_000);
  const dup = await db.riskAlert
    .findFirst({
      where: { code: "CORPORATE_EVENT_RATIO_DRIFT", createdAt: { gte: since24h } },
      select: { id: true },
    })
    .catch(() => null);
  if (dup) return;
  await db.riskAlert
    .create({
      data: {
        severity: "WARNING",
        code: "CORPORATE_EVENT_RATIO_DRIFT",
        message: `[P1-1 drift] ${inst.symbol}: f mới ${newF.toFixed(4)} lệch f đã adjust ${previousRatio.toFixed(4)} > ±1% — nguồn (dchart) đổi số liệu sự kiện ${eventDate.toISOString().slice(0, 10)}. KHÔNG tự sửa thêm — kiểm tra và reverse bằng script nếu cần.`,
        metricKey: "corporate-event.ratio-drift",
        metricValue: Number((Math.abs(newF / previousRatio - 1) * 100).toFixed(2)),
        threshold: CE_RATIO_AGREEMENT_PCT,
      },
    })
    .catch(() => undefined); // fail-soft — alert không chặn scan
}

/**
 * F-611R-01/#61 (Vòng 2) — TÁI ÁP adjustment sau deep backfill.
 * deepBackfillEod xoá toàn bộ bar rồi tạo lại từ giá GỐC nguồn dchart → mọi
 * điều chỉnh tự động trước đó BỐC HƠI. Event TRONG cửa sổ quét 92 ngày sẽ tự
 * được scan lại (gap tái xuất); event CŨ HƠN không bao giờ được quét lại →
 * chuỗi giữ giá gốc vĩnh viễn trong khi row vẫn nói AUTO_ADJUSTED (nói dối).
 * Hàm này tái áp mọi row AUTO_ADJUSTED của mã (tuần tự cũ → mới, đúng thứ tự
 * nhân chuỗi) — gọi ngay sau khi backfill xong từng mã. Không đụng REVERSED
 * (người đã từ chối) và SUSPECTED (chưa từng sửa giá).
 */
export async function reapplyAutoAdjustments(instrumentId: string): Promise<number> {
  const events = await db.corporateEvent.findMany({
    where: { instrumentId, status: "AUTO_ADJUSTED" },
    orderBy: { date: "asc" },
  });
  let barsAdjusted = 0;
  for (const ev of events) {
    const f = ev.ratio;
    if (!(f > 0) || f === 1) continue;
    const preBars = await db.bar.findMany({
      where: { instrumentId, date: { lt: ev.date } },
      orderBy: { date: "asc" },
      select: { date: true, open: true, high: true, low: true, close: true, volume: true },
    });
    if (preBars.length === 0) continue;
    const adjustedAt = new Date();
    // F-611R-10 — interactive form + timeout 60s (deep history × WAN vượt 5s
    // mặc định; array-form của Prisma 6.19 không nhận timeout).
    await db.$transaction(
      async (tx) => {
        for (const b of preBars) {
          const open = roundToTick(b.open * f);
          const high = roundToTick(b.high * f);
          const low = roundToTick(b.low * f);
          const close = roundToTick(b.close * f);
          const volume = Math.max(0, Math.round(b.volume / f));
          const value = BigInt(volume) * BigInt(close);
          await tx.bar.update({
            where: { instrumentId_date: { instrumentId, date: b.date } },
            data: { open, high, low, close, volume, value, updatedAt: adjustedAt },
          });
        }
      },
      { timeout: 60_000 }
    );
    barsAdjusted += preBars.length;
    // Ghi vết tái áp vào detail (giữ khoá cũ — audit trail)
    try {
      const detail = ev.detail ? (JSON.parse(ev.detail) as Record<string, unknown>) : {};
      detail.reappliedAfterDeepBackfill = adjustedAt.toISOString();
      detail.barsAdjusted = preBars.length;
      await db.corporateEvent.update({
        where: { id: ev.id },
        data: { detail: JSON.stringify(detail) },
      });
    } catch {
      // detail cũ hỏng JSON — không chặn tái áp giá
    }
  }
  // P2-3/#62 — chuỗi vừa tái áp ×f → xoá cache rổ (nếu có điều chỉnh)
  if (barsAdjusted > 0) {
    await invalidateFeatureCache(TOPBYADTV_CACHE_PREFIX);
  }
  return barsAdjusted;
}

/* ═══════════════════════ Đảo ngược (lớp an toàn 8-3b) ═══════════════════════ */

export interface ReverseResult {
  ok: boolean;
  symbol?: string;
  eventDate?: string;
  barsRestored?: number;
  status?: string;
  /** F-1091-07 (fixbug api #109): mã HTTP đúng ngữ nghĩa cho route PUT map —
   * 404 không tồn tại · 409 xung đột trạng thái · mặc định 400 lỗi dữ liệu. */
  httpStatus?: number;
  error?: string;
}

/**
 * ĐẢO NGƯỢC 1 auto-adjust từ AuditLog pre-values (gọi bởi script
 * scripts/reverse-corporate-event.ts hoặc route POST manual):
 *   1. Đọc CorporateEvent row + HỢP CÁC AuditLog của event (F-611A-03/#61:
 *      eod-sync đè lookback tạo NHIỀU audit từng vòng re-adjust, mỗi audit
 *      chỉ chứa pre-values TẬP CON — trước đây chỉ lấy audit MỚI NHẤT →
 *      restore một phần, chuỗi lẫn ×f vĩnh viễn. Giờ: union theo ngày,
 *      audit CŨ NHẤT thắng — đó là pre-values GỐC đầu tiên);
 *   2. Restore từng bar về pre-values (đúng cả value BigInt) — MỘT transaction
 *      cùng row update + audit REVERSED (F-611A-07);
 *   3. Đổi status row → REVERSED (scan sau này KHÔNG tự adjust lại).
 * Chỉ đảo được khi AuditLog còn pre-values đầy đủ (bars > 0).
 */
export async function reverseCorporateEvent(eventId: string): Promise<ReverseResult> {
  try {
    const row = await db.corporateEvent.findUnique({ where: { id: eventId } });
    // F-1091-07: 404 (không tồn tại) / 409 (đã REVERSED) thay vì 400 mặc định
    if (!row) return { ok: false, error: "CorporateEvent không tồn tại", httpStatus: 404 };
    if (row.status === "REVERSED") {
      return { ok: false, error: "sự kiện đã REVERSED từ trước", status: row.status, httpStatus: 409 };
    }
    // F-611A-03/#61 + F-611A-11: lấy TẤT CẢ audit của event theo ngày TĂNG
    // DẦN (audit cũ nhất = vòng adjust ĐẦU TIÊN chứa pre-values gốc đầy đủ
    // nhất), take 200 (trước đây take 50 desc — chuỗi re-adjust hằng ngày có
    // thể đẩy audit mục tiêu ra ngoài cửa sổ).
    const audits = await db.auditLog.findMany({
      where: { action: "CORPORATE_EVENT_AUTO_ADJUSTED", entityId: row.instrumentId },
      orderBy: { createdAt: "asc" },
      take: 200,
    });
    const matches = audits.filter((a) => {
      try {
        const b = JSON.parse(a.before ?? "{}") as { eventDate?: string; kind?: string };
        return (
          b.eventDate === row.date.toISOString().slice(0, 10) &&
          (b.kind ?? "") === row.kind
        );
      } catch {
        return false;
      }
    });
    if (matches.length === 0) {
      return { ok: false, error: "không tìm thấy AuditLog pre-values của event này", httpStatus: 404 };
    }
    // Union pre-values theo NGÀY — audit cũ nhất thắng (vòng adjust đầu ghi
    // giá GỐC của toàn chuỗi; các vòng sau chỉ ghi lại tập con đã bị nguồn đè
    // lại — pre-values của chúng cũng là giá gốc, nhưng cũ nhất là đủ tin).
    const unionByDate = new Map<
      string,
      { date: string; open: number; high: number; low: number; close: number; volume: number; value: string | null }
    >();
    let symbol = row.instrumentId;
    for (const m of matches) {
      try {
        const pre = JSON.parse(m.before ?? "{}") as {
          symbol?: string;
          bars?: { date: string; open: number; high: number; low: number; close: number; volume: number; value: string | null }[];
        };
        if (pre.symbol) symbol = pre.symbol;
        for (const b of pre.bars ?? []) {
          if (!unionByDate.has(b.date)) unionByDate.set(b.date, b);
        }
      } catch {
        // audit hỏng JSON — bỏ qua audit này, audit khác cùng event vẫn có
      }
    }
    const bars = [...unionByDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
    if (bars.length === 0) {
      return { ok: false, error: "AuditLog không chứa pre-values bars (rỗng)" };
    }
    const restoredAt = new Date();
    // F-611A-07/#61 — MỘT transaction: restore bars + row REVERSED + audit
    // (F-611R-10: interactive form + timeout 30s cho chuỗi dài qua WAN —
    // array-form của Prisma 6.19 không nhận timeout).
    await db.$transaction(
      async (tx) => {
        for (const b of bars) {
          await tx.bar.update({
            where: {
              instrumentId_date: {
                instrumentId: row.instrumentId,
                date: new Date(`${b.date}T15:00:00.000Z`),
              },
            },
            data: {
              open: b.open,
              high: b.high,
              low: b.low,
              close: b.close,
              volume: b.volume,
              value: b.value != null ? BigInt(b.value) : null,
              updatedAt: restoredAt,
            },
          });
        }
        await tx.corporateEvent.update({
          where: { id: row.id },
          data: {
            status: "REVERSED",
            detail: JSON.stringify({
              reversedAt: restoredAt.toISOString(),
              reversedFromAuditLogs: matches.map((m) => m.id),
              barsRestored: bars.length,
              note: "đã đảo ngược thủ công (union mọi vòng adjust — audit cũ nhất thắng) — scan KHÔNG tự adjust lại (kill-switch per-event)",
            }),
          },
        });
        await tx.auditLog.create({
          data: {
            action: "CORPORATE_EVENT_REVERSED",
            entity: "CorporateEvent",
            entityId: row.id,
            before: JSON.stringify({ status: row.status, ratio: row.ratio }),
            after: JSON.stringify({ status: "REVERSED", barsRestored: bars.length }),
          },
        });
      },
      { timeout: 30_000 }
    );
    // P2-3/#62 — pre-values gốc vừa được restore → xoá cache rổ
    await invalidateFeatureCache(TOPBYADTV_CACHE_PREFIX);
    return {
      ok: true,
      symbol,
      eventDate: row.date.toISOString().slice(0, 10),
      barsRestored: bars.length,
      status: "REVERSED",
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
