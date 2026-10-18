"use client";

/**
 * ml/sweep-tab.tsx (C1 #99 · ML_AUTOML_BLUEPRINT §4.5/F9) — tab "Tự động tìm
 * kiếm" (tab 8 của SYNTHESIS_TABS): champion board công khai của sweep
 * AutoML L1 deterministic + cổng 4 điều kiện.
 *
 * VẬN HÀNH THẬT (không phải UI trang trí):
 *  - "Chạy đợt ngay" → POST /api/ml/sweep {force:true} → train tuần tự ≤16
 *    ứng viên (~4 phút) → mọi ứng viên (kể cả thua) lưu hàng MlModel +
 *    logJson trên SweepRun — deterministic nên KHÔNG THỂ "câu" kết quả;
 *    serving chỉ đổi khi champion qua CỔNG 4 ĐIỀU KIỆN (audit ML_SWEEP_SWAP).
 *    KHÔNG có nút "áp dụng ngay" vượt cổng.
 *  - Lưu cấu hình → POST {action:"config"} → AppSetting "ml-sweep" (kill-
 *    switch enabled cho đường ENGINE CN 04:15 ICT + budget/seed/δ/maxParamFactor).
 *  - WS "ml-sweep" (use-realtime.ts) invalidate ["ml-sweep"] + ["ml-status"]
 *    khi engine chạy đợt → bảng tự làm mới.
 */

import * as React from "react";
import { Loader2, Play, Save, Search, ShieldCheck, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  useMlSweep,
  useRunSweepNow,
  useSaveSweepConfig,
  type MlSweepConfig,
  type MlSweepLogRow,
  type MlSweepRun,
} from "@/hooks/use-ml-sweep";
import { EmptyNote, accTone, nf0, nf2, nf4, pct1 } from "./shared";

/* ─────────────────── Helpers ─────────────────── */

/** lossWeights compact: [1, 0,5, 2,5] → "1/0,5/2,5". */
function lossWeightsCompact(lw: [number, number, number] | undefined): string {
  if (!lw || lw.length !== 3) return "—";
  return lw.map((v) => nf2.format(v)).join("/");
}

/** F-18 (#131): arch ĐẦY ĐỦ "in-hidden…-out" (vd 24-24-12-3) — trước đây
 *  bảng rút gọn còn "24-12" làm người đọc tưởng kiến trúc chỉ có 2 con số
 *  mà không biết chiều vào (16 hay 24) — nguyên nhân câu hỏi "24-12 là gì".
 *  Giữ nguyên chuỗi đầy đủ + tooltip diễn giải từng đoạn. */
function archFull(arch: string): string {
  return arch;
}

/** Tooltip diễn giải arch "24-24-12-3" → "24 đặc trưng vào → ẩn 24 → ẩn 12 → 3 đầu ra". */
function archTooltip(arch: string): string {
  const parts = arch.split("-");
  if (parts.length < 3) return arch;
  const inDim = parts[0];
  const outDim = parts[parts.length - 1];
  const hidden = parts.slice(1, -1);
  return `${inDim} đặc trưng vào → ${hidden.length} lớp ẩn (${hidden.join(" → ")}) → ${outDim} đầu ra (Giảm/Đi ngang/Tăng)`;
}

/** Chuỗi activation compact: "relu,tanh" → "r,t". */
function activationsCompact(acts: string[] | undefined): string {
  if (!acts || acts.length === 0) return "—";
  return acts.map((a) => (a === "relu" ? "r" : a === "tanh" ? "t" : "s")).join("");
}

/** Badge trạng thái đợt — done xanh · failed đỏ · running vàng. */
function runStatusBadge(status: string): { label: string; className: string } {
  switch (status) {
    case "done":
      return {
        label: "hoàn tất",
        className: "bg-emerald-600/15 text-emerald-700 dark:text-emerald-400",
      };
    case "failed":
      return { label: "thất bại", className: "bg-rose-600/15 text-rose-700 dark:text-rose-400" };
    default:
      return { label: "đang chạy", className: "bg-amber-500/15 text-amber-700 dark:text-amber-400" };
  }
}

