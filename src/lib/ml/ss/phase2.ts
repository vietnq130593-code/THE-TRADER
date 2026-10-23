/**
 * src/lib/ml/ss/phase2.ts — STATE_SPACE_BLUEPRINT PHASE 2 vận hành (Task 178).
 *
 *   SS-8 · runSsDataFlagCycle — AUXILIARY RESIDUALS → cờ chất lượng dữ liệu
 *   (ch. 9): mỗi đêm (engine đôn đốc POST /api/ml/ss-daily T2–T6 16:50 ICT,
 *   sau council-eval) chạy SMOOTHER trên log-giá 10 mã rổ top ADTV HOSE —
 *   cửa sổ đã đóng, mục đích audit (chỗ HỢP PHÁP dùng smoother — quy tắc 2):
 *     |std smoothed obs residual| > 3,5 → cờ OUTLIER  (sốc quan sát — "dữ liệu bẩn")
 *     |std smoothed state residual| > 3,5 → cờ LEVEL_SHIFT (tin tức cấu trúc — "thị trường đổi chế")
 *   GIAI ĐOẠN 1 READ-ONLY (F7-v1.1): ghi AuditLog SS_DATA_FLAG + vào ngữ cảnh
 *   strategist (context/ss-block.ts) — KHÔNG đổi tuyển dòng train (đổi thì
 *   windowHash phải hash cả quyết định tuyển — triết lý F-166b-3).
 *
 *   SS-5 · runSsBetaCycle — β ĐỘNG W1 (ch. 8): TVP Kalman từng mã so VNINDEX
 *   (chuỗi căn LỊCH PHIÊN — SS-3 null-tolerant), β_{T|T} + Var(β) + phân tách
 *   rủi ro thị trường/idiosyncratic + cờ destabilising. Ghi AuditLog SS_BETA +
 *   vào ngữ cảnh strategist (hedge ratio dự phòng — future hook sizing).
 *
 * Kill-switch riêng từng tầng (AppSetting ml-ss-dataflag / ml-ss-beta, tắt
 * không restart — quy tắc 5) + audit CẢ lần skip (F-177-1) + fail-soft tuyệt
 * đối. KHÔNG đụng featureset dl-mlp / digest (Phần VI mục 3 — tầng driver
 * Bayes + context, chưa vào train-set).
 */

import { db } from "@/lib/db";
import { loadSegmentBaskets, type SegmentSymbol } from "@/lib/ml/features";
import { holtSsFit, holtSsRefitSteps } from "@/lib/ml/ss/holt-ss";
import { kalmanAuxResiduals } from "@/lib/ml/ss/kalman";
import { betaDecompose, betaDestabilising, tvpFit, type TvpFit } from "@/lib/ml/ss/tvp";
import { alignSeries, unionCalendar } from "@/lib/ml/ss/calendar";
import { auditSkip, ictDate, SS_BASKET_SESSIONS } from "@/lib/ml/ss/shadow";

/* ───────────────────────── Cấu hình & kill-switch ───────────────────────── */

/** Kill-switch cờ dữ liệu SS-8 (mặc định BẬT — read-only an toàn). */
export const SS_DATA_FLAG_SETTING_KEY = "ml-ss-dataflag";
/** Audit action cờ dữ liệu (1 dòng/ngày tổng hợp 10 mã). */
export const SS_DATA_FLAG_AUDIT_ACTION = "SS_DATA_FLAG";
/** Kill-switch β động SS-5 (mặc định BẬT — read-only + context). */
export const SS_BETA_SETTING_KEY = "ml-ss-beta";
/** Audit action β động (1 dòng/ngày). */
export const SS_BETA_AUDIT_ACTION = "SS_BETA";

/** Ngưỡng cờ aux residuals (blueprint SS-8: 3,5σ). */
export const SS_AUX_FLAG_THRESHOLD = 3.5;

/** Mã thị trường chuẩn cho β động (W1 — rổ HOSE so VNINDEX). */
export const SS_BETA_MARKET_SYMBOL = "VNINDEX";

type FlagSetting = { enabled: boolean };

const cache = new Map<string, { value: FlagSetting; at: number }>();

async function getFlagSetting(key: string, defaultEnabled = true): Promise<FlagSetting> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  let setting: FlagSetting = { enabled: defaultEnabled };
  try {
    const row = await db.appSetting.findUnique({ where: { key } });
    if (row) {
      const parsed = JSON.parse(row.value) as { enabled?: unknown };
      setting = { enabled: parsed.enabled !== false };
    }
  } catch {
    // AppSetting hỏng/missing → mặc định (an toàn — read-only)
  }
  cache.set(key, { value: setting, at: Date.now() });
  return setting;
}

