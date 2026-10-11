"use client";

import { create } from "zustand";

/**
 * Local UI state (TECHNICAL_BLUEPRINT §3 — Zustand store).
 * Server state lives in TanStack Query; this store only holds
 * ephemeral UI selections to avoid prop drilling and duplicated
 * sources of truth.
 */

/**
 * PHASE3_BLUEPRINT §3.1 + phiên #34 — workspace tab của app shell (single route `/`).
 * Tổng quan cũ được chia thành 7 module nhỏ hơn theo yêu cầu:
 * overview (tin nhanh) · market (bảng giá + biểu đồ) · portfolio (danh mục) ·
 * signals (tín hiệu + rủi ro + vận hành) · agents (đội agent) ·
 * synthesis (Bộ tổng hợp Bayes) · settings (Cài đặt VNDIRECT).
 */
export type Workspace =
  | "overview"
  | "market"
  | "portfolio"
  | "signals"
  | "agents"
  | "synthesis"
  | "settings";

/** PHASE3_BLUEPRINT §5.1 — chế độ render biểu đồ giá. */
export type ChartMode = "candle" | "line";

interface UiState {
  /** Symbol selected for the price chart / quotes table highlight. */
  selectedSymbol: string;
  setSelectedSymbol: (symbol: string) => void;

  /** Price chart timeframe in trading days (30 / 60 / 90). */
  chartDays: number;
  setChartDays: (days: number) => void;

  /** Active portfolio tab (positions | orders | trades). */
  portfolioTab: string;
  setPortfolioTab: (tab: string) => void;

  /** Phiên #88 (K1) — thế giới tài khoản đang xem trong Danh mục:
   *  "paper" (tài khoản Giữ của trader) | "sandbox" (tài khoản Thử nghiệm
   *  K1 — agents tự giao dịch). Đưa vào store để nút trong khối Settings
   *  "Cơ chế thử nghiệm" nhảy thẳng sang Danh mục → Thử nghiệm. */
  portfolioWorld: "paper" | "sandbox";
  setPortfolioWorld: (world: "paper" | "sandbox") => void;

  /** Quotes table mode: watchlist-only vs full VN30 board. */
  watchlistOnly: boolean;
  setWatchlistOnly: (value: boolean) => void;

  /** PHASE3 B1: workspace đang mở — chuyển bằng nav, không thêm route. */
  activeWorkspace: Workspace;
  setActiveWorkspace: (ws: Workspace) => void;

  /** Phiên #45 — sidebar trái (điều hướng module) mở/đóng bằng nút logo
   * "The Trader" trên header. Mặc định ĐÓNG — nhấp logo để mở ra/đóng lại. */
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;

  /** PHASE3 B3: biểu đồ giá — nến Nhật hay đường polyline. */
  chartMode: ChartMode;
  setChartMode: (mode: ChartMode) => void;

  /** PHASE3 B3: bảng giá — bật/tắt cột mở rộng (trần/sàn/TC/cao/thấp). */
  quotesExpanded: boolean;
  setQuotesExpanded: (value: boolean) => void;

  /** Realtime (WebSocket market-engine) — connection state + tick mới nhất. */
  realtimeConnected: boolean;
  setRealtimeConnected: (value: boolean) => void;
  lastTickAt: number | null;
  setLastTickAt: (ts: number | null) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  selectedSymbol: "VCB",
  setSelectedSymbol: (symbol) => set({ selectedSymbol: symbol }),

  chartDays: 90,
  setChartDays: (days) => set({ chartDays: days }),

  portfolioTab: "positions",
  setPortfolioTab: (tab) => set({ portfolioTab: tab }),

  portfolioWorld: "paper",
  setPortfolioWorld: (world) => set({ portfolioWorld: world }),

  watchlistOnly: false,
  setWatchlistOnly: (value) => set({ watchlistOnly: value }),

  activeWorkspace: "overview",
  setActiveWorkspace: (ws) => set({ activeWorkspace: ws }),

  sidebarOpen: false,
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),

  chartMode: "candle",
  setChartMode: (mode) => set({ chartMode: mode }),

  quotesExpanded: false,
  setQuotesExpanded: (value) => set({ quotesExpanded: value }),

  realtimeConnected: false,
  setRealtimeConnected: (value) => set({ realtimeConnected: value }),
  lastTickAt: null,
  setLastTickAt: (ts) => set({ lastTickAt: ts }),
}));
