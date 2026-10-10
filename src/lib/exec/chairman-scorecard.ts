/**
 * src/lib/exec/chairman-scorecard.ts — E-P1-4 (EXECUTION_OPS_BLUEPRINT
 * v1.1 §4, triển khai v1.2): ChairmanScorecard — đo chất lượng Tín hiệu
 * Chủ tịch (giải G4 "Chất lượng Chủ tịch không đo được").
 *
 * Nhãn (đúng spec): tín hiệu 5 PHIÊN SAU đối chiếu Bar —
 *  - BUY thắng nếu high của 5 bar sau CHẠM targetPrice TRƯỚC khi low chạm
 *    stopLoss; ngược lại thua nếu low chạm stop trước (có đủ target/stop);
 *    THIẾU target/stop → đơn giản hoá phiên 1: close-5-phiên vs giá sinh
 *    (entry close của bar ngày sinh tín hiệu);
 *  - SELL đối xứng (low ≤ targetPrice = thắng; high ≥ stopLoss = thua;
 *    fallback close-5 < entry = thắng).
 *  - Chưa đủ 5 bar tương lai → "chưa chấm được" (đếm pendingLabels, không bịa).
 *
 * Phân loại [ML M1]: predicted-up = direction BUY; actual-up = (BUY && WIN)
 * || (SELL && LOSS) → confusion TP/FP/FN/TN → precision ("tín hiệu BUY có tới
 * target không"), recall, F1 (BUY hiếm — imbalanced đúng cảnh báo tài liệu).
 * AUC-PR = Average Precision trên rank theo score (gộp nhóm đồng điểm — xử
 * lý tie chuẩn). RMSE target/stop [ML M2 — phạt nặng sai số lớn]. Calibration
 * LOW/MEDIUM/HIGH → winrate + odds [MATH H6 e^β — ngôn ngữ odds của LR] +
 * [DL L3 softmax 3 lớp như "phân phối xác suất"]. enoughData=false khi n<30
 * [DA D7 — trung thực như B8].
 *
 * Thuần DB — 0 LLM, 0 dependency (TypeScript thuần §2.7 P1).
 */

import { db } from "@/lib/db";

/** Mã Chủ tịch trong roster (A1). */
export const CHAIRMAN_CODE = "portfolio-strategist";

/** Số phiên tương lai để chấm nhãn. */
export const LABEL_SESSIONS = 5;
/** Ngưỡng đủ dữ liệu [DA D7 n≥30]. */
export const ENOUGH_DATA_N = 30;
/** Cửa sổ mặc định 90 ngày. */
export const DEFAULT_WINDOW_DAYS = 90;

// ── Nhãn & dữ liệu chấm ──

/** Kết quả chấm 1 tín hiệu. */
export interface SignalLabel {
  signalId: string;
  symbol: string;
  direction: "BUY" | "SELL";
  confidence: "LOW" | "MEDIUM" | "HIGH";
  score: number;
  entryClose: number | null;
  close5: number | null;
  high5: number | null;
  low5: number | null;
  targetPrice: number | null;
  stopLoss: number | null;
  /** WIN | LOSS | null (chưa chấm được — thiếu bar tương lai). */
  label: "WIN" | "LOSS" | null;
  /** Quy tắc chấm áp dụng (audit minh bạch). */
  rule: "target-stop" | "close5" | "pending";
}

/** Hộp calibration theo confidence. */
export interface CalibrationBucket {
  confidence: "LOW" | "MEDIUM" | "HIGH";
  n: number;
  wins: number;
  /** winrate 0..1 — null khi n=0. */
  winrate: number | null;
  /** odds = p/(1−p) [MATH H6] — null khi p=0 hoặc p=1 (odds 0/∞ không minh bạch). */
  odds: number | null;
}

/** Hợp đồng ChairmanScorecard §3.2 (E-P1-4). */
export interface ChairmanScorecard {
  v: 1;
  kind: "ChairmanScorecard";
  window: { days: number; from: string; to: string };
  /** Tín hiệu actionable (BUY/SELL) của Chủ tịch trong window. */
  signals: number;
  /** Số đã chấm được nhãn. */
  labeled: number;
  /** Chưa đủ bar tương lai (tín hiệu non chưa chấm — không bịa). */
  pendingLabels: number;
  buys: number;
  sells: number;
  confusion: { tp: number; fp: number; fn: number; tn: number };
  precision: number | null;
  recall: number | null;
  f1: number | null;
  /** Average Precision (AUC-PR xấp xỉ — rank theo score, gộp đồng điểm). */
  aucPr: number | null;
  /** RMSE targetPrice vs high thực 5 phiên (BUY có target) — VND. */
  targetRmse: number | null;
  /** RMSE stopLoss vs low thực 5 phiên (BUY có stop) — VND. */
  stopRmse: number | null;
  calibration: CalibrationBucket[];
  /** F-73B-06: số nhãn theo từng quy tắc — tín hiệu CÓ target/stop nhưng
   *  không chạm trong 5 phiên vẫn fallback close-5 (semantics khai báo rõ). */
  ruleCounts: { targetStop: number; close5: number; pending: number };
  /** n ≥ 30 [DA D7] — false → UI "chưa đủ dữ liệu" trung thực. */
  enoughData: boolean;
  note: string;
  generatedAt: string;
}

