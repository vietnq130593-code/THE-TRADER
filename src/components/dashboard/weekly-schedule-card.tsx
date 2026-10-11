"use client";

import { CalendarClock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { DOW_LABELS_VN, parseScheduleGrammar } from "@/lib/schedule";
import { cn } from "@/lib/utils";
import type { ScheduledTaskRow } from "@/lib/types";

/**
 * K3 #94 (AUTONOMY_BLUEPRINT §6.4) — khối "Lịch tuần": gom nhiệm vụ định kỳ
 * CẢ NHÓM theo thứ tự giờ — nhìn 1 cái thấy toàn bộ nhịp đội:
 *   - "Hằng ngày": các nhiệm vụ daily xếp theo HH:MM;
 *   - Thứ Hai → Chủ nhật: các nhiệm vụ weekly đúng thứ + giờ.
 * Dữ liệu từ GET /api/agents → scheduledTasks (workspace cha truyền vào).
 */

/** Nhãn aria tiếng Việt đúng cho 1 thứ trong tuần.
 *  COSMETIC-2 (FB-4A): DOW 0 là "Chủ nhật" — KHÔNG tiền tố "Thứ" (trước đây
 *  "Thứ Chủ nhật" sai tiếng Việt); các ngày khác DOW_LABELS_VN đã chứa
 *  "thứ Hai"… — chỉ viết hoa chữ đầu ("Thứ Hai"), không nhân đôi tiền tố. */
function dayAriaLabel(d: number): string {
  const label = DOW_LABELS_VN[d] ?? "";
  return d === 0 ? label : label.charAt(0).toUpperCase() + label.slice(1);
}

/** Dòng hiển thị 1 nhiệm vụ trong lịch. */
function ScheduleLine({ t, time }: { t: ScheduledTaskRow; time: string }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1 text-xs">
      <span className="font-mono tabular-nums text-muted-foreground">{time}</span>
      <span className="font-medium">{t.agentName}</span>
      <span className="font-mono text-[10px] text-muted-foreground">{t.agentCode}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground" title={t.title}>
        — {t.title}
      </span>
      {t.paused && (
        <Badge
          variant="outline"
          className="px-1.5 py-0 text-[9px] text-amber-600 dark:text-amber-400"
        >
          tạm dừng
        </Badge>
      )}
      {t.runCount > 0 && (
        <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">
          {t.runCount} lần
        </span>
      )}
    </li>
  );
}

export function WeeklyScheduleCard({ tasks }: { tasks: ScheduledTaskRow[] }) {
  // Tách daily / weekly + sort theo (dow, phút).
  const daily: { t: ScheduledTaskRow; minutes: number }[] = [];
  const weekly: { t: ScheduledTaskRow; dow: number; minutes: number }[] = [];
  for (const t of tasks) {
    const g = parseScheduleGrammar(t.schedule);
    if (!g) continue;
    if (g.kind === "daily") daily.push({ t, minutes: g.minutes });
    else weekly.push({ t, dow: g.dow, minutes: g.minutes });
  }
  daily.sort((a, b) => a.minutes - b.minutes);
  weekly.sort((a, b) => a.dow - b.dow || a.minutes - b.minutes);

  const hhmm = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

  if (daily.length === 0 && weekly.length === 0) {
    return (
      <Card className="gap-3">
        <CardHeader className="pb-0">
          <CardTitle className="flex items-center gap-2 text-sm">
            <CalendarClock className="size-4 text-primary" aria-hidden="true" />
            Lịch tuần — nhiệm vụ định kỳ
          </CardTitle>
          <CardDescription className="text-xs">
            Chưa có nhiệm vụ định kỳ nào — mở panel chi tiết agent, tab “Nhiệm vụ”
            để tạo lịch hằng ngày/hằng tuần.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  // Gom weekly theo dow (1..6, 0 — tuần VN bắt đầu Thứ Hai).
  const dayOrder = [1, 2, 3, 4, 5, 6, 0];
  const byDow = new Map<number, { t: ScheduledTaskRow; minutes: number }[]>();
  for (const w of weekly) {
    const list = byDow.get(w.dow) ?? [];
    list.push({ t: w.t, minutes: w.minutes });
    byDow.set(w.dow, list);
  }

  return (
    <Card className="gap-3" aria-labelledby="weekly-schedule-heading">
      <CardHeader className="pb-0">
        <CardTitle
          id="weekly-schedule-heading"
          className="flex items-center gap-2 text-sm"
        >
          <CalendarClock className="size-4 text-primary" aria-hidden="true" />
          Lịch tuần — nhiệm vụ định kỳ
          <Badge variant="secondary" className="px-1.5 text-[10px] tabular-nums">
            {daily.length + weekly.length}
          </Badge>
        </CardTitle>
        <CardDescription className="text-xs">
          Toàn bộ nhịp chạy định kỳ của đội theo giờ Việt Nam (ICT) — engine đôn
          đốc mỗi phút.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {daily.length > 0 && (
          <div
            className={cn(
              "rounded-lg border bg-muted/30 p-2.5",
              weekly.length === 0 && "border-b-0"
            )}
            aria-label="Nhiệm vụ hằng ngày"
          >
            <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Hằng ngày
            </p>
            <ul className="divide-y divide-border/50">
              {daily.map(({ t, minutes }) => (
                <ScheduleLine key={t.id} t={t} time={hhmm(minutes)} />
              ))}
            </ul>
          </div>
        )}
        {dayOrder
          .filter((d) => (byDow.get(d)?.length ?? 0) > 0)
          .map((d) => (
            <div
              key={d}
              className="rounded-lg border bg-muted/30 p-2.5"
              aria-label={dayAriaLabel(d)}
            >
              <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {DOW_LABELS_VN[d]}
              </p>
              <ul className="divide-y divide-border/50">
                {(byDow.get(d) ?? []).map(({ t, minutes }) => (
                  <ScheduleLine key={t.id} t={t} time={hhmm(minutes)} />
                ))}
              </ul>
            </div>
          ))}
      </CardContent>
    </Card>
  );
}
