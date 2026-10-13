"use client";

import { ChartLine } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ChipMeta, EmptyState, Sparkline } from "@/components/dashboard/kit";
import { formatDateTime, formatPct, formatVndCompact } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * src/components/dashboard/portfolio/equity-curve-card.tsx — M4.1.1 (#110)
 * "Đường cong equity" của thế giới đang xem (CashSnapshot ≤ 90 điểm, cũ → mới
 * — #110-F đã trả kèm /api/portfolio).
 *
 * Trung thực trạng thái §2.5: < 2 điểm hoặc TOÀN 0 (thế giới Giấy vừa reset
 * "về 0 ₫ tròn trĩnh") → KHÔNG vẽ curve rỗng giả — hiện EmptyState nói rõ
 * engine ghi snapshot mỗi chu kỳ.
 */

export interface EquityCurvePoint {
  createdAt: string;
  equity: number;
}

export function EquityCurveCard({
  curve,
  loading = false,
  className,
}: {
  curve?: EquityCurvePoint[];
  loading?: boolean;
  className?: string;
}) {
  const points = curve ?? [];
  const values = points.map((x) => x.equity);
  const flatZero = values.length === 0 || values.every((v) => v === 0);
  const showable = values.length >= 2 && !flatZero;

  const first = showable ? values[0] : 0;
  const last = showable ? values[values.length - 1] : 0;
  const periodPct = showable && first > 0 ? ((last - first) / first) * 100 : null;
  // Đồng bộ quy tắc tone của kit.Sparkline auto: cuối ≥ đầu → up, ngược lại down.
  const tone = last >= first ? "up" : "down";

  return (
    <Card className={cn("gap-4", className)}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ChartLine className="size-4 text-muted-foreground" aria-hidden="true" />
          Đường cong equity
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-center gap-2 pb-6">
        {loading ? (
          <Skeleton className="h-24 w-full" />
        ) : showable ? (
          <>
            <div className="flex items-center justify-between gap-2">
              <ChipMeta tone={tone} title="Thay đổi từ điểm đầu đến điểm cuối của kỳ hiển thị">
                {periodPct != null ? formatPct(periodPct) : "—"} · {formatVndCompact(last)}
              </ChipMeta>
              <span className="text-[10px] tabular-nums text-muted-foreground">
                {points.length} điểm
              </span>
            </div>
            <Sparkline
              values={values}
              height={96}
              ariaLabel={`Đường cong equity — ${points.length} điểm, từ ${formatVndCompact(first)} đến ${formatVndCompact(last)}`}
            />
            <div className="flex justify-between text-[10px] tabular-nums text-muted-foreground">
              <span>{formatDateTime(points[0].createdAt)}</span>
              <span>{formatDateTime(points[points.length - 1].createdAt)}</span>
            </div>
          </>
        ) : (
          <EmptyState
            icon={ChartLine}
            title="Chưa có dữ liệu đường cong"
            description="Đường cong equity sẽ xuất hiện sau snapshot chu kỳ đầu tiên — engine ghi mỗi chu kỳ."
          />
        )}
      </CardContent>
    </Card>
  );
}
