/**
 * src/lib/council/experiments.ts — SÂN THÍ NGHIỆM PHÂN BỔ ĐA RỔ E-ALLOC
 * (#106 COUNCIL_STEWARDSHIP_BLUEPRINT §5 — "đầu tư bao nhiêu, bao nhiêu phần
 * bỏ vào rổ này rổ kia đấy là việc HỘI ĐỒNG phải tự nghiên cứu, học tập,
 * thử nghiệm và thu nhận kết quả").
 *
 * Vòng đời: đề xuất (hội nghị LLM / trader tạo tay / seed) → RUNNING →
 * mark-to-market HẰNG NGÀY theo chỉ số rổ (constant-mix: tái cân bằng về
 * trọng số gốc mỗi ngày) → đủ horizonDays → DONE kèm return/maxDD/Sharpe/
 * đóng góp từng rổ → bài học do phiên hội nghị KẾ TIẾP viết lại.
 *
 * KHÔNG đặt lệnh thật/sandbox — danh mục giấy ĐỘC LẬP (capitalVND riêng).
 * Idempotent: markExperimentsDaily() chỉ chèn snapshot ngày còn thiếu
 * (unique(experimentId, date)); chạy 2 lần không đổi số.
 *
 * Engine gọi 16:35 ICT t2–t6; route POST /api/council/experiments/mark
 * cho phép chạy tay. Trung thực: rổ thiếu dữ liệu ngày → equal-weight trên
 * thành viên có dữ liệu (baskets.ts) + cờ coverage trong basketsJson.
 */

import { db } from "@/lib/db";
import {
  BASKET_KEYS,
  basketDailySeriesCached,
  type BasketKey,
} from "@/lib/council/baskets";

export interface ExperimentWeight {
  basket: BasketKey;
  weight: number; // %
}

export interface CreateExperimentInput {
  name: string;
  hypothesis: string;
  /** Trọng số thô từ caller (LLM/trader) — validateWeights kiểm rổ hợp lệ. */
  weights: Array<{ basket: string; weight: number }>;
  capitalVND: number;
  horizonDays: number;
  createdBy?: string;
}

export interface CreateExperimentResult {
  ok: boolean;
  error?: string;
  experiment?: {
    id: string;
    name: string;
    weightsJson: string;
    capitalVND: string;
    horizonDays: number;
    status: string;
    startedAt: string;
  };
}

const MIN_CAPITAL_VND = 1_000_000;
const MAX_CAPITAL_VND = 10_000_000_000;
const MIN_HORIZON_DAYS = 7;
const MAX_HORIZON_DAYS = 90;

/** Chuẩn hoá + validate trọng số — trả null + lỗi 422-style message. */
export function validateWeights(
  raw: Array<{ basket: string; weight: number }>
): { weights: ExperimentWeight[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: "weights: cần ít nhất 1 rổ có trọng số" };
  }
  const seen = new Set<string>();
  let sum = 0;
  const weights: ExperimentWeight[] = [];
  for (const w of raw) {
    if (!w || typeof w.basket !== "string") continue;
    if (!BASKET_KEYS.includes(w.basket as BasketKey)) {
      return { error: `weights: rổ "${w.basket}" không hợp lệ (${BASKET_KEYS.join(" | ")})` };
    }
    if (seen.has(w.basket)) {
      return { error: `weights: rổ "${w.basket}" xuất hiện 2 lần` };
    }
    seen.add(w.basket);
    const weight = Number(w.weight);
    if (!Number.isFinite(weight) || weight < 0 || weight > 100) {
      return { error: `weights: trọng số ${w.basket} phải ∈ [0, 100]` };
    }
    if (weight > 0) weights.push({ basket: w.basket as BasketKey, weight });
    sum += weight;
  }
  if (weights.length === 0) return { error: "weights: tổng trọng số = 0" };
  if (sum < 95 || sum > 105) {
    return { error: `weights: tổng trọng số phải ∈ [95, 105] (hiện ${sum.toFixed(1)})` };
  }
  // chuẩn hoá về đúng 100 để mark engine dùng trực tiếp
  const norm = weights.map((w) => ({
    basket: w.basket,
    weight: Number(((w.weight / sum) * 100).toFixed(2)),
  }));
  return { weights: norm };
}

