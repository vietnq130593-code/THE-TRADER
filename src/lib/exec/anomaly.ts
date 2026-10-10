/**
 * src/lib/exec/anomaly.ts — E-P1-5 (EXECUTION_OPS_BLUEPRINT v1.1 §4,
 * triển khai v1.2): A11/A10 phát hiện giao dịch bất thường.
 *
 * Hai phép (đúng spec):
 *  1. IQR fee/slippage [DA D4 — NumPy EDA IQR Method]:样本 slippage (lệch giá
 *     khớp vs giá đặt của lệnh FILLED) + fence Q1−1,5×IQR / Q3+1,5×IQR —
 *     ngoài rào → bất thường (cần ≥ 4 mẫu để IQR có nghĩa).
 *  2. z-score fill vs mid [DA D8 — ±2σ "rõ rệt" Empirical rule]: giá khớp
 *     so với phân phối 20 bar CLOSE trước ngày giao dịch của chính mã đó
 *     (mean20/σ20 từ Bar EOD — "mid" ≈ trung bình close 20 phiên; Quote lịch sử
 *     không lưu sâu nên mid = mean close 20 phiên, khai báo minh bạch). Cần đủ
 *     20 bar — thiếu thì bỏ qua trung thực (F-73B-12). |z| > 2 → fill bất thường.
 *
 * RiskAlert mức NHẸ (severity INFO — không ack-bắt-buộc, đúng spec E-P1-5):
 * code EXEC_TRADE_ANOMALY, dedupe 24h (cùng họ EXEC_RECONCILE_MISMATCH).
 *
 * Fail-soft §6.6: mọi lỗi query → trả { skipped: true } không sập A11.
 */

import { db } from "@/lib/db";

/** Ngưỡng z-score "rõ rệt" của quy tắc thực nghiệm [DA D8 ±2σ]. */
export const ZSCORE_THRESHOLD = 2;
/** Số bar close tính mean/σ cho z-score fill. */
export const ZSCORE_BARS = 20;
/** Số mẫu slippage tối thiểu để IQR có nghĩa. */
export const IQR_MIN_SAMPLES = 4;

// ── Hợp đồng phát hiện ──

/** Một phát hiện bất thường (minh bạch đủ để audit). */
export interface TradeAnomaly {
  kind: "zscore-fill" | "iqr-slippage";
  /** Trade/Order id liên quan. */
  refId: string;
  symbol: string;
  /** Con số đo được (z hoặc % slippage). */
  value: number;
  /** Ngưỡng bị vượt. */
  threshold: number;
  detail: string;
}

/** Kết quả quét bất thường trên window. */
export interface AnomalyScanResult {
  window: { from: string; to: string };
  tradesScanned: number;
  slippageSamples: number;
  anomalies: TradeAnomaly[];
  /** True khi quét bị bỏ qua vì lỗi dữ liệu (fail-soft — không sập A11). */
  skipped: boolean;
  skipReason?: string;
}

