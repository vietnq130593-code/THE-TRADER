"use client";

import * as React from "react";
import { io } from "socket.io-client";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useUiStore } from "@/lib/store";
import type { QuotesResponse, WatchlistResponse } from "@/lib/types";

/**
 * Realtime market feed qua WebSocket mini-service market-engine (port 3003).
 * Kết nối QUA GATEWAY theo chuẩn sandbox: io("/?XTransformPort=3003") —
 * query XTransformPort được gắn vào mọi request engine.io (polling + ws).
 *
 * - "quotes": ghi thẳng vào cache TanStack Query (["quotes"], ["watchlist"])
 *   → mọi section dùng bảng giá cập nhật tức thì, không cần refetch.
 * - "news": invalidate ["news"] sau mỗi lần crawler RSS chạy.
 * - "eod": invalidate dữ liệu giá/bar sau mỗi lần đồng bộ EOD THẬT VNDIRECT
 *   (market-engine 15:45 ICT hằng ngày) — nến/chart/chỉ báo đổi sang giá thật.
 * - "cycle": invalidate dữ liệu agent khi scheduler chạy chu kỳ tự động.
 * - "ml-sweep": invalidate ["ml-sweep"] + ["ml-status"] sau mỗi đợt sweep
 *   AutoML L1 (C1 #99 — engine CN 04:15 ICT; champion board + serving snapshot
 *   đổi ngay khi có SWAP).
 *
 * AUDIT 137 D4 — engine phát 14 loại sự kiện WS nhưng client chỉ nghe 5 →
 * 9 sự kiện rơi vào khoảng không (settle · ml-train · k1-settle · council-eval
 * · macro-vn · flow-sync · intl · reprobe · welcome): tab mở lâu bị stale ở
 * module không có polling (k1-settle 16:30 → tiles portfolio, council-eval
 * 16:45 → sổ đánh giá, ml-train CN 04:00 → tab Tinh chỉnh). Bổ sung 8 handler
 * (welcome là handshake kết nối — không cần invalidate). QUY TẮC: chỉ
 * invalidate queryKey TỒN TẠI trong codebase (grep src/hooks + src/components
 * /dashboard trước khi thêm — macro-vn không có key riêng nên chỉ đụng
 * ["system-status"] nơi footer hiển thị markSource macro-vn).
 */
