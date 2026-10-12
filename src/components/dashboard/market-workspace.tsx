"use client";

import { MarketSummary } from "@/components/dashboard/market-summary";
import { QuotesTable } from "@/components/dashboard/quotes-table";
import { PriceChart } from "@/components/dashboard/price-chart";
import { NewsCard } from "@/components/dashboard/news-card";
import { RelationsCard } from "@/components/dashboard/relations-card";

/**
 * Phiên #34 — workspace "Thị trường": tách khỏi module Tổng quan cũ.
 * Bảng giá + biểu đồ + tin tức — dữ liệu EOD thật VNDIRECT (dchart).
 * M2 #103: card Quan hệ thị trường (cơ chế số 2 — học quan hệ liên thị trường).
 */
export function MarketWorkspace() {
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

      {/* 2. Header section nhỏ */}
      <div className="flex items-baseline gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Bảng giá &amp; biểu đồ VN30
        </h3>
        <span className="text-xs text-muted-foreground/80">
          dữ liệu EOD thật VNDIRECT
        </span>
      </div>

      {/* 3. Bảng giá + biểu đồ */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-5">
        <div className="xl:col-span-2">
          <QuotesTable />
        </div>
        <div className="xl:col-span-3">
          <PriceChart />
        </div>
      </div>

      {/* 4. Tin tức thị trường */}
      <NewsCard />

      {/* 5. Quan hệ thị trường đã học (M2 #103 — cơ chế số 2) */}
      <RelationsCard />
    </div>
  );
}