function parseNum(raw: string): number | null {
  const normalized = raw.trim().replace(",", ".");
  if (normalized === "") return null;
  const v = Number(normalized);
  return Number.isFinite(v) ? v : null;
}

/* ─────────────────── Ô nhập cấu hình ─────────────────── */

interface FieldSpec {
  key: "budgetCandidates" | "seed" | "deltaSwap" | "maxParamFactor";
  label: string;
  min: number;
  max: number;
  step: number;
  integer: boolean;
  hint: string;
}

const CONFIG_FIELDS: FieldSpec[] = [
  {
    key: "budgetCandidates",
    label: "Budget ứng viên/đợt",
    min: 1,
    max: 64,
    step: 1,
    integer: true,
    hint: "Coarse 12 trước, refine 4 sau (mặc định 16 ≈ 4 phút/đợt).",
  },
  {
    key: "seed",
    label: "Seed dãy ứng viên",
    min: 0,
    max: 999999999,
    step: 1,
    integer: true,
    hint: "Cùng seed + cùng windowHash ⇒ cùng danh sách, cùng kết quả.",
  },
  {
    key: "deltaSwap",
    label: "δ hoán đổi (valAcc)",
    min: 0,
    max: 0.1,
    step: 0.005,
    integer: false,
    hint: "Điều kiện 1: champion phải vượt serving thêm δ (mặc định 0,01).",
  },
  {
    key: "maxParamFactor",
    label: "Hệ số cap tham số",
    min: 1,
    max: 10,
    step: 0.5,
    integer: false,
    hint: "Điều kiện 3: cap = max(hệ số × tham số serving; nTrain ÷ 15 mẫu/tham số) — dữ liệu lớn đủ chứng minh cho mô hình lớn.",
  },
];

function ConfigField({
  spec,
  value,
  error,
  onChange,
}: {
  spec: FieldSpec;
  value: string;
  error: string | null;
  onChange: (v: string) => void;
}) {
  const id = `sweep-${spec.key}`;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs font-medium">
        {spec.label}
      </Label>
      <Input
        id={id}
        type="number"
        inputMode={spec.integer ? "numeric" : "decimal"}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error != null}
        className={cn("h-9 font-mono text-xs tabular-nums", error && "border-rose-500")}
      />
      {error ? (
        <p className="text-[10px] font-medium text-rose-600 dark:text-rose-400">{error}</p>
      ) : (
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          {spec.hint} <span className="whitespace-nowrap">[{spec.min} – {spec.max}]</span>
        </p>
      )}
    </div>
  );
}

/* ─────────────────── Bảng champion board ─────────────────── */