export function useRealtimeMarket(): void {
  const queryClient = useQueryClient();
  const setRealtimeConnected = useUiStore((s) => s.setRealtimeConnected);
  const setLastTickAt = useUiStore((s) => s.setLastTickAt);

  React.useEffect(() => {
    let socket: ReturnType<typeof io> | null = null;
    try {
      socket = io("/?XTransformPort=3003", {
        transports: ["polling", "websocket"],
        reconnection: true,
        reconnectionDelay: 3_000,
        reconnectionDelayMax: 15_000,
        timeout: 8_000,
      });
    } catch {
      return;
    }
    const s = socket;

    const onConnect = () => setRealtimeConnected(true);
    const onDisconnect = () => setRealtimeConnected(false);

    const onQuotes = (payload: QuotesResponse) => {
      if (!payload || !Array.isArray(payload.quotes)) return;
      // Defer sang macrotask để không đụng render đang chạy (concurrent React)
      setTimeout(() => {
        queryClient.setQueryData(["quotes"], payload);
        // Patch cache watchlist từ payload mới (nếu đang ở chế độ theo dõi)
        const wl = queryClient.getQueryData<WatchlistResponse>(["watchlist"]);
        if (wl?.watchlist?.quotes?.length) {
          const bySymbol = new Map(payload.quotes.map((q) => [q.symbol, q]));
          queryClient.setQueryData(["watchlist"], {
            ...wl,
            watchlist: {
              ...wl.watchlist,
              quotes: wl.watchlist.quotes.map((q) => bySymbol.get(q.symbol) ?? q),
            },
          });
        }
        setLastTickAt(Date.now());
      }, 0);
    };

    const onNews = () => {
      setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ["news"] });
        void queryClient.invalidateQueries({ queryKey: ["system-status"] });
      }, 0);
    };

    const onEod = () => {
      setTimeout(() => {
        for (const key of ["quotes", "watchlist", "bars", "portfolio", "system-status"]) {
          void queryClient.invalidateQueries({ queryKey: [key] });
        }
      }, 0);
    };

    const onCycle = () => {
      setTimeout(() => {
        for (const key of ["agents", "agent-messages", "signals", "orders", "portfolio", "risk-alerts"]) {
          void queryClient.invalidateQueries({ queryKey: [key] });
        }
        toast.info("Chu kỳ agent tự động hoàn tất", {
          description: "Scheduler đã chạy chu kỳ phân tích — dữ liệu đã được làm mới.",
        });
      }, 0);
    };

    // C1 (#99 — ML_AUTOML_BLUEPRINT §4.6/F3): đợt sweep AutoML L1 xong (engine
    // CN 04:15 ICT hoặc nút tay) — làm mới champion board + serving snapshot.
    const onMlSweep = () => {
      setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ["ml-sweep"] });
        void queryClient.invalidateQueries({ queryKey: ["ml-status"] });
      }, 0);
    };

    // ── AUDIT 137 D4 — 8 sự kiện WS trước đó rơi vào khoảng không ──────────
    // invalidate theo từng job engine (key chỉ định TỒN TẠI trong codebase):
    //  - settle (16:15 ICT): kết toán bandit — portfolio/orders/signals gần
    //    thời điểm chốt + system-status (markSource);
    //  - ml-train (CN 04:00): serving mới → ml-status + ml-tuning (tab Tinh
    //    chỉnh hiển thị arch/hyper của champion — ml-architecture tự lành
    //    nhờ refetchInterval 120s sẵn có);
    //  - k1-settle (16:30): kết toán sandbox K1 → k-sandbox + portfolio/orders
    //    (tiles Header/Danh mục thế giới sandbox staleTime 60s không interval);
    //  - council-eval (16:45 T2-T6): sổ đánh giá quyết định D-LEDGER →
    //    council-overview + assessment (Tổng hợp);
    //  - macro-vn (06:35): KHÔNG có query key macro riêng (macro-series không
    //    tồn tại — dữ liệu đi vào prompt agent, không có UI query) → chỉ
    //    system-status nơi footer hiển thị nguồn macro-vn;
    //  - flow-sync (16:05): snapshot khối ngoại → flows (MarketPulseBar);
    //  - intl (06:15): bar EOD quốc tế PHI-VN → bars (biểu đồ) + quotes
    //    (bảng tham chiếu quốc tế) + system-status;
    //  - reprobe (CN 04:00): instrument mới + backfill bar → quotes/bars/status.
    const invalidateKeys = (keys: string[]) => {
      for (const key of keys) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    };
    const onSettle = () => {
      setTimeout(() => invalidateKeys(["portfolio", "orders", "signals", "system-status"]), 0);
    };
    const onMlTrain = () => {
      setTimeout(() => invalidateKeys(["ml-status", "ml-tuning"]), 0);
    };
    const onK1Settle = () => {
      setTimeout(() => invalidateKeys(["k-sandbox", "portfolio", "orders"]), 0);
    };
    const onCouncilEval = () => {
      setTimeout(() => invalidateKeys(["council-overview", "assessment"]), 0);
    };
    const onMacroVn = () => {
      setTimeout(() => invalidateKeys(["system-status"]), 0);
    };
    const onFlowSync = () => {
      setTimeout(() => invalidateKeys(["flows"]), 0);
    };
    const onIntl = () => {
      setTimeout(() => invalidateKeys(["bars", "quotes", "system-status"]), 0);
    };
    const onReprobe = () => {
      setTimeout(() => invalidateKeys(["quotes", "bars", "system-status"]), 0);
    };

    s.on("connect", onConnect);
    s.on("disconnect", onDisconnect);
    s.on("quotes", onQuotes);
    s.on("news", onNews);
    s.on("eod", onEod);
    s.on("cycle", onCycle);
    s.on("ml-sweep", onMlSweep);
    // AUDIT 137 D4 — đăng ký đối xứng 8 handler mới (on/off cùng tên)
    s.on("settle", onSettle);
    s.on("ml-train", onMlTrain);
    s.on("k1-settle", onK1Settle);
    s.on("council-eval", onCouncilEval);
    s.on("macro-vn", onMacroVn);
    s.on("flow-sync", onFlowSync);
    s.on("intl", onIntl);
    s.on("reprobe", onReprobe);

    return () => {
      s.off("connect", onConnect);
      s.off("disconnect", onDisconnect);
      s.off("quotes", onQuotes);
      s.off("news", onNews);
      s.off("eod", onEod);
      s.off("cycle", onCycle);
      s.off("ml-sweep", onMlSweep);
      s.off("settle", onSettle);
      s.off("ml-train", onMlTrain);
      s.off("k1-settle", onK1Settle);
      s.off("council-eval", onCouncilEval);
      s.off("macro-vn", onMacroVn);
      s.off("flow-sync", onFlowSync);
      s.off("intl", onIntl);
      s.off("reprobe", onReprobe);
      s.disconnect();
    };
  }, [queryClient, setRealtimeConnected, setLastTickAt]);
}
