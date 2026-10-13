"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { vi } from "date-fns/locale";
import { ArrowRight, FlaskConical, Play, Radar } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ChipMeta,
  EmptyState,
  VerdictBadge,
  type StatTileTone,
} from "@/components/dashboard/kit";
import {
  SIGNAL_DIRECTION,
  SignalDetailDialog,
  consensusMeta,
  statusMeta,
} from "@/components/dashboard/signals/signal-detail-dialog";
import { apiGet } from "@/lib/api";
import { useDateRange } from "@/hooks/use-date-range";
import { formatPct } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { SignalRow } from "@/lib/types";

/**
 * M4.2 (UIUX_UPGRADE_BLUEPRINT §4 — #110-b): hết "wall-of-text". Màn chính
 * chỉ còn HÀNG GỌN cấu trúc (badge hướng · mã + score · chip đồng thuận ·
 * lý do 1 dòng truncate · chip trạng thái + phán quyết D-LEDGER · nút Chi
 * tiết); toàn bộ chiều sâu (FULL rationale + JSON + Duyệt/Từ chối) chuyển
 * xuống dialog tier-3 `SignalDetailDialog`.
 *
 * Nhóm theo trạng thái (M4.2.2): "Cần quyết" (ACTIVE + MUA/BÁN chưa xử lý)
 * nổi trên cùng với viền PRIMARY + đếm; phần còn lại (đã thực thi · hết
 * hạn · từ chối · không cần quyết) gọn 1 dòng mỗi tín hiệu.
 *
 * Bản compact (props cũ cho workspace Tổng quan — giữ nguyên interface
 * limit/compact/onSeeAll từ #34) nâng cấp nhẹ theo cùng ngôn ngữ: badge +
 * mã + score + chip đồng thuận nhỏ + lý do truncate + tuổi, KHÔNG dialog.
 */

/** M4.2.1 — lý do rút gọn ~120 ký tự cho hàng (title giữ nguyên văn). */
function shortRationale(text: string): string {
  if (!text) return "—";
  if (text.length <= 120) return text;
  return `${text.slice(0, 120).trimEnd()}…`;
}

/** Chip phán quyết D-LEDGER (M4.2.3) — VerdictBadge + lãi/lỗ đánh dấu. */
function VerdictChips({ s }: { s: SignalRow }) {
  const e = s.evaluation;
  if (!e) return null;
  const pctTone: StatTileTone =
    e.markPnlPct != null && e.markPnlPct > 0
      ? "up"
      : e.markPnlPct != null && e.markPnlPct < 0
        ? "down"
        : "neutral";
  return (
    <>
      <VerdictBadge verdict={e.verdict} />
      {e.markPnlPct != null && (
        <ChipMeta
          tone={pctTone}
          title="Lãi/lỗ đánh dấu (%) so mốc ra tín hiệu — sổ phán quyết D-LEDGER"
        >
          {formatPct(e.markPnlPct)}
        </ChipMeta>
      )}
    </>
  );
}

/* ─────────────────── Hàng "Cần quyết" — cấu trúc đầy đủ ─────────────────── */

