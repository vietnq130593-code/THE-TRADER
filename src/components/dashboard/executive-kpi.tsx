"use client";

import { useQuery } from "@tanstack/react-query";
import { Activity, Sigma, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet } from "@/lib/api";
import { formatVndCompact } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ExecKpi } from "@/lib/exec/kpi";
// E-P1-3: dự báo dòng tiền kèm payload KPI (fail-soft → có thể null).
import type { CashflowForecast } from "@/lib/exec/forecast";

/** Payload /api/exec/kpi — KPI + forecast (E-P1-3 v1.2). */
interface ExecKpiResponse extends ExecKpi {
  forecast: CashflowForecast | null;
}

/**
 * E-P0-5 (EXECUTION_OPS_BLUEPRINT v1.1 §4) — khối KPI vận hành nhóm
 * Điều hành & Thực thi: funnel tín hiệu→duyệt→lệnh→khớp 30 ngày + churn +
 * AOV + phân bố slippage (box plot CSS thuần [DA D5]). §6.5: KPI mô tả,
 * không phán xét — nhãn ghi rõ ngay description.
 */

interface FunnelStep {
  label: string;
  value: number;
  hint: string;
}

function pctLabel(n: number | null): string {
  return n == null ? "—" : `${n.toFixed(1).replace(".", ",")}%`;
}

function FunnelBar({ step, max }: { step: FunnelStep; max: number }) {
  // F-73B-13: value=0 phải vẽ thanh 0 — Math.max(2,…) chỉ dành cho value > 0.
  const ratio = max > 0 && step.value > 0 ? Math.max(2, Math.round((step.value / max) * 100)) : 0;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs font-medium text-muted-foreground">{step.label}</span>
        <span className="tabular-nums text-sm font-semibold">{step.value}</span>
      </div>
      <Progress value={ratio} aria-label={`${step.label}: ${step.value}`} className="h-2" />
      <span className="text-[10px] leading-tight text-muted-foreground/80">{step.hint}</span>
    </div>
  );
}

/** E-P1-3 — dải dự báo dòng tiền kịch bản {none, half, allApprove} + CI 95%.
 *  Chỉ hiển thị + nhãn "ước tính nội bộ" (§6.4/§6.7 — KHÔNG dùng chặn lệnh). */
function ForecastStrip({ f }: { f: CashflowForecast }) {
  const vnd = (n: number) => formatVndCompact(n);
  const name: Record<string, string> = {
    none: "Không duyệt thêm",
    half: "Duyệt một nửa",
    allApprove: "Duyệt tất cả",
  };
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-dashed p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <TrendingUp className="size-3.5 text-primary" aria-hidden="true" />
          Dự báo dòng tiền {f.horizonHours}h tới — 3 kịch bản phê duyệt (ước tính nội bộ)
        </span>
        <Badge variant="outline" className="tabular-nums" title={f.note}>
          {f.history.n} snapshot · {f.baseline}
        </Badge>
      </div>
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
        {f.scenarios.map((s) => (
          <div key={s.name} className="flex min-w-0 flex-1 flex-col">
            <span className="text-[10px] text-muted-foreground">{name[s.name]}</span>
            <span className="tabular-nums text-sm font-semibold">
              {vnd(s.cashAtHorizon)} ₫
            </span>
            <span className="text-[10px] tabular-nums text-muted-foreground/80">
              {s.ci95 ? `CI95 ${vnd(s.ci95.low)} – ${vnd(s.ci95.high)}` : "chưa đủ mẫu CI"}
            </span>
          </div>
        ))}
      </div>
      {!f.enoughData && (
        <p className="text-[10px] text-muted-foreground">
          Chưa đủ 30 mẫu snapshot — độ tin cậy hạn chế [DA D7]. Kịch bản “duyệt một nửa”
          là kịch bản minh bạch, không phải xác suất thật. Không dùng chặn lệnh (§6.4).
        </p>
      )}
    </div>
  );
}

function SlippageBox({ s }: { s: NonNullable<ExecKpi["slippage"]> }) {
  // Quy chiếu [min, max] về 0..100%; khi min == max (toàn 0%) dồn về giữa.
  const span = s.maxPct - s.minPct;
  const at = (v: number) => (span > 0 ? ((v - s.minPct) / span) * 100 : 50);
  const p25 = at(s.p25Pct);
  const med = at(s.medianPct);
  const p75 = at(s.p75Pct);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>lệch giá khớp vs giá đặt</span>
        <span className="tabular-nums">n={s.n}</span>
      </div>
      <div className="relative h-6" role="img" aria-label={`Phân bố slippage: min ${s.minPct}%, P25 ${s.p25Pct}%, trung vị ${s.medianPct}%, P75 ${s.p75Pct}%, max ${s.maxPct}%`}>
        <div className="absolute left-0 right-0 top-1/2 h-px -translate-y-1/2 bg-border" />
        <div
          className="absolute top-1/2 h-4 w-px -translate-y-1/2 bg-muted-foreground/60"
          style={{ left: `${Math.min(98, Math.max(0, at(s.minPct)))}%` }}
        />
        <div
          className="absolute top-1/2 h-4 w-px -translate-y-1/2 bg-muted-foreground/60"
          style={{ left: `${Math.min(99, Math.max(0, at(s.maxPct)))}%` }}
        />
        <div
          className="absolute top-1/2 h-5 -translate-y-1/2 rounded-sm border border-primary/50 bg-primary/15"
          style={{ left: `${Math.min(90, Math.max(0, p25))}%`, width: `${Math.max(2, p75 - p25)}%` }}
        />
        <div
          className="absolute top-1/2 h-5 w-0.5 -translate-y-1/2 bg-primary"
          style={{ left: `${Math.min(94, Math.max(2, med))}%` }}
        />
      </div>
      <div className="flex justify-between text-[10px] tabular-nums text-muted-foreground">
        <span>{s.minPct.toFixed(2).replace(".", ",")}%</span>
        <span>P25 {s.p25Pct.toFixed(2).replace(".", ",")}%</span>
        <span className="font-semibold text-foreground">
          TB {s.medianPct.toFixed(2).replace(".", ",")}%
        </span>
        <span>P75 {s.p75Pct.toFixed(2).replace(".", ",")}%</span>
        <span>{s.maxPct.toFixed(2).replace(".", ",")}%</span>
      </div>
    </div>
  );
}

