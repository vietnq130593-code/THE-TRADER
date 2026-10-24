"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Crosshair, Globe2, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiGet } from "@/lib/api";
import { changeColor, formatPct, formatVndCompact } from "@/lib/format";
import type { BreadthResponse, FocusAction, FocusRow, FocusResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * UNIVERSE_TIERING_BLUEPRINT §7 — card "Toàn sàn — bức tranh rộng (T0)".
 *
 * Lấp khoảng trống breadth Task 186 (cũ chỉ ~30 mã HOSE quoted): A/D +
 * %trên MA20/50/200 trên ~1.000 mã CORE+BROAD, theo sàn + gộp, kèm bảng
 * MÃ TRỌNG TÂM (screen §4 — top-30 ADTV20 ổn định, hysteresis 2 snapshot).
 *
 * Dữ liệu on-demand qua /api/market/breadth + /api/market/focus (cache lib
 * 10 phút — staleTime khớp nhịp; refetchInterval=false để fallback polling
 * của TanStack mặc định không tự đấm). Phase 1: hiển thị + đề xuất — chưa
 * bỏ phiếu Bayes (ổn định synthesis, để Phase 2 kèm bài toán trọng số).
 */
const T0_STALE_MS = 10 * 60_000;

const MARKET_LABELS_VI: Record<string, string> = {
  HOSE: "TP.HCM",
  HNX: "Hà Nội",
  UPCOM: "UPCOM",
  TOTAL: "Toàn thị trường",
};

const ACTION_BADGE: Record<FocusAction, { label: string; className: string }> = {
  "THĂNG-CẤP-T2": { label: "THĂNG CẤP T2", className: "border-up/40 bg-up/10 text-up" },
  "GIỮ-T1": { label: "GIỮ T1", className: "border-border bg-muted text-foreground" },
  "GẦN-TRỌNG-TÂM": {
    label: "GẦN TRỌNG TÂM",
    className: "border-flat/40 bg-flat/10 text-flat",
  },
  "THEO-DÕI-T0": { label: "THEO DÕI T0", className: "border-border text-muted-foreground" },
  "XEM-LẠI": { label: "XEM LẠI", className: "border-down/40 bg-down/10 text-down" },
};

function AdChip({
  advancing,
  declining,
  unchanged,
}: {
  advancing: number;
  declining: number;
  unchanged: number;
}) {
  const total = Math.max(1, advancing + declining + unchanged);
  const upPct = (advancing / total) * 100;
  const downPct = (declining / total) * 100;
  const flatPct = (unchanged / total) * 100;
  return (
    <div className="flex flex-col gap-1.5" aria-label="Tỷ lệ tăng giảm toàn sàn">
      <p className="text-sm leading-tight">
        <span className="font-semibold text-up">{advancing}</span>
        <span className="text-muted-foreground"> tăng · </span>
        <span className="font-semibold text-down">{declining}</span>
        <span className="text-muted-foreground"> giảm · </span>
        <span className="font-semibold text-flat">{unchanged}</span>
        <span className="text-muted-foreground"> giữ</span>
      </p>
      <div
        className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={`Thanh tỷ lệ: ${upPct.toFixed(0)}% tăng, ${downPct.toFixed(0)}% giảm, ${flatPct.toFixed(0)}% giữ`}
      >
        <div className="bg-up" style={{ width: `${upPct}%` }} />
        <div className="bg-flat" style={{ width: `${flatPct}%` }} />
        <div className="bg-down" style={{ width: `${downPct}%` }} />
      </div>
    </div>
  );
}

function StatChip({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-card p-3">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold leading-none tabular-nums">{value}</p>
      <p className="text-[11px] leading-tight text-muted-foreground/80">{hint}</p>
    </div>
  );
}

function FocusActionBadge({ action }: { action: FocusAction }) {
  const cfg = ACTION_BADGE[action];
  return (
    <Badge variant="outline" className={cn("whitespace-nowrap text-[10px]", cfg.className)}>
      {cfg.label}
    </Badge>
  );
}

function FocusRows({ rows, dimmed }: { rows: FocusRow[]; dimmed?: boolean }) {
  return (
    <>
      {rows.map((r) => (
        <TableRow key={r.symbol} className={dimmed ? "opacity-70" : undefined}>
          <TableCell className="py-2 font-medium">{r.symbol}</TableCell>
          <TableCell className="py-2 text-muted-foreground">
            {MARKET_LABELS_VI[r.market] ?? r.market}
          </TableCell>
          <TableCell className="py-2">
            <Badge
              variant="outline"
              className={cn(
                "text-[10px]",
                r.tier === "CORE" ? "border-primary/40 text-primary" : "text-muted-foreground"
              )}
            >
              {r.tier === "CORE" ? "T1" : "T0"}
            </Badge>
          </TableCell>
          <TableCell className="py-2 text-right tabular-nums">
            {formatVndCompact(r.adtv20Vnd)}
          </TableCell>
          <TableCell className="py-2 text-right tabular-nums text-muted-foreground">
            {r.rankNow}
            <span className="text-muted-foreground/60"> / {r.rankStable ?? "—"}</span>
          </TableCell>
          <TableCell
            className={cn("py-2 text-right tabular-nums", changeColor(r.momentum20Pct ?? 0))}
          >
            {r.momentum20Pct != null ? formatPct(r.momentum20Pct) : "—"}
          </TableCell>
          <TableCell className="py-2 text-center">
            {r.aboveMa50 == null ? (
              <span className="text-muted-foreground/60">—</span>
            ) : r.aboveMa50 ? (
              <span className="text-up" aria-label="Trên MA50">
                ▲
              </span>
            ) : (
              <span className="text-down" aria-label="Dưới MA50">
                ▼
              </span>
            )}
          </TableCell>
          <TableCell className="py-2 text-right">
            <FocusActionBadge action={r.action} />
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

export function MarketBreadthCard() {
  const breadth = useQuery({
    queryKey: ["market-breadth"],
    queryFn: () => apiGet<BreadthResponse>("/api/market/breadth"),
    staleTime: T0_STALE_MS,
    refetchInterval: false,
  });
  const focus = useQuery({
    queryKey: ["market-focus"],
    queryFn: () => apiGet<FocusResponse>("/api/market/focus"),
    staleTime: T0_STALE_MS,
    refetchInterval: false,
  });

  if (breadth.isLoading) {
    return (
      <Card aria-busy="true">
        <CardContent className="flex flex-col gap-3 p-4">
          <Skeleton className="h-5 w-64" />
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
          <Skeleton className="h-40 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (breadth.isError || !breadth.data) {
    return (
      <Card>
        <CardContent className="px-4 py-3 text-sm text-down">
          {breadth.error?.message ?? "Không tải được bức tranh toàn sàn (T0)."}
        </CardContent>
      </Card>
    );
  }

  const b = breadth.data;
  const t = b.total;
  const pct = (n: number) => (t.counted > 0 ? (n / t.counted) * 100 : 0);

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-4 sm:p-6">
        {/* Header */}
        <div className="flex flex-wrap items-center gap-2">
          <Globe2 className="size-4 text-primary" aria-hidden="true" />
          <h3 className="text-sm font-semibold uppercase tracking-wider text-foreground">
            Toàn sàn — bức tranh rộng (T0)
          </h3>
          <span className="text-xs text-muted-foreground">phiên {b.asOf}</span>
          <span className="ms-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <Badge variant="outline" className="border-primary/40 text-[10px] text-primary">
              T1 · {b.universe.core} mã lõi
            </Badge>
            <Badge variant="outline" className="text-[10px]">
              T0 · {b.universe.broad} mã toàn sàn
            </Badge>
          </span>
        </div>

        {/* Stat chips */}
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <div className="flex flex-col gap-1.5 rounded-lg border bg-card p-3">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              A/D toàn thị trường
            </p>
            <AdChip advancing={t.advancing} declining={t.declining} unchanged={t.unchanged} />
          </div>
          <StatChip
            label="Trên MA20"
            value={`${pct(t.aboveMa20).toFixed(0)}%`}
            hint={`${t.aboveMa20}/${t.counted} mã`}
          />
          <StatChip
            label="Trên MA50"
            value={`${pct(t.aboveMa50).toFixed(0)}%`}
            hint={`${t.aboveMa50}/${t.counted} mã`}
          />
          <StatChip
            label="Trên MA200"
            value={`${pct(t.aboveMa200).toFixed(0)}%`}
            hint={`${t.aboveMa200}/${t.counted} mã`}
          />
        </div>

        {/* Bảng theo sàn */}
        <div className="overflow-x-auto">
          <Table>
            <caption className="sr-only">
              Chỉ số breadth theo sàn: tăng/giảm/giữ và tỷ lệ trên MA20/50/200
            </caption>
            <TableHeader>
              <TableRow>
                <TableHead className="h-8 text-xs">Sàn</TableHead>
                <TableHead className="h-8 text-xs text-right">A/D</TableHead>
                <TableHead className="h-8 text-xs text-right">Giữ</TableHead>
                <TableHead className="h-8 text-xs text-right">%MA20</TableHead>
                <TableHead className="h-8 text-xs text-right">%MA50</TableHead>
                <TableHead className="h-8 text-xs text-right">%MA200</TableHead>
                <TableHead className="h-8 text-xs text-right">Mẫu</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {b.byMarket.map((row) => {
                const mTotal = Math.max(1, row.advancing + row.declining + row.unchanged);
                return (
                  <TableRow key={row.market}>
                    <TableCell className="py-2 text-xs font-medium">
                      {MARKET_LABELS_VI[row.market] ?? row.market}
                    </TableCell>
                    <TableCell className="py-2 text-right text-xs tabular-nums">
                      <span className="font-semibold text-up">{row.advancing}</span>
                      <span className="text-muted-foreground"> / </span>
                      <span className="font-semibold text-down">{row.declining}</span>
                    </TableCell>
                    <TableCell className="py-2 text-right text-xs tabular-nums text-flat">
                      {row.unchanged}
                    </TableCell>
                    <TableCell className="py-2 text-right text-xs tabular-nums">
                      {row.counted > 0 ? ((row.aboveMa20 / row.counted) * 100).toFixed(0) : "—"}%
                    </TableCell>
                    <TableCell className="py-2 text-right text-xs tabular-nums">
                      {row.counted > 0 ? ((row.aboveMa50 / row.counted) * 100).toFixed(0) : "—"}%
                    </TableCell>
                    <TableCell className="py-2 text-right text-xs tabular-nums">
                      {row.counted > 0 ? ((row.aboveMa200 / row.counted) * 100).toFixed(0) : "—"}%
                    </TableCell>
                    <TableCell className="py-2 text-right text-xs tabular-nums text-muted-foreground">
                      {row.counted}
                      {row.nonTrading > 0 ? (
                        <span className="text-muted-foreground/60"> (+{row.nonTrading} nghỉ)</span>
                      ) : null}
                      <span className="sr-only">mã tính breadth (mTotal={mTotal})</span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        {/* Mã trọng tâm */}
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <Crosshair className="size-4 text-primary" aria-hidden="true" />
            <h4 className="text-sm font-semibold">Mã trọng tâm — đề xuất bám sát</h4>
            {focus.data ? (
              <span className="text-xs text-muted-foreground">
                {focus.data.stats.coreInFocus} T1 · {focus.data.stats.broadInFocus} T0 đề nghị
                thăng cấp
                {focus.data.stats.coreDemoted > 0
                  ? ` · ${focus.data.stats.coreDemoted} T1 rơi khỏi top ${focus.data.rule.demotionRank}`
                  : ""}
              </span>
            ) : null}
          </div>
          <div className="max-h-96 overflow-auto custom-scrollbar rounded-lg border">
            <Table>
              <caption className="sr-only">
                Bảng mã trọng tâm: mã, sàn, tầng, ADTV 20 phiên, hạng hiện tại và tại T-10 phiên,
                động lượng 20 phiên, trên/dưới MA50, hành động đề xuất
              </caption>
              <TableHeader className="sticky top-0 z-10 bg-background">
                <TableRow>
                  <TableHead className="h-8 text-xs">Mã</TableHead>
                  <TableHead className="h-8 text-xs">Sàn</TableHead>
                  <TableHead className="h-8 text-xs">Tầng</TableHead>
                  <TableHead className="h-8 text-xs text-right">ADTV20</TableHead>
                  <TableHead className="h-8 text-xs text-right">Hạng nay/T-10</TableHead>
                  <TableHead className="h-8 text-xs text-right">QĐL 20 phiên</TableHead>
                  <TableHead className="h-8 text-xs text-center">MA50</TableHead>
                  <TableHead className="h-8 text-xs text-right">Đề xuất</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {focus.isLoading ? (
                  <TableRow>
                    <TableCell colSpan={8} className="py-6 text-center text-sm text-muted-foreground">
                      Đang xếp hạng {b.universe.core + b.universe.broad} mã…
                    </TableCell>
                  </TableRow>
                ) : focus.isError || !focus.data ? (
                  <TableRow>
                    <TableCell colSpan={8} className="py-6 text-center text-sm text-down">
                      {focus.error?.message ?? "Không tải được screen trọng tâm."}
                    </TableCell>
                  </TableRow>
                ) : focus.data.focus.length === 0 && focus.data.near.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="py-6 text-center text-sm text-muted-foreground">
                      Chưa đủ dữ liệu xếp hạng (cần ≥ 20 phiên có giao dịch/mã).
                    </TableCell>
                  </TableRow>
                ) : (
                  <>
                    <FocusRows rows={focus.data.focus} />
                    {focus.data.near.length > 0 ? <FocusRows rows={focus.data.near} dimmed /> : null}
                  </>
                )}
              </TableBody>
            </Table>
          </div>
        </div>

        {/* Footnote */}
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
          <span>
            T0 = bar ngày, cửa sổ cuộn ~260 phiên (420 ngày) · đồng bộ dchart sau EOD 16:00 ICT,
            prune tự động · breadth tính trên {t.counted} mã có giao dịch (bỏ ETF theo chuẩn A/D
            sàn). Trọng tâm = top {focus.data?.rule.topN ?? 30} ADTV20, ổn định hạng ≤{" "}
            {focus.data?.rule.stabilityMaxRank ?? 40} tại T-{focus.data?.rule.lagSessions ?? 10} phiên
            (chống mã nhảy top do 1 phiên volume bất thường). Phase 2 sẽ tiêu thụ trọng tâm cho
            bar 5-phút · tin RAG · phiếu LLM; hiện tại đề xuất quan sát.
          </span>
        </p>
      </CardContent>
    </Card>
  );
}
