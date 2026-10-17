/**
 * src/lib/risk/scenario.ts — F-14 · FACTOR-BETA MONTE CARLO + KỊCH BẢN STRESS
 * CÓ TÊN (AI_ENGINEER_REVIEW_BRAIN v3 §3 F-14 — Task #129-C, subagent).
 *
 * VAI TRÒ (E6 — đọc kỹ trước khi sửa): `RiskQuantSnapshot` ĐÃ CÓ Monte Carlo
 * bootstrap VÔ ĐIỀU KIỆN (`mcLoss5Pct`/`mcPDd` — src/lib/risk/tail.ts CRB-3,
 * engine.ts ghi mỗi chu kỳ). Module này là MỞ RỘNG, KHÔNG PHẢI BUILD ĐÚP và
 * KHÔNG THAY THẾ snapshot đó: MC cũ trả lời "danh mục dao động thế nào nói
 * chung" (bootstrap return lịch sử); F-14 trả lời "khi factor vĩ mô X đi
 * hướng Y thì lỗ bao nhiêu" (điều kiện hoá theo 4 factor). Theo thiết kế
 * #129-C module KHÔNG ghi RiskQuantSnapshot — chỉ trả payload JSON cho
 * risk-manager + UI (main agent quyết wiring vào snapshot.detail sau).
 *
 * PIPELINE (`runScenarioAnalysis()`):
 *   1. Nạp vị thế OPEN thật (Position × quote mới nhất); 0 vị thế → PROXY:
 *      rổ top-10 thanh khoản HOSE (clone pattern settle bandit.ts — KHÔNG
 *      import @/lib/ml/features vì file đó đang sửa song song #129).
 *   2. `estimateFactorBetas()` — OLS đơn biến daily logret mã vs từng factor
 *      ∈ {VNINDEX, US10Y, DX-Y.NYB, GC=F} trên cửa sổ phiên CHUNG cuối.
 *   3. `monteCarloFactorSim()` — 10.000 đường correlated (Cholesky ma trận
 *      hiệp phương sai factor) × horizon 5 phiên, seed cố định Mulberry32.
 *   4. `namedStressScenarios()` — 5 kịch bản ĐẶT TÊN (xấp xỉ tĩnh, đúng dấu
 *      theo beta) + baseline "VNINDEX −3%" kiểm chứng dấu.
 *
 * ĐƠN VỊ (nguyên tắc N1 — khai báo 1 chỗ, không heuristic tầng tiêu thụ):
 *   ┌────────────┬───────────────┬───────────────────────────────────────────────────┐
 *   │ factorKey  │ symbol        │ chuỗi hồi quy (Bar.close là đơn vị DB thô)          │
 *   ├────────────┼───────────────┼───────────────────────────────────────────────────┤
 *   │ vnindex    │ VNINDEX       │ log-return ngày ln(c_t/c_{t−1}); close = điểm×100   │
 *   │            │               │ → hệ số ×100 TỰ TRIỆT TIÊU trong logret             │
 *   │ us10yCb    │ US10Y         │ Δ lợi suất ĐIỂM-% = Δclose/100 (close = %×100, vd   │
 *   │            │               │ 509 = 5,09%) → 1 đơn vị chuỗi = +1pp = +100cb.     │
 *   │            │               │ LOGRET KHÔNG hợp lệ cho lợi suất — dùng delta.      │
 *   │ dxy        │ DX-Y.NYB      │ log-return ngày (close = DXY×10.000 — triệt tiêu)   │
 *   │ gold       │ GC=F          │ log-return ngày (close = cents×100 — triệt tiêu)    │
 *   └────────────┴───────────────┴───────────────────────────────────────────────────┘
 *   Beta = cov(r_mã, f)/var(f) — độ nhạy log-return MÃ theo 1 đơn vị factor.
 *
 * CÔNG THỨC P&L:
 *   · MC (tuyến tính, đúng công thức đặc tả F-14):
 *       P&L_path = Σᵢ MVᵢ × Σ_f βᵢ,f · f_f,  f ~ N(0, Σ·5) (zero-drift, σ×√5)
 *   · Kịch bản đặt tên (chuẩn xác mũ — tên kịch bản nêu biến động THỊ TRƯỜNG
 *     dạng % đơn, quy về log-shock rồi hoàn trả % đơn của MÃ):
 *       shock_vnindex(−3%) = ln(0,97); shock_dxy(+2%) = ln(1,02);
 *       shock_gold(±10%) = ln(1,10)/ln(0,90); shock_us10y(+50cb) = +0,5 (pp).
 *       P&Lᵢ = MVᵢ × (e^{βᵢ,f · shock_f} − 1)  → β=1, VNINDEX −3% ⇒ lỗ đúng 3%.
 *     (Hai dạng tương đương tới bậc 1; dạng mũ giữ nguyên văn "−3%" của tên
 *     kịch bản, dạng tuyến tính khớp công thức MC — đều khai báo trong notes.)
 *   · "VND −2%": KHÔNG có beta VND trực tiếp (theo thiết kế F-14) → PROXY qua
 *     beta DXY: VND mất giá thường đi kèm DXY TĂNG ⇒ mô hình hoá bằng kịch bản
 *     DXY +2%, GHI RÕ proxy trong output (trung thực, không bịa beta VND).
 *
 * CĂN CHỈNH & CỬA SỔ: "phiên chung" = ngày CẢ 4 factor có bar (lịch VN ∩ Mỹ —
 * DXY/GC/US10Y theo lịch Mỹ, VNINDEX theo lịch VN). Factor Mỹ đóng cửa
 * ~21:00 ICT SAU phiên VN cùng ngày → beta đo ĐỒNG BIẾN ĐỘNG risk-off cùng
 * bước (contemporaneous), không phải hiệu ứng trễ; muốn PIT nghiêm ngặt dùng
 * alignMacroBefore của F-01. Mã mới niêm yết < 60 phiên chung → beta null +
 * khai báo "chưa đủ dữ liệu beta" (N2) — không bịa.
 *
 * DETERMINISM: Mulberry32 (tái dùng src/lib/risk/tail.ts) + seed cố định
 * 12914 (129-C) — 2 lần chạy trả số byte-giống nhau. Thuần TypeScript,
 * Float64Array, 0 dependency mới, 0 LLM, 0 ghi DB. Ngân sách < 2s ≤ 10 vị thế.
 */