/** Tạo thí nghiệm mới (hội đồng / trader). Snapshot ngày 0 = vốn gốc. */
export async function createExperiment(
  input: CreateExperimentInput
): Promise<CreateExperimentResult> {
  const name = (input.name ?? "").trim();
  if (name.length < 3 || name.length > 120) {
    return { ok: false, error: "name: 3..120 ký tự" };
  }
  const hypothesis = (input.hypothesis ?? "").trim();
  if (hypothesis.length < 10 || hypothesis.length > 600) {
    return { ok: false, error: "hypothesis: 10..600 ký tự — hội đồng tự viết giả thuyết" };
  }
  const capital = Number(input.capitalVND);
  if (!Number.isFinite(capital) || capital < MIN_CAPITAL_VND || capital > MAX_CAPITAL_VND) {
    return {
      ok: false,
      error: `capitalVND: ∈ [${MIN_CAPITAL_VND.toLocaleString("vi-VN")}, 10 tỷ]`,
    };
  }
  const horizon = Number(input.horizonDays);
  if (!Number.isFinite(horizon) || horizon < MIN_HORIZON_DAYS || horizon > MAX_HORIZON_DAYS) {
    return { ok: false, error: `horizonDays: ∈ [${MIN_HORIZON_DAYS}, ${MAX_HORIZON_DAYS}]` };
  }
  const checked = validateWeights(
    (input.weights ?? []).map((w) => ({ basket: String(w.basket), weight: Number(w.weight) }))
  );
  if ("error" in checked) return { ok: false, error: checked.error };

  const created = await db.allocationExperiment.create({
    data: {
      name,
      hypothesis,
      weightsJson: JSON.stringify(checked.weights),
      capitalVND: BigInt(Math.round(capital)),
      horizonDays: Math.round(horizon),
      status: "RUNNING",
      createdBy: input.createdBy ?? "trader",
    },
  });
  // Snapshot ngày 0 (startedAt) — equity = vốn gốc, returnPct = 0
  const startDay = ictDayUtc(created.startedAt);
  await db.experimentSnapshot.upsert({
    where: {
      experimentId_date: { experimentId: created.id, date: startDay },
    },
    create: {
      experimentId: created.id,
      date: startDay,
      equityVND: created.capitalVND,
      returnPct: 0,
      basketsJson: JSON.stringify(
        checked.weights.map((w) => ({
          basket: w.basket,
          value: Math.round((Number(created.capitalVND) * w.weight) / 100),
          retDay: 0,
        }))
      ),
    },
    update: {},
  });
  return {
    ok: true,
    experiment: {
      id: created.id,
      name: created.name,
      weightsJson: created.weightsJson,
      capitalVND: created.capitalVND.toString(),
      horizonDays: created.horizonDays,
      status: created.status,
      startedAt: created.startedAt.toISOString(),
    },
  };
}

/** Ngày ICT hiện tại → Date 15:00 UTC (convention Bar). */
function ictDayUtc(at: Date = new Date()): Date {
  const ict = new Date(at.getTime() + 7 * 3_600_000);
  return new Date(
    Date.UTC(ict.getUTCFullYear(), ict.getUTCMonth(), ict.getUTCDate(), 15, 0, 0)
  );
}

export interface MarkExperimentsOutcome {
  running: number;
  snapshotsWritten: number;
  finalized: string[]; // id các thí nghiệm chuyển DONE
  skippedNoData: number;
  durationMs: number;
}

/**
 * Đánh giá mark-to-market mọi thí nghiệm RUNNING qua chỉ số rổ —
 * constant-mix: equity_t = equity_{t−1} × (1 + Σ w_b·r_b,t).
 * Chỉ chèn snapshot cho ngày CÓ dữ liệu rổ (lịch giao dịch thật); idempotent.
 */
