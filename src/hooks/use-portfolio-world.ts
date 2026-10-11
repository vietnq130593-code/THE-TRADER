"use client";

import { useQuery } from "@tanstack/react-query";
import { useUiStore } from "@/lib/store";
import { apiGet } from "@/lib/api";
import type { KSandboxState } from "@/lib/types";

/**
 * PHIÊN #90 — thế giới tiền HIỂN THỊ đồng bộ toàn app (hiệu lệnh trader:
 * "một khi kích hoạt chế độ Thử nghiệm thì tạm coi số tiền chế độ đấy là
 * tiền chính để đầu tư giả định… chế độ thử nghiệm vẫn chưa đồng bộ được
 * hết tới các phần cần thiết").
 *
 * Một nguồn suy luận duy nhất dùng ở CẢ BA nơi hiển thị tiền:
 *   1. Danh mục đầu tư (portfolio-section) — tiles Tiền mặt/Tổng tài sản;
 *   2. Chip tài khoản trên thanh bar (header) — equity SANDBOX-K1;
 *   3. Chip Sức mua (header) — buying power theo đúng thế giới đang xem.
 *
 * Luật suy luận (thuần dẫn xuất — không setState trong effect):
 *   - Cơ chế thử nghiệm ĐANG BẬT + trader CHƯA từng bấm chọn tay
 *     (portfolioWorldUserSet=false) → tự động xem THỬ NGHIỆM;
 *   - Trader bấm "Giấy"/"Thử nghiệm" → tôn trọng lựa chọn tường minh đó;
 *   - Thử nghiệm bị tắt/đặt lại khi đang xem → suy về Giấy (paper sống mãi).
 *
 * Query ["k-sandbox"] dùng chung cache với sandbox-card (Settings) — không
 * thêm tải; mọi mutation k-sandbox setQueryData/invalidate nên 3 nơi đổi
 * tiền ngay lập tức.
 */

export interface PortfolioWorld {
  /** Thế giới đang xem — quyết định endpoint & mọi phép tính tiền hiển thị. */
  viewAccountType: "paper" | "sandbox";
  /** Cơ chế thử nghiệm có đang bật không. */
  sandboxAvailable: boolean;
  /** State k-sandbox đầy đủ (paused… — dùng chung cache, không tải thêm). */
  sandboxState: KSandboxState | undefined;
  /** Chọn tay (segmented control Giấy/Thử nghiệm). */
  setWorld: (world: "paper" | "sandbox") => void;
  /** Endpoint /api/portfolio đúng thế giới (query key ["portfolio", world]). */
  portfolioUrl: string;
}

export function usePortfolioWorld(): PortfolioWorld {
  const accountType = useUiStore((s) => s.portfolioWorld);
  const userSet = useUiStore((s) => s.portfolioWorldUserSet);
  const setWorld = useUiStore((s) => s.setPortfolioWorld);

  const { data: kSandbox } = useQuery({
    queryKey: ["k-sandbox"],
    queryFn: () => apiGet<KSandboxState>("/api/k/sandbox"),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
  const sandboxAvailable = kSandbox?.enabled === true;

  const viewAccountType: "paper" | "sandbox" =
    !userSet && sandboxAvailable
      ? "sandbox"
      : accountType === "sandbox" && !sandboxAvailable
        ? "paper"
        : accountType;

  return {
    viewAccountType,
    sandboxAvailable,
    sandboxState: kSandbox,
    setWorld,
    portfolioUrl:
      viewAccountType === "sandbox" ? "/api/portfolio?accountType=sandbox" : "/api/portfolio",
  };
}
