"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FlaskConical, Loader2, Pause, Play, Plus, RotateCcw, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet, apiPostJson } from "@/lib/api";
import { changeColor, formatDateTime, formatPct, formatSigned, formatVnd } from "@/lib/format";
import type { KSandboxState } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * K1 (#87 — AUTONOMY_BLUEPRINT v1.1 §5.6): khối "Cơ chế thử nghiệm (tiền ảo)"
 * trong workspace Cài đặt.
 *
 * - Chưa kích hoạt: nhập số tiền (placeholder gợi ý 100.000.000 ₫ — §8-Q8
 *   "tôi tự nhập") + validate live (≥ 10 triệu, bội 100.000 ₫) + nút Kích hoạt.
 * - Đã kích hoạt: số dư · equity · lãi/lỗ từ lúc kích hoạt (₫ + %) · số phiên
 *   đã chạy · số lệnh auto · đồ thị equity mini (CashSnapshot k1-daily) ·
 *   Nạp thêm / Tạm dừng / Đặt lại (2 bước xác nhận).
 * - Trạng thái nguồn trung thực: 0 lệnh → "chưa có tín hiệu nào được thực thi".
 *
 * Tách bạch P0: card chỉ đọc/ghi qua /api/k/sandbox (scoped accountType
 * "sandbox") — không bao giờ chạm tài khoản paper.
 */

/** Mirror hằng lib/k-sandbox (server là nguồn validate — client chỉ hiển thị). */
const MIN_ACTIVATE = 10_000_000;
const MIN_TOPUP = 1_000_000;
const STEP = 100_000;

/** "100000000" → "100.000.000" (nhập số không bấm phím chữ). */
function groupDigits(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  return Number(digits).toLocaleString("vi-VN");
}

function parseAmount(raw: string): number {
  const digits = raw.replace(/\D/g, "");
  return digits ? Number(digits) : 0;
}

/** Đồ thị equity mini — SVG polyline thuần (không lib) + tooltip ngày từng điểm. */
function EquitySparkline({
  points,
}: {
  points: { equity: number; createdAt: string }[];
}) {
  if (points.length === 0) return null;
  const w = 560;
  const h = 120;
  const pad = 6;
  const values = points.map((p) => p.equity);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.max(1, Math.abs(max) * 0.001);
  const xy = points.map((p, i) => {
    const x = pad + (i / Math.max(1, points.length - 1)) * (w - 2 * pad);
    const y = h - pad - ((p.equity - min) / span) * (h - 2 * pad);
    return { x, y, ...p };
  });
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
        aria-label={`Đường cong equity tài khoản thử nghiệm — ${points.length} phiên, từ ${formatVnd(
          values[0]
        )} tới ${formatVnd(values[values.length - 1])}`}
        preserveAspectRatio="none"
      >
        <polygon points={area} fill={up ? "rgba(22,163,74,0.10)" : "rgba(220,38,38,0.10)"} />
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
        <span>{formatDateTime(points[0].createdAt)}</span>
        <span>{formatDateTime(points[points.length - 1].createdAt)}</span>
      </div>
    </div>
  );
}

