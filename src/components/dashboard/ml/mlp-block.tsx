"use client";

/**
 * ml/mlp-block.tsx (#89 — tách từ ml-panel.tsx #35/#79/#81) — khối
 * "MLP dự báo 5 phiên (học sâu)" của tab Tổng quan.
 */

import { Activity, Layers, Sigma } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type {
  DlMlpMetrics,
  MlAutoRetrainStatus,
  MlModelStatus,
  MlSsStatus,
} from "@/hooks/use-ml";
import {
  EmptyNote,
  Stat,
  StatusBadge,
  TrainedAtCaption,
  VersionBadge,
  accTone,
  type DriftStatus,
  driftLevelVisual,
  driftWorstLevel,
  nf0,
  nf1,
  nf2,
} from "./shared";

/* ───────────── B1 · badge bộ đặc trưng ───────────── */

/** Badge bộ đặc trưng — v2-lag16 nổi bật (secondary), v1-lag10 muted trung
 *  thực (bản serving train trước B1). Giá trị lạ hiển thị nguyên văn. */
function FeatureSetBadge({ featureSet }: { featureSet: string | null | undefined }) {
  const label = featureSet ?? "v1-lag10";
  const isV2 = label === "v2-lag16";
  return (
    <Badge
      variant={isV2 ? "secondary" : "outline"}
      className={cn(
        "font-mono text-[10px]",
        !isV2 && "text-muted-foreground"
      )}
      title={isV2 ? "Bộ 16 đặc trưng v2-lag16: 6 chiều lag/đạo hàm mới (B1)" : "Bộ 10 đặc trưng v1 (bản train trước B1)"}
    >
      {label}
    </Badge>
  );
}

/* ───────────── F-18B (#132) · badge kiến trúc ANN bản serving ───────────── */

/** Arch bản serving ("ANN 10-16-8-3") — cùng nguồn sự thật với sơ đồ trọng
 *  lượng thật ở tab Mạng thần kinh (weights JSON). Tooltip nói rõ đây là bản
 *  ĐANG dự báo, tách biệt với trình chỉnh sửa (cấu hình lần train kế tiếp) —
 *  trả lời câu hỏi chủ sở hữu “số nơ-rôn khác hẳn kiến trúc ANN trình
 *  chỉnh sửa”. Thiếu archString (weights cũ không parse được) → ẩn badge. */
function ServingArchBadge({
  archString,
  featureCount,
}: {
  archString: string | null | undefined;
  featureCount: number | null | undefined;
}) {
  if (archString == null) return null;
  return (
    <Badge
      variant="outline"
      className="font-mono text-[10px] font-semibold"
      title={
        `Kiến trúc ANN bản đang phục vụ: ${archString} (vào – các lớp ẩn – ra 3 xác suất Tăng/Ngang/Giảm)` +
        (featureCount != null ? ` · ${featureCount} đặc trưng z-score` : "") +
        " — đây là bản ĐANG dự báo 5 phiên. Trình chỉnh sửa ở tab Mạng thần kinh là cấu hình cho lần huấn luyện KẾ TIẾP (hai phần có thể khác nhau cho tới khi champion qua cổng hoặc train lại qua guard)."
      }
    >
      ANN {archString}
    </Badge>
  );
}

/* ───────────── Task 176 · tầng State Space (khối kiểm định 4 ô) ───────────── */

/**
 * SsShadowNote — STATE_SPACE_BLUEPRINT Phase 1 + Phase 2 (quy tắc 7: hiển thị
 * mới theo khối kiểm định 4 ô kiểu W3/W4). Hàng 1 (Task 176): (1) chế độ
 * bóng/live + ngày n/14, (2) log-score A/B mới vs cũ (SS-11), (3) guard ngạc
 * nhiên CUSUM SS-7 (đọc-only), (4) kill-switch 2 tầng. Hàng 2 (Task 178):
 * (5) CI80 dự báo rổ h=5 (SS-2 bullet 3 — driver mới predictive variance vs
 * driver cũ heuristic), (6) cờ dữ liệu SS-8 aux residuals (OUTLIER/LEVEL_SHIFT
 * read-only), (7) β động SS-5 TVP so VNINDEX, (8) kill-switch 2 tầng Phase 2.
 * Không có dữ liệu (API cũ/chưa chu kỳ nào) → ẩn im lặng như W3 (không bịa).
 */
