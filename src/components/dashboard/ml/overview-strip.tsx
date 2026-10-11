"use client";

/**
 * ml/overview-strip.tsx (#89) — dải "một-chiều-nhìn" đầu tab Tổng quan:
 * 7 thẻ mini tóm trạng thái mọi subsystem học máy (MLP · Cổng B2 · GRU ·
 * RAG · Intraday · Q-learning · Bandit) để trader KHÔNG phải cuộn hết module
 * mới thấy điều mình cần. Số liệu sống từ GET /api/ml/status (30s).
 */

import {
  Brain,
  Database,
  Dumbbell,
  FlaskConical,
  Layers,
  Scale,
  ShieldCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { MlStatusResponse } from "@/hooks/use-ml";
import { RL_STANCE, clamp01, normalizeStance, nf0 } from "./shared";
import type { DriftStatus } from "./shared";

function MiniCard({
  icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "ok" | "warn" | "bad" | "neutral";
}) {
  const toneClass =
    tone === "ok"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "warn"
        ? "text-amber-600 dark:text-amber-400"
        : tone === "bad"
          ? "text-rose-600 dark:text-rose-400"
          : "text-foreground";
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border bg-muted/30 px-3 py-2.5">
      <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        {icon}
        <span className="truncate">{label}</span>
      </span>
      <span className={cn("truncate text-sm font-semibold tabular-nums leading-tight", toneClass)}>
        {value}
      </span>
      {sub != null && (
        <span className="truncate text-[10px] leading-tight text-muted-foreground">{sub}</span>
      )}
    </div>
  );
}

export function OverviewStrip({
  data,
  drift,
}: {
  data: MlStatusResponse | undefined;
  drift: DriftStatus | null;
}) {
  const mlp = data?.dlMlp ?? null;
  const gate = data?.gate ?? null;
  const gru = data?.gru ?? null;
  const rag = data?.rag ?? null;
  const intraday = data?.intraday ?? null;
  const rlq = data?.rlQ ?? null;
  const bandit = data?.bandit ?? null;

  const gateOk = gate?.available === true && gate.verdict === "PASS";
  const gruOn = gru?.enabled === true;
  const topArm =
    bandit && bandit.arms.length > 0
      ? [...bandit.arms].sort((a, b) => clamp01(b.posteriorMean) - clamp01(a.posteriorMean))[0]
      : null;
  const driftLabel =
    drift?.available === true
      ? driftWorstLabel(drift)
      : null;

  return (
    <div
      className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-4"
      aria-label="Tóm tắt nhanh trạng thái học máy"
    >
      <MiniCard
        icon={<Layers className="size-3.5 shrink-0" aria-hidden="true" />}
        label="MLP dự báo 5 phiên"
        value={mlp ? `${((mlp.metrics.valAcc ?? 0) * 100).toFixed(1).replace(".", ",")}%` : "chưa train"}
        sub={
          mlp
            ? `v${mlp.version} · ${mlp.featureSet ?? "v1-lag10"}${driftLabel ? ` · drift ${driftLabel}` : ""}`
            : "bấm Huấn luyện để bắt đầu"
        }
        tone={mlp ? (mlp.metrics.valAcc >= 0.5 ? "ok" : "bad") : "neutral"}
      />
      <MiniCard
        icon={<ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" />}
        label="Cổng bằng chứng B2"
        value={gate?.available === true ? (gateOk ? "MỞ" : "CHƯA mở") : "chưa đo"}
        sub={
          gate?.available === true
            ? `ΔBrier CI [${gate.deltaBrier.ciLow.toFixed(4).replace(".", ",")}; ${gate.deltaBrier.ciHigh.toFixed(4).replace(".", ",")}]`
            : "scripts/ml-evidence-gate.ts"
        }
        tone={gate?.available !== true ? "neutral" : gateOk ? "ok" : "bad"}
      />
      <MiniCard
        icon={<Brain className="size-3.5 shrink-0" aria-hidden="true" />}
        label="GRU giọng thứ ba"
        value={gru ? (gruOn ? "đang phục vụ" : "shadow") : "chưa triển khai"}
        sub={gru ? `v${gru.version} · ${nf0.format(gru.shadowSettled)}/60 phiên shadow` : "chờ cổng B2 mở"}
        tone={gruOn ? "ok" : "warn"}
      />
      <MiniCard
        icon={<Database className="size-3.5 shrink-0" aria-hidden="true" />}
        label="RAG tri thức (L1)"
        value={
          rag
            ? rag.usageRate30d == null
              ? "chưa có mẫu"
              : `${(rag.usageRate30d * 100).toFixed(0)}% dùng`
            : "chưa đo"
        }
        sub={rag ? `corpus ${nf0.format(rag.corpusMessages + rag.corpusNews)} docs · 30 ngày` : "BM25 + recency"}
        tone="neutral"
      />
      <MiniCard
        icon={<FlaskConical className="size-3.5 shrink-0" aria-hidden="true" />}
        label="Chuỗi intraday 5-phút"
        value={intraday && intraday.bars > 0 ? `${nf0.format(intraday.bars)} bar` : "chờ phiên"}
        sub={intraday && intraday.bars > 0 ? `${nf0.format(intraday.symbols)} mã · ${nf0.format(intraday.tradingDays)} phiên` : "gom từ tick 10s"}
        tone={intraday && intraday.bars > 0 ? "ok" : "neutral"}
      />
      <MiniCard
        icon={<Dumbbell className="size-3.5 shrink-0" aria-hidden="true" />}
        label="Q-learning Gym"
        value={rlq ? RL_STANCE[normalizeStance(rlq.metrics.stance)].label : "chưa train"}
        sub={
          rlq
            ? `phơi nhiễm ${((rlq.metrics.exposure ?? 0) * 100).toFixed(0)}% · ${rlq.metrics.states}×${rlq.metrics.actions}`
            : "48 trạng thái × 3 hành động"
        }
        tone={rlq ? "neutral" : "neutral"}
      />
      <MiniCard
        icon={<Scale className="size-3.5 shrink-0" aria-hidden="true" />}
        label="Bandit Thompson"
        value={bandit && bandit.arms.length > 0 ? `${bandit.arms.length} arms` : "chưa có arm"}
        sub={
          topArm
            ? `dẫn đầu ${topArm.agentCode} · ${((clamp01(topArm.posteriorMean)) * 100).toFixed(0)}%`
            : "Beta(α+1, β+1)"
        }
        tone="neutral"
      />
      <MiniCard
        icon={<Brain className="size-3.5 shrink-0" aria-hidden="true" />}
        label="Phiếu chờ kết toán"
        value={`${nf0.format(data?.pendingSettles ?? 0)} phiếu`}
        sub={bandit?.lastSettleAt ? "kết toán 16:15 ICT mỗi phiên" : "chưa từng kết toán"}
        tone={(data?.pendingSettles ?? 0) > 0 ? "warn" : "neutral"}
      />
    </div>
  );
}

function driftWorstLabel(drift: Extract<DriftStatus, { available: true }>): string {
  const worst = [...drift.dims].sort((a, b) => b.psi - a.psi)[0];
  if (!worst) return "—";
  switch (worst.level) {
    case "ổn":
      return "ổn";
    case "cảnh-báo":
      return "cảnh báo";
    default:
      return "dịch chuyển";
  }
}