function ChampionBoard({ run }: { run: MlSweepRun }) {
  const rows: MlSweepLogRow[] = Array.isArray(run.log) ? run.log : [];
  const championIndex = run.champion?.index;
  return (
    <div className="max-h-96 overflow-y-auto overflow-x-auto custom-scrollbar rounded-lg border">
      <table className="w-full text-xs">
        <caption className="sr-only">
          Bảng champion board — toàn bộ ứng viên của đợt sweep gần nhất (kể cả
          thua), điểm score và lỗi nếu có
        </caption>
        <thead className="sticky top-0 bg-muted/95 backdrop-blur">
          <tr className="text-left">
            <th className="px-2 py-2 font-medium">STT</th>
            <th className="px-2 py-2 font-medium" title="Đầy đủ: vào → các lớp ẩn → ra (vd 24-24-12-3 = 24 đặc trưng vào, ẩn 24, ẩn 12, 3 đầu ra)">Kiến trúc</th>
            <th className="px-2 py-2 font-medium">Kích hoạt</th>
            <th className="px-2 py-2 font-medium">Trọng số loss</th>
            <th className="px-2 py-2 text-right font-medium">valAcc</th>
            <th className="px-2 py-2 text-right font-medium">valLoss</th>
            <th className="px-2 py-2 text-right font-medium">Brier</th>
            <th className="px-2 py-2 text-right font-medium">Tham số</th>
            <th className="px-2 py-2 text-right font-medium">Điểm</th>
            <th className="px-2 py-2 text-right font-medium">ms</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const isChampion = row.i === championIndex;
            return (
              <tr
                key={`${run.id}-${row.i}`}
                className={cn(
                  "border-t",
                  isChampion && "bg-emerald-500/10",
                  row.error != null && "text-muted-foreground"
                )}
              >
                <td className="whitespace-nowrap px-2 py-2 font-medium">
                  {row.tag ?? `#${row.i + 1}`}
                  {isChampion && (
                    <Badge className="ml-1 bg-emerald-600/15 px-1.5 text-[9px] text-emerald-700 dark:text-emerald-400">
                      champion
                    </Badge>
                  )}
                </td>
                <td
                  className="whitespace-nowrap px-2 py-2 font-mono text-[10px]"
                  title={row.error != null ? undefined : archTooltip(row.arch)}
                >
                  {row.error != null ? "—" : archFull(row.arch)}
                </td>
                <td className="whitespace-nowrap px-2 py-2 font-mono text-[10px] text-muted-foreground">
                  {activationsCompact(row.activations)}
                </td>
                <td className="whitespace-nowrap px-2 py-2 font-mono text-[10px] tabular-nums text-muted-foreground">
                  {lossWeightsCompact(row.lossWeights)}
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                  {row.error != null ? "—" : pct1(row.valAcc)}
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-muted-foreground">
                  {row.error != null ? "—" : nf2.format(row.valLoss ?? Number.NaN)}
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-muted-foreground">
                  {row.error != null ? "—" : nf4.format(row.brier ?? Number.NaN)}
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-muted-foreground">
                  {row.error != null ? "—" : nf0.format(row.params ?? 0)}
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-right font-semibold tabular-nums">
                  {row.error != null ? "—" : nf2.format(row.score ?? Number.NaN)}
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-muted-foreground">
                  {row.error != null ? (
                    <span
                      className="text-rose-600 dark:text-rose-400"
                      title={row.error}
                      aria-label={`Lỗi ứng viên: ${row.error}`}
                    >
                      {row.error === "budget thời gian" ? "⏱ quá giờ" : "lỗi"}
                    </span>
                  ) : (
                    nf0.format(row.ms ?? 0)
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ─────────────────── Tab ─────────────────── */

export function SweepTab() {
  const sweep = useMlSweep();
  const runNow = useRunSweepNow();
  const saveConfig = useSaveSweepConfig();

  const [values, setValues] = React.useState<Record<string, string>>({});
  const [enabled, setEnabled] = React.useState(true);
  // F-18 (#131): kill-switch đồng bộ champion → tab Mạng thần kinh (ml-tuning).
  const [autoPromote, setAutoPromote] = React.useState(true);
  const lastHydratedAt = React.useRef<string | null>(null);
  /** F-100A-2 (#100-A Fixbug): trader có chỉnh chưa lưu — hydrate không đè. */
  const hasUnsavedEdits = React.useRef(false);

  // Hydrate form từ config (updatedAt/lastRunAt đổi) — KHÔNG đè khi trader đang gõ.
  // F-100A-2: trước đây chỉ chặn re-render cùng `at` — config ĐỔI THẬT giữa chừng
  // (đợt sweep engine chạy xong, hoặc tab khác lưu) vẫn đè mất chữ đang gõ dở;
  // giờ thêm cờ hasUnsavedEdits (reset khi lưu thành công để đồng bộ lại canonical).
  React.useEffect(() => {
    const data = sweep.data;
    if (!data) return;
    const at = data.config.updatedAt ?? data.config.lastRunAt ?? "";
    if (lastHydratedAt.current === at) return;
    if (hasUnsavedEdits.current) return; // tay người đang có chỉnh chưa lưu — giữ
    lastHydratedAt.current = at;
    setValues({
      budgetCandidates: String(data.config.budgetCandidates),
      seed: String(data.config.seed),
      deltaSwap: String(data.config.deltaSwap),
      maxParamFactor: String(data.config.maxParamFactor),
    });
    setEnabled(data.config.enabled);
    setAutoPromote(data.config.autoPromoteTuning !== false); // cũ thiếu trường → ON (mặc định F-18)
  }, [sweep.data]);

  // Lưu xong → cho phép hydrate lại từ config vừa lưu (đồng bộ định dạng chuẩn).
  React.useEffect(() => {
    if (!saveConfig.isSuccess) return;
    hasUnsavedEdits.current = false;
    lastHydratedAt.current = null;
  }, [saveConfig.isSuccess]);

  const serving = sweep.data?.serving ?? null;
  const runs = sweep.data?.runs ?? [];
  const latest = runs[0] ?? null;

  /** Payload cấu hình SỐ đã đổi (so với config đang lưu) + lỗi validate form. */
  const payloadInfo = React.useMemo(() => {
    const errors: string[] = [];
    const payload: Partial<
      Pick<
        MlSweepConfig,
        "enabled" | "autoPromoteTuning" | "budgetCandidates" | "seed" | "deltaSwap" | "maxParamFactor"
      >
    > = {};
    const current: Record<string, number> = {
      budgetCandidates: sweep.data?.config.budgetCandidates ?? 16,
      seed: sweep.data?.config.seed ?? 20261012,
      deltaSwap: sweep.data?.config.deltaSwap ?? 0.01,
      maxParamFactor: sweep.data?.config.maxParamFactor ?? 2,
    };
    for (const spec of CONFIG_FIELDS) {
      const raw = values[spec.key] ?? "";
      const parsed = parseNum(raw);
      if (parsed == null) {
        if (raw.trim() !== "" && raw.trim() !== String(current[spec.key])) {
          errors.push(`${spec.label}: phải là số`);
        }
        continue;
      }
      if (spec.integer && !Number.isInteger(parsed)) {
        errors.push(`${spec.label}: phải là số nguyên`);
        continue;
      }
      if (parsed < spec.min || parsed > spec.max) {
        errors.push(`${spec.label}: ngoài phạm vi [${spec.min} – ${spec.max}]`);
        continue;
      }
      if (parsed !== current[spec.key]) payload[spec.key] = parsed;
    }
    if (enabled !== (sweep.data?.config.enabled ?? true)) payload.enabled = enabled;
    // F-18 (#131): so với config thật (cũ thiếu trường → coi ON như hydrate).
    if (autoPromote !== (sweep.data?.config.autoPromoteTuning !== false)) {
      payload.autoPromoteTuning = autoPromote;
    }
    return { payload, errors, hasChange: Object.keys(payload).length > 0 };
  }, [values, enabled, autoPromote, sweep.data?.config]);

  const dirty = payloadInfo.hasChange && payloadInfo.errors.length === 0;

  /** F-100A-1 (#100-A Fixbug): lỗi từng ô suy trực tiếp từ payloadInfo.errors,
   *  hiển thị NGAY khi gõ sai (viền đỏ + dòng đỏ + aria-invalid). Trước đây
   *  handleSave setFieldErrors bằng LABEL làm khoá ("Budget ứng viên/đợt") trong
   *  khi ô nhập tra theo spec.key ("budgetCandidates") → không bao giờ trúng,
   *  và nút Lưu disabled khiến nhánh đó thành code chết — trader gõ sai chỉ thấy
   *  nút mờ im lặng, không biết sai ở đâu. */
  const fieldErrors = React.useMemo(() => {
    const map: Record<string, string> = {};
    for (const e of payloadInfo.errors) {
      const spec = CONFIG_FIELDS.find((s) => e.startsWith(`${s.label}:`));
      if (spec != null) map[spec.key] = e;
      else map._form = map._form != null ? `${map._form}; ${e}` : e;
    }
    return map;
  }, [payloadInfo.errors]);

  const markEdited = () => {
    hasUnsavedEdits.current = true;
  };

  const handleSave = () => {
    if (payloadInfo.errors.length > 0) return; // đã hiển thị dưới từng ô
    if (!payloadInfo.hasChange) return; // không có gì đổi — nút đã disabled
    saveConfig.mutate(payloadInfo.payload);
  };

  if (sweep.isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (sweep.isError) {
    return (
      <Card className="gap-4">
        <CardHeader>
          <CardTitle className="text-base">Không tải được trạng thái sweep</CardTitle>
          <CardDescription>
            {sweep.error instanceof Error
              ? sweep.error.message
              : "API /api/ml/sweep chưa phản hồi — backend có thể đang triển khai."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            className="min-h-11 gap-2"
            onClick={() => void sweep.refetch()}
          >
            Thử lại
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* ── Card 1 · Trạng thái & cấu hình ── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Search className="size-4 text-primary" aria-hidden="true" />
            Trạng thái &amp; cấu hình AutoML L1
          </CardTitle>
          <CardDescription>
            Sweep deterministic chạy Chủ nhật 04:15 ICT (sau retrain A4 04:00) —
            cùng seed + cùng cửa sổ dữ liệu ⇒ cùng kết quả. Kill-switch chỉ tắt
            đường tự động; nút &quot;Chạy đợt ngay&quot; vẫn chạy (cổng 4 điều kiện
            vẫn giữ nguyên).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* Snapshot serving hiện tại */}
          <section aria-label="Bản serving dl-mlp hiện tại" className="flex flex-col gap-2">
            <h4 className="text-sm font-semibold">Bench serving hiện tại</h4>
            {serving ? (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <div className="rounded-lg border bg-muted/30 px-3 py-2">
                  <span className="text-[11px] text-muted-foreground">Phiên bản</span>
                  <p className="font-mono text-lg font-semibold leading-tight">
                    v{serving.version}
                  </p>
                  {/* F-18B (#132) — arch serving từ weights (đối chiếu cùng nguồn
                      sự thật với tab Mạng thần kinh + Tổng quan). */}
                  {serving.archString != null && (
                    <p
                      className="mt-0.5 font-mono text-[11px] font-semibold text-muted-foreground"
                      title={`Kiến trúc ANN bản đang phục vụ: ${serving.archString} — champion chỉ thay thế khi qua cổng 4 điều kiện`}
                    >
                      ANN {serving.archString}
                    </p>
                  )}
                </div>
                <div className="rounded-lg border bg-muted/30 px-3 py-2">
                  <span className="text-[11px] text-muted-foreground">valAcc</span>
                  <p className={cn("text-lg font-semibold leading-tight tabular-nums", accTone(serving.valAcc))}>
                    {pct1(serving.valAcc)}
                  </p>
                </div>
                <div className="rounded-lg border bg-muted/30 px-3 py-2">
                  <span className="text-[11px] text-muted-foreground">Bộ đặc trưng</span>
                  <p className="font-mono text-sm font-semibold leading-tight">
                    {serving.featureSet}
                  </p>
                </div>
                <div className="rounded-lg border bg-muted/30 px-3 py-2">
                  <span className="text-[11px] text-muted-foreground">windowHash</span>
                  <p
                    className="font-mono text-sm font-semibold leading-tight"
                    title={serving.windowHash ?? undefined}
                  >
                    {(serving.windowHash ?? "—").slice(0, 12)}
                    {serving.windowHash ? "…" : ""}
                  </p>
                </div>
              </div>
            ) : (
              <EmptyNote>
                Chưa có bản dl-mlp serving — champion sẽ được so với baseline
                1/3 (valAcc), Brier uniform 0,667 và cap 2 × 5.000 tham số.
              </EmptyNote>
            )}
          </section>

          {/* Form cấu hình */}
          <section aria-label="Cấu hình sweep" className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/20 px-3 py-2.5">
              <div className="flex flex-col gap-0.5">
                <Label htmlFor="sweep-enabled" className="text-xs font-medium">
                  Tự động Chủ nhật 04:15 ICT
                </Label>
                <span className="text-[10px] leading-relaxed text-muted-foreground">
                  Kill-switch từng đợt — tắt thì engine bỏ qua, nút tay vẫn chạy.
                </span>
              </div>
              <Switch
                id="sweep-enabled"
                checked={enabled}
                onCheckedChange={(v) => {
                  markEdited();
                  setEnabled(v);
                }}
                aria-label="Bật/tắt sweep tự động Chủ nhật 04:15 ICT"
              />
            </div>
            {/* F-18 (#131): kill-switch đồng bộ thiết lập champion → tab Mạng thần kinh */}
            <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/20 px-3 py-2.5">
              <div className="flex flex-col gap-0.5">
                <Label htmlFor="sweep-auto-promote" className="text-xs font-medium">
                  Champion tự cập nhật tab Mạng thần kinh
                </Label>
                <span className="text-[10px] leading-relaxed text-muted-foreground">
                  BẬT: champion qua cổng 4 điều kiện &amp; hoán đổi serving → kiến
                  trúc + tinh chỉnh (lr, epoch, batch, seed, bộ đặc trưng) được
                  ghi tự động xuống AppSetting ml-tuning — tab Mạng thần kinh
                  phản ánh ngay, lần train kế tiếp dùng đúng cấu hình champion.
                  TẮT: chỉ hoán đổi trọng số serving, giữ thiết lập trader.
                </span>
              </div>
              <Switch
                id="sweep-auto-promote"
                checked={autoPromote}
                onCheckedChange={(v) => {
                  markEdited();
                  setAutoPromote(v);
                }}
                aria-label="Bật/tắt champion tự động cập nhật thiết lập tab Mạng thần kinh"
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {CONFIG_FIELDS.map((spec) => (
                <ConfigField
                  key={spec.key}
                  spec={spec}
                  value={values[spec.key] ?? ""}
                  error={fieldErrors[spec.key] ?? null}
                  onChange={(v) => {
                    markEdited();
                    setValues((prev) => ({ ...prev, [spec.key]: v }));
                  }}
                />
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="outline"
                className="min-h-11 gap-2"
                onClick={handleSave}
                disabled={!dirty || saveConfig.isPending}
              >
                {saveConfig.isPending ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Save className="size-4" aria-hidden="true" />
                )}
                Lưu cấu hình
              </Button>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Hiệu lực từ đợt kế tiếp — đợt đang chạy (nếu có) dùng cấu hình đã đọc.
              </p>
            </div>
          </section>
        </CardContent>
      </Card>

      {/* ── Card 2 · Nút hành động ── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="size-4 text-primary" aria-hidden="true" />
            Chạy đợt ngay
          </CardTitle>
          <CardDescription>
            Train tuần tự từng ứng viên theo đúng đường huấn luyện thật (~12
            giây/ứng viên — 16 ứng viên ≈ 4 phút). Trong lúc chạy, nút Huấn luyện
            ở tab Học máy sẽ xếp hàng chờ mutex dùng chung (429).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Button
            className="min-h-11 gap-2"
            onClick={() => runNow.mutate()}
            disabled={runNow.isPending}
            aria-label="Chạy đợt sweep ngay"
          >
            {runNow.isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Đang sweep ({sweep.data?.config.budgetCandidates ?? 16} ứng viên)…
              </>
            ) : (
              <>
                <Play className="size-4" aria-hidden="true" />
                Chạy đợt ngay
              </>
            )}
          </Button>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Deterministic — không thể &quot;câu&quot; kết quả: mọi champion vẫn phải qua
            cổng 4 điều kiện trước khi đổi serving; mọi ứng viên (kể cả thua)
            hiện công khai trên bảng dưới đây.
          </p>
        </CardContent>
      </Card>

      {/* ── Card 3 · Champion board — đợt gần nhất ── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
            Champion board — đợt gần nhất
          </CardTitle>
          <CardDescription>
            {latest
              ? `Đợt ${formatDateTime(latest.startedAt)} · ${latest.evaluated}/${latest.candidates} ứng viên · seed ${nf0.format(latest.seed)} · windowHash ${(latest.windowHash ?? "").slice(0, 12)}…`
              : "Bảng xếp hạng công khai toàn bộ ứng viên đã đánh giá."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {latest == null ? (
            <EmptyNote>
              Chưa có đợt sweep nào — đợt đầu tiên tự chạy Chủ nhật 04:15 ICT
              hoặc bấm &quot;Chạy đợt ngay&quot;.
            </EmptyNote>
          ) : (
            <>
              <ChampionBoard run={latest} />
              {latest.champion ? (
                <div
                  className={cn(
                    "flex flex-col gap-1 rounded-lg border px-3 py-2.5 text-[11px] leading-relaxed",
                    latest.champion.swapProposed
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                      : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                  )}
                  role="status"
                >
                  <p className="font-semibold">
                    {latest.champion.tag} ({latest.champion.arch}) — điểm{" "}
                    {nf2.format(latest.champion.score)} · Brier{" "}
                    {nf4.format(latest.champion.brier)} ·{" "}
                    {nf0.format(latest.champion.paramCount)} tham số
                    {latest.champion.deltaBrier
                      ? ` · ΔBrier CI [${nf4.format(latest.champion.deltaBrier.ciLow)}; ${nf4.format(latest.champion.deltaBrier.ciHigh)}]`
                      : ""}
                  </p>
                  <p>
                    {latest.champion.swapProposed
                      ? "ĐÃ HOÁN ĐỔI sang serving — champion qua đủ cổng 4 điều kiện (audit ML_SWEEP_SWAP)."
                      : `Không đổi serving — ${latest.champion.swapReason}`}
                  </p>
                  {/* F-18B (#132): chỉ đường hiển thị kết quả — trả lời câu hỏi
                      “UI hiển thị kết quả tính toán của Champion board ở đâu”. */}
                  <p className="opacity-80">
                    {latest.champion.swapProposed
                      ? "Kết quả đầy đủ của đợt (mọi ứng viên, điểm, Brier, ΔBrier CI) vẫn xem được trên bảng Champion board và Lịch sử bên dưới; tab Mạng thần kinh hiện banner nguồn gốc NAS + sơ đồ serving mới."
                      : "Kết quả tính toán của đợt hiển thị công khai trên bảng Champion board + Lịch sử bên dưới (mọi ứng viên kể cả thua); serving và trình chỉnh sửa tab Mạng thần kinh giữ nguyên cho tới khi có champion qua cổng."}
                  </p>
                  {/* F-18 (#131): trạng thái đồng bộ thiết lập champion → ml-tuning */}
                  {latest.champion.swapProposed && latest.champion.tuningSync != null && (
                    <p className={latest.champion.tuningSync.synced ? "" : "opacity-80"}>
                      {latest.champion.tuningSync.synced
                        ? "ĐÃ ĐỒNG BỘ thiết lập xuống tab Mạng thần kinh — kiến trúc + thuật toán kích hoạt + tinh chỉnh của champion được ghi tự động (audit ML_SWEEP_SYNC_TUNING); trader lưu tay sẽ ghi đè."
                        : `Chưa đồng bộ thiết lập — ${latest.champion.tuningSync.note}`}
                    </p>
                  )}
                  {/* Giải nghĩa arch đầy đủ cho người đọc (F-18 #131 — câu
                      hỏi "24-12 là 2 lớp ẩn chứ?") */}
                  <p className="text-[10px] opacity-80" title={archTooltip(latest.champion.arch)}>
                    Arch {latest.champion.arch}: {archTooltip(latest.champion.arch)}.
                  </p>
                </div>
              ) : (
                <EmptyNote>
                  Đợt gần nhất không có ứng viên train thành công — xem cột lỗi
                  trên bảng hoặc logJson của SweepRun.
                </EmptyNote>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Card 4 · Lịch sử các đợt ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lịch sử các đợt</CardTitle>
          <CardDescription>10 đợt gần nhất (mới nhất trước).</CardDescription>
        </CardHeader>
        <CardContent>
          {runs.length === 0 ? (
            <EmptyNote>Chưa có đợt sweep nào được ghi lại.</EmptyNote>
          ) : (
            <div className="max-h-96 overflow-y-auto custom-scrollbar rounded-lg border">
              <ul className="divide-y">
                {runs.map((r) => {
                  const badge = runStatusBadge(r.status);
                  return (
                    <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-xs">
                      <span className="font-medium">{formatDateTime(r.startedAt)}</span>
                      <Badge className={cn("font-mono text-[10px]", badge.className)}>
                        {badge.label}
                      </Badge>
                      <span className="tabular-nums text-muted-foreground">
                        {r.evaluated}/{r.candidates} ứng viên
                      </span>
                      <span
                        className="font-mono text-[10px] text-muted-foreground"
                        title={r.windowHash}
                      >
                        {r.windowHash.slice(0, 12)}…
                      </span>
                      <span className="ml-auto flex flex-wrap items-center gap-2">
                        {r.champion ? (
                          <>
                            <span className="font-mono text-[10px]" title={archTooltip(r.champion.arch)}>
                              {r.champion.tag} · {r.champion.arch}
                            </span>
                            <Badge
                              className={cn(
                                "font-mono text-[10px]",
                                r.champion.swapProposed
                                  ? "bg-emerald-600/15 text-emerald-700 dark:text-emerald-400"
                                  : "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                              )}
                              title={r.champion.swapReason}
                            >
                              {r.champion.swapProposed ? "đã swap" : "không qua cổng"}
                            </Badge>
                            {/* F-18 (#131): đợt đã đồng bộ thiết lập champion xuống tab NN */}
                            {r.champion.tuningSync?.synced === true && (
                              <Badge
                                className="bg-primary/15 font-mono text-[9px] text-primary"
                                title={r.champion.tuningSync.note}
                              >
                                → tab NN
                              </Badge>
                            )}
                          </>
                        ) : (
                          <span className="text-[10px] text-muted-foreground">—</span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Card 5 · Cổng 4 điều kiện (công khai) ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cổng 4 điều kiện (công khai)</CardTitle>
          <CardDescription>
            Công thức điểm và điều kiện hoán đổi serving — không có gì ẩn.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-[11px] leading-relaxed text-muted-foreground">
          <p>
            <span className="font-semibold text-foreground">Điểm ứng viên</span> = valAcc −
            0,0002 × max(0, tham số − 5.000)/100 + 0,01 nếu Brier ≤ Brier serving
            (mốc 5.000 = ngưỡng cảnh báo quá tham số hoá — một nguồn với trình
            chỉnh sửa kiến trúc).
          </p>
          <p>
            <span className="font-semibold text-foreground">Điều kiện 1</span> — valAcc
            champion ≥ valAcc serving + δ (chưa có serving → baseline 1/3 ngẫu nhiên).
          </p>
          <p>
            <span className="font-semibold text-foreground">Điều kiện 2</span> — ΔBrier
            paired bootstrap CI 95% hoàn toàn &lt; 0 (1.000 lần resample ghép cặp
            theo mẫu; chưa có serving → baseline uniform 0,667).
          </p>
          <p>
            <span className="font-semibold text-foreground">Điều kiện 3</span> — số tham
            số champion ≤ max(hệ số cap × tham số serving; nTrain ÷ 15 mẫu/tham
            số) — chống &quot;thắng vì to&quot; chỉ khi dữ liệu không đủ mẫu nuôi mô
            hình: kho 60.000 mẫu (nTrain 48.000) cấp cap 3.200 tham số, mô
            hình to hơn vẫn bị chặn khi dữ liệu nhỏ.
          </p>
          <p>
            <span className="font-semibold text-foreground">Điều kiện 4</span> — skip-guard
            windowHash áp LUÔN: cùng cửa sổ dữ liệu với đợt trước ⇒ không sweep lại
            (không có bar mới = không có gì mới để tìm).
          </p>
          <p>
            Không thoả đủ 4 điều kiện → champion nằm lại bảng với lý do thật —
            trung thực, không ép. Người đánh giá cuối cùng của kiến trúc vẫn là
            cổng bằng chứng, không phải bảng xếp hạng.
          </p>
          <p>
            <span className="font-semibold text-foreground">Phạm vi tìm kiếm</span> — chỉ
            kiến trúc <strong>MLP/ANN</strong> (6 topo coarse × 2 biến thể activation + 4
            refine quanh top-2: ±nơ-rôn, thêm/bớt lớp, lr × 0,5, preset trọng số loss ·
            featureSet 16/24 chiều): đây là cấp <strong>L1 &quot;NAS-Lite&quot;</strong>{" "}
            deterministic — <strong>không phải HyperNAS</strong> (L3: surrogate zero-shot,
            graph encoder H(z), loss thích ứng — đã bị loại ở audit #97 vì chưa có bằng
            chứng đủ). GRU-24 (cố định 16→24→8→3, window 20) và Q-learning nằm ngoài
            sweep — GRU lên giọng thứ ba qua cổng bằng chứng B2 riêng.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export default SweepTab;