function Tile({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2">
      <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-sm font-semibold tabular-nums">{value}</p>
      {hint ? <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function SandboxCard() {
  const queryClient = useQueryClient();
  const [activateRaw, setActivateRaw] = React.useState("");
  const [topupRaw, setTopupRaw] = React.useState("");
  const [resetArmed, setResetArmed] = React.useState(false);
  const resetArmTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["k-sandbox"],
    queryFn: () => apiGet<KSandboxState>("/api/k/sandbox"),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const mutation = useMutation({
    mutationKey: ["k-sandbox-action"],
    mutationFn: (vars: { action: string; amount?: number }) =>
      apiPostJson<KSandboxState>("/api/k/sandbox", vars),
    onSuccess: (res, vars) => {
      queryClient.setQueryData(["k-sandbox"], res);
      queryClient.invalidateQueries({ queryKey: ["portfolio"] });
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      if (vars.action === "activate") {
        setActivateRaw("");
        toast.success("Đã kích hoạt cơ chế thử nghiệm", {
          description: `Cấp ${formatVnd(res.initialAmount)} tiền ảo — agents sẽ tự thực thi mọi tín hiệu qua cổng đồng thuận B9.`,
        });
      } else if (vars.action === "topup") {
        setTopupRaw("");
        toast.success(`Đã nạp thêm ${formatVnd(vars.amount ?? 0)} tiền ảo`);
      } else if (vars.action === "reset") {
        toast.success("Đã đặt lại tài khoản thử nghiệm", {
          description: "Xoá toàn bộ lệnh/vị thế/đường cong — tổng kết đã ghi vào audit.",
        });
      } else if (vars.action === "pause") {
        toast.success("Đã tạm dừng tự động thực thi", {
          description: "Vị thế cũ giữ nguyên, không tạo lệnh mới cho tới khi tiếp tục lại.",
        });
      } else if (vars.action === "resume") {
        toast.success("Đã tiếp tục tự động thực thi");
      }
    },
    onError: (err) => {
      toast.error("Thao tác thất bại", {
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });

  // Huỷ kích nút reset 2 bước sau 5 giây không bấm xác nhận.
  const armReset = () => {
    if (resetArmTimer.current) clearTimeout(resetArmTimer.current);
    if (resetArmed) {
      setResetArmed(false);
      mutation.mutate({ action: "reset" });
      return;
    }
    setResetArmed(true);
    resetArmTimer.current = setTimeout(() => setResetArmed(false), 5_000);
  };
  React.useEffect(
    () => () => {
      if (resetArmTimer.current) clearTimeout(resetArmTimer.current);
    },
    []
  );

  const activateAmount = parseAmount(activateRaw);
  const activateValid =
    activateAmount >= MIN_ACTIVATE && activateAmount % STEP === 0;
  const topupAmount = parseAmount(topupRaw);
  const topupValid = topupAmount >= MIN_TOPUP && topupAmount % STEP === 0;
  const enabled = data?.enabled ?? false;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <FlaskConical className="size-4 text-muted-foreground" aria-hidden="true" />
          Cơ chế thử nghiệm (tiền ảo)
          {data?.enabled && (
            <Badge variant="outline" className="gap-1 border-primary/40 text-primary">
              {data.paused ? (
                <>
                  <Pause className="size-3" aria-hidden="true" /> Đang tạm dừng
                </>
              ) : (
                <>
                  <Play className="size-3" aria-hidden="true" /> Agents tự giao dịch
                </>
              )}
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          K1 — tài khoản sandbox riêng: agents tự thực thi mọi tín hiệu{" "}
          <span className="font-medium">qua cổng đồng thuận B9</span>, thắng/thua thật trộn vào
          vòng học. Tách bạch tuyệt đối với tài khoản Giấy của trader.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {isLoading ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-lg" />
            ))}
          </div>
        ) : isError ? (
          <div className="flex items-center gap-3">
            <p className="text-sm text-down">
              {error?.message ?? "Không tải được trạng thái K1."}
            </p>
            <Button variant="outline" size="sm" className="min-h-9" onClick={() => void refetch()}>
              Thử lại
            </Button>
          </div>
        ) : !enabled ? (
          /* ── Chưa kích hoạt: nhập tiền + nút Kích hoạt (§8-Q8 tự nhập) ── */
          <div className="flex flex-col gap-3 sm:max-w-md">
            <p className="text-sm text-muted-foreground">
              Nhập số tiền ảo cấp cho agents (tối thiểu {formatVnd(MIN_ACTIVATE)}, bội số{" "}
              {formatVnd(STEP)}):
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative flex-1">
                <Input
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="100.000.000"
                  aria-label="Số tiền ảo kích hoạt (VND)"
                  value={activateRaw}
                  onChange={(e) => setActivateRaw(groupDigits(e.target.value))}
                  className="pr-8 tabular-nums"
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                  ₫
                </span>
              </div>
              <Button
                className="min-h-10 gap-2 sm:w-auto"
                disabled={!activateValid || mutation.isPending}
                onClick={() => mutation.mutate({ action: "activate", amount: activateAmount })}
              >
                {mutation.isPending && mutation.variables?.action === "activate" ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Play className="size-4" aria-hidden="true" />
                )}
                Kích hoạt
              </Button>
            </div>
            {activateRaw && !activateValid && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {activateAmount < MIN_ACTIVATE
                  ? `Tối thiểu ${formatVnd(MIN_ACTIVATE)} ₫.`
                  : `Phải là bội số của ${formatVnd(STEP)} ₫.`}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Gợi ý: {formatVnd(100_000_000)} ₫. Mỗi lệnh auto ~{data?.sizePct ?? 5}% NAV, tối đa{" "}
              {data?.maxBudgetPctPerCycle ?? 10}% NAV mỗi chu kỳ. Kết toán equity 16:30 ICT hằng
              ngày.
            </p>
          </div>
        ) : (
          /* ── Đã kích hoạt: tổng quan + vòng đời tiền ── */
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              <Tile
                label="Tiền mặt"
                value={formatVnd(data?.account?.cash ?? 0)}
                hint={`${data?.account?.accountNumber ?? "SANDBOX-K1"} · thử nghiệm`}
              />
              <Tile
                label="Tổng tài sản"
                value={formatVnd(data?.account?.equity ?? 0)}
                hint={`${data?.account?.openCount ?? 0} vị thế mở`}
              />
              <Tile
                label="Lãi/lỗ từ lúc kích hoạt"
                value={
                  <span className={changeColor(data?.pnlSinceActivation ?? 0)}>
                    {formatSigned(data?.pnlSinceActivation ?? 0)} ₫
                    <span className="ml-1 text-xs">
                      ({formatPct(data?.pnlPctSinceActivation ?? 0)})
                    </span>
                  </span>
                }
                hint={`Vốn ban đầu ${formatVnd(data?.initialAmount ?? 0)}`}
              />
              <Tile
                label="LN chưa thực hiện"
                value={
                  <span className={changeColor(data?.account?.unrealisedPnl ?? 0)}>
                    {formatSigned(data?.account?.unrealisedPnl ?? 0)} ₫
                  </span>
                }
                hint={`Đã thực hiện ${formatSigned(data?.account?.realisedPnlTotal ?? 0)} ₫`}
              />
              <Tile
                label="Phiên đã chạy"
                value={String(data?.sessionsRun ?? 0)}
                hint={
                  data?.lastSettleAt
                    ? `Kết toán gần nhất ${formatDateTime(data.lastSettleAt)}`
                    : "chưa có kết toán 16:30 nào"
                }
              />
              <Tile
                label="Lệnh tự động"
                value={String(data?.autoOrderCount ?? 0)}
                hint={
                  (data?.autoOrderCount ?? 0) === 0
                    ? "chưa có tín hiệu nào được thực thi"
                    : `qua cổng B9 · ${data?.sizePct ?? 5}% NAV/lệnh`
                }
              />
            </div>

            {/* Đường cong equity — CashSnapshot k1-daily (§5.6 mini chart) */}
            {(data?.snapshots.length ?? 0) > 1 ? (
              <EquitySparkline points={data!.snapshots} />
            ) : (
              <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
                Đường cong equity sẽ hiện sau kết toán 16:30 ICT đầu tiên (1 điểm/ngày).
              </p>
            )}

            <Separator />

            {/* Vòng đời tiền: Nạp thêm · Tạm dừng/Tiếp tục · Đặt lại (2 bước) */}
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-1">
                <div className="relative flex-1">
                  <Input
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="Nạp thêm (VD 50.000.000)"
                    aria-label="Số tiền nạp thêm vào tài khoản thử nghiệm (VND)"
                    value={topupRaw}
                    onChange={(e) => setTopupRaw(groupDigits(e.target.value))}
                    className="pr-8 tabular-nums"
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                    ₫
                  </span>
                </div>
                <Button
                  variant="outline"
                  className="min-h-10 gap-2"
                  disabled={!topupValid || mutation.isPending || data?.paused}
                  onClick={() => mutation.mutate({ action: "topup", amount: topupAmount })}
                >
                  {mutation.isPending && mutation.variables?.action === "topup" ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Plus className="size-4" aria-hidden="true" />
                  )}
                  Nạp thêm
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  className="min-h-10 gap-2"
                  disabled={mutation.isPending}
                  onClick={() =>
                    mutation.mutate({ action: data?.paused ? "resume" : "pause" })
                  }
                >
                  {mutation.isPending &&
                  (mutation.variables?.action === "pause" ||
                    mutation.variables?.action === "resume") ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : data?.paused ? (
                    <Play className="size-4" aria-hidden="true" />
                  ) : (
                    <Pause className="size-4" aria-hidden="true" />
                  )}
                  {data?.paused ? "Tiếp tục" : "Tạm dừng"}
                </Button>
                <Button
                  variant={resetArmed ? "destructive" : "outline"}
                  className={cn("min-h-10 gap-2", !resetArmed && "text-down")}
                  disabled={mutation.isPending}
                  onClick={armReset}
                  aria-label={
                    resetArmed
                      ? "Xác nhận xoá toàn bộ lệnh, vị thế và đường cong tài khoản thử nghiệm"
                      : "Đặt lại tài khoản thử nghiệm"
                  }
                >
                  {mutation.isPending && mutation.variables?.action === "reset" ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <RotateCcw className="size-4" aria-hidden="true" />
                  )}
                  {resetArmed ? "Bấm lần nữa để xoá" : "Đặt lại"}
                </Button>
              </div>
            </div>
            {data?.paused && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Đang tạm dừng: chu kỳ sau <span className="font-medium">0 lệnh mới</span>, vị thế
                cũ vẫn giữ và vẫn kết toán equity hằng ngày.
              </p>
            )}
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Wallet className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
              Khoản tiền ảo chỉ dùng nội bộ — không chạm tài khoản giấy VNDIRECT của bạn. Kết thúc
              thử nghiệm: bấm Đặt lại (tổng kết lãi/lỗ được lưu vào audit trước khi xoá).
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
