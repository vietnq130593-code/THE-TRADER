"use client";

import * as React from "react";
import {
  Activity,
  AlertTriangle,
  Brain,
  Clock,
  Dumbbell,
  Layers,
  Loader2,
  RefreshCw,
  Scale,
  ShieldCheck,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip as UiTooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { isMlNotFound, useMlStatus, useTrainMl } from "@/hooks/use-ml";
import type {
  BanditArm,
  DlMlpMetrics,
  MlGateStatus,
  MlGruStatus,
  MlModelStatus,
  MlStatusResponse,
  RlQMetrics,
} from "@/hooks/use-ml";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Phiên #35 (Task 35-FE) — card "Học máy & Học tăng cường" trong workspace
 * Tổng hợp. Hiển thị trạng thái 3 mô hình học THẬT của hệ thống:
 *
 *   1. MLP dự báo 5 phiên (học sâu — backprop + Adam)
 *   2. Q-learning Gym (học tăng cường — tabular 48 trạng thái)
 *   3. Bandit Thompson sampling (trọng số phiếu LLM — Beta-Bernoulli)
 *
 * Backend 35-ML chạy song song: GET /api/ml/status có thể 404 → render
 * empty-state "Đang chờ backend học máy" (query vẫn polling 30s để tự lành),
 * dlMlp/rlQ có thể null → mỗi khối có empty-state riêng. Màu chỉ dùng
 * emerald / rose / amber / neutral theo token ngữ nghĩa of app.
 *
 * A3 (phiên #79 — ML_OPS_BLUEPRINT §3): khối MLP thêm badge "Drift" + chi
 * tiết PSI top-3 chiều (đọc field additive `drift` của /api/ml/status — hook
 * use-ml chung KHÔNG sửa theo ràng buộc task, đọc qua cast cục bộ tolerant).
 *
 * B1/B2/B3/B4 (phiên #81 — ML_OPS_BLUEPRINT §4): khối MLP thêm badge bộ
 * đặc trưng (v1-lag10 / v2-lag16) + khối mới "Cổng bằng chứng chuỗi" —
 * verdict ΔBrier CI hiển thị TRUNG THỰC (B4: FAIL không giấu) + dòng trạng
 * thái GRU giọng thứ ba (chưa triển khai khi cổng chưa mở).
 */

/* ─────────────────── A3 · types field `drift` (local — không sửa hook) ─────────────────── */

/** Một chiều PSI trong payload drift (mirror hợp đồng API ml/status). */
interface DriftDim {
  name: string;
  psi: number;
  level: string;
}

/** Field `drift` — unavailable kèm reason trung thực (bản train trước A3). */
type DriftStatus =
  | { available: false; reason?: string }
  | {
      available: true;
      asOf: string;
      samples: number;
      dims: DriftDim[];
      maxPsi: number;
      maxDim: string;
      retrainRecommended: boolean;
    };

/* ─────────────────── Format helpers (vi-VN, "%"/số có dấu − U+2212) ─────────────────── */

const nf0 = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("vi-VN", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const nf2 = new Intl.NumberFormat("vi-VN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
/** 4 chữ số thập phân — ΔBrier/CI cổng bằng chứng (B2 #81). */
const nf4 = new Intl.NumberFormat("vi-VN", {
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});

/** "61,0%" — nhập tỷ lệ 0..1 → ×100. */
function pct1(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${nf1.format(n * 100)}%`;
}

/** "−0,12" / "+0,40" (2 chữ số, dấu − U+2212). */
function signed2(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  const s = nf2.format(Math.abs(n));
  return n > 0 ? `+${s}` : n < 0 ? `−${s}` : "0,00";
}

function clamp01(n: number | null | undefined): number {
  if (n == null || Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Xanh (emerald) khi ≥50%, đỏ (rose) khi <50% — cho độ chính xác 0..1. */
function accTone(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "text-muted-foreground";
  return n >= 0.5
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-rose-600 dark:text-rose-400";
}

/** Dấu số: dương = emerald, âm = rose, 0/không xác định = muted. */
function signTone(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n) || n === 0) return "text-muted-foreground";
  return n > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400";
}

/* ─────────────────── Label maps ─────────────────── */

const MODEL_STATUS: Record<string, { label: string; className: string }> = {
  serving: {
    label: "serving",
    className: "bg-emerald-600/15 text-emerald-700 dark:text-emerald-400",
  },
  training: {
    label: "training",
    className: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  },
};

/* ─────────────────── A3 · Drift PSI visuals (emerald/amber/rose) ─────────────────── */

/** Mức PSI 3 bậc (API trả label tiếng Việt) → nhãn hiển thị + màu badge.
 * Giá trị lạ/missing → đỏ (fail-safe — không bao giờ xanh khi không rõ). */
function driftLevelVisual(level: string | null | undefined): {
  label: string;
  className: string;
} {
  switch (level) {
    case "ổn":
      return {
        label: "ổn",
        className:
          "bg-emerald-600/15 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-600/15",
      };
    case "cảnh-báo":
      return {
        label: "cảnh báo",
        className:
          "bg-amber-500/15 text-amber-700 dark:text-amber-400 hover:bg-amber-500/15",
      };
    default:
      return {
        label: "dịch chuyển",
        className:
          "bg-rose-600/15 text-rose-700 dark:text-rose-400 hover:bg-rose-600/15",
      };
  }
}

/** Mức tóm lược của cả payload — theo chiều PSI cao nhất. */
function driftWorstLevel(drift: Extract<DriftStatus, { available: true }>): string {
  const worst = [...drift.dims].sort((a, b) => b.psi - a.psi)[0];
  return worst?.level ?? "dịch-chuyển";
}

/** Chuẩn hoá stance (API trả tiếng Việt) → tăng / giữ / giảm. */
function normalizeStance(stance: string | null | undefined): "up" | "hold" | "down" {
  const s = (stance ?? "").trim().toLowerCase();
  if (["tăng", "tang", "up", "buy", "long"].includes(s)) return "up";
  if (["giảm", "giam", "down", "sell", "short"].includes(s)) return "down";
  return "hold";
}

const RL_STANCE: Record<"up" | "hold" | "down", { label: string; className: string }> = {
  up: {
    label: "TĂNG",
    className: "bg-emerald-600/15 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-600/15",
  },
  hold: {
    label: "GIỮ",
    className: "bg-amber-500/15 text-amber-700 dark:text-amber-400 hover:bg-amber-500/15",
  },
  down: {
    label: "GIẢM",
    className: "bg-rose-600/15 text-rose-700 dark:text-rose-400 hover:bg-rose-600/15",
  },
};

/* ─────────────────── Panel ─────────────────── */

export function MlPanel() {
  const { data, isLoading, isError, error, refetch } = useMlStatus();
  const train = useTrainMl();

  // 404 = backend 35-ML chưa merge → empty-state lịch sự (không crash).
  const waitingBackend = isError && isMlNotFound(error);
  // Khi chưa có backend thì không cho train (POST cũng 404 → chỉ toast lỗi).
  const trainDisabled = train.isPending || waitingBackend;

  // A3 — field `drift` là additive trên payload /api/ml/status; hook chung
  // (use-ml.ts) không được sửa theo ràng buộc task 79-A3 → đọc qua cast cục
  // bộ, optional-tolerant (API cũ chưa có field → null → ẩn UI drift).
  const drift =
    (data as (MlStatusResponse & { drift?: DriftStatus }) | undefined)?.drift ??
    null;
  // B2/B3 (#81) — field additive gate/gru (hook đã có type — tolerant).
  const gate = data?.gate ?? null;
  const gru = data?.gru ?? null;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <span
            className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted"
            aria-hidden="true"
          >
            <Brain className="size-4 text-foreground/80" />
          </span>
          Học máy &amp; Học tăng cường
        </CardTitle>
        <CardDescription>
          3 mô hình học thật chạy thuật toán trong code: MLP backprop+Adam ·
          Q-learning tabular 48 trạng thái · Thompson sampling Beta-Bernoulli
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {isLoading ? (
          <MlPanelSkeleton />
        ) : waitingBackend ? (
          <WaitingBackend />
        ) : isError ? (
          <MlErrorState
            message={error?.message ?? ""}
            onRetry={() => void refetch()}
          />
        ) : (
          <>
            {/* Khối 1 — MLP dự báo 5 phiên (học sâu) */}
            <MlpBlock model={data?.dlMlp ?? null} drift={drift} />

            <Separator />

            {/* B2/B3/B4 (#81) — Cổng bằng chứng chuỗi + GRU giọng thứ ba */}
            <GateBlock gate={gate} gru={gru} />

            <Separator />

            {/* Khối 2 — Q-learning Gym (học tăng cường) */}
            <RlBlock model={data?.rlQ ?? null} />

            <Separator />

            {/* Khối 3 — Bandit Thompson sampling (trọng số phiếu LLM) */}
            <BanditBlock
              bandit={data?.bandit ?? null}
              pendingSettles={data?.pendingSettles ?? 0}
            />
          </>
        )}

        {/* Hành động — cuối card */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-4">
          <TooltipProvider delayDuration={200}>
            <UiTooltip>
              <TooltipTrigger asChild>
                <Button
                  className="min-h-11 gap-2"
                  onClick={() => train.mutate("all")}
                  disabled={trainDisabled}
                >
                  {train.isPending ? (
                    <>
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                      Đang huấn luyện…
                    </>
                  ) : (
                    <>
                      <Zap className="size-4" aria-hidden="true" />
                      Huấn luyện mô hình
                    </>
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                Train lại MLP + Q-learning trên dữ liệu EOD thật
              </TooltipContent>
            </UiTooltip>
          </TooltipProvider>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Huấn luyện lại chạy đúng thuật toán trong code — không tốn chi phí
            LLM.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/* ─────────────────── Tiểu khối dùng chung ─────────────────── */

/** Ô số liệu: nhãn muted + giá trị tabular-nums. */
function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  tone?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border bg-muted/30 px-3 py-2">
      <span className="text-[11px] leading-tight text-muted-foreground">{label}</span>
      <span className={cn("tabular-nums text-lg font-semibold leading-tight", tone)}>
        {value}
      </span>
    </div>
  );
}

/** Badge phiên bản "v2". */
function VersionBadge({ version }: { version: number }) {
  return (
    <Badge variant="secondary" className="font-mono text-[10px]">
      v{version}
    </Badge>
  );
}

/** Badge trạng thái mô hình — "serving" emerald, còn lại outline thô. */
function StatusBadge({ status }: { status: string }) {
  const known = MODEL_STATUS[(status ?? "").toLowerCase()];
  if (known) {
    return (
      <Badge className={cn("font-mono text-[10px]", known.className)}>{known.label}</Badge>
    );
  }
  return (
    <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground">
      {status || "—"}
    </Badge>
  );
}

/** Dòng meta "Huấn luyện lúc …" căn phải hàng tiêu đề khối. */
function TrainedAtCaption({ trainedAt }: { trainedAt: string | null | undefined }) {
  if (!trainedAt) return null;
  return (
    <span className="ml-auto text-[11px] text-muted-foreground">
      Huấn luyện {formatDateTime(trainedAt)}
    </span>
  );
}

/** Empty-state 1 khối (dlMlp/rlQ null — chưa train). */
function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed bg-muted/20 px-3 py-3 text-sm leading-relaxed text-muted-foreground">
      {children}
    </p>
  );
}

/* ─────────────────── Khối 1 — MLP dự báo 5 phiên ─────────────────── */

function MlpBlock({
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
            <Stat label="Độ chính xác train" value={pct1(m.trainAcc)} tone={accTone(m.trainAcc)} />
            <Stat label="Độ chính xác xác thực" value={pct1(m.valAcc)} tone={accTone(m.valAcc)} />
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

/* ─────────────────── A3 · Drift PSI (badge + khối chi tiết) ─────────────────── */

/** Badge "Drift" cạnh version/status khối MLP — mức theo chiều PSI cao nhất
 * (xanh ổn · vàng cảnh báo · đỏ dịch chuyển); chưa có histogram → trung tính
 * muted, trung thực (bản serving train trước A3). */
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

/** Khối phụ: top-3 chiều PSI cao nhất (tên + giá trị + mức) + n/asOf + dòng
 * "đề xuất train lại" khi retrainRecommended; unavailable → ghi chú trung
 * tính với reason từ API. Ép mobile an toàn: hàng flex truncate, badge shrink-0. */
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

/* ───────────── B1/B2/B3/B4 · Cổng bằng chứng chuỗi + GRU (#81) ───────────── */

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

/** Khối Cổng bằng chứng (B2) + trạng thái GRU (B3/B4) — hiển thị TRUNG
 *  THỰC cả khi cổng KHÔNG mở (B4: "không phải bây giờ ≠ không bao giờ").
  * Ép mobile an toàn: các hàng flex truncate, badge shrink-0. */
function GateBlock({ gate, gru }: { gate: MlGateStatus | null; gru: MlGruStatus | null }) {
  return (
    <section aria-labelledby="ml-gate-heading" className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <h3
          id="ml-gate-heading"
          className="flex items-center gap-2 text-sm font-semibold"
        >
          <ShieldCheck className="size-4 text-muted-foreground" aria-hidden="true" />
          Cổng bằng chứng chuỗi (B2)
        </h3>
      </div>

      {!gate || !gate.available ? (
        <EmptyNote>
          Cổng chưa đo — {gate && "reason" in gate && gate.reason
            ? gate.reason
            : "chạy scripts/ml-evidence-gate.ts sau khi bản v2-lag16 được huấn luyện"}
          . Mô hình chuỗi (GRU) chỉ mở khi số liệu xác quyết, không mở vì “hay
          để có” (nguyên tắc §1.8).
        </EmptyNote>
      ) : (
        <div className="rounded-lg border bg-muted/20 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            {gate.verdict === "PASS" ? (
              <Badge className="bg-emerald-600/15 text-[10px] font-semibold text-emerald-700 hover:bg-emerald-600/15 dark:text-emerald-400">
                Cổng chuỗi: MỞ
              </Badge>
            ) : (
              <Badge className="bg-rose-600/15 text-[10px] font-semibold text-rose-700 hover:bg-rose-600/15 dark:text-rose-400">
                Cổng chuỗi: CHƯA mở
              </Badge>
            )}
            <span className="text-[11px] tabular-nums text-muted-foreground">
              ΔBrier CI 95% [{nf4.format(gate.deltaBrier.ciLow)}; {nf4.format(gate.deltaBrier.ciHigh)}]
              <span className="mx-1">·</span>
              {gate.newFeaturesSignificant}/6 đặc trưng mới có ý nghĩa
            </span>
            {gate.measuredAt ? (
              <span className="ml-auto text-[11px] text-muted-foreground">
                Đo {formatDateTime(gate.measuredAt)}
              </span>
            ) : null}
          </div>

          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            ΔBrier = Brier(v2-lag16) − Brier(v1-lag10) trên cùng cửa sổ dữ liệu
            (paired bootstrap 1.000×) — âm nghĩa là bộ 16 đặc trưng thắng. {" "}
            {gate.verdict === "PASS"
              ? gate.passedVia === "deltabrier"
                ? "V2 thắng có ý nghĩa thống kê."
                : "Mở nhờ ≥ 3/6 đặc trưng mới mang thông tin."
              : "CI chạm 0 hoặc không đủ đặc trưng mới có ý nghĩa — mặc định an toàn: FAIL."}{" "}
            {gate.swappedServing
              ? "Đã hoán đổi serving sang v2-lag16."
              : "Serving giữ nguyên cho tới khi cổng xử quyết."}
          </p>

          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            Re-đo mỗi quý, hoặc ngay khi có dữ liệu intraday 5-phút (B4 — “không
            phải bây giờ ≠ không bao giờ”).
          </p>
        </div>
      )}

      {/* GRU giọng thứ ba — B3/B4 trung thực */}
      <div className="rounded-lg border border-dashed bg-muted/20 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium">GRU giọng thứ ba (B3)</span>
          {!gru ? (
            <Badge variant="outline" className="shrink-0 text-[10px] text-muted-foreground">
              chưa triển khai — chờ cổng
            </Badge>
          ) : (
            <>
              <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
                v{gru.version}
              </Badge>
              <Badge
                className={cn(
                  "shrink-0 text-[10px]",
                  gru.enabled
                    ? "bg-emerald-600/15 text-emerald-700 hover:bg-emerald-600/15 dark:text-emerald-400"
                    : "bg-amber-500/15 text-amber-700 hover:bg-amber-500/15 dark:text-amber-400"
                )}
              >
                {gru.enabled ? "đang phục vụ (0,5/0,3/0,2)" : "shadow — chưa vào điểm"}
              </Badge>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                shadow {nf0.format(gru.shadowSettled)}/60 phiên
                {gru.gruBrier != null && gru.mlpBrier != null
                  ? ` · Brier GRU ${nf4.format(gru.gruBrier)} vs MLP ${nf4.format(gru.mlpBrier)}`
                  : ""}
                {gru.consecutiveWorse > 0 ? ` · tệ hơn ${gru.consecutiveWorse} phiên liên tiếp` : ""}
              </span>
            </>
          )}
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          Khi được triển khai: GRU-24 (3.179 tham số, window 20 phiên) dự báo
          shadow 60 phiên, chỉ lên giọng thứ ba khi Brier ≤ MLP, kill-switch tự
          hạ khi tệ hơn 5 phiên liên tiếp.
        </p>
      </div>
    </section>
  );
}

/* ─────────────────── Khối 2 — Q-learning Gym ─────────────────── */

function RlBlock({ model }: { model: MlModelStatus<RlQMetrics> | null }) {
  const m = model?.metrics;
  const stance = RL_STANCE[normalizeStance(m?.stance)];
  const exposurePct = clamp01(m?.exposure) * 100;

  return (
    <section aria-labelledby="ml-rlq-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3
          id="ml-rlq-heading"
          className="flex items-center gap-2 text-sm font-semibold"
        >
          <Dumbbell className="size-4 text-muted-foreground" aria-hidden="true" />
          Q-learning Gym (học tăng cường)
        </h3>
        {model && <VersionBadge version={model.version} />}
        {model && <StatusBadge status={model.status} />}
        {model && <TrainedAtCaption trainedAt={model.trainedAt} />}
      </div>

      {!model || !m ? (
        <EmptyNote>
          Chưa huấn luyện — bấm <strong className="font-semibold">Huấn luyện</strong>{" "}
          để chạy gym Q-learning trên dữ liệu EOD thật.
        </EmptyNote>
      ) : (
        <>
          {/* Stance hiện tại + phơi nhiễm + kích thước không gian */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            <span className="flex items-center gap-2">
              Stance hiện tại
              <Badge className={cn("px-2.5 text-[11px] font-bold tracking-wide", stance.className)}>
                {stance.label}
              </Badge>
            </span>
            <span className="flex items-center gap-2">
              Phơi nhiễm
              <span className="flex items-center gap-2">
                <span
                  className="h-1.5 w-20 overflow-hidden rounded-full bg-muted"
                  aria-hidden="true"
                >
                  <span
                    className="block h-full rounded-full bg-amber-500"
                    style={{ width: `${exposurePct}%` }}
                  />
                </span>
                <span className="tabular-nums font-semibold">{pct1(m.exposure)}</span>
              </span>
            </span>
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              {m.states} trạng thái × {m.actions} hành động
            </Badge>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Episodes" value={nf0.format(m.episodes)} />
            <Stat label="ε cuối" value={nf2.format(m.epsilonEnd)} />
            <Stat
              label="Thưởng TB 50 ep cuối"
              value={signed2(m.avgRewardLast50)}
              tone={signTone(m.avgRewardLast50)}
            />
            <Stat label="Q-max" value={signed2(m.qMax)} tone={signTone(m.qMax)} />
          </div>
        </>
      )}
    </section>
  );
}

/* ─────────────────── Khối 3 — Bandit Thompson sampling ─────────────────── */

function BanditBlock({
  bandit,
  pendingSettles,
}: {
  bandit: { arms: BanditArm[]; lastSettleAt: string | null } | null;
  pendingSettles: number;
}) {
  // Sort giảm dần posteriorMean — tự phòng vệ bất kể thứ tự API.
  const arms = React.useMemo(
    () =>
      [...(bandit?.arms ?? [])].sort(
        (a, b) => clamp01(b.posteriorMean) - clamp01(a.posteriorMean)
      ),
    [bandit?.arms]
  );

  return (
    <section aria-labelledby="ml-bandit-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3
          id="ml-bandit-heading"
          className="flex items-center gap-2 text-sm font-semibold"
        >
          <Scale className="size-4 text-muted-foreground" aria-hidden="true" />
          Bandit Thompson sampling (trọng số phiếu LLM)
        </h3>
        {pendingSettles > 0 && (
          <Badge variant="outline" className="text-[10px] text-muted-foreground">
            {pendingSettles.toLocaleString("vi-VN")} phiếu chờ kết toán
          </Badge>
        )}
        {bandit?.lastSettleAt && (
          <span className="ml-auto text-[11px] text-muted-foreground">
            Kết toán lần cuối {formatDateTime(bandit.lastSettleAt)}
          </span>
        )}
      </div>

      {arms.length === 0 ? (
        <EmptyNote>
          Chưa có arm nào — arms Beta-Bernoulli xuất hiện sau phiếu bầu đầu tiên
          của các agent LLM và được kết toán reward sau 5 phiên.
        </EmptyNote>
      ) : (
        <div className="max-h-64 overflow-y-auto custom-scrollbar rounded-lg border">
          {/* table-fixed mobile: hàng gộp 1 cell không đẩy bảng rộng hơn container */}
          <Table className="table-fixed sm:table-auto">
            <TableHeader>
              {/* Bảng header đầy đủ — desktop; mobile dùng hàng gộp (không header) */}
              <TableRow className="hidden sm:table-row">
                <TableHead className="text-xs">Agent</TableHead>
                <TableHead className="text-xs">α</TableHead>
                <TableHead className="text-xs">β</TableHead>
                <TableHead className="text-xs">Pulls</TableHead>
                <TableHead className="text-xs">Wins</TableHead>
                <TableHead className="text-xs">Posterior</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {arms.map((arm) => (
                <ArmRow key={arm.agentCode} arm={arm} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Reward = phiếu bầu đúng hướng giá thực tế sau 5 phiên · Beta(α+1,β+1)
      </p>
    </section>
  );
}

function ArmRow({ arm }: { arm: BanditArm }) {
  const mean = clamp01(arm.posteriorMean);
  const name = arm.name || arm.agentCode;
  const meta = `${arm.agentCode} · α ${nf1.format(arm.alpha)} · β ${nf1.format(arm.beta)} · ${nf0.format(arm.pulls)} pulls · ${nf1.format(arm.wins)} wins`;

  return (
    <TableRow>
      {/* Mobile — 1 hàng gộp (không tràn cột ở 390px) */}
      <TableCell colSpan={6} className="sm:hidden">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5 leading-tight">
            <span className="truncate text-xs font-semibold" title={name}>
              {name}
            </span>
            <span className="truncate text-[10px] text-muted-foreground" title={meta}>
              {meta}
            </span>
          </div>
          <span className="flex shrink-0 items-center gap-2">
            <Progress
              value={mean * 100}
              className="h-1.5 w-14 [&>div]:bg-emerald-600 dark:[&>div]:bg-emerald-400"
              aria-label={`Posterior mean ${pct1(mean)}`}
            />
            <span className="tabular-nums text-xs font-semibold">{pct1(mean)}</span>
          </span>
        </div>
      </TableCell>

      {/* Desktop — 6 cột đầy đủ */}
      <TableCell className="hidden sm:table-cell">
        <div className="flex flex-col leading-tight">
          <span className="max-w-28 truncate text-xs font-semibold" title={name}>
            {name}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {arm.agentCode}
          </span>
        </div>
      </TableCell>
      <TableCell className="hidden tabular-nums text-xs text-muted-foreground sm:table-cell">
        {nf1.format(arm.alpha)}
      </TableCell>
      <TableCell className="hidden tabular-nums text-xs text-muted-foreground sm:table-cell">
        {nf1.format(arm.beta)}
      </TableCell>
      <TableCell className="hidden tabular-nums text-xs sm:table-cell">
        {nf0.format(arm.pulls)}
      </TableCell>
      <TableCell className="hidden tabular-nums text-xs text-muted-foreground sm:table-cell">
        {nf1.format(arm.wins)}
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        <span className="flex items-center gap-2">
          <Progress
            value={mean * 100}
            className="h-1.5 w-20 [&>div]:bg-emerald-600 dark:[&>div]:bg-emerald-400"
            aria-label={`Posterior mean ${pct1(mean)}`}
          />
          <span className="tabular-nums text-xs font-semibold">{pct1(mean)}</span>
        </span>
      </TableCell>
    </TableRow>
  );
}

/* ─────────────────── Trạng thái đặc biệt ─────────────────── */

/** Backend 35-ML chưa merge (GET 404) — empty-state lịch sự, query polling tự lành. */
function WaitingBackend() {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-dashed bg-muted/20 p-4">
      <Clock
        className="mt-0.5 size-4 shrink-0 animate-pulse text-muted-foreground"
        aria-hidden="true"
      />
      <div className="min-w-0">
        <p className="text-sm font-medium">Đang chờ backend học máy</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          API /api/ml/status chưa sẵn sàng (đang được triển khai song song) —
          thẻ tự động tải lại mỗi 30 giây khi có dữ liệu.
        </p>
      </div>
    </div>
  );
}

/** Lỗi khác 404 — banner + Thử lại (không crash workspace). */
function MlErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-down/40 bg-down/10 p-4 text-sm text-down"
    >
      <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
      <p className="min-w-40 flex-1 leading-relaxed">
        Không tải được trạng thái học máy{message ? ` — ${message}` : "."}
      </p>
      <Button variant="outline" size="sm" className="gap-2" onClick={onRetry}>
        <RefreshCw className="size-3.5" aria-hidden="true" />
        Thử lại
      </Button>
    </div>
  );
}

/* ─────────────────── Skeleton ─────────────────── */

function MlPanelSkeleton() {
  return (
    <div
      className="flex flex-col gap-4"
      aria-busy="true"
      aria-label="Đang tải trạng thái học máy"
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-14 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-10 w-2/3" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-14 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-40 w-full rounded-lg" />
    </div>
  );
}
