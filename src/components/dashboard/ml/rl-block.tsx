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
  nf4,
  pct1,
  signed2,
  signTone,
} from "./shared";

export function RlBlock({ model }: { model: MlModelStatus<RlQMetrics> | null }) {
  const m = model?.metrics;
  const stance = RL_STANCE[normalizeStance(m?.stance)];
  const exposurePct = clamp01(m?.exposure) * 100;
  // W4 (#165) — số per-step của holdout cỡ 1e-4: 4 chữ số thập phân (ô
  // in-training giữ signed2 như cũ — khác biệt có chủ đích để mắt phân biệt
  // hai loại số ngay khi liếc).
  // F-166a-5 (Fixbug #166 — Vòng 1): dùng nf4 DÙNG CHUNG từ shared (bỏ bản
  // địa trùng) + dấu − U+2212 như signed2 — trước đây 2 ký tự trừ khác nhau
  // trong cùng card (ô train "−0,12" vs ô holdout "-0,0009").
  const signed4 = (n: number | null | undefined): string =>
    n == null || Number.isNaN(n)
      ? "—"
      : n > 0
        ? `+${nf4.format(n)}`
        : n < 0
          ? `−${nf4.format(Math.abs(n))}`
          : "0,0000";

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
            {/* W4 (#165) — nhãn trung thực: số in-training trên TRAIN split
                (Q-table không nhìn đoạn holdout); số ngoài mẫu ở khối dưới. */}
            <Stat
              label="Thưởng TB 50 ep cuối (train)"
              value={signed2(m.avgRewardLast50)}
              tone={signTone(m.avgRewardLast50)}
            />
            <Stat label="Q-max" value={signed2(m.qMax)} tone={signTone(m.qMax)} />
          </div>

          {/* W4 (#165) — kiểm định ngoài mẫu: chính sách greedy argmax Q chạy
              trên đoạn CUỐI tách khỏi train (cut theo thời gian), so 3 baseline
              đo trên CHÍNH đoạn đó. null → note trung thực (bản train trước
              W4 hoặc dữ liệu tối thiểu — không bịa số ngoài mẫu). */}
          {m.holdout ? (
            <div className="rounded-lg border bg-muted/20 px-3 py-2">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-[11px] font-medium">
                  Kiểm định ngoài mẫu (holdout tách thời gian)
                </span>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {nf0.format(m.holdout.bars)} phiên giữ ra · {nf0.format(m.holdout.steps)} bước — Q-table không nhìn đoạn này khi học
                </span>
              </div>
              <div className="mt-1.5 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat
                  label="Thưởng/bước (chính sách)"
                  value={signed4(m.holdout.avgRewardPerStep)}
                  tone={signTone(m.holdout.avgRewardPerStep)}
                />
                <Stat
                  label="Edge vs giữ 50%"
                  value={signed4(m.holdout.edgeVsHold50)}
                  tone={signTone(m.holdout.edgeVsHold50)}
                />
                <Stat
                  label="Baseline mua-giữ/bước"
                  value={signed4(m.holdout.baselines.buyHold)}
                  tone={signTone(m.holdout.baselines.buyHold)}
                />
                <Stat
                  label="Edge vs mua-giữ"
                  value={signed4(m.holdout.edgeVsBuyHold)}
                  tone={signTone(m.holdout.edgeVsBuyHold)}
                />
              </div>
              {/* F-166a-1/2/3 (Fixbug #166 — Vòng 1): ưu tiên note TỪ API
                  (metricsNote persist lúc train — một nguồn sự thật, chống
                  trôi FE/API); fallback cho bản cũ. Ghi rõ semantics: số
                  per-step theo công thức reward · baseline cost-free. */}
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                {model.metricsNote ??
                  "Số trung thực ngoài mẫu: chính sách greedy argmax Q đánh giá trên đoạn giữ-ra, so 3 baseline cùng đoạn (giữ 50% · mua-giữ 100% · cash 0). Mọi số là trung bình THƯỞNG TỪNG BƯỚC theo công thức reward (không phải lợi nhu kép); baseline mua-giữ là đối chứng không phí. Dòng “Thưởng TB 50 ep cuối (train)” là số in-training — thước đo hội tụ, không phải hiệu năng ngoài mẫu."}
              </p>
            </div>
          ) : (
            <p className="rounded-lg border border-dashed bg-muted/20 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              {"Chưa có số ngoài mẫu (holdout) cho bản này — train trước kiểm định W4 hoặc dữ liệu tối thiểu. “Thưởng TB 50 ep cuối” là số in-training (đo trên chính dữ liệu học) — đọc như thước đo hội tụ, không phải hiệu năng ngoài mẫu."}
            </p>
          )}
        </>
      )}
    </section>
  );
}
