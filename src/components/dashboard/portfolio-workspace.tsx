"use client";

import { PortfolioSection } from "@/components/dashboard/portfolio-section";

/**
 * Phiên #34 — workspace "Danh mục": tách khỏi module Tổng quan cũ.
 * #110 M4.1 — PortfolioSection trả về bố cục 3 tầng (KPI tier-1 + curve/donut
 * + tabs vòng đời) dưới dạng fragment; wrapper này giữ tabpanel + tiêu đề
 * sr-only và phẳng gap-6 giữa các tầng.
 */
export function PortfolioWorkspace() {
  return (
    <div
      role="tabpanel"
      id="workspace-panel-portfolio"
      aria-labelledby="workspace-tab-portfolio"
      className="flex flex-col gap-6"
    >
      <h2 className="sr-only">Danh mục — tài khoản, vị thế, lệnh &amp; giao dịch</h2>
      <PortfolioSection />
    </div>
  );
}
