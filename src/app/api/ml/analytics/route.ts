import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";
import { BANDIT_ARM_CODES } from "@/lib/ml/bandit";
import { ROSTER_BY_CODE } from "@/lib/agent-roster";
import { loadSegmentBaskets } from "@/lib/ml/features";
import { REGIME_LABELS, type MarketRegime } from "@/lib/quant/regime";
import {
  buildArmAnalytics,
  buildDatedBasketIndex,
  brierDecomposition,
  calibrationBuckets,
  posteriorTrajectory,
  regimeAt,
  regimeTimeline,
  REGIME_ORDER,
  type AnalyticsArm,
  type AnalyticsPayload,
  type ArmBrier,
  type ArmTrajectory,
  type BrierEntry,
  type RegimeCell,
  type RegimeTable,
} from "@/lib/ml/analytics";

export const dynamic = "force-dynamic";

/**
 * GET /api/ml/analytics (A2 — ML_OPS_BLUEPRINT v1.1 §3) — kiểm định thống kê
 * vòng học bandit: Wilson 95% CI từng arm · Brier Murphy decomposition +
 * calibration 5 bucket · posterior trajectory · bảng agent × regime.
 * Thuần truy vấn (0 LLM · 0 ghi DB — KHÔNG ensureArms: 6 arm do settle/
 * scorecard đảm nhiệm; arm thiếu → trả dòng default Beta(1,1) pulls=0).
 *
 * Semantics outcome (nhị phân hoá cho Brier/calibration — xem analytics.ts):
 *   o = reward != null && reward >= 0.5 ? 1 : 0  (FLAT khớp 0,7 ≥ 0,5 = đúng)
 *   p = BanditEvent.confidence (độ tin cậy khai báo lúc cast — B8 đã lưu)
 * Hit-rate arm GIỮ mean reward (wins/pulls — FLAT 0,7/0,2 — như scorecard B8).
 *
 * BanditEvent chưa có settle nào → payload TRUNG THỰC RỖNG: đủ 6 arm với
 * pulls=0, mọi metric null + insufficient, totalSettled=0 (UI tự hiển thị
 * empty-state, không hiện số 0 gây hiểu lầm).
 *
 * TTL cache 15s module-level theo pattern bandit.ts snapCache (#64): dữ
 * liệu chỉ đổi khi settle chạy (từ A1: lịch 16:15 ICT hằng ngày) — poll UI
 * 30s/lần được cache hấp thụ một nửa.
 */

/** TTL cache 15s — pattern bandit.ts #64 (settle mới nhất lâu nhất trễ 15s). */
const CACHE_TTL_MS = 15_000;
let cache: { at: number; value: AnalyticsPayload } | null = null;

/** Số phiên nạp cho basket regime — cùng BARS_PER_SYMBOL của evidence.ts (:79). */
const REGIME_SESSIONS = 260;
/** Cửa sổ lịch nạp bar regime — cùng công thức loadSegmentBaskets (features.ts:610). */
const REGIME_CUTOFF_DAYS = 420;

export async function GET() {
  try {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
      return NextResponse.json(toPlain(cache.value));
    }
    const value = await buildAnalyticsPayload();
    cache = { at: Date.now(), value };
    return NextResponse.json(toPlain(value));
  } catch (err) {
    console.error("[api/ml/analytics] GET failed:", err);
    return NextResponse.json(
      { error: "Không đọc được phân tích hiệu năng vòng học bandit." },
      { status: 500 }
    );
  }
}