/** Một điểm dữ liệu bar thu gọn để chấm nhãn. */
interface BarPoint {
  date: number; // epoch ms (00:00 VN theo DB)
  high: number;
  low: number;
  close: number;
}

/** Chấm nhãn 1 tín hiệu bằng chuỗi bar của mã (barAtOrBefore = entry). */
export function labelSignal(
  sig: {
    direction: "BUY" | "SELL";
    targetPrice: number | null;
    stopLoss: number | null;
    createdAt: Date;
  },
  bars: BarPoint[]
): Pick<SignalLabel, "entryClose" | "close5" | "high5" | "low5" | "label" | "rule"> {
  // Entry: bar cuối cùng có date ≤ ngày sinh tín hiệu (giá sinh ≈ close phiên đó).
  let entryIdx = -1;
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].date <= sig.createdAt.getTime()) {
      entryIdx = i;
      break;
    }
  }
  if (entryIdx < 0) {
    return { entryClose: null, close5: null, high5: null, low5: null, label: null, rule: "pending" };
  }
  const future = bars.slice(entryIdx + 1, entryIdx + 1 + LABEL_SESSIONS);
  if (future.length < LABEL_SESSIONS) {
    return {
      entryClose: bars[entryIdx].close,
      close5: null,
      high5: null,
      low5: null,
      label: null,
      rule: "pending",
    };
  }
  const entryClose = bars[entryIdx].close;
  const close5 = future[future.length - 1].close;
  const high5 = Math.max(...future.map((b) => b.high));
  const low5 = Math.min(...future.map((b) => b.low));

  // ── Quy tắc chính: target/stop chạm trước trong 5 phiên ──
  if (sig.direction === "BUY") {
    if (sig.targetPrice != null && sig.targetPrice > 0 && sig.stopLoss != null && sig.stopLoss > 0) {
      for (const b of future) {
        if (b.low <= sig.stopLoss) {
          return { entryClose, close5, high5, low5, label: "LOSS", rule: "target-stop" };
        }
        if (b.high >= sig.targetPrice) {
          return { entryClose, close5, high5, low5, label: "WIN", rule: "target-stop" };
        }
      }
    }
    // Fallback phiên 1: so close-5-phiên vs giá sinh.
    return {
      entryClose,
      close5,
      high5,
      low5,
      label: close5 > entryClose ? "WIN" : "LOSS",
      rule: "close5",
    };
  }
  // SELL
  if (sig.targetPrice != null && sig.targetPrice > 0 && sig.stopLoss != null && sig.stopLoss > 0) {
    for (const b of future) {
      if (b.high >= sig.stopLoss) {
        return { entryClose, close5, high5, low5, label: "LOSS", rule: "target-stop" };
      }
      if (b.low <= sig.targetPrice) {
        return { entryClose, close5, high5, low5, label: "WIN", rule: "target-stop" };
      }
    }
  }
  return {
    entryClose,
    close5,
    high5,
    low5,
    label: close5 < entryClose ? "WIN" : "LOSS",
    rule: "close5",
  };
}

/** Average Precision gộp nhóm đồng điểm (xử lý tie chuẩn — không thiên vị thứ tự). */
export function averagePrecision(
  items: { score: number; relevant: boolean }[]
): number | null {
  if (items.length === 0) return null;
  const positives = items.filter((i) => i.relevant).length;
  if (positives === 0) return null;
  // Sort giảm dần theo score (ổn định — nhóm đồng điểm tính GỘP).
  const sorted = [...items].sort((a, b) => b.score - a.score);
  let hits = 0;
  let ap = 0;
  let i = 0;
  while (i < sorted.length) {
    // Nhóm đồng điểm liên tiếp.
    let j = i;
    while (j < sorted.length && sorted[j].score === sorted[i].score) j++;
    const group = sorted.slice(i, j);
    const groupHits = group.filter((g) => g.relevant).length;
    if (groupHits > 0) {
      hits += groupHits;
      const precisionAtGroup = hits / j; // sau khi nạp cả nhóm
      ap += precisionAtGroup * (groupHits / positives);
    }
    i = j;
  }
  return ap;
}

