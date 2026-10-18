/**
 * src/lib/risk/engine.ts — CRB-0 · RISK QUANT ENGINE (ORCHESTRATOR) +
 * CRB-7 · BAYESIAN LIMIT-LEARNING (CONTROL_RISK_QUANT_BLUEPRINT v1.1 — phiên #51).
 *
 * Chạy TRƯỚC đợt C trong chu kỳ 23 agents (§2):
 *   1. Nạp danh mục thật (Position × quote + BrokerAccount F-102) + bar EOD
 *      từng mã; danh mục rỗng / NAV ≤ 0 / < 60 phiên chung → PROXY MODE:
 *      rổ top-10 thanh khoản HOSE (§0.4 — không bịa dữ liệu, ghi proxyMode).
 *   2. CRB-1  EWMA σ + hạn mức động hai chiều [0,6 · 1,15] (chốt user #50 Q2).
 *   3. CRB-7  Beta-Bernoulli limit-learning per giới hạn {sector, position,
 *      dd, dailyLoss} — prior Beta(1,99), hợp nhất min(volMult, mult_ℓ):
 *      nới CHỈ đến từ volMult, Bayesian luôn một chiều siết (floor 0,75×).
 *   4. CRB-2  HS-VaR/CVaR 95 (empirical, ×√5) · CRB-3 MC bootstrap 5.000 path.
 *   5. CRB-4  HHI ngành/vị thế + N_eff · CRB-5 tương quan + N_eff_bets
 *      (chế độ danh mục thật; proxy mode bỏ qua — không tô đỏ số liệu rỗng).
 *   6. CRB-8  CUSUM + EWMA chart trên NAV snapshot theo NGÀY (≥ 60 ngày —
 *      PHA 1 thiếu → rổ proxy, ghi rõ nguồn) · CRB-6 logistic P(vi phạm)
 *      train trên rổ proxy (PHA 1 — chốt user #50 Q3), AUC ≥ 0,55 mới serving.
 *   7. Persist RiskQuantSnapshot + RiskAlert (dedupe 24h theo code) + cập
 *      nhật Beta CRB-7 vào AppSetting "risk-quant-limits".
 *
 * VETO vẫn là luật cứng (§0.1): engine chỉ ĐO + CẢNH BÁO + điều chỉnh hạn
 * mức động cho exposure A7 (ngữ nghĩa điều kiện VETO giữ nguyên — §0.3).
 * Bằng chứng quant vào Bayes đúng MỘT lần với source riêng (T7.5 — §0.6).
 *
 * Deterministic, thuần TS, 0 dependency mới — ngân sách ≤ 1,5s/chu kỳ (§10).
 */

import { db } from "@/lib/db";
import { ROSTER_BY_CODE } from "@/lib/agent-roster";
import { loadTopSeries } from "@/lib/ml/features";
import { returnsDated } from "@/lib/dated-series";
import { buildBasket } from "@/lib/ml/rl";
import type { BayesEvidence } from "@/lib/bayes/types";
import {
  computeVolatility,
  ewmaSigmaSeries,
  median,
  MULT_FLOOR,
  MULT_CEILING,
  type VolatilityResult,
} from "@/lib/risk/volatility";
import {
  hsVarCvar,
  monteCarloStress,
  crossCheckMcVsHs,
  type TailResult,
  type McResult,
} from "@/lib/risk/tail";
import {
  computeConcentration,
  computeCorrelation,
  type ConcentrationResult,
  type CorrelationResult,
  type DatedReturn,
} from "@/lib/risk/concentration";
import {
  trainBreachLogit,
  predictBreach,
  breachOddsLr,
  computeDrift,
  type BreachLogitModel,
  type DriftResult,
} from "@/lib/risk/forecast";
import type { CouncilArm } from "@/lib/risk/sizing";

/* ─────────────────── CRB-7 · AppSetting risk-quant-limits ─────────────────── */

export const RISK_QUANT_SETTING_KEY = "risk-quant-limits";

/** Posterior Beta một giới hạn (α/beta là SỐ LẦN VI PHẠM/không vi phạm). */
export interface LimitBeta {
  alpha: number;
  beta: number;
}

export interface RiskQuantLimitsSetting {
  sector: LimitBeta;
  position: LimitBeta;
  dd: LimitBeta;
  dailyLoss: LimitBeta;
}

/** Prior Beta(1,99) — base 1%, khiêm tốn (chốt thiết kế §5 CRB-7). */
const DEFAULT_LIMITS: RiskQuantLimitsSetting = {
  sector: { alpha: 1, beta: 99 },
  position: { alpha: 1, beta: 99 },
  dd: { alpha: 1, beta: 99 },
  dailyLoss: { alpha: 1, beta: 99 },
};

/** Cache in-process 60s — pattern consensus.ts. */
let limitsCache: { value: RiskQuantLimitsSetting; at: number } | null = null;

function parseLimits(raw: string | null | undefined): RiskQuantLimitsSetting {
  if (!raw) return DEFAULT_LIMITS;
  try {
    const p = JSON.parse(raw) as Partial<RiskQuantLimitsSetting>;
    const num = (v: unknown): number =>
      typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : -1;
    const one = (v: unknown, d: LimitBeta): LimitBeta => {
      const o = (v ?? {}) as Partial<LimitBeta>;
      const a = num(o.alpha);
      const b = num(o.beta);
      return a >= 0 && b >= 0 ? { alpha: a, beta: b } : d;
    };
    return {
      sector: one(p.sector, DEFAULT_LIMITS.sector),
      position: one(p.position, DEFAULT_LIMITS.position),
      dd: one(p.dd, DEFAULT_LIMITS.dd),
      dailyLoss: one(p.dailyLoss, DEFAULT_LIMITS.dailyLoss),
    };
  } catch {
    return DEFAULT_LIMITS;
  }
}

/** Đọc Beta per-limit (fallback prior mặc định khi AppSetting lỗi/missing). */
export async function getRiskQuantLimits(): Promise<RiskQuantLimitsSetting> {
  if (limitsCache && Date.now() - limitsCache.at < 60_000) return limitsCache.value;
  let value = DEFAULT_LIMITS;
  try {
    const row = await db.appSetting.findUnique({ where: { key: RISK_QUANT_SETTING_KEY } });
    value = parseLimits(row?.value);
  } catch {
    // AppSetting hỏng → prior mặc định (an toàn)
  }
  limitsCache = { value, at: Date.now() };
  return value;
}

/** Ghi Beta per-limit + làm mới cache. */
async function saveRiskQuantLimits(next: RiskQuantLimitsSetting): Promise<void> {
  await db.appSetting.upsert({
    where: { key: RISK_QUANT_SETTING_KEY },
    update: { value: JSON.stringify(next), updatedAt: new Date() },
    create: { key: RISK_QUANT_SETTING_KEY, value: JSON.stringify(next) },
  });
  limitsCache = { value: next, at: Date.now() };
}

/** Nút reset thủ công (nghiệm thu CRB-7.4) — ghi AuditLog minh bạch. */
export async function resetRiskQuantLimits(): Promise<void> {
  await saveRiskQuantLimits(DEFAULT_LIMITS);
  await db.auditLog.create({
    data: {
      action: "RISK_QUANT_LIMITS_RESET",
      entity: "AppSetting",
      entityId: RISK_QUANT_SETTING_KEY,
      before: null,
      after: JSON.stringify(DEFAULT_LIMITS),
    },
  });
}

/**
 * Fixbug #52-F5 — trạng thái 4 giới hạn CRB-7 cho UI Cài đặt (GET
 * /api/settings): posterior Beta + hệ số siết một chiều từng giới hạn.
 */
export async function getRiskQuantLimitsStatus(): Promise<
  Record<"sector" | "position" | "dd" | "dailyLoss", LimitStatus>
