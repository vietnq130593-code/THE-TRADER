"use client";

/**
 * ml/mlp-block.tsx (#89 — tách từ ml-panel.tsx #35/#79/#81) — khối
 * "MLP dự báo 5 phiên (học sâu)" của tab Tổng quan.
 */

import { Activity, Layers } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { DlMlpMetrics, MlModelStatus } from "@/hooks/use-ml";
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

/** Khối phụ: top-3 chiều PSI cao nhất + n/asOf + dòng "đề xuất train lại". */
function DriftDetail({ drift }: { drift: DriftStatus | null }) {
  if (!drift) return null; // API chưa có field drift (bản cũ) — ẩn im lặng
  if (!drift.available) {
    return (
      <p className="rounded-lg border border-dashed bg-muted/20 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
        Drift đặc trưng:{" "}
        {drift.reason ?? "chưa có histogram — sẽ có sau lần train kế tiếp"}
      </p>
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
        </p>
      )}
    </div>
  );
}

/* ───────────── Khối MLP ───────────── */

export function MlpBlock({
  model,
  drift,
}: {
  model: MlModelStatus<DlMlpMetrics> | null;
  drift: DriftStatus | null;
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
            <Stat label="Độ chính xác xác thực" value={pct(m.valAcc)} tone={accTone(m.valAcc)} />
            <Stat label="Loss xác thực" value={nf2.format(m.valLoss)} />
            <Stat
              label="Cấu hình"
              value={
                <span className="text-sm font-semibold">
                  {m.horizonDays} phiên · {m.features} đặc trưng
                </span>
              }
            />
          </div>

          {/* A3 — giám sát drift đặc trưng (PSI 30 phiên gần nhất) */}
          <DriftDetail drift={drift} />

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
