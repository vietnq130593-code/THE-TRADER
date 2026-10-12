"use client";

/**
 * src/components/dashboard/council-workspace.tsx — #106
 * COUNCIL_STEWARDSHIP_BLUEPRINT: module "Hội đồng" (workspace thứ 8).
 *
 * Ba卡片:
 *  (1) TÀI KHOẢN HỘI ĐỒNG — tầm nhìn toàn cục (C-VISION): equity · cash ·
 *      P&L từ lúc kích hoạt · đường cong CashSnapshot k1-daily · vị thế với
 *      lãi/lỗ chưa thực hiện. Trước #106 tài khoản sandbox VÔ HÌNH với hội
 *      đồng (quarantine P0 #87) — trader đã phê duyệt thay đổi này.
 *  (2) SỔ ĐÁNH GIÁ QUYẾT ĐỊNH (D-LEDGER): mỗi tín hiệu 1 hàng với phán quyết
 *      WIN/LOSS/NEUTRAL ±0,5% + P&L tiền quy kết — "đánh giá toàn cục các
 *      quyết định mua bán lợi ích hay tổn thất".
 *  (3) THÍ NGHIỆM PHÂN BỔ ĐA RỔ (E-ALLOC): hội đồng TỰ nghiên cứu tỷ trọng
 *      5 rổ — hội nghị LLM Chủ nhật 05:50 + tạo tay + mark hằng ngày + bài
 *      học từ kết quả.
 *
 * Bộ chọn khoảng thời gian toàn cục #105 lọc sổ quyết định (decidedAt) và
 * thí nghiệm (startedAt) theo ngày ICT.
 */

