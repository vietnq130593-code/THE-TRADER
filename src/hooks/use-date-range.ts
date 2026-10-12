"use client";

import { useUiStore } from "@/lib/store";

/**
 * PHIÊN #105 — helper dùng chung cho mọi component tiêu thụ dữ liệu theo
 * KHOẢNG THỜI GIAN TOÀN CỤC (bộ chọn trên thanh bar trên cùng).
 *
 * Trả về:
 * - dateRange: {from,to} ngày ICT "YYYY-MM-DD" | null (null = toàn bộ)
 * - rangeQuery: "from=...&to=..." hoặc "" — nối thẳng vào URL API
 * - rangeKey: chuỗi khoá cho react-query queryKey (đổi khoảng → refetch;
 *   invalidateQueries prefix ["signals"] / ["orders"] / ... vẫn ăn vì
 *   queryKeycon dạng ["signals", rangeKey])
 */
export function useDateRange() {
  const dateRange = useUiStore((s) => s.dateRange);
  return {
    dateRange,
    rangeQuery:
      dateRange != null ? `from=${encodeURIComponent(dateRange.from)}&to=${encodeURIComponent(dateRange.to)}` : "",
    rangeKey: dateRange != null ? `${dateRange.from}~${dateRange.to}` : "all",
  };
}
