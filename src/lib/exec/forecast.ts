/**
 * src/lib/exec/forecast.ts — E-P1-3 (EXECUTION_OPS_BLUEPRINT v1.1 §4,
 * triển khai v1.2): A12 CashflowForecast — dự báo dòng tiền kịch bản.
 *
 * Ngôn ngữ: TYPESCRIPT THUẦN trước (mặc định §7.5 trader duyệt) — baseline
 * hồi quy tuyến tính + quantile [DA D2] (OLS slope theo thời gian, phần dư
 * lấy phân vị p2,5/p97,5 làm CI 95% phi tham số — kháng đuôi nặng [DA D7
 * cảnh báo "dữ liệu tài chính đuôi nặng → không dùng CI chuẩn mù"]). Worker
 * Python GRU [DL L2/L7 rule of thumb] chỉ cân nhắc khi baseline vượt ngưỡng
 * lỗi (khi đó mới mở worker — không trong P1 này).
 *
 * Kịch bản phê duyệt (đầu vào CommittedCashView E-P0-4 + khối cam kết):
 *  - none       : mọi cam kết KHÔNG thực hiện — xu hướng thuần từ chuỗi cash;
 *  - half       : MỘT NỬA cam kết thực hiện — kịch bản MINH BẠCH (không phải
 *                 xác suất thật — khai báo trong contract, đúng spec E-P1-3);
 *  - allApprove : MỌI cam kết thực hiện (BUY chi tiền, SELL thu về).
 *
 * §6.4/§6.7: KHÔNG dùng làm hạn mức chặn — chỉ hiển thị + khuyến nghị;
 * nhãn "ước tính nội bộ — không phải hạn mức thật VNDIRECT" giữ nguyên.
 *
 * ĐIỀU KIỆN TIÊN QUYẾT (§8): chuỗi snapshot cash theo thời gian — model
 * CashSnapshot (mới trong P1) ghi mỗi chu kỳ A12, prune 90 ngày.
 */

import { db } from "@/lib/db";

// ── Snapshot chuỗi cash (điều kiện tiên quyết §8) ──────────────────────────

