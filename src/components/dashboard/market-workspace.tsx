"use client";

import * as React from "react";
import { MarketSummary } from "@/components/dashboard/market-summary";
import { MarketBreadthCard } from "@/components/dashboard/market-breadth-card";
import { QuotesTable } from "@/components/dashboard/quotes-table";
import { PriceChart } from "@/components/dashboard/price-chart";
import { NewsCard } from "@/components/dashboard/news-card";
import { RelationsCard } from "@/components/dashboard/relations-card";
import { MultiMarketCard } from "@/components/dashboard/multi-market-card";

/**
 * Phiên #34 — workspace "Thị trường": tách khỏi module Tổng quan cũ.
 * Bảng giá + biểu đồ + tin tức — dữ liệu EOD thật VNDIRECT (dchart).
 * M2 #103: card Quan hệ thị trường (cơ chế số 2 — học quan hệ liên thị trường).
 * #106: card Đa rổ thị trường (5 lớp tài sản — trái phiếu/forex/hàng hoá/
 * quốc tế cho nghiên cứu phân bổ của Hội đồng).
 *
 * #110 M4.5 (UIUX_UPGRADE_BLUEPRINT §4 M4.5): state cục bộ basketFilter —
 * bấm rổ trong card Đa rổ → lọc bảng giá theo lớp tài sản đó (mapping
 * basket-filter.ts); null = tất cả nhóm. Hiệu chỉnh v1.2 (#108): các rổ
 * phi-VN là THAM CHIẾU nghiên cứu, vũ trụ đầu tư chỉ CP/ETF Việt Nam.
 */
export function MarketWorkspace() {
  const [basketFilter, setBasketFilter] = React.useState<string | null>(null);

  return (
    <div
      role="tabpanel"
      id="workspace-panel-market"
      aria-labelledby="workspace-tab-market"
      className="flex flex-col gap-6"
    >
      <h2 className="sr-only">Thị trường — bảng giá &amp; biểu đồ VN30</h2>

      {/* 1. Stat cards tổng quan thị trường */}
      <MarketSummary />

      {/* 1b. UNIVERSE_TIERING §7 — bức tranh toàn sàn T0 (breadth A/D + %MA
       * trên ~1.000 mã CORE+BROAD) + bảng mã trọng tâm đề xuất (screen §4).
       * Trả nợ Task 186: breadth cũ chỉ ~30 mã HOSE quoted CORE. */}
      <MarketBreadthCard />

      {/* 2. Header section nhỏ */}
      <div className="flex items-baseline gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Bảng giá &amp; biểu đồ VN30
        </h3>
        <span className="text-xs text-muted-foreground/80">
          dữ liệu EOD thật VNDIRECT
        </span>
      </div>

      {/* 3. Bảng giá + biểu đồ — M4.5.2: truyền rổ đang lọc xuống bảng giá */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-5">
        <div className="xl:col-span-2">
          <QuotesTable
            basketFilter={basketFilter}
            onClearBasketFilter={() => setBasketFilter(null)}
          />
        </div>
        <div className="xl:col-span-3">
          <PriceChart />
        </div>
      </div>

      {/* 4. Tin tức thị trường */}
      <NewsCard />

      {/* 5. Quan hệ thị trường đã học (M2 #103 — cơ chế số 2) */}
      <RelationsCard />

      {/* 6. Đa rổ thị trường — 5 lớp tài sản (#106 · #110 M4.5.1 sparkline
       * nav30d + bấm rổ lọc bảng giá) */}
      <MultiMarketCard
        selectedBasket={basketFilter}
        onSelectBasket={(basket) => setBasketFilter(basket)}
      />
    </div>
  );
}
