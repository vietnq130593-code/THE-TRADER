"use client";

import { AgentDiscussionCard, AgentsPanel } from "@/components/dashboard/agents-panel";
import { RiskAlerts } from "@/components/dashboard/risk-alerts";
import { SignalsFeed } from "@/components/dashboard/signals-feed";

/**
 * Phiên #34 — workspace "Tín hiệu" (vận hành tín hiệu): tách khỏi module
 * Tổng quan cũ. SignalsFeed cột trái + cột phải RiskAlerts + AgentsPanel
 * (feed broadcast + phê duyệt/từ chối tín hiệu strategist).
 *
 * PHIÊN #90 — cân bằng bố cục theo hiệu lệnh trader: thẻ "Luồng thảo luận
 * giữa các agent" trước đây nằm CUỐI cột hẹp phải (1/3) nên tràn dài xuống
 * dưới trong khi cột trái (Tín hiệu giao dịch max-h-32rem) còn trống lớn —
 * "nhìn lỗi quá thể". Giờ thẻ thảo luận nằm trong CỘT RỘNG (2/3) ngay dưới
 * Tín hiệu giao dịch, dùng hết chỗ trống; cột phải gọn lại còn RiskAlerts +
 * Hệ thống đa tác tử + Nhiệm vụ agent.
 *
 * Mobile (<xl): mọi thẻ xếp dọc theo thứ tự Tín hiệu → Thảo luận → Rủi ro →
 * Hệ thống đa tác tử → Nhiệm vụ (DOM order).
 */
export function SignalsWorkspace() {
  return (
    <div
      role="tabpanel"
      id="workspace-panel-signals"
      aria-labelledby="workspace-tab-signals"
      className="flex flex-col gap-6"
    >
      <h2 className="sr-only">
        Tín hiệu — khuyến nghị, cảnh báo rủi ro &amp; vận hành phê duyệt
      </h2>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        {/* Cột trái (2/3): tín hiệu + luồng thảo luận — #90 dùng hết chỗ trống */}
        <div className="flex flex-col gap-6 xl:col-span-2">
          <SignalsFeed />
          <AgentDiscussionCard />
        </div>
        {/* Cột phải (1/3): rủi ro + hệ thống agent + nhiệm vụ */}
        <div className="flex flex-col gap-6">
          <RiskAlerts />
          {/* AgentsPanel: header hệ thống + nhiệm vụ (phiên #47 — nút chạy
              chu kỳ đã dời về nút "Chạy agent" duy nhất trên Header) */}
          <AgentsPanel />
        </div>
      </div>
    </div>
  );
}
