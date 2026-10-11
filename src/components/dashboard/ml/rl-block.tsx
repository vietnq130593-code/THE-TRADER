"use client";

/**
 * ml/rl-block.tsx (#89 — tách từ ml-panel.tsx #35) — khối "Q-learning Gym"
 * của tab Tổng quan.
 */

import { Dumbbell } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { MlModelStatus, RlQMetrics } from "@/hooks/use-ml";
import {
  EmptyNote,
  RL_STANCE,
  Stat,
  StatusBadge,
  TrainedAtCaption,
  VersionBadge,
  clamp01,
  normalizeStance,
  nf0,
  nf2,
  pct1,
  signed2,
  signTone,
} from "./shared";

export function RlBlock({ model }: { model: MlModelStatus<RlQMetrics> | null }) {
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