export function ExecutiveKpi() {
  const kpiQuery = useQuery({
    queryKey: ["exec-kpi"],
    queryFn: () => apiGet<ExecKpiResponse>("/api/exec/kpi"),
    staleTime: 30_000,
  });

  const kpi = kpiQuery.data;
  const forecast = kpi?.forecast ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="size-4 text-primary" aria-hidden="true" />
          Vận hành nhóm Điều hành &amp; Thực thi
        </CardTitle>
        <CardDescription>
          Funnel 30 ngày: tín hiệu → duyệt → lệnh → khớp · churn · AOV · slippage — KPI mô tả,
          không phán xét (E-P0-5)
        </CardDescription>
        {kpi && (
          <CardAction>
            <Badge variant="outline" className="tabular-nums">
              {kpi.window.days} ngày
            </Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {kpiQuery.isLoading ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-lg" />
            ))}
          </div>
        ) : kpiQuery.isError ? (
          <p className="text-sm text-down" role="alert">
            {kpiQuery.error?.message ?? "Không tải được KPI vận hành."}
          </p>
        ) : !kpi ? null : (
          <div className="flex flex-col gap-5">
            {/* Funnel 4 bước [DA tr1 Conversion] — bước 3/4 neo theo TÍN HIỆU
                (E-P1-2: 1 duyệt TWAP sinh N lệnh con — hint hiển thị số lát thật) */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-4">
              <FunnelBar
                step={{
                  label: "Tín hiệu MUA/BÁN",
                  value: kpi.funnel.signals,
                  hint: `${kpi.funnel.holdCount} tín hiệu GIỮ ngoài funnel`,
                }}
                max={Math.max(1, kpi.funnel.signals)}
              />
              <FunnelBar
                step={{ label: "Trader duyệt", value: kpi.funnel.approved, hint: pctLabel(kpi.approvePct) }}
                max={Math.max(1, kpi.funnel.signals)}
              />
              <FunnelBar
                step={{
                  label: "Lệnh tạo",
                  value: kpi.funnel.approvedWithOrders,
                  hint:
                    kpi.funnel.ordersCreated !== kpi.funnel.approvedWithOrders
                      ? `${kpi.funnel.ordersCreated} lát lệnh (TWAP tách lát)`
                      : "lệnh từ phê duyệt window · plan đi kèm",
                }}
                max={Math.max(1, kpi.funnel.signals)}
              />
              <FunnelBar
                step={{
                  label: "Khớp trọn vẹn",
                  value: kpi.funnel.signalsFullyFilled,
                  hint:
                    kpi.funnel.ordersFilled !== kpi.funnel.signalsFullyFilled
                      ? `${kpi.funnel.ordersFilled}/${kpi.funnel.ordersCreated} lát đã khớp`
                      : pctLabel(kpi.fillPct),
                }}
                max={Math.max(1, kpi.funnel.signals)}
              />
            </div>

            {/* KPI chips: churn · AOV · từ chối [DA tr1 Churn/AOV] */}
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant="outline"
                className={cn(
                  "gap-1 tabular-nums",
                  (kpi.churnPct ?? 0) > 30 && "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                )}
                title="Tỷ lệ tín hiệu hết hạn chưa duyệt (churn)"
              >
                <Sigma className="size-3" aria-hidden="true" />
                Churn {pctLabel(kpi.churnPct)}
              </Badge>
              <Badge variant="outline" className="tabular-nums" title="Giá trị lệnh khớp trung bình">
                AOV {kpi.aovVnd == null ? "—" : formatVndCompact(kpi.aovVnd)}
              </Badge>
              <Badge variant="outline" className="tabular-nums" title="Tín hiệu bị trader từ chối">
                Từ chối {kpi.rejected}
              </Badge>
              {kpi.funnel.ordersOutOfFunnel > 0 ? (
                <Badge
                  variant="outline"
                  className="tabular-nums"
                  title="Lệnh tạo trong window không từ phê duyệt tín hiệu window (thủ công/seed/đường cũ) — không vào funnel, hiển thị minh bạch (F-701-02)"
                >
                  Ngoài phễu {kpi.funnel.ordersOutOfFunnel}
                </Badge>
              ) : null}
              {Object.entries(kpi.signalStatusCounts).map(([status, count]) => (
                <Badge key={status} variant="secondary" className="tabular-nums">
                  {status} {count}
                </Badge>
              ))}
            </div>

            {/* Box plot slippage [DA D5] */}
            {kpi.slippage ? (
              <SlippageBox s={kpi.slippage} />
            ) : (
              <p className="text-xs text-muted-foreground">
                Chưa có lệnh khớp trong window — phân bố slippage hiển thị sau lệnh khớp đầu tiên.
              </p>
            )}

            {/* E-P1-3 — Dự báo dòng tiền kịch bản (kèm KPI card, ước tính nội bộ) */}
            {forecast ? (
              <ForecastStrip f={forecast} />
            ) : (
              <p className="text-xs text-muted-foreground">
                Dự báo dòng tiền chưa sẵn sàng (chuỗi snapshot cash đang tích lũy mỗi chu kỳ A12).
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
