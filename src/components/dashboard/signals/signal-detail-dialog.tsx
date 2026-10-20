"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { vi } from "date-fns/locale";
import {
  CheckCircle2,
  FlaskConical,
  Loader2,
  Minus,
  Radar,
  TrendingDown,
  TrendingUp,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
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
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ChipMeta, ListRow, VerdictBadge, type StatTileTone } from "@/components/dashboard/kit";
import { apiPostJson } from "@/lib/api";
import { formatDateTime, formatPct, formatPrice, formatSigned } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { SignalRow } from "@/lib/types";

/**
 * M4.2.1 (UIUX_UPGRADE_BLUEPRINT §4) — dialog tier-3 cho module Tín hiệu:
 * màn chính chỉ còn HÀNG GỌN (feed #110-b), toàn bộ chiều sâu chuyển vào đây
 * — FULL rationale nguyên văn + JSON tín hiệu + hành động Duyệt/Từ chối.
 *
 * Hành động dùng POST /api/signals/{id}/decision (APPROVE ≡ convert cũ):
 *  - APPROVE → tạo lệnh giấy 5% NAV + status ACTED;
 *  - REJECT  → status REJECTED + rejectNote (≤500 ký tự, tuỳ chọn).
 * Nút chính theo pattern #102 "DISABLED-CÓ-LÝ-DO": tooltip nêu rõ vì sao
 * chưa bấm được (GIỮ / đã ACTED / đã REJECT / EXPIRED).
 *
 * Meta dùng chung (SIGNAL_DIRECTION · consensusMeta · statusMeta) khai báo
 * Ở ĐÂY để signals-feed/overview/todo-panel nhập về — một nguồn, không
 * chế bản sao (nguyên tắc kit §2.4); dialog KHÔNG import ngược về feed.
 * (F-1114-01 fixbug #111: bỏ SIGNAL_CONFIDENCE khỏi danh sách — đã un-export
 * theo F-1111-05, chỉ còn dùng nội bộ dialog.)
 */

/* ─────────────────── Meta hướng / độ tin cậy (dùng chung) ─────────────────── */

export interface DirectionMeta {
  label: string;
  /** Chữ in hoa cho tiêu đề dialog: MUA / BÁN / GIỮ. */
  upper: string;
  className: string;
  icon: React.ComponentType<{ className?: string }>;
}

export const SIGNAL_DIRECTION: Record<string, DirectionMeta> = {
  BUY: {
    label: "Mua",
    upper: "MUA",
    className: "bg-up/15 text-up",
    icon: TrendingUp,
  },
  SELL: {
    label: "Bán",
    upper: "BÁN",
    className: "bg-down/15 text-down",
    icon: TrendingDown,
  },
  HOLD: {
    label: "Giữ",
    upper: "GIỮ",
    className: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    icon: Minus,
  },
};

// F-1111-05 (fixbug #111 — dọn code rác): SIGNAL_CONFIDENCE chỉ dùng nội bộ
// dialog (feed dùng 3 meta đã import: SIGNAL_DIRECTION/consensusMeta/statusMeta) — bỏ export.
const SIGNAL_CONFIDENCE: Record<string, { label: string; className: string }> = {
  HIGH: { label: "Tin cậy cao", className: "border-up/40 text-up" },
  MEDIUM: { label: "Tin cậy vừa", className: "border-amber-500/40 text-amber-600 dark:text-amber-400" },
  LOW: { label: "Tin cậy thấp", className: "text-muted-foreground" },
};

/* ─────────────────── Cổng đồng thuận hội đồng (M4.2.1) ─────────────────── */

export interface ConsensusMeta {
  label: string;
  tone: StatTileTone;
  title: string;
}

const nfConsensus = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 });

