"use client";

/**
 * src/components/dashboard/multi-market-card.tsx — #106 → #110 M4.5.1 nâng cấp
 * (UIUX_UPGRADE_BLUEPRINT §4 M4.5 · COUNCIL_STEWARDSHIP_BLUEPRINT §2.4):
 * bảng chỉ số 5 RỔ THỊ TRƯỜNG trong module Thị trường — mỗi rổ MỘT HÀNG:
 * [chip rổ — active viền primary] [ret 1/5/30 phiên ChipMeta tone ngữ nghĩa]
 * [Sparkline nav30d base 100 · kit #110-F, height 40, tone auto].
 *
 * Hiệu chỉnh v1.2 (#108 — chính sách VN-only): 5 lớp tài sản là chỉ số
 * THAM CHIẾU cho nghiên cứu (theo dõi tỷ giá/hàng hoá/cảm xúc qtế ảnh
 * hưởng VN) — đầu tư chỉ tại thị trường Việt Nam theo chính sách Hội đồng.
 *
 * Hàng bấm được: click rổ → lọc bảng giá theo lớp tài sản đó (state
 * basketFilter nằm ở market-workspace, truyền xuống qua props) — bấm lại
 * rổ đang chọn để bỏ lọc.
 *
 * Dữ liệu: useCouncilBaskets (#110-F — GET /api/council/baskets, cùng
 * engine basketStatsCached với prompt hội nghị, 1 nguồn sự thật; nav30d
 * = NAV lũy kế 30 phiên base 100, cùng compound với ret30d).
 */

import * as React from "react";
import { Database, Globe2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ChipMeta, EmptyState, Sparkline } from "@/components/dashboard/kit";
import { BASKET_LABELS } from "@/components/dashboard/market/basket-filter";
import { useCouncilBaskets } from "@/hooks/use-council";
import { formatPct } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Tone ngữ nghĩa #45 cho lợi suất: tăng up · giảm down · 0/null flat. */
function retTone(v: number | null | undefined): "up" | "down" | "flat" {
  if (v == null || Number.isNaN(v) || v === 0) return "flat";
  return v > 0 ? "up" : "down";
}

export interface MultiMarketCardProps {
  /** Rổ đang chọn (lọc bảng giá) — null = tất cả. */
  selectedBasket?: string | null;
  /** Bấm rổ: chọn rổ (hoặc bỏ chọn khi bấm lại rổ đang chọn). */
  onSelectBasket?: (basket: string | null) => void;
}

