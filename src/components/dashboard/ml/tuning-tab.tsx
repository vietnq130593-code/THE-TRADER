"use client";

/**
 * ml/tuning-tab.tsx (#89 → #94 · Task 3) — tab "Tinh chỉnh": ô nhập điều chỉnh
 * hyper MLP (epoch · patience · batch · lr · L2 · tỷ lệ val · seed — kiến
 * trúc lớp ẩn + trọng số loss chuyển sang trình chỉnh sửa ở tab Mạng thần
 * kinh) + tham số RAG BM25 (topK · k₁ · b · w recency) + kill-switch GRU +
 * đặt lại vòng học Bandit.
 *
 * VẬN HÀNH THẬT (không phải UI trang trí):
 *  - Lưu → POST /api/ml/tuning → AppSetting "ml-tuning" → train route/rag.ts
 *    đọc GIÁ TRỊ NÀY ở lần huấn luyện/truy hồi kế tiếp (meta bản train ghi
 *    rõ cấu hình đã dùng — truy vết được).
 *  - GRU switch → ghi AppSetting "ml-gru" — hiệu lực TỨC thì ở ensemble.
 *  - Bandit reset → 6 arm về prior Beta(1,1) — có Dialog xác nhận.
 */

import * as React from "react";
import {
  AlertTriangle,
  Brain,
  Info,
  RotateCcw,
  Save,
  Scale,
  SlidersHorizontal,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Switch } from "@/components/ui/switch";
import {
  useMlStatus,
  useMlTuning,
  useSaveMlTuning,
  type MlTuningFieldSpec,
  type MlTuningMlp,
  type MlTuningRag,
} from "@/hooks/use-ml";
import { toast } from "sonner";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { EmptyNote, nf0 } from "./shared";

type FieldValues = Record<string, string>;

function parseNum(raw: string): number | null {
  const normalized = raw.trim().replace(",", ".");
  if (normalized === "") return null;
  const v = Number(normalized);
  return Number.isFinite(v) ? v : null;
}

function initValues(specs: MlTuningFieldSpec[], values: Record<string, number> | MlTuningMlp | MlTuningRag): FieldValues {
  const out: FieldValues = {};
  for (const spec of specs) {
    const v = (values as Record<string, number | undefined>)[spec.key];
    out[spec.key] = v == null ? "" : String(v);
  }
  return out;
}

/** Ô nhập 1 trường tinh chỉnh — label + input + phạm vi + hint. */
function TuningField({
  spec,
  value,
  error,
  onChange,
}: {
  spec: MlTuningFieldSpec;
  value: string;
  error: string | null;
  onChange: (v: string) => void;
}) {
  const id = `tuning-${spec.key}`;
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

function SectionShell({
  title,
  icon,
  badge,
  onReset,
  resetDisabled,
  children,
  note,
}: {
  title: string;
  icon: React.ReactNode;
  badge?: React.ReactNode;
  onReset?: () => void;
  resetDisabled?: boolean;
  children: React.ReactNode;
  note: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border bg-muted/20 px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground" aria-hidden="true">
          {icon}
        </span>
        <h4 className="text-sm font-semibold">{title}</h4>
        {badge}
        {onReset && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto h-8 gap-1.5 px-2.5 text-[11px]"
            onClick={onReset}
            disabled={resetDisabled}
          >
            <RotateCcw className="size-3" aria-hidden="true" />
            Mặc định code
          </Button>
        )}
      </div>
      {children}
      <p className="text-[11px] leading-relaxed text-muted-foreground">{note}</p>
    </section>
  );
}

