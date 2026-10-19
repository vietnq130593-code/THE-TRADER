// (Task 144 P2-c) — tách từ synthesis-workspace.tsx (pure move)
// Kiểu dữ liệu dùng chung các section của workspace Tổng hợp.

/** 1 dòng lịch sử cho chart + list. */
export interface HistoryRow {
  createdAt: string;
  pUp: number;
  pDown: number;
  pFlat: number;
  marketDirection: string;
}
