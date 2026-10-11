"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowRight,
  FlaskConical,
  Loader2,
  Pause,
  Play,
  Plus,
  Radar,
  RotateCcw,
  Wallet,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet, apiPostJson } from "@/lib/api";
import { useUiStore } from "@/lib/store";
// #91 — đọc trạng thái VNDIRECT thật (dùng chung cache ["settings"] với
// Settings workspace) để ghi chú "đã TỰ ĐỘNG tạm dừng vì VNDIRECT thật kết nối".
import { useSettings } from "@/hooks/use-settings";
import { changeColor, formatDateTime, formatPct, formatSigned, formatVnd } from "@/lib/format";
import type { KSandboxState } from "@/lib/types";

/**
 * K1 (#87 — AUTONOMY_BLUEPRINT v1.1 §5.6): khối "Cơ chế thử nghiệm (tiền ảo)"
 * trong workspace Cài đặt.
 *
 * - Chưa kích hoạt / SAU ĐẶT LẠI (#90): dòng trạng thái "Tiền ảo hiện tại
 *   0 ₫" + nhập số tiền (placeholder gợi ý 100.000.000 ₫ — §8-Q8 "tôi tự
 *   nhập") + validate live (≥ 10 triệu, bội 100.000 ₫) + nút Kích hoạt.
 * - Đã kích hoạt: số dư · equity · lãi/lỗ từ lúc kích hoạt (₫ + %) · số phiên
 *   đã chạy · số lệnh auto · đồ thị equity mini (CashSnapshot k1-daily) ·
 *   ĐẶT LẠI TIỀN MẶT trực tiếp (#90 — không cần reset toàn bộ) · Nạp thêm ·
 *   Tạm dừng · Đặt lại về 0 (Dialog xác nhận — thay nút 2-bấm dễ misunderstood).
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

/** Ô tiền có nhãn + validate live — dùng cho cả Đặt lại tiền mặt & Nạp thêm. */
function MoneyControl({
  id,
  label,
  description,
  placeholder,
  raw,
  onChange,
  valid,
  pending,
  buttonLabel,
  ButtonIcon,
  onConfirm,
  disabled,
  error,
}: {
  id: string;
  label: string;
  description: string;
  placeholder: string;
  raw: string;
  onChange: (v: string) => void;
  valid: boolean;
  pending: boolean;
  buttonLabel: string;
  ButtonIcon: React.ComponentType<{ className?: string }>;
  onConfirm: () => void;
  disabled?: boolean;
  error: string | null;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-muted/10 px-3 py-2.5">
      <Label htmlFor={id} className="text-xs font-medium text-foreground">
        {label}
      </Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Input
            id={id}
            inputMode="numeric"
            autoComplete="off"
            placeholder={placeholder}
            aria-label={`${label} (VND)`}
            value={raw}
            onChange={(e) => onChange(groupDigits(e.target.value))}
            className="pr-8 tabular-nums"
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
            ₫
          </span>
        </div>
        <Button
          variant="outline"
          className="min-h-10 gap-2 sm:w-auto"
          disabled={!valid || pending || disabled}
          onClick={onConfirm}
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <ButtonIcon className="size-4" aria-hidden="true" />
          )}
          {buttonLabel}
        </Button>
      </div>
      {error ? (
        <p className="text-xs text-amber-600 dark:text-amber-400">{error}</p>
      ) : (
        <p className="text-[11px] leading-snug text-muted-foreground">{description}</p>
      )}
    </div>
  );
}