/** Chip đồng thuận: CONSENSUS=primary · WEAK_MAJORITY=amber · NO_CONSENSUS=muted. */
export function consensusMeta(
  gate: string | null | undefined,
  ratio: number | null | undefined,
  dominant?: string | null,
): ConsensusMeta | null {
  if (!gate) return null;
  const pct = ratio != null ? `${nfConsensus.format(ratio * 100)}%` : null;
  // F-151-1 (Task 152) — hướng số đông của snapshot gắn lên chip ("tăng"/
  // "giảm"/"đi ngang") để trader thấy vì sao tín hiệu khớp hướng bị duyệt/
  // bị chặn (gate chỉ duyệt lệnh KHỚP hướng số đông).
  const dirVi =
    dominant === "UP" ? "tăng" : dominant === "DOWN" ? "giảm" : dominant === "FLAT" ? "đi ngang" : null;
  const dirSuffix = dirVi ? ` · ${dirVi}` : "";
  switch (gate) {
    case "CONSENSUS":
      return {
        label: pct ? `Đồng thuận ${pct}${dirSuffix}` : `Đồng thuận${dirSuffix}`,
        tone: "primary",
        title: `Hội đồng đồng thuận${pct ? ` ${pct} trọng số phiếu` : ""}${dirVi ? ` nghiêng ${dirVi}` : ""} (đạt ngưỡng 80%) — cổng enforcement chỉ duyệt lệnh MUA/BÁN khớp hướng số đông${dirVi ? ` (${dirVi})` : ""} (F-151-1).`,
      };
    case "WEAK_MAJORITY":
      return {
        label: pct ? `Đa số yếu ${pct}${dirSuffix}` : `Đa số yếu${dirSuffix}`,
        tone: "flat",
        title: `Đa số yếu${pct ? ` ${pct} trọng số phiếu` : ""}${dirVi ? ` nghiêng ${dirVi}` : ""} (50–80%, chưa đạt 80%) — enforcement hạ mọi MUA/BÁN về GIỮ.`,
      };
    case "NO_CONSENSUS":
      return {
        label: pct ? `Không đồng thuận ${pct}${dirSuffix}` : `Không đồng thuận${dirSuffix}`,
        tone: "neutral",
        title: `Hội đồng không đạt đa số${pct ? ` (${pct} trọng số phiếu)` : ""}${dirVi ? `, xu hướng yếu nghiêng ${dirVi}` : ""} — không có xu hướng chung.`,
      };
    default:
      return null;
  }
}

/* ─────────────────── Chip trạng thái vòng đời ─────────────────── */

/**
 * PHIÊN #91 (tái triển khai trên #111) — quy tắc 1 duyệt · 2 từ chối:
 *   ACTED    → "Đã duyệt" (xanh up) — kèm "· đã chuyển lệnh" khi có lệnh
 *              paper THẬT (paperOrdered); auto-duyệt đủ đồng thuận nhưng
 *              paper 0 ₫ → chỉ "Đã duyệt" (quyết định tách khỏi số dư).
 *   REJECTED → "Đã từ chối" (đỏ down) + rejectNote làm title/tooltip.
 *   EXPIRED  → "Đã hết hạn" (xám neutral).
 *   ACTIVE   → "Chờ quyết định" (vàng flat) — chỉ còn khi auto-decision
 *              cuối chu kỳ lỗi fail-soft (hiếm), hoặc tín hiệu sinh ngoài
 *              chu kỳ agents/run.
 */
export function statusMeta(s: SignalRow): {
  label: string;
  tone: StatTileTone;
  title: string;
} {
  if (s.rejectedAt != null || s.status === "REJECTED") {
    return {
      label: "Đã từ chối",
      tone: "down",
      title: s.rejectNote
        ? `Tín hiệu đã bị từ chối — lý do: ${s.rejectNote}`
        : "Tín hiệu đã bị từ chối.",
    };
  }
  if (s.actedAt != null || s.status === "ACTED") {
    return s.paperOrdered
      ? {
          label: "Đã duyệt · đã chuyển lệnh",
          tone: "up",
          title: "Tín hiệu đã được duyệt (đủ đồng thuận ≥80% hoặc trader duyệt tay) và lệnh giấy đã đặt — chờ khớp.",
        }
      : {
          label: "Đã duyệt",
          tone: "up",
          title:
            "Tín hiệu đã được DUYỆT theo cổng đồng thuận ≥80% (quy tắc 1 duyệt · 2 từ chối). Lệnh giấy chưa đặt được (tài khoản giấy 0 ₫ / không đủ vị thế BÁN) — quyết định tách khỏi số dư, chi tiết trong audit.",
        };
  }
  if (s.status === "EXPIRED") {
    return {
      label: "Đã hết hạn",
      tone: "neutral",
      title: "Tín hiệu đã quá thời hạn hiệu lực — không thể duyệt/từ chối nữa.",
    };
  }
  return {
    label: "Chờ quyết định",
    tone: "flat",
    title:
      "Tín hiệu đang ACTIVE — auto-decision cuối chu kỳ sẽ duyệt (≥80% đồng thuận) hoặc từ chối ngay; nhóm này chỉ còn khi auto-decision lỗi fail-soft.",
  };
}

