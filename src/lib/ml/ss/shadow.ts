/**
 * src/lib/ml/ss/shadow.ts — A/B SHADOW 14 NGÀY + GUARD NGẠC NHIÊN (Phase 1 vận hành).
 *
 * STATE_SPACE_BLUEPRINT quy tắc 5 + 6 (hiệu đính v1.1 F5 — SHADOW, không
 * dual-live):
 *   - Driver mới `ml-forecast.holt-ss` (A15b — id riêng, KHÔNG đè A15 đang
 *     sống) chạy 14 ngày ở chế độ BÓNG: mỗi settle ghi AuditLog SS_AB_LOG
 *     {driver, horizon, mean, sd, realised-through-logscore} nhưng KHÔNG đốt
 *     vào Bayes (2 driver cùng nguồn closes sống song song trong Bayes = đếm
 *     kép thông tin trend).
 *   - Hết 14 ngày so log-score (SS-11): chỉ khi THẮNG (log-score trung bình
 *     ngày mới > cũ) mới hoán đổi evidence + TẮT driver cũ (mode "live") —
 *     audit SS_AB_VERDICT ghi quyết định. Thua → giữ bóng tiếp.
 *   - Kill-switch riêng từng tầng (AppSetting, tắt không restart): ml-ss-shadow
 *     (A/B bóng) · ml-ss-surprise (guard SS-7). Mọi lần chạy đều audit — im
 *     lặng là lỗi giám sát (bài học F-166c-1).
 *   - Guard ngạc nhiên SS-7: 1 lần/ngày sau settle — CUSUM-of-squares tin
 *     chính (F6), KS phụ Bonferroni, |e|>4 đơn phát. Phase 1 READ-ONLY: ghi
 *     audit SS_SURPRISE, KHÔNG hành động (4 tuần im lặng trước khi nối vào
 *     auto-retrain W3 có sẵn — F9).
 *
 * Lịch: engine :3003 đôn đốc POST /api/ml/ss-daily T2–T6 16:50 ICT (sau
 * settle 16:15 · k1 16:30 · council-eval 16:45 — EOD hôm nay đã sync).
 *
 * Hàm THUẦN (0 DB) tách riêng để scripts/p176 kiểm định kill-switch/decision
 * không cần DB (pattern psi-retrain.ts).
 */

import { db } from "@/lib/db";
import { loadSegmentBaskets } from "@/lib/ml/features";
import { buildBasketIndex } from "@/lib/bayes/evidence";
import { holtForecastPct } from "@/lib/quant/forecast";
import { holtSsFit, holtSsForecast } from "@/lib/ml/ss/holt-ss";
import { holdoutLogScores } from "@/lib/ml/ss/logscore";
import { bonferroniAlpha, surpriseDiagnostics, SURPRISE_WINDOW } from "@/lib/ml/ss/diag";

/* ───────────────────────── Cấu hình & kill-switch ───────────────────────── */

/** Kill-switch A/B bóng (AppSetting key). Mặc định BẬT — bóng chỉ ghi audit. */
export const SS_SHADOW_SETTING_KEY = "ml-ss-shadow";
/** Audit action của chu kỳ bóng (mỗi settle 1 dòng). */
export const SS_SHADOW_AUDIT_ACTION = "SS_AB_LOG";
/** Audit action quyết định hoán đổi (ghi 1 lần khi đủ 14 ngày). */
export const SS_AB_VERDICT_AUDIT_ACTION = "SS_AB_VERDICT";
/** Kill-switch guard ngạc nhiên SS-7. */
export const SS_SURPRISE_SETTING_KEY = "ml-ss-surprise";
/** Audit action guard ngạc nhiên (1 dòng/ngày tổng hợp 10 mã). */
export const SS_SURPRISE_AUDIT_ACTION = "SS_SURPRISE";

/** Số ngày bóng trước khi so sánh verdict (quy tắc 6). */
export const SS_AB_DAYS = 14;

/** Cửa sổ closes cho driver bóng (đúng PRIOR_SESSIONS của evidence). */
export const SS_BASKET_SESSIONS = 250;

