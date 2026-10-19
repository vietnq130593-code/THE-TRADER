"use client";

// (Task 144 P2-c) — tách từ synthesis-workspace.tsx (pure move)
// Card 1c (B9) "Cổng đồng thuận 80%": badge gate + shadow/enforcement + thanh
// tally 3 cụm có đường ngưỡng 80% + danh sách phiếu Hội đồng Nghiên cứu.

import { Vote } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ConsensusSnapshot, ConsensusVote } from "@/lib/types";
import { DRIVER_DIRECTION, GATE_TONE, TALLY_DIRS } from "./constants";
import { nf2, pct1 } from "./helpers";

/* ─────────────────── 1c. B9 — Cổng đồng thuận 80% ─────────────────── */

export function ConsensusCard({ consensus }: { consensus: ConsensusSnapshot }) {
  const tally = consensus.tally ?? [];
  const totalWeight = tally.reduce((s, v) => s + v.weight, 0);
  const votesOf = (d: (typeof TALLY_DIRS)[number]) =>
    tally.filter((v) => v.direction === d);
  const sumOf = (d: (typeof TALLY_DIRS)[number]) =>
    votesOf(d).reduce((s, v) => s + v.weight, 0);
  const shareOf = (d: (typeof TALLY_DIRS)[number]) =>
    totalWeight > 0 ? sumOf(d) / totalWeight : 0;
  const gateTone = GATE_TONE[consensus.gate] ?? GATE_TONE.NO_CONSENSUS;

  const ariaLabel =
    totalWeight > 0
      ? `Cổng đồng thuận 80%: tỷ lệ trọng số ${pct1(consensus.ratio)} — ${consensus.gateLabel}. ` +
        TALLY_DIRS.map(
          (d) =>
            `${votesOf(d).length} phiếu ${d === "UP" ? "tăng" : d === "DOWN" ? "giảm" : "đi ngang"} (${pct1(shareOf(d))})`
        ).join(", ") +
        ". Ngưỡng đồng thuận 80%."
      : "Cổng đồng thuận 80%: không có phiếu hợp lệ.";

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Vote className="size-4 text-muted-foreground" aria-hidden="true" />
          Cổng đồng thuận 80%
        </CardTitle>
        <CardDescription>
          {consensus.present}/7 cử tri Hội đồng Nghiên cứu · tỷ lệ đồng thuận
          trọng số{" "}
          <span className="tabular-nums font-semibold text-foreground">
            {pct1(consensus.ratio)}
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* Gate + trạng thái enforcement */}
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            className={cn("px-3 py-1 text-sm font-bold tracking-wide", gateTone)}
          >
            {consensus.gateLabel}
          </Badge>
          {consensus.shadow ? (
            <Badge
              variant="outline"
              className="border-amber-500/50 text-[11px] text-amber-700 dark:text-amber-400"
            >
              Shadow-mode — chưa chặn tín hiệu
            </Badge>
          ) : (
            <Badge className="bg-emerald-600/15 text-[11px] text-emerald-700 dark:text-emerald-400">
              Enforcement ĐANG BẬT
            </Badge>
          )}
          {consensus.present < 7 && (
            <span className="text-[11px] text-muted-foreground">
              {consensus.present}/7 cử tri có mặt
            </span>
          )}
        </div>

        {/* Thanh tally 3 cụm + đường ngưỡng 80% */}
        {totalWeight > 0 ? (
          <div className="flex flex-col gap-1.5">
            <div className="relative">
              <div
                className="flex h-8 overflow-hidden rounded-md border border-border/60"
                role="img"
                aria-label={ariaLabel}
              >
                {TALLY_DIRS.map((d) => {
                  const share = shareOf(d);
                  if (share <= 0) return null;
                  return (
                    <div
                      key={d}
                      className={cn(
                        "flex items-center justify-center border-r border-background/60 last:border-r-0",
                        d === "UP"
                          ? "bg-up/25"
                          : d === "DOWN"
                            ? "bg-down/25"
                            : "bg-muted-foreground/20"
                      )}
                      style={{ width: `${share * 100}%` }}
                      title={`${votesOf(d).length} phiếu · ${pct1(share)} trọng số`}
                    >
                      {share >= 0.18 && (
                        <span
                          className={cn(
                            "tabular-nums text-[11px] font-semibold",
                            d === "UP"
                              ? "text-up"
                              : d === "DOWN"
                                ? "text-down"
                                : "text-foreground"
                          )}
                        >
                          {votesOf(d).length} · {pct1(share)}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
              {/* Đường ngưỡng 80% (vị trí left 80%) */}
              <div
                className="pointer-events-none absolute inset-y-[-4px] left-[80%] w-0 border-l-2 border-dashed border-foreground/50"
                aria-hidden="true"
              />
            </div>
            {/* Nhãn ngưỡng dưới đường */}
            <div className="relative h-4">
              <span
                className="absolute left-[80%] -translate-x-1/2 whitespace-nowrap text-[10px] font-semibold text-muted-foreground"
                aria-hidden="true"
              >
                ▾ ngưỡng 80%
              </span>
            </div>
            {/* Legend — đọc được cả khi cụm quá hẹp */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
              {TALLY_DIRS.map((d) => (
                <span key={d} className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "size-2 rounded-full",
                      d === "UP" ? "bg-up" : d === "DOWN" ? "bg-down" : "bg-muted-foreground"
                    )}
                    aria-hidden="true"
                  />
                  {d === "UP" ? "Tăng" : d === "DOWN" ? "Giảm" : "Đi ngang"}{" "}
                  <span className="tabular-nums font-semibold text-foreground">
                    {votesOf(d).length}
                  </span>{" "}
                  phiếu · <span className="tabular-nums">{pct1(shareOf(d))}</span>
                </span>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Không có phiếu hợp lệ trong lần tổng hợp này.
          </p>
        )}

        {/* Danh sách 6 phiếu */}
        {tally.length > 0 && (
          <ul
            className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3"
            aria-label="Danh sách phiếu bầu Hội đồng Nghiên cứu"
          >
            {tally.map((v) => (
              <VoteRow key={v.code} vote={v} />
            ))}
          </ul>
        )}

        {/* Ghi chú narrative */}
        {consensus.note && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {consensus.note}
          </p>
        )}
        {consensus.shadow && consensus.wouldBlock && (
          <p className="text-xs leading-relaxed text-amber-700 dark:text-amber-400">
            Nếu bật enforcement: tín hiệu ngược hướng số đông tại lần tổng hợp
            này sẽ bị chặn.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function VoteRow({ vote }: { vote: ConsensusVote }) {
  // Tái dụng DRIVER_DIRECTION (Tăng/Giảm/Đi ngang + icon lucide + màu ngữ nghĩa).
  const dir = DRIVER_DIRECTION[vote.direction] ?? DRIVER_DIRECTION.FLAT;
  const DirIcon = dir.icon;

  return (
    <li className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2">
      <div className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-xs font-semibold" title={vote.agentName}>
          {vote.agentName}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {vote.gen1 ? `${vote.gen1} · ` : ""}
          {vote.code}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {vote.model === "ml" && (
          <Badge variant="secondary" className="px-1 py-0 text-[9px]">
            ML
          </Badge>
        )}
        <span
          className="tabular-nums text-[11px] text-muted-foreground"
          title="Trọng số phiếu = health × posterior bandit (clamp 0,3–1)"
        >
          w {nf2.format(vote.weight)}
        </span>
        <span className={cn("flex items-center gap-1 text-xs font-medium", dir.className)}>
          <DirIcon className="size-3.5" aria-hidden="true" />
          <span className="sr-only">{dir.label}</span>
          <span aria-hidden="true">{dir.label}</span>
        </span>
      </div>
    </li>
  );
}
