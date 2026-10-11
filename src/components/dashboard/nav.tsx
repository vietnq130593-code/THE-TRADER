"use client";

import * as React from "react";
import {
  Bot,
  Brain,
  Briefcase,
  ChartCandlestick,
  LayoutDashboard,
  Radar,
  Settings,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUiStore, type Workspace } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * PHASE3_BLUEPRINT §3.2 + phiên #34 → phiên #45 → PHIÊN #46 (tinh chỉnh user):
 * thanh tab workspace ngang trên header được thay bằng SIDEBAR TRÁI overlay.
 *
 * PHIÊN #46:
 * - Sidebar + backdrop neo từ mép DƯỚI thanh header (top-[var(--header-h)])
 *   — KHÔNG che thanh bar trên cùng nữa; header (chứa logo) luôn nhìn thấy
 *   và bấm được khi sidebar mở. Biến --header-h do Header đo & công bố
 *   (ResizeObserver, co giãn theo flex-wrap mobile).
 * - Logo "The Trader" trên header là nút bật/tắt DUY NHẤT — không còn nút
 *   icon nhỏ cạnh logo: nhấp logo mở, nhấp lại đúng logo để đóng.
 * - Sidebar không lặp lại logo trong đầu panel (logo thật đã ở header) —
 * chỉ còn nhãn "Module" + nút X đóng nhanh.
 *
 * - Chọn một module → chuyển workspace (Zustand) + tự đóng sidebar.
 * - Đóng bằng: nhấp lại logo trên header · nút X · Esc · nhấp vùng tối.
 * - Giữ id nút `workspace-tab-<id>` để `aria-labelledby` của các workspace
 *   panel (role="tabpanel") vẫn trỏ đúng phần tử — không đổi href/route,
 *   vẫn bất biến single-route `/` + deep-link ?ws=.
 *
 * A11y: vai trò tab dọc (WAI-ARIA tabs) — mũi tên Lên/Xuống chuyển module,
 * Home/End nhảy đầu/cuối; sidebar dùng `inert` khi đóng để không nuốt focus
 * bàn phím; body khoá cuộn khi mở (mobile).
 */

const WORKSPACE_ITEMS: {
  id: Workspace;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  {
    id: "overview",
    label: "Tổng quan",
    description: "Tin nhanh thị trường · nhận định · tín hiệu",
    icon: LayoutDashboard,
  },
  {
    id: "market",
    label: "Thị trường",
    description: "Bảng giá đa sàn · biểu đồ giá · dòng tiền",
    icon: ChartCandlestick,
  },
  {
    id: "portfolio",
    label: "Danh mục",
    description: "Vị thế · lệnh · khớp lệnh · sức mua",
    icon: Briefcase,
  },
  {
    id: "signals",
    label: "Tín hiệu",
    description: "Tín hiệu MUA/BÁN · rủi ro · vận hành",
    icon: Radar,
  },
  {
    id: "agents",
    label: "Đội Agent",
    description: "23 agents · 5 nhóm · bảng điểm · độ phủ",
    icon: Bot,
  },
  {
    id: "synthesis",
    label: "Tổng hợp",
    description: "7 tab: Bayes · học máy · mạng thần kinh · tinh chỉnh",
    icon: Brain,
  },
  {
    id: "settings",
    label: "Cài đặt",
    description: "Nguồn dữ liệu VNDIRECT · chế độ giao dịch",
    icon: Settings,
  },
];

