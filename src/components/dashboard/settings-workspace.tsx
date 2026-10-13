"use client";

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CircleCheck,
  CircleX,
  Cpu,
  CalendarClock,
  Bell,
  Database,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Plug,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  useApplyMarketDataMode,
  useSettings,
  useTestConnection,
  useUpdateSettings,
} from "@/hooks/use-settings";
import { cn } from "@/lib/utils";
import { apiGet, apiPost } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { MarketDataMode, SettingsResponse } from "@/lib/types";
// K1 (#87 — AUTONOMY_BLUEPRINT v1.1 §5.6): khối "Cơ chế thử nghiệm (tiền ảo)"
// — query riêng /api/k/sandbox (không phụ thuộc useSettings nên luôn hiển thị).
import { SandboxCard } from "@/components/dashboard/sandbox-card";
// M4.8 (#110 — UIUX_UPGRADE_BLUEPRINT §4): chip số bước 1-2-3 cạnh CardTitle +
// Khối Hội đồng (card cấu hình bổ sung, điều hướng sang module Hội đồng).
import { StepBadge } from "@/components/dashboard/settings/step-badge";
import { CouncilLinkCard } from "@/components/dashboard/settings/council-link-card";

/**
 * Phiên #34 — workspace "Cài đặt": kết nối VNDIRECT (credentials masked),
 * nguồn dữ liệu thị trường (real-eod | realtime-vndirect | simulated) và
 * thông tin mô hình AI & đội agent (read-only).
 *
 * Form là local state (không controlled bởi server); PUT chỉ gửi field
 * người dùng nhập — chuỗi rỗng "" nghĩa là xoá. API /api/settings có thể
 * chưa sẵn sàng (backend song song) — error state + retry, không crash.
 */

/* ─────────────────── Form types ─────────────────── */

interface VndirectForm {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accountNumber: string;
}

const EMPTY_FORM: VndirectForm = {
  consumerKey: "",
  consumerSecret: "",
  accessToken: "",
  accountNumber: "",
};

const FORM_FIELDS: {
  key: keyof VndirectForm;
  label: string;
  secret: boolean;
  autoComplete: string;
  /** M4.8 (#110) — placeholder ví dụ THẬT (không phải mô tả chung chung
   *  “Nhập…”): trader nhìn vào biết ngay định dạng giá trị kỳ vọng. */
  example: string;
}[] = [
  { key: "consumerKey", label: "Consumer Key", secret: true, autoComplete: "off", example: "VD: 0f8k3x9q2r7w5e1n" },
  { key: "consumerSecret", label: "Consumer Secret", secret: true, autoComplete: "off", example: "••••••••••••" },
  { key: "accessToken", label: "Access Token", secret: true, autoComplete: "off", example: "••••••••••••" },
  { key: "accountNumber", label: "Số tài khoản", secret: false, autoComplete: "off", example: "VD0012345" },
];