/** RMSE danh sách sai số (null khi rỗng) [ML M2]. */
function rmseOf(errors: number[]): number | null {
  if (errors.length === 0) return null;
  return Math.round(
    Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / errors.length)
  );
}

/**
 * Tổng hợp ChairmanScorecard trong window — thuần query DB. Trả đủ hợp đồng
 * kể cả 0 tín hiệu (metrics null, enoughData=false — UI trung thực).
 *
 * opts.signalIds: thu hẹp cohort về đúng tập id (exec-verify hermetic — không
 * phụ thuộc tín hiệu prod trong window; mặc định undefined = toàn cohort).
 */
export async function buildChairmanScorecard(
  days = DEFAULT_WINDOW_DAYS,
  opts?: { signalIds?: string[] }
): Promise<ChairmanScorecard> {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);

  const chairmanAgent = await db.agent.findFirst({
    where: { code: CHAIRMAN_CODE },
    select: { id: true },
  });
  // F-73B-08: thiếu agent row → scorecard RỖNG trung thực — fallback lấy mọi
  // tín hiệu của mọi agent sẽ chấm sai cohort (DB thật có tín hiệu từ 4 agentId).
  if (!chairmanAgent) {
    return {
      v: 1,
      kind: "ChairmanScorecard",
      window: { days, from: from.toISOString(), to: to.toISOString() },
      signals: 0,
      labeled: 0,
      pendingLabels: 0,
      buys: 0,
      sells: 0,
      confusion: { tp: 0, fp: 0, fn: 0, tn: 0 },
      precision: null,
      recall: null,
      f1: null,
      aucPr: null,
      targetRmse: null,
      stopRmse: null,
      calibration: (["LOW", "MEDIUM", "HIGH"] as const).map((confidence) => ({
        confidence,
        n: 0,
        wins: 0,
        winrate: null,
        odds: null,
      })),
      ruleCounts: { targetStop: 0, close5: 0, pending: 0 },
      enoughData: false,
      note: "Không xác định được agent Chủ tịch (portfolio-strategist) trong DB — scorecard trống trung thực, không fallback lấy tín hiệu mọi agent.",
      generatedAt: new Date().toISOString(),
    };
  }
  // F-73B-08: cohort neo agentId Chủ tịch đã xác thực — không fallback mọi
  // tín hiệu (mọi agentId) khi thiếu row (đã trả rỗng trung thực ở trên).
  const signals = await db.signal.findMany({
    where: {
      createdAt: { gte: from, lt: to },
      direction: { in: ["BUY", "SELL"] },
      agentId: chairmanAgent.id,
      ...(opts?.signalIds ? { id: { in: opts.signalIds } } : {}),
    },
    select: {
      id: true,
      instrumentId: true,
      direction: true,
      confidence: true,
      score: true,
      targetPrice: true,
      stopLoss: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  // Load bar 1 lần/mã (từ 30 ngày trước window → đủ entry cho mọi tín hiệu).
  const instrumentIds = [...new Set(signals.map((s) => s.instrumentId))];
  const barsByInstrument = new Map<string, BarPoint[]>();
  if (instrumentIds.length > 0) {
    const barFrom = new Date(from.getTime() - 30 * 86_400_000);
    const bars = await db.bar.findMany({
      where: { instrumentId: { in: instrumentIds }, date: { gte: barFrom, lt: to } },
      orderBy: [{ instrumentId: "asc" }, { date: "asc" }],
      select: { instrumentId: true, date: true, high: true, low: true, close: true },
    });
    for (const b of bars) {
      const arr = barsByInstrument.get(b.instrumentId) ?? [];
      arr.push({ date: b.date.getTime(), high: b.high, low: b.low, close: b.close });
      barsByInstrument.set(b.instrumentId, arr);
    }
  }

  const labels: SignalLabel[] = signals.map((s) => {
    const bars = barsByInstrument.get(s.instrumentId) ?? [];
    // Where-clause đã lọc direction IN (BUY, SELL) — thu hẹp kiểu cho labelSignal.
    const graded = labelSignal(
      {
        direction: s.direction as "BUY" | "SELL",
        targetPrice: s.targetPrice,
        stopLoss: s.stopLoss,
        createdAt: s.createdAt,
      },
      bars
    );
    return {
      signalId: s.id,
      symbol: "", // symbol không bắt buộc cho metrics — bỏ chi tiết tối thiểu
      direction: s.direction as "BUY" | "SELL",
      confidence:
        s.confidence === "HIGH" || s.confidence === "LOW" ? s.confidence : "MEDIUM",
      score: s.score,
      entryClose: graded.entryClose,
      close5: graded.close5,
      high5: graded.high5,
      low5: graded.low5,
      targetPrice: s.targetPrice,
      stopLoss: s.stopLoss,
      label: graded.label,
      rule: graded.rule,
    };
  });

  const labeled = labels.filter((l) => l.label != null);
  const pendingLabels = labels.length - labeled.length;

  // ── Confusion: predicted-up = BUY; actual-up = giá tăng ──
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  const rankItems: { score: number; relevant: boolean }[] = [];
  for (const l of labeled) {
    const actualUp = l.direction === "BUY" ? l.label === "WIN" : l.label === "LOSS";
    if (l.direction === "BUY" && actualUp) tp++;
    else if (l.direction === "BUY" && !actualUp) fp++;
    else if (l.direction === "SELL" && actualUp) fn++;
    else tn++;
    rankItems.push({ score: l.score, relevant: actualUp });
  }

  const precision = tp + fp > 0 ? Number((tp / (tp + fp)).toFixed(4)) : null;
  const recall = tp + fn > 0 ? Number((tp / (tp + fn)).toFixed(4)) : null;
  const f1 =
    precision != null && recall != null && precision + recall > 0
      ? Number(((2 * precision * recall) / (precision + recall)).toFixed(4))
      : null;
  const aucPr = averagePrecision(rankItems);

  // ── RMSE target/stop (BUY có đủ số) ──
  const targetErrors: number[] = [];
  const stopErrors: number[] = [];
  for (const l of labeled) {
    if (l.direction === "BUY") {
      if (l.targetPrice != null && l.high5 != null) {
        targetErrors.push(l.targetPrice - l.high5);
      }
      if (l.stopLoss != null && l.low5 != null) {
        stopErrors.push(l.stopLoss - l.low5);
      }
    }
  }

  // ── Calibration LOW/MEDIUM/HIGH → winrate + odds ──
  const calibration: CalibrationBucket[] = (["LOW", "MEDIUM", "HIGH"] as const).map(
    (confidence) => {
      const bucket = labeled.filter((l) => l.confidence === confidence);
      const wins = bucket.filter((l) => l.label === "WIN").length;
      const winrate = bucket.length > 0 ? Number((wins / bucket.length).toFixed(4)) : null;
      return {
        confidence,
        n: bucket.length,
        wins,
        winrate,
        odds:
          winrate != null && winrate > 0 && winrate < 1
            ? Number((winrate / (1 - winrate)).toFixed(4))
            : null,
      };
    }
  );

  return {
    v: 1,
    kind: "ChairmanScorecard",
    window: { days, from: from.toISOString(), to: to.toISOString() },
    signals: signals.length,
    labeled: labeled.length,
    pendingLabels,
    buys: labels.filter((l) => l.direction === "BUY").length,
    sells: labels.filter((l) => l.direction === "SELL").length,
    confusion: { tp, fp, fn, tn },
    precision,
    recall,
    f1,
    aucPr,
    targetRmse: rmseOf(targetErrors),
    stopRmse: rmseOf(stopErrors),
    calibration,
    // F-73B-06: minh bạch quy tắc chấm — bao nhiêu nhãn target/stop vs
    // fallback close-5 vs chưa chấm được (pending).
    ruleCounts: {
      targetStop: labels.filter((l) => l.rule === "target-stop").length,
      close5: labels.filter((l) => l.rule === "close5").length,
      pending: labels.filter((l) => l.rule === "pending").length,
    },
    enoughData: labeled.length >= ENOUGH_DATA_N,
    note:
      "Nhãn 5 phiên sau (target/stop chạm trước; fallback close-5-phiên) — đủData " +
      `yêu cầu ${ENOUGH_DATA_N} nhãn [DA D7]. Scorecard mô tả, không phán xét (§6.5). ` +
      // F-73B-06/F-73B-07: khai báo semantics fallback close-5 + phạm vi RMSE.
      // F-73R2-04: close5 gồm CẢ 2 loại — tín hiệu không đặt target/stop lẫn
      // tín hiệu CÓ target/stop nhưng không chạm trong 5 phiên (fallthrough).
      "Tín hiệu có target/stop nhưng không chạm trong 5 phiên → fallback close-5 " +
      "(ruleCounts.close5 gồm cả tín hiệu không đặt target/stop lẫn fallthrough). " +
      "RMSE tính trên tập BUY (SELL đối xứng hoá ở P2).",
    generatedAt: new Date().toISOString(),
  };
}
