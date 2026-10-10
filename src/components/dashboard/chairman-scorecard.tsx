"use client";

import { useQuery } from "@tanstack/react-query";
import { Award } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { formatVndCompact } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ChairmanScorecard } from "@/lib/exec/chairman-scorecard";

/**
 * E-P1-4 (EXECUTION_OPS_BLUEPRINT v1.2) — Bảng điểm CHẤT LƯỢNG TÍN HIỆU
 * Chủ tịch (A1): nhãn 5 phiên sau → precision/recall/F1/AUC-PR [ML M1] +
 * RMSE target/stop [ML M2] + calibration LOW/MEDIUM/HIGH → winrate + odds
 * [MATH H6]. Đặt dưới section nhóm executive (Đội Agent) — cùng pattern B8.
 * enoughData=false khi nhãn < 30 [DA D7] — trung thực "chưa đủ dữ liệu".
 */

const pct = (n: number | null) =>
  n == null ? "—" : `${(n * 100).toFixed(1).replace(".", ",")}%`;

function num(n: number | null): string {
  return n == null ? "—" : n.toLocaleString("vi-VN");
}

export function ChairmanScorecardCard() {
  const query = useQuery({
    queryKey: ["exec-chairman-scorecard"],
    queryFn: () => apiGet<ChairmanScorecard>("/api/exec/chairman-scorecard"),
    staleTime: 60_000,
  });

  const sc = query.data;

  return (
    <Card className="gap-4" aria-labelledby="chairman-scorecard-heading">
      <CardHeader>
        <CardTitle
          id="chairman-scorecard-heading"
          className="flex items-center gap-2 text-base"
        >
          <Award className="size-4 text-primary" aria-hidden="true" />
          Bảng điểm Chủ tịch (A1) — chất lượng tín hiệu
        </CardTitle>
        <CardDescription>
          Nhãn 5 phiên sau (target/stop chạm trước, fallback close-5-phiên) →
          precision/recall/F1/AUC-PR + RMSE target + calibration — mô tả, không
          phán xét (E-P1-4)
        </CardDescription>
        {sc && (
          <CardAction>
            <Badge variant="outline" className="tabular-nums">
              {sc.window.days} ngày
            </Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {query.isLoading ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-9 w-full rounded-lg" />
            <Skeleton className="h-24 w-full rounded-lg" />
          </div>
        ) : query.isError ? (
          <p className="text-sm text-down" role="alert">
            {query.error?.message ?? "Không tải được bảng điểm Chủ tịch."}
          </p>
        ) : !sc ? null : (
          <div className="flex flex-col gap-4">
            {/* Tổng quan cohort */}
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="tabular-nums" title="Tín hiệu MUA/BÁN của Chủ tịch trong window">
                Tín hiệu {sc.signals}
              </Badge>
              <Badge variant="secondary" className="tabular-nums" title="Đã chấm được nhãn WIN/LOSS 5 phiên sau">
                Đã chấm {sc.labeled}
              </Badge>
              {sc.pendingLabels > 0 && (
                <Badge variant="outline" className="tabular-nums" title="Tín hiệu chưa đủ 5 bar tương lai — không bịa nhãn">
                  Chưa chấm được {sc.pendingLabels}
                </Badge>
              )}
              <Badge variant="outline" className="tabular-nums">
                MUA {sc.buys} · BÁN {sc.sells}
              </Badge>
              <Badge
                variant="outline"
                className={cn(
                  "tabular-nums",
                  !sc.enoughData && "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                )}
                title="n ≥ 30 nhãn mới đủ độ tin cậy [DA D7]"
              >
                {sc.enoughData ? "Đủ dữ liệu" : "Chưa đủ 30 nhãn"}
              </Badge>
            </div>

            {/* Metrics chính — 4 thẻ nhỏ */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {(
                [
                  { label: "Precision", value: pct(sc.precision), hint: "Tín hiệu MUA có tới mục tiêu [ML M1]" },
                  { label: "Recall", value: pct(sc.recall), hint: "Không bỏ sót cơ hội tăng" },
                  { label: "F1", value: pct(sc.f1), hint: "MUA hiếm hơn HOLD — imbalance" },
                  { label: "AUC-PR", value: pct(sc.aucPr), hint: "Average Precision theo rank score" },
                ] as const
              ).map((m) => (
                <div key={m.label} className="flex flex-col gap-0.5 rounded-lg border p-3">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    {m.label}
                  </span>
                  <span className="tabular-nums text-lg font-semibold">{m.value}</span>
                  <span className="text-[10px] leading-tight text-muted-foreground/80">{m.hint}</span>
                </div>
              ))}
            </div>

            {/* Confusion + RMSE */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span className="tabular-nums" title="Confusion: dự-đoán-tăng = MUA; thực-tăng = giá lên">
                TP {num(sc.confusion.tp)} · FP {num(sc.confusion.fp)} · FN{" "}
                {num(sc.confusion.fn)} · TN {num(sc.confusion.tn)}
              </span>
              <span className="tabular-nums" title="RMSE targetPrice vs high thực 5 phiên [ML M2]">
                RMSE mục tiêu {sc.targetRmse == null ? "—" : `${formatVndCompact(sc.targetRmse)} ₫`}
              </span>
              <span className="tabular-nums" title="RMSE stopLoss vs low thực 5 phiên [ML M2]">
                RMSE cắt lỗ {sc.stopRmse == null ? "—" : `${formatVndCompact(sc.stopRmse)} ₫`}
              </span>
              {/* F-73B-06: minh bạch quy tắc chấm — render điều kiện để an toàn
                  với payload cũ thiếu field (cache react-query). */}
              {sc.ruleCounts ? (
                <span
                  className="tabular-nums"
                  title="Số nhãn theo quy tắc chấm: target/stop chạm trước vs fallback close-5 phiên (F-73B-06)"
                >
                  Chấm theo target/stop: {sc.ruleCounts.targetStop} · close-5: {sc.ruleCounts.close5}
                </span>
              ) : null}
            </div>

            {/* Calibration — bảng winrate + odds theo confidence */}
            <div className="overflow-hidden rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50">
                    <TableHead className="h-9 text-xs">Tin cậy</TableHead>
                    <TableHead className="h-9 text-xs text-right">Số nhãn</TableHead>
                    <TableHead className="h-9 text-xs text-right">Thắng</TableHead>
                    <TableHead className="h-9 text-xs text-right">Winrate</TableHead>
                    <TableHead className="h-9 text-xs text-right">Odds (p/(1−p))</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sc.calibration.map((b) => (
                    <TableRow key={b.confidence}>
                      <TableCell className="py-2 text-xs font-medium">{b.confidence}</TableCell>
                      <TableCell className="py-2 text-right text-xs tabular-nums">{b.n}</TableCell>
                      <TableCell className="py-2 text-right text-xs tabular-nums">{b.wins}</TableCell>
                      <TableCell className="py-2 text-right text-xs tabular-nums">{pct(b.winrate)}</TableCell>
                      <TableCell className="py-2 text-right text-xs tabular-nums">
                        {b.odds == null ? "—" : b.odds.toFixed(2).replace(".", ",")}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <p className="text-[10px] leading-tight text-muted-foreground">
              {sc.note} — calibration ngôn ngữ softmax 3 lớp [DL L3] + odds [MATH H6];
              odds null khi winrate 0%/100% (0/∞ không minh bạch để hiển thị).
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
