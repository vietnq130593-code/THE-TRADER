"use client";

// (Task 144 P2-c) — tách từ synthesis-workspace.tsx (pure move)
// Card 1b (B5) "Đa thị trường — posterior phân đoạn": bảng segments + trọng số
// đóng góp composite VN (mobile gộp 1 hàng, desktop 6 cột).

import { Globe } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { SegmentAssessment } from "@/lib/types";
import { DIRECTION } from "./constants";
import { formatShare, pct1, segmentShort } from "./helpers";

/* ─────────────────── 1b. B5 — Đa thị trường: posterior phân đoạn ─────────────────── */

export function SegmentsCard({ segments }: { segments: SegmentAssessment[] }) {
  // Tỷ lệ đóng góp composite = compositeWeight / Σw — chỉ tính trên segment
  // có weight > 0 (bỏ COMPOSITE là tổng, bỏ INTERNATIONAL weight null).
  const weighted = segments.filter(
    (s) =>
      s.compositeWeight != null &&
      s.compositeWeight > 0 &&
      s.segment !== "VN-COMPOSITE"
  );
  const totalWeight = weighted.reduce(
    (sum, s) => sum + (s.compositeWeight ?? 0),
    0
  );
  const shareOf = (s: SegmentAssessment): number | null =>
    totalWeight > 0 &&
    s.compositeWeight != null &&
    s.compositeWeight > 0 &&
    s.segment !== "VN-COMPOSITE"
      ? s.compositeWeight / totalWeight
      : null;
  const weightNote = weighted
    .map((s) => `${segmentShort(s.segment)} ${formatShare(shareOf(s)) ?? "0%"}`)
    .join(" · ");

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Globe className="size-4 text-muted-foreground" aria-hidden="true" />
          Đa thị trường — posterior phân đoạn
        </CardTitle>
        <CardDescription>
          {segments.length} phân đoạn · composite VN = trung bình trọng số theo
          ADTV thật (index cố định 0,05/index)
        </CardDescription>
      </CardHeader>
      <CardContent className="pb-0">
        <div className="max-h-96 overflow-y-auto custom-scrollbar">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Phân đoạn</TableHead>
                <TableHead className="text-xs">Hướng</TableHead>
                <TableHead className="text-xs">P(tăng)</TableHead>
                <TableHead className="hidden text-xs sm:table-cell">
                  P(đi ngang)
                </TableHead>
                <TableHead className="text-xs">P(giảm)</TableHead>
                <TableHead className="hidden text-xs sm:table-cell">
                  Trọng số
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {segments.map((s) => (
                <SegmentRow key={s.segment} row={s} share={shareOf(s)} />
              ))}
            </TableBody>
          </Table>
        </div>
        {weightNote && (
          <p className="py-3 text-[11px] leading-relaxed text-muted-foreground">
            Trọng số: {weightNote} — tỷ lệ đóng góp vào composite VN (ADTV đo
            được, index khiêm tốn cố định).
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function SegmentRow({
  row,
  share,
}: {
  row: SegmentAssessment;
  share: number | null;
}) {
  const dir = DIRECTION[row.marketDirection] ?? DIRECTION.NEUTRAL;
  const isComposite = row.segment === "VN-COMPOSITE";
  // INTERNATIONAL (hoặc segment weight null) — tham khảo, không vào composite.
  const isReference =
    !isComposite && (row.segment === "INTERNATIONAL" || row.compositeWeight == null);
  const shareText = formatShare(share);

  return (
    <TableRow
      className={cn(isComposite && "border-t-2 border-border bg-muted/40")}
    >
      {/* Mobile — 1 hàng gộp (không tràn cột ở 390px) */}
      <TableCell colSpan={6} className="sm:hidden">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-0.5 leading-tight">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-xs font-semibold" title={row.note}>
                {row.label}
              </span>
              {isComposite && (
                <Badge variant="secondary" className="px-1 py-0 text-[9px]">
                  composite
                </Badge>
              )}
              {isReference && (
                <Badge
                  variant="outline"
                  className="px-1 py-0 text-[9px] text-muted-foreground"
                >
                  tham khảo
                </Badge>
              )}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {row.symbolCount.toLocaleString("vi-VN")} mã
              {isComposite
                ? " · Σ 100%"
                : shareText
                  ? ` · TL ${shareText}`
                  : ""}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Badge variant="outline" className={cn("text-[10px]", dir.className)}>
              {dir.label}
            </Badge>
            <span className="tabular-nums text-[11px] font-semibold">
              {pct1(row.pUp)}
            </span>
            <span className="text-[10px] text-muted-foreground">/</span>
            <span className="tabular-nums text-[11px] text-muted-foreground">
              {pct1(row.pDown)}
            </span>
          </div>
        </div>
      </TableCell>

      {/* Desktop — 6 cột đầy đủ */}
      <TableCell className="hidden sm:table-cell">
        <div className="flex flex-col leading-tight" title={row.note}>
          <span className="flex items-center gap-1.5 text-xs font-semibold">
            {row.label}
            {isComposite && (
              <Badge variant="secondary" className="px-1 py-0 text-[9px]">
                composite
              </Badge>
            )}
          </span>
          <span className="text-[10px] text-muted-foreground">
            {row.symbolCount.toLocaleString("vi-VN")} mã
          </span>
        </div>
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        <Badge variant="outline" className={cn("text-[10px]", dir.className)}>
          {dir.label}
        </Badge>
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        <span
          className={cn(
            "tabular-nums text-xs",
            row.marketDirection === "BULLISH"
              ? "font-semibold text-up"
              : "text-muted-foreground"
          )}
        >
          {pct1(row.pUp)}
        </span>
      </TableCell>
      <TableCell className="hidden tabular-nums text-xs text-muted-foreground sm:table-cell">
        {pct1(row.pFlat)}
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        <span
          className={cn(
            "tabular-nums text-xs",
            row.marketDirection === "BEARISH"
              ? "font-semibold text-down"
              : "text-muted-foreground"
          )}
        >
          {pct1(row.pDown)}
        </span>
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        {isComposite ? (
          <span
            className="tabular-nums text-xs text-muted-foreground"
            title="Tổng hợp có trọng số của các phân đoạn thành phần"
          >
            Σ 100%
          </span>
        ) : shareText ? (
          <span
            className="tabular-nums text-xs text-muted-foreground"
            title="Tỷ lệ đóng góp vào composite VN"
          >
            {shareText}
          </span>
        ) : (
          <span className="text-[11px] italic text-muted-foreground">tham khảo</span>
        )}
      </TableCell>
    </TableRow>
  );
}
