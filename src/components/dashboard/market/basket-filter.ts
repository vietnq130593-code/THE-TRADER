/**
 * src/components/dashboard/market/basket-filter.ts — #110 M4.5.2
 * Mapping rổ thị trường (GET /api/council/baskets · BasketStatView.key) →
 * nhóm `market` trong bảng giá (QuoteRow.market — #106 B13: HOSE · HNX ·
 * UPCOM · US · HK · BOND · FOREX · COMMODITY).
 *
 * UIUX_UPGRADE_BLUEPRINT hiệu chỉnh v1.2 (#108 — chính sách VN-only):
 * vũ trụ ĐẦU TƯ chỉ CP/ETF Việt Nam; các rổ phi-VN (INTL/BOND/FOREX/
 * COMMODITY) là chỉ số THAM CHIẾU cho nghiên cứu — lọc bảng giá theo rổ
 * là tra cứu tham chiếu, không phải kênh đầu tư.
 */

/** Rổ → nhóm market trong bảng giá (nhóm "Chỉ số" luôn giữ nguyên).
 * F-1113-04 (fixbug #111): bỏ export — chỉ marketsOfBasket dùng nội bộ. */
const BASKET_MARKETS: Record<string, readonly string[]> = {
  VN_EQUITY: ["HOSE", "HNX", "UPCOM"],
  INTL_EQUITY: ["US", "HK"],
  BOND: ["BOND"],
  FOREX: ["FOREX"],
  COMMODITY: ["COMMODITY"],
};

/** Nhãn ngắn tiếng Việt của rổ (dùng chip "Đang lọc: …" + hàng card Đa rổ). */
export const BASKET_LABELS: Record<string, string> = {
  VN_EQUITY: "CP Việt Nam",
  INTL_EQUITY: "CP quốc tế",
  BOND: "Trái phiếu",
  FOREX: "Forex USD/VND",
  COMMODITY: "Hàng hoá",
};

/** Danh sách market tương ứng rổ — trả [] nếu key lạ (bảng về "không khớp"). */
export function marketsOfBasket(basket: string | null | undefined): readonly string[] {
  if (!basket) return [];
  return BASKET_MARKETS[basket] ?? [];
}

/** Nhãn rổ — fallback key gốc khi thiếu (trung thực dữ liệu). */
export function basketLabel(basket: string | null | undefined): string {
  if (!basket) return "";
  return BASKET_LABELS[basket] ?? basket;
}