import { db } from "@/lib/db";
import { mulberry32 } from "@/lib/risk/tail";
import { correlation, stdev } from "@/lib/quant/statistics";

/* ─────────────────────────── Hằng số & type ─────────────────────────── */

/** 4 factor theo THỨ TỰ ma trận hiệp phương sai / vector beta (N1). */
export type FactorKey = "vnindex" | "us10yCb" | "dxy" | "gold";

interface FactorDef {
  key: FactorKey;
  symbol: string;
  label: string;
  /** Khai báo đơn vị chuỗi hồi quy — nguồn sự thật duy nhất cho UI/prompt. */
  unit: string;
  /** true = log-return (ln tỉ giá); false = delta Δclose/100 (US10Y, pp). */
  isLog: boolean;
}

const FACTOR_DEFS: FactorDef[] = [
  {
    key: "vnindex",
    symbol: "VNINDEX",
    label: "VN-Index",
    unit: "log-return ngày (ln(c_t/c_{t−1})); Bar.close = điểm×100 — hệ số triệt tiêu trong logret",
    isLog: true,
  },
  {
    key: "us10yCb",
    symbol: "US10Y",
    label: "Lợi suất T-10Y Mỹ",
    // close = %×100 (509 = 5,09%) → Δclose/100 = Δ điểm-%; 1 đơn vị = +1pp = +100cb
    unit: "Δ lợi suất điểm-% = Δclose/100 (close = %×100) — 1 đơn vị chuỗi = +1pp = +100cb; logret KHÔNG hợp lệ cho lợi suất",
    isLog: false,
  },
  {
    key: "dxy",
    symbol: "DX-Y.NYB",
    label: "Chỉ số Đô la Mỹ (DXY)",
    unit: "log-return ngày (Bar.close = DXY×10.000 — hệ số triệt tiêu trong logret)",
    isLog: true,
  },
  {
    key: "gold",
    symbol: "GC=F",
    label: "Vàng COMEX (GC=F)",
    unit: "log-return ngày (Bar.close = cents×100 — hệ số triệt tiêu trong logret)",
    isLog: true,
  },
];

/** Số phiên chung mặc định cho hồi quy beta (đặc tả F-14). */
export const BETA_LOOKBACK = 250;
/** Ngưỡng tối thiểu cặp quan sát để tính beta (N2 — dưới ngưỡng → null). */
export const MIN_BETA_OBS = 60;
/** Số path MC mặc định (đặc tả F-14). */
export const MC_FACTOR_PATHS = 10_000;
/** Horizon MC (phiên) — khớp horizon 5 phiên của MC bootstrap có sẵn. */
export const MC_FACTOR_HORIZON = 5;
/** Seed cố định 12914 (task 129-C) — deterministic, tái lập. */
export const MC_FACTOR_SEED = 12_914;
/** Lấy đủ ~250 phiên chung cần ~800 ngày lịch (DXY/GC mới backfill ~1 năm). */
const BAR_CUTOFF_DAYS = 800;
/** NAV danh nghĩa khi proxy mode mà tài khoản không đọc được số dư (> 0). */
const PROXY_NOMINAL_NAV = 200_000_000;

/** Đầu vào một vị thế cho ước lượng beta (runScenarioAnalysis tự query DB). */
export interface ScenarioPositionInput {
  instrumentId: string;
  symbol: string;
  /** null ở proxy mode (rổ mô phỏng, không có vị thế thật). */
  qty: number | null;
  /** Giá trị thị trường VND (quote last × qty; proxy: NAV/n). */
  marketValueVnd: number;
}

/** Beta của 1 vị thế theo 4 factor — null = chưa đủ dữ liệu (N2). */
export type FactorBetas = Record<FactorKey, number | null>;

/** Kết quả beta một vị thế. */
export interface PositionBeta extends ScenarioPositionInput {
  betas: FactorBetas;
  /** Số cặp quan sát thực dùng hồi quy (phiên chung MÃ có bar tại cả 2 mốc). */
  obs: number;
  /** "ok" | "insufficient-beta-history" (N2 — UI hiển thị khai báo). */
  status: "ok" | "insufficient-beta-history";
}