import * as React from "react";
import {
  BookOpenCheck,
  FlaskConical,
  Loader2,
  Plus,
  RefreshCw,
  Scale,
  Square,
  Users,
} from "lucide-react";
import {
  Badge,
} from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  useAllocationSession,
  useCouncilOverview,
  useCreateExperiment,
  useMarkExperiments,
  useRunDecisionEval,
  useStopExperiment,
} from "@/hooks/use-council";
import { useDateRange } from "@/hooks/use-date-range";
import {
  changeColor,
  formatDateTime,
  formatPct,
  formatPrice,
  formatVnd,
  formatVndCompact,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import type {
  CouncilExperimentView,
  DecisionLedgerRowView,
} from "@/lib/types";

/* ─────────────────── Tiện ích dùng chung ─────────────────── */

const BASKET_SHORT: Record<string, string> = {
  VN_EQUITY: "CP VN",
  INTL_EQUITY: "CP QT",
  BOND: "Tr.phiếu",
  FOREX: "Forex",
  COMMODITY: "Hàng hoá",
};

function verdictClass(verdict: string): string {
  if (verdict === "WIN") return "border-up/40 text-up";
  if (verdict === "LOSS") return "border-down/40 text-down";
  return "border-amber-500/40 text-amber-600 dark:text-amber-400";
}

function verdictLabel(verdict: string): string {
  if (verdict === "WIN") return "LỢI";
  if (verdict === "LOSS") return "TỔN THẤT";
  return "ĐI NGANG";
}

function directionClass(direction: string): string {
  if (direction === "BUY") return "text-up";
  if (direction === "SELL") return "text-down";
  return "text-flat";
}

function executionLabel(kind: string | null): string {
  switch (kind) {
    case "EXECUTED_CLOSED":
      return "đã khớp — đóng";
    case "EXECUTED_OPEN":
      return "đã khớp — đang mở";
    case "UNEXECUTED":
      return "chưa thực thi";
    default:
      return "—";
  }
}

/** Sparkline returnPct cho thí nghiệm — SVG polyline thuần (pattern EquitySparkline). */
function ReturnSparkline({
  points,
}: {
  points: Array<{ date: string; returnPct: number }>;
}) {
  if (points.length < 2) return null;
  const w = 240;
  const h = 44;
  const pad = 4;
  const values = points.map((p) => p.returnPct);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min || 1;
  const xy = points.map((p, i) => ({
    x: pad + (i / (points.length - 1)) * (w - 2 * pad),
    y: h - pad - ((p.returnPct - min) / span) * (h - 2 * pad),
  }));
  const line = xy.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const zeroY = h - pad - ((0 - min) / span) * (h - 2 * pad);
  const up = values[values.length - 1] >= 0;
  const stroke = up ? "var(--color-up, #16a34a)" : "var(--color-down, #dc2626)";
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="h-11 w-full min-w-[120px]"
      role="img"
      aria-label={`Lợi suất thí nghiệm ${points.length} phiên: ${formatPct(
        values[values.length - 1]
      )}`}
      preserveAspectRatio="none"
    >
      <line
        x1={pad}
        x2={w - pad}
        y1={zeroY}
        y2={zeroY}
        stroke="currentColor"
        className="text-border"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
      <polyline
        points={line}
        fill="none"
        stroke={stroke}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/* ─────────────────── Card 1: Tài khoản Hội đồng ─────────────────── */

function AccountVisionCard({
  account,
  isLoading,
}: {
  account: CouncilOverviewResponseAccount | undefined;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <Card className="gap-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="size-4 text-primary" aria-hidden="true" />
            Tài khoản Hội đồng — nhìn toàn cục
          </CardTitle>
          <CardDescription>Tài khoản thử nghiệm K1 agents tự giao dịch</CardDescription>
        </CardHeader>
        <CardContent className="pb-6">
          <div className="grid grid-cols-2 gap-3 px-1 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }
  if (!account?.configured) {
    return (
      <Card className="gap-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="size-4 text-primary" aria-hidden="true" />
            Tài khoản Hội đồng — nhìn toàn cục
          </CardTitle>
          <CardDescription>
            Tài khoản thử nghiệm K1 — agents tự giao dịch tiền ảo
          </CardDescription>
        </CardHeader>
        <CardContent className="pb-6">
          <p className="text-sm text-muted-foreground">
            Chưa kích hoạt cơ chế thử nghiệm (K1) — bật trong{" "}
            <strong>Cài đặt → Cơ chế thử nghiệm (tiền ảo)</strong>.
          </p>
        </CardContent>
      </Card>
    );
  }
  const equity = account.equity ?? 0;
  const cash = account.cash ?? 0;
  const pnl = account.pnlSinceActivation ?? 0;
  const pnlPct = account.pnlPctSinceActivation ?? 0;
  const curve = account.equityCurve ?? [];
  const positions = account.positions ?? [];

  // Đường cong equity — SVG polyline (pattern EquitySparkline sandbox-card)
  const spark = (() => {
    if (curve.length < 2) return null;
    const w = 560;
    const h = 120;
    const pad = 6;
    const values = curve.map((p) => p.equity);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || Math.max(1, Math.abs(max) * 0.001);
    const xy = curve.map((p, i) => ({
      x: pad + (i / (curve.length - 1)) * (w - 2 * pad),
      y: h - pad - ((p.equity - min) / span) * (h - 2 * pad),
    }));
    const line = xy.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    const area = `${pad},${h - pad} ${line} ${(w - pad).toFixed(1)},${h - pad}`;
    const up = values[values.length - 1] >= values[0];
    const stroke = up ? "var(--color-up, #16a34a)" : "var(--color-down, #dc2626)";
    return (
      <div className="overflow-hidden rounded-lg border bg-muted/30">
        <svg
          viewBox={`0 0 ${w} ${h}`}
          className="h-28 w-full"
          role="img"
          aria-label={`Đường cong equity tài khoản Hội đồng — ${curve.length} phiên`}
          preserveAspectRatio="none"
        >
          <polygon
            points={area}
            fill={up ? "rgba(22,163,74,0.10)" : "rgba(220,38,38,0.10)"}
          />
          <polyline
            points={line}
            fill="none"
            stroke={stroke}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
          <circle cx={xy[xy.length - 1].x} cy={xy[xy.length - 1].y} r={3.5} fill={stroke} />
        </svg>
        <div className="flex justify-between px-3 py-1.5 text-[10px] tabular-nums text-muted-foreground">
          <span>{formatDateTime(curve[0].createdAt)}</span>
          <span>{formatDateTime(curve[curve.length - 1].createdAt)}</span>
        </div>
      </div>
    );
  })();

  const tiles: Array<{ label: string; value: string; sub?: string; cls?: string }> = [
    { label: "Tổng tài sản", value: formatVndCompact(equity) },
    { label: "Tiền mặt", value: formatVndCompact(cash) },
    {
      label: "L/L từ lúc kích hoạt",
      value: formatVnd(pnl),
      sub: formatPct(pnlPct),
      cls: changeColor(pnl),
    },
    {
      label: "Biến động ngày gần nhất",
      value: account.dayChange != null ? formatVnd(account.dayChange) : "—",
      cls: changeColor(account.dayChange ?? 0),
    },
  ];

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Users className="size-4 text-primary" aria-hidden="true" />
          Tài khoản Hội đồng — nhìn toàn cục
        </CardTitle>
        <CardDescription>
          Tài khoản thử nghiệm K1 (agents tự giao dịch) — từ #106 Hội đồng
          <strong> nhìn thấy</strong> tài khoản này khi ra quyết định
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 pb-6">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {tiles.map((t) => (
            <div key={t.label} className="rounded-lg border bg-muted/30 p-3">
              <p className="text-[11px] text-muted-foreground">{t.label}</p>
              <p className={cn("mt-1 text-sm font-semibold tabular-nums", t.cls)}>
                {t.value}
              </p>
              {t.sub ? (
                <p className={cn("text-[11px] tabular-nums", t.cls)}>{t.sub}</p>
              ) : null}
            </div>
          ))}
        </div>
        {spark}
        {positions.length > 0 ? (
          <div className="overflow-hidden rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-[11px] text-muted-foreground">
                  <th className="px-3 py-2 text-left font-medium">Mã</th>
                  <th className="px-3 py-2 text-right font-medium">Lượng</th>
                  <th className="px-3 py-2 text-right font-medium">Giá vốn</th>
                  <th className="px-3 py-2 text-right font-medium">Giá gần nhất</th>
                  <th className="px-3 py-2 text-right font-medium">Lãi/lỗ chưa thực hiện</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={p.symbol} className="border-b last:border-0">
                    <td className="px-3 py-2 font-medium">{p.symbol}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {p.quantity.toLocaleString("vi-VN")}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatPrice(p.avgPrice)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {p.lastPrice != null ? formatPrice(p.lastPrice) : "—"}
                    </td>
                    <td
                      className={cn(
                        "px-3 py-2 text-right font-medium tabular-nums",
                        changeColor(p.unrealizedPnl)
                      )}
                    >
                      {p.unrealizedPnl != null ? formatVnd(p.unrealizedPnl) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Không nắm giữ vị thế nào — tiền mặt 100%.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

interface CouncilOverviewResponseAccount {
  configured: boolean;
  equity?: number;
  cash?: number;
  initial?: number | null;
  activatedAt?: string | null;
  pnlSinceActivation?: number | null;
  pnlPctSinceActivation?: number | null;
  dayChange?: number | null;
  equityCurve?: Array<{ createdAt: string; equity: number }>;
  positions?: Array<{
    symbol: string;
    quantity: number;
    avgPrice: number;
    lastPrice: number | null;
    unrealizedPnl: number | null;
  }>;
}

/* ─────────────────── Card 2: Sổ đánh giá quyết định ─────────────────── */

function DecisionLedgerRow({ row }: { row: DecisionLedgerRowView }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 sm:px-6">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={cn("text-xs font-bold", directionClass(row.direction))}>
            {row.direction === "BUY" ? "MUA" : row.direction === "SELL" ? "BÁN" : "GIỮ"}
          </span>
          <span className="text-sm font-medium">{row.symbol}</span>
          <Badge variant="outline" className={cn("px-1.5 py-0 text-[10px]", verdictClass(row.verdict))}>
            {verdictLabel(row.verdict)}
          </Badge>
          {row.world ? (
            <span className="hidden rounded-full border bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline">
              {row.world === "sandbox" ? "thử nghiệm" : "giấy"}
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {formatDateTime(row.decidedAt)} · {executionLabel(row.executionKind)}
          {row.agentName ? ` · ${row.agentName}` : ""}
        </p>
      </div>
      <div className="flex items-center gap-4 text-right">
        <div className="hidden flex-col sm:flex">
          <span className="text-[10px] text-muted-foreground">đỉnh / đáy</span>
          <span className="text-[11px] tabular-nums">
            <span className={changeColor(row.peakPnlPct)}>{formatPct(row.peakPnlPct)}</span>
            {" / "}
            <span className={changeColor(row.troughPnlPct)}>{formatPct(row.troughPnlPct)}</span>
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] text-muted-foreground">hiện tại</span>
          <span className={cn("text-sm font-semibold tabular-nums", changeColor(row.markPnlPct))}>
            {formatPct(row.markPnlPct)}
          </span>
        </div>
        <div className="hidden w-24 flex-col md:flex">
          <span className="text-[10px] text-muted-foreground">P&L quy kết</span>
          <span
            className={cn(
              "text-sm font-semibold tabular-nums",
              changeColor(row.cashPnlVND)
            )}
          >
            {row.cashPnlVND != null ? formatVndCompact(row.cashPnlVND) : "—"}
          </span>
        </div>
      </div>
    </div>
  );
}

function DecisionLedgerCard({
  data,
  isLoading,
  onEvaluate,
  evaluatePending,
  rangeLabel,
}: {
  data:
    | {
        rows: DecisionLedgerRowView[];
        stats: {
          total: number;
          WIN: number;
          LOSS: number;
          NEUTRAL: number;
          winRate: number | null;
          executed: number;
          totalCashPnlVND: number;
        };
      }
    | undefined;
  isLoading: boolean;
  onEvaluate: () => void;
  evaluatePending: boolean;
  rangeLabel: string | null;
}) {
  const stats = data?.stats;
  const rows = data?.rows ?? [];
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BookOpenCheck className="size-4 text-primary" aria-hidden="true" />
          Sổ đánh giá quyết định — lợi ích / tổn thất
        </CardTitle>
        <CardDescription>
          Mỗi quyết định (tín hiệu) 1 hàng: phán quyết WIN/LOSS ±0,5% · P&amp;L
          dự báo theo hướng + P&amp;L tiền quy kết từ lệnh đã khớp
          {rangeLabel ? ` · ${rangeLabel}` : ""}
        </CardDescription>
        <CardAction>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 px-2.5"
            onClick={onEvaluate}
            disabled={evaluatePending}
            aria-label="Đánh giá lại toàn bộ quyết định"
          >
            {evaluatePending ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="size-3.5" aria-hidden="true" />
            )}
            <span className="hidden sm:inline">Đánh giá ngay</span>
            <span className="sm:hidden">Đánh giá</span>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="pb-0">
        {isLoading ? (
          <div className="flex flex-col gap-2 px-6 pb-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : !stats || stats.total === 0 ? (
          <div className="px-6 pb-6 text-sm text-muted-foreground">
            <strong>Sổ chưa có hàng nào.</strong> Chạy chu kỳ agents để sinh
            tín hiệu rồi bấm “Đánh giá ngay” (hoặc chờ job 16:45 ICT) — mọi
            quyết định trong 90 ngày đều được đánh giá.
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 px-4 pb-3 sm:px-6">
              <Badge variant="outline" className="gap-1">
                <Scale className="size-3" aria-hidden="true" />
                {stats.total} quyết định
              </Badge>
              <Badge variant="outline" className={verdictClass("WIN")}>
                LỢI {stats.WIN}
              </Badge>
              <Badge variant="outline" className={verdictClass("LOSS")}>
                TỔN THẤT {stats.LOSS}
              </Badge>
              <Badge variant="outline" className={verdictClass("NEUTRAL")}>
                ĐI NGANG {stats.NEUTRAL}
              </Badge>
              <Badge variant="outline">
                tỷ đúng {stats.winRate != null ? `${Math.round(stats.winRate * 100)}%` : "—"}
              </Badge>
              <Badge variant="outline">thực thi {stats.executed}/{stats.total}</Badge>
              <span className={cn("text-sm font-semibold tabular-nums", changeColor(stats.totalCashPnlVND))}>
                Σ P&amp;L quy kết: {formatVndCompact(stats.totalCashPnlVND)}
              </span>
            </div>
            <div className="max-h-96 divide-y divide-border/60 overflow-y-auto custom-scrollbar">
              {rows.map((r) => (
                <DecisionLedgerRow key={r.id} row={r} />
              ))}
            </div>
            <p className="px-4 pb-4 pt-3 text-[11px] leading-relaxed text-muted-foreground sm:px-6">
              Ngưỡng phán quyết ±0,5% (khớp bandit #87) · tín hiệu BÁN thực thi
              đánh giá bằng VWAP bán so giá quyết định (chi phí vốn thuộc tín
              hiệu MUA trước) · engine chạy lại 16:45 ICT hằng ngày.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/* ─────────────────── Card 3: Thí nghiệm phân bổ ─────────────────── */

function WeightChips({
  weights,
}: {
  weights: Array<{ basket: string; weight: number }>;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {weights
        .filter((w) => w.weight > 0)
        .map((w) => (
          <span
            key={w.basket}
            className="rounded-full border bg-muted/40 px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground"
          >
            {BASKET_SHORT[w.basket] ?? w.basket} {w.weight}%
          </span>
        ))}
    </div>
  );
}

function ExperimentRow({
  exp,
  onStop,
  stopPending,
}: {
  exp: CouncilExperimentView;
  onStop: (id: string) => void;
  stopPending: boolean;
}) {
  const running = exp.status === "RUNNING";
  const ret = running ? (exp.latest?.returnPct ?? 0) : (exp.result?.returnPct ?? null);
  return (
    <div className="flex flex-col gap-2 px-4 py-3 sm:px-6">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{exp.name}</span>
            <Badge
              variant="outline"
              className={
                running
                  ? "border-primary/40 text-primary"
                  : "border-muted-foreground/40 text-muted-foreground"
              }
            >
              {running ? "đang chạy" : exp.status === "DONE" ? "đã đóng" : "đã dừng"}
            </Badge>
            <span className="rounded-full border bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {exp.createdBy === "council"
                ? "hội đồng đề xuất"
                : exp.createdBy === "seed"
                  ? "khởi động (hồi tính)"
                  : "trader tạo"}
            </span>
            {running ? (
              <span className="text-[10px] text-muted-foreground">
                ngày {exp.daysRun}/{exp.horizonDays} · vốn{" "}
                {formatVndCompact(exp.capitalVND)}
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
            {exp.hypothesis}
          </p>
          <div className="mt-1.5">
            <WeightChips weights={exp.weights} />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {exp.snapshots.length >= 2 ? (
            <div className="hidden w-36 sm:block">
              <ReturnSparkline points={exp.snapshots} />
            </div>
          ) : null}
          <div className="flex flex-col items-end">
            <span className="text-[10px] text-muted-foreground">
              {running ? "tới nay" : "kết quả"}
            </span>
            <span className={cn("text-base font-semibold tabular-nums", changeColor(ret))}>
              {formatPct(ret)}
            </span>
            {!running && exp.result ? (
              <span className="text-[10px] text-muted-foreground">
                maxDD {exp.result.maxDrawdownPct != null ? `${exp.result.maxDrawdownPct.toFixed(2).replace(".", ",")}%` : "—"}
                {" · "}
                Sharpe {exp.result.sharpe ?? "—"}
              </span>
            ) : null}
          </div>
          {running ? (
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2.5"
              onClick={() => onStop(exp.id)}
              disabled={stopPending}
              aria-label={`Dừng thí nghiệm ${exp.name}`}
            >
              <Square className="size-3.5" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </div>
      {!running && exp.result?.lesson ? (
        <p className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-[11px] leading-relaxed">
          <strong className="text-primary">Bài học:</strong> {exp.result.lesson}
        </p>
      ) : null}
      {!running && exp.result?.perBasket && exp.result.perBasket.length > 0 ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 px-1 text-[11px] text-muted-foreground">
          {exp.result.perBasket
            .filter((b) => b.weight > 0)
            .map((b) => (
              <span key={b.basket} className="tabular-nums">
                {BASKET_SHORT[b.basket] ?? b.basket} đóng góp{" "}
                <span className={changeColor(b.contributionPct)}>
                  {formatPct(b.contributionPct)}
                </span>
              </span>
            ))}
        </div>
      ) : null}
    </div>
  );
}

function CreateExperimentDialog({
  open,
  onOpenChange,
  onCreate,
  pending,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreate: (input: {
    name: string;
    hypothesis: string;
    weights: Array<{ basket: string; weight: number }>;
    capitalVND: number;
    horizonDays: number;
  }) => void;
  pending: boolean;
}) {
  const [name, setName] = React.useState("");
  const [hypothesis, setHypothesis] = React.useState("");
  const [horizon, setHorizon] = React.useState(30);
  const [capitalM, setCapitalM] = React.useState(100);
  const [weights, setWeights] = React.useState<Record<string, number>>({
    VN_EQUITY: 40,
    INTL_EQUITY: 15,
    BOND: 15,
    FOREX: 10,
    COMMODITY: 20,
  });
  const basketKeys = ["VN_EQUITY", "INTL_EQUITY", "BOND", "FOREX", "COMMODITY"];
  const total = basketKeys.reduce((a, k) => a + (weights[k] || 0), 0);
  const valid = total >= 95 && total <= 105;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Tạo thí nghiệm phân bổ</DialogTitle>
          <DialogDescription>
            Danh mục giấy độc lập — engine đánh giá mark-to-market 16:35 ICT
            hằng ngày theo chỉ số 5 rổ (constant-mix). Không đặt lệnh thật.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="exp-name">Tên thí nghiệm</Label>
            <Input
              id="exp-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="VD: Nghiên cứu 60-40 cổ phiếu–trái phiếu"
              maxLength={120}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="exp-hypo">Giả thuyết cần kiểm chứng</Label>
            <Textarea
              id="exp-hypo"
              value={hypothesis}
              onChange={(e) => setHypothesis(e.target.value)}
              placeholder="VD: Trong môi trường lãi suất cao, tăng tỷ trọng trái phiếu giảm biên độ mà giữ lợi suất?"
              rows={3}
              maxLength={600}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="exp-capital">Vốn (triệu ₫)</Label>
              <Input
                id="exp-capital"
                type="number"
                min={1}
                max={10_000}
                value={capitalM}
                onChange={(e) => setCapitalM(Number(e.target.value) || 0)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="exp-horizon">Horizon (ngày 7–90)</Label>
              <Input
                id="exp-horizon"
                type="number"
                min={7}
                max={90}
                value={horizon}
                onChange={(e) => setHorizon(Number(e.target.value) || 0)}
              />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label>Trọng số 5 rổ (%)</Label>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {basketKeys.map((k) => (
                <div key={k} className="flex flex-col gap-1">
                  <span className="text-[10px] text-muted-foreground">
                    {BASKET_SHORT[k]}
                  </span>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={weights[k] ?? 0}
                    onChange={(e) =>
                      setWeights((prev) => ({
                        ...prev,
                        [k]: Math.max(0, Math.min(100, Number(e.target.value) || 0)),
                      }))
                    }
                    aria-label={`Trọng số rổ ${BASKET_SHORT[k]}`}
                  />
                </div>
              ))}
            </div>
            <p
              className={cn(
                "text-[11px] tabular-nums",
                valid ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400"
              )}
            >
              Tổng: {total}% — phải nằm trong [95, 105] (tự chuẩn hoá về 100).
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Huỷ
          </Button>
          <Button
            onClick={() => {
              onCreate({
                name,
                hypothesis,
                weights: basketKeys.map((k) => ({
                  basket: k,
                  weight: weights[k] || 0,
                })),
                capitalVND: capitalM * 1_000_000,
                horizonDays: horizon,
              });
            }}
            disabled={
              pending || !valid || name.trim().length < 3 || hypothesis.trim().length < 10
            }
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : null}
            Tạo thí nghiệm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ExperimentsCard({
  experiments,
  isLoading,
  onSession,
  sessionPending,
  onMark,
  markPending,
  onCreate,
  createPending,
  onStop,
  stopPending,
  rangeLabel,
}: {
  experiments:
    | { running: CouncilExperimentView[]; closed: CouncilExperimentView[] }
    | undefined;
  isLoading: boolean;
  onSession: () => void;
  sessionPending: boolean;
  onMark: () => void;
  markPending: boolean;
  onCreate: (input: {
    name: string;
    hypothesis: string;
    weights: Array<{ basket: string; weight: number }>;
    capitalVND: number;
    horizonDays: number;
  }) => void;
  createPending: boolean;
  onStop: (id: string) => void;
  stopPending: boolean;
  rangeLabel: string | null;
}) {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const running = experiments?.running ?? [];
  const closed = experiments?.closed ?? [];
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FlaskConical className="size-4 text-primary" aria-hidden="true" />
          Thí nghiệm phân bổ đa rổ — việc của Hội đồng
        </CardTitle>
        <CardDescription>
          Hội đồng tự nghiên cứu “bao nhiêu phần bỏ vào rổ nào”: hội nghị LLM
          Chủ nhật 05:50 đề xuất → engine đánh giá hằng ngày → kết quả + bài
          học quay lại prompt Chủ tịch
          {rangeLabel ? ` · ${rangeLabel}` : ""}
        </CardDescription>
        <CardAction>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 px-2.5"
              onClick={onSession}
              disabled={sessionPending}
              aria-label="Họp Hội đồng phân bổ ngay (LLM ~25 giây)"
            >
              {sessionPending ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Users className="size-3.5" aria-hidden="true" />
              )}
              <span className="hidden sm:inline">Họp Hội đồng</span>
              <span className="sm:hidden">Họp</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 px-2.5"
              onClick={onMark}
              disabled={markPending}
              aria-label="Đánh giá mark-to-market thí nghiệm ngay"
            >
              {markPending ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw className="size-3.5" aria-hidden="true" />
              )}
              <span className="hidden lg:inline">Đánh giá</span>
            </Button>
            <Button
              size="sm"
              className="h-8 gap-1.5 px-2.5"
              onClick={() => setDialogOpen(true)}
              aria-label="Tạo thí nghiệm phân bổ thủ công"
            >
              <Plus className="size-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">Tạo thí nghiệm</span>
              <span className="sm:hidden">Tạo</span>
            </Button>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="pb-0">
        {isLoading ? (
          <div className="flex flex-col gap-2 px-6 pb-6">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        ) : running.length + closed.length === 0 ? (
          <div className="px-6 pb-6 text-sm text-muted-foreground">
            <strong>Chưa có thí nghiệm nào.</strong> Bấm “Họp Hội đồng” để
            Chủ tịch đề xuất thí nghiệm đầu tiên từ số liệu 5 rổ — hoặc tạo
            tay qua “Tạo thí nghiệm”.
          </div>
        ) : (
          <div className="max-h-[28rem] divide-y divide-border/60 overflow-y-auto custom-scrollbar">
            {[...running, ...closed].map((exp) => (
              <ExperimentRow
                key={exp.id}
                exp={exp}
                onStop={onStop}
                stopPending={stopPending}
              />
            ))}
          </div>
        )}
        <p className="px-4 pb-4 pt-3 text-[11px] leading-relaxed text-muted-foreground sm:px-6">
          Thí nghiệm là danh mục giấy ĐỘC LẬP (không đụng lệnh sandbox HOSE) —
          đúng chỉ đạo: “đầu tư bao nhiêu, đầu tư thế nào… là việc hội đồng
          phải tự nghiên cứu, học tập, thử nghiệm và thu nhận kết quả”.
        </p>
      </CardContent>
      <CreateExperimentDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreate={(input) => {
          onCreate(input);
          setDialogOpen(false);
        }}
        pending={createPending}
      />
    </Card>
  );
}

/* ─────────────────── Workspace ─────────────────── */

export function CouncilWorkspace() {
  const { rangeQuery, rangeKey, dateRange } = useDateRange();
  const overviewQuery = useCouncilOverview(rangeQuery, rangeKey);
  const evalMutation = useRunDecisionEval();
  const markMutation = useMarkExperiments();
  const sessionMutation = useAllocationSession();
  const createMutation = useCreateExperiment();
  const stopMutation = useStopExperiment();

  const rangeLabel = dateRange
    ? `theo khoảng đã chọn ${dateRange.from} → ${dateRange.to}`
    : null;

  return (
    <section
      role="tabpanel"
      id="workspace-panel-council"
      aria-labelledby="workspace-tab-council"
      className="flex flex-col gap-6"
    >
      <h2 className="sr-only">
        Hội đồng — tài khoản toàn cục · sổ đánh giá quyết định · thí nghiệm phân bổ
      </h2>
      <AccountVisionCard
        account={overviewQuery.data?.account}
        isLoading={overviewQuery.isLoading}
      />
      <DecisionLedgerCard
        data={overviewQuery.data?.decisions}
        isLoading={overviewQuery.isLoading}
        onEvaluate={() => evalMutation.mutate()}
        evaluatePending={evalMutation.isPending}
        rangeLabel={rangeLabel}
      />
      <ExperimentsCard
        experiments={overviewQuery.data?.experiments}
        isLoading={overviewQuery.isLoading}
        onSession={() => sessionMutation.mutate()}
        sessionPending={sessionMutation.isPending}
        onMark={() => markMutation.mutate()}
        markPending={markMutation.isPending}
        onCreate={(input) => createMutation.mutate(input)}
        createPending={createMutation.isPending}
        onStop={(id) => stopMutation.mutate(id)}
        stopPending={stopMutation.isPending}
        rangeLabel={rangeLabel}
      />
    </section>
  );
}