function PendingSignalRow({
  s,
  onDetail,
}: {
  s: SignalRow;
  onDetail: (s: SignalRow) => void;
}) {
  const dir = SIGNAL_DIRECTION[s.direction] ?? SIGNAL_DIRECTION.HOLD;
  const DirIcon = dir.icon;
  const cons = consensusMeta(s.consensusGate, s.consensusRatio);
  const st = statusMeta(s);
  return (
    <li className="transition-colors hover:bg-accent/40">
      {/* Desktop — 1 hàng ngang cấu trúc (M4.2.1) */}
      <div className="hidden items-center gap-3 px-4 py-2.5 sm:flex">
        <Badge className={cn("gap-1", dir.className)}>
          <DirIcon className="size-3" aria-hidden="true" />
          {dir.label}
        </Badge>
        <span className="flex min-w-[92px] items-baseline gap-1.5">
          <span className="text-sm font-bold tracking-tight">{s.symbol}</span>
          <span className="tabular-nums text-[11px] text-muted-foreground">
            {s.score.toFixed(0)}/100
          </span>
        </span>
        {cons ? (
          <ChipMeta tone={cons.tone} title={cons.title}>
            {cons.label}
          </ChipMeta>
        ) : null}
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={s.rationale}>
          {shortRationale(s.rationale)}
        </p>
        <span className="flex shrink-0 items-center gap-1.5">
          <ChipMeta tone={st.tone} title={st.title}>
            {st.label}
          </ChipMeta>
          {s.sandboxExecuted && (
            <ChipMeta
              tone="primary"
              title="Agents đã tự thực thi tín hiệu này trong tài khoản thử nghiệm (K1) — xem lệnh ở Danh mục → Thử nghiệm"
            >
              <FlaskConical className="size-3" aria-hidden="true" />
              Thực thi · thử nghiệm
            </ChipMeta>
          )}
          <VerdictChips s={s} />
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-3 text-xs"
          onClick={() => onDetail(s)}
        >
          Chi tiết
        </Button>
      </div>
      {/* Mobile — thẻ dọc (M4.2.4): badge+mã+score / chips / lý do / nút to */}
      <div className="flex flex-col gap-1.5 px-4 py-2.5 sm:hidden">
        <div className="flex items-center gap-2">
          <Badge className={cn("gap-1", dir.className)}>
            <DirIcon className="size-3" aria-hidden="true" />
            {dir.label}
          </Badge>
          <span className="text-sm font-bold tracking-tight">{s.symbol}</span>
          <span className="tabular-nums text-[11px] text-muted-foreground">
            {s.score.toFixed(0)}/100
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {cons ? (
            <ChipMeta tone={cons.tone} title={cons.title}>
              {cons.label}
            </ChipMeta>
          ) : null}
          <ChipMeta tone={st.tone} title={st.title}>
            {st.label}
          </ChipMeta>
          {s.sandboxExecuted && (
            <ChipMeta
              tone="primary"
              title="Agents đã tự thực thi tín hiệu này trong tài khoản thử nghiệm (K1)"
            >
              <FlaskConical className="size-3" aria-hidden="true" />
              Thực thi · thử nghiệm
            </ChipMeta>
          )}
          <VerdictChips s={s} />
        </div>
        <p className="truncate text-xs text-muted-foreground" title={s.rationale}>
          {shortRationale(s.rationale)}
        </p>
        <Button
          variant="outline"
          className="min-h-11 w-full"
          onClick={() => onDetail(s)}
        >
          Chi tiết
        </Button>
      </div>
    </li>
  );
}

/* ─────────────── Hàng đã xử lý — gọn 1 dòng (M4.2.2) ─────────────── */

function DoneSignalRow({
  s,
  onDetail,
}: {
  s: SignalRow;
  onDetail: (s: SignalRow) => void;
}) {
  const dir = SIGNAL_DIRECTION[s.direction] ?? SIGNAL_DIRECTION.HOLD;
  const DirIcon = dir.icon;
  const st = statusMeta(s);
  return (
    <li className="transition-colors hover:bg-accent/40">
      {/* Desktop — 1 dòng gọn: badge + mã + trạng thái + phán quyết + Chi tiết */}
      <div className="hidden items-center gap-3 px-4 py-2 sm:flex">
        <Badge className={cn("gap-1", dir.className)}>
          <DirIcon className="size-3" aria-hidden="true" />
          {dir.label}
        </Badge>
        <span className="flex items-baseline gap-1.5">
          <span className="text-sm font-semibold tracking-tight">{s.symbol}</span>
          <span className="tabular-nums text-[11px] text-muted-foreground">
            {s.score.toFixed(0)}/100
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-1.5">
          <ChipMeta tone={st.tone} title={st.title}>
            {st.label}
          </ChipMeta>
          <VerdictChips s={s} />
        </span>
        <span className="flex-1" aria-hidden="true" />
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-3 text-xs"
          onClick={() => onDetail(s)}
        >
          Chi tiết
        </Button>
      </div>
      {/* Mobile — thẻ dọc gọn */}
      <div className="flex flex-col gap-1.5 px-4 py-2.5 sm:hidden">
        <div className="flex items-center gap-2">
          <Badge className={cn("gap-1", dir.className)}>
            <DirIcon className="size-3" aria-hidden="true" />
            {dir.label}
          </Badge>
          <span className="text-sm font-bold tracking-tight">{s.symbol}</span>
          <span className="tabular-nums text-[11px] text-muted-foreground">
            {s.score.toFixed(0)}/100
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <ChipMeta tone={st.tone} title={st.title}>
            {st.label}
          </ChipMeta>
          <VerdictChips s={s} />
        </div>
        <Button variant="outline" className="min-h-11 w-full" onClick={() => onDetail(s)}>
          Chi tiết
        </Button>
      </div>
    </li>
  );
}