/** Đọc kill-switch ml-ss-dataflag. */
export function getSsDataFlagSetting(): Promise<FlagSetting> {
  return getFlagSetting(SS_DATA_FLAG_SETTING_KEY, true);
}

/** Đọc kill-switch ml-ss-beta. */
export function getSsBetaSetting(): Promise<FlagSetting> {
  return getFlagSetting(SS_BETA_SETTING_KEY, true);
}

/** Xoá cache (test/toggle ngoài tiến trình). */
export function clearSsPhase2Cache(): void {
  cache.clear();
}

/* ─────────────────── Chồng giúp: rổ + lịch + returns ─────────────────── */

interface LoadedBasket {
  symbols: SegmentSymbol[];
  calendar: string[];
}

/** Rổ top-10 HOSE + lịch phiên union (cắt SS_BASKET_SESSIONS ngày cuối). */
async function loadTop10WithCalendar(): Promise<LoadedBasket | null> {
  const baskets = await loadSegmentBaskets(SS_BASKET_SESSIONS + 10);
  const hose = baskets.find((b) => b.segment === "VN-HOSE-STOCK");
  if (!hose || hose.symbols.length === 0) return null;
  const symbols = hose.symbols.slice(0, 10);
  const calendar = unionCalendar(symbols.map((s) => s.dates)).slice(-SS_BASKET_SESSIONS);
  if (calendar.length < 60) return null;
  return { symbols, calendar };
}

/** Returns 1 bước từ chuỗi căn lịch (null giữ null — SS-3). */
function alignedReturns(closes: (number | null)[]): (number | null)[] {
  const out: (number | null)[] = [null];
  for (let t = 1; t < closes.length; t++) {
    const a = closes[t - 1];
    const b = closes[t];
    out.push(a != null && b != null && a > 0 ? b / a - 1 : null);
  }
  return out;
}

/* ─────────────────── SS-8 · Chu kỳ cờ dữ liệu (mỗi đêm) ─────────────────── */

export interface SsDataFlagCycleResult {
  outcome: "ran" | "skip-disabled" | "skip-insufficient-data" | "error";
  reason?: string;
  checked?: number;
  outliers?: number;
  levelShifts?: number;
  trendShifts?: number;
}

/** Một cờ với ngày phiên + mức σ. */
interface FlagItem {
  date: string;
  std: number;
}

/** Kết quả 1 mã. */
interface SymbolFlags {
  symbol: string;
  n: number;
  present: number;
  outliers: FlagItem[];
  levelShifts: FlagItem[];
  trendShifts: FlagItem[];
  skippedVariance: number;
}

/**
 * Chu kỳ SS-8: smoother aux residuals trên log-giá từng mã → cờ OUTLIER /
 * LEVEL_SHIFT / TREND_SHIFT. READ-ONLY (không đổi tuyển dòng train — F7).
 */