function SsShadowNote({ ss }: { ss: MlSsStatus | null }) {
  if (!ss) return null;
  const live = ss.mode === "live";
  const winning = ss.cumulativeAdv != null && ss.cumulativeAdv > 0;
  const fmtPct = (v: number) =>
    `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
  return (
    <div className="rounded-lg border bg-muted/20 px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="flex items-center gap-1.5 text-[11px] font-medium">
          <Sigma className="size-3.5 text-muted-foreground" aria-hidden="true" />
          State Space · Holt-SS (Durbin–Koopman)
        </span>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {ss.lastAt
            ? `chu kỳ gần nhất ${new Date(ss.lastAt).toLocaleString("vi-VN")}`
            : "chưa có chu kỳ nào"}
        </span>
      </div>
      <div className="mt-1.5 grid grid-cols-1 gap-1.5 min-[420px]:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-md bg-background/60 px-2 py-1.5">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Chế độ A/B</div>
          <div className="text-xs font-semibold">
            {live ? (
              <span className="text-emerald-600 dark:text-emerald-400">LIVE — đã hoán đổi evidence A15b</span>
            ) : (
              <span>
                BÓNG <span className="text-muted-foreground">(không đốt vào Bayes)</span>{" "}
                <span className="tabular-nums text-muted-foreground">
                  {ss.days}/{ss.totalDays} ngày
                </span>
              </span>
            )}
          </div>
        </div>
        <div className="rounded-md bg-background/60 px-2 py-1.5">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Log-score h=1+h=5 (mới vs cũ)
          </div>
          <div className="text-xs font-semibold tabular-nums">
            {ss.newMeanLogScore != null && ss.oldMeanLogScore != null ? (
              <>
                {ss.newMeanLogScore.toFixed(3)} vs {ss.oldMeanLogScore.toFixed(3)}{" "}
                <span
                  className={
                    winning
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-amber-600 dark:text-amber-400"
                  }
                >
                  ({winning ? "mới đang thắng" : "mới chưa thắng"})
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">— chưa đủ dòng audit</span>
            )}
          </div>
        </div>
        <div className="rounded-md bg-background/60 px-2 py-1.5">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Guard ngạc nhiên (CUSUM e²−1)
          </div>
          <div className="text-xs font-semibold tabular-nums">
            {ss.lastSurpriseChecked != null ? (
              <>
                {ss.lastSurpriseFlagged ?? 0}/{ss.lastSurpriseChecked} mã sốc{" "}
                {ss.lastSurpriseTier === "surprise-broad" ? (
                  <span className="text-amber-600 dark:text-amber-400">(rộng &gt; 30% rổ)</span>
                ) : (
                  <span className="text-muted-foreground">(trong ngưỡng)</span>
                )}
              </>
            ) : (
              <span className="text-muted-foreground">— chưa chạy</span>
            )}
            <span className="block text-[10px] font-normal text-muted-foreground">
              Phase 1 đọc-only — KS Bonferroni phụ, CUSUM tin chính
            </span>
          </div>
        </div>
        <div className="rounded-md bg-background/60 px-2 py-1.5">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Kill-switch</div>
          <div className="text-xs font-semibold">
            <span className={ss.enabled ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}>
              ml-ss-shadow {ss.enabled ? "BẬT" : "TẮT"}
            </span>{" "}
            ·{" "}
            <span className={ss.surpriseEnabled ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}>
              ml-ss-surprise {ss.surpriseEnabled ? "BẬT" : "TẮT"}
            </span>
          </div>
        </div>
      </div>
      {/* ───── Task 178 · Phase 2 — hàng 4 ô thứ hai (additive — ẩn khi chưa có) ───── */}
      {(ss.forecast != null || ss.lastDataFlagAt != null || ss.lastBetaAt != null ||
        ss.dataFlagEnabled != null || ss.betaEnabled != null) && (
        <div className="mt-1.5 grid grid-cols-1 gap-1.5 min-[420px]:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-md bg-background/60 px-2 py-1.5">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              CI80 dự báo rổ h=5 (SS-2)
            </div>
            <div className="text-xs font-semibold tabular-nums">
              {ss.forecast?.newDriver != null || ss.forecast?.oldDriver != null ? (
                <>
                  {ss.forecast?.newDriver != null ? (
                    <>
                      mới <span className="text-muted-foreground">{fmtPct(ss.forecast.newDriver.lowPct)}…{fmtPct(ss.forecast.newDriver.highPct)}%</span>
                    </>
                  ) : null}
                  {ss.forecast?.newDriver != null && ss.forecast?.oldDriver != null ? (
                    <span className="text-muted-foreground"> · </span>
                  ) : null}
                  {ss.forecast?.oldDriver != null ? (
                    <>
                      cũ <span className="text-muted-foreground">{fmtPct(ss.forecast.oldDriver.lowPct)}…{fmtPct(ss.forecast.oldDriver.highPct)}%</span>
                    </>
                  ) : null}
                  <span className="block text-[10px] font-normal text-muted-foreground">
                    mới: mean ± 1,2816·sd (predictive variance MLE) · cũ: heuristic Z80·σ√h
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground">— chưa có dòng bóng</span>
              )}
            </div>
          </div>
          <div className="rounded-md bg-background/60 px-2 py-1.5">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Cờ dữ liệu SS-8 (aux residuals)
            </div>
            <div className="text-xs font-semibold tabular-nums">
              {ss.lastDataFlagChecked != null ? (
                <>
                  {ss.lastDataFlagOutliers ?? 0} outlier · {ss.lastDataFlagLevelShifts ?? 0} level-shift{" "}
                  <span className="text-muted-foreground">/ {ss.lastDataFlagChecked} mã</span>
                  <span className="block text-[10px] font-normal text-muted-foreground">
                    đọc-only Phase 2 — OUTLIER = dữ liệu bẩn · LEVEL_SHIFT = đổi chế
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground">— chưa chạy</span>
              )}
            </div>
          </div>
          <div className="rounded-md bg-background/60 px-2 py-1.5">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              β động SS-5 (TVP vs VNINDEX)
            </div>
            <div className="text-xs font-semibold tabular-nums">
              {ss.lastBetaChecked != null ? (
                <>
                  {(ss.topBetas ?? [])
                    .map((b) => `${b.symbol} β=${b.beta.toFixed(2)}±${b.betaSd.toFixed(2)}`)
                    .join(" · ") || `${ss.lastBetaChecked} mã`}
                  {ss.lastBetaChecked != null && (ss.topBetas?.length ?? 0) > 0 ? (
                    <span className="block text-[10px] font-normal text-muted-foreground">
                      {ss.lastBetaChecked} mã · {ss.lastBetaDestabilising ?? 0} destabilising (Var β phình)
                    </span>
                  ) : null}
                </>
              ) : (
                <span className="text-muted-foreground">— chưa chạy</span>
              )}
            </div>
          </div>
          <div className="rounded-md bg-background/60 px-2 py-1.5">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Kill-switch Phase 2
            </div>
            <div className="text-xs font-semibold">
              {ss.dataFlagEnabled == null && ss.betaEnabled == null ? (
                <span className="text-muted-foreground">— API chưa có tầng Phase 2</span>
              ) : (
                <>
                  <span className={ss.dataFlagEnabled ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}>
                    ml-ss-dataflag {ss.dataFlagEnabled ? "BẬT" : "TẮT"}
                  </span>{" "}
                  ·{" "}
                  <span className={ss.betaEnabled ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}>
                    ml-ss-beta {ss.betaEnabled ? "BẬT" : "TẮT"}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      )}
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
        Quy tắc hoán đổi: đủ {ss.totalDays} ngày bóng và log-score (SS-11) trung
        bình ngày của Holt-SS (MLE + predictive variance) vượt driver Holt
        heuristic cũ thì evidence A15 tự tắt, A15b lên thay — không chạy song
        song hai driver cùng nguồn (đếm kép thông tin trend). Thua thì bóng
        tiếp. Cờ SS-8/β SS-5 là kiểm định đọc-only — không tự chặn lệnh.{" "}
        <span className="sr-only"> — {ss.schedule}</span>
      </p>
    </div>
  );
}

/* ───────────── A3 · Drift PSI (badge + khối chi tiết) ───────────── */

/** Badge "Drift" cạnh version/status khối MLP — mức theo chiều PSI cao nhất. */
function DriftBadge({ drift }: { drift: DriftStatus | null }) {
  if (!drift || !drift.available) {
    return (
      <Badge variant="outline" className="text-[10px] text-muted-foreground">
        Drift: chưa có histogram
      </Badge>
    );
  }
  const visual = driftLevelVisual(driftWorstLevel(drift));
  return <Badge className={cn("text-[10px]", visual.className)}>Drift: {visual.label}</Badge>;
}

/** Khối phụ: top-3 chiều PSI cao nhất + n/asOf + dòng "đề xuất train lại" +
 *  trạng thái cơ chế auto-retrain W3 (#164) — engine tự train khi PSI ≥ 0,25. */
/** F-166b-5 (Fixbug #166 — Vòng 1): khối trạng thái W3 tách component riêng —
 *  render ở CẢ HAI nhánh (trước đây chỉ nằm trong nhánh drift available →
 *  serving chưa có histogram thì kill-switch/cooldown/lần trigger gần nhất
 *  vô hình dù API vẫn trả autoRetrain). Kèm: psiWarn format nf2 (vi-VN
 *  "0,25" — cùng dấu phẩy với dòng đề xuất phía trên). */
function AutoRetrainNote({
  autoRetrain,
}: {
  autoRetrain: MlAutoRetrainStatus | null;
}) {
  if (!autoRetrain) return null;
  return (
    <p className="mt-1.5 border-t pt-1.5 text-[11px] leading-relaxed text-muted-foreground">
      Tự train lại khi trôi dịch (W3):{" "}
      <strong className={autoRetrain.enabled ? "font-semibold text-emerald-600 dark:text-emerald-400" : "font-semibold text-rose-600 dark:text-rose-400"}>
        {autoRetrain.enabled ? "BẬT" : "TẮT (kill-switch AppSetting ml-psi-retrain)"}
      </strong>
      {` · ngưỡng PSI ≥ ${nf2.format(autoRetrain.psiWarn)} · cooldown ${autoRetrain.cooldownHours}h`}
      {autoRetrain.lastAt
        ? ` · lần gần nhất: ${new Date(autoRetrain.lastAt).toLocaleString("vi-VN")} (${autoRetrain.lastOutcome ?? "?"})`
        : " · chưa từng trigger"}
      <span className="sr-only"> — {autoRetrain.schedule}</span>
    </p>
  );
}

function DriftDetail({
  drift,
  autoRetrain,
}: {
  drift: DriftStatus | null;
  autoRetrain: MlAutoRetrainStatus | null;
}) {
  if (!drift) return null; // API chưa có field drift (bản cũ) — ẩn im lặng
  if (!drift.available) {
    return (
      <div>
        <p className="rounded-lg border border-dashed bg-muted/20 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          Drift đặc trưng:{" "}
          {drift.reason ?? "chưa có histogram — sẽ có sau lần train kế tiếp"}
        </p>
        <AutoRetrainNote autoRetrain={autoRetrain} />
      </div>
    );
  }
  const top = [...drift.dims].sort((a, b) => b.psi - a.psi).slice(0, 3);
  return (
    <div className="rounded-lg border bg-muted/20 px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="flex items-center gap-1.5 text-[11px] font-medium">
          <Activity className="size-3.5 text-muted-foreground" aria-hidden="true" />
          Drift đặc trưng (PSI · 30 phiên cuối)
        </span>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          n={nf0.format(drift.samples)} · tới {drift.asOf}
        </span>
      </div>
      <div className="mt-1.5 flex flex-col gap-1">
        {top.map((dim) => {
          const visual = driftLevelVisual(dim.level);
          return (
            <div key={dim.name} className="flex items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate" title={dim.name}>
                {dim.name}
              </span>
              <span className="shrink-0 tabular-nums font-semibold">
                {nf2.format(dim.psi)}
              </span>
              <Badge className={cn("shrink-0 px-2 text-[10px]", visual.className)}>
                {visual.label}
              </Badge>
            </div>
          );
        })}
      </div>
      {drift.retrainRecommended && (
        <p className="mt-1.5 text-xs font-medium text-rose-600 dark:text-rose-400">
          Đề xuất train lại mô hình — PSI ≥ 0,25 ({drift.maxDim})
          {autoRetrain?.enabled === true
            ? " — engine sẽ tự train trong khung 17:00 ICT (W3), hoặc bấm Huấn luyện ngay"
            : ""}
        </p>
      )}
      {/* W3 (#164) — minh bạch cơ chế: auto-retrain theo PSI có guard (5 tầng:
          kill-switch · cooldown 24h · ngưỡng · windowHash · mutex train). */}
      <AutoRetrainNote autoRetrain={autoRetrain} />
    </div>
  );
}

/* ───────────── Khối MLP ───────────── */

export function MlpBlock({
  model,
  drift,
  autoRetrain,
  ss,
}: {
  model: MlModelStatus<DlMlpMetrics> | null;
  drift: DriftStatus | null;
  autoRetrain?: MlAutoRetrainStatus | null;
  ss?: MlSsStatus | null;
}) {
  const m = model?.metrics;
  const topSymbols = (m?.topSymbols ?? []).filter(Boolean).slice(0, 8);

  return (
    <section aria-labelledby="ml-mlp-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3
          id="ml-mlp-heading"
          className="flex items-center gap-2 text-sm font-semibold"
        >
          <Layers className="size-4 text-muted-foreground" aria-hidden="true" />
          MLP dự báo 5 phiên (học sâu)
        </h3>
        {model && <VersionBadge version={model.version} />}
        {model && <StatusBadge status={model.status} />}
        {model && <ServingArchBadge archString={model.archString} featureCount={m?.features} />}
        {model && <FeatureSetBadge featureSet={model.featureSet} />}
        {model && <DriftBadge drift={drift} />}
        {model && <TrainedAtCaption trainedAt={model.trainedAt} />}
      </div>

      {!model || !m ? (
        <EmptyNote>
          Chưa huấn luyện — bấm <strong className="font-semibold">Huấn luyện</strong>{" "}
          để train MLP trên dữ liệu EOD thật.
        </EmptyNote>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Epochs" value={nf0.format(m.epochs)} />
            <Stat label="Mẫu dữ liệu" value={nf0.format(m.samples)} />
            <Stat label="Độ chính xác train" value={pct(m.trainAcc)} tone={accTone(m.trainAcc)} />
            {/* W5 (#163) — đổi nhãn trung thực: đây là số selection (thiên lệch
                lên); số ngoài mẫu hiện ở ô Holdout khi có. */}
            <Stat label="Độ chính xác xác thực (selection)" value={pct(m.valAcc)} tone={accTone(m.valAcc)} />
            <Stat label="Loss xác thực" value={nf2.format(m.valLoss)} />
            {model.holdout ? (
              <Stat
                label={`Holdout ngoài mẫu (n=${nf0.format(model.holdout.size)})`}
                value={pct(model.holdout.valAcc)}
                tone={accTone(model.holdout.valAcc)}
              />
            ) : (
              <Stat label="Holdout ngoài mẫu" value="—" />
            )}
            {model.holdout && model.holdout.brier != null && (
              <Stat
                label="Brier holdout"
                value={nf2.format(model.holdout.brier)}
                tone={model.holdout.brier <= 0.667 ? "ok" : "neutral"}
              />
            )}
            <Stat
              label="Cấu hình"
              value={
                <span className="text-sm font-semibold">
                  {m.horizonDays} phiên · {m.features} đặc trưng
                </span>
              }
            />
          </div>

          {/* W5 (#163) — note thiên lệch selection: luôn hiện để người đọc
              không lấy valAcc selection làm tuyên bố ngoài mẫu. */}
          {/* F-166a-3 (Fixbug #166 — Vòng 1): ưu tiên note TỪ API (metricsNote
              do status route soạn — một nguồn sự thật, chống trôi FE/API);
              fallback giữ logic W5 cũ cho bản không có note. */}
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {model.metricsNote ??
              (model.holdout
                ? 'Ô "Holdout ngoài mẫu" là số trung thực (walk-forward, cùng cut thời gian — đo khi bản này qua cổng sweep). Ô "xác thực" là số selection, thiên lệch LÊN.'
                : 'Chưa có số ngoài mẫu cho bản này (lên serving qua train tay). Áp chính xác "xác thực (selection)" là số post-selection — chọn kiến trúc + early-stop trên cùng val block, thiên lệch LÊN so với khả năng dự báo thật.')}
          </p>

          {/* A3 — giám sát drift đặc trưng (PSI 30 phiên gần nhất) + W3 trạng
              thái auto-retrain theo PSI */}
          <DriftDetail drift={drift} autoRetrain={autoRetrain ?? null} />

          {/* Task 176 — STATE_SPACE_BLUEPRINT Phase 1: tầng State Space (A/B
              bóng holt-ss + guard ngạc nhiên) — khối kiểm định 4 ô. */}
          <SsShadowNote ss={ss ?? null} />

          {/* F-18B (#132) — ghi chú phân vai: arch này là bản ĐANG phục vụ,
              tách biệt trình chỉnh sửa tab Mạng thần kinh (lần train kế tiếp). */}
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Kiến trúc ANN ở trên là của bản đang phục vụ (dự báo 5 phiên ngay
            hôm nay). Trình chỉnh sửa ở tab Mạng thần kinh là cấu hình cho lần
            huấn luyện kế tiếp — hai phần khác nhau là bình thường cho tới khi
            champion qua cổng 4 điều kiện (tab Tự động tìm kiếm) hoặc train lại
            qua serving-swap guard.
          </p>

          {topSymbols.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">
                Mã đóng góp mạnh nhất:
              </span>
              {topSymbols.map((sym) => (
                <Badge
                  key={sym}
                  variant="outline"
                  className="font-mono text-[10px] font-semibold"
                >
                  {sym}
                </Badge>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** pct1 nội bộ (tránh xuất helper trùng từ shared). */
function pct(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${nf1.format(n * 100)}%`;
}