export function MultiMarketCard({
  selectedBasket = null,
  onSelectBasket,
}: MultiMarketCardProps) {
  const basketsQuery = useCouncilBaskets();

  const baskets = basketsQuery.data?.baskets ?? [];
  const anyCoverage = baskets.some((b) => b.coverageDays > 0);

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Globe2 className="size-4 text-primary" aria-hidden="true" />
          Đa rổ thị trường — 5 lớp tài sản
        </CardTitle>
        {/* Hiệu chỉnh v1.2 (#108): nhãn ngữ nghĩa v2.2 — THAM CHIẾU nghiên cứu,
         * vũ trụ đầu tư chỉ CP/ETF Việt Nam. */}
        <CardDescription>
          5 lớp tài sản — chỉ số THAM CHIẾU cho nghiên cứu (đầu tư chỉ tại thị
          trường Việt Nam theo chính sách Hội đồng). Thống kê 30 phiên gần
          nhất · bấm một rổ để lọc bảng giá theo lớp đó, bấm lại để bỏ lọc.
        </CardDescription>
      </CardHeader>
      <CardContent className="pb-0">
        {basketsQuery.isLoading ? (
          <div className="flex flex-col gap-2 px-6 pb-6">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : basketsQuery.isError ? (
          <p className="px-6 pb-6 text-sm text-down">
            {basketsQuery.error?.message ?? "Không tính được chỉ số rổ."}
          </p>
        ) : !anyCoverage ? (
          <div className="px-4 pb-6 sm:px-6">
            <EmptyState
              icon={Database}
              title="Chưa có dữ liệu rổ nào"
              description={
                <>
                  Chạy đồng bộ đa thị trường (intl-sync 06:15 ICT hằng ngày
                  hoặc nút Nạp lại trong Khối dữ liệu) — rổ trái phiếu/forex
                  chính về dữ liệu trong 1 ngày đầu.
                </>
              }
            />
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {baskets.map((b) => {
              const isActive = selectedBasket === b.key;
              const hasNav = b.nav30d != null && b.nav30d.length >= 2;
              return (
                <button
                  key={b.key}
                  type="button"
                  data-basket={b.key}
                  aria-pressed={isActive}
                  title={
                    isActive
                      ? `Bỏ lọc bảng giá — rổ ${BASKET_LABELS[b.key] ?? b.short}`
                      : `Lọc bảng giá theo rổ ${BASKET_LABELS[b.key] ?? b.short}`
                  }
                  onClick={() => onSelectBasket?.(isActive ? null : b.key)}
                  className={cn(
                    "flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors outline-none sm:px-6",
                    "hover:bg-accent/50 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40",
                    isActive && "rounded-lg bg-primary/10 ring-1 ring-primary",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {/* Chip rổ — active: viền primary (chấm trạng thái M4.5.1) */}
                      <span
                        className={cn(
                          "shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                          isActive
                            ? "border-primary/60 bg-primary/5 text-primary"
                            : "border-border bg-muted/40 text-muted-foreground",
                        )}
                      >
                        {BASKET_LABELS[b.key] ?? b.short}
                      </span>
                      <span className="hidden shrink-0 rounded-full border bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline">
                        {b.members.length} mã · {b.coverageDays} phiên
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      {b.description}
                      {b.coverageDays === 0
                        ? " — CHƯA có dữ liệu (chờ đồng bộ)"
                        : b.coverageDays < 25
                          ? ` — đang tích luỹ (${b.firstDate ?? "?"} → ${b.lastDate ?? "?"})`
                          : ""}
                    </p>
                  </div>
                  {/* Lợi suất 1/5/30 phiên — ChipMeta tone ngữ nghĩa (#45) */}
                  <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
                    <ChipMeta tone={retTone(b.ret1d)} title="Lợi suất 1 phiên">
                      1 phiên {formatPct(b.ret1d)}
                    </ChipMeta>
                    <ChipMeta
                      tone={retTone(b.ret5d)}
                      title="Lợi suất 5 phiên"
                      className="hidden sm:inline-flex"
                    >
                      5 phiên {formatPct(b.ret5d)}
                    </ChipMeta>
                    <ChipMeta tone={retTone(b.ret30d)} title="Lợi suất 30 phiên">
                      30 phiên {formatPct(b.ret30d)}
                    </ChipMeta>
                    <div className="hidden flex-col items-end md:flex">
                      <span className="text-[10px] text-muted-foreground">
                        vol 30 phiên
                      </span>
                      <span className="text-sm font-medium tabular-nums">
                        {b.vol30d != null ? `${b.vol30d.toFixed(2).replace(".", ",")}%` : "—"}
                      </span>
                    </div>
                  </div>
                  {/* NAV lũy kế 30 phiên base 100 — Sparkline kit (#110-F) */}
                  <div className="w-20 shrink-0 sm:w-28">
                    {hasNav ? (
                      <Sparkline
                        values={b.nav30d as number[]}
                        height={40}
                        tone="auto"
                        className="shrink-0"
                        ariaLabel={`NAV 30 phiên rổ ${BASKET_LABELS[b.key] ?? b.short} — ${formatPct(b.ret30d)} so nền 100`}
                      />
                    ) : (
                      <div className="flex h-10 items-center justify-center rounded-md border border-dashed text-[10px] text-muted-foreground/60">
                        chưa đủ dữ liệu
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
        <p className="px-4 pb-4 pt-3 text-[11px] leading-relaxed text-muted-foreground sm:px-6">
          Mô hình hoá minh bạch: rổ trái phiếu = thang duration đơn giản
          (−D·Δy + carry, D = 4,5/8/17) · cổ phiếu quốc tế &amp; hàng hoá quy
          VND qua USD/VND hằng ngày · forex = lợi ích giữ USD so với VND.
          Chi tiết xem <strong>COUNCIL_STEWARDSHIP_BLUEPRINT</strong> §2.4.
        </p>
      </CardContent>
    </Card>
  );
}