/** Nạp dữ liệu + tính toàn bộ payload A2 (chỉ SELECT — 0 ghi DB). */
async function buildAnalyticsPayload(): Promise<AnalyticsPayload> {
  // 2 query parallel: 6 arm + toàn bộ event đã settle (chỉ trường cần).
  const [armRows, eventRows] = await Promise.all([
    db.banditArm.findMany({
      where: { agentCode: { in: [...BANDIT_ARM_CODES] } },
    }),
    db.banditEvent.findMany({
      where: { settledAt: { not: null } },
      select: {
        agentCode: true,
        castAt: true,
        settledAt: true,
        reward: true,
        confidence: true,
      },
      orderBy: { settledAt: "asc" },
    }),
  ]);

  // Event hợp lệ = đã settle + có reward (settle luôn ghi cả hai; phòng dòng lệch)
  const events = eventRows.filter(
    (e): e is {
      agentCode: string;
      castAt: Date;
      settledAt: Date;
      reward: number;
      confidence: number | null;
    } => e.reward != null && Number.isFinite(e.reward)
  );

  const armByCode = new Map(armRows.map((a) => [a.agentCode, a]));

  /* ── 1. Per-arm: posterior + hit-rate + Wilson (thuần — analytics.ts) ── */
  const arms: AnalyticsArm[] = [...BANDIT_ARM_CODES].map((code) => {
    const row = armByCode.get(code);
    const base = buildArmAnalytics({
      agentCode: code,
      alpha: row?.alpha,
      beta: row?.beta,
      pulls: row?.pulls,
      wins: row?.wins,
    });
    return { ...base, name: ROSTER_BY_CODE.get(code)?.name ?? code };
  });

  /* ── 2. Brier (nhị phân hoá o = reward ≥ 0,5 · p = confidence) ─────── */
  // Lựa chọn nhị phân hoá: reward Thompson sampling không nhị phân (FLAT
  // 0,7/0,2) — Murphy decomposition/calibration chuẩn nhị phân nên quy o
  // = reward ≥ 0,5 ? 1 : 0 (cùng ngưỡng "kể như đúng" của streak B8).
  const entriesByCode = new Map<string, BrierEntry[]>(
    [...BANDIT_ARM_CODES].map((c) => [c, [] as BrierEntry[]])
  );
  const allEntries: BrierEntry[] = [];
  for (const e of events) {
    if (e.confidence == null || !Number.isFinite(e.confidence)) continue;
    const p = Math.max(0, Math.min(1, e.confidence));
    const o = e.reward >= 0.5 ? 1 : 0;
    const entry: BrierEntry = { p, o };
    allEntries.push(entry);
    entriesByCode.get(e.agentCode)?.push(entry);
  }

  const brierArms: ArmBrier[] = arms.map((a) => {
    const entries = entriesByCode.get(a.code) ?? [];
    const brier =
      entries.length > 0
        ? entries.reduce((s, x) => s + (x.p - x.o) * (x.p - x.o), 0) / entries.length
        : null;
    return {
      code: a.code,
      brier: brier == null ? null : round4(brier),
      n: entries.length,
    };
  });

  const overallBrier =
    allEntries.length > 0
      ? round4(
          allEntries.reduce((s, x) => s + (x.p - x.o) * (x.p - x.o), 0) /
            allEntries.length
        )
      : null;

  const decomposition = brierDecomposition(allEntries);

  /* ── 3. Calibration 5 bucket (luôn đủ 5 dòng — n=0 → null) ─────────── */
  const calibration = calibrationBuckets(allEntries);

  /* ── 4. Posterior trajectory theo timeline settle từng arm ─────────── */
  const trajectory: ArmTrajectory[] = arms.map((a) => ({
    code: a.code,
    name: a.name,
    points: posteriorTrajectory(
      events
        .filter((e) => e.agentCode === a.code)
        .map((e) => ({ settledAt: e.settledAt, reward: e.reward }))
    ),
  }));

  /* ── 5. Bảng agent × regime — regime tại PHIÊN CAST (PIT) ──────────── */
  // Nguồn regime: CÙNG caller hiện có (bayes/evidence.ts:189-205) — rổ
  // top-10 HOSE-STOCK theo ADTV 20 phiên từ loadSegmentBaskets, basket index
  // equal-weight → classifyRegime. Basket không kèm ngày → nạp lại bar CÓ
  // NGÀY cho đúng 10 instrumentId đó (chỉ SELECT).
  const regimeTable = await buildRegimeTable(events);

  return {
    ok: true as const,
    generatedAt: new Date().toISOString(),
    arms,
    brier: { overall: overallBrier, decomposition, arms: brierArms },
    calibration,
    trajectory,
    regimeTable,
    totalSettled: events.length,
  };
}