/** Horizon evidence thật của cả 2 driver (A15 holt-basket dùng 5). */
export const SS_EVIDENCE_HORIZON = 5;

/** Kill-switch + trạng thái A/B bóng. */
export interface SsShadowSetting {
  enabled: boolean;
  /** shadow = chỉ log (mặc định) · live = hoán đổi evidence, driver cũ TẮT. */
  mode: "shadow" | "live";
  /** Thời điểm verdict hoán đổi được ghi (audit). */
  swappedAt?: string;
}

const DEFAULT_SHADOW: SsShadowSetting = { enabled: true, mode: "shadow" };

/** Cache in-process 60s — tránh query AppSetting mỗi assessment (pattern consensus.ts). */
let shadowCache: { value: SsShadowSetting; at: number } | null = null;

/** Đọc kill-switch A/B bóng (fallback mặc định shadow an toàn). */
export async function getSsShadowSetting(): Promise<SsShadowSetting> {
  if (shadowCache && Date.now() - shadowCache.at < 60_000) return shadowCache.value;
  let setting = DEFAULT_SHADOW;
  try {
    const row = await db.appSetting.findUnique({ where: { key: SS_SHADOW_SETTING_KEY } });
    if (row) {
      const parsed = JSON.parse(row.value) as Partial<SsShadowSetting>;
      setting = {
        enabled: parsed.enabled !== false,
        mode: parsed.mode === "live" ? "live" : "shadow",
        swappedAt: typeof parsed.swappedAt === "string" ? parsed.swappedAt : undefined,
      };
    }
  } catch {
    // AppSetting hỏng/missing → mặc định shadow (an toàn — không đổi hành vi Bayes)
  }
  shadowCache = { value: setting, at: Date.now() };
  return setting;
}

/** Ghi đè kill-switch (dùng khi verdict hoán đổi; cũng dùng toggle tay). */
export async function setSsShadowSetting(next: SsShadowSetting): Promise<void> {
  await db.appSetting.upsert({
    where: { key: SS_SHADOW_SETTING_KEY },
    update: { value: JSON.stringify(next), updatedAt: new Date() },
    create: { key: SS_SHADOW_SETTING_KEY, value: JSON.stringify(next) },
  });
  shadowCache = { value: next, at: Date.now() };
}

/** Kill-switch guard ngạc nhiên (mặc định BẬT — chỉ ghi audit read-only). */
export async function getSsSurpriseSetting(): Promise<{ enabled: boolean }> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: SS_SURPRISE_SETTING_KEY } });
    if (row) {
      const parsed = JSON.parse(row.value) as { enabled?: unknown };
      return { enabled: parsed.enabled !== false };
    }
  } catch {
    // fail-soft: mặc định bật
  }
  return { enabled: true };
}

/** Xoá cache (test/toggle ngoài tiến trình). */
export function clearSsShadowCache(): void {
  shadowCache = null;
}

/* ───────────────────── Hàm THUẦN (0 DB — p176 kiểm định) ───────────────────── */

/**
 * Trọng số evidence theo z (SS-2 — thay hardcode 0,65): sàn 0,3 · ceiling 0,9
 * (chống overconfident khi |z| lớn — HOSE đuôi dày). |z| ≥ 2,5 → chạm trần.
 */
export function zWeight(z: number): number {
  const az = Math.abs(z);
  if (!Number.isFinite(az)) return 0.3;
  return Math.min(0.9, 0.3 + 0.6 * Math.min(1, az / 2.5));
}

/**
 * Guard phình sd (SS-2): sd dự báo h=5 > 3× sd cửa sổ cuộn 250 phiên cùng
 * horizon → trọng số 0 (fail-soft trung thực — "model tự nhận tôi không biết").
 */
export function sdInflated(sdPctH5: number, rollingSdPctH5: number): boolean {
  if (!(rollingSdPctH5 > 0) || !Number.isFinite(sdPctH5)) return false;
  return sdPctH5 > 3 * rollingSdPctH5;
}

/** Dự báo rút gọn để hàm decision thuần không phải tính lại fit. */
export interface SsForecastBrief {
  meanPct: number;
  sdPct: number;
  pUp: number | null;
  z: number;
  weight: number;
}

