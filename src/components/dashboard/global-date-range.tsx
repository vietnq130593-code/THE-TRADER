"use client";

import * as React from "react";
import { CalendarRange, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { NewsRangeCalendar, type NewsDayRange } from "@/components/dashboard/news-range-calendar";
import { useUiStore } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * PHIÊN #105 — bộ chọn KHOẢNG THỜI GIAN TOÀN CỤC trên thanh bar trên cùng.
 *
 * Yêu cầu trader: "thanh bar trên cùng tạo một nút chọn từ ngày đến ngày để
 * nội dung trong app hiển thị được theo thời gian đã chọn".
 *
 * - MỘT nút outline (icon CalendarRange + nhãn khoảng) → mở popover chứa
 *   LỊCH ĐÔI 2 tháng (tái dùng NewsRangeCalendar #102 — nâng cấp value null).
 * - Chọn khoảng bằng ĐÚNG 2 CLICK (click nào trước cũng được), click đôi 1
 *   ngày = chỉ xem ngày đó — cùng ngữ cảm với kho tin tức #102.
 * - Preset nhanh: 7/30/90 ngày · 1 năm · 3 năm (kết thúc hôm nay ICT).
 * - "Toàn bộ thời gian" = xoá khoảng (dateRange → null) — hành vi mặc định.
 * - Chọn xong tự ĐÓNG popover (không cần nút Áp dụng).
 * - Ranh giới ngày theo ICT (UTC+7) — cùng quy ước kho tin #101/#102;
 *   maxDay = hôm nay ICT (không cho chọn tương lai).
 */

const DAY_MS = 86_400_000;

/** "YYYY-MM-DD" theo ICT của thời điểm hiện tại. */
function ictToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** today − (n−1) ngày → "YYYY-MM-DD" (toán chuỗi UTC, không lệch múi giờ). */
function daysAgoIso(today: string, n: number): string {
  const d = new Date(Date.parse(`${today}T00:00:00Z`) - (n - 1) * DAY_MS);
  return d.toISOString().slice(0, 10);
}

/** "2026-10-06" → "06/10/2026" (có năm) hoặc "06/10" (không năm). */
function fmtVi(iso: string, withYear: boolean): string {
  const [y, m, d] = iso.split("-");
  return withYear ? `${d}/${m}/${y}` : `${d}/${m}`;
}

export function GlobalDateRange() {
  const dateRange = useUiStore((s) => s.dateRange);
  const setDateRange = useUiStore((s) => s.setDateRange);
  const [open, setOpen] = React.useState(false);
  const today = React.useMemo(() => ictToday(), []);

  const presets = React.useMemo(
    () =>
      [
        { label: "7 ngày", range: { from: daysAgoIso(today, 7), to: today } },
        { label: "30 ngày", range: { from: daysAgoIso(today, 30), to: today } },
        { label: "90 ngày", range: { from: daysAgoIso(today, 90), to: today } },
        { label: "1 năm", range: { from: daysAgoIso(today, 365), to: today } },
        { label: "3 năm", range: { from: daysAgoIso(today, 365 * 3), to: today } },
      ] satisfies { label: string; range: NewsDayRange }[],
    [today],
  );

  const handleSelect = (range: NewsDayRange) => {
    setDateRange(range);
    setOpen(false); // chọn xong tự đóng — không cần nút Áp dụng (cùng gu #102)
  };

  const single = dateRange != null && dateRange.from === dateRange.to;
  const label =
    dateRange == null
      ? "Toàn bộ thời gian"
      : single
        ? `Ngày ${fmtVi(dateRange.from, true)}`
        : `${fmtVi(dateRange.from, false)} → ${fmtVi(dateRange.to, true)}`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={`Khoảng thời gian đang xem: ${label} — bấm để chọn từ ngày đến ngày`}
          className={cn(
            "h-9 gap-2 whitespace-nowrap px-3 font-normal",
            dateRange != null && "border-primary/40 bg-primary/5 text-foreground",
          )}
        >
          <CalendarRange className="size-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="tabular-nums text-xs sm:text-[13px]">{label}</span>
          {dateRange != null && (
            <span
              role="button"
              tabIndex={0}
              aria-label="Xoá khoảng thời gian — xem toàn bộ"
              onClick={(e) => {
                e.stopPropagation();
                setDateRange(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  setDateRange(null);
                }
              }}
              className="-mr-1 ml-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <X className="size-3.5" aria-hidden="true" />
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(calc(100vw-2rem),42rem)] p-3"
      >
        <p className="mb-2 px-1 text-xs font-medium text-foreground">
          Xem dữ liệu trong khoảng
          <span className="ml-1 font-normal text-muted-foreground">
            — áp dụng cho tín hiệu · lệnh · thảo luận · tin tức · biểu đồ
          </span>
        </p>
        {/* key-remount theo khoảng để view lịch luôn mở đúng tháng ngày bắt đầu */}
        <NewsRangeCalendar
          key={dateRange?.from ?? "none"}
          value={dateRange}
          minDay={null}
          maxDay={today}
          onSelect={handleSelect}
          presets={presets}
        />
        <div className="mt-2 flex items-center justify-between gap-2 border-t border-border/60 px-1 pt-2">
          <p className="text-[11px] leading-snug text-muted-foreground">
            Ranh giới ngày theo giờ Việt Nam (ICT).
          </p>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2.5 text-[11px]"
            onClick={() => {
              setDateRange(null);
              setOpen(false);
            }}
          >
            Toàn bộ thời gian
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