/** Nhãn Việt cho executionKind của sổ phán quyết D-LEDGER (#106). */
function executionKindLabel(kind: string | null): string | null {
  switch (kind) {
    case "EXECUTED_CLOSED":
      return "Đã thực thi · vị thế đã đóng";
    case "EXECUTED_OPEN":
      return "Đã thực thi · vị thế còn mở";
    case "UNEXECUTED":
      return "Chưa thực thi";
    default:
      return null;
  }
}

/* ─────────────────── Lý do nút chính bị khoá (pattern #102) ─────────────────── */

function approveDisabledReason(s: SignalRow): string | null {
  if (s.direction === "HOLD") {
    return "Khuyến nghị GIỮ không chuyển được thành lệnh — chỉ MUA/BÁN mới được duyệt & chuyển lệnh.";
  }
  if (s.actedAt != null || s.status === "ACTED") {
    return "Tín hiệu này đã được duyệt và chuyển thành lệnh.";
  }
  if (s.rejectedAt != null || s.status === "REJECTED") {
    return "Tín hiệu này đã bị từ chối.";
  }
  if (s.status === "EXPIRED") {
    return `Tín hiệu đã hết hạn${s.expiresAt ? ` lúc ${formatDateTime(s.expiresAt)}` : ""} — không thể duyệt nữa.`;
  }
  return null;
}

/* ─────────────────── Dialog chi tiết tín hiệu (tier-3) ─────────────────── */

type DecisionVars = { id: string; action: "APPROVE" | "REJECT"; note?: string };
type DecisionResponse = {
  order: { symbol: string; side: string; quantity: number; price: number } | null;
};

interface SignalDetailDialogProps {
  /** Tín hiệu đang xem (null = đóng). */
  signal: SignalRow | null;
  onOpenChange: (open: boolean) => void;
}