export function SandboxCard() {
  const queryClient = useQueryClient();
  const setActiveWorkspace = useUiStore((s) => s.setActiveWorkspace);
  const setPortfolioWorld = useUiStore((s) => s.setPortfolioWorld);
  // #91 việc 2 — VNDIRECT thật đã cấu hình? (dùng chung cache ["settings"])
  const { data: settingsData } = useSettings();
  const vndirectConfigured = settingsData?.vndirect?.configured === true;
  const [activateRaw, setActivateRaw] = React.useState("");
  const [cashRaw, setCashRaw] = React.useState("");
  const [topupRaw, setTopupRaw] = React.useState("");
  /** #90 — reset qua Dialog xác nhận tường minh (thay nút 2-bấm dễ bỏ sót). */
  const [resetDialogOpen, setResetDialogOpen] = React.useState(false);

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
      } else if (vars.action === "setcash") {
        setCashRaw("");
        toast.success(`Đã đặt tiền mặt = ${formatVnd(vars.amount ?? 0)}`, {
          description:
            "Vòng lãi/lỗ tính lại từ số mới — lệnh, giao dịch và đường cong giữ nguyên.",
        });
      } else if (vars.action === "topup") {
        setTopupRaw("");
        toast.success(`Đã nạp thêm ${formatVnd(vars.amount ?? 0)} tiền ảo`);
      } else if (vars.action === "reset") {
        setResetDialogOpen(false);
        setCashRaw("");
        setTopupRaw("");
        toast.success("Đã đặt lại về 0 — thử nghiệm mới hoàn toàn", {
          description:
            "Toàn bộ lệnh · vị thế · giao dịch · đường cong đã xoá sạch, tiền ảo về 0 ₫. Nhập số vốn mới ngay bên dưới để bắt đầu vòng thử nghiệm kế tiếp.",
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

  const activateAmount = parseAmount(activateRaw);
  const activateValid =
    activateAmount >= MIN_ACTIVATE && activateAmount % STEP === 0;
  const cashAmount = parseAmount(cashRaw);
  const cashValid = cashAmount >= MIN_ACTIVATE && cashAmount % STEP === 0;
  const topupAmount = parseAmount(topupRaw);
  const topupValid = topupAmount >= MIN_TOPUP && topupAmount % STEP === 0;
  const enabled = data?.enabled ?? false;
  const openCount = data?.account?.openCount ?? 0;

  const cashError = cashRaw && !cashValid
    ? cashAmount < MIN_ACTIVATE
      ? `Tối thiểu ${formatVnd(MIN_ACTIVATE)}.`
      : `Phải là bội số của ${formatVnd(STEP)}.`
    : null;
  const topupError = topupRaw && !topupValid
    ? topupAmount < MIN_TOPUP
      ? `Tối thiểu ${formatVnd(MIN_TOPUP)}.`
      : `Phải là bội số của ${formatVnd(STEP)}.`
    : null;

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
          /* ── Chưa kích hoạt / sau Đặt lại về 0: tiền ảo = 0 ₫ + nhập vốn ── */
          <div className="flex flex-col gap-3 sm:max-w-md">
            {/* #90 — dòng trạng thái rõ ràng "đã về 0": đúng cả trường hợp
                chưa từng kích hoạt lẫn vừa bấm Đặt lại về 0 (reset đặt
                cash = 0 và tắt cơ chế). */}
            <div className="flex items-center justify-between rounded-lg border border-dashed px-3 py-2.5">
              <p className="text-xs text-muted-foreground">Tiền ảo hiện tại</p>
              <p className="text-sm font-semibold tabular-nums text-foreground">0 ₫</p>
            </div>
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">Bạn quyết định số vốn</span> — nhập
              số tiền ảo cấp cho agents (tối thiểu {formatVnd(MIN_ACTIVATE)}, bội số{" "}
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
                  ? `Tối thiểu ${formatVnd(MIN_ACTIVATE)}.`
                  : `Phải là bội số của ${formatVnd(STEP)}.`}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Gợi ý: {formatVnd(100_000_000)}. Mỗi lệnh auto ~{data?.sizePct ?? 5}% NAV, tối đa{" "}
              {data?.maxBudgetPctPerCycle ?? 10}% NAV mỗi chu kỳ. Kết toán equity 16:30 ICT hằng
              ngày. Khi bật, Danh mục đầu tư &amp; chip tiền trên thanh bar tự chuyển sang xem
              tiền thử nghiệm; đổi số vốn bất cứ lúc nào bằng ô “Đặt lại tiền mặt” bên dưới —
              không cần đặt lại từ đầu.
            </p>
          </div>
        ) : (
          /* ── Đã kích hoạt: tổng quan + vòng đời tiền ── */
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              <Tile
                label="Tiền mặt"
                value={formatVnd(data?.account?.cash ?? 0)}
                hint={`${data?.account?.accountNumber ?? "SANDBOX-K1"} · chỉnh được ở dưới`}
              />
              <Tile
                label="Tổng tài sản"
                value={formatVnd(data?.account?.equity ?? 0)}
                hint={`tiền mặt + giá trị vị thế · ${openCount} vị thế mở`}
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
                hint={
                  (data?.topupTotal ?? 0) > 0
                    ? `Vốn ${formatVnd(data?.initialAmount ?? 0)} + nạp ${formatVnd(data?.topupTotal ?? 0)} (đã trừ nạp)`
                    : `Vốn ban đầu ${formatVnd(data?.initialAmount ?? 0)}`
                }
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

            {/* #90 — VÒNG ĐỜI TIỀN: 2 ô cạnh nhau (lg) — Đặt lại tiền mặt
                (ghi đè tuyệt đối, không cần reset) + Nạp thêm (cộng dồn). */}
            <div className="grid gap-3 lg:grid-cols-2">
              <MoneyControl
                id="sandbox-setcash"
                label="Đặt lại tiền mặt (ghi đè)"
                description={
                  openCount > 0
                    ? `Đang có ${openCount} vị thế mở — đóng vị thế hoặc "Đặt lại về 0" trước khi ghi đè.`
                    : "Ghi đè số dư bằng đúng số bạn nhập · vòng lãi/lỗ tính lại từ số mới · lệnh & đường cong giữ nguyên."
                }
                placeholder={`VD ${formatVnd(data?.account?.cash ?? 0)}`}
                raw={cashRaw}
                onChange={setCashRaw}
                valid={cashValid}
                pending={mutation.isPending && mutation.variables?.action === "setcash"}
                buttonLabel="Đặt tiền mặt"
                ButtonIcon={RotateCcw}
                onConfirm={() => mutation.mutate({ action: "setcash", amount: cashAmount })}
                disabled={openCount > 0 || data?.paused}
                error={cashError}
              />
              <MoneyControl
                id="sandbox-topup"
                label="Nạp thêm (cộng dồn)"
                description={`Cộng vào tiền hiện có · tối thiểu ${formatVnd(MIN_TOPUP)} · không đếm là lãi.`}
                placeholder="VD 50.000.000"
                raw={topupRaw}
                onChange={setTopupRaw}
                valid={topupValid}
                pending={mutation.isPending && mutation.variables?.action === "topup"}
                buttonLabel="Nạp thêm"
                ButtonIcon={Plus}
                onConfirm={() => mutation.mutate({ action: "topup", amount: topupAmount })}
                disabled={data?.paused}
                error={topupError}
              />
            </div>

            {/* Tạm dừng · Đặt lại về 0 (Dialog xác nhận — #90) */}
            <div className="flex flex-wrap items-center gap-2">
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
                variant="outline"
                className="min-h-10 gap-2 text-down"
                disabled={mutation.isPending}
                onClick={() => setResetDialogOpen(true)}
                aria-label="Đặt lại tài khoản thử nghiệm về 0"
                title="Về 0 từ đầu: xoá toàn bộ lệnh · vị thế · giao dịch · đường cong, tiền về 0 — sau đó bạn tự nhập số vốn mới"
              >
                <RotateCcw className="size-4" aria-hidden="true" />
                Đặt lại về 0
              </Button>
              <p className="text-xs leading-relaxed text-muted-foreground">
                “Đặt lại tiền mặt” đổi số vốn mà vẫn giữ lịch sử · “Đặt lại về 0” xoá sạch
                vòng thử nghiệm.
              </p>
            </div>
            {data?.paused && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {vndirectConfigured ? (
                  <>
                    <span className="font-medium">Đã TỰ ĐỘNG tạm dừng</span> vì VNDIRECT thật đã
                    được kết nối (lưu cấu hình trong Cài đặt) — dừng lệnh mới, vị thế cũ vẫn giữ
                    và vẫn kết toán equity hằng ngày. Muốn chạy tiếp vòng thử nghiệm: bấm
                    “Tiếp tục” bên cạnh (tự chịu trách nhiệm).
                  </>
                ) : (
                  <>
                    Đang tạm dừng: chu kỳ sau{" "}
                    <span className="font-medium">0 lệnh mới</span>, vị thế cũ vẫn giữ và vẫn
                    kết toán equity hằng ngày. Ô Đặt lại tiền mặt / Nạp thêm tạm khoá tới khi
                    tiếp tục lại.
                  </>
                )}
              </p>
            )}

            {/* #88 — điều hướng chéo: tiền ở đây, lệnh/giao dịch ở Danh mục,
                quyết định (tín hiệu) ở tab Tín hiệu. */}
            <div className="flex flex-col gap-2 rounded-lg border border-dashed px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-muted-foreground">
                Thông tin đầy đủ của thử nghiệm nằm ở 3 nơi:
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="min-h-9 gap-1.5 text-xs"
                  onClick={() => {
                    setPortfolioWorld("sandbox");
                    setActiveWorkspace("portfolio");
                  }}
                >
                  <FlaskConical className="size-3.5" aria-hidden="true" />
                  Lệnh &amp; giao dịch
                  <ArrowRight className="size-3" aria-hidden="true" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="min-h-9 gap-1.5 text-xs"
                  onClick={() => setActiveWorkspace("signals")}
                >
                  <Radar className="size-3.5" aria-hidden="true" />
                  Quyết định (tín hiệu)
                  <ArrowRight className="size-3" aria-hidden="true" />
                </Button>
              </div>
            </div>
            <ul className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-3">
              <li className="flex items-start gap-1.5">
                <span className="mt-0.5 shrink-0 font-semibold text-foreground">Tiền:</span>
                ở đây (sửa/nạp/đặt lại) + hiển thị chính tại Danh mục đầu tư &amp; chip tiền
                thanh bar trên cùng.
              </li>
              <li className="flex items-start gap-1.5">
                <span className="mt-0.5 shrink-0 font-semibold text-foreground">Lượt giao dịch:</span>
                Danh mục → Thử nghiệm → tab Lệnh / Giao dịch (vị thế cũng ở đó).
              </li>
              <li className="flex items-start gap-1.5">
                <span className="mt-0.5 shrink-0 font-semibold text-foreground">Quyết định:</span>
                Tín hiệu — tín hiệu được agents tự thực thi có badge “Đã thực thi · thử nghiệm”.
              </li>
            </ul>
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Wallet className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
              Khoản tiền ảo chỉ dùng nội bộ — không chạm tài khoản giấy VNDIRECT của bạn. Kết thúc
              thử nghiệm: bấm Đặt lại về 0 (tổng kết lãi/lỗ được lưu vào audit trước khi xoá)
              rồi nhập số vốn mới nếu muốn chạy vòng khác.
            </p>
          </>
        )}
      </CardContent>

      {/* #90 — Dialog xác nhận reset: tường minh thay nút 2-bấm (trader phản
          ánh "bấm đặt lại về 0 nó cũng chẳng về 0" — một lần bấm không đủ &
          dễ hiểu là đã xong). */}
      <Dialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Đặt lại về 0 — xoá toàn bộ vòng thử nghiệm?</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2">
                <p>
                  Tiền ảo về <span className="font-semibold text-foreground">0 ₫</span>, cơ chế
                  thử nghiệm tắt. Xoá sạch của{" "}
                  <span className="font-medium">chỉ tài khoản thử nghiệm</span>:
                </p>
                <ul className="ml-4 list-disc space-y-0.5">
                  <li>{data?.autoOrderCount ?? 0} lệnh tự động</li>
                  <li>{openCount} vị thế mở</li>
                  <li>toàn bộ giao dịch đã khớp của vòng hiện tại</li>
                  <li>đường cong equity ({data?.sessionsRun ?? 0} điểm kết toán)</li>
                </ul>
                <p>
                  Tổng kết lãi/lỗ được lưu vào audit trước khi xoá. Tài khoản Giấy của bạn không
                  đổi một đồng. Chỉ muốn đổi số vốn? dùng ô{" "}
                  <span className="font-medium text-foreground">Đặt lại tiền mặt</span> — không
                  cần xoá gì cả.
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetDialogOpen(false)}>
              Huỷ
            </Button>
            <Button
              variant="destructive"
              className="gap-2"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate({ action: "reset" })}
            >
              {mutation.isPending && mutation.variables?.action === "reset" ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <RotateCcw className="size-4" aria-hidden="true" />
              )}
              Xoá hết &amp; về 0
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