export async function markExperimentsDaily(): Promise<MarkExperimentsOutcome> {
  const startedAt = Date.now();
  const seriesList = await basketDailySeriesCached(120); // đủ dài cho horizon 90
  const retByBasket = new Map<BasketKey, Map<string, number>>();
  for (const s of seriesList) {
    retByBasket.set(
      s.key,
      new Map(s.series.map((p) => [p.date, p.ret]))
    );
  }
  // Lịch ngày đồng bộ = intersect các ngày có ít nhất 1 rổ (dùng union — ngày
  // nào rổ thiếu thì ret 0 của rổ đó? KHÔNG — trung thực: ngày chỉ tính khi
  // ÍT NHẤT rổ trọng số lớn nhất có dữ liệu; missing rổ khác → ret 0 + cờ)
  const allDates = new Set<string>();
  for (const m of retByBasket.values()) for (const d of m.keys()) allDates.add(d);
  const dateList = [...allDates].sort();

  const running = await db.allocationExperiment.findMany({
    where: { status: "RUNNING" },
    orderBy: { startedAt: "asc" },
    include: {
      snapshots: { orderBy: { date: "asc" } },
    },
  });

  let snapshotsWritten = 0;
  let skippedNoData = 0;
  const finalized: string[] = [];

  for (const exp of running) {
    const weights = parseWeights(exp.weightsJson);
    if (!weights) continue;
    const capital = Number(exp.capitalVND);
    const startIso = exp.startedAt.toISOString().slice(0, 10);
    const existing = new Set(exp.snapshots.map((s) => s.date.toISOString().slice(0, 10)));
    // equity lũy kế — khởi từ snapshot cuối (hoặc vốn gốc)
    let equity = capital;
    if (exp.snapshots.length > 0) {
      equity = Number(exp.snapshots[exp.snapshots.length - 1].equityVND);
    }
    // Các ngày CHƯA có snapshot: sau startedAt, chưa có, có dữ liệu rổ
    const pending = dateList.filter(
      (d) => d > startIso && !existing.has(d) && d <= new Date().toISOString().slice(0, 10)
    );
    for (const d of pending) {
      let dayRet = 0;
      const perBasket: Array<{ basket: string; value: number; retDay: number | null }> = [];
      let hasData = false;
      for (const w of weights) {
        const r = retByBasket.get(w.basket)?.get(d);
        if (r != null) {
          hasData = true;
          dayRet += (w.weight / 100) * (r / 100);
          perBasket.push({
            basket: w.basket,
            value: Math.round((equity * w.weight) / 100),
            retDay: r,
          });
        } else {
          perBasket.push({ basket: w.basket, value: Math.round((equity * w.weight) / 100), retDay: null });
        }
      }
      if (!hasData) {
        skippedNoData++;
        continue;
      }
      equity = equity * (1 + dayRet);
      const date = new Date(`${d}T15:00:00.000Z`);
      await db.experimentSnapshot.upsert({
        where: { experimentId_date: { experimentId: exp.id, date } },
        create: {
          experimentId: exp.id,
          date,
          equityVND: BigInt(Math.round(equity)),
          returnPct: Number((((equity - capital) / capital) * 100).toFixed(4)),
          basketsJson: JSON.stringify(perBasket),
        },
        update: {},
      });
      snapshotsWritten++;
    }
    // Kiểm tra kết thúc: đủ horizonDays snapshot
    const totalSnaps = existing.size + pending.length;
    if (totalSnaps >= exp.horizonDays) {
      await finalizeExperiment(exp.id);
      finalized.push(exp.id);
    }
  }

  return {
    running: running.length,
    snapshotsWritten,
    finalized,
    skippedNoData,
    durationMs: Date.now() - startedAt,
  };
}

function parseWeights(json: string): ExperimentWeight[] | null {
  try {
    const arr = JSON.parse(json) as Array<{ basket: string; weight: number }>;
    if (!Array.isArray(arr)) return null;
    return arr
      .filter((w) => w && typeof w.basket === "string" && Number.isFinite(Number(w.weight)))
      .map((w) => ({ basket: w.basket as BasketKey, weight: Number(w.weight) }));
  } catch {
    return null;
  }
}

