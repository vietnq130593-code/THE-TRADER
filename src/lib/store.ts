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

/** PHIÊN #105 — khoảng thời gian toàn cục do trader chọn trên thanh bar trên cùng.
 * from/to là ngày dạng "YYYY-MM-DD" theo ICT (UTC+7) — cùng quy ước với kho
 * tin tức #101/#102 (ranh giới ngày +07:00, không phải ngày UTC).
 * null = "Toàn bộ thời gian" — hành vi mặc định như cũ (không lọc).
 * Các module có dữ liệu theo thời gian (tín hiệu · lệnh/giao dịch · thảo luận
 * agent · tin tức · cửa sổ biểu đồ) đọc giá trị này để refetch theo khoảng. */
export type DateRange = { from: string; to: string };

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
   *  "Cơ chế thử nghiệm" nhảy thẳng sang Danh mục → Thử nghiệm.
   *
   *  Phiên #90 — portfolioWorldUserSet: trader có BẤM vào bộ lọc Giấy/Thử
   *  nghiệm chưa? false (mặc định — chưa từng bấm) → Danh mục & chip tiền trên
   *  Header TỰ ĐỘNG xem thế giới Thử nghiệm khi cơ chế thử nghiệm đang bật
   *  (hiệu lệnh: "kích hoạt thử nghiệm thì coi tiền chế độ đó là tiền chính
   *  để đầu tư giả định"). Trader bấm chọn tay → ghi đè tự động và tôn trọng
   *  lựa chọn đó cho tới khi tải lại trang. */
  portfolioWorld: "paper" | "sandbox";
  portfolioWorldUserSet: boolean;
  setPortfolioWorld: (world: "paper" | "sandbox") => void;

  /** Phiên #90 — tab đang mở trong module Tổng hợp (7 tab: nhận định ·
   *  bằng chứng · học máy · mạng thần kinh · thuật toán · dữ liệu · tinh
   *  chỉnh). Cùng pattern portfolioTab — giữ lựa chọn khi đổi module qua lại. */
  synthesisTab: string;
  setSynthesisTab: (tab: string) => void;

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

  /** PHIÊN #105 — khoảng thời gian toàn cục (null = toàn bộ). */
  dateRange: DateRange | null;
  setDateRange: (range: DateRange | null) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  selectedSymbol: "VCB",
  setSelectedSymbol: (symbol) => set({ selectedSymbol: symbol }),

  chartDays: 90,
  setChartDays: (days) => set({ chartDays: days }),

  portfolioTab: "positions",
  setPortfolioTab: (tab) => set({ portfolioTab: tab }),

  portfolioWorld: "paper",
  portfolioWorldUserSet: false,
  setPortfolioWorld: (world) =>
    set({ portfolioWorld: world, portfolioWorldUserSet: true }),

  synthesisTab: "assessment",
  setSynthesisTab: (tab) => set({ synthesisTab: tab }),

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

  dateRange: null,
  setDateRange: (range) => set({ dateRange: range }),
}));

/* ── PHIÊN #105 — nhớ khoảng thời gian toàn cục qua TẢI LẠI TRANG ──
 * sessionStorage (mỗi tab riêng — đóng tab là về mặc định "Toàn bộ").
 * KHÔNG dùng zustand/persist cho cả store: chỉ dateRange cần sống qua reload,
 * phần còn lại là UI state thoáng qua đúng thiết kế TECHNICAL_BLUEPRINT §3.
 * Hydrate SAU mount (hàm do page.tsx gọi trong useEffect) để tránh lệch
 * hydration SSR/CSR — không setState ở module-init. */
const DATE_RANGE_STORAGE_KEY = "the-trader:date-range";

/** Gọi một lần sau mount (useEffect ở page) — đọc khoảng đã lưu vào store. */
export function hydrateDateRangeFromSession(): void {
  if (typeof window === "undefined") return;
  try {
    const saved = window.sessionStorage.getItem(DATE_RANGE_STORAGE_KEY);
    if (!saved) return;
    const parsed = JSON.parse(saved) as { from?: unknown; to?: unknown };
    if (
      typeof parsed?.from === "string" &&
      typeof parsed?.to === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(parsed.from) &&
      /^\d{4}-\d{2}-\d{2}$/.test(parsed.to) &&
      parsed.from <= parsed.to
    ) {
      useUiStore.setState({ dateRange: { from: parsed.from, to: parsed.to } });
    }
  } catch {
    // chuỗi hỏng / storage bị chặn → im lặng dùng mặc định (null)
  }
}

// Ghi mỗi lần đổi (đăng ký một lần ở module — client only, sau hydrate an toàn
// vì subscribe không setState).
if (typeof window !== "undefined") {
  useUiStore.subscribe((s, prev) => {
    if (s.dateRange === prev.dateRange) return;
    try {
      if (s.dateRange != null) {
        window.sessionStorage.setItem(DATE_RANGE_STORAGE_KEY, JSON.stringify(s.dateRange));
      } else {
        window.sessionStorage.removeItem(DATE_RANGE_STORAGE_KEY);
      }
    } catch {
      // storage đầy/bị chặn — bỏ qua, không làm hỏng UI
    }
  });
}
