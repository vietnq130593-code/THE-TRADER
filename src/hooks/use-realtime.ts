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

    s.on("connect", onConnect);
    s.on("disconnect", onDisconnect);
    s.on("quotes", onQuotes);
    s.on("news", onNews);
    s.on("eod", onEod);
    s.on("cycle", onCycle);
    s.on("ml-sweep", onMlSweep);

    return () => {
      s.off("connect", onConnect);
      s.off("disconnect", onDisconnect);
      s.off("quotes", onQuotes);
      s.off("news", onNews);
      s.off("eod", onEod);
      s.off("cycle", onCycle);
      s.off("ml-sweep", onMlSweep);
      s.disconnect();
    };
  }, [queryClient, setRealtimeConnected, setLastTickAt]);
}
