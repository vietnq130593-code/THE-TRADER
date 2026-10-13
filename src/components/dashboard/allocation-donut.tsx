"use client";

import * as React from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { Skeleton } from "@/components/ui/skeleton";
import { formatVnd } from "@/lib/format";
import type { PortfolioPosition } from "@/lib/types";

/**
 * PHASE3_BLUEPRINT §5.3 — donut phân bổ danh mục theo ngành
 * (Instrument.sector × marketValue). Chỉ hiển thị desktop ≥ md;
 * mobile dùng dòng tổng hợp "Top ngành: …" (xử lý ở parent).
 *
 * #110-g M4.10: khối donut chỉ render khi thực sự hiển thị (matchMedia ≥768px,
 * SSR-safe — mặc định không render, đo sau khi mount) để recharts
 * ResponsiveContainer không đo width(0) trên mobile khi container `hidden md:flex`.
 */

// Bảng màu ngành — tách biệt đủ, không dùng indigo/blue thuần
const SECTOR_COLORS = [
  "#16a34a", // green-600
  "#d97706", // amber-600
  "#dc2626", // red-600
  "#0d9488", // teal-600
  "#7c3aed", // violet-600
  "#65a30d", // lime-600
  "#c026d3", // fuchsia-600
];

interface SectorSlice {
  name: string;
  value: number; // marketValue (VND)
  pct: number; // % tổng GTTH
}

interface AllocationDonutProps {
  positions: PortfolioPosition[];
  totalMarketValue: number;
  loading: boolean;
}

export function AllocationDonut({ positions, totalMarketValue, loading }: AllocationDonutProps) {
  // SSR-safe: mặc định false (không render donut ở HTML đầu tiên), sau khi mount
  // đo matchMedia rồi mới render — tránh recharts warning width(0) khi ẩn ở mobile.
  const [isDesktop, setIsDesktop] = React.useState(false);

  React.useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  const slices = React.useMemo<SectorSlice[]>(() => {
    const bySector = new Map<string, number>();
    for (const p of positions) {
      const key = p.sector || "Khác";
      bySector.set(key, (bySector.get(key) ?? 0) + p.marketValue);
    }
    return [...bySector.entries()]
      .map(([name, value]) => ({
        name,
        value,
        pct: totalMarketValue > 0 ? (value / totalMarketValue) * 100 : 0,
      }))
      .sort((a, b) => b.value - a.value);
  }, [positions, totalMarketValue]);

  const topSectorsLine = React.useMemo(
    () =>
      slices
        .slice(0, 3)
        .map((s) => `${s.name} ${s.pct.toFixed(0)}%`)
        .join(" · "),
    [slices]
  );

  return (
    <div className="flex flex-col gap-2">
      {loading ? (
        <Skeleton className="h-44 w-full rounded-xl" />
      ) : slices.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          Chưa có vị thế để phân bổ.
        </p>
      ) : (
        <>
          {/* Dòng tổng hợp — luôn hiển thị (mobile thay donut) */}
          <p className="text-[11px] text-muted-foreground md:hidden">
            Top ngành: {topSectorsLine || "—"}
          </p>
          {isDesktop && (
            <div className="hidden items-center gap-4 md:flex">
            <div className="h-40 w-40 shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={slices}
                    dataKey="value"
                    nameKey="name"
                    innerRadius="62%"
                    outerRadius="95%"
                    paddingAngle={2}
                    strokeWidth={0}
                    isAnimationActive={false}
                  >
                    {slices.map((s, i) => (
                      <Cell key={s.name} fill={SECTOR_COLORS[i % SECTOR_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const s = payload[0].payload as SectorSlice;
                      return (
                        <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-lg">
                          <p className="font-medium">{s.name}</p>
                          <p className="tabular-nums text-muted-foreground">
                            {formatVnd(s.value)} · {s.pct.toFixed(1)}% GTTH
                          </p>
                        </div>
                      );
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            {/* Legend chip % */}
            <ul className="flex min-w-0 flex-col gap-1.5">
              {slices.map((s, i) => (
                <li key={s.name} className="flex items-center gap-2 text-xs">
                  <span
                    className="size-2.5 shrink-0 rounded-sm"
                    style={{ backgroundColor: SECTOR_COLORS[i % SECTOR_COLORS.length] }}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 truncate text-muted-foreground">{s.name}</span>
                  <span className="tabular-nums ml-auto font-medium">
                    {s.pct.toFixed(1)}%
                  </span>
                </li>
              ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