export function SignalDetailDialog({ signal, onOpenChange }: SignalDetailDialogProps) {
  const queryClient = useQueryClient();
  // Ghi chú từ chối — component chỉ được mount khi có tín hiệu (feed render
  // có điều kiện), mở tín hiệu khác/lại = state mới, không cần effect reset.
  const [note, setNote] = React.useState("");

  const s = signal;
  const dir = s ? (SIGNAL_DIRECTION[s.direction] ?? SIGNAL_DIRECTION.HOLD) : null;
  const conf = s ? (SIGNAL_CONFIDENCE[s.confidence] ?? SIGNAL_CONFIDENCE.MEDIUM) : null;
  const cons = s ? consensusMeta(s.consensusGate, s.consensusRatio, s.consensusDominant) : null;
  const st = s ? statusMeta(s) : null;
  const evaln = s?.evaluation ?? null;
  const canReject = s != null && s.status === "ACTIVE" && !s.actedAt && !s.rejectedAt;
  const approveReason = s ? approveDisabledReason(s) : null;
  const canApprove = s != null && approveReason == null;

  const decisionMutation = useMutation({
    mutationFn: (vars: DecisionVars) =>
      apiPostJson<DecisionResponse>(`/api/signals/${vars.id}/decision`, {
        action: vars.action,
        ...(vars.action === "REJECT" && vars.note ? { note: vars.note } : {}),
      }),
    onSuccess: (res, vars) => {
      void queryClient.invalidateQueries({ queryKey: ["signals"] });
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      if (vars.action === "APPROVE") {
        // F-1111-09 (fixbug #111): tách nhánh theo action thay vì else mặc định
        // giả định REJECT — nếu sau này route trả APPROVE mà order null thì thông
        // báo đúng trạng thái, không báo nhầm "đã từ chối".
        if (res.order) {
          toast.success("Đã duyệt và tạo lệnh chờ khớp", {
            description: `${res.order.side === "BUY" ? "MUA" : "BÁN"} ${res.order.quantity} cp ${res.order.symbol} @ ${formatPrice(res.order.price)} ₫`,
          });
        } else {
          toast.success("Đã duyệt tín hiệu", {
            description: "Không sinh lệnh (tín hiệu không đủ điều kiện chuyển lệnh).",
          });
        }
      } else {
        toast.success("Đã từ chối tín hiệu", {
          description: vars.note || "Tín hiệu chuyển sang trạng thái đã từ chối.",
        });
      }
      onOpenChange(false);
    },
    onError: (err: Error) => {
      toast.error(err.message || "Không xử lý được quyết định tín hiệu.");
    },
  });

  const jsonPretty = React.useMemo(() => {
    if (!s) return "";
    return JSON.stringify(
      {
        id: s.id,
        symbol: s.symbol,
        name: s.name,
        direction: s.direction,
        confidence: s.confidence,
        score: s.score,
        targetPrice: s.targetPrice,
        stopLoss: s.stopLoss,
        takeProfit: s.takeProfit,
        consensusGate: s.consensusGate ?? null,
        consensusRatio: s.consensusRatio ?? null,
        consensusDominant: s.consensusDominant ?? null,
        status: s.status,
        sandboxExecuted: s.sandboxExecuted ?? false,
        paperOrdered: s.paperOrdered ?? false,
        evaluation: s.evaluation ?? null,
        agent: s.agentCode ?? null,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
      },
      null,
      2,
    );
  }, [s]);

  if (!s || !dir || !conf || !st) return null;

  const DirIcon = dir.icon;
  const pendingKind =
    decisionMutation.isPending && decisionMutation.variables != null
      ? decisionMutation.variables.action
      : null;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] gap-4 overflow-y-auto custom-scrollbar sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Radar className="size-4 text-primary" aria-hidden="true" />
            Tín hiệu {s.symbol} · {dir.upper}
          </DialogTitle>
          <DialogDescription>
            {s.name} · đề xuất bởi {s.agentName ?? "Agent"} ·{" "}
            {formatDistanceToNow(new Date(s.createdAt), { addSuffix: true, locale: vi })}
          </DialogDescription>
        </DialogHeader>

        {/* Bức ảnh nhanh: hướng · tin cậy · đồng thuận · trạng thái · thử nghiệm */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge className={cn("gap-1", dir.className)}>
            <DirIcon className="size-3" aria-hidden="true" />
            {dir.label}
          </Badge>
          <Badge variant="outline" className={cn("text-[10px]", conf.className)}>
            {conf.label}
          </Badge>
          {cons && (
            <ChipMeta tone={cons.tone} title={cons.title}>
              {cons.label}
            </ChipMeta>
          )}
          <ChipMeta tone={st.tone} title={st.title}>
            {st.label}
          </ChipMeta>
          {s.sandboxExecuted && (
            <ChipMeta
              tone="primary"
              title="Agents đã tự thực thi tín hiệu này trong tài khoản thử nghiệm (K1) — xem lệnh ở Danh mục → Thử nghiệm"
            >
              <FlaskConical className="size-3" aria-hidden="true" />
              Thực thi · thử nghiệm
            </ChipMeta>
          )}
        </div>

        {/* PHIÊN #91 — khung lý do TỪ CHỐI (auto-decision ghi rejectNote) */}
        {s.rejectNote != null && (
          <div className="rounded-lg border border-down/30 bg-down/5 px-4 py-3">
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-down">
              Lý do từ chối
            </h3>
            <p className="break-words text-sm leading-relaxed text-foreground">
              {s.rejectNote}
            </p>
          </div>
        )}

        {/* Số liệu chính: score bar + mục tiêu/cắt lỗ/chốt lời + agent + tuổi */}
        <div className="overflow-hidden rounded-lg border border-border/60">
          <div className="border-b border-border/60 px-4 py-2.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm text-muted-foreground">Điểm khuyến nghị</span>
              <span className="text-sm font-medium tabular-nums">{s.score.toFixed(0)}/100</span>
            </div>
            <Progress value={s.score} className="mt-1.5 h-1.5" />
          </div>
          <ListRow
            label="Mục tiêu"
            value={s.targetPrice != null ? `${formatPrice(s.targetPrice)} ₫` : "—"}
          />
          <ListRow
            label="Cắt lỗ"
            tone={s.stopLoss != null ? "down" : "neutral"}
            value={s.stopLoss != null ? `${formatPrice(s.stopLoss)} ₫` : "—"}
          />
          <ListRow
            label="Chốt lời"
            tone={s.takeProfit != null ? "up" : "neutral"}
            value={s.takeProfit != null ? `${formatPrice(s.takeProfit)} ₫` : "—"}
          />
          <ListRow label="Agent đề xuất" value={s.agentName ?? "—"} />
          <ListRow
            label="Tuổi tín hiệu"
            value={`${formatDistanceToNow(new Date(s.createdAt), { addSuffix: true, locale: vi })} · ${formatDateTime(s.createdAt)}`}
          />
        </div>

        {/* FULL rationale — nguyên văn, KHÔNG cắt */}
        <section aria-labelledby="signal-rationale-h">
          <h3
            id="signal-rationale-h"
            className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Lý do đầy đủ (nguyên văn)
          </h3>
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
            {s.rationale || "—"}
          </p>
        </section>

        {/* Phán quyết D-LEDGER (#106) — vòng phản hồi thị giác */}
        {evaln && (
          <section
            aria-labelledby="signal-verdict-h"
            className="rounded-lg border border-border/60 bg-muted/20 px-4 py-3"
          >
            <h3
              id="signal-verdict-h"
              className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
            >
              Phán quyết sổ đánh giá (D-LEDGER)
            </h3>
            <div className="flex flex-wrap items-center gap-1.5">
              <VerdictBadge verdict={evaln.verdict} />
              {evaln.markPnlPct != null && (
                <ChipMeta
                  tone={evaln.markPnlPct > 0 ? "up" : evaln.markPnlPct < 0 ? "down" : "neutral"}
                  title="Lãi/lỗ đánh dấu (%) của quyết định so mốc ra tín hiệu"
                >
                  {formatPct(evaln.markPnlPct)}
                </ChipMeta>
              )}
              {evaln.cashPnlVND != null && (
                <ChipMeta
                  tone={evaln.cashPnlVND > 0 ? "up" : evaln.cashPnlVND < 0 ? "down" : "neutral"}
                  title="Lãi/lỗ tiền mặt đã phát sinh (₫)"
                >
                  {formatSigned(evaln.cashPnlVND)} ₫
                </ChipMeta>
              )}
              {executionKindLabel(evaln.executionKind) && (
                <ChipMeta title="Trạng thái thực thi của quyết định">
                  {executionKindLabel(evaln.executionKind)}
                </ChipMeta>
              )}
            </div>
          </section>
        )}

        {/* JSON tín hiệu — máy đọc được, pretty-print các trường chính */}
        <section aria-labelledby="signal-json-h">
          <h3
            id="signal-json-h"
            className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            JSON tín hiệu
          </h3>
          <pre className="max-h-64 overflow-auto custom-scrollbar rounded-lg border border-border/60 bg-muted/30 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {jsonPretty}
          </pre>
        </section>

        {/* Ghi chú từ chối — chỉ khi tín hiệu còn ACTIVE */}
        {canReject && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="signal-reject-note" className="text-xs text-muted-foreground">
              Ghi chú từ chối (tuỳ chọn · tối đa 500 ký tự)
            </label>
            <Textarea
              id="signal-reject-note"
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value.slice(0, 500))}
              placeholder="vd: chờ MACD xác nhận đảo chiều rồi mới vào lệnh…"
              className="min-h-16 text-sm"
            />
            <p className="text-right text-[11px] tabular-nums text-muted-foreground">
              {note.length}/500
            </p>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            className="h-11 sm:h-9"
            disabled={decisionMutation.isPending}
            onClick={() => onOpenChange(false)}
          >
            Huỷ
          </Button>
          {canReject && (
            <Button
              variant="outline"
              className="h-11 gap-1.5 sm:h-9"
              disabled={decisionMutation.isPending}
              onClick={() =>
                decisionMutation.mutate({
                  id: s.id,
                  action: "REJECT",
                  note: note.trim().length > 0 ? note.trim() : undefined,
                })
              }
            >
              {pendingKind === "REJECT" ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <XCircle className="size-4" aria-hidden="true" />
              )}
              Từ chối
            </Button>
          )}
          {canApprove ? (
            <Button
              className="h-11 gap-1.5 sm:h-9"
              disabled={decisionMutation.isPending}
              onClick={() => decisionMutation.mutate({ id: s.id, action: "APPROVE" })}
            >
              {pendingKind === "APPROVE" ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <CheckCircle2 className="size-4" aria-hidden="true" />
              )}
              Duyệt &amp; chuyển lệnh
            </Button>
          ) : (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* span bọc để tooltip vẫn hiện trên nút disabled (pattern #102) */}
                  <span tabIndex={0} className="inline-flex cursor-not-allowed">
                    <Button className="h-11 gap-1.5 sm:h-9" disabled aria-disabled="true">
                      <CheckCircle2 className="size-4" aria-hidden="true" />
                      Duyệt &amp; chuyển lệnh
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-64 text-left">
                  {approveReason}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
