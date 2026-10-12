"use client";

/**
 * src/components/dashboard/council-workspace.tsx — #106/#107
 * COUNCIL_STEWARDSHIP_BLUEPRINT v2.0: module "Hội đồng".
 *
 * Hai card (#107 — bỏ card Thí nghiệm phân bổ E-ALLOC: khoản tiền thử nghiệm
 * sandbox CHÍNH LÀ thí nghiệm — vẽ rắn thêm chân):
 *  (1) TÀI KHOẢN HỘI ĐỒNG — tầm nhìn toàn cục (C-VISION): equity · cash ·
 *      P&L từ lúc kích hoạt · đường cong CashSnapshot k1-daily · VỊ THẾ NHÓM
 *      THEO THỊ TRƯỜNG (CP VN · CP quốc tế · trái phiếu · forex · hàng hoá —
 *      tài sản USD kèm chip quy đổi USD→VND, #107 E-EXEC).
 *  (2) SỔ ĐÁNH GIÁ QUYẾT ĐỊNH (D-LEDGER): mỗi tín hiệu 1 hàng với phán quyết
 *      WIN/LOSS/NEUTRAL ±0,5% + P&L tiền quy kết — "đánh giá toàn cục các
 *      quyết định mua bán lợi ích hay tổn thất".
 *
 * Bộ chọn khoảng thời gian toàn cục #105 lọc sổ quyết định (decidedAt)
 * theo ngày ICT.
 */

import * as React from "react";
import {
  BookOpenCheck,
  Loader2,
  RefreshCw,
  Scale,
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
import { Skeleton } from "@/components/ui/skeleton";
import { useCouncilOverview, useRunDecisionEval } from "@/hooks/use-council";
import { useDateRange } from "@/hooks/use-date-range";
import {
  changeColor,
  formatDateTime,
  formatPct,
  formatUnitPrice,
  formatVnd,
  formatVndCompact,
} from "@/lib/format";
import type { UnitKind } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { DecisionLedgerRowView } from "@/lib/types";

/* ─────────────────── Tiện ích dùng chung ─────────────────── */

/** Nhóm hiển thị vị thế theo thị trường (#107 E-EXEC M4.6 UIUX v1.1). */
const MARKET_GROUP: Record<string, string> = {
  HOSE: "CP Việt Nam",
  HNX: "CP Việt Nam",
  UPCOM: "CP Việt Nam",
  US: "Cổ phiếu quốc tế",
  HK: "Cổ phiếu quốc tế",
  BOND: "Trái phiếu",
  FOREX: "Forex",
  COMMODITY: "Hàng hoá",
};
const MARKET_GROUP_ORDER = [
  "CP Việt Nam",
  "Cổ phiếu quốc tế",
  "Trái phiếu",
  "Forex",
  "Hàng hoá",
];

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
                  <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Giá trị (quy VND)</th>
                  <th className="px-3 py-2 text-right font-medium">Lãi/lỗ</th>
                </tr>
              </thead>
              <tbody>
                {MARKET_GROUP_ORDER.map((group) => {
                  const rows = positions.filter(
                    (p) => (MARKET_GROUP[p.market ?? ""] ?? "CP Việt Nam") === group
                  );
                  if (rows.length === 0) return null;
                  const groupValue = rows.reduce((s, p) => s + (p.marketValue ?? 0), 0);
                  const groupUpnl = rows.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0);
                  const fxRate = rows.find((p) => p.fxRate != null)?.fxRate ?? null;
                  return (
                    <React.Fragment key={group}>
                      <tr className="border-b bg-muted/20">
                        <td colSpan={6} className="px-3 py-1.5 text-[11px] text-muted-foreground">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-foreground">{group}</span>
                            <span className="tabular-nums">{formatVndCompact(groupValue)}</span>
                            <span className={cn("tabular-nums", changeColor(groupUpnl))}>
                              {groupUpnl >= 0 ? "+" : "−"}
                              {formatVndCompact(Math.abs(groupUpnl))}
                            </span>
                            {fxRate != null ? (
                              <Badge variant="outline" className="border-primary/30 text-[10px] text-primary">
                                quy đổi {Math.round(fxRate).toLocaleString("vi-VN")}₫/USD
                              </Badge>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                      {rows.map((p) => {
                        const kind = (p.unitKind ?? "VND") as UnitKind;
                        const cur = p.currency ?? "VND";
                        const isVn = !p.market || ["HOSE", "HNX", "UPCOM"].includes(p.market);
                        return (
                          <tr key={p.symbol} className="border-b last:border-0">
                            <td className="px-3 py-2 font-medium">{p.symbol}</td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {p.quantity.toLocaleString("vi-VN")}
                              {!isVn ? (
                                <span className="ml-1 text-[10px] text-muted-foreground">
                                  {p.unitLabel}
                                </span>
                              ) : null}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {isVn ? formatVndCompact(p.avgPrice) : formatUnitPrice(p.avgPrice, kind, cur)}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {p.lastPrice != null
                                ? isVn
                                  ? formatVndCompact(p.lastPrice)
                                  : formatUnitPrice(p.lastPrice, kind, cur)
                                : "—"}
                            </td>
                            <td className="hidden px-3 py-2 text-right tabular-nums sm:table-cell">
                              {p.marketValue != null ? formatVnd(p.marketValue) : "—"}
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
                        );
                      })}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Không nắm giữ vị thế nào — tiền mặt 100%. Hội đồng có thể đầu tư vào
            CP VN · CP quốc tế · trái phiếu · forex · hàng hoá từ khoản tiền thử
            nghiệm (khối VŨ TRỤ GIAO DỊCH trong prompt Chủ tịch).
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
    market: string;
    currency: string;
    unitKind: string;
    unitLabel: string;
    quantity: number;
    avgPrice: number;
    lastPrice: number | null;
    unrealizedPnl: number | null;
    marketValue: number | null;
    fxRate: number | null;
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

/* ─────────────────── Workspace ─────────────────── */

export function CouncilWorkspace() {
  const { rangeQuery, rangeKey, dateRange } = useDateRange();
  const overviewQuery = useCouncilOverview(rangeQuery, rangeKey);
  const evalMutation = useRunDecisionEval();

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
        Hội đồng — tài khoản toàn cục đa thị trường · sổ đánh giá quyết định
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
    </section>
  );
}