/** Thông tin 1 chuỗi factor sau căn chỉnh cửa sổ chung. */
export interface FactorSeriesInfo {
  key: FactorKey;
  symbol: string;
  label: string;
  unit: string;
  obs: number;
  /** σ ngày theo ĐÚNG đơn vị chuỗi khai báo (logret / điểm-%). */
  stdevDaily: number;
}

/** Kết quả estimateFactorBetas (đầu vào cho MC + stress). */
export interface BetaEstimation {
  positions: PositionBeta[];
  factors: FactorSeriesInfo[];
  /** Ma trận hiệp phương sai 4×4 cùng thứ tự FACTOR_DEFS (đơn vị hỗn hợp khai báo). */
  covMatrix: number[][];
  window: { from: string; to: string; commonSessions: number; usedReturns: number };
  notes: string[];
}

/* ───────────────────── 1. estimateFactorBetas ───────────────────── */

/**
 * F-14a — ước lượng beta từng vị thế vs 4 factor bằng OLS đơn biến trên cửa
 * sổ `lookback` PHIÊN CHUNG cuối (ngày cả 4 factor có bar). Tự nạp Bar từ DB
 * (read-only). Mã thiếu < MIN_BETA_OBS cặp quan sát → beta null (N2, không bịa).
 *
 * β_i,f = corr(r_i, f) · σ(r_i)/σ(f)  (= cov/var — tái dùng statistics.ts)
 *
 * Trả về kèm ma trận hiệp phương sai factor (cho MC) + khai báo đơn vị.
 */
export async function estimateFactorBetas(
  positions: ScenarioPositionInput[],
  lookback = BETA_LOOKBACK
): Promise<BetaEstimation> {
  const notes: string[] = [];

  /* — 1a. Giải nghĩa instrument 4 factor — thiếu bất kỳ → lỗi rõ ràng — */
  const factorInsts = await db.instrument.findMany({
    where: { symbol: { in: FACTOR_DEFS.map((d) => d.symbol) } },
    select: { id: true, symbol: true },
  });
  const factorIdBySymbol = new Map(factorInsts.map((i) => [i.symbol, i.id]));
  const missing = FACTOR_DEFS.filter((d) => !factorIdBySymbol.has(d.symbol)).map((d) => d.symbol);
  if (missing.length > 0) {
    throw new Error(
      `Thiếu instrument factor (${missing.join(", ")}) — cần seed/sync vĩ mô (scripts/p106-seed-markets.ts + job 06:15).`
    );
  }

  /* — 1b. Bar 4 factor (read-only, close > 0) — */
  const cutoff = new Date(Date.now() - BAR_CUTOFF_DAYS * 86_400_000);
  const factorBars = await db.bar.findMany({
    where: { instrumentId: { in: [...factorIdBySymbol.values()] }, date: { gte: cutoff } },
    orderBy: { date: "asc" },
    select: { instrumentId: true, date: true, close: true },
  });
  // ISO date (yyyy-mm-dd, bar neo 15:00Z mọi thị trường) → close, theo factor
  const symbolByFactorId = new Map<string, string>();
  for (const [sym, id] of factorIdBySymbol) symbolByFactorId.set(id, sym);
  const closeBySymbol = new Map<string, Map<string, number>>();
  for (const d of FACTOR_DEFS) closeBySymbol.set(d.symbol, new Map());
  for (const b of factorBars) {
    if (!(b.close > 0)) continue;
    const sym = symbolByFactorId.get(b.instrumentId);
    if (sym) closeBySymbol.get(sym)!.set(b.date.toISOString().slice(0, 10), b.close);
  }

  /* — 1c. Phiên CHUNG = ngày cả 4 factor có bar (lịch VN ∩ Mỹ) — */
  let common = [...closeBySymbol.get("VNINDEX")!.keys()];
  for (const d of FACTOR_DEFS.slice(1)) {
    const s = closeBySymbol.get(d.symbol)!;
    common = common.filter((day) => s.has(day));
  }
  common.sort();
  if (common.length < MIN_BETA_OBS + 1) {
    throw new Error(
      `Chỉ có ${common.length} phiên chung cho 4 factor (cần ≥ ${MIN_BETA_OBS + 1}) — sync vĩ mô chưa đủ lịch sử.`
    );
  }
  // Cửa sổ: `lookback` RETURN cuối → cần lookback+1 ngày chung (trừ khi ít hơn)
  const usedReturns = Math.min(lookback, common.length - 1);
  const win = common.slice(-(usedReturns + 1));
  if (usedReturns < lookback) {
    notes.push(
      `Cửa sổ chung thực tế ${usedReturns} phiên (< ${lookback} mục tiêu — DXY/GC=F mới backfill ~1 năm, tự dài theo sync 06:15).`
    );
  }

  /* — 1d. Chuỗi factor từng BƯỚC chung (logret hoặc Δpp) + σ — */
  const stepFactor = (def: FactorDef, d0: string, d1: string): number => {
    const m = closeBySymbol.get(def.symbol)!;
    const c0 = m.get(d0)!;
    const c1 = m.get(d1)!;
    return def.isLog ? Math.log(c1 / c0) : (c1 - c0) / 100;
  };
  const factorSeries: Record<FactorKey, number[]> = {
    vnindex: [],
    us10yCb: [],
    dxy: [],
    gold: [],
  };
  for (let i = 1; i < win.length; i++) {
    for (const def of FACTOR_DEFS) factorSeries[def.key].push(stepFactor(def, win[i - 1], win[i]));
  }
  const factors: FactorSeriesInfo[] = FACTOR_DEFS.map((def) => ({
    key: def.key,
    symbol: def.symbol,
    label: def.label,
    unit: def.unit,
    obs: usedReturns,
    stdevDaily: stdev(factorSeries[def.key]),
  }));

  /* — 1e. Ma trận hiệp phương sai 4×4: cov_ij = corr·σᵢ·σⱼ (statistics.ts) — */
  const k = FACTOR_DEFS.length;
  const covMatrix: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      if (i === j) {
        covMatrix[i][j] = factors[i].stdevDaily * factors[i].stdevDaily;
      } else {
        const r = correlation(factorSeries[FACTOR_DEFS[i].key], factorSeries[FACTOR_DEFS[j].key]);
        covMatrix[i][j] = r == null ? 0 : r * factors[i].stdevDaily * factors[j].stdevDaily;
      }
    }
  }

  /* — 1f. Beta từng vị thế: OLS đơn biến trên CẶP ngày chung mã có đủ bar — */
  const positionResults: PositionBeta[] = [];
  if (positions.length > 0) {
    const stockBars = await db.bar.findMany({
      where: { instrumentId: { in: positions.map((p) => p.instrumentId) }, date: { gte: cutoff } },
      orderBy: { date: "asc" },
      select: { instrumentId: true, date: true, close: true },
    });
    const stockClose = new Map<string, Map<string, number>>();
    for (const b of stockBars) {
      if (!(b.close > 0)) continue;
      const m = stockClose.get(b.instrumentId) ?? new Map<string, number>();
      m.set(b.date.toISOString().slice(0, 10), b.close);
      stockClose.set(b.instrumentId, m);
    }

    for (const p of positions) {
      const closes = stockClose.get(p.instrumentId);
      const xs: number[] = [];
      const fs: Record<FactorKey, number[]> = { vnindex: [], us10yCb: [], dxy: [], gold: [] };
      if (closes) {
        for (let i = 1; i < win.length; i++) {
          const d0 = win[i - 1];
          const d1 = win[i];
          const c0 = closes.get(d0);
          const c1 = closes.get(d1);
          if (c0 == null || c1 == null || !(c0 > 0) || !(c1 > 0)) continue; // mã nghỉ phiên → bỏ cặp, không bịa ret 0
          xs.push(Math.log(c1 / c0));
          for (const def of FACTOR_DEFS) fs[def.key].push(stepFactor(def, d0, d1));
        }
      }
      const obs = xs.length;
      if (obs < MIN_BETA_OBS) {
        positionResults.push({
          ...p,
          betas: { vnindex: null, us10yCb: null, dxy: null, gold: null },
          obs,
          status: "insufficient-beta-history",
        });
        continue;
      }
      const sdX = stdev(xs);
      const betas: FactorBetas = { vnindex: null, us10yCb: null, dxy: null, gold: null };
      for (const def of FACTOR_DEFS) {
        const f = fs[def.key];
        const sdF = stdev(f);
        if (sdF <= 1e-12) continue; // factor phẳng trong cửa sổ — vô phương sai
        const r = correlation(xs, f);
        if (r != null) betas[def.key] = (r * sdX) / sdF; // = cov(x,f)/var(f)
      }
      positionResults.push({ ...p, betas, obs, status: "ok" });
    }
  }

  return {
    positions: positionResults,
    factors,
    covMatrix,
    window: {
      from: win[0],
      to: win[win.length - 1],
      commonSessions: common.length,
      usedReturns,
    },
    notes,
  };
}