> {
  const limits = await getRiskQuantLimits();
  return {
    sector: { ...limits.sector, posteriorMean: posteriorMean(limits.sector), mult: tighteningMult(limits.sector) },
    position: { ...limits.position, posteriorMean: posteriorMean(limits.position), mult: tighteningMult(limits.position) },
    dd: { ...limits.dd, posteriorMean: posteriorMean(limits.dd), mult: tighteningMult(limits.dd) },
    dailyLoss: { ...limits.dailyLoss, posteriorMean: posteriorMean(limits.dailyLoss), mult: tighteningMult(limits.dailyLoss) },
  };
}

/** posteriorMean = (α+1)/(α+β+2) — cùng pattern bandit.ts. */
function posteriorMean(b: LimitBeta): number {
  return (b.alpha + 1) / (b.alpha + b.beta + 2);
}

/** mult_ℓ = 1 − 0,5·max(0, mean − 0,05), floor 0,75 — MỘT CHIỀU SIẾT. */
function tighteningMult(b: LimitBeta): number {
  return Math.max(0.75, 1 - 0.5 * Math.max(0, posteriorMean(b) - 0.05));
}

/* ─────────────────── Kết quả engine ─────────────────── */

/** Tình trạng 1 giới hạn sau CRB-7. */
export interface LimitStatus {
  alpha: number;
  beta: number;
  posteriorMean: number;
  mult: number;
}

export interface RiskQuantAlertDraft {
  severity: "INFO" | "WARNING" | "CRITICAL";
  code: string;
  message: string;
  metricKey?: string;
  metricValue?: number;
  threshold?: number;
}

/** Kết quả đầy đủ của một lần chạy engine (đầu vào cho đợt C + Bayes + UI). */
export interface RiskQuantResult {
  ok: boolean;
  /** true = tính trên rổ top-10 proxy (danh mục rỗng/thiếu dữ liệu — §0.4). */
  proxyMode: boolean;
  nav: number;
  /** CRB-1. */
  vol: VolatilityResult;
  /** Hạn mức động sau hợp nhất min(volMult, mult_ℓ) (% NAV). */
  dynMaxPositionPct: number;
  dynMaxSectorPct: number;
  staticMaxPositionPct: number;
  staticMaxSectorPct: number;
  /** CRB-7 per-limit. */
  limits: Record<"sector" | "position" | "dd" | "dailyLoss", LimitStatus>;
  /** CRB-2/3. */
  tail: TailResult;
  mc: McResult;
  /** Sai lệch đối chiếu chéo |MC-VaR − HS-VaR|/HS-VaR (> 0,20 → log review). */
  mcCrossGap: number;
  /** CRB-4/5 — null ở proxy mode (không bịa số liệu phơi nhiễm). */
  conc: ConcentrationResult | null;
  corr: CorrelationResult | null;
  /** CRB-8. */
  drift: DriftResult;
  /** Nguồn chuỗi NAV cho CUSUM (PHA 1: snapshot-theo-ngày ≥ 60 hoặc proxy). */
  navSeriesSource: "snapshot-daily" | "basket-proxy" | "none";
  /** CRB-6 — null khi AUC < 0,55 (không serving — trung thực). */
  pBreach: number | null;
  logit: {
    auc: number;
    served: boolean;
    trainSamples: number;
    valSamples: number;
    baseRate: number;
    modelVersion: string;
  };
  /** Vi phạm của CHU KỲ NÀY (đã cập nhật vào Beta CRB-7). */
  breaches: {
    sector: boolean;
    position: boolean;
    dd: boolean;
    /** null = không đủ dữ liệu để đo (kiểu abstain — không tăng β giả). */
    dailyLoss: boolean | null;
  };
  /** Cảnh báo sẽ persist (sau dedupe 24h — bản nháp TRƯỚC dedupe). */
  alerts: RiskQuantAlertDraft[];
  /** Bằng chứng Bayes (T7.5 — source quant-tail:/quant-drift: riêng biệt). */
  evidence: BayesEvidence[];
  /** Dòng prompt cho risk-manager A6 (khối QUANT — §3 "Điểm nối"). */
  promptLines: string[];
  /** Posterior bandit các arm (route dùng cho Kelly CRB-9 sau khi có tín hiệu). */
  arms: CouncilArm[];
  /** id dòng RiskQuantSnapshot đã persist (route update kellyHint sau). */
  snapshotId: string | null;
  /** Ghi chú minh bạch cho UI + log. */
  notes: string[];
  durationMs: number;
}

/* ─────────────────── Tiện ích nội bộ ─────────────────── */

const vnd = (n: number): string => Math.round(Math.max(0, n)).toLocaleString("vi-VN");
const pct1 = (n: number): string => `${n.toFixed(1).replace(".", ",")}%`;
const pct2 = (n: number): string => `${n.toFixed(2).replace(".", ",")}%`;
/** Số phiên tối thiểu để tin chuỗi danh mục thật. */
const MIN_REAL_SESSIONS = 60;
/** Cửa sổ rổ proxy cho CRB-6/8 (phiên). */
const BASKET_WINDOW = 500;
/** Số chuỗi NAV snapshot đọc tối đa. */
const NAV_SNAPSHOT_LIMIT = 400;

/** Return đơn giản từ chuỗi close (Float64Array, độ dài = n−1). */
function closeToReturns(closes: number[]): Float64Array {
  const n = closes.length;
  const out = new Float64Array(Math.max(0, n - 1));
  for (let i = 1; i < n; i++) {
    out[i - 1] = closes[i - 1] > 0 ? closes[i] / closes[i - 1] - 1 : 0;
  }
  return out;
}