/** Ngữ cảnh sd cuộn (guard SS-2). */
export interface SsDecisionContext {
  rollingSdPctH5: number;
}

/** Kết quả decision evidence (thuần — evidence.ts tiêu thụ). */
export interface SsEvidenceDecision {
  push: boolean;
  reason: string;
  source?: string;
  gen1?: string;
  weight?: number;
  direction?: "UP" | "DOWN";
  likelihoodRatio?: number;
}

/**
 * Quyết định có đốt evidence A15b vào Bayes hay không (THUẦN — p176 T8/T9):
 *   kill-switch off → KHÔNG (hệ về đúng hành vi cũ — checklist Phụ lục B)
 *   mode shadow    → KHÔNG (bóng chỉ log — quy tắc 6)
 *   mode live + w=0 (sd-guard) → KHÔNG (fail-soft)
 *   mode live + w>0 → CÓ — source "ml-forecast.holt-ss", gen1 A15b, trọng số
 *   theo z, lr mirror công thức driver cũ (so sánh A/B công bằng).
 */
export function ssEvidenceDecision(
  setting: SsShadowSetting,
  fc: SsForecastBrief,
  ctx: SsDecisionContext
): SsEvidenceDecision {
  if (!setting.enabled) {
    return { push: false, reason: "kill-switch ml-ss-shadow TẮT — hệ về đúng hành vi trước đó" };
  }
  if (setting.mode !== "live") {
    return { push: false, reason: "shadow-mode — KHÔNG đốt vào Bayes (quy tắc 6, tránh đếm kép)" };
  }
  if (fc.weight <= 0) {
    return { push: false, reason: "sd-guard phình — model tự nhận không biết (SS-2 fail-soft)" };
  }
  const strength = Math.min(1, Math.abs(fc.meanPct) / 1.5);
  return {
    push: true,
    reason: "live — hoán đổi evidence sau khi thắng log-score 14 ngày (SS_AB_VERDICT)",
    source: "ml-forecast.holt-ss",
    gen1: "A15b",
    weight: fc.weight,
    direction: fc.meanPct > 0 ? "UP" : "DOWN",
    likelihoodRatio: Math.min(1.9, 1 + 0.9 * strength),
  };
}