/* ───────────────────── 2. monteCarloFactorSim ───────────────────── */

/** Kết quả MC factor (F-14b). */
export interface McFactorResult {
  /** Percentile 5% của P&L 5 phiên (% NAV — số ÂM;=-mcLoss5Pct của bản cũ). */
  pnlPct5: number;
  /** Expected Shortfall 99% (% NAV — lỗ KỲ VỌNG khi đã vượt VaR99, dương). */
  p99LossPct: number;
  /** VaR 95% 5 phiên (% NAV — dương). */
  var95Pct: number;
  /** VaR 99% 5 phiên (% NAV — dương). */
  var99Pct: number;
  /** Phân phối P&L RÚT GỌN (% NAV) — percentile [1,5,25,50,75,95,99] (không trả 10k path). */
  paths: { p1: number; p5: number; p25: number; p50: number; p75: number; p95: number; p99: number };
  nPaths: number;
  horizon: number;
  seed: number;
  /** > 0 = đã jitter đường chéo để Cholesky hội tụ; −1 = Cholesky thất bại. */
  choleskyJitter: number;
  /** != null = stats về 0 vì lý do này (NAV ≤ 0 / không có beta / Cholesky fail). */
  degenerate: string | null;
}

/** Cholesky hạ tam giác; thử jitter 0 → 1e-10 → 1e-8 → 1e-6 trên đường chéo. */
function choleskyWithJitter(m: number[][]): { L: number[][] | null; jitter: number } {
  const jitters = [0, 1e-10, 1e-8, 1e-6];
  for (const jitter of jitters) {
    const n = m.length;
    const L: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      for (let j = 0; j <= i; j++) {
        let s = m[i][j] + (i === j ? jitter : 0);
        for (let t = 0; t < j; t++) s -= L[i][t] * L[j][t];
        if (j === i) {
          if (!(s > 0)) {
            ok = false; // không PSD ở mức jitter này → thử mức kế
            break;
          }
          L[i][i] = Math.sqrt(s);
        } else {
          L[i][j] = s / L[j][j];
        }
      }
    }
    if (ok) return { L, jitter };
  }
  return { L: null, jitter: -1 };
}

