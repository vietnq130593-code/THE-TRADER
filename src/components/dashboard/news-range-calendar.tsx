"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Lịch đôi chọn khoảng ngày (#102) — 2 bảng tháng cạnh nhau, chọn bằng
 * ĐÚNG 2 CLICK: click 1 neo ngày bắt đầu, click 2 đóng khoảng (bấm ngày
 * cũ hơn trước cũng tự sắp đúng thứ tự). Click đôi vào MỘT ngày
 * (2 click trùng nhau) → from == to → chỉ xem đúng ngày đó.
 *
 * Toán ngày thuần chuỗi "YYYY-MM-DD" + Date.UTC → không lệch múi giờ
 * client; ranh giới chọn theo ngày ICT do caller truyền (bounds kho tin).
 */

/** Ngày dạng "YYYY-MM-DD" — so sánh chuỗi = so sánh thời gian. */
export interface NewsDayRange {
  from: string;
  to: string;
}

interface Preset {
  label: string;
  range: NewsDayRange;
}

interface Props {
  /** Khoảng đang áp dụng — đóng khung highlight + tháng mở khởi đầu.
   * PHIÊN #105: null = chưa chọn khoảng nào (toàn bộ thời gian) — lịch mở
   * tại tháng hiện tại, không highlight ngày nào (dùng cho bộ chọn toàn cục). */
  value: NewsDayRange | null;
  /** Ngày nhỏ nhất cho phép (bounds kho tin) — null → không giới hạn dưới. */
  minDay?: string | null;
  /** Ngày lớn nhất cho phép — caller cap ở hôm nay ICT. */
  maxDay?: string | null;
  /** Bắn khi đủ 2 click (click đôi 1 ngày → from == to). */
  onSelect: (range: NewsDayRange) => void;
  /** Chip khoảng nhanh đặt ở chân lịch. */
  presets?: Preset[];
}

const WEEKDAYS = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"];
const MONTH_LABEL = [
  "Tháng 1", "Tháng 2", "Tháng 3", "Tháng 4", "Tháng 5", "Tháng 6",
  "Tháng 7", "Tháng 8", "Tháng 9", "Tháng 10", "Tháng 11", "Tháng 12",
];

/* ── Toán ngày thuần UTC/ chuỗi (không đụng múi giờ client) ── */

const pad2 = (n: number) => String(n).padStart(2, "0");
const isoOf = (y: number, m: number, d: number) => `${y}-${pad2(m + 1)}-${pad2(d)}`;

function monthOf(day: string): { y: number; m: number } {
  return { y: Number(day.slice(0, 4)), m: Number(day.slice(5, 7)) - 1 };
}

function addMonth(v: { y: number; m: number }, delta: number): { y: number; m: number } {
  const total = v.y * 12 + v.m + delta;
  return { y: Math.floor(total / 12), m: ((total % 12) + 12) % 12 };
}

function monthKey(v: { y: number; m: number }): number {
  return v.y * 12 + v.m;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

/** Ô lưới 1 tháng: null = ô trống đầu/cuối cho thẳng hàng tuần. */
function buildCells(y: number, m: number): (string | null)[] {
  const lead = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7; // tuần bắt đầu T2
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= daysInMonth(y, m); d++) cells.push(isoOf(y, m, d));
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

/** "2026-10-06" → "06/10/2026" (withYear) hoặc "06/10". */
function fmtVi(iso: string, withYear = true): string {
  const [y, m, d] = iso.split("-");
  return withYear ? `${d}/${m}/${y}` : `${d}/${m}`;
}

function dayCount(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86_400_000) + 1 : 0;
}