/** RSI14 Wilder chuỗi (đủ warmup) — cho đặc trưng x2 của CRB-6. */
function rsiSeries(closes: number[]): (number | null)[] {
  const n = closes.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n < 15) return out;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= 14; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d;
    else losses -= d;
  }
  let avgGain = gains / 14;
  let avgLoss = losses / 14;
  for (let i = 14; i < n; i++) {
    if (i > 14) {
      const d = closes[i] - closes[i - 1];
      avgGain = (avgGain * 13 + Math.max(d, 0)) / 14;
      avgLoss = (avgLoss * 13 + Math.max(-d, 0)) / 14;
    }
    if (avgGain === 0 && avgLoss === 0) out[i] = null;
    else if (avgLoss === 0) out[i] = 100;
    else out[i] = 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/** Đặc trưng CRB-6 tại chỉ số t của rổ (KHÔNG lookahead — chỉ quá khứ ≤ t). */
function basketFeatureAt(
  t: number,
  basketCloses: number[],
  sigmaSeries: Float64Array,
  rsi: (number | null)[]
): number[] | null {
  if (t < 60 || t >= basketCloses.length) return null;
  // Fixbug #52-F7: hệ đánh dấu lệch 1 — sigmaSeries[i] là σ sau return
  // closes[i]→closes[i+1] (biết tới close i+1). Tính năng tại close t phải
  // dùng sigmaSeries[t−1] (biết tới close t): (a) không lookahead return
  // t→t+1 vốn nằm TRONG cửa sổ nhãn; (b) serving t = lastIndex tránh
  // sigmaSeries[t] = undefined → NaN → pBreach null dù AUC đạt cổng (bug
  // ngủ chỉ tỉnh khi F6 làm rổ ổn định đưa AUC 62,6% ≥ 55% lần đầu).
  const sigIdx = t - 1; // hợp lệ vì t ≥ 60
  // x1 volZ = (σ20 − volRef250)/volRef250 — volRef = median σ 250 phiên đến t
  const refWin = sigmaSeries.subarray(Math.max(0, sigIdx - 249), sigIdx + 1);
  const volRef = median(refWin);
  const sigmaNow = sigmaSeries[sigIdx];
  const x1 = volRef > 1e-12 ? (sigmaNow - volRef) / volRef : 0;
  // x2 rsiBucket (0..3)/3
  const r = rsi[t];
  const bucket = r == null ? 2 : r < 30 ? 0 : r < 50 ? 1 : r < 70 ? 2 : 3;
  const x2 = bucket / 3;
  // x3 mom5 = tanh(ret 5 phiên)
  const mom5 =
    basketCloses[t - 5] > 0 ? basketCloses[t] / basketCloses[t - 5] - 1 : 0;
  const x3 = Math.tanh(mom5);
  // x5 dd(t)/0,15 — drawdown rổ so đỉnh 60 phiên tới t
  let peak = basketCloses[t - 59];
  for (let j = t - 58; j <= t; j++) if (basketCloses[j] > peak) peak = basketCloses[j];
  const dd = peak > 0 ? Math.max(0, 1 - basketCloses[t] / peak) : 0;
  const x5 = dd / 0.15;
  // x8 volRatio20/60 = σ EWMA hiện tại / σ trung bình 60 phiên
  const mean60 =
    sigmaSeries.subarray(Math.max(0, sigIdx - 59), sigIdx + 1).reduce((s, v) => s + v, 0) /
    Math.min(60, sigIdx + 1);
  const x8 = mean60 > 1e-12 ? sigmaNow / mean60 - 1 : 0;
  return [x1, x2, x3, 0, x5, 0, 0, x8]; // x4/x6/x7 = trạng thái hiện tại (điền khi serving)
}

/* ─────────────────── ENGINE CHÍNH ─────────────────── */

/**
 * CRB-0 — chạy toàn bộ quant engine cho chu kỳ. KHÔNG bao giờ ném lỗi ra
 * ngoài — lỗi toàn bộ → ok:false + limits tĩnh (mult = 1), chu kỳ tiếp tục
 * như trước khi có engine (fail-safe §0.1: VETO vẫn là luật cứng, quant chỉ
 * đo). Phiếu bầu cử tri KHÔNG cần ở đây — Kelly CRB-9 tính ở route sau khi
 * Chủ tịch ra tín hiệu (cần target/stop) bằng arms trả kèm kết quả này.
 */
export async function runRiskQuantEngine(): Promise<RiskQuantResult> {
  const startedAt = Date.now();
  const notes: string[] = [];
  const alerts: RiskQuantAlertDraft[] = [];

  /* ── 0. Hạn mức tĩnh từ roster config (AUD-CODE #15 — một nguồn sự thật) ── */
  const exposureCfg = ROSTER_BY_CODE.get("exposure")?.config as
    | { maxSectorWeightPct?: number; maxPositionPct?: number }
    | undefined;
  const riskCfg = ROSTER_BY_CODE.get("risk-manager")?.config as
    | {
        maxDrawdownPct?: number;
        maxSectorWeightPct?: number;
        maxPositionPct?: number;
        dailyLossLimitVnd?: number;
      }
    | undefined;
  const staticMaxSectorPct = exposureCfg?.maxSectorWeightPct ?? riskCfg?.maxSectorWeightPct ?? 40;
  const staticMaxPositionPct = exposureCfg?.maxPositionPct ?? riskCfg?.maxPositionPct ?? 25;
  const ddThresholdPct = riskCfg?.maxDrawdownPct ?? 15;
  const dailyLossLimitVnd = riskCfg?.dailyLossLimitVnd ?? 50_000_000;

  /* ── 1. Nạp danh mục + chuỗi NAV snapshot + bandit + rổ proxy ───────── */
  // Ngân sách §10 ≤ 1,5s: (a) bar vị thế cắt cửa sổ ~420 ngày (≈ 260 phiên);
  // (b) banditArm đọc TRỰC TIẾP (1 query — tránh ensureArms 6 upsert +
  // aggregate của banditSnapshot; arm thiếu → Kelly trung tính p=0,5 —
  // các agent ml khác đã ensureArms trong chu kỳ); (c) rổ proxy top-10
  // cắt sinceDays 800 (~500 phiên — đủ train CRB-6, đừa 30k dòng full-history).
  const posBarCutoff = new Date(Date.now() - 420 * 86_400_000);
  // AUDIT 137 C1 — world-context paper: P0 quarantine §5.1 — engine phải đo
  // THẾ GIỚI PAPER, không gộp vị thế sandbox (positions mọi tài khoản + cash
  // 1 tài khoản tuỳ ý → NAV/VaR/HHI/ngưỡng VETO chạy trên danh mục sandbox).
  // Nạp tài khoản paper TRƯỚC (accountType != sandbox, orderBy cố định như
  // orders/portfolio route); hết tài khoản paper → 0 vị thế (thế giới trống →
  // proxy mode như thiết kế §0.4), KHÔNG lọt sandbox.
  const account = await db.brokerAccount
    .findFirst({
      where: { deletedAt: null, accountType: { not: "sandbox" } },
      orderBy: { createdAt: "asc" },
      select: { id: true, cashBalance: true, marginUsed: true },
    })
    .catch(() => null);
  const [positionRows, snapshotRows, limitsBefore, banditArms] = await Promise.all([
    db.position
      .findMany({
        where: { status: "OPEN", brokerAccountId: account?.id ?? "__no_paper_account__" },
        select: {
          quantity: true,
          avgPrice: true,
          instrumentId: true,
          instrument: {
            select: {
              symbol: true,
              sector: true,
              quotes: { orderBy: { tradedAt: "desc" }, take: 1, select: { last: true } },
            },
          },
        },
      })
      .catch(() => []),
    db.riskQuantSnapshot
      .findMany({
        orderBy: { createdAt: "desc" },
        take: NAV_SNAPSHOT_LIMIT,
        select: { nav: true, createdAt: true },
      })
      .catch(() => []),
    getRiskQuantLimits(),
    db.banditArm.findMany({ select: { agentCode: true, alpha: true, beta: true } }).catch(() => []),
  ]);

  const arms: CouncilArm[] = banditArms.map((a) => ({
    agentCode: a.agentCode,
    // Trọng số đồng thuận B9 = clamp(health×posterior, 0,3, 1) — engine không
    // có health từng agent lúc này; alignedCouncilP tự clamp [0,3 · 1] → dùng
    // trọng số posteriorMean làm xấp xỉ khiêm tốn (Kelly chỉ tham mưu).
    weight: Math.max(0.3, Math.min(1, (a.alpha + 1) / (a.alpha + a.beta + 2))),
    posteriorMean: (a.alpha + 1) / (a.alpha + a.beta + 2),
  }));

  // MV mỗi vị thế theo quote mới nhất (đúng nguồn portfolioSnapshot F-102)
  const positions = positionRows.map((p) => {
    const last = p.instrument.quotes[0]?.last ?? p.avgPrice;
    return {
      symbol: p.instrument.symbol,
      sector: p.instrument.sector ?? "Khác",
      instrumentId: p.instrumentId,
      mv: last * p.quantity,
    };
  });
  const positionsMv = positions.reduce((s, p) => s + p.mv, 0);
  const cash = account ? Number(account.cashBalance) : 0;
  const nav = cash + positionsMv;

  // Chuỗi NAV theo NGÀY (mỗi ngày lấy snapshot cuối — CUSUM ý nghĩa daily)
  const navByDay = new Map<string, number>();
  for (const row of [...snapshotRows].reverse()) {
    navByDay.set(row.createdAt.toISOString().slice(0, 10), Number(row.nav));
  }
  const navDaily = [...navByDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => v);
  const navReturns = closeToReturns(navDaily);

  /* ── 2. Chuỗi return danh mục: THẬT hoặc PROXY ─────────────────────── */
  // Fixbug #59: khởi tạo rỗng — TS strict không suy luận được mọi nhánh gán
  // (realOk∧đủ phiên → gán · proxyMode → gán rổ) đều chạy trước khi đọc;
  // runtime an toàn nhưng compile-error che mất lỗi mới của phiên sau.
  let portReturns: Float64Array = new Float64Array(0);
  let proxyMode = false;
  let symbolProxies = 0;

  const instrumentIds = positions.map((p) => p.instrumentId);
  const barRows =
    instrumentIds.length > 0
      ? await db.bar
          .findMany({
            where: { instrumentId: { in: instrumentIds }, date: { gte: posBarCutoff } },
            orderBy: { date: "asc" },
            select: { instrumentId: true, date: true, close: true },
          })
          .catch(() => [])
      : [];
  // Return theo NGÀY từng mã (fixbug #52-F2 — căn mép theo NGÀY thay vì
  // index trailing: mã đình quyền/thiếu bar không làm lệch chuỗi hợp nhất).
  // P0-1 (phiên #57): chuyển sang hợp đồng `returnsDated` của dated-series.ts
  // — một định nghĩa duy nhất toàn hệ thống (ret = close/prevClose − 1 của
  // CHÍNH mã đó, date ISO từ bar EOD; toán tử giống hệt bản inline cũ).
  const retsById = new Map<string, DatedReturn[]>();
  {
    const rowsById = new Map<string, { date: Date; close: number }[]>();
    for (const b of barRows) {
      if (!(b.close > 0)) continue;
      const list = rowsById.get(b.instrumentId) ?? [];
      list.push({ date: b.date, close: b.close });
      rowsById.set(b.instrumentId, list);
    }
    for (const [id, rows] of rowsById) retsById.set(id, returnsDated(rows));
  }

  // Mã đủ lịch sử: ≥ 59 return (≈ 60 close như chuẩn cũ MIN_REAL_SESSIONS)
  const usable = positions.filter(
    (p) => (retsById.get(p.instrumentId)?.length ?? 0) >= MIN_REAL_SESSIONS - 1
  );
  const realOk = usable.length >= 1 && nav > 0;

  if (realOk) {
    // Tra cứu return theo ngày của từng mã usable + nhóm ngành cho proxy §3
    const retLookup = new Map<string, Map<string, number>>();
    for (const p of usable) {
      const m = new Map<string, number>();
      for (const dr of retsById.get(p.instrumentId) ?? []) m.set(dr.date, dr.ret);
      retLookup.set(p.instrumentId, m);
    }
    const sectorMembers = new Map<string, string[]>();
    for (const p of usable) {
      sectorMembers.set(p.sector, [...(sectorMembers.get(p.sector) ?? []), p.instrumentId]);
    }
    // Union NGÀY của mọi mã usable (tăng dần)
    const allDates = new Set<string>();
    for (const m of retLookup.values()) for (const d of m.keys()) allDates.add(d);
    const dates = [...allDates].sort();
    // Hợp nhất theo NGÀY (fixbug #52-F2): r_p(d) = Σᵢ wᵢ·rᵢ(d) / Σᵢ wᵢ —
    // mã usable thiếu return tại d (đình quyền — giá giữ phiên trước) → ret 0;
    // mã KHÔNG usable (thiếu lịch sử) → return rổ CÙNG NGÀNH tại d (§3 CRB-2)
    const proxiedSymbols = new Set<string>();
    const datedSeries: DatedReturn[] = [];
    for (const d of dates) {
      let wSum = 0;
      let rSum = 0;
      for (const p of positions) {
        const w = nav > 0 ? p.mv / nav : 0;
        if (w <= 0) continue;
        const own = retLookup.get(p.instrumentId);
        let ret: number | null;
        if (own) {
          ret = own.get(d) ?? 0; // đình quyền 1 phiên → giá giữ → ret 0
        } else {
          // Mã thiếu lịch sử → proxy ngành TẠI NGÀY d (trung bình mã cùng ngành)
          const members = sectorMembers.get(p.sector) ?? [];
          let s = 0;
          let c = 0;
          for (const mid of members) {
            const r = retLookup.get(mid)?.get(d);
            if (r != null) {
              s += r;
              c++;
            }
          }
          ret = c > 0 ? s / c : null; // ngành trống tại d → bỏ mã khỏi ngày này
          if (ret != null) proxiedSymbols.add(p.symbol);
        }
        if (ret == null) continue;
        wSum += w;
        rSum += w * ret;
      }
      if (wSum > 0) datedSeries.push({ date: d, ret: rSum / wSum });
    }
    symbolProxies = proxiedSymbols.size;
    for (const p of positions) {
      if (usable.includes(p)) continue;
      if (nav > 0 && p.mv / nav > 0 && !proxiedSymbols.has(p.symbol)) {
        notes.push(
          `${p.symbol} thiếu lịch sử ≥ ${MIN_REAL_SESSIONS} phiên và không có ngành thay thế — bỏ khỏi chuỗi return (đã đếm proxy).`
        );
        symbolProxies++;
      }
    }
    if (datedSeries.length >= MIN_REAL_SESSIONS - 1) {
      portReturns = Float64Array.from(datedSeries.map((x) => x.ret));
      if (symbolProxies > 0) notes.push(`${symbolProxies} mã dùng return proxy ngành (thiếu lịch sử — §3 CRB-2).`);
    } else {
      proxyMode = true;
      notes.push(`Chuỗi ngày hợp nhất chỉ ${datedSeries.length} phiên < ${MIN_REAL_SESSIONS} — chuyển rổ proxy top-10.`);
    }
  } else {
    proxyMode = true;
    if (positions.length === 0) notes.push("Danh mục rỗng — proxy mode rổ top-10 thanh khoản HOSE (§0.4).");
    else if (nav <= 0) notes.push("NAV ≤ 0 — proxy mode rổ top-10 (nghiệm thu CRB-2.4).");
    else notes.push("Không có vị thế nào đủ lịch sử — proxy mode rổ top-10.");
  }

  // Rổ proxy (dùng cho proxy mode + CRB-6 train + CRB-8 fallback) —
  // sinceDays 800 ≈ 500 phiên (BASKET_WINDOW), không kéo full-history
  // (đỡ 30k dòng bar full-history)
  const topSeries = await loadTopSeries(10, { sinceDays: 800 }).catch(() => []);
  const basketCloses = buildBasket(
    topSeries.map((s) => s.closes),
    BASKET_WINDOW
  );
  const basketRets = closeToReturns(basketCloses);
  if (proxyMode) portReturns = basketRets;
  if (portReturns.length < 10) {
    // Không có nổi dữ liệu rổ (DB trống) — fail-safe trả kết quả tĩnh
    notes.push("Không đủ dữ liệu tính toán (danh mục + rổ đều trống) — giữ hạn mức tĩnh.");
    return {
      ok: false,
      proxyMode: true,
      nav,
      vol: {
        sigmaDaily: 0, sigmaAnnPct: 0, volRef: 0, volRatio: 1, mult: 1,
        dynMaxPositionPct: staticMaxPositionPct, dynMaxSectorPct: staticMaxSectorPct,
        loosened: false, sessions: 0,
      },
      dynMaxPositionPct: staticMaxPositionPct,
      dynMaxSectorPct: staticMaxSectorPct,
      staticMaxPositionPct,
      staticMaxSectorPct,
      limits: {
        sector: { ...limitsBefore.sector, posteriorMean: posteriorMean(limitsBefore.sector), mult: tighteningMult(limitsBefore.sector) },
        position: { ...limitsBefore.position, posteriorMean: posteriorMean(limitsBefore.position), mult: tighteningMult(limitsBefore.position) },
        dd: { ...limitsBefore.dd, posteriorMean: posteriorMean(limitsBefore.dd), mult: tighteningMult(limitsBefore.dd) },
        dailyLoss: { ...limitsBefore.dailyLoss, posteriorMean: posteriorMean(limitsBefore.dailyLoss), mult: tighteningMult(limitsBefore.dailyLoss) },
      },
      tail: { var95Pct: 0, cvar95Pct: 0, var95Vnd: 0, cvar95Vnd: 0, var95OneDayPct: 0, sessions: 0 },
      mc: { mcLoss5Pct: 0, pLoss2: 0, pLoss5: 0, pDd: 0, worstPathPct: 0, mcVarPct: 0, paths: 0 },
      mcCrossGap: 0,
      conc: null,
      corr: null,
      drift: { s: 0, sPlus: 0, h: 0, alarm: false, sessionsToDd: null, chartZ: 0, chartLimit: 0, chartAlarm: false, sigma: 0 },
      navSeriesSource: "none",
      pBreach: null,
      logit: { auc: 0, served: false, trainSamples: 0, valSamples: 0, baseRate: 0, modelVersion: "phase1-basket" },
      breaches: { sector: false, position: false, dd: false, dailyLoss: null },
      alerts: [],
      evidence: [],
      promptLines: [],
      arms,
      snapshotId: null,
      notes,
      durationMs: Date.now() - startedAt,
    };
  }

  /* ── 3. CRB-1 · EWMA σ + volMult (hai chiều [0,6 · 1,15]) ──────────── */
  const vol = computeVolatility(portReturns, {
    maxPositionPct: staticMaxPositionPct,
    maxSectorWeightPct: staticMaxSectorPct,
  });

  /* ── 4. CRB-7 · mult_ℓ per-limit (một chiều siết, floor 0,75) ──────── */
  const multSector = tighteningMult(limitsBefore.sector);
  const multPosition = tighteningMult(limitsBefore.position);
  // Hợp nhất CRB-1 × CRB-7 — ERRATUM v1.1.1 (phiên #51): TÍCH rồi kẹp dải
  // cứng [0,6 · 1,15] (§0.3), KHÔNG dùng min(volMult, mult_ℓ) như chữ CRB-7
  // v1.1 — min() với mult_ℓ = 1 trung tính (chưa có lịch sử vi phạm) chặn
  // VĨNH VIỄN việc nới, mâu thuẫn quyết định Q2 "được phép nới khi yên bình".
  // Tích: nới chỉ khi volMult > 1 VÀ mult_ℓ = 1 (learning không phản đối) —
  // đúng nghĩa "NỚI chỉ đến từ volMult, Bayesian một chiều siết".
  const mergedSectorMult = Math.min(MULT_CEILING, Math.max(MULT_FLOOR, vol.mult * multSector));
  const mergedPositionMult = Math.min(MULT_CEILING, Math.max(MULT_FLOOR, vol.mult * multPosition));
  // Hợp nhất: nới CHỈ đến từ volMult (CRB-7 một chiều) — đã kẹp dải cứng
  const dynMaxSectorPct = staticMaxSectorPct * mergedSectorMult;
  const dynMaxPositionPct = staticMaxPositionPct * mergedPositionMult;

  /* ── 5. CRB-2/3 · HS-VaR/CVaR + Monte Carlo ────────────────────────── */
  // ddNow: từ chuỗi NAV snapshot theo ngày (đỉnh → hiện tại); PHA 1 chưa đủ → 0
  let ddNow = 0;
  if (navDaily.length >= 2) {
    const peak = Math.max(...navDaily);
    ddNow = peak > 0 ? Math.max(0, 1 - navDaily[navDaily.length - 1] / peak) : 0;
  }
  const tail = hsVarCvar(portReturns, proxyMode ? 0 : nav);
  const mc = monteCarloStress(portReturns, { nav: proxyMode ? 0 : nav, ddNow });
  const mcCrossGap = crossCheckMcVsHs(mc, tail.var95Pct);
  if (mcCrossGap > 0.2) {
    notes.push(
      `MC-VaR lệch HS-VaR ${pct1(mcCrossGap * 100)} (> 20%) — dấu hiệu đuôi nặng, log review (nghiệm thu CRB-3.2).`
    );
  }

  /* ── 6. CRB-4/5 · HHI + tương quan (chỉ chế độ danh mục thật) ──────── */
  let conc: ConcentrationResult | null = null;
  let corr: CorrelationResult | null = null;
  const sectorPcts: number[] = [];
  const positionPcts: number[] = [];
  if (!proxyMode && positions.length > 0 && nav > 0) {
    const bySector = new Map<string, number>();
    for (const p of positions) bySector.set(p.sector, (bySector.get(p.sector) ?? 0) + p.mv);
    for (const pct of bySector.values()) sectorPcts.push((pct / nav) * 100);
    for (const p of positions) positionPcts.push((p.mv / nav) * 100);
    conc = computeConcentration(sectorPcts, positionPcts);
    // Tương quan: top-15 vị thế theo MV có ≥ 59 return theo ngày — mỗi cặp
    // ghép PHIÊN CHUNG theo NGÀY trong concentration.ts (fixbug #52-F1)
    const top15 = [...positions]
      .sort((a, b) => b.mv - a.mv)
      .slice(0, 15)
      .map((p) => retsById.get(p.instrumentId))
      .filter((r): r is DatedReturn[] => (r?.length ?? 0) >= MIN_REAL_SESSIONS - 1);
    if (top15.length >= 2) corr = computeCorrelation(top15);
  }

  /* ── 7. CRB-8 · CUSUM + EWMA chart (NAV theo ngày ≥ 60, else rổ) ──── */
  let drift: DriftResult;
  let navSeriesSource: RiskQuantResult["navSeriesSource"] = "none";
  if (navReturns.length >= 60) {
    drift = computeDrift(navReturns, { ddNow, ddThreshold: ddThresholdPct / 100 });
    navSeriesSource = "snapshot-daily";
  } else if (basketRets.length >= 60) {
    drift = computeDrift(basketRets, { ddNow, ddThreshold: ddThresholdPct / 100 });
    navSeriesSource = "basket-proxy";
    notes.push(`CUSUM chạy trên rổ proxy (chỉ ${navReturns.length} ngày NAV snapshot < 60 — PHA 1).`);
  } else {
    drift = {
      s: 0, sPlus: 0, h: 0, alarm: false, sessionsToDd: null,
      chartZ: 0, chartLimit: 0, chartAlarm: false, sigma: 0,
    };
  }

  /* ── 8. CRB-6 · logistic P(vi phạm 5 phiên) — PHA 1 nhãn proxy rổ ──── */
  let logit: BreachLogitModel;
  let pBreach: number | null = null;
  {
    const rsi = rsiSeries(basketCloses);
    const sigmaSeries = ewmaSigmaSeries(basketRets);
    const feats: number[][] = [];
    const labels: number[] = [];
    for (let t = 60; t < basketCloses.length - 5; t++) {
      const x = basketFeatureAt(t, basketCloses, sigmaSeries, rsi);
      if (!x) continue;
      const ret5 = basketCloses[t + 5] / basketCloses[t] - 1;
      feats.push(x);
      labels.push(ret5 <= -0.02 ? 1 : 0); // nhãn PHA 1: đuôi xấu rổ ≤ −2%
    }
    logit = trainBreachLogit(feats, labels, "phase1-basket");
    if (logit.served && basketCloses.length >= 60) {
      // Serving vector: x1/x2/x3/x5/x8 tại phiên cuối + x4/x6/x7 trạng thái hiện tại
      const t = basketCloses.length - 1;
      const xHist = basketFeatureAt(t, basketCloses, sigmaSeries, rsi);
      if (xHist) {
        const investedFraction = proxyMode || nav <= 0 ? 0 : positionsMv / nav;
        xHist[3] = Math.min(1, investedFraction); // x4 exposure
        xHist[5] = conc ? Math.min(1, conc.hhiSector) : 0; // x6 hhiSector
        xHist[6] = corr ? Math.max(-1, Math.min(1, corr.avgCorr)) : 0; // x7 avgCorr
        const p = predictBreach(logit, xHist);
        // Phòng thủ NaN (fixbug #52-F7): giá trị không hữu hạn → null
        // (trung thực "không biết") thay vì để JSON.stringify biến NaN thành
        // null lặng lẽ ở mọi tầng snapshot/alert/evidence.
        pBreach = Number.isFinite(p) ? p : null;
      }
    }
    if (!logit.served) {
      notes.push(
        `Logistic CRB-6 AUC ${pct2(logit.auc * 100)} < 55% — KHÔNG serving (chỉ log, không vào Bayes — trung thực).`
      );
    }
  }

  /* ── 9. Vi phạm chu kỳ này → cập nhật Beta CRB-7 (vi phạm thật) ────── */
  const topSectorPct = sectorPcts.length > 0 ? Math.max(...sectorPcts) : 0;
  const topPositionPct = positionPcts.length > 0 ? Math.max(...positionPcts) : 0;
  const breachSector = !proxyMode && topSectorPct > dynMaxSectorPct + 1e-9;
  const breachPosition = !proxyMode && topPositionPct > dynMaxPositionPct + 1e-9;
  const breachDd = ddNow >= ddThresholdPct / 100 - 1e-9;
  // dailyLoss: cần snapshot TRƯỚC cùng ngày (đối chiếu NAV) — không có → abstain
  let breachDailyLoss: boolean | null = null;
  {
    const today = new Date().toISOString().slice(0, 10);
    const todays = snapshotRows.filter((r) => r.createdAt.toISOString().slice(0, 10) === today);
    if (todays.length >= 1 && nav > 0) {
      const prevNav = Math.max(...todays.map((r) => Number(r.nav)));
      if (prevNav > 0) breachDailyLoss = prevNav - nav > dailyLossLimitVnd;
    }
  }
  const limitsAfter: RiskQuantLimitsSetting = {
    sector: breachSector
      ? { alpha: limitsBefore.sector.alpha + 1, beta: limitsBefore.sector.beta }
      : { alpha: limitsBefore.sector.alpha, beta: limitsBefore.sector.beta + 1 },
    position: breachPosition
      ? { alpha: limitsBefore.position.alpha + 1, beta: limitsBefore.position.beta }
      : { alpha: limitsBefore.position.alpha, beta: limitsBefore.position.beta + 1 },
    dd: breachDd
      ? { alpha: limitsBefore.dd.alpha + 1, beta: limitsBefore.dd.beta }
      : { alpha: limitsBefore.dd.alpha, beta: limitsBefore.dd.beta + 1 },
    dailyLoss:
      breachDailyLoss == null
        ? limitsBefore.dailyLoss // abstain — không tăng β giả (trung thực)
        : breachDailyLoss
          ? { alpha: limitsBefore.dailyLoss.alpha + 1, beta: limitsBefore.dailyLoss.beta }
          : { alpha: limitsBefore.dailyLoss.alpha, beta: limitsBefore.dailyLoss.beta + 1 },
  };
  await saveRiskQuantLimits(limitsAfter).catch((err) => {
    console.error("[risk-quant] lưu AppSetting risk-quant-limits lỗi:", err);
  });

  const limitsOut: RiskQuantResult["limits"] = {
    sector: { ...limitsAfter.sector, posteriorMean: posteriorMean(limitsAfter.sector), mult: tighteningMult(limitsAfter.sector) },
    position: { ...limitsAfter.position, posteriorMean: posteriorMean(limitsAfter.position), mult: tighteningMult(limitsAfter.position) },
    dd: { ...limitsAfter.dd, posteriorMean: posteriorMean(limitsAfter.dd), mult: tighteningMult(limitsAfter.dd) },
    dailyLoss: { ...limitsAfter.dailyLoss, posteriorMean: posteriorMean(limitsAfter.dailyLoss), mult: tighteningMult(limitsAfter.dailyLoss) },
  };

  /* ── 10. RiskAlert (theo quy tắc §3-§6 — dedupe 24h theo code) ─────── */
  // Nới thực sự áp dụng = hệ số hợp nhất > 1 (volMult nới VÀ learning không phản đối)
  const loosenedApplied = mergedSectorMult > 1 + 1e-9 || mergedPositionMult > 1 + 1e-9;
  if (loosenedApplied) {
    alerts.push({
      severity: "INFO",
      code: "QUANT_VOL_LOOSEN",
      message: `Nới hạn mức theo biến động thấp hơn mốc: hệ số hợp nhất vol×${vol.mult.toFixed(2).replace(".", ",")} × learning×${multSector.toFixed(2).replace(".", ",")} ∈ (1 · 1,15] → vị thế tối đa ${pct1(dynMaxPositionPct)} NAV · ngành ${pct1(dynMaxSectorPct)} (kiểm toán được — §0.3).`,
      metricKey: "risk.vol.mult",
      metricValue: vol.mult,
      threshold: 1.15,
    });
  }
  if (vol.mult <= 0.75) {
    alerts.push({
      severity: "WARNING",
      code: "QUANT_VOL_TIGHT",
      message: `Biến động EWMA cao bất thường (×${vol.volRatio.toFixed(2).replace(".", ",")} mốc bình thường) — hạn mức động đã siết về ${pct1(dynMaxPositionPct)} NAV/vị thế · ${pct1(dynMaxSectorPct)}/ngành.`,
      metricKey: "risk.vol.ratio",
      metricValue: vol.volRatio,
      threshold: 1.33,
    });
  }
  if (tail.cvar95Pct > 3) {
    alerts.push({
      severity: tail.cvar95Pct > 5 ? "CRITICAL" : "WARNING",
      code: "QUANT_CVAR",
      message: `CVaR95 5 phiên ${pct1(tail.cvar95Pct)} NAV${!proxyMode ? ` (≈ ${vnd((tail.cvar95Pct / 100) * nav)} ₫)` : " (rổ proxy)"} — ${tail.cvar95Pct > 5 ? "vượt ngưỡng khủng hoảng 5%" : "vượt ngưỡng cảnh báo 3%"}.`,
      metricKey: "risk.cvar95.pct",
      metricValue: tail.cvar95Pct,
      threshold: tail.cvar95Pct > 5 ? 5 : 3,
    });
  }
  if (mc.paths > 0 && mc.pDd >= 0.1) {
    alerts.push({
      severity: "CRITICAL",
      code: "QUANT_MC_DD",
      message: `Monte Carlo bootstrap ${mc.paths.toLocaleString("vi-VN")} path: P(chạm DD ${ddThresholdPct}%) = ${pct1(mc.pDd * 100)} ≥ 10% — rủi ro drawdown cao trong 5 phiên tới.`,
      metricKey: "risk.mc.pdd",
      metricValue: mc.pDd,
      threshold: 0.1,
    });
  }
  if (conc?.breach) {
    alerts.push({
      severity: "WARNING",
      code: "QUANT_HHI",
      message: `Tập trung danh mục: ${conc.breaches.join(" · ")} — tín hiệu siết sớm (VETO A7 giữ nguyên ranh giới hạn mức).`,
      metricKey: "risk.hhi.sector",
      metricValue: conc.hhiSector,
      threshold: 0.25,
    });
  }
  if (corr?.breach) {
    alerts.push({
      severity: "WARNING",
      code: "QUANT_CORR",
      message: `Tương quan vị thế cao: ${corr.note} — ${corr.pairsDropped > 0 ? `(${corr.pairsDropped} cặp bỏ vì thiếu phiên chung)` : ""}.`,
      metricKey: "risk.avgcorr",
      metricValue: corr.avgCorr,
      threshold: 0.7,
    });
  }
  if (drift.alarm) {
    alerts.push({
      severity: "WARNING",
      code: "QUANT_CUSUM",
      message: `CUSUM phát hiện trôi dạt XUỐNG sớm (S vượt 4σ${drift.sessionsToDd != null ? `, ngoại suy còn ~${drift.sessionsToDd} phiên tới DD ${ddThresholdPct}% theo trend hiện tại` : ""}) — nguồn ${navSeriesSource === "snapshot-daily" ? "NAV snapshot" : "rổ proxy"}.`,
      metricKey: "risk.cusum.s",
      metricValue: drift.s,
      threshold: drift.h,
    });
  }
  if (drift.chartAlarm) {
    alerts.push({
      severity: "WARNING",
      code: "QUANT_VOL_SHIFT",
      message: `EWMA control chart vượt giới hạn ±2,7σ·√(μ/(2−μ)): z ${drift.chartZ.toFixed(4).replace(".", ",")} ngoài ±${drift.chartLimit.toFixed(4).replace(".", ",")} — vol-shift.`,
      metricKey: "risk.ewmachart.z",
      metricValue: drift.chartZ,
      threshold: drift.chartLimit,
    });
  }
  if (pBreach != null && pBreach > 0.35) {
    alerts.push({
      severity: "WARNING",
      code: "QUANT_PBREACH",
      message: `Logistic CRB-6: P(vi phạm hạn mức 5 phiên) = ${pct1(pBreach * 100)} > 35% (AUC ${pct1(logit.auc * 100)}, ${logit.modelVersion}) — chuẩn bị siết phòng thủ.`,
      metricKey: "risk.pbreach",
      metricValue: pBreach,
      threshold: 0.35,
    });
  }

  /* ── 11. Bằng chứng Bayes (T7.5 — đúng MỘT lần, source riêng) ──────── */
  const evidence: BayesEvidence[] = [];
  if (tail.cvar95Pct > 3) {
    evidence.push({
      source: "quant-tail:hs-cvar",
      agentName: "Ủy ban Kiểm soát Định lượng",
      gen1: "A6",
      level: "market",
      direction: "DOWN",
      likelihoodRatio: Math.min(2, Math.max(1, 1 + (tail.cvar95Pct - 3) / 2)),
      weight: 0.3,
      note: `CVaR95 5 phiên ${pct1(tail.cvar95Pct)} NAV${proxyMode ? " (rổ proxy)" : ""} — đuôi xấu quant`,
    });
  }
  if (conc?.breach) {
    evidence.push({
      source: "quant-tail:hhi",
      agentName: "Ủy ban Kiểm soát Định lượng",
      gen1: "A6",
      level: "market",
      direction: "DOWN",
      likelihoodRatio: Math.min(1.6, Math.max(1, 1 + (conc.hhiSector - 0.25) * 2)),
      weight: 0.3,
      note: `HHI ngành ${conc.hhiSector.toFixed(3).replace(".", ",")} > 0,25 — tập trung (${conc.breaches[0] ?? ""})`,
    });
  }
  if (pBreach != null && pBreach > 0.35) {
    evidence.push({
      source: "quant-drift:breach-prob",
      agentName: "Ủy ban Kiểm soát Định lượng",
      gen1: "A6",
      level: "market",
      direction: "DOWN",
      likelihoodRatio: breachOddsLr(logit, pBreach),
      weight: Math.min(0.8, Math.max(0.3, pBreach * 1.5)),
      note: `P(vi phạm 5 phiên) ${pct1(pBreach * 100)} > 35% (logistic AUC ${pct1(logit.auc * 100)})`,
    });
  }
  if (drift.alarm) {
    evidence.push({
      source: "quant-drift:cusum",
      agentName: "Ủy ban Kiểm soát Định lượng",
      gen1: "A6",
      level: "market",
      direction: "DOWN",
      likelihoodRatio: 1.5,
      weight: 0.3,
      note: `CUSUM trôi dạt xuống vượt 4σ${drift.sessionsToDd != null ? ` (~${drift.sessionsToDd} phiên tới DD)` : ""}`,
    });
  }

  /* ── 12. Prompt lines cho risk-manager A6 (khối QUANT — §3) ────────── */
  const promptLines: string[] = [
    `- Biến động EWMA20 năm hoá: ${pct2(vol.sigmaAnnPct)} (×${vol.volRatio.toFixed(2).replace(".", ",")} mốc bình thường) → hạn mức vị thế động ${pct1(dynMaxPositionPct)} NAV · ngành ${pct1(dynMaxSectorPct)} (tĩnh ${pct1(staticMaxPositionPct)}/${pct1(staticMaxSectorPct)} × hệ số hợp nhất ${mergedSectorMult.toFixed(2).replace(".", ",")} = vol ${vol.mult.toFixed(2).replace(".", ",")} × learning ${multSector.toFixed(2).replace(".", ",")}).`,
    `- VaR95 5 phiên: ${pct2(tail.var95Pct)} NAV${!proxyMode ? ` (≈ ${vnd(tail.var95Vnd)} ₫)` : " (rổ proxy)"} · CVaR95: ${pct2(tail.cvar95Pct)} NAV — đối chiếu lỗ ngày tối đa ${vnd(dailyLossLimitVnd)} ₫ và DD ${ddThresholdPct}%.`,
    `- Monte Carlo bootstrap ${mc.paths.toLocaleString("vi-VN")} path × 5 phiên: P(lỗ > 2%) = ${pct1(mc.pLoss2 * 100)} · P(lỗ > 5%) = ${pct1(mc.pLoss5 * 100)} · P(chạm DD ${ddThresholdPct}%) = ${pct1(mc.pDd * 100)}${mc.paths > 0 ? ` · path tệ nhất ${mc.worstPathPct.toFixed(1).replace(".", ",")}%` : ""}.`,
  ];
  if (conc) {
    promptLines.push(
      `- Tập trung: HHI ngành ${conc.hhiSector.toFixed(3).replace(".", ",")} (≈ ${conc.effSectors.toFixed(1).replace(".", ",")} ngành hiệu quả) · HHI vị thế ${conc.hhiPosition.toFixed(3).replace(".", ",")} (≈ ${conc.effPositions.toFixed(1).replace(".", ",")})${conc.breach ? " — VƯỢT ngưỡng cảnh báo" : ""}.`
    );
  }
  if (corr) {
    promptLines.push(`- Tương quan TB vị thế: ${corr.avgCorr.toFixed(2).replace(".", ",")} → ${corr.note}.`);
  }
  promptLines.push(
    `- CUSUM trôi dạt: S = ${drift.s.toFixed(5).replace(".", ",")} / ngưỡng h = ${drift.h.toFixed(5).replace(".", ",")} (${drift.alarm ? "BÁO ĐỘNG" : "yên"})${pBreach != null ? ` · P(vi phạm 5 phiên) = ${pct1(pBreach * 100)} (logistic AUC ${pct1(logit.auc * 100)})` : " · logistic chưa đạt AUC serving"}.`
  );

  /* ── 13. Persist snapshot + alerts (dedupe 24h theo code) ──────────── */
  let snapshotId: string | null = null;
  try {
    const detail = {
      staticLimits: { maxSectorWeightPct: staticMaxSectorPct, maxPositionPct: staticMaxPositionPct, maxDrawdownPct: ddThresholdPct, dailyLossLimitVnd },
      volMult: vol.mult,
      volRatio: vol.volRatio,
      sigmaAnnPct: vol.sigmaAnnPct,
      limits: limitsOut,
      breaches: { sector: breachSector, position: breachPosition, dd: breachDd, dailyLoss: breachDailyLoss },
      topSectorPct,
      topPositionPct,
      ddNow,
      navSeriesSource,
      mc: { pLoss2: mc.pLoss2, pLoss5: mc.pLoss5, worstPathPct: mc.worstPathPct, mcVarPct: mc.mcVarPct, crossGap: mcCrossGap, paths: mc.paths },
      logit: { auc: logit.auc, served: logit.served, trainSamples: logit.trainSamples, valSamples: logit.valSamples, baseRate: logit.baseRate, modelVersion: logit.modelVersion },
      cusum: { s: drift.s, sPlus: drift.sPlus, h: drift.h, chartZ: drift.chartZ, chartLimit: drift.chartLimit, sessionsToDd: drift.sessionsToDd },
      alerts: alerts.map((a) => ({ severity: a.severity, code: a.code, message: a.message })),
      basketSymbols: topSeries.map((s) => s.symbol),
      symbolProxies,
      notes,
      durationMs: Date.now() - startedAt,
    };
    const snap = await db.riskQuantSnapshot.create({
      data: {
        nav: Math.max(0, Math.round(nav)),
        proxyMode,
        volEwmaAnnPct: Number(vol.sigmaAnnPct.toFixed(4)),
        volRatio: Number(vol.volRatio.toFixed(4)),
        dynMaxPositionPct: Number(dynMaxPositionPct.toFixed(2)),
        dynMaxSectorPct: Number(dynMaxSectorPct.toFixed(2)),
        var95Pct: Number(tail.var95Pct.toFixed(4)),
        cvar95Pct: Number(tail.cvar95Pct.toFixed(4)),
        var95Vnd: tail.var95Vnd,
        mcLoss5Pct: Number(mc.mcLoss5Pct.toFixed(4)),
        mcPDd: Number(mc.pDd.toFixed(4)),
        hhiSector: Number((conc?.hhiSector ?? 0).toFixed(4)),
        hhiPosition: Number((conc?.hhiPosition ?? 0).toFixed(4)),
        effSectors: Number((conc?.effSectors ?? 0).toFixed(2)),
        effBets: Number((corr?.effBets ?? 0).toFixed(2)),
        avgCorr: Number((corr?.avgCorr ?? 0).toFixed(4)),
        cusumS: Number(drift.s.toFixed(6)),
        pBreach5d: pBreach != null ? Number(pBreach.toFixed(4)) : null,
        detail: JSON.stringify(detail),
      },
    });
    snapshotId = snap.id;

    // RiskAlert — dedupe: bỏ code đã có alert CHƯA acknowledge trong 24h
    if (alerts.length > 0) {
      const since24h = new Date(Date.now() - 24 * 3_600_000);
      const existing = await db.riskAlert
        .findMany({
          where: { code: { in: alerts.map((a) => a.code) }, createdAt: { gte: since24h }, acknowledgedAt: null },
          select: { id: true, code: true },
        })
        .catch(() => []);
      const seen = new Set(existing.map((e) => e.code));
      const fresh = alerts.filter((a) => !seen.has(a.code));
      if (fresh.length > 0) {
        await db.riskAlert.createMany({
          data: fresh.map((a) => ({
            severity: a.severity,
            code: a.code,
            message: a.message,
            metricKey: a.metricKey ?? null,
            metricValue: a.metricValue ?? null,
            threshold: a.threshold ?? null,
          })),
        });
      }
      // Điều kiện còn kéo dài (> 1 chu kỳ trong 24h, chưa acknowledge) →
      // CẬP NHẬT thông điệp dòng cũ bằng số liệu MỚI NHẤT (giữ 1 dòng/code,
      // không spam; số liệu không lỗi thời khi audit)
      for (const e of existing) {
        const latest = alerts.find((a) => a.code === e.code);
        if (latest) {
          await db.riskAlert
            .update({
              where: { id: e.id },
              data: {
                message: latest.message,
                metricValue: latest.metricValue ?? null,
                threshold: latest.threshold ?? null,
              },
            })
            .catch(() => undefined);
        }
      }
    }
  } catch (err) {
    console.error("[risk-quant] persist snapshot/alerts lỗi:", err);
  }

  const durationMs = Date.now() - startedAt;
  if (durationMs > 1500) {
    console.warn(`[risk-quant] engine vượt ngân sách 1,5s: ${durationMs}ms (§10 — xem cắt N_PATHS).`);
  }

  return {
    ok: true,
    proxyMode,
    nav,
    vol,
    dynMaxPositionPct,
    dynMaxSectorPct,
    staticMaxPositionPct,
    staticMaxSectorPct,
    limits: limitsOut,
    tail,
    mc,
    mcCrossGap,
    conc,
    corr,
    drift,
    navSeriesSource,
    pBreach,
    logit: {
      auc: logit.auc,
      served: logit.served,
      trainSamples: logit.trainSamples,
      valSamples: logit.valSamples,
      baseRate: logit.baseRate,
      modelVersion: logit.modelVersion,
    },
    breaches: { sector: breachSector, position: breachPosition, dd: breachDd, dailyLoss: breachDailyLoss },
    alerts,
    evidence,
    promptLines,
    arms,
    snapshotId,
    notes,
    durationMs,
  };
}

/** Cập nhật kellyHint vào snapshot sau khi Chủ tịch ra tín hiệu (CRB-9). */
export async function attachKellyHint(
  snapshotId: string | null,
  kellyHint: number | null
): Promise<void> {
  if (!snapshotId) return;
  await db.riskQuantSnapshot
    .update({
      where: { id: snapshotId },
      data: { kellyHint: kellyHint != null ? Number(kellyHint.toFixed(4)) : null },
    })
    .catch(() => undefined);
}

/** Bản view gọn cho detail.riskQuant của MarketAssessment (UI Tổng hợp). */
export interface RiskQuantViewData {
  proxyMode: boolean;
  volEwmaAnnPct: number;
  volRatio: number;
  mult: number;
  dynMaxPositionPct: number;
  dynMaxSectorPct: number;
  staticMaxPositionPct: number;
  staticMaxSectorPct: number;
  var95Pct: number;
  cvar95Pct: number;
  var95Vnd: number;
  mcPDd: number;
  mcLoss5Pct: number;
  hhiSector: number;
  hhiPosition: number;
  effSectors: number;
  effBets: number;
  avgCorr: number;
  cusumS: number;
  cusumAlarm: boolean;
  pBreach5d: number | null;
  kellyHint: number | null;
  alerts: { severity: string; code: string; message: string }[];
  notes: string[];
}

/** Rút view gọn từ kết quả engine (lưu vào MarketAssessment.detail.riskQuant). */
export function toRiskQuantView(r: RiskQuantResult): RiskQuantViewData {
  return {
    proxyMode: r.proxyMode,
    volEwmaAnnPct: r.vol.sigmaAnnPct,
    volRatio: r.vol.volRatio,
    // Fixbug #52-F4: hệ số hiển thị = hệ số HỢP NHẤT áp dụng cho vị thế
    // (dyn/static = clamp(vol.mult × mult_ℓ)) — tile "Hệ số hạn mức" + hint
    // "Nới" phản ánh đúng hạn động đã áp; chuyện biến động kể ở tile volRatio.
    mult: r.staticMaxPositionPct > 0 ? r.dynMaxPositionPct / r.staticMaxPositionPct : r.vol.mult,
    dynMaxPositionPct: r.dynMaxPositionPct,
    dynMaxSectorPct: r.dynMaxSectorPct,
    staticMaxPositionPct: r.staticMaxPositionPct,
    staticMaxSectorPct: r.staticMaxSectorPct,
    var95Pct: r.tail.var95Pct,
    cvar95Pct: r.tail.cvar95Pct,
    var95Vnd: r.tail.var95Vnd,
    mcPDd: r.mc.pDd,
    mcLoss5Pct: r.mc.mcLoss5Pct,
    hhiSector: r.conc?.hhiSector ?? 0,
    hhiPosition: r.conc?.hhiPosition ?? 0,
    effSectors: r.conc?.effSectors ?? 0,
    effBets: r.corr?.effBets ?? 0,
    avgCorr: r.corr?.avgCorr ?? 0,
    cusumS: r.drift.s,
    cusumAlarm: r.drift.alarm,
    pBreach5d: r.pBreach,
    kellyHint: null, // route điền sau khi có tín hiệu (attachKellyHint song song)
    alerts: r.alerts.map((a) => ({ severity: a.severity, code: a.code, message: a.message })),
    notes: r.notes,
  };
}
