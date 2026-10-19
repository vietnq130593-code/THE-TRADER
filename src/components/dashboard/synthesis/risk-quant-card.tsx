"use client";

// (Task 144 P2-c) — tách từ synthesis-workspace.tsx (pure move)
// Card 1d (Phiên #51) "Ủy ban Kiểm soát Định lượng (QUANT)": EWMA/VaR/CVaR/MC/
// HHI/CUSUM + Kelly ¼ + cảnh báo & ghi chú minh bạch.

import { Gauge } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatVnd } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { RiskQuantView } from "@/lib/types";
import { ALERT_TONE } from "./constants";
import { nf1, nf2, pct1, pctRaw } from "./helpers";

/* ─────────────────── 1d. Phiên #51 — CRB: Ủy ban Kiểm soát Định lượng ─────────────────── */

function QuantStat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: string;
}) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={cn("tabular-nums text-sm font-semibold", tone ?? "text-foreground")}>
        {value}
      </div>
      {hint ? <div className="text-[11px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

export function RiskQuantCard({ riskQuant }: { riskQuant: RiskQuantView }) {
  const rq = riskQuant;
  const volTone =
    rq.volRatio > 1.33
      ? "text-rose-600 dark:text-rose-400"
      : rq.volRatio < 0.9
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-foreground";
  const loosened = rq.mult > 1 + 1e-9;
  const alerts = rq.alerts ?? [];
  const notes = rq.notes ?? [];

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Gauge className="size-4 text-muted-foreground" aria-hidden="true" />
          Ủy ban Kiểm soát Định lượng (QUANT)
        </CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-2">
          <span>
            EWMA λ=0,94 · HS-VaR/CVaR · MC bootstrap 5.000 path · HHI · CUSUM —
            deterministic, 0 LLM
          </span>
          {rq.proxyMode ? (
            <Badge
              variant="outline"
              className="border-amber-500/50 text-[11px] text-amber-700 dark:text-amber-400"
            >
              Proxy mode — rổ top-10 (danh mục chưa đủ dữ liệu)
            </Badge>
          ) : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* Khối 1 · Biến động + hạn mức động (CRB-1 hai chiều × CRB-7) */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <QuantStat
            label="Biến động EWMA20 (năm hoá)"
            value={pctRaw(rq.volEwmaAnnPct)}
            hint={`× ${nf2.format(rq.volRatio)} mốc bình thường`}
            tone={volTone}
          />
          <QuantStat
            label="Hệ số hạn mức"
            value={`× ${nf2.format(rq.mult)}`}
            hint={loosened ? "Nới +15% trần — INFO alert" : rq.mult <= 0.75 ? "Siết mạnh (vol/learning)" : "Siết vừa"}
            tone={loosened ? "text-emerald-600 dark:text-emerald-400" : rq.mult <= 0.75 ? "text-rose-600 dark:text-rose-400" : undefined}
          />
          <QuantStat
            label="Hạn vị thế động"
            value={pctRaw(rq.dynMaxPositionPct)}
            hint={`tĩnh ${pctRaw(rq.staticMaxPositionPct)}`}
          />
          <QuantStat
            label="Hạn ngành động"
            value={pctRaw(rq.dynMaxSectorPct)}
            hint={`tĩnh ${pctRaw(rq.staticMaxSectorPct)}`}
          />
          <QuantStat
            label="CUSUM downside S"
            value={nf2.format(rq.cusumS)}
            hint={rq.cusumAlarm ? "BÁO ĐỘNG vượt 4σ" : "trong ngưỡng"}
            tone={rq.cusumAlarm ? "text-rose-600 dark:text-rose-400" : undefined}
          />
        </div>

        {/* Khối 2 · Rủi ro đuôi + tập trung (CRB-2/3/4/5) */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <QuantStat
            label="VaR95 5 phiên"
            value={pctRaw(rq.var95Pct, 2)}
            hint={rq.var95Vnd > 0 ? `≈ ${formatVnd(rq.var95Vnd)}` : "rổ proxy"}
          />
          <QuantStat
            label="CVaR95 5 phiên"
            value={pctRaw(rq.cvar95Pct, 2)}
            hint={rq.cvar95Pct > 5 ? "vượt 5% NAV" : rq.cvar95Pct > 3 ? "vượt 3% NAV" : "an toàn"}
            tone={
              rq.cvar95Pct > 5
                ? "text-rose-600 dark:text-rose-400"
                : rq.cvar95Pct > 3
                  ? "text-amber-600 dark:text-amber-400"
                  : undefined
            }
          />
          <QuantStat
            label="MC · P(chạm DD 15%)"
            value={pct1(rq.mcPDd)}
            hint={`lỗ 5% tệ nhất: ${pctRaw(rq.mcLoss5Pct, 2)}`}
            tone={rq.mcPDd >= 0.1 ? "text-rose-600 dark:text-rose-400" : undefined}
          />
          <QuantStat
            label="HHI ngành / vị thế"
            value={`${nf2.format(rq.hhiSector)} / ${nf2.format(rq.hhiPosition)}`}
            hint={`≈ ${nf1.format(rq.effSectors)} ngành hiệu quả${rq.effBets > 0 ? ` · ~${nf1.format(rq.effBets)} cược` : ""}`}
            tone={
              rq.hhiSector > 0.25 || rq.hhiPosition > 0.15
                ? "text-amber-600 dark:text-amber-400"
                : undefined
            }
          />
          <QuantStat
            label="P(vi phạm 5 phiên)"
            value={rq.pBreach5d != null ? pct1(rq.pBreach5d) : "chưa serving"}
            hint={
              rq.pBreach5d != null
                ? rq.pBreach5d > 0.35
                  ? "vượt 35% — bằng chứng Bayes DOWN"
                  : "trong ngưỡng"
                : "AUC < 0,55 — trung thực không dự báo"
            }
            tone={rq.pBreach5d != null && rq.pBreach5d > 0.35 ? "text-amber-600 dark:text-amber-400" : undefined}
          />
        </div>

        {/* Khối 3 · Kelly ¼ (CRB-9 — tham mưu) */}
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2">
          <span className="text-[11px] text-muted-foreground">Kelly ¼ (tham mưu):</span>
          <span className="tabular-nums text-sm font-semibold text-foreground">
            {rq.kellyHint != null ? pct1(rq.kellyHint) : "—"}
          </span>
          <span className="text-[11px] text-muted-foreground">
            gợi ý tỷ trọng tối đa cho tín hiệu chu kỳ (bandit posterior cử tri đồng hướng,
            chặn hạn mức động) — khối lượng lệnh do trader phê duyệt
          </span>
        </div>

        {/* Cảnh báo quant (đã dedupe 24h phía engine) */}
        {alerts.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <div className="text-xs font-medium text-muted-foreground">
              Cảnh báo ({alerts.length})
            </div>
            <ul className="flex max-h-40 flex-col gap-1.5 overflow-y-auto pr-1">
              {alerts.map((a) => (
                <li key={a.code} className="flex items-start gap-2 text-xs">
                  <Badge className={cn("shrink-0 px-1.5 py-0 text-[10px] font-bold", ALERT_TONE[a.severity] ?? "")}>
                    {a.severity}
                  </Badge>
                  <span className="text-muted-foreground">{a.message}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* Ghi chú minh bạch (proxy mode, nguồn chuỗi NAV, sai lệch MC vs HS…) */}
        {notes.length > 0 ? (
          <ul className="flex max-h-24 flex-col gap-1 overflow-y-auto pr-1 text-[11px] text-muted-foreground">
            {notes.map((n, i) => (
              <li key={i}>· {n}</li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
