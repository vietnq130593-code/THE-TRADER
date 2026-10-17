"use client";

/**
 * ml/bandit-block.tsx (#89 — tách từ ml-panel.tsx #35) — khối "Bandit
 * Thompson sampling" của tab Tổng quan.
 */

import * as React from "react";
import { Scale } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";
import type { BanditArm } from "@/hooks/use-ml";
import { EmptyNote, clamp01, nf0, nf1, pct1 } from "./shared";

export function BanditBlock({
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
  // F-15 (#129): Wilson CI 95% cạnh posterior + mốc "≥100 pulls = tin khoảng
  // cách"; F-13: regime posterior (nếu có) hiển thị hậu tố theo regime.
  const hasCi =
    typeof arm.wilsonLow === "number" && typeof arm.wilsonHigh === "number" && arm.pulls > 0;
  const ciTxt = hasCi
    ? `CI95 ${pct1(clamp01(arm.wilsonLow ?? 0))}–${pct1(clamp01(arm.wilsonHigh ?? 1))}${arm.pulls < 100 ? " (<100 pulls — chưa tin khoảng cách)" : ""}`
    : "";
  const regimeTxt =
    typeof arm.regimePosteriorMean === "number"
      ? ` · regime ${pct1(clamp01(arm.regimePosteriorMean))}`
      : "";
  const meta = `${arm.agentCode} · α ${nf1.format(arm.alpha)} · β ${nf1.format(arm.beta)} · ${nf0.format(arm.pulls)} pulls · ${nf1.format(arm.wins)} wins${regimeTxt}`;

  return (
    <TableRow>
      {/* Mobile — 1 hàng gộp (không tràn cột ở 390px) */}
      <TableCell colSpan={6} className="sm:hidden">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5 leading-tight">
            <span className="truncate text-xs font-semibold" title={name}>
              {name}
            </span>
            <span className="truncate text-[10px] text-muted-foreground" title={hasCi ? `${meta} · ${ciTxt}` : meta}>
              {meta}
            </span>
            {hasCi ? (
              <span className="truncate text-[10px] tabular-nums text-muted-foreground">
                {ciTxt}
              </span>
            ) : null}
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
          <span className="flex flex-col leading-tight">
            <span className="tabular-nums text-xs font-semibold">{pct1(mean)}</span>
            {hasCi ? (
              <span className="text-[10px] tabular-nums text-muted-foreground" title={ciTxt}>
                {ciTxt}
              </span>
            ) : null}
          </span>
        </span>
      </TableCell>
    </TableRow>
  );
}