/** Bảng agent × regime: hit-rate từng arm trong 4 chế độ tại thời điểm cast. */
async function buildRegimeTable(
  events: { agentCode: string; castAt: Date; reward: number }[]
): Promise<RegimeTable> {
  const emptyCell = (): RegimeCell => ({ hitRate: null, n: 0, insufficient: true });
  const emptyRow = (code: string) => ({
    code,
    name: ROSTER_BY_CODE.get(code)?.name ?? code,
    cells: {
      BULL_TREND: emptyCell(),
      BEAR_TREND: emptyCell(),
      SIDEWAYS: emptyCell(),
      VOLATILE: emptyCell(),
    } satisfies Record<MarketRegime, RegimeCell>,
  });
  const base: RegimeTable = {
    regimes: REGIME_ORDER,
    labels: { ...REGIME_LABELS },
    rows: [...BANDIT_ARM_CODES].map(emptyRow),
    available: false,
  };

  if (events.length === 0) return base; // trung thực rỗng — khỏi chạm basket

  // Fail-soft: lỗi nạp basket → bảng rỗng + available=false (UI ghi chú).
  let timeline: Map<string, MarketRegime>;
  let sortedDates: Date[];
  try {
    const baskets = await loadSegmentBaskets(REGIME_SESSIONS);
    const hose = baskets.find((b) => b.segment === "VN-HOSE-STOCK");
    const ids = hose?.symbols.map((s) => s.instrumentId) ?? [];
    if (ids.length === 0) return base;
    const cutoff = new Date(Date.now() - REGIME_CUTOFF_DAYS * 86_400_000);
    const bars = await db.bar.findMany({
      where: { instrumentId: { in: ids }, date: { gte: cutoff } },
      orderBy: [{ instrumentId: "asc" }, { date: "asc" }],
      select: { instrumentId: true, date: true, close: true },
    });
    const seriesById = new Map<string, { date: Date; close: number }[]>();
    for (const b of bars) {
      if (!(b.close > 0)) continue;
      const list = seriesById.get(b.instrumentId) ?? [];
      list.push({ date: b.date, close: b.close });
      seriesById.set(b.instrumentId, list);
    }
    const basketIndex = buildDatedBasketIndex([...seriesById.values()]);
    if (basketIndex.length === 0) return base;
    timeline = regimeTimeline(basketIndex);
    sortedDates = basketIndex.map((p) => p.date);
  } catch (err) {
    console.error("[api/ml/analytics] regime basket load failed:", err);
    return base;
  }

  // Gom (arm × regime) → n + Σreward
  const sumReward = new Map<string, number>();
  const counts = new Map<string, number>();
  let matched = 0;
  for (const e of events) {
    const regime = regimeAt(timeline, sortedDates, e.castAt);
    if (regime == null) continue; // cast trước mọi phiên bar — bỏ (không xảy ra thực tế)
    matched++;
    const key = `${e.agentCode}:${regime}`;
    sumReward.set(key, (sumReward.get(key) ?? 0) + e.reward);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (matched === 0) return base;

  const rows = base.rows.map((row) => ({
    ...row,
    cells: Object.fromEntries(
      REGIME_ORDER.map((regime) => {
        const n = counts.get(`${row.code}:${regime}`) ?? 0;
        const sum = sumReward.get(`${row.code}:${regime}`) ?? 0;
        const cell: RegimeCell = {
          hitRate: n > 0 ? round4(sum / n) : null,
          n,
          insufficient: n < 30,
        };
        return [regime, cell];
      })
    ) as Record<MarketRegime, RegimeCell>,
  }));
  return { ...base, rows, available: true };
}

/** Làm tròn 4 chữ số — pattern scorecard.ts. */
function round4(n: number): number {
  return Number(n.toFixed(4));
}