/** Số % gọn: "40%" / "12,5%". */
function pctFmt(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${n.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%`;
}

/** Nhãn tiếng Việt cho 4 giới hạn CRB-7 (fixbug #52-F5). */
const LIMIT_LABELS: Record<"sector" | "position" | "dd" | "dailyLoss", string> = {
  sector: "P(vi phạm hạn ngành)",
  position: "P(vi phạm hạn vị thế)",
  dd: "P(vi phạm hạn drawdown)",
  dailyLoss: "P(vi phạm hạn lỗ ngày)",
};

/* ─────────────────── Workspace ─────────────────── */

export function SettingsWorkspace() {
  const { data, isLoading, isError, error, refetch } = useSettings();

  return (
    <div
      role="tabpanel"
      id="workspace-panel-settings"
      aria-labelledby="workspace-tab-settings"
      className="flex flex-col gap-6"
    >
      <h2 className="sr-only">Cài đặt hệ thống — kết nối VNDIRECT &amp; nguồn dữ liệu</h2>

      {isLoading ? (
        <SettingsSkeleton />
      ) : isError || !data ? (
        <Card className="gap-4">
          <CardHeader>
            <CardTitle className="text-base">Không tải được cấu hình</CardTitle>
            <CardDescription>
              {error?.message ??
                "API /api/settings chưa phản hồi — backend có thể đang triển khai."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" className="min-h-11 gap-2" onClick={() => void refetch()}>
              <RefreshCw className="size-4" aria-hidden="true" />
              Thử lại
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* M4.8 (#110 — UIUX_UPGRADE_BLUEPRINT §4, hiệu chỉnh v1.1 #107): nhóm
              card theo TRÌNH TỰ HÀNH ĐỘNG — 1 Kết nối → 2 Chạy agent → 3 Thử
              nghiệm (KHÔNG còn bước “Phân bổ”: khoản tiền thử nghiệm sandbox LÀ
              thí nghiệm). Các card còn lại là cấu hình bổ sung: thông báo ·
              lịch nghỉ lễ · hội đồng. */}
          <p className="text-xs leading-relaxed text-muted-foreground">
            Cấu hình theo trình tự hành động: {" "}
            <span className="font-medium text-foreground">1 Kết nối</span> →{" "}
            <span className="font-medium text-foreground">2 Chạy agent</span> →{" "}
            <span className="font-medium text-foreground">3 Thử nghiệm</span> —
            các khối còn lại là cấu hình bổ sung.
          </p>
          <VndirectCard settings={data} />
          <LlmCard settings={data} />
          <MarketDataCard settings={data} />
          <SandboxCard />
          <CouncilLinkCard />
          <NotifyCard settings={data} />
          <CalendarCard settings={data} />
        </>
      )}
    </div>
  );
}

/* ─────────────────── 1. Kết nối VNDIRECT ─────────────────── */

function VndirectCard({ settings }: { settings: SettingsResponse }) {
  const update = useUpdateSettings();
  const test = useTestConnection();
  const queryClient = useQueryClient();

  const [form, setForm] = React.useState<VndirectForm>(EMPTY_FORM);
  const [reveal, setReveal] = React.useState<Record<string, boolean>>({});

  const saved = settings.vndirect;
  const hasTyped = (Object.keys(form) as (keyof VndirectForm)[]).some(
    (k) => form[k].trim() !== ""
  );
  const busy = update.isPending || test.isPending;

  function setField(key: keyof VndirectForm, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  /** Body cho POST test: creds form đang nhập (nếu có), ngược lại rỗng → backend dùng creds đã lưu. */
  function typedCreds(): Partial<VndirectForm> {
    const creds: Partial<VndirectForm> = {};
    for (const k of Object.keys(form) as (keyof VndirectForm)[]) {
      if (form[k].trim() !== "") creds[k] = form[k].trim();
    }
    return creds;
  }

  function handleTest() {
    const creds = typedCreds();
    test.mutate(Object.keys(creds).length > 0 ? creds : null);
  }

  function handleSave() {
    const creds = typedCreds();
    if (Object.keys(creds).length === 0) {
      toast.info("Chưa nhập thông tin nào để lưu", {
        description: "Điền ít nhất một trường rồi bấm Lưu cấu hình.",
      });
      return;
    }
    update.mutate(
      { vndirect: creds },
      {
        onSuccess: (res) => {
          // #91 việc 2 — lưu cấu hình VNDIRECT THẬT: cơ chế thử nghiệm tự
          // dừng phía backend (pause §5.2 + audit K1_SANDBOX_AUTO_PAUSED_FOR_REAL),
          // thế giới Giấy đổi tên Thực tế. Invalidate ["k-sandbox"] +
          // ["portfolio"] để chips/segmented control toàn app cập nhật ngay.
          void queryClient.invalidateQueries({ queryKey: ["k-sandbox"] });
          void queryClient.invalidateQueries({ queryKey: ["portfolio"] });
          if (res.sandboxAutoPaused) {
            toast.success("Đã lưu cấu hình VNDIRECT — kết nối THẬT hoạt động", {
              description:
                "Cơ chế Thử nghiệm đã TỰ ĐỘNG TẠM DỪNG (lệnh mới dừng, vị thế cũ giữ + vẫn kết toán). " +
                "Thế giới Giấy đổi tên thành THỰC TẾ — mọi bài học từ thử nghiệm lẫn thực tế đều có giá trị như nhau.",
              duration: 10_000,
            });
          } else {
            toast.success("Đã lưu cấu hình VNDIRECT", {
              description: `${Object.keys(creds).length} trường được cập nhật (hiển thị đã che).`,
            });
          }
          setForm(EMPTY_FORM);
        },
        onError: (err: Error) => toast.error(err.message || "Không lưu được cấu hình."),
      }
    );
  }

  function handleClear() {
    update.mutate(
      {
        vndirect: {
          consumerKey: "",
          consumerSecret: "",
          accessToken: "",
          accountNumber: "",
        },
      },
      {
        onSuccess: () => {
          toast.success("Đã xoá cấu hình VNDIRECT");
          setForm(EMPTY_FORM);
        },
        onError: (err: Error) => toast.error(err.message || "Không xoá được cấu hình."),
      }
    );
  }

  const testResult = test.data;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <StepBadge n={1} label="Kết nối" />
          <KeyRound className="size-4 text-muted-foreground" aria-hidden="true" />
          Kết nối VNDIRECT
        </CardTitle>
        <CardDescription>
          Nhập thông tin từ VNDIRECT customer portal để bật dữ liệu realtime
          &amp; API khách hàng. Thông tin lưu trong DB, hiển thị đã che (masked).
        </CardDescription>
        {saved.configured && (
          <CardAction>
            <Badge variant="outline" className="border-up/40 text-up">
              Đã cấu hình
            </Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {FORM_FIELDS.map((f) => {
            const masked = saved[f.key];
            return (
              <div key={f.key} className="flex flex-col gap-1.5">
                <Label htmlFor={`vndirect-${f.key}`} className="text-xs">
                  {f.label}
                </Label>
                <div className="relative">
                  <Input
                    id={`vndirect-${f.key}`}
                    type={f.secret && !reveal[f.key] ? "password" : "text"}
                    autoComplete={f.autoComplete}
                    value={form[f.key]}
                    onChange={(e) => setField(f.key, e.target.value)}
                    placeholder={
                      masked ? `Đã lưu: ${masked}` : f.example
                    }
                    className={cn(
                      "min-h-11 pr-10 focus-visible:ring-2 focus-visible:ring-ring/40",
                      f.secret && "font-mono text-sm"
                    )}
                  />
                  {f.secret && (
                    <button
                      type="button"
                      aria-label={
                        reveal[f.key]
                          ? `Ẩn ${f.label}`
                          : `Hiện ${f.label}`
                      }
                      onClick={() =>
                        setReveal((r) => ({ ...r, [f.key]: !r[f.key] }))
                      }
                      className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {reveal[f.key] ? (
                        <EyeOff className="size-4" aria-hidden="true" />
                      ) : (
                        <Eye className="size-4" aria-hidden="true" />
                      )}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Kết quả kiểm tra kết nối */}
        {testResult && (
          <div
            role="status"
            className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3 text-xs"
          >
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
              <span className="flex items-center gap-1.5">
                {testResult.details.authOk ? (
                  <CircleCheck className="size-3.5 text-up" aria-hidden="true" />
                ) : (
                  <CircleX className="size-3.5 text-down" aria-hidden="true" />
                )}
                Auth {testResult.details.authOk ? "OK" : "lỗi"}
              </span>
              <span className="flex items-center gap-1.5">
                {testResult.details.finfoOk ? (
                  <CircleCheck className="size-3.5 text-up" aria-hidden="true" />
                ) : (
                  <CircleX className="size-3.5 text-down" aria-hidden="true" />
                )}
                Finfo {testResult.details.finfoOk ? "OK" : "lỗi"}
              </span>
              <span className="tabular-nums text-muted-foreground">
                Độ trễ {testResult.details.latencyMs.toLocaleString("vi-VN")} ms
              </span>
              {testResult.details.sampleQuote && (
                <Badge variant="outline" className="tabular-nums text-[10px]">
                  {testResult.details.sampleQuote.symbol}{" "}
                  {testResult.details.sampleQuote.last.toLocaleString("vi-VN")} ₫ ·{" "}
                  <span
                    className={cn(
                      testResult.details.sampleQuote.changePct >= 0 ? "text-up" : "text-down"
                    )}
                  >
                    {testResult.details.sampleQuote.changePct >= 0 ? "+" : "−"}
                    {Math.abs(testResult.details.sampleQuote.changePct).toLocaleString("vi-VN", {
                      maximumFractionDigits: 2,
                    })}
                    %
                  </span>
                </Badge>
              )}
            </div>
            {(testResult.details.authMessage || testResult.details.finfoMessage) && (
              <p className="text-muted-foreground">
                {[testResult.details.authMessage, testResult.details.finfoMessage]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            )}
            <p className={cn("font-medium", testResult.ok ? "text-up" : "text-down")}>
              {testResult.message}
            </p>
          </div>
        )}

        {/* Lần test gần nhất từ server */}
        {saved.lastTestAt && !testResult && (
          <p className="text-xs text-muted-foreground">
            Lần kiểm tra gần nhất: {formatDateTime(saved.lastTestAt)} —{" "}
            <span
              className={cn(
                "font-medium",
                saved.lastTestOk ? "text-up" : "text-down"
              )}
            >
              {saved.lastTestOk ? "thành công" : "thất bại"}
            </span>
            {saved.lastTestMessage ? ` · ${saved.lastTestMessage}` : ""}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            onClick={handleTest}
            disabled={busy}
            className="min-h-11 gap-2"
          >
            {test.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Plug className="size-4" aria-hidden="true" />
            )}
            Kiểm tra kết nối
          </Button>
          <Button
            onClick={handleSave}
            disabled={busy}
            className="min-h-11 gap-2"
            title={hasTyped ? "Lưu các trường đã nhập" : "Chưa nhập trường nào"}
          >
            {update.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Save className="size-4" aria-hidden="true" />
            )}
            Lưu cấu hình
          </Button>
          <Button
            variant="outline"
            onClick={handleClear}
            disabled={busy || !saved.configured}
            className="min-h-11 gap-2 border-down/40 text-down hover:bg-down/10 hover:text-down"
            title="Xoá toàn bộ credentials VNDIRECT khỏi DB"
          >
            {update.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Trash2 className="size-4" aria-hidden="true" />
            )}
            Xoá cấu hình
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/* ─────────────────── 2. Nguồn dữ liệu thị trường ─────────────────── */

const MODES: {
  id: MarketDataMode;
  title: string;
  description: string;
}[] = [
  {
    id: "real-eod",
    title: "EOD thật VNDIRECT (dchart)",
    description: "Bar lịch sử giá thật, tick trong phiên mô phỏng quanh mức tham chiếu thật",
  },
  {
    id: "realtime-vndirect",
    title: "Realtime VNDIRECT (finfo)",
    description: "Cần kết nối VNDIRECT phía trên. Tick trong phiên lấy giá thật từ finfo",
  },
  {
    id: "simulated",
    title: "Mô phỏng",
    description: "Toàn bộ giá mô phỏng (dev)",
  },
];

function MarketDataCard({ settings }: { settings: SettingsResponse }) {
  const apply = useApplyMarketDataMode();
  const [selected, setSelected] = React.useState<MarketDataMode | null>(null);

  const md = settings.marketData;
  const effectiveSelected = selected ?? md.mode;
  const fallbackActive = md.effectiveMode !== md.mode;

  function handleApply() {
    if (effectiveSelected === md.mode) return;
    apply.mutate(effectiveSelected);
  }

  function handleRadioKeyDown(e: React.KeyboardEvent, idx: number) {
    // WAI-ARIA radio: mũi tên di chuyển focus + chọn theo focus.
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "ArrowUp" && e.key !== "ArrowDown") {
      return;
    }
    e.preventDefault();
    const next = (idx + (e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1) + MODES.length) % MODES.length;
    setSelected(MODES[next].id);
    document.getElementById(`mode-${MODES[next].id}`)?.focus();
  }

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <StepBadge n={2} label="Chạy agent" />
          <Database className="size-4 text-muted-foreground" aria-hidden="true" />
          Nguồn dữ liệu thị trường
        </CardTitle>
        <CardDescription>
          Chế độ feed giá cho bảng giá, biểu đồ &amp; chỉ báo — ghi đè env MARKET_DATA_MODE
        </CardDescription>
        {fallbackActive && (
          <CardAction>
            <Badge
              variant="outline"
              className="border-amber-500/40 text-amber-600 dark:text-amber-400"
            >
              Đang fallback: EOD thật
            </Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div role="radiogroup" aria-label="Chế độ nguồn dữ liệu thị trường" className="flex flex-col gap-2.5">
          {MODES.map((mode, idx) => {
            const isSelected = effectiveSelected === mode.id;
            const isSaved = md.mode === mode.id;
            return (
              <div key={mode.id} className="flex flex-col gap-1">
                <button
                  type="button"
                  role="radio"
                  id={`mode-${mode.id}`}
                  aria-checked={isSelected}
                  tabIndex={isSelected ? 0 : -1}
                  onClick={() => setSelected(mode.id)}
                  onKeyDown={(e) => handleRadioKeyDown(e, idx)}
                  className={cn(
                    "flex min-h-14 w-full flex-col items-start gap-0.5 rounded-lg border p-3 text-left transition-colors sm:min-h-11 sm:flex-row sm:items-center sm:gap-3",
                    isSelected
                      ? "border-primary bg-primary/5"
                      : "border-border hover:bg-accent"
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-full border",
                        isSelected ? "border-primary" : "border-muted-foreground/50"
                      )}
                      aria-hidden="true"
                    >
                      {isSelected && <span className="size-2 rounded-full bg-primary" />}
                    </span>
                    <span className="text-sm font-medium">{mode.title}</span>
                  </span>
                  <span className="pl-6 text-xs text-muted-foreground sm:pl-0">
                    {mode.description}
                  </span>
                  <span className="ml-auto flex items-center gap-1.5 pl-6 sm:pl-0">
                    {mode.id === "real-eod" && isSaved && (
                      <Badge variant="secondary" className="text-[10px]">
                        Mặc định
                      </Badge>
                    )}
                    {mode.id === "realtime-vndirect" && !settings.vndirect.configured && (
                      <Badge variant="destructive" className="text-[10px]">
                        Chưa kết nối
                      </Badge>
                    )}
                    {mode.id === "realtime-vndirect" &&
                      settings.vndirect.configured &&
                      fallbackActive && (
                        <Badge
                          variant="outline"
                          className="border-amber-500/40 text-[10px] text-amber-600 dark:text-amber-400"
                        >
                          Fallback: EOD thật
                        </Badge>
                      )}
                    {isSaved && <span className="sr-only">(đang dùng)</span>}
                  </span>
                </button>
                {/* Giải thích realtime khi configured nhưng đang fallback */}
                {mode.id === "realtime-vndirect" &&
                  settings.vndirect.configured &&
                  fallbackActive && (
                    <p className="pl-6 text-xs text-muted-foreground sm:pl-7">
                      {md.realtimeOk == null
                        ? "Chưa có lần fetch realtime nào thành công"
                        : md.realtimeOk
                          ? `Lần fetch realtime cuối OK lúc ${formatDateTime(md.lastRealtimeAt)}`
                          : `Lần fetch realtime cuối lỗi lúc ${formatDateTime(md.lastRealtimeAt) ?? "—"} — tick đang dùng bar EOD thật quanh tham chiếu`}{" "}
                      — kiểm tra lại credentials phía trên.
                    </p>
                  )}
              </div>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={handleApply}
            disabled={apply.isPending || effectiveSelected === md.mode}
            className="min-h-11 gap-2"
          >
            {apply.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="size-4" aria-hidden="true" />
            )}
            Áp dụng
          </Button>
          <p className="text-xs text-muted-foreground">
            Hiện đang dùng:{" "}
            <span className="font-medium text-foreground">
              {MODES.find((m) => m.id === md.mode)?.title ?? md.mode}
            </span>
            {fallbackActive && " (fallback EOD thật)"}
          </p>
        </div>

        <Separator />

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
          {md.strictSession && (
            <Badge variant="outline" className="text-[10px]">
              Phiên HOSE 09:15–15:00
            </Badge>
          )}
          <span>Đồng bộ EOD hằng ngày lúc {md.eodSyncAt || "15:45"} ICT</span>
          {md.realtimeOk != null && (
            <span className="flex items-center gap-1.5">
              <span
                className={cn("size-2 rounded-full", md.realtimeOk ? "bg-up" : "bg-down")}
                aria-hidden="true"
              />
              Realtime lần cuối {md.realtimeOk ? "OK" : "lỗi"}
              {md.lastRealtimeAt ? ` lúc ${formatDateTime(md.lastRealtimeAt)}` : ""}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/* ─────────────────── 3. Mô hình AI & đội agent (read-only) ─────────────────── */

function LlmCard({ settings }: { settings: SettingsResponse }) {
  const llm = settings.llm;
  const risk = settings.risk;
  const update = useUpdateSettings();
  // Fixbug #52-F5 — nút reset CRB-7.4: xác nhận 2 bước nội tuyến (không cần
  // AlertDialog) — bấm lần 1 đổi nhãn, lần 2 mới gọi PUT riskQuantReset.
  const [confirmReset, setConfirmReset] = React.useState(false);
  React.useEffect(() => {
    if (!confirmReset) return;
    const t = setTimeout(() => setConfirmReset(false), 6_000);
    return () => clearTimeout(t);
  }, [confirmReset]);

  function handleResetLimits() {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    setConfirmReset(false);
    update.mutate(
      { riskQuantReset: true },
      {
        onSuccess: () => {
          toast.success("Đã đặt lại học giới hạn CRB-7", {
            description:
              "Posterior quay về prior Beta(1,99) — thao tác ghi AuditLog RISK_QUANT_LIMITS_RESET.",
          });
        },
        onError: (err: Error) => {
          toast.error(err.message || "Không đặt lại được học giới hạn CRB-7.");
        },
      }
    );
  }

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <StepBadge n={2} label="Chạy agent" />
          <Cpu className="size-4 text-muted-foreground" aria-hidden="true" />
          Mô hình AI &amp; đội agent
        </CardTitle>
        <CardDescription>
          Đội 23 agent chạy trên model AI đang chọn (nút “Model AI” ở workspace Đội
          Agent — kèm nút Kiểm tra model thật) · nguồn giá ở card trên · thông tin
          runtime chỉ đọc
        </CardDescription>
        {llm.free && (
          <CardAction>
            <Badge variant="outline" className="border-up/40 text-up">
              Miễn phí
            </Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
          <span className="font-medium">{llm.modelLabel}</span>
          <span className="font-mono text-xs text-muted-foreground">{llm.model}</span>
          {llm.runsOutsideSandbox && (
            <Badge variant="secondary" className="text-[10px]">
              Chạy được ngoài sandbox
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          23 agents · 5 nhóm · chu kỳ 6 đợt (nền tảng → nghiên cứu + học máy →
          kiểm soát VETO → Bộ tổng hợp Bayes → chủ tịch → thực thi)
        </p>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-lg border bg-muted/30 p-3">
            <p className="text-[11px] text-muted-foreground">Ngành tối đa</p>
            <p className="tabular-nums text-lg font-semibold">{pctFmt(risk.maxSectorWeightPct)}</p>
          </div>
          <div className="rounded-lg border bg-muted/30 p-3">
            <p className="text-[11px] text-muted-foreground">Vị thế tối đa</p>
            <p className="tabular-nums text-lg font-semibold">{pctFmt(risk.maxPositionPct)}</p>
          </div>
          <div className="rounded-lg border bg-muted/30 p-3">
            <p className="text-[11px] text-muted-foreground">Drawdown tối đa</p>
            <p className="tabular-nums text-lg font-semibold">{pctFmt(risk.maxDrawdownPct)}</p>
          </div>
        </div>

        {/* Fixbug #52-F5 — CRB-7 học giới hạn + nút reset (nghiệm thu CRB-7.4) */}
        <div className="flex flex-col gap-3">
          <div>
            <p className="flex items-center gap-2 text-sm font-medium">
              <ShieldAlert className="size-4 text-muted-foreground" aria-hidden="true" />
              Ủy ban Kiểm soát Định lượng — học giới hạn (CRB-7)
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Beta-Bernoulli học P(vi phạm) từng giới hạn từ chu kỳ thật —
              posterior cao → siết hạn mức động một chiều (sàn 0,75×). Việc nới
              hạn mức chỉ đến từ biến động thấp (CRB-1), learning không bao giờ nới.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {(risk.riskQuantLimits ?? []).map((l) => (
              <div key={l.key} className="rounded-lg border bg-muted/30 p-3">
                <p className="text-[11px] text-muted-foreground">{LIMIT_LABELS[l.key]}</p>
                <p className="tabular-nums text-lg font-semibold">
                  {pctFmt(l.posteriorMean * 100)}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  siết ×{l.mult.toFixed(2).replace(".", ",")} ·{" "}
                  {Math.max(0, l.alpha + l.beta - 100)} chu kỳ quan sát
                </p>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={confirmReset ? "destructive" : "outline"}
              size="sm"
              className="min-h-9 gap-2"
              onClick={handleResetLimits}
              disabled={update.isPending}
            >
              {update.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <RotateCcw className="size-4" aria-hidden="true" />
              )}
              {confirmReset ? "Xác nhận đặt lại?" : "Đặt lại về prior Beta(1,99)"}
            </Button>
            <span className="text-[11px] text-muted-foreground">
              Xoá toàn bộ lịch sử quan sát vi phạm — ghi AuditLog minh bạch.
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span
            className={cn(
              "flex items-center gap-1.5",
              settings.bayes.enabled ? "text-up" : "text-muted-foreground"
            )}
          >
            <span
              className={cn("size-2 rounded-full", settings.bayes.enabled ? "bg-up" : "bg-muted-foreground")}
              aria-hidden="true"
            />
            Bộ tổng hợp Bayes {settings.bayes.enabled ? "bật" : "tắt"}
          </span>
          <span>
            Lần tổng hợp gần nhất:{" "}
            {settings.bayes.lastAssessmentAt
              ? formatDateTime(settings.bayes.lastAssessmentAt)
              : "chưa có"}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

/* ─────────────────── Skeleton ─────────────────── */

function SettingsSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Đang tải cấu hình">
      {Array.from({ length: 3 }).map((_, i) => (
        <Card key={i}>
          <CardHeader>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-72" />
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {i === 0 ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {Array.from({ length: 4 }).map((_, j) => (
                  <div key={j} className="flex flex-col gap-1.5">
                    <Skeleton className="h-3.5 w-24" />
                    <Skeleton className="h-11 w-full" />
                  </div>
                ))}
              </div>
            ) : (
              <>
                {Array.from({ length: 3 }).map((_, j) => (
                  <Skeleton key={j} className="h-14 w-full rounded-lg" />
                ))}
              </>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/* ─────────────────── P2-1 · Kênh thông báo S1 (webhook/email) ─────────────────── */

interface NotifyOutboxRow {
  id: string;
  channel: string;
  target: string;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

/** Trạng thái hộp thư đi trả về GET /api/notify. */
interface NotifyStatusResponse {
  settings: { enabled: boolean; webhookUrl: string; emailTo: string };
  status: { pendingCount: number; sentCount: number; lastSentAt: string | null };
  outbox: NotifyOutboxRow[];
}

/**
 * P2-1 (phiên #62 — blueprint §5): S1 NotificationOfficer phát bản tin chu kỳ
 * qua webhook/email theo pattern PENDING-EGRESS (sandbox chặn egress → bản
 * tin vào hàng đợi NotificationOutbox, tự retry mỗi chu kỳ S1 + nút dưới đây).
 */
function NotifyCard({ settings }: { settings: SettingsResponse }) {
  const update = useUpdateSettings();
  const queryClient = useQueryClient();
  const [webhookUrl, setWebhookUrl] = React.useState(settings.notify.webhookUrl);
  const [emailTo, setEmailTo] = React.useState(settings.notify.emailTo);
  const [enabled, setEnabled] = React.useState(settings.notify.enabled);
  const [retrying, setRetrying] = React.useState(false);

  const outboxQuery = useOutboxQuery(settings.notify);

  function handleSave() {
    update.mutate(
      { notify: { enabled, webhookUrl: webhookUrl.trim(), emailTo: emailTo.trim() } },
      {
        onSuccess: () => {
          toast.success("Đã lưu cấu hình kênh thông báo");
          void queryClient.invalidateQueries({ queryKey: ["settings"] });
          void outboxQuery.refetch();
        },
        onError: (err: Error) => {
          toast.error("Lưu kênh thông báo thất bại", { description: err.message });
        },
      }
    );
  }

  async function handleRetry() {
    setRetrying(true);
    try {
      const res = await apiPost<{ ok: boolean; result: { sent: number; stillPending: number } }>(
        "/api/notify"
      );
      toast.success(
        `Đã thử gửi lại: ${res.result.sent} gửi thành công · ${res.result.stillPending} còn chờ egress`,
        { description: "Sandbox chặn egress — hàng đợi tự phát khi lên máy chủ có egress." }
      );
      void outboxQuery.refetch();
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    } catch (err) {
      toast.error("Quét thử gửi lại thất bại", {
        description: err instanceof Error ? err.message : "Lỗi không xác định",
      });
    } finally {
      setRetrying(false);
    }
  }

  const pending = outboxQuery.data?.status.pendingCount ?? settings.notify.pendingCount;
  const sent = outboxQuery.data?.status.sentCount ?? settings.notify.sentCount;
  const outbox = outboxQuery.data?.outbox ?? [];

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Bell className="size-4 text-primary" aria-hidden="true" />
          Kênh thông báo S1 (webhook / email)
        </CardTitle>
        <CardDescription>
          Bản tin chu kỳ của NotificationOfficer gửi ra ngoài — pattern pending-egress:
          sandbox chặn đầu ra thì bản tin vào hàng đợi, tự phát khi có egress
        </CardDescription>
        <CardAction>
          <div className="flex items-center gap-2">
            <Label htmlFor="notify-enabled" className="text-xs text-muted-foreground">
              {enabled ? "Bật" : "Tắt"}
            </Label>
            <Switch
              id="notify-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label="Bật/tắt kênh thông báo S1"
            />
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="notify-webhook">Webhook URL (POST JSON)</Label>
            <Input
              id="notify-webhook"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder="https://discord.com/api/webhooks/…"
              autoComplete="url"
              inputMode="url"
              className="min-h-11 focus-visible:ring-2 focus-visible:ring-ring/40"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="notify-email">Email người nhận</Label>
            <Input
              id="notify-email"
              value={emailTo}
              onChange={(e) => setEmailTo(e.target.value)}
              placeholder="trader@example.com"
              autoComplete="email"
              inputMode="email"
              className="min-h-11 focus-visible:ring-2 focus-visible:ring-ring/40"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            className="min-h-11 gap-2"
            onClick={handleSave}
            disabled={update.isPending}
          >
            {update.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Save className="size-4" aria-hidden="true" />
            )}
            Lưu kênh
          </Button>
          <Button
            variant="outline"
            className="min-h-11 gap-2"
            onClick={() => void handleRetry()}
            disabled={retrying || pending === 0}
            title={
              pending === 0
                ? "Không có bản tin nào đang chờ — bản tin mới vào hàng đợi mỗi chu kỳ S1"
                : undefined
            }
          >
            {retrying ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="size-4" aria-hidden="true" />
            )}
            Thử gửi lại ({pending})
          </Button>
          <Badge
            variant="outline"
            className={cn(
              "gap-1.5 px-2 py-0.5 text-[10px]",
              pending > 0
                ? "border-amber-500/40 text-amber-600 dark:text-amber-400"
                : "border-up/40 text-up"
            )}
            title="pending-egress: sandbox chặn đầu ra — hàng đợi tự phát mỗi chu kỳ S1 khi lên máy chủ có egress"
          >
            {pending > 0
              ? `${pending} bản tin chờ egress`
              : sent > 0
                ? `${sent} bản tin đã gửi`
                : "chưa có bản tin nào"}
          </Badge>
          {settings.notify.lastSentAt && (
            <span className="text-[11px] text-muted-foreground">
              gửi cuối {formatDateTime(settings.notify.lastSentAt)}
            </span>
          )}
        </div>

        {outbox.length > 0 && (
          <div className="max-h-40 overflow-y-auto overflow-x-auto custom-scrollbar rounded-lg border border-border/60">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-muted/60 text-[10px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">Kênh</th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">Đích</th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">Trạng thái</th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">Thử</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {outbox.slice(0, 12).map((row) => (
                  <tr key={row.id} className="items-center">
                    <td className="whitespace-nowrap px-3 py-1.5 font-medium">{row.channel}</td>
                    <td className="max-w-40 truncate px-3 py-1.5 text-muted-foreground" title={row.target}>
                      {row.target}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5">
                      {row.status === "SENT" ? (
                        <Badge variant="outline" className="border-up/40 px-1.5 py-0 text-[10px] text-up">
                          SENT
                        </Badge>
                      ) : row.status === "PENDING_EGRESS" ? (
                        <Badge
                          variant="outline"
                          className="border-amber-500/40 px-1.5 py-0 text-[10px] text-amber-600 dark:text-amber-400"
                          title={row.lastError ?? "chờ egress"}
                        >
                          CHỜ EGRESS
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="border-red-500/40 px-1.5 py-0 text-[10px] text-red-600 dark:text-red-400" title={row.lastError ?? undefined}>
                          FAILED
                        </Badge>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground">{row.attempts}×</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Đọc outbox P2-1 (GET /api/notify) — refetch khi cấu hình đổi. */
function useOutboxQuery(notify: SettingsResponse["notify"]) {
  return useQuery({
    queryKey: ["notify-outbox", notify.webhookUrl, notify.emailTo, notify.enabled],
    queryFn: () => apiGet<NotifyStatusResponse>("/api/notify"),
    staleTime: 30_000,
    retry: 1,
  });
}

/* ─────────────────── P2-4 · Lịch nghỉ lễ VN (overlay runtime) ─────────────────── */

/**
 * P2-4 (phiên #62 — blueprint §5): lịch giao dịch VN chính thức — lớp tĩnh
 * 2026 (chính thức) + 2027 (ước lượng) trong market-session.ts, overlay
 * runtime AppSetting "vn-holidays" cho ngày lễ đột xuất (quốc tang, nghỉ bù
 * muộn) — A9 dùng đúng lịch này khi kiểm freshness/EOD (hết báo "outage
 * tổng?" giả khi cả sàn nghỉ hợp lệ).
 */
function CalendarCard({ settings }: { settings: SettingsResponse }) {
  const update = useUpdateSettings();
  const queryClient = useQueryClient();
  const [extraText, setExtraText] = React.useState(settings.vnHolidays.extra.join(", "));
  const [removeText, setRemoveText] = React.useState(settings.vnHolidays.remove.join(", "));

  function parseDates(raw: string): string[] {
    return [
      ...new Set(
        raw
          .split(/[,;\s]+/)
          .map((s) => s.trim())
          .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s))
      ),
    ].sort();
  }

  function handleSave() {
    const extra = parseDates(extraText);
    const remove = parseDates(removeText);
    update.mutate(
      { vnHolidays: { extra, remove } },
      {
        onSuccess: () => {
          toast.success("Đã lưu lịch nghỉ lễ tuỳ chỉnh", {
            description: `thêm ${extra.length} ngày · bỏ ${remove.length} ngày — A9 dùng lịch này từ chu kỳ sau`,
          });
          void queryClient.invalidateQueries({ queryKey: ["settings"] });
        },
        onError: (err: Error) => {
          toast.error("Lưu lịch nghỉ lễ thất bại", { description: err.message });
        },
      }
    );
  }

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarClock className="size-4 text-primary" aria-hidden="true" />
          Lịch giao dịch VN — ngày lễ chính thức
        </CardTitle>
        <CardDescription>
          Lớp tĩnh 2026 chính thức + 2027 ước lượng (market-session.ts); khai báo
          runtime ngày nghỉ đột xuất dưới đây — không cần deploy
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {settings.vnHolidays.upcoming.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Sắp tới:</span>
            {settings.vnHolidays.upcoming.map((h) => (
              <Badge
                key={h.date}
                variant="outline"
                title={h.source === "overlay-extra" ? "khai báo runtime" : "lịch tĩnh chính thức"}
                className={cn(
                  "gap-1 px-2 py-0.5 text-[10px]",
                  h.source === "overlay-extra"
                    ? "border-amber-500/40 text-amber-600 dark:text-amber-400"
                    : "border-border/60 text-muted-foreground"
                )}
              >
                {h.date} · {h.name}
              </Badge>
            ))}
          </div>
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="vn-holidays-extra">Ngày nghỉ THÊM (cách nhau bởi dấu phẩy)</Label>
            <Input
              id="vn-holidays-extra"
              value={extraText}
              onChange={(e) => setExtraText(e.target.value)}
              placeholder="2026-10-20, 2026-10-21"
              className="min-h-11 focus-visible:ring-2 focus-visible:ring-ring/40"
            />
            <p className="text-[11px] text-muted-foreground">
              Vd quốc tang / nghỉ bù thông báo muộn — A9 ngừng kiểm EOD những ngày này
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="vn-holidays-remove">Ngày lớp tĩnh coi là lễ nhưng VẪN giao dịch</Label>
            <Input
              id="vn-holidays-remove"
              value={removeText}
              onChange={(e) => setRemoveText(e.target.value)}
              placeholder="2027-02-05"
              className="min-h-11 focus-visible:ring-2 focus-visible:ring-ring/40"
            />
            <p className="text-[11px] text-muted-foreground">
              Bỏ ngày ước lượng sai khi có công bố chính thức
            </p>
          </div>
        </div>
        <div>
          <Button
            variant="outline"
            className="min-h-11 gap-2"
            onClick={handleSave}
            disabled={update.isPending}
          >
            {update.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Save className="size-4" aria-hidden="true" />
            )}
            Lưu lịch tuỳ chỉnh
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