/** Ghi 1 snapshot cash mỗi chu kỳ A12 + prune cũ hơn 90 ngày (chống phình). */
export async function recordCashSnapshot(input: {
  brokerAccountId: string;
  cash: number;
  equity: number;
  source?: string;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  await db.cashSnapshot.create({
    data: {
      brokerAccountId: input.brokerAccountId,
      cash: BigInt(Math.round(input.cash)),
      equity: BigInt(Math.round(input.equity)),
      source: input.source ?? "cycle",
      createdAt: now,
    },
  });
  // Prune: giữ 90 ngày (chuỗi dài đủ cho xu hướng, ngắn đủ nhẹ DB).
  await db.cashSnapshot.deleteMany({
    where: { createdAt: { lt: new Date(now.getTime() - 90 * 86_400_000) } },
  }).catch(() => undefined);
}

// ── Hợp đồng CashflowForecast §3.2/E-P1-3 ─────────────────────────────────

/** Một kịch bản dòng tiền. */
export interface CashflowScenario {
  name: "none" | "half" | "allApprove";
  /** Cash dự kiến tại chân trời (VND). */
  cashAtHorizon: number;
  /** Biến động ròng của kịch bản so với cash hiện tại (VND). */
  deltaVnd: number;
  /** Khoảng tin cậy 95% quanh cashAtHorizon (từ quantile phần dư — phi tham số). */
  ci95: { low: number; high: number } | null;
  note: string;
}

/** Hợp đồng dự báo dòng tiền A12 (E-P1-3). */
export interface CashflowForecast {
  v: 1;
  kind: "CashflowForecast";
  /** Nhãn minh bạch — ước tính nội bộ, không phải hạn mức thật VNDIRECT. */
  label: string;
  /** Chân trời dự báo (giờ) — 1 chu kỳ kế tiếp mặc định. */
  horizonHours: number;
  /** Chuỗi lịch sử đang dùng (số mẫu + khoảng thời gian). */
  history: { n: number; from: string | null; to: string | null; spanDays: number };
  /** Hệ số góc OLS xu hướng cash (VND/ngày) — null khi chưa đủ mẫu fit. */
  trendVndPerDay: number | null;
  /** Phân vị phần dư OLS (VND) — dải CI 95% phi tham số. */
  residualQuantiles: { p2_5: number; p97_5: number } | null;
  scenarios: CashflowScenario[];
  /** n ≥ 30 [DA D7] — false → UI trung thực "chưa đủ dữ liệu". */
  enoughData: boolean;
  /** Baseline đang dùng + đường tiến hoá (GRU chỉ khi baseline thiếu). */
  baseline: "linear-quantile";
  note: string;
}

/** Đầu vào từ CommittedCashView (E-P0-4) + snapshot chuỗi. */
export interface ForecastInput {
  cash: number;
  /** Cam kết chi tiền nếu MỌI lệnh BUY chờ khớp (kèm phí). */
  committedBuyNotional: number;
  /** Tiền vào nếu MỌI lệnh SELL chờ khớp (đã trừ phí + thuế). */
  committedSellInflow: number;
  horizonHours?: number;
}

/** Quantile kiểu Pandas (linear interpolation) — dùng chung ngôn ngữ [DA D2]. */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Số mẫu tối thiểu để fit xu hướng (dưới mức này → trend null, CI null). */
const MIN_FIT_N = 5;
/** F-73B-05: span tối thiểu để fit xu hướng (ngày) — 5 snapshot trong vài phút
 *  cho slope "VND/ngày" ngoại suy vô nghĩa (đo thực tế: 720 triệu ₫/ngày). */
const MIN_SPAN_DAYS = 1;
/** Ngưỡng đủ dữ liệu hiển thị độ tin cậy [DA D7 n≥30]. */
const ENOUGH_DATA_N = 30;

/**
 * Tính CashflowForecast từ chuỗi CashSnapshot + cam kết hiện tại.
 * Thuần TS — 0 dependency. Fail-soft: caller bọc try/catch (A12 DEGRADED).
 */
export async function computeCashflowForecast(
  input: ForecastInput,
  accountId?: string
): Promise<CashflowForecast> {
  const horizonHours = input.horizonHours ?? 1;
  const horizonDays = horizonHours / 24;

  // F-73B-01 (fixbug #73): orderBy desc + reverse — orderBy asc + take sẽ
  // lấy 500 dòng CŨ NHẤT, trend/CI đóng băng trên dữ liệu cũ khi chuỗi > 500.
  const snapshots = await db.cashSnapshot.findMany({
    where: accountId ? { brokerAccountId: accountId } : undefined,
    orderBy: { createdAt: "desc" }, // F-73B-01: lấy 500 MỚI NHẤT...
    take: 500,
    select: { createdAt: true, cash: true },
  });
  snapshots.reverse(); // ...rồi đảo lại thành tăng dần cho OLS
  const series = snapshots.map((s) => ({
    t: s.createdAt.getTime(),
    cash: Number(s.cash),
  }));

  // F-73R2-05: span THÔ (ms→ngày, KHÔNG làm tròn) cho guard fit — history.spanDays
  // đã toFixed(2) nên span 0,995 ngày thành "1.00" → fit nhầm sớm ~30ph.
  const rawSpanDays =
    series.length > 1 ? (series[series.length - 1].t - series[0].t) / 86_400_000 : 0;

  const history = {
    n: series.length,
    from: series.length > 0 ? series[0].t : null,
    to: series.length > 0 ? series[series.length - 1].t : null,
    spanDays: Number(rawSpanDays.toFixed(2)),
  };

  // ── Baseline OLS: cash ~ a + b×t (b = VND/ms → đổi VND/ngày) ──
  let trendVndPerDay: number | null = null;
  let residualQuantiles: { p2_5: number; p97_5: number } | null = null;
  // F-73B-05: span < 1 ngày → slope "VND/ngày" vô nghĩa — trend/CI null
  // (fail trung thực như n < 5, không ngoại suy chuỗi trải vài phút).
  if (series.length >= MIN_FIT_N && rawSpanDays >= MIN_SPAN_DAYS) {
    const n = series.length;
    const t0 = series[0].t;
    const xs = series.map((s) => (s.t - t0) / 86_400_000); // ngày (số thực)
    const ys = series.map((s) => s.cash);
    const mx = xs.reduce((s, v) => s + v, 0) / n;
    const my = ys.reduce((s, v) => s + v, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - mx) * (ys[i] - my);
      den += (xs[i] - mx) * (xs[i] - mx);
    }
    if (den > 0) {
      const slopePerDay = num / den;
      const intercept = my - slopePerDay * mx;
      trendVndPerDay = Math.round(slopePerDay);
      // Phần dư tại các điểm lịch sử → phân vị [DA D2 — CI phi tham số].
      const residuals = ys
        .map((y, i) => y - (intercept + slopePerDay * xs[i]))
        .sort((a, b) => a - b);
      residualQuantiles = {
        p2_5: Math.round(quantile(residuals, 0.025)),
        p97_5: Math.round(quantile(residuals, 0.975)),
      };
    }
  }

  // ── Kịch bản (điểm khởi hành = cash HIỆN TẠI, không phải fit) ──
  const trendDelta = trendVndPerDay != null ? trendVndPerDay * horizonDays : 0;
  const netCommitment = input.committedBuyNotional - input.committedSellInflow;
  const mk = (
    name: CashflowScenario["name"],
    executedShare: number,
    note: string
  ): CashflowScenario => {
    const delta = trendDelta - executedShare * netCommitment;
    const cashAtHorizon = Math.round(input.cash + delta);
    return {
      name,
      cashAtHorizon,
      deltaVnd: Math.round(delta),
      ci95:
        residualQuantiles != null
          ? {
              low: cashAtHorizon + residualQuantiles.p2_5,
              high: cashAtHorizon + residualQuantiles.p97_5,
            }
          : null,
      note,
    };
  };

  const scenarios: CashflowScenario[] = [
    mk(
      "none",
      0,
      "Không phê duyệt thêm — cash đi theo xu hướng thuần từ chuỗi snapshot"
    ),
    mk(
      "half",
      0.5,
      "Kịch bản MINH BẠCH một nửa cam kết thực hiện — không phải xác suất thật"
    ),
    mk(
      "allApprove",
      1,
      "Mọi cam kết BUY chi tiền + lệnh SELL khớp — dòng biến động đầy đủ"
    ),
  ];

  return {
    v: 1,
    kind: "CashflowForecast",
    label: "ước tính nội bộ — không phải hạn mức thật VNDIRECT",
    horizonHours,
    history: {
      n: history.n,
      from: history.from != null ? new Date(history.from).toISOString() : null,
      to: history.to != null ? new Date(history.to).toISOString() : null,
      spanDays: history.spanDays,
    },
    trendVndPerDay,
    residualQuantiles,
    scenarios,
    enoughData: series.length >= ENOUGH_DATA_N,
    baseline: "linear-quantile",
    note:
      "Baseline hồi quy tuyến tính + quantile phần dư (TypeScript thuần — §7.5); " +
      "worker GRU [DL L2/L7] chỉ mở khi baseline vượt ngưỡng lỗi. Kịch bản half là " +
      "kịch bản minh bạch, KHÔNG phải xác suất thật. Dự báo KHÔNG dùng chặn lệnh (§6.4). " +
      // F-73B-09/F-73B-10: khai báo minh bạch horizon + CI + bảo thủ một chiều.
      "Chân trời cố định 1h (mặc định P1 — không theo AGENT_CYCLE_MINUTES); CI95 từ " +
      "phần dư thang NGÀY nên rộng hơn cho chân trời ngắn (bảo thủ); kịch bản allApprove " +
      "chưa tính dòng vào của tín hiệu SELL ACTIVE (bảo thủ một chiều — khai báo minh bạch).",
  };
}

/** Tóm tắt 1 câu cho content ServiceRunResult của A12. */
export function forecastSummary(f: CashflowForecast): string {
  const vnd = (n: number) => Math.round(n).toLocaleString("vi-VN");
  const name: Record<CashflowScenario["name"], string> = {
    none: "không duyệt thêm",
    half: "duyệt một nửa",
    allApprove: "duyệt tất cả",
  };
  const parts = f.scenarios.map(
    (s) => `${name[s.name]} → ${vnd(s.cashAtHorizon)} ₫${s.ci95 ? ` (CI95 ${vnd(s.ci95.low)}–${vnd(s.ci95.high)})` : ""}`
  );
  const trend =
    f.trendVndPerDay != null
      ? ` Xu hướng ${vnd(f.trendVndPerDay)} ₫/ngày từ ${f.history.n} snapshot.`
      : ` Chuỗi ${f.history.n} snapshot chưa đủ fit xu hướng.`;
  return `Dự báo dòng tiền ${f.horizonHours}h tới: ${parts.join(" · ")}.${trend}${f.enoughData ? "" : " (chưa đủ 30 mẫu — độ tin cậy hạn chế)"}`;
}