/** Ngày ICT (UTC+7) dạng YYYY-MM-DD — khóa "1 dòng/ngày" của audit. */
export function ictDate(d: Date = new Date()): string {
  return new Date(d.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
}

/* ───────────────────────── Chu kỳ bóng (mỗi settle) ───────────────────────── */

export interface SsShadowCycleResult {
  outcome: "ran" | "skip-disabled" | "skip-insufficient-data" | "error";
  reason?: string;
  daysElapsed?: number;
  mode?: "shadow" | "live";
  adv?: number | null;
  verdict?: string | null;
}

/** sd cuộn của biến động 5-phiên (%) trên cửa sổ — guard SS-2. */
function rollingSdPctH5(closes: number[]): number {
  if (closes.length < 12) return 0;
  const rets: number[] = [];
  for (let i = 0; i + 5 < closes.length; i++) {
    if (closes[i] > 0) rets.push(((closes[i + 5] - closes[i]) / closes[i]) * 100);
  }
  if (rets.length < 2) return 0;
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const v = rets.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (rets.length - 1);
  return Math.sqrt(Math.max(v, 0));
}

/**
 * Chu kỳ bóng: tính A/B trên rổ HOSE (PIT — closes kết thúc hôm nay), ghi
 * SS_AB_LOG, kiểm verdict 14 ngày. Fail-soft tuyệt đối (route trả error chứ
 * không sập).
 */
export async function runSsShadowCycle(): Promise<SsShadowCycleResult> {
  try {
    const setting = await getSsShadowSetting();
    if (!setting.enabled) {
      return { outcome: "skip-disabled", reason: "kill-switch ml-ss-shadow TẮT" };
    }

    const baskets = await loadSegmentBaskets(SS_BASKET_SESSIONS + 10);
    const hose = baskets.find((b) => b.segment === "VN-HOSE-STOCK");
    if (!hose || hose.symbols.length === 0) {
      return { outcome: "skip-insufficient-data", reason: "không tải được rổ VN-HOSE-STOCK" };
    }
    const basketCloses = buildBasketIndex(
      hose.symbols.map((s) => s.closes),
      SS_BASKET_SESSIONS
    );
    if (basketCloses.length < 120) {
      return {
        outcome: "skip-insufficient-data",
        reason: `basket closes ${basketCloses.length} < 120`,
      };
    }

    /* A/B log-score trên holdout (tham số đóng băng — logscore.ts) */
    const ab = holdoutLogScores(basketCloses, { horizons: [1, SS_EVIDENCE_HORIZON] });
    if (!ab) {
      return { outcome: "skip-insufficient-data", reason: "cửa sổ quá ngắn cho holdout log-score" };
    }

    /* Dự báo hiện tại (h=5) của cả 2 driver trên TOÀN cửa sổ — đánh giá bóng */
    const fit = holtSsFit(basketCloses);
    const ssFc = fit ? holtSsForecast(fit, basketCloses, SS_EVIDENCE_HORIZON) : null;
    const oldFc = holtForecastPct(basketCloses, { horizon: SS_EVIDENCE_HORIZON });
    const rollSd = rollingSdPctH5(basketCloses);
    const hIdx = SS_EVIDENCE_HORIZON - 1;
    const z5 = ssFc?.z[hIdx] ?? 0;
    const sd5 = ssFc?.sdPct[hIdx] ?? 0;
    const brief: SsForecastBrief = {
      meanPct: ssFc?.meanPct[hIdx] ?? 0,
      sdPct: sd5,
      pUp: ssFc?.pUp ?? null,
      z: z5,
      weight: sdInflated(sd5, rollSd) ? 0 : zWeight(z5),
    };
    const decision = ssEvidenceDecision(setting, brief, { rollingSdPctH5: rollSd });

    /* Lợi thế ngày: trung bình 2 horizon của mới trừ cũ (thước verdict SS-11) */
    const ssMean = (h: number) => ab.ss.find((s) => s.h === h)?.mean ?? 0;
    const oldMean = (h: number) => ab.holt.find((s) => s.h === h)?.mean ?? 0;
    const adv =
      ((ssMean(1) + ssMean(SS_EVIDENCE_HORIZON)) / 2 -
        (oldMean(1) + oldMean(SS_EVIDENCE_HORIZON)) / 2);

    /* Số ngày bóng đã chạy (ngày ICT phân biệt từ audit) */
    const priorRows = await db.auditLog.findMany({
      where: { action: SS_SHADOW_AUDIT_ACTION },
      orderBy: { createdAt: "desc" },
      take: 60,
      select: { createdAt: true },
    });
    const days = new Set(priorRows.map((r) => ictDate(r.createdAt)));
    const daysElapsed = days.size; // dòng sắp ghi sẽ cộng 1 nếu ngày mới

    const after = JSON.stringify({
      phase: "ab-shadow",
      mode: setting.mode,
      daysElapsed: daysElapsed + 1,
      totalDays: SS_AB_DAYS,
      window: { closes: basketCloses.length, trainN: ab.trainN, holdoutN: ab.holdoutN },
      new: {
        driver: "ml-forecast.holt-ss",
        gen1: "A15b",
        forecastH5: {
          meanPct: Number(brief.meanPct.toFixed(4)),
          sdPct: Number(brief.sdPct.toFixed(4)),
          pUp: brief.pUp != null ? Number(brief.pUp.toFixed(4)) : null,
          z: Number(brief.z.toFixed(3)),
          weightZ: Number(brief.weight.toFixed(3)),
          sdGuard: sdInflated(sd5, rollSd),
          rollingSdPctH5: Number(rollSd.toFixed(4)),
        },
        params: {
          sigma2Eps: fit?.sigma2Eps ?? null,
          sigma2EtaMu: fit?.sigma2EtaMu ?? null,
          sigma2EtaB: fit?.sigma2EtaB ?? null,
          logLik: fit?.logLik ?? null,
          converged: fit?.converged ?? null,
        },
        logScore: {
          h1: { n: ab.ss.find((s) => s.h === 1)?.n ?? 0, mean: ssMean(1) },
          h5: {
            n: ab.ss.find((s) => s.h === SS_EVIDENCE_HORIZON)?.n ?? 0,
            mean: ssMean(SS_EVIDENCE_HORIZON),
          },
        },
      },
      old: {
        driver: "ml-forecast.holt-basket",
        gen1: "A15",
        forecastH5: oldFc
          ? {
              expectedPct: Number(oldFc.expectedPct.toFixed(4)),
              lowPct: Number(oldFc.lowPct.toFixed(4)),
              highPct: Number(oldFc.highPct.toFixed(4)),
              sigmaPct: Number(oldFc.sigmaPct.toFixed(4)),
            }
          : null,
        logScore: {
          h1: { n: ab.holt.find((s) => s.h === 1)?.n ?? 0, mean: oldMean(1) },
          h5: {
            n: ab.holt.find((s) => s.h === SS_EVIDENCE_HORIZON)?.n ?? 0,
            mean: oldMean(SS_EVIDENCE_HORIZON),
          },
        },
      },
      advDaily: Number(adv.toFixed(4)),
      evidenceDecision: { push: decision.push, reason: decision.reason },
      verdict: "shadow — không đốt vào Bayes (quy tắc 6)",
    });

    await db.auditLog.create({
      data: {
        action: SS_SHADOW_AUDIT_ACTION,
        entity: "MlModel",
        entityId: "holt-ss-shadow",
        after,
      },
    });

    /* Verdict 14 ngày — tính MỘT LẦN (guard audit SS_AB_VERDICT tồn tại) */
    let verdictNote: string | null = null;
    if (daysElapsed + 1 >= SS_AB_DAYS && setting.mode === "shadow") {
      const already = await db.auditLog.findFirst({
        where: { action: SS_AB_VERDICT_AUDIT_ACTION },
        select: { id: true },
      });
      if (!already) {
        // Lợi thế luỹ kế: trung bình advDaily trên mọi dòng bóng đã ghi
        const allRows = await db.auditLog.findMany({
          where: { action: SS_SHADOW_AUDIT_ACTION },
          orderBy: { createdAt: "asc" },
          select: { after: true },
          take: 120,
        });
        let sumAdv = 0;
        let cntAdv = 0;
        for (const r of allRows) {
          try {
            const p = JSON.parse(r.after) as { advDaily?: unknown };
            if (typeof p.advDaily === "number" && Number.isFinite(p.advDaily)) {
              sumAdv += p.advDaily;
              cntAdv++;
            }
          } catch {
            // after hỏng — bỏ dòng (trung thực)
          }
        }
        const cumAdv = cntAdv > 0 ? sumAdv / cntAdv : 0;
        const win = cumAdv > 0;
        if (win) {
          await setSsShadowSetting({
            ...setting,
            mode: "live",
            swappedAt: new Date().toISOString(),
          });
        }
        await db.auditLog.create({
          data: {
            action: SS_AB_VERDICT_AUDIT_ACTION,
            entity: "MlModel",
            entityId: "holt-ss-shadow",
            after: JSON.stringify({
              decision: win ? "swap-to-live" : "keep-shadow",
              days: daysElapsed + 1,
              cumulativeAdv: Number(cumAdv.toFixed(4)),
              rule: "log-score (SS-11) trung bình ngày: mới > cũ mới hoán đổi evidence + tắt driver cũ (quy tắc 6)",
              swappedAt: win ? new Date().toISOString() : null,
            }),
          },
        });
        verdictNote = win
          ? `Đủ ${daysElapsed + 1} ngày bóng + log-score thắng (${cumAdv.toFixed(4)}) → ĐÃ hoán đổi evidence A15b (driver cũ TẮT)`
          : `Đủ ${daysElapsed + 1} ngày bóng nhưng log-score thua (${cumAdv.toFixed(4)}) → giữ bóng tiếp`;
      }
    }

    return {
      outcome: "ran",
      daysElapsed: daysElapsed + 1,
      mode: setting.mode,
      adv,
      verdict: verdictNote,
    };
  } catch (err) {
    return {
      outcome: "error",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/* ─────────────────── Guard ngạc nhiên SS-7 (1 lần/ngày) ─────────────────── */

export interface SsSurpriseCycleResult {
  outcome: "ran" | "skip-disabled" | "skip-insufficient-data" | "error";
  reason?: string;
  checked?: number;
  flagged?: number;
  tier?: string;
}

/**
 * Guard ngạc nhiên: fit local linear trend trên LOG-GIÁ từng mã rổ top-10
 * HOSE (cửa sổ 250, tham số đóng băng mỗi đêm — blueprint SS-7), chấm CUSUM
 * e²−1 (tin chính) + KS Bonferroni (phụ) + |e|>4. GHI AUDIT READ-ONLY —
 * Phase 1 không hành động (4 tuần im lặng trước khi nối auto-retrain W3).
 */
export async function runSsSurpriseCheck(): Promise<SsSurpriseCycleResult> {
  try {
    const { enabled } = await getSsSurpriseSetting();
    if (!enabled) {
      return { outcome: "skip-disabled", reason: "kill-switch ml-ss-surprise TẮT" };
    }
    const baskets = await loadSegmentBaskets(SS_BASKET_SESSIONS + 10);
    const hose = baskets.find((b) => b.segment === "VN-HOSE-STOCK");
    if (!hose || hose.symbols.length === 0) {
      return { outcome: "skip-insufficient-data", reason: "không tải được rổ VN-HOSE-STOCK" };
    }
    const symbols = hose.symbols.slice(0, 10);
    const alpha = bonferroniAlpha(Math.max(1, symbols.length), 1);

    const checked: {
      symbol: string;
      n: number;
      cusum: number;
      ksP: number;
      maxAbsE: number;
      flagged: boolean;
      reasons: string[];
    }[] = [];
    const skipped: { symbol: string; reason: string }[] = [];

    for (const s of symbols) {
      const closes = s.closes.slice(-SS_BASKET_SESSIONS);
      if (closes.length < 60 || closes.some((c) => !(c > 0))) {
        skipped.push({ symbol: s.symbol, reason: `closes ${closes.length} < 60 hoặc có giá ≤ 0` });
        continue;
      }
      const logCloses = closes.map((c) => Math.log(c));
      const fit = holtSsFit(logCloses);
      if (!fit) {
        skipped.push({ symbol: s.symbol, reason: "fit không hội tụ (chuỗi ngắn)" });
        continue;
      }
      const e = fit.innovations.slice(-SURPRISE_WINDOW).map((i) => i.e);
      const diag = surpriseDiagnostics(e, { alpha });
      checked.push({
        symbol: s.symbol,
        n: diag.n,
        cusum: Number(diag.cusum.toFixed(3)),
        ksP: Number(diag.ksP.toFixed(5)),
        maxAbsE: Number(diag.maxAbsE.toFixed(2)),
        flagged: diag.flagged,
        reasons: diag.reasons,
      });
    }

    if (checked.length === 0) {
      return { outcome: "skip-insufficient-data", reason: "0 mã đủ điều kiện kiểm định" };
    }

    const flaggedCount = checked.filter((c) => c.flagged).length;
    const tier = flaggedCount / checked.length > 0.3 ? "surprise-broad" : "normal";

    await db.auditLog.create({
      data: {
        action: SS_SURPRISE_AUDIT_ACTION,
        entity: "DataQuality",
        entityId: "ss-surprise",
        after: JSON.stringify({
          date: ictDate(),
          checked,
          skipped,
          flaggedCount,
          tier,
          bonferroniAlpha: alpha,
          action: "read-only-phase1",
          note:
            tier === "surprise-broad"
              ? `>30% rổ sốc (${flaggedCount}/${checked.length}) — cùng tín hiệu với PSI W3, Phase 1 chỉ ghi audit (chưa nối auto-retrain)`
              : `${flaggedCount}/${checked.length} mã sốc — trong ngưỡng bình thường`,
        }),
      },
    });

    return { outcome: "ran", checked: checked.length, flagged: flaggedCount, tier };
  } catch (err) {
    return {
      outcome: "error",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