export async function runSsDataFlagCycle(): Promise<SsDataFlagCycleResult> {
  try {
    const { enabled } = await getSsDataFlagSetting();
    if (!enabled) {
      await auditSkip("dataflag", "skip-disabled", "kill-switch ml-ss-dataflag TẮT");
      return { outcome: "skip-disabled", reason: "kill-switch ml-ss-dataflag TẮT" };
    }
    const loaded = await loadTop10WithCalendar();
    if (!loaded) {
      await auditSkip("dataflag", "skip-insufficient-data", "không tải được rổ VN-HOSE-STOCK / lịch < 60");
      return { outcome: "skip-insufficient-data", reason: "không tải được rổ VN-HOSE-STOCK" };
    }

    const flags: SymbolFlags[] = [];
    const skipped: { symbol: string; reason: string }[] = [];
    for (const s of loaded.symbols) {
      const { closes: alignedCloses, present } = alignSeries(s.dates, s.closes, loaded.calendar);
      if (present < 60 || alignedCloses.some((c) => c != null && !(c > 0))) {
        skipped.push({ symbol: s.symbol, reason: `closes có-mặt ${present} < 60 hoặc có giá ≤ 0` });
        continue;
      }
      const logCloses: (number | null)[] = alignedCloses.map((c) => (c == null ? null : Math.log(c)));
      const fit = holtSsFit(logCloses);
      if (!fit) {
        skipped.push({ symbol: s.symbol, reason: "fit MLE không hội tụ" });
        continue;
      }
      const refit = holtSsRefitSteps(logCloses, fit);
      if (!refit) {
        skipped.push({ symbol: s.symbol, reason: "refit steps lỗi" });
        continue;
      }
      const spec = {
        T: [
          [1, 1],
          [0, 1],
        ],
        Z: [1, 0],
        R: [
          [1, 0],
          [0, 1],
        ],
        Q: [
          [fit.sigma2EtaMu, 0],
          [0, fit.sigma2EtaB],
        ],
        H: fit.sigma2Eps,
      };
      const { aux, skippedVariance } = kalmanAuxResiduals(spec, refit.steps);
      const outliers: FlagItem[] = [];
      const levelShifts: FlagItem[] = [];
      const trendShifts: FlagItem[] = [];
      for (const a of aux) {
        const date = loaded.calendar[a.t] ?? String(a.t);
        if (a.observed && a.uSd != null && a.uSd > 0) {
          const std = a.uHat / a.uSd;
          if (Math.abs(std) > SS_AUX_FLAG_THRESHOLD) {
            outliers.push({ date, std: Number(std.toFixed(2)) });
          }
        }
        const eta0 = a.etaSd[0] ?? 0;
        if (eta0 > 0) {
          const std = (a.etaHat[0] ?? 0) / eta0;
          if (Math.abs(std) > SS_AUX_FLAG_THRESHOLD) {
            levelShifts.push({ date, std: Number(std.toFixed(2)) });
          }
        }
        const eta1 = a.etaSd[1] ?? 0;
        if (eta1 > 0) {
          const std = (a.etaHat[1] ?? 0) / eta1;
          if (Math.abs(std) > SS_AUX_FLAG_THRESHOLD) {
            trendShifts.push({ date, std: Number(std.toFixed(2)) });
          }
        }
      }
      flags.push({
        symbol: s.symbol,
        n: loaded.calendar.length,
        present,
        outliers,
        levelShifts,
        trendShifts,
        skippedVariance,
      });
    }

    if (flags.length === 0) {
      await auditSkip("dataflag", "skip-insufficient-data", "0 mã đủ điều kiện smoother");
      return { outcome: "skip-insufficient-data", reason: "0 mã đủ điều kiện smoother" };
    }

    const outliers = flags.reduce((s, f) => s + f.outliers.length, 0);
    const levelShifts = flags.reduce((s, f) => s + f.levelShifts.length, 0);
    const trendShifts = flags.reduce((s, f) => s + f.trendShifts.length, 0);

    await db.auditLog.create({
      data: {
        action: SS_DATA_FLAG_AUDIT_ACTION,
        entity: "DataQuality",
        entityId: "ss-dataflag",
        after: JSON.stringify({
          date: ictDate(),
          window: SS_BASKET_SESSIONS,
          threshold: SS_AUX_FLAG_THRESHOLD,
          checked: flags.length,
          skipped,
          symbols: flags,
          totals: { outliers, levelShifts, trendShifts },
          action: "read-only-phase2",
          note: "Cờ aux residuals (ch. 9 smoother — cửa sổ đóng, audit hợp pháp quy tắc 2): OUTLIER = sốc quan sát (dữ liệu bẩn) · LEVEL_SHIFT = đổi level thật (thị trường đổi chế). KHÔNG đổi tuyển dòng train (F7 — đổi thì windowHash phải hash quyết định tuyển).",
        }),
      },
    });

    return { outcome: "ran", checked: flags.length, outliers, levelShifts, trendShifts };
  } catch (err) {
    await auditSkip("dataflag", "error", err instanceof Error ? err.message : String(err));
    return {
      outcome: "error",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/* ─────────────────── SS-5 · Chu kỳ β động (mỗi đêm) ─────────────────── */

export interface SsBetaCycleResult {
  outcome: "ran" | "skip-disabled" | "skip-insufficient-data" | "error";
  reason?: string;
  checked?: number;
  destabilising?: number;
}

/** Kết quả 1 mã. */
interface SymbolBeta {
  symbol: string;
  beta: number;
  betaSd: number;
  alpha: number;
  /** Tỉ lệ phương sai giải thích bởi thị trường (0..1). */
  systematicShare: number;
  destabilising: boolean;
  reasons: string[];
  presentPairs: number;
  params: {
    sigma2Eps: number;
    sigma2EtaAlpha: number;
    sigma2EtaBeta: number;
    logLik: number;
    converged: boolean;
  };
}

/**
 * Chu kỳ SS-5: TVP β từng mã so VNINDEX trên lịch phiên chung — ghi SS_BETA.
 * READ-ONLY đối với quyết định (chỉ vào strategist context + audit).
 */
export async function runSsBetaCycle(): Promise<SsBetaCycleResult> {
  try {
    const { enabled } = await getSsBetaSetting();
    if (!enabled) {
      await auditSkip("beta", "skip-disabled", "kill-switch ml-ss-beta TẮT");
      return { outcome: "skip-disabled", reason: "kill-switch ml-ss-beta TẮT" };
    }
    const baskets = await loadSegmentBaskets(SS_BASKET_SESSIONS + 10);
    const hose = baskets.find((b) => b.segment === "VN-HOSE-STOCK");
    const idx = baskets.find((b) => b.segment === "VN-INDEX");
    const market = idx?.symbols.find((s) => s.symbol === SS_BETA_MARKET_SYMBOL);
    if (!hose || hose.symbols.length === 0 || !market) {
      await auditSkip(
        "beta",
        "skip-insufficient-data",
        `không tải được rổ HOSE hoặc ${SS_BETA_MARKET_SYMBOL}`
      );
      return {
        outcome: "skip-insufficient-data",
        reason: `không tải được rổ HOSE hoặc ${SS_BETA_MARKET_SYMBOL}`,
      };
    }
    const symbols = hose.symbols.slice(0, 10);
    // Lịch chung: union ngày của 10 mã + VNINDEX (mã thiếu phiên → null — SS-3)
    const calendar = unionCalendar([
      ...symbols.map((s) => s.dates),
      market.dates,
    ]).slice(-SS_BASKET_SESSIONS);
    if (calendar.length < 60) {
      await auditSkip("beta", "skip-insufficient-data", "lịch phiên < 60");
      return { outcome: "skip-insufficient-data", reason: "lịch phiên < 60" };
    }

    const marketAligned = alignSeries(market.dates, market.closes, calendar).closes;
    const marketReturns = alignedReturns(marketAligned);
    const marketPresent = marketReturns.filter((r): r is number => r != null).length;
    if (marketPresent < 60) {
      await auditSkip("beta", "skip-insufficient-data", `VNINDEX returns có-mặt ${marketPresent} < 60`);
      return { outcome: "skip-insufficient-data", reason: `VNINDEX returns ${marketPresent} < 60` };
    }

    const results: SymbolBeta[] = [];
    const skipped: { symbol: string; reason: string }[] = [];
    for (const s of symbols) {
      const { closes: alignedCloses, present } = alignSeries(s.dates, s.closes, calendar);
      if (present < 60 || alignedCloses.some((c) => c != null && !(c > 0))) {
        skipped.push({ symbol: s.symbol, reason: `closes có-mặt ${present} < 60` });
        continue;
      }
      const symbolReturns = alignedReturns(alignedCloses);
      const fit: TvpFit | null = tvpFit(symbolReturns, marketReturns);
      if (!fit) {
        skipped.push({ symbol: s.symbol, reason: "TVP fit không đủ cặp dùng được" });
        continue;
      }
      const decomp = betaDecompose(fit, symbolReturns, marketReturns);
      const destab = betaDestabilising(fit);
      results.push({
        symbol: s.symbol,
        beta: Number(fit.betaT.toFixed(3)),
        betaSd: Number(fit.betaSdT.toFixed(3)),
        alpha: Number(fit.alphaT.toExponential(2)),
        systematicShare: Number(decomp.systematicShare.toFixed(3)),
        destabilising: destab.flagged,
        reasons: destab.reasons,
        presentPairs: fit.presentPairs,
        params: {
          sigma2Eps: fit.sigma2Eps,
          sigma2EtaAlpha: fit.sigma2EtaAlpha,
          sigma2EtaBeta: fit.sigma2EtaBeta,
          logLik: fit.logLik,
          converged: fit.converged,
        },
      });
    }

    if (results.length === 0) {
      await auditSkip("beta", "skip-insufficient-data", "0 mã đủ điều kiện TVP");
      return { outcome: "skip-insufficient-data", reason: "0 mã đủ điều kiện TVP" };
    }

    const destabilising = results.filter((r) => r.destabilising).length;
    const avgSystematic =
      results.reduce((s, r) => s + r.systematicShare, 0) / results.length;

    await db.auditLog.create({
      data: {
        action: SS_BETA_AUDIT_ACTION,
        entity: "MlModel",
        entityId: "ss-beta",
        after: JSON.stringify({
          date: ictDate(),
          market: SS_BETA_MARKET_SYMBOL,
          window: SS_BASKET_SESSIONS,
          calendarDays: calendar.length,
          checked: results.length,
          skipped,
          symbols: results,
          summary: {
            destabilising,
            avgSystematicShare: Number(avgSystematic.toFixed(3)),
            avgIdiosyncraticShare: Number((1 - avgSystematic).toFixed(3)),
          },
          action: "read-only-phase2",
          note: "β động TVP (ch. 8 — random walk, MLE 3 tham số, PIT filtered β_{T|T}): hedge ratio dự phòng strategist · tách rủi ro thị trường/idiosyncratic · cờ destabilising = Var(β) phình hoặc β dịch nhanh. Chưa nối sizing (future hook — blueprint SS-5).",
        }),
      },
    });

    return { outcome: "ran", checked: results.length, destabilising };
  } catch (err) {
    await auditSkip("beta", "error", err instanceof Error ? err.message : String(err));
    return {
      outcome: "error",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