/* ─────────────── Hàng compact — workspace Tổng quan (props #34) ─────────────── */

function CompactSignalRow({ s }: { s: SignalRow }) {
  const dir = SIGNAL_DIRECTION[s.direction] ?? SIGNAL_DIRECTION.HOLD;
  const DirIcon = dir.icon;
  const cons = consensusMeta(s.consensusGate, s.consensusRatio);
  // PHIÊN #91 (tái triển khai): "Đã chuyển lệnh" chỉ khi CÓ lệnh paper THẬT
  // (paperOrdered) — auto-duyệt đủ đồng thuận nhưng paper 0 ₫ → chỉ "Đã duyệt".
  const acted = s.status === "ACTED" || s.actedAt != null;
  return (
    <li className="flex flex-col gap-1 py-2.5 pr-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge className={cn("gap-1", dir.className)}>
          <DirIcon className="size-3" aria-hidden="true" />
          {dir.label}
        </Badge>
        <span className="text-sm font-bold tracking-tight">{s.symbol}</span>
        <span className="tabular-nums text-xs text-muted-foreground">
          {s.score.toFixed(0)}/100
        </span>
        {cons ? (
          <ChipMeta tone={cons.tone} title={cons.title}>
            {cons.label}
          </ChipMeta>
        ) : null}
        {s.sandboxExecuted && (
          <ChipMeta
            tone="primary"
            title="Agents đã tự thực thi tín hiệu này trong tài khoản thử nghiệm (K1)"
          >
            Thực thi
          </ChipMeta>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          {acted &&
            (s.paperOrdered ? (
              <ChipMeta tone="up" title="Tín hiệu đã được duyệt (≥80% đồng thuận) và lệnh giấy đã đặt — chờ khớp">
                Đã chuyển lệnh
              </ChipMeta>
            ) : (
              <ChipMeta
                tone="up"
                title="Tín hiệu đã được DUYỆT theo cổng đồng thuận ≥80% — lệnh giấy chưa đặt được (tài khoản giấy 0 ₫), quyết định tách khỏi số dư"
              >
                Đã duyệt
              </ChipMeta>
            ))}
          {s.status === "REJECTED" && (
            <ChipMeta
              tone="down"
              title={s.rejectNote ?? "Tín hiệu đã bị từ chối theo cổng đồng thuận"}
            >
              Đã từ chối
            </ChipMeta>
          )}
          <span className="whitespace-nowrap text-[11px] text-muted-foreground">
            {formatDistanceToNow(new Date(s.createdAt), { addSuffix: true, locale: vi })}
          </span>
        </span>
      </div>
      {s.rationale && (
        <p className="truncate text-xs text-muted-foreground" title={s.rationale}>
          {s.rationale}
        </p>
      )}
    </li>
  );
}

/* ─────────────────── SignalsFeed ─────────────────── */

/**
 * Phiên #34 — props tùy chọn cho bản compact trên workspace Tổng quan:
 * - limit: số dòng hiển thị tối đa (chỉ hiệu lực khi compact).
 * - compact: mỗi dòng gọn hơn (không nhóm, không dialog).
 * - onSeeAll: callback footer "Xem tất cả (N) →" (vd chuyển sang tab Tín hiệu).
 */
export interface SignalsFeedProps {
  limit?: number;
  compact?: boolean;
  onSeeAll?: () => void;
}

export function SignalsFeed({ limit, compact = false, onSeeAll }: SignalsFeedProps) {
  // #105 — khoảng thời gian toàn cục trên thanh bar: lọc tín hiệu theo khoảng.
  const { rangeQuery, rangeKey, dateRange } = useDateRange();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["signals", rangeKey],
    queryFn: () =>
      apiGet<{ signals: SignalRow[] }>(`/api/signals${rangeQuery ? `?${rangeQuery}` : ""}`),
    staleTime: 60_000,
  });

  // Dialog tier-3 (chỉ feed đầy đủ — compact không mở dialog).
  const [detail, setDetail] = React.useState<SignalRow | null>(null);

  const signals = data?.signals ?? [];
  const maxRows = compact ? (limit ?? 5) : signals.length;
  const visible = signals.slice(0, maxRows);
  const hiddenCount = signals.length - visible.length;

  // M4.2.2 — nhóm "Cần quyết": ACTIVE + MUA/BÁN + chưa actedAt/rejectedAt.
  const pendingIds = new Set(
    signals
      .filter(
        (s) =>
          s.status === "ACTIVE" &&
          s.direction !== "HOLD" &&
          s.actedAt == null &&
          s.rejectedAt == null,
      )
      .map((s) => s.id),
  );
  const pending = signals.filter((s) => pendingIds.has(s.id));
  const done = signals.filter((s) => !pendingIds.has(s.id));

  // Tên nhóm dưới ghép từ các loại thật sự có mặt (m4.2.2):
  const doneTitle =
    [
      done.some((s) => s.actedAt != null || s.status === "ACTED") ? "Đã thực thi" : null,
      done.some((s) => s.status === "EXPIRED") ? "Hết hạn" : null,
      done.some((s) => s.rejectedAt != null || s.status === "REJECTED") ? "Từ chối" : null,
      done.some((s) => s.status === "ACTIVE") ? "Không cần quyết" : null,
    ]
      .filter(Boolean)
      .join(" · ") || "Đã xử lý";

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Radar className="size-4 text-muted-foreground" aria-hidden="true" />
          Tín hiệu giao dịch
          {dateRange != null && (
            <span className="rounded-sm bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              theo khoảng đã chọn
            </span>
          )}
        </CardTitle>
        <CardDescription>
          {compact ? (
            `Khuyến nghị mới nhất từ các agent · ${signals.length} tín hiệu`
          ) : (
            <>
              <span>
                {pending.length > 0
                  ? `Khuyến nghị mới nhất từ các agent · ${pending.length.toLocaleString("vi-VN")} chờ quyết trong ${signals.length.toLocaleString("vi-VN")} tín hiệu`
                  : "Khuyến nghị mới nhất từ các agent"}
              </span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground/80">
                Quy tắc phiên #91 — 1 là duyệt, 2 là từ chối: đủ đồng thuận ≥80% →
                duyệt NGAY cuối chu kỳ (kèm lệnh giấy khi có tiền); không đủ / GIỮ →
                từ chối NGAY có lý do. Không tín hiệu nào treo chờ vô hạn.
              </span>
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="pb-0">
        {isLoading ? (
          // Skeleton đúng kích thước hàng ListRow (h-14) — không khối to (§2.5).
          <div className="flex flex-col gap-2 pb-4">
            {Array.from({ length: compact ? 3 : 4 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-lg" />
            ))}
          </div>
        ) : isError ? (
          <div className="mb-4 rounded-lg border border-down/30 bg-down/5 px-4 py-3">
            <p className="text-sm font-medium text-down">
              {error?.message ?? "Không tải được tín hiệu."}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Thử tải lại trang; nếu vẫn lỗi, kiểm tra API <code>/api/signals</code> trong log
              server.
            </p>
          </div>
        ) : signals.length === 0 ? (
          <EmptyState
            icon={Radar}
            title={
              dateRange != null
                ? "Chưa có tín hiệu nào trong khoảng đã chọn"
                : "Chưa có tín hiệu nào"
            }
            description={
              dateRange != null
                ? "Không có tín hiệu nào sinh ra trong khoảng đang chọn — thử mở rộng khoảng trên bộ chọn thời gian của thanh bar trên cùng, hoặc chạy chu kỳ agents mới."
                : "Tín hiệu xuất hiện sau khi agents chạy chu kỳ phân tích và hội đồng bỏ phiếu khuyến nghị."
            }
            action={
              <span className="inline-flex items-center gap-1.5 rounded-full border border-dashed px-3 py-1 text-xs text-muted-foreground">
                <Play className="size-3.5" aria-hidden="true" />
                Chạy chu kỳ agents — nút “Chạy agent” trên thanh bar trên cùng
              </span>
            }
            className="mb-4"
          />
        ) : compact ? (
          <ul className="divide-y overflow-y-auto custom-scrollbar max-h-none">
            {visible.map((s) => (
              <CompactSignalRow key={s.id} s={s} />
            ))}
          </ul>
        ) : (
          <div className="flex max-h-[32rem] flex-col gap-3 overflow-y-auto custom-scrollbar pb-1">
            {/* ── Nhóm "Cần quyết" — viền PRIMARY, nổi trên cùng (M4.2.2) ── */}
            {pending.length > 0 && (
              <section
                aria-labelledby="signals-pending-h"
                className="overflow-hidden rounded-lg border border-primary/40"
              >
                <div
                  id="signals-pending-h"
                  className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-primary/25 bg-primary/[0.06] px-4 py-2"
                  title="Hiếm khi có tín hiệu ở đây — auto-decision cuối chu kỳ tự duyệt/từ chối toàn bộ tín hiệu theo cổng đồng thuận (phiên #91). Nhóm này chỉ còn khi auto-decision lỗi fail-soft."
                >
                  <span className="text-xs font-semibold uppercase tracking-wider text-primary">
                    Cần quyết
                  </span>
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {pending.length.toLocaleString("vi-VN")} tín hiệu chờ quyết
                  </span>
                  <span className="ml-auto text-[10px] text-muted-foreground/70">
                    auto-decision lỗi fail-soft — quyết tay dự phòng
                  </span>
                </div>
                <ul className="divide-y divide-border/60">
                  {pending.map((s) => (
                    <PendingSignalRow key={s.id} s={s} onDetail={setDetail} />
                  ))}
                </ul>
              </section>
            )}

            {/* ── Nhóm đã xử lý — gọn 1 dòng mỗi tín hiệu (M4.2.2) ── */}
            {done.length > 0 && (
              <section
                aria-labelledby="signals-done-h"
                className="overflow-hidden rounded-lg border border-border/60"
              >
                <div
                  id="signals-done-h"
                  className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-border/60 bg-muted/30 px-4 py-2"
                >
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {doneTitle}
                  </span>
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {done.length.toLocaleString("vi-VN")} tín hiệu
                  </span>
                </div>
                <ul className="divide-y divide-border/60">
                  {done.map((s) => (
                    <DoneSignalRow key={s.id} s={s} onDetail={setDetail} />
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}

        {/* Footer compact — "Xem tất cả (N) →" chuyển sang workspace Tín hiệu */}
        {compact && !isLoading && !isError && hiddenCount > 0 && onSeeAll && (
          <button
            type="button"
            onClick={onSeeAll}
            className="my-2 flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg border border-dashed text-sm font-medium text-primary transition-colors hover:bg-accent"
          >
            Xem tất cả ({signals.length.toLocaleString("vi-VN")})
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </button>
        )}
      </CardContent>

      {/* Dialog tier-3 — FULL rationale + JSON + Duyệt/Từ chối (M4.2.1).
       * Mount có điều kiện: đóng dialog = unmount = state (ghi chú) reset. */}
      {!compact && detail != null && (
        <SignalDetailDialog
          signal={detail}
          onOpenChange={(open) => {
            if (!open) setDetail(null);
          }}
        />
      )}
    </Card>
  );
}