/** Quét bất thường giao dịch trong window [from, to). */
export async function detectTradeAnomalies(
  from: Date,
  to: Date
): Promise<AnomalyScanResult> {
  try {
    const trades = await db.trade.findMany({
      where: { executedAt: { gte: from, lt: to } },
      select: {
        id: true,
        instrumentId: true,
        orderId: true,
        side: true,
        price: true,
        executedAt: true,
      },
      orderBy: { executedAt: "asc" },
    });

    // ── (2-prep) Orders FILLED của window — query TRƯỚC nhánh z-score ──
    // F-73B-02: zip order+slippage thành cặp — 2 mảng song song (filter riêng
    // rồi forEach theo idx) lệch chỉ số khi có dòng bẩn bị lọc, gán nhầm
    // anomaly cho lệnh khác + bỏ sót outlier thật (mô phỏng Vòng 1 đã chứng
    // minh). F-73B-03: cần instrumentId của lệnh cho symbolById dùng chung.
    const orders = await db.order.findMany({
      where: {
        status: "FILLED",
        filledAt: { gte: from, lt: to },
        price: { gt: 0 }, // loại dòng bẩn ngay ở query (giữ thẳng hàng mẫu)
        avgFillPrice: { not: null },
      },
      select: { id: true, instrumentId: true, price: true, avgFillPrice: true, quantity: true },
    });

    // F-73B-03: gộp instrumentIds từ trades VÀ orders → symbolById DÙNG CHUNG
    // cho z-score + IQR (map trước đây chỉ build trong nhánh z-score nên nhánh
    // IQR rơi vào "N cp" thiếu mã thật). Chỉ query instrument + build map khi
    // instrumentIds.length > 0 (fail-soft như cũ).
    const instrumentIds = [
      ...new Set([...trades.map((t) => t.instrumentId), ...orders.map((o) => o.instrumentId)]),
    ];
    const anomalies: TradeAnomaly[] = [];
    const symbolById =
      instrumentIds.length > 0
        ? new Map(
            (
              await db.instrument.findMany({
                where: { id: { in: instrumentIds } },
                select: { id: true, symbol: true },
              })
            ).map((i) => [i.id, i.symbol] as [string, string])
          )
        : new Map<string, string>();

    // ── (1) z-score fill vs mean20/σ20 của Bar close ──
    const tradeInstrumentIds = [...new Set(trades.map((t) => t.instrumentId))];
    if (tradeInstrumentIds.length > 0) {
      const barFrom = new Date(from.getTime() - 60 * 86_400_000);
      const bars = await db.bar.findMany({
        where: { instrumentId: { in: tradeInstrumentIds }, date: { gte: barFrom, lt: from } },
        orderBy: [{ instrumentId: "asc" }, { date: "desc" }],
        select: { instrumentId: true, date: true, close: true },
      });
      const closesByInstrument = new Map<string, number[]>();
      for (const b of bars) {
        const arr = closesByInstrument.get(b.instrumentId) ?? [];
        if (arr.length < ZSCORE_BARS) arr.push(b.close); // 20 bar GẦN NHẤT trước window
        closesByInstrument.set(b.instrumentId, arr);
      }
      for (const t of trades) {
        const closes = closesByInstrument.get(t.instrumentId) ?? [];
        if (closes.length < ZSCORE_BARS) continue; // F-73B-12: σ từ <20 bar là nhiễu — bỏ qua trung thực
        const n = closes.length;
        const mean = closes.reduce((s, v) => s + v, 0) / n;
        const variance = closes.reduce((s, v) => s + (v - mean) * (v - mean), 0) / n;
        const std = Math.sqrt(variance);
        if (std <= 0) continue; // giá phẳng — z vô nghĩa
        const z = (t.price - mean) / std;
        if (Math.abs(z) > ZSCORE_THRESHOLD) {
          anomalies.push({
            kind: "zscore-fill",
            refId: t.id,
            symbol: symbolById.get(t.instrumentId) ?? "?",
            value: Number(z.toFixed(2)),
            threshold: ZSCORE_THRESHOLD,
            detail: `Trade ${t.side} giá khớp ${t.price.toLocaleString("vi-VN")} ₫ lệch ${z >= 0 ? "+" : ""}${z.toFixed(2)}σ so mean close ${n} phiên trước window (${Math.round(mean).toLocaleString("vi-VN")} ₫) — vượt ±${ZSCORE_THRESHOLD}σ [DA D8]`,
          });
        }
      }
    }

    // ── (2) IQR slippage trên lệnh FILLED của window ──
    // F-73B-02: zip order+slippage thành cặp — mỗi slip luôn đi kèm đúng lệnh
    // của nó (đã lọc dòng bẩn ngay ở query nên mẫu thẳng hàng tuyệt đối).
    const slippage = orders
      .filter((o) => o.avgFillPrice != null)
      .map((o) => ({
        order: o,
        slip: Number((((o.avgFillPrice! - o.price!) / o.price!) * 100).toFixed(3)),
      }));
    const slippageSamples = slippage.map((s) => s.slip);
    if (slippageSamples.length >= IQR_MIN_SAMPLES) {
      const sorted = [...slippageSamples].sort((a, b) => a - b);
      const q = (p: number) => {
        const pos = (sorted.length - 1) * p;
        const lo = Math.floor(pos);
        const hi = Math.ceil(pos);
        return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
      };
      const q1 = q(0.25);
      const q3 = q(0.75);
      const iqr = q3 - q1;
      if (iqr > 0) {
        const low = q1 - 1.5 * iqr;
        const high = q3 + 1.5 * iqr;
        for (const s of slippage) {
          if (s.slip < low || s.slip > high) {
            const sym = symbolById.get(s.order.instrumentId) ?? "?";
            anomalies.push({
              kind: "iqr-slippage",
              refId: s.order.id,
              symbol: sym,
              value: s.slip,
              threshold: Number((s.slip < low ? low : high).toFixed(3)),
              detail: `Lệnh FILLED ${sym} ${s.order.quantity} cp lệch giá khớp vs đặt ${s.slip.toFixed(2).replace(".", ",")}% — ngoài rào IQR [${low.toFixed(2).replace(".", ",")}%; ${high.toFixed(2).replace(".", ",")}%] trên ${slippage.length} mẫu [DA D4]`,
            });
          }
        }
      }
    }

    return {
      window: { from: from.toISOString(), to: to.toISOString() },
      tradesScanned: trades.length,
      slippageSamples: slippageSamples.length,
      anomalies,
      skipped: false,
    };
  } catch (err) {
    console.error("[exec/anomaly]", err);
    return {
      window: { from: from.toISOString(), to: to.toISOString() },
      tradesScanned: 0,
      slippageSamples: 0,
      anomalies: [],
      skipped: true,
      skipReason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** RiskAlert EXEC_TRADE_ANOMALY — severity INFO (nhẹ, không ack-bắt-buộc),
 *  dedupe 24h theo code + chưa ack. Trả số alert MỚI tạo (0 hoặc 1). */
export async function raiseAnomalyAlert(scan: AnomalyScanResult): Promise<number> {
  if (scan.skipped || scan.anomalies.length === 0) return 0;
  const since = new Date(Date.now() - 24 * 3_600_000);
  const dup = await db.riskAlert.findFirst({
    where: {
      code: "EXEC_TRADE_ANOMALY",
      acknowledgedAt: null,
      createdAt: { gte: since },
    },
    select: { id: true },
  });
  if (dup) return 0;
  const top = scan.anomalies.slice(0, 3);
  await db.riskAlert.create({
    data: {
      severity: "INFO",
      code: "EXEC_TRADE_ANOMALY",
      message:
        `Bất thường giao dịch (${scan.anomalies.length} điểm) trong window ` +
        `${scan.window.from.slice(0, 16).replace("T", " ")} → ${scan.window.to.slice(0, 16).replace("T", " ")}: ` +
        top.map((a) => a.detail).join(" · ") +
        (scan.anomalies.length > top.length
          ? ` · +${scan.anomalies.length - top.length} nữa`
          : "") +
        " — mức nhẹ, không yêu cầu ack bắt buộc (E-P1-5).",
      metricKey: "exec.trade.anomaly",
      metricValue: scan.anomalies.length,
      threshold: 0,
    },
  });
  return 1;
}

/** Tóm tắt 1 câu cho content ServiceRunResult của A11. */
export function anomalyScanSummary(scan: AnomalyScanResult): string {
  if (scan.skipped) {
    return `Quét bất thường giao dịch: BỎ QUA (${scan.skipReason ?? "lỗi dữ liệu"} — fail-soft §6.6).`;
  }
  if (scan.anomalies.length === 0) {
    return `Quét bất thường: ${scan.tradesScanned} giao dịch · ${scan.slippageSamples} mẫu slippage — 0 bất thường (IQR + z-score ±${ZSCORE_THRESHOLD}σ).`;
  }
  const kinds = scan.anomalies.map((a) => a.kind);
  const z = kinds.filter((k) => k === "zscore-fill").length;
  const i = kinds.filter((k) => k === "iqr-slippage").length;
  return `Quét bất thường: ${scan.anomalies.length} điểm (z-score fill: ${z} · IQR slippage: ${i}) — RiskAlert INFO đã ghi (không ack-bắt-buộc).`;
}
