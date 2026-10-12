"use client";

import * as React from "react";
import { Header } from "@/components/dashboard/header";
import { AppSidebar } from "@/components/dashboard/nav";
import { OverviewWorkspace } from "@/components/dashboard/overview-workspace";
import { MarketWorkspace } from "@/components/dashboard/market-workspace";
import { PortfolioWorkspace } from "@/components/dashboard/portfolio-workspace";
import { SignalsWorkspace } from "@/components/dashboard/signals-workspace";
import { AgentsWorkspace } from "@/components/dashboard/agents-workspace";
import { SynthesisWorkspace } from "@/components/dashboard/synthesis-workspace";
import { SettingsWorkspace } from "@/components/dashboard/settings-workspace";
import { Footer } from "@/components/dashboard/footer";
import { useRealtimeMarket } from "@/hooks/use-realtime";
import { useUiStore, hydrateDateRangeFromSession, type Workspace } from "@/lib/store";

/**
 * PHASE3_BLUEPRINT §3 — App shell (single route `/`):
 * header + workspace switch (Zustand) + sticky footer.
 *
 * Phiên #34 — module "Tổng quan" quá tải được chia thành 7 workspace:
 * overview (gọn) · market · portfolio · signals · agents · synthesis · settings.
 *
 * Phiên #45 — điều hướng module chuyển từ thanh tab ngang sang SIDEBAR TRÁI
 * overlay (AppSidebar), mở/đóng bằng nút logo "The Trader" trên Header.
 * Phiên #46 — sidebar neo BÊN DƯỚI thanh header (không che bar trên cùng),
 * logo tự thân là nút bật/tắt duy nhất.
 *
 * WebSocket realtime (market-engine) gắn MỘT lần ở cấp trang — đặt ngoài
 * workspace component nên đổi module KHÔNG đứt kết nối realtime.
 */

/** Các giá trị ?ws= hợp lệ — ngoài danh sách này → "overview". */
const WORKSPACES: readonly Workspace[] = [
  "overview",
  "market",
  "portfolio",
  "signals",
  "agents",
  "synthesis",
  "settings",
] as const;

function isWorkspace(value: string | null): value is Workspace {
  return value != null && (WORKSPACES as readonly string[]).includes(value);
}

export default function Page() {
  useRealtimeMarket();

  const activeWorkspace = useUiStore((s) => s.activeWorkspace);
  const setActiveWorkspace = useUiStore((s) => s.setActiveWorkspace);

  // ?ws=<id> — deep-link đọc MỘT lần khi mount (vẫn route `/`)
  React.useEffect(() => {
    const ws = new URLSearchParams(window.location.search).get("ws");
    if (isWorkspace(ws)) setActiveWorkspace(ws);
  }, [setActiveWorkspace]);

  // #105 — khoảng thời gian toàn cục sống qua tải lại trang (sessionStorage;
  // hydrate SAU mount → không lệch hydration SSR/CSR).
  React.useEffect(() => {
    hydrateDateRangeFromSession();
  }, []);

  return (
    <div className="flex min-h-screen flex-col">
      {/* Phiên #45 — sidebar trái overlay (z-50) + backdrop (z-40) */}
      <AppSidebar />
      <Header />
      <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 sm:px-6">
        <h1 className="sr-only">
          The Trader — Bảng điều khiển hệ thống giao dịch đa tác tử VNDIRECT
        </h1>

        {activeWorkspace === "overview" ? (
          <OverviewWorkspace />
        ) : activeWorkspace === "market" ? (
          <MarketWorkspace />
        ) : activeWorkspace === "portfolio" ? (
          <PortfolioWorkspace />
        ) : activeWorkspace === "signals" ? (
          <SignalsWorkspace />
        ) : activeWorkspace === "agents" ? (
          <AgentsWorkspace />
        ) : activeWorkspace === "synthesis" ? (
          <SynthesisWorkspace />
        ) : (
          <SettingsWorkspace />
        )}
      </main>
      <Footer />
    </div>
  );
}