export function AppSidebar() {
  const active = useUiStore((s) => s.activeWorkspace);
  const setActive = useUiStore((s) => s.setActiveWorkspace);
  const open = useUiStore((s) => s.sidebarOpen);
  const setOpen = useUiStore((s) => s.setSidebarOpen);
  const realtimeConnected = useUiStore((s) => s.realtimeConnected);

  // Esc để đóng + khoá cuộn body khi mở (tránh cuộn lạc phía sau overlay).
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, setOpen]);

  /** Mũi tên Lên/Xuống/Home/End — điều hướng tab dọc (chuẩn WAI-ARIA tabs). */
  const onItemKeyDown = (e: React.KeyboardEvent, id: Workspace) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") {
      return;
    }
    e.preventDefault();
    const idx = WORKSPACE_ITEMS.findIndex((t) => t.id === id);
    let next = idx;
    if (e.key === "ArrowDown") next = (idx + 1) % WORKSPACE_ITEMS.length;
    else if (e.key === "ArrowUp") next = (idx - 1 + WORKSPACE_ITEMS.length) % WORKSPACE_ITEMS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = WORKSPACE_ITEMS.length - 1;
    setActive(WORKSPACE_ITEMS[next].id);
    document.getElementById(`workspace-tab-${WORKSPACE_ITEMS[next].id}`)?.focus();
  };

  return (
    <>
      {/* Backdrop — nhấp để đóng; chỉ phủ VÙNG DƯỚI header (phiên #46):
       * thanh bar trên cùng (chứa logo bật/tắt) không bị che, luôn bấm được */}
      <div
        aria-hidden="true"
        onClick={() => setOpen(false)}
        className={cn(
          "fixed bottom-0 left-0 right-0 top-[var(--header-h,4.25rem)] z-40 bg-black/50 backdrop-blur-[2px] transition-opacity duration-300",
          open ? "opacity-100" : "pointer-events-none opacity-0"
        )}
      />

      <aside
        id="app-sidebar"
        aria-label="Thanh điều hướng module"
        inert={!open}
        className={cn(
          "fixed bottom-0 left-0 top-[var(--header-h,4.25rem)] z-50 flex w-72 max-w-[85vw] flex-col rounded-tr-xl border-r border-t border-border/60 bg-background shadow-xl transition-transform duration-300 ease-out",
          open ? "translate-x-0" : "-translate-x-full"
        )}
      >
        {/* Đầu sidebar — nhãn + đóng nhanh (logo thật nằm trên header, luôn thấy) */}
        <div className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Module
          </p>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Đóng thanh điều hướng"
            onClick={() => setOpen(false)}
            className="size-8 shrink-0"
          >
            <X className="size-4" />
          </Button>
        </div>

        {/* Danh sách module */}
        <nav
          aria-label="Vùng làm việc"
          role="tablist"
          aria-orientation="vertical"
          className="custom-scrollbar flex-1 space-y-1 overflow-y-auto px-3 py-3"
        >
          {WORKSPACE_ITEMS.map((item) => {
            const selected = active === item.id;
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                id={`workspace-tab-${item.id}`}
                aria-selected={selected}
                aria-controls={`workspace-panel-${item.id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => {
                  setActive(item.id);
                  setOpen(false); // chọn module xong tự đóng sidebar
                }}
                onKeyDown={(e) => onItemKeyDown(e, item.id)}
                className={cn(
                  "flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40",
                  selected
                    ? "border-primary/30 bg-accent text-accent-foreground"
                    : "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                )}
              >
                <Icon
                  className={cn(
                    "mt-0.5 size-4 shrink-0",
                    selected ? "text-foreground" : "text-muted-foreground"
                  )}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {item.label}
                    {selected && <span className="sr-only">(đang mở)</span>}
                    {/* Chấm realtime khi workspace Đội Agent & engine đang nối */}
                    {item.id === "agents" && realtimeConnected && (
                      <span
                        className="relative flex size-2 shrink-0"
                        title="market-engine đang phát realtime"
                      >
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-up opacity-60" />
                        <span className="relative inline-flex size-2 rounded-full bg-up" />
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground/80">
                    {item.description}
                  </span>
                </span>
              </button>
            );
          })}
        </nav>

        {/* Chân sidebar — chú thích màu chuẩn tài chính (phiên #45) */}
        <div className="space-y-2 border-t border-border/60 px-4 py-3 text-[11px] text-muted-foreground">
          <p className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <span className="size-2 rounded-sm bg-up" aria-hidden="true" /> tăng
            </span>
            <span className="flex items-center gap-1">
              <span className="size-2 rounded-sm bg-down" aria-hidden="true" /> giảm
            </span>
            <span className="flex items-center gap-1">
              <span className="size-2 rounded-sm bg-flat" aria-hidden="true" /> đứng giá
            </span>
          </p>
          <p>7 module · nhấp logo “The Trader” trên cùng để mở/đóng</p>
        </div>
      </aside>
    </>
  );
}