/** "YYYY-MM-DD" theo ICT — chấm dấu ngày hiện tại. */
function ictToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function NewsRangeCalendar({ value, minDay, maxDay, onSelect, presets }: Props) {
  const lo = minDay ?? "";
  const hi = maxDay ?? "9999-12-31";
  const today = React.useMemo(() => ictToday(), []);
  // Mở lịch tại tháng của ngày BẮT ĐẦU đang áp dụng (mount 1 lần — dialog
  // key-remount mỗi lần áp dụng khoảng mới nên view luôn về đúng chỗ).
  // #105: chưa chọn khoảng → mở tại tháng hiện tại ICT.
  const [view, setView] = React.useState(() => monthOf(value?.from ?? today));
  const [anchor, setAnchor] = React.useState<string | null>(null);

  const right = addMonth(view, 1);
  const prevDisabled = monthKey(view) <= monthKey(monthOf(lo || "1990-01"));
  const nextDisabled = monthKey(right) >= monthKey(monthOf(hi));

  const handleClick = (day: string) => {
    if (anchor === null) {
      setAnchor(day);
      return;
    }
    // Click 2 — đóng khoảng (hai click trùng 1 ngày → from == to).
    const from = anchor < day ? anchor : day;
    const to = anchor > day ? anchor : day;
    setAnchor(null);
    onSelect({ from, to });
  };

  const single = value != null && value.from === value.to;

  return (
    <div
      role="group"
      aria-label="Chọn khoảng ngày xem tin — bấm 2 ngày, hoặc bấm đôi 1 ngày"
      className="flex flex-col gap-2 rounded-lg border border-border/60 bg-background p-3"
    >
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Bấm một ngày bắt đầu rồi một ngày kết thúc (bấm ngày nào trước cũng
        được) — bấm <strong>đôi</strong> vào một ngày để chỉ xem đúng ngày đó.
      </p>

      <div className="flex flex-col gap-4 sm:flex-row sm:justify-center">
        <MonthPanel
          view={view}
          value={value}
          anchor={anchor}
          lo={lo}
          hi={hi}
          today={today}
          single={single}
          onDay={handleClick}
          onDayDouble={(day) => onSelect({ from: day, to: day })}
          nav={
            prevDisabled ? null : (
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={() => setView(addMonth(view, -1))}
                aria-label="Xem tháng trước"
              >
                <ChevronLeft className="size-4" aria-hidden="true" />
              </Button>
            )
          }
        />
        <MonthPanel
          view={right}
          value={value}
          anchor={anchor}
          lo={lo}
          hi={hi}
          today={today}
          single={single}
          onDay={handleClick}
          onDayDouble={(day) => onSelect({ from: day, to: day })}
          nav={
            nextDisabled ? null : (
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={() => setView(addMonth(view, 1))}
                aria-label="Xem tháng sau"
              >
                <ChevronRight className="size-4" aria-hidden="true" />
              </Button>
            )
          }
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2">
        <p className="text-[11px] text-muted-foreground" aria-live="polite">
          {anchor ? (
            <>
              Đang chọn bắt đầu:{" "}
              <span className="font-medium text-foreground">{fmtVi(anchor)}</span>{" "}
              — bấm ngày kết thúc (hoặc bấm lại chính nó để chỉ xem ngày này)
            </>
          ) : value == null ? (
            <>Chưa giới hạn — đang xem toàn bộ thời gian</>
          ) : single ? (
            <>
              Đang xem: <span className="font-medium text-foreground">ngày {fmtVi(value.from)}</span>
            </>
          ) : (
            <>
              Đang xem:{" "}
              <span className="font-medium text-foreground">
                {fmtVi(value.from, false)} → {fmtVi(value.to)}
              </span>{" "}
              · {dayCount(value.from, value.to).toLocaleString("vi-VN")} ngày
            </>
          )}
        </p>
        {presets && presets.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {presets.map((p) => (
              <Button
                key={p.label}
                size="sm"
                variant="outline"
                className="h-7 px-2.5 text-[11px]"
                onClick={() => onSelect(p.range)}
              >
                {p.label}
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Một bảng tháng ── */

interface MonthPanelProps {
  view: { y: number; m: number };
  value: NewsDayRange | null;
  anchor: string | null;
  lo: string;
  hi: string;
  today: string;
  single: boolean;
  onDay: (day: string) => void;
  /** Click đôi 1 ngày → chọn chỉ xem ngày đó (từ MonthPanel cha truyền xuống). */
  onDayDouble: (day: string) => void;
  nav: React.ReactNode;
}

function MonthPanel({ view, value, anchor, lo, hi, today, single, onDay, onDayDouble, nav }: MonthPanelProps) {
  const cells = buildCells(view.y, view.m);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-1">
        {/* Ô giữ chỗ đối xứng khi panel không có nút điều hướng */}
        <span className="w-7" aria-hidden="true" />
        <p className="text-xs font-medium text-foreground">
          {MONTH_LABEL[view.m]} <span className="text-muted-foreground">{view.y}</span>
        </p>
        {nav ?? <span className="w-7" aria-hidden="true" />}
      </div>
      <div className="grid grid-cols-7 gap-0.5 text-center">
        {WEEKDAYS.map((w) => (
          <span
            key={w}
            className={cn(
              "pb-1 text-[10px] font-medium",
              w === "CN" ? "text-muted-foreground/70" : "text-muted-foreground"
            )}
          >
            {w}
          </span>
        ))}
        {cells.map((day, i) => {
          if (day === null) return <span key={`e${i}`} className="size-9" aria-hidden="true" />;
          const disabled = day < lo || day > hi;
          const isFrom = value != null && day === value.from;
          const isTo = value != null && !single && day === value.to;
          const inRange = value != null && !single && value.from < day && day < value.to;
          const isAnchor = day === anchor;
          const isToday = day === today;
          return (
            <button
              key={day}
              type="button"
              disabled={disabled}
              aria-label={`Ngày ${fmtVi(day)}${disabled ? " (ngoài kho tin)" : ""}`}
              aria-pressed={isFrom || isTo || (single && isFrom)}
              onClick={() => onDay(day)}
              onDoubleClick={() => onDayDouble(day)}
              className={cn(
                "relative inline-flex size-9 items-center justify-center rounded-md text-[13px] tabular-nums transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                disabled && "cursor-not-allowed text-muted-foreground/30",
                !disabled && !isFrom && !isTo && !inRange && "text-foreground hover:bg-accent",
                inRange && "rounded-none bg-primary/15 text-foreground",
                isFrom && (single ? "rounded-md bg-primary text-primary-foreground" : "rounded-l-md rounded-r-none bg-primary text-primary-foreground"),
                isTo && "rounded-r-md rounded-l-none bg-primary text-primary-foreground",
                isAnchor && !isFrom && !isTo && "bg-accent ring-2 ring-ring/60",
                isToday && !isFrom && !isTo && "font-semibold"
              )}
            >
              {Number(day.slice(8, 10))}
              {isToday && !isFrom && !isTo && (
                <span
                  className="absolute bottom-1 size-1 rounded-full bg-primary"
                  aria-hidden="true"
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