/** Box-Muller: 1 cặp gauss chuẩn độc lập từ 2 uniform của RNG deterministic. */
function gaussianPair(rng: () => number): [number, number] {
  const u1 = Math.max(rng(), 1e-12); // tránh log(0)
  const u2 = rng();
  const r = Math.sqrt(-2 * Math.log(u1));
  return [r * Math.cos(2 * Math.PI * u2), r * Math.sin(2 * Math.PI * u2)];
}

/** Percentile kiểu order-statistic (sort + floor, không nội suy) — như tail.ts. */
function percentileSorted(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const idx = Math.min(n - 1, Math.max(0, Math.floor(p * n)));
  return sorted[idx];
}

/**
 * F-14b — Monte Carlo correlated theo mô hình factor:
 *   f ~ N(0, Σ·horizon)  (zero-drift — thuần phân phối RỦI RO, không kỳ vọng)
 *   P&L_path = Σᵢ MVᵢ × Σ_f βᵢ,f · f_f   (tuyến tính — công thức đặc tả F-14)
 * Beta null → đóng góp 0 (mã chưa đủ dữ liệu beta — khai báo ở caller).
 * Seed cố định (Mulberry32 tái dùng risk/tail.ts) → deterministic tái lập.
 */
export function monteCarloFactorSim(
  exposures: { marketValueVnd: number; betas: FactorBetas }[],
  covMatrix: number[][],
  nav: number,
  options: { nPaths?: number; horizon?: number; seed?: number } = {}
): McFactorResult {
  const nPaths = options.nPaths ?? MC_FACTOR_PATHS;
  const horizon = options.horizon ?? MC_FACTOR_HORIZON;
  const seed = options.seed ?? MC_FACTOR_SEED;
  const k = FACTOR_DEFS.length;
  const zero: McFactorResult = {
    pnlPct5: 0,
    p99LossPct: 0,
    var95Pct: 0,
    var99Pct: 0,
    paths: { p1: 0, p5: 0, p25: 0, p50: 0, p75: 0, p95: 0, p99: 0 },
    nPaths,
    horizon,
    seed,
    choleskyJitter: 0,
    degenerate: null,
  };
  if (covMatrix.length !== k || covMatrix.some((row) => row.length !== k)) {
    return { ...zero, degenerate: "covMatrix không đúng kích thước 4×4" };
  }
  // Phơi nhiễm factor CỔNG TỔNG danh mục: E_f = Σ MVᵢ·βᵢ,f (beta null → 0)
  const E = new Array<number>(k).fill(0);
  for (const p of exposures) {
    for (let f = 0; f < k; f++) {
      const b = p.betas[FACTOR_DEFS[f].key];
      if (b != null) E[f] += p.marketValueVnd * b;
    }
  }
  if (E.every((e) => Math.abs(e) < 1e-9)) {
    return { ...zero, degenerate: "không có beta hợp lệ nào (toàn bộ mã chưa đủ dữ liệu beta)" };
  }
  if (!(nav > 0)) {
    return { ...zero, degenerate: "NAV ≤ 0 — không quy % NAV được" };
  }
  const { L, jitter } = choleskyWithJitter(covMatrix);
  if (L == null) {
    return { ...zero, choleskyJitter: -1, degenerate: "Cholesky thất bại dù đã jitter (Σ không PSD)" };
  }

  const rng = mulberry32(seed);
  const sqrtH = Math.sqrt(horizon);
  const gauss = new Array<number>(k).fill(0);
  const pairsPerPath = Math.ceil(k / 2);
  const pnlPct = new Float64Array(nPaths);
  for (let p = 0; p < nPaths; p++) {
    for (let m = 0; m < pairsPerPath; m++) {
      const [a, b] = gaussianPair(rng);
      gauss[2 * m] = a;
      if (2 * m + 1 < k) gauss[2 * m + 1] = b;
    }
    // f = √horizon × (L·z); P&L = E·f (tuyến tính)
    let pnl = 0;
    for (let j = 0; j < k; j++) {
      let fj = 0;
      for (let m = 0; m <= j; m++) fj += L[j][m] * gauss[m];
      fj *= sqrtH;
      pnl += E[j] * fj;
    }
    pnlPct[p] = (pnl / nav) * 100;
  }
  const sorted = Float64Array.from(pnlPct).sort(); // TypedArray.sort() = số học
  const p1 = percentileSorted(sorted, 0.01);
  const p5 = percentileSorted(sorted, 0.05);
  // ES99 = −mean(đuôi lỗ ≤ percentile 1%)
  const tailIdx = Math.min(nPaths - 1, Math.floor(0.01 * nPaths));
  let tailSum = 0;
  for (let i = 0; i <= tailIdx; i++) tailSum += sorted[i];
  const es99 = -tailSum / (tailIdx + 1);

  return {
    pnlPct5: p5,
    p99LossPct: es99,
    var95Pct: -p5,
    var99Pct: -p1,
    paths: {
      p1,
      p5,
      p25: percentileSorted(sorted, 0.25),
      p50: percentileSorted(sorted, 0.5),
      p75: percentileSorted(sorted, 0.75),
      p95: percentileSorted(sorted, 0.95),
      p99: percentileSorted(sorted, 0.99),
    },
    nPaths,
    horizon,
    seed,
    choleskyJitter: jitter,
    degenerate: null,
  };
}