export function TuningTab() {
  const tuning = useMlTuning();
  const status = useMlStatus();
  const save = useSaveMlTuning();

  const [mlpValues, setMlpValues] = React.useState<FieldValues>({});
  const [ragValues, setRagValues] = React.useState<FieldValues>({});
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [confirmBandit, setConfirmBandit] = React.useState(false);
  const lastHydratedAt = React.useRef<string | null>(null);

  // Hydrate lần đầu + sau mỗi lần lưu (updatedAt đổi) — KHÔNG đè khi trader
  // đang gõ mà query nền refetch cùng giá trị (updatedAt không đổi).
  React.useEffect(() => {
    const data = tuning.data;
    if (!data) return;
    const at = data.updatedAt ?? "";
    if (lastHydratedAt.current === at) return;
    lastHydratedAt.current = at;
    setMlpValues(initValues(data.ranges.mlp, data.effective.mlp));
    setRagValues(initValues(data.ranges.rag, data.effective.rag));
    setFieldErrors({});
  }, [tuning.data]);

  const effective = tuning.data?.effective;
  const mlpSpecs = tuning.data?.ranges.mlp ?? [];
  const ragSpecs = tuning.data?.ranges.rag ?? [];

  /** So sánh state vs hiệu lực — trả payload SỐ của các trường bị đổi. */
  const diffSection = (
    values: FieldValues,
    specs: MlTuningFieldSpec[],
    current: Record<string, number> | MlTuningMlp | MlTuningRag
  ): Record<string, number> | null => {
    const cur = current as Record<string, number>;
    const changed: Record<string, number> = {};
    let any = false;
    for (const spec of specs) {
      const raw = values[spec.key] ?? "";
      const parsed = parseNum(raw);
      const curVal = cur[spec.key];
      if (parsed == null) {
        if (raw.trim() !== "" && raw.trim() !== String(curVal)) {
          // rỗng/NaN mà khác hiệu lực → coi như đổi, lỗi sẽ bắt ở validate
          any = true;
          changed[spec.key] = Number.NaN;
        }
        continue;
      }
      if (parsed !== curVal) {
        any = true;
        changed[spec.key] = parsed;
      }
    }
    return any ? changed : null;
  };

  const mlpChanged = effective ? diffSection(mlpValues, mlpSpecs, effective.mlp) : null;
  const ragChanged = effective ? diffSection(ragValues, ragSpecs, effective.rag) : null;
  const dirty = mlpChanged != null || ragChanged != null;

  /** Validate toàn bộ trường ĐỔI trước khi gửi — lỗi hiện cạnh ô nhập. */
  const validate = (): { mlp?: Partial<MlTuningMlp>; rag?: Partial<MlTuningRag> } | null => {
    const errors: Record<string, string> = {};
    const out: { mlp?: Partial<MlTuningMlp>; rag?: Partial<MlTuningRag> } = {};
    const check = (changed: Record<string, number> | null, specs: MlTuningFieldSpec[]) => {
      if (changed == null) return;
      const clean: Record<string, number> = {};
      for (const spec of specs) {
        if (!(spec.key in changed)) continue;
        const v = changed[spec.key];
        if (!Number.isFinite(v)) {
          errors[spec.key] = "Giá trị không phải số hợp lệ.";
          continue;
        }
        if (spec.integer && !Number.isInteger(v)) {
          errors[spec.key] = "Phải là số nguyên.";
          continue;
        }
        if (v < spec.min || v > spec.max) {
          errors[spec.key] = `Ngoài phạm vi [${spec.min} – ${spec.max}].`;
          continue;
        }
        clean[spec.key] = v;
      }
      return clean;
    };
    const mlpClean = check(mlpChanged, mlpSpecs);
    const ragClean = check(ragChanged, ragSpecs);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      toast.error("Giá trị chưa hợp lệ", {
        description: Object.entries(errors)
          .map(([k, v]) => `${k}: ${v}`)
          .join(" · "),
      });
      return null;
    }
    if (mlpClean && Object.keys(mlpClean).length > 0) out.mlp = mlpClean as Partial<MlTuningMlp>;
    if (ragClean && Object.keys(ragClean).length > 0) out.rag = ragClean as Partial<MlTuningRag>;
    return out;
  };

  const handleSave = () => {
    const payload = validate();
    if (payload == null) return;
    if (payload.mlp == null && payload.rag == null) {
      toast.info("Không có giá trị nào thay đổi để lưu.");
      return;
    }
    save.mutate(payload);
  };

  if (tuning.isLoading) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="h-40 w-full rounded-lg" />
        <Skeleton className="h-32 w-full rounded-lg" />
        <Skeleton className="h-24 w-full rounded-lg" />
      </div>
    );
  }

  if (tuning.isError || tuning.data == null) {
    return (
      <EmptyNote>
        Không tải được cấu hình tinh chỉnh ({tuning.error?.message ?? "API /api/ml/tuning chưa sẵn sàng"}) —
        thử tải lại tab.
      </EmptyNote>
    );
  }

  const gru = status.data?.gru ?? null;
  const gruOn = gru?.enabled === true;
  const gruPending = save.isPending;
  const savedMlp = tuning.data.saved.mlp;
  const savedRag = tuning.data.saved.rag;

  return (
    <div className="flex flex-col gap-4">
      <p className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        Mọi ô nhập dưới đây ghi vào AppSetting “ml-tuning” và được huấn
        luyện/truy hồi ĐỌC THẬT ở lần chạy kế tiếp — không phải UI trang trí.
        Giá trị hiển thị là cấu hình HIỆU LỰC hiện tại.
        {tuning.data.updatedAt && (
          <>
            {" "}· Lưu lần cuối {formatDateTime(tuning.data.updatedAt)}.
          </>
        )}
      </p>

      {/* MLP */}
      <SectionShell
        title="MLP — kiến trúc & tối ưu"
        icon={<SlidersHorizontal className="size-4" />}
        badge={
          savedMlp ? (
            <Badge variant="outline" className="text-[10px] text-amber-700 dark:text-amber-400">
              đang ghi đè mặc định
            </Badge>
          ) : (
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              mặc định code
            </Badge>
          )
        }
        onReset={() => save.mutate({ resetMlp: true })}
        resetDisabled={gruPending || savedMlp == null}
        note={
          <>
            Áp dụng từ lần huấn luyện KẾ TIẾP (nút “Huấn luyện” ở tab Tổng quan).
            Bản serving không đổi đến khi train lại và qua serving-swap guard
            (valAcc ≥ bản cũ). Meta bản mới ghi rõ arch + activations + hyper đã
            dùng. <strong>Kiến trúc lớp ẩn &amp; trọng số loss từng đầu ra</strong>{" "}
            chỉnh ở trình chỉnh sửa kiến trúc ANN — tab <strong>Mạng thần kinh</strong>.
            Ví dụ an toàn: 16-24-12-3 (747 tham số, ~84 mẫu/tham số).
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          {mlpSpecs.map((spec) => (
            <TuningField
              key={spec.key}
              spec={spec}
              value={mlpValues[spec.key] ?? ""}
              error={fieldErrors[spec.key] ?? null}
              onChange={(v) => setMlpValues((prev) => ({ ...prev, [spec.key]: v }))}
            />
          ))}
        </div>
      </SectionShell>

      {/* RAG */}
      <SectionShell
        title="RAG BM25 — truy hồi tri thức"
        icon={<Brain className="size-4" />}
        badge={
          savedRag ? (
            <Badge variant="outline" className="text-[10px] text-amber-700 dark:text-amber-400">
              đang ghi đè mặc định
            </Badge>
          ) : (
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              mặc định code
            </Badge>
          )
        }
        onReset={() => save.mutate({ resetRag: true })}
        resetDisabled={gruPending || savedRag == null}
        note={
          <>
            Áp dụng từ lần truy hồi KẾ TIẾP (mỗi chu kỳ agent) — cache corpus
            60 giây bị xoá ngay khi lưu. Cap khối prompt 3.000 ký tự vẫn giữ
            nguyên (an toàn ngân sách token ≤1.200).
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {ragSpecs.map((spec) => (
            <TuningField
              key={spec.key}
              spec={spec}
              value={ragValues[spec.key] ?? ""}
              error={fieldErrors[spec.key] ?? null}
              onChange={(v) => setRagValues((prev) => ({ ...prev, [spec.key]: v }))}
            />
          ))}
        </div>
      </SectionShell>

      {/* GRU kill-switch */}
      <SectionShell
        title="GRU — giọng thứ ba (kill-switch)"
        icon={<Brain className="size-4" />}
        badge={
          gruOn ? (
            <Badge className="bg-emerald-600/15 text-[10px] text-emerald-700 hover:bg-emerald-600/15 dark:text-emerald-400">
              đang phục vụ
            </Badge>
          ) : (
            <Badge variant="outline" className="text-[10px] text-amber-700 dark:text-amber-400">
              {gru ? "shadow — chưa vào điểm" : "chưa triển khai"}
            </Badge>
          )
        }
        note={
          <>
            Hiệu lực TỨC THENH (ensemble đọc AppSetting “ml-gru” mỗi lần dự
            báo). Khi bật: điểm rổ = 0,5·MLP + 0,2·GRU + 0,3·linreg. Tầng bảo
            vệ 2 &amp; 3 vẫn tự hạ nếu shadow đủ 60 phiên mà Brier tệ hơn MLP 5
            phiên liên tiếp.
          </>
        }
      >
        <div className="flex items-center justify-between gap-3 rounded-md border bg-background/60 px-3 py-2.5">
          <Label htmlFor="gru-switch" className="text-xs font-medium">
            Cho phép GRU tham gia điểm rổ
          </Label>
          <Switch
            id="gru-switch"
            checked={gruOn}
            disabled={gruPending || gru == null}
            onCheckedChange={(checked) => save.mutate({ gruEnabled: checked })}
            aria-label="Bật tắt giọng thứ ba GRU"
          />
        </div>
      </SectionShell>

      {/* Bandit reset */}
      <SectionShell
        title="Bandit — vòng học trọng số phiếu"
        icon={<Scale className="size-4" />}
        note={
          <>
            Đặt lại toàn bộ arm về prior Beta(1,1) — pulls/wins về 0. BanditEvent
            (sổ phiếu) GIỮ NGUYÊN để truy vết và chặn kết toán lại phiếu cũ.
            Thắng/thua đã trộn posterior là học thật — chỉ đặt lại khi muốn
            bắt đầu vòng học mới hoàn toàn.
          </>
        }
      >
        <div className="flex items-center justify-between gap-3 rounded-md border bg-background/60 px-3 py-2.5">
          <span className="text-xs leading-relaxed text-muted-foreground">
            {status.data?.bandit
              ? `${status.data.bandit.arms.length} arms · ${nf0.format(status.data.pendingSettles ?? 0)} phiếu chờ kết toán`
              : "Chưa có arm nào"}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 border-rose-500/40 px-2.5 text-[11px] text-rose-600 hover:bg-rose-500/10 hover:text-rose-700 dark:text-rose-400"
            onClick={() => setConfirmBandit(true)}
            disabled={gruPending || (status.data?.bandit?.arms.length ?? 0) === 0}
          >
            <RotateCcw className="size-3" aria-hidden="true" />
            Đặt lại vòng học
          </Button>
        </div>
      </SectionShell>

      {/* Lưu */}
      <div className="flex flex-wrap items-center gap-3 border-t pt-3">
        <Button
          onClick={handleSave}
          disabled={!dirty || gruPending}
          className="min-h-11 gap-2"
        >
          <Save className="size-4" aria-hidden="true" />
          {save.isPending ? "Đang lưu…" : "Lưu cấu hình"}
        </Button>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {dirty
            ? "Có giá trị chưa lưu — bấm Lưu để ghi vào AppSetting ml-tuning."
            : "Không có thay đổi chưa lưu (giá trị đang hiển thị = cấu hình hiệu lực)."}
        </p>
      </div>

      {/* Dialog xác nhận reset Bandit */}
      <Dialog open={confirmBandit} onOpenChange={setConfirmBandit}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />
              Đặt lại vòng học Bandit?
            </DialogTitle>
            <DialogDescription className="leading-relaxed">
              Toàn bộ posterior Beta của các arm (α, β, pulls, wins) trở về prior
              Beta(1,1). Học đã tích luỹ từ các phiếu bầu sẽ KHÔNG thể hoàn tác
              (sổ phiếu BanditEvent vẫn giữ để truy vết). Chỉ nên làm khi muốn
              bắt đầu vòng học mới hoàn toàn.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:justify-start">
            <Button
              variant="outline"
              onClick={() => setConfirmBandit(false)}
              className="min-h-11"
            >
              Huỷ
            </Button>
            <Button
              variant="destructive"
              className="min-h-11"
              disabled={save.isPending}
              onClick={() => {
                setConfirmBandit(false);
                save.mutate({ resetBandit: true });
              }}
            >
              {save.isPending ? "Đang đặt lại…" : "Xác nhận đặt lại"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
