"use client";

/**
 * ml/gate-block.tsx (#89 — tách từ ml-panel.tsx #81) — khối "Cổng bằng
 * chứng chuỗi (B2)" + trạng thái GRU giọng thứ ba của tab Tổng quan.
 */

import { ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/format";
import type { MlGateStatus, MlGruStatus } from "@/hooks/use-ml";
import { EmptyNote, nf0, nf4 } from "./shared";

export function GateBlock({ gate, gru }: { gate: MlGateStatus | null; gru: MlGruStatus | null }) {
  return (
    <section aria-labelledby="ml-gate-heading" className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <h3
          id="ml-gate-heading"
          className="flex items-center gap-2 text-sm font-semibold"
        >
          <ShieldCheck className="size-4 text-muted-foreground" aria-hidden="true" />
          Cổng bằng chứng chuỗi (B2)
        </h3>
      </div>

      {!gate || !gate.available ? (
        <EmptyNote>
          Cổng chưa đo — {gate && "reason" in gate && gate.reason
            ? gate.reason
            : "chạy scripts/ml-evidence-gate.ts sau khi bản v2-lag16 được huấn luyện"}
          . Mô hình chuỗi (GRU) chỉ mở khi số liệu xác quyết, không mở vì “hay
          để có” (nguyên tắc §1.8).
        </EmptyNote>
      ) : (
        <div className="rounded-lg border bg-muted/20 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            {gate.verdict === "PASS" ? (
              <Badge className="bg-emerald-600/15 text-[10px] font-semibold text-emerald-700 hover:bg-emerald-600/15 dark:text-emerald-400">
                Cổng chuỗi: MỞ
              </Badge>
            ) : (
              <Badge className="bg-rose-600/15 text-[10px] font-semibold text-rose-700 hover:bg-rose-600/15 dark:text-rose-400">
                Cổng chuỗi: CHƯA mở
              </Badge>
            )}
            <span className="text-[11px] tabular-nums text-muted-foreground">
              ΔBrier CI 95% [{nf4.format(gate.deltaBrier.ciLow)}; {nf4.format(gate.deltaBrier.ciHigh)}]
              <span className="mx-1">·</span>
              {gate.newFeaturesSignificant}/6 đặc trưng mới có ý nghĩa
            </span>
            {gate.measuredAt ? (
              <span className="ml-auto text-[11px] text-muted-foreground">
                Đo {formatDateTime(gate.measuredAt)}
              </span>
            ) : null}
          </div>

          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            ΔBrier = Brier(v2-lag16) − Brier(v1-lag10) trên cùng cửa sổ dữ liệu
            (paired bootstrap 1.000×) — âm nghĩa là bộ 16 đặc trưng thắng.{" "}
            {gate.verdict === "PASS"
              ? gate.passedVia === "deltabrier"
                ? "V2 thắng có ý nghĩa thống kê."
                : "Mở nhờ ≥ 3/6 đặc trưng mới mang thông tin."
              : "CI chạm 0 hoặc không đủ đặc trưng mới có ý nghĩa — mặc định an toàn: FAIL."}{" "}
            {gate.swappedServing
              ? "Đã hoán đổi serving sang v2-lag16."
              : "Serving giữ nguyên cho tới khi cổng xử quyết."}
          </p>

          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            Re-đo mỗi quý, hoặc ngay khi có dữ liệu intraday 5-phút (B4 — “không
            phải bây giờ ≠ không bao giờ”).
          </p>
        </div>
      )}

      {/* GRU giọng thứ ba — B3/B4 trung thực */}
      <div className="rounded-lg border border-dashed bg-muted/20 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium">GRU giọng thứ ba (B3)</span>
          {!gru ? (
            <Badge variant="outline" className="shrink-0 text-[10px] text-muted-foreground">
              chưa triển khai — chờ cổng
            </Badge>
          ) : (
            <>
              <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
                v{gru.version}
              </Badge>
              <Badge
                className={cn(
                  "shrink-0 text-[10px]",
                  gru.enabled
                    ? "bg-emerald-600/15 text-emerald-700 hover:bg-emerald-600/15 dark:text-emerald-400"
                    : "bg-amber-500/15 text-amber-700 hover:bg-amber-500/15 dark:text-amber-400"
                )}
              >
                {gru.enabled ? "đang phục vụ (0,5/0,3/0,2)" : "shadow — chưa vào điểm"}
              </Badge>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                shadow {nf0.format(gru.shadowSettled)}/60 phiên
                {gru.gruBrier != null && gru.mlpBrier != null
                  ? ` · Brier GRU ${nf4.format(gru.gruBrier)} vs MLP ${nf4.format(gru.mlpBrier)}`
                  : ""}
                {gru.consecutiveWorse > 0 ? ` · tệ hơn ${gru.consecutiveWorse} phiên liên tiếp` : ""}
              </span>
            </>
          )}
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          Khi được triển khai: GRU-24 (3.179 tham số, window 20 phiên) dự báo
          shadow 60 phiên, chỉ lên giọng thứ ba khi Brier ≤ MLP, kill-switch tự
          hạ khi tệ hơn 5 phiên liên tiếp.
        </p>
      </div>
    </section>
  );
}
