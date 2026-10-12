"use client";

/**
 * src/components/dashboard/multi-market-card.tsx — #106
 * COUNCIL_STEWARDSHIP_BLUEPRINT §2.4: bảng chỉ số 5 RỔ THỊ TRƯỜNG trong
 * module Thị trường (đặt sau RelationsCard): cổ phiếu VN · cổ phiếu quốc tế ·
 * trái phiếu · forex · hàng hoá — lợi suất 1/5/30 phiên + vol 30 phiên +
 * độ phủ dữ liệu trung thực. Đây là "bảng tổng quan nghiên cứu phân bổ"
 * mà Hội đồng đọc trước khi đề xuất thí nghiệm.
 *
 * Dữ liệu: GET /api/council/baskets (cùng engine basketStatsCached với
 * prompt hội nghị phân bổ — 1 nguồn sự thật). Mô hình hoá ghi rõ ở chân
 * card (BOND = thang duration đơn giản; INTL/COMMODITY quy VND qua USD/VND).
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Globe2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet } from "@/lib/api";
import { changeColor, formatPct } from "@/lib/format";
import type { CouncilBasketsResponse } from "@/lib/types";

const BASKET_SHORT: Record<string, string> = {
  VN_EQUITY: "CP Việt Nam",
  INTL_EQUITY: "CP quốc tế",
  BOND: "Trái phiếu",
  FOREX: "Forex USD/VND",
  COMMODITY: "Hàng hoá",
};

function RetCell({
  value,
  label,
}: {
  value: number | null;
  label: string;
}) {
  return (
    <div className="flex flex-col items-end">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <span className={`text-sm font-medium tabular-nums ${changeColor(value)}`}>
        {formatPct(value)}
      </span>
    </div>
  );
}

export function MultiMarketCard() {
  const basketsQuery = useQuery({
    queryKey: ["council-baskets"],
    queryFn: () => apiGet<CouncilBasketsResponse>("/api/council/baskets"),
    staleTime: 60_000,
  });

  const baskets = basketsQuery.data?.baskets ?? [];
  const anyCoverage = baskets.some((b) => b.coverageDays > 0);

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Globe2 className="size-4 text-primary" aria-hidden="true" />
          Đa rổ thị trường — 5 lớp tài sản
        </CardTitle>
        <CardDescription>
          Vũ trụ nghiên cứu của Hội đồng: cổ phiếu VN (top-10 thanh khoản) ·
          cổ phiếu Mỹ–Hồng Kông · trái phiếu Treasury · forex USD/VND · hàng
          hoá — thống kê 30 phiên gần nhất
        </CardDescription>
      </CardHeader>
      <CardContent className="pb-0">
        {basketsQuery.isLoading ? (
          <div className="flex flex-col gap-2 px-6 pb-6">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : basketsQuery.isError ? (
          <p className="px-6 pb-6 text-sm text-down">
            {basketsQuery.error?.message ?? "Không tính được chỉ số rổ."}
          </p>
        ) : !anyCoverage ? (
          <div className="px-6 pb-6 text-sm text-muted-foreground">
            <strong>Chưa có dữ liệu rổ nào.</strong> Chạy đồng bộ đa thị trường
            (intl-sync 06:15 ICT hằng ngày hoặc nút Nạp lại trong Khối dữ liệu)
            — rổ trái phiếu/forex chính về dữ liệu trong 1 ngày đầu.
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {baskets.map((b) => (
              <div
                key={b.key}
                className="flex items-center gap-3 px-4 py-2.5 sm:px-6"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {BASKET_SHORT[b.key] ?? b.short}
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
                <div className="flex items-center gap-3 sm:gap-5">
                  <RetCell value={b.ret1d} label="1 phiên" />
                  <RetCell value={b.ret5d} label="5 phiên" />
                  <RetCell value={b.ret30d} label="30 phiên" />
                  <div className="hidden flex-col items-end md:flex">
                    <span className="text-[10px] text-muted-foreground">
                      vol 30 phiên
                    </span>
                    <span className="text-sm font-medium tabular-nums">
                      {b.vol30d != null ? `${b.vol30d.toFixed(2).replace(".", ",")}%` : "—"}
                    </span>
                  </div>
                </div>
              </div>
            ))}
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