/* ───────────────────── 3. namedStressScenarios ───────────────────── */

/** P&L 1 vị thế trong 1 kịch bản. */
export interface StressPositionPnl {
  instrumentId: string;
  symbol: string;
  marketValueVnd: number;
  beta: number | null;
  /** null = mã chưa đủ dữ liệu beta (N2) — loại khỏi tổng, khai báo rõ. */
  pnlVnd: number | null;
  /** P&L / giá trị thị trường mã đó (%). */
  pnlPctMv: number | null;
}

/** Một kịch bản stress ĐẶT TÊN (xấp xỉ tĩnh, không MC). */
export interface NamedScenario {
  key: string;
  name: string;
  factorKey: FactorKey;
  factorSymbol: string;
  /** Trị số shock theo đơn vị chuỗi hồi quy (logret hoặc điểm-%). */
  shock: number;
  /** Diễn giải shock bằng ngôn ngữ người (kèm đổi đơn vị cb). */
  shockLabel: string;
  /** Khai báo proxy (vd "VND −2%" ≈ DXY +2%) khi kịch bản dùng proxy. */
  proxy: string | null;
  positions: StressPositionPnl[];
  totalPnlVnd: number;
  totalPnlPctNav: number;
  note: string;
}

/** P&L kịch bản dạng mũ: tên kịch bản nêu % đơn → log-shock → trả % đơn của mã. */
function stressPnl(mv: number, beta: number, shock: number): { pnlVnd: number; pnlPctMv: number } {
  const simpleRet = Math.exp(beta * shock) - 1; // cùng dấu với beta·shock (nghiệm thu dấu)
  return { pnlVnd: mv * simpleRet, pnlPctMv: simpleRet * 100 };
}

/**
 * F-14c — 5 kịch bản ĐẶT TÊN + baseline kiểm chứng dấu (xấp xỉ tĩnh, không MC):
 *   "VNINDEX −3%"  ·  "US10Y +50cb"  ·  "DXY +2%"  ·  "VND −2% (proxy DXY)"
 *   "Hàng hoá ±10%" = "GC=F +10%" + "GC=F −10%" (2 kịch bản con).
 * P&L_i = MV_i × (e^{β_i,f·shock} − 1) — đúng dấu theo beta: beta VNINDEX
 * dương + VNINDEX −3% ⇒ lỗ (baseline chứng minh).
 */
export function namedStressScenarios(positions: PositionBeta[], nav: number): NamedScenario[] {
  const defs: {
    key: string;
    name: string;
    factorKey: FactorKey;
    shock: number;
    shockLabel: string;
    proxy?: string;
    note: string;
  }[] = [
    {
      key: "vnindex-3",
      name: "VNINDEX −3%",
      factorKey: "vnindex",
      shock: Math.log(0.97),
      shockLabel: "VN-Index giảm 3% (log-shock −3,05%)",
      note: "Baseline kiểm chứng DẤU: mã beta VNINDEX dương phải LỖ trong kịch bản này.",
    },
    {
      key: "us10y+50cb",
      name: "US10Y +50cb",
      factorKey: "us10yCb",
      shock: 0.5,
      shockLabel: "Lợi suất T-10Y Mỹ +0,5 điểm-% = +50 cơ bản điểm (cb)",
      note: "Beta us10yCb tính theo +1 điểm-% (=+100cb) — đơn vị khai báo ở factors[].",
    },
    {
      key: "dxy+2",
      name: "DXY +2%",
      factorKey: "dxy",
      shock: Math.log(1.02),
      shockLabel: "Chỉ số Đô la Mỹ tăng 2% (log-shock +1,98%)",
      note: "Đô la mạnh — gió ngược thị trường mới nổi; beta dxy dương = rủi ro.",
    },
    {
      key: "vnd-2",
      name: "VND −2% (proxy DXY)",
      factorKey: "dxy",
      shock: Math.log(1.02),
      shockLabel: "VND mất giá 2% — mô hình hoá bằng DXY +2% (log-shock +1,98%)",
      proxy:
        "PROXY: chưa có beta VND trực tiếp (thiết kế F-14) — 'VND −2%' xấp xỉ bằng kịch bản DXY +2% vì VND mất giá thường đi kèm DXY tăng (tương quan VND=X ↔ DXY âm). Đây là xấp xỉ 1 CHIỀU, chỉ đúng khi diễn biến đi cùng hướng; không phải ước lượng trực tiếp từ chuỗi VND=X.",
      note: "Kịch bản tỷ giá dùng beta DXY làm proxy — đọc kỹ trường proxy trước khi trích dẫn.",
    },
    {
      key: "gold+10",
      name: "GC=F +10% (vàng)",
      factorKey: "gold",
      shock: Math.log(1.1),
      shockLabel: "Vàng COMEX +10% (log-shock +9,53%)",
      note: "Nửa thứ nhất của kịch bản kép 'Hàng hoá ±10%'.",
    },
    {
      key: "gold-10",
      name: "GC=F −10% (vàng)",
      factorKey: "gold",
      shock: Math.log(0.9),
      shockLabel: "Vàng COMEX −10% (log-shock −10,53%)",
      note: "Nửa thứ hai của kịch bản kép 'Hàng Hoá ±10%'.",
    },
  ];

  const out: NamedScenario[] = [];
  for (const d of defs) {
    const def = FACTOR_DEFS.find((f) => f.key === d.factorKey)!;
    const rows: StressPositionPnl[] = positions.map((p) => {
      const beta = p.betas[d.factorKey];
      if (beta == null) {
        return {
          instrumentId: p.instrumentId,
          symbol: p.symbol,
          marketValueVnd: p.marketValueVnd,
          beta: null,
          pnlVnd: null,
          pnlPctMv: null,
        };
      }
      const { pnlVnd, pnlPctMv } = stressPnl(p.marketValueVnd, beta, d.shock);
      return {
        instrumentId: p.instrumentId,
        symbol: p.symbol,
        marketValueVnd: p.marketValueVnd,
        beta,
        pnlVnd,
        pnlPctMv,
      };
    });
    const totalPnlVnd = rows.reduce((s, r) => s + (r.pnlVnd ?? 0), 0);
    const noBeta = rows.filter((r) => r.pnlVnd == null).map((r) => r.symbol);
    out.push({
      key: d.key,
      name: d.name,
      factorKey: d.factorKey,
      factorSymbol: def.symbol,
      shock: d.shock,
      shockLabel: d.shockLabel,
      proxy: d.proxy ?? null,
      positions: rows,
      totalPnlVnd,
      totalPnlPctNav: nav > 0 ? (totalPnlVnd / nav) * 100 : 0,
      note:
        noBeta.length > 0
          ? `${d.note} · ${noBeta.length} mã chưa đủ dữ liệu beta (${noBeta.join(", ")}) bị LOẠI khỏi tổng.`
          : d.note,
    });
  }
  return out;
}

