"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useUiStore } from "@/lib/store";
import { apiGet, apiPostJson } from "@/lib/api";
import type { KSandboxState, PaperWorldResetResponse, SettingsResponse } from "@/lib/types";

/**
 * PHIÊN #90 — thế giới tiền HIỂN THỊ đồng bộ toàn app (hiệu lệnh trader:
 * "một khi kích hoạt chế độ Thử nghiệm thì tạm coi số tiền chế độ đấy là
 * tiền chính để đầu tư giả định… chế độ thử nghiệm vẫn chưa đồng bộ được
 * hết tới các phần cần thiết").
 *
 * PHIÊN #91 bổ sung luật "VNDIRECT thật" (việc 2 — hiệu lệnh trader: "khi
 * Lưu cấu hình VNDIRECT thật → cơ chế Thử nghiệm tự động dừng, chuyển sang
 * cơ chế Giấy — đổi tên 'Giấy' thành 'Thực tế'"):
 *   - Khi VNDIRECT ĐÃ cấu hình (creds đầy đủ trong Settings) → nhãn thế giới
 *     giấy đổi thành "THỰC TẾ" (paperLabel) và auto-view KHÔNG còn mặc định
 *     sang Thử nghiệm nữa — trader thấy tiền THỰC TẾ là tiền chính.
 *   - Cơ chế Thử nghiệm tự PAUSE phía backend khi lưu cấu hình thật (route
 *     PUT /api/settings — audit K1_SANDBOX_AUTO_PAUSED_FOR_REAL); hook này
 *     chỉ phản ánh trạng thái, không tự dừng (một nguồn quyết định).
 *
 * Một nguồn suy luận duy nhất dùng ở CẢ BA nơi hiển thị tiền:
 *   1. Danh mục đầu tư (portfolio-section) — tiles Tiền mặt/Tổng tài sản;
 *   2. Chip tài khoản trên thanh bar (header) — equity SANDBOX-K1;
 *   3. Chip Sức mua (header) — buying power theo đúng thế giới đang xem.
 *
 * Luật suy luận (thuần dẫn xuất — không setState trong effect):
 *   - Cơ chế thử nghiệm ĐANG BẬT + trader CHƯA từng bấm chọn tay
 *     (portfolioWorldUserSet=false) + VNDIRECT CHƯA cấu hình thật
 *     → tự động xem THỬ NGHIỆM (#90);
 *   - VNDIRECT ĐÃ cấu hình thật → tự động xem THỰC TẾ (Giấy) — tiền chính
 *     quay về thế giới thật (#91 việc 2);
 *   - Trader bấm "Giấy"/"Thử nghiệm" → tôn trọng lựa chọn tường minh đó;
 *   - Thử nghiệm bị tắt/đặt lại khi đang xem → suy về Giấy (paper sống mãi).
 *
 * Query ["k-sandbox"] dùng chung cache với sandbox-card (Settings) — không
 * thêm tải; mọi mutation k-sandbox setQueryData/invalidate nên 3 nơi đổi
 * tiền ngay lập tức. Query ["settings"] dùng chung cache với Settings
 * workspace (staleTime 30s như hooks/use-settings.ts).
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
  /** #91 — VNDIRECT thật đã cấu hình trong Settings (creds đầy đủ). */
  vndirectConfigured: boolean;
  /**
   * #91 — nhãn thế giới giấy: "Thực tế" khi VNDIRECT đã cấu hình thật,
   * "Giấy" khi chưa (đem ra mọi chỗ hiển thị: segmented control Danh mục,
   * chip tài khoản header, tooltip).
   */
  paperLabel: "Thực tế" | "Giấy";
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

  // #91 — dùng chung cache ["settings"] với Settings workspace (không thêm
  // tải; staleTime 30s đồng bộ hooks/use-settings.ts). Fail → undefined →
  // coi như CHƯA cấu hình (an toàn: thế giới giấy vẫn là "Giấy").
  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: () => apiGet<SettingsResponse>("/api/settings"),
    staleTime: 30_000,
  });
  const vndirectConfigured = settings?.vndirect?.configured === true;
  const paperLabel: "Thực tế" | "Giấy" = vndirectConfigured ? "Thực tế" : "Giấy";

  const viewAccountType: "paper" | "sandbox" =
    !userSet && sandboxAvailable && !vndirectConfigured
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
    vndirectConfigured,
    paperLabel,
  };
}

/**
 * #91 việc 1 — "Đặt lại thế giới Giấy về 0": xoá toàn bộ dữ liệu demo cũ
 * (Order/Trade/Position/CashSnapshot mọi tài khoản giấy, cash/equity về 0).
 * Invalidate ["portfolio"] + ["orders"] (prefix — mọi world) để tiles/tables
 * toàn app đổi ngay. Toast summary chi tiết đã xoá cho trader minh bạch.
 */
export function useResetPaperWorld() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => apiPostJson<PaperWorldResetResponse>("/api/portfolio/reset-paper", {}),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ["portfolio"] });
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      const s = res.summary;
      toast.success("Thế giới Giấy đã về 0 trọn vẹn", {
        description:
          `Đã xoá ${s.orders} lệnh · ${s.positions} vị thế · ${s.trades} giao dịch · ` +
          `${s.snapshots} điểm đường cong trên ${s.accounts} tài khoản giấy — ` +
          "tiền mặt/tổng tài sản về 0 ₫. Tài khoản Thử nghiệm & bài học agents không đổi.",
      });
    },
    onError: (err: Error) => {
      toast.error("Không đặt lại được thế giới Giấy", {
        description: err.message,
      });
    },
  });
}