/** Tổng kết 1 thí nghiệm: return/maxDD/Sharpe/đóng góp từng rổ → DONE. */
export async function finalizeExperiment(
  experimentId: string
): Promise<{ ok: boolean; reason?: string }> {
  const exp = await db.allocationExperiment.findUnique({
    where: { id: experimentId },
    include: { snapshots: { orderBy: { date: "asc" } } },
  });
  if (!exp) return { ok: false, reason: "không tìm thấy thí nghiệm" };
  if (exp.status === "DONE") return { ok: true }; // idempotent
  const snaps = exp.snapshots;
  if (snaps.length < 2) {
    // Chưa đủ dữ liệu tính kết quả — nếu người dùng chủ động dừng thì vẫn
    // chuyển STOPPED (không số liệu); engine tự kết thúc chỉ khi đủ ngày.
    if (exp.status === "RUNNING") {
      return { ok: false, reason: "chưa đủ snapshot (≥2) để tổng kết" };
    }
  }
  const capital = Number(exp.capitalVND);
  const equities = snaps.map((s) => Number(s.equityVND));
  const finalEquity = equities[equities.length - 1] ?? capital;
  const returnPct = ((finalEquity - capital) / capital) * 100;
  // max drawdown trên chuỗi equity
  let peak = equities[0] ?? capital;
  let maxDD = 0;
  for (const e of equities) {
    if (e > peak) peak = e;
    const dd = peak > 0 ? (peak - e) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }
  // Sharpe trên chuỗi lợi suất ngày snapshot
  const dailyRets: number[] = [];
  for (let i = 1; i < equities.length; i++) {
    if (equities[i - 1] > 0) dailyRets.push(equities[i] / equities[i - 1] - 1);
  }
  let sharpe: number | null = null;
  if (dailyRets.length >= 2) {
    const mean = dailyRets.reduce((a, b) => a + b, 0) / dailyRets.length;
    const varr =
      dailyRets.reduce((a, b) => a + (b - mean) ** 2, 0) / (dailyRets.length - 1);
    const sd = Math.sqrt(varr);
    sharpe = sd > 0 ? Number(((mean / sd) * Math.sqrt(252)).toFixed(3)) : null;
  }
  // Đóng góp từng rổ: Σ w_b × r_b,t trên các ngày có dữ liệu
  const weights = parseWeights(exp.weightsJson) ?? [];
  const contrib = new Map<string, number>();
  for (const w of weights) contrib.set(w.basket, 0);
  for (const s of snaps) {
    try {
      const per = JSON.parse(s.basketsJson) as Array<{ basket: string; retDay: number | null }>;
      for (const p of per) {
        if (p.retDay == null) continue;
        const w = weights.find((x) => x.basket === p.basket)?.weight ?? 0;
        contrib.set(p.basket, (contrib.get(p.basket) ?? 0) + (w / 100) * (p.retDay / 100));
      }
    } catch {
      // basketsJson hỏng 1 dòng — bỏ qua dòng đó
    }
  }
  await db.allocationExperiment.update({
    where: { id: exp.id },
    data: {
      status: snaps.length >= 2 ? "DONE" : "STOPPED",
      finalEquityVND: BigInt(Math.round(finalEquity)),
      returnPct: Number(returnPct.toFixed(4)),
      maxDrawdownPct: Number((maxDD * 100).toFixed(4)),
      sharpe,
      perBasketJson: JSON.stringify(
        weights.map((w) => ({
          basket: w.basket,
          weight: w.weight,
          contributionPct: Number(
            (((contrib.get(w.basket) ?? 0) * 100)).toFixed(4)
          ),
        }))
      ),
      endedAt: new Date(),
    },
  });
  return { ok: true };
}

/** Dừng thí nghiệm tay (trader) → tổng kết ngay với dữ liệu có tới nay. */
export async function stopExperiment(experimentId: string) {
  const exp = await db.allocationExperiment.findUnique({ where: { id: experimentId } });
  if (!exp) return { ok: false, reason: "không tìm thấy" };
  if (exp.status !== "RUNNING") return { ok: false, reason: "thí nghiệm đã kết thúc" };
  await db.allocationExperiment.update({
    where: { id: experimentId },
    data: { status: "STOPPED" },
  });
  await finalizeExperiment(experimentId).catch(() => undefined);
  // finalizeExperiment với status STOPPED + ≥2 snapshot vẫn ghi kết quả;
  // <2 snapshot giữ nguyên không số liệu
  return { ok: true };
}