/* ───────────────────── 4. runScenarioAnalysis ───────────────────── */

/** Báo cáo F-14 đầy đủ — JSON-serialisable (trả nguyên qua API). */
export interface ScenarioReport {
  asOf: string;
  proxyMode: boolean;
  /** Mô tả rổ proxy khi proxyMode (null khi chạy danh mục thật). */
  proxyNote: string | null;
  nav: number;
  lookback: number;
  positions: PositionBeta[];
  factors: {
    keys: FactorKey[];
    series: FactorSeriesInfo[];
    covMatrix: number[][];
    window: { from: string; to: string; commonSessions: number; usedReturns: number };
    alignment: string;
  };
  mc: McFactorResult;
  scenarios: NamedScenario[];
  notes: string[];
  durationMs: number;
}

/**
 * F-14 ORCHESTRATOR — query vị thế OPEN (0 vị thế → proxy rổ top-10 HOSE,
 * clone pattern settle bandit.ts) → beta → MC + stress → report.
 * Read-only: KHÔNG ghi RiskQuantSnapshot (main agent wiring sau), KHÔNG LLM.
 * Ngân sách < 2s cho ≤ 10 vị thế (5 truy vấn read-only + ~40k phép tính MC).
 */
export async function runScenarioAnalysis(): Promise<ScenarioReport> {
  const started = Date.now();
  const notes: string[] = [];

  /* — 4a. Vị thế thật + số dư tài khoản (pattern engine.ts F-102) — */
  const [positionRows, account] = await Promise.all([
    db.position
      .findMany({
        where: { status: "OPEN" },
        select: {
          quantity: true,
          avgPrice: true,
          instrumentId: true,
          instrument: {
            select: {
              symbol: true,
              quotes: { orderBy: { tradedAt: "desc" }, take: 1, select: { last: true } },
            },
          },
        },
      })
      .catch(() => []),
    db.brokerAccount
      .findFirst({ where: { deletedAt: null }, select: { cashBalance: true } })
      .catch(() => null),
  ]);
  const cash = account ? Number(account.cashBalance) : 0;

  let inputs: ScenarioPositionInput[] = [];
  let proxyMode = false;
  let proxyNote: string | null = null;

  if (positionRows.length > 0) {
    inputs = positionRows.map((p) => {
      const last = p.instrument.quotes[0]?.last ?? p.avgPrice; // fallback avgPrice như engine
      const qty = Number(p.quantity); // Int trong schema — Number() an toàn BigInt nếu đổi
      return {
        instrumentId: p.instrumentId,
        symbol: p.instrument.symbol,
        qty,
        marketValueVnd: last * qty,
      };
    });
  } else {
    /* — 4b. PROXY: rổ top-10 thanh khoản HOSE (clone bandit.ts settle —
       quote volume desc, khoá HOSE-STOCK tránh volume index tràn vào top) — */
    proxyMode = true;
    const instruments = await db.instrument
      .findMany({
        where: { isActive: true, market: "HOSE", type: "STOCK" },
        select: {
          id: true,
          symbol: true,
          quotes: { orderBy: { tradedAt: "desc" }, take: 1, select: { volume: true } },
        },
      })
      .catch(() => []);
    const top = instruments
      .map((i) => (i.quotes[0] ? { id: i.id, symbol: i.symbol, volume: i.quotes[0].volume } : null))
      .filter((r): r is { id: string; symbol: string; volume: number } => r !== null)
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 10);
    if (top.length === 0) {
      throw new Error("Không có vị thế OPEN và không dựng được rổ proxy top-10 HOSE (thiếu quote).");
    }
    const nav = cash > 0 ? cash : PROXY_NOMINAL_NAV;
    if (cash <= 0) {
      notes.push(
        `Không đọc được số dư tài khoản — NAV danh nghĩa ${PROXY_NOMINAL_NAV.toLocaleString("vi-VN")}₫ (hằng số proxy, khai báo trung thực).`
      );
    }
    inputs = top.map((t) => ({
      instrumentId: t.id,
      symbol: t.symbol,
      qty: null,
      marketValueVnd: nav / top.length, // equal-weight như rổ settle bandit
    }));
    proxyNote = `Không có vị thế OPEN — dùng rổ proxy top-${top.length} thanh khoản HOSE (equal-weight ${nav.toLocaleString("vi-VN")}₫ NAV), MV mỗi mã = NAV/${top.length}. Số liệu là MÔ PHỎNG cho mục đích phân tích, không phải phơi nhiễm thật.`;
    notes.push(proxyNote);
  }

  /* — 4c. Beta + ma trận hiệp phương sai factor — */
  const est = await estimateFactorBetas(inputs, BETA_LOOKBACK);
  notes.push(...est.notes);
  const nav =
    proxyMode ? inputs.reduce((s, p) => s + p.marketValueVnd, 0) : cash + inputs.reduce((s, p) => s + p.marketValueVnd, 0);

  /* — 4d. MC correlated + stress đặt tên — */
  const mc = monteCarloFactorSim(est.positions, est.covMatrix, nav);
  const scenarios = namedStressScenarios(est.positions, nav);

  /* — 4e. Ghi chú minh bạch (E6/N1/N2 + giới hạn mô hình) — */
  notes.unshift(
    "F-14 #129-C MỞ RỘNG MC bootstrap vô điều kiện sẵn có trong RiskQuantSnapshot (mcLoss5Pct/mcPDd — risk/tail.ts CRB-3): bản này điều kiện hoá theo 4 factor vĩ mô; KHÔNG ghi đè/KHÔNG thay thế snapshot đó (theo E6)."
  );
  notes.push(
    "Đơn vị (N1): VNINDEX/DXY/GC=F dùng log-return ngày (hệ số ×100/×10.000/×100 của Bar.close tự triệt tiêu); US10Y dùng Δ lợi suất điểm-% (Δclose/100) — beta us10yCb theo +1pp = +100cb; +50cb = shock +0,5."
  );
  notes.push(
    `Cửa sổ ${est.window.usedReturns} phiên chung cuối (${est.window.from} → ${est.window.to}) — phiên chung = ngày CẢ 4 factor có bar (lịch VN ∩ Mỹ).`
  );
  notes.push(
    "Căn chỉnh cùng bước (contemporaneous): factor Mỹ đóng cửa ~21:00 ICT SAU phiên VN cùng ngày → beta đo đồng biến động risk-off chung, không phải hiệu ứng trễ; cần PIT nghiêm ngặt thì dùng alignMacroBefore (F-01)."
  );
  notes.push(
    `MC: f ~ N(0, Σ·${MC_FACTOR_HORIZON} phiên) zero-drift, P&L tuyến tính Σ MV·β·f — bỏ nhánh idiosyncratic nên đuôi lỗ THỰC có thể dài hơn (đối chiếu mcLoss5Pct của RiskQuantSnapshot). Seed ${MC_FACTOR_SEED} cố định — deterministic tái lập.`
  );
  const noBetaSyms = est.positions.filter((p) => p.status !== "ok").map((p) => p.symbol);
  if (noBetaSyms.length > 0) {
    notes.push(
      `N2 — ${noBetaSyms.length} mã chưa đủ ${MIN_BETA_OBS} phiên chung để ước lượng beta (${noBetaSyms.join(", ")}): beta null, loại khỏi MC và tổng kịch bản (khai báo, không bịa).`
    );
  }
  if (mc.degenerate) notes.push(`MC suy biến: ${mc.degenerate}.`);
  if (mc.choleskyJitter > 0) {
    notes.push(`Cholesky cần jitter ${mc.choleskyJitter.toExponential(1)} trên đường chéo Σ (vẫn PSD).`);
  }
  if (mc.choleskyJitter === -1) notes.push("Cholesky thất bại dù đã jitter — số MC về 0 (khai báo trung thực).");

  return {
    asOf: new Date().toISOString(),
    proxyMode,
    proxyNote,
    nav,
    lookback: BETA_LOOKBACK,
    positions: est.positions,
    factors: {
      keys: FACTOR_DEFS.map((d) => d.key),
      series: est.factors,
      covMatrix: est.covMatrix,
      window: est.window,
      alignment: "contemporaneous — cùng bước chung VN∩Mỹ (không trễ 1 phiên)",
    },
    mc,
    scenarios,
    notes,
    durationMs: Date.now() - started,
  };
}
