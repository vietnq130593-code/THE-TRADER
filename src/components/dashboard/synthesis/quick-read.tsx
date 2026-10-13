"use client";

/**
 * synthesis/quick-read.tsx (M4.7 #110 — UIUX_UPGRADE_BLUEPRINT §4) — hàng
 * "1 dòng đọc nhanh" mở đầu MỖI tab của workspace Tổng hợp (trừ tab Nhận
 * định đã có AssessmentHeaderCard): 1 mệnh đề kết luận + 3 số then chốt.
 *
 * Trung thực số liệu (§2.5): mọi số lấy THẬT từ chính query mà tab đó đang
 * dùng (react-query cache dùng chung — KHÔNG thêm API mới, KHÔNG bịa số).
 * Tab chưa có dữ liệu (loading/error/empty) → icon ZapOff + câu trung thực,
 * không hiển thị số đoán.
 *
 * Bố cục: nền bg-primary/5 + viền border-primary/20 (accent thương hiệu nhẹ,
 * không phải màu dữ liệu) — icon Zap/ZapOff size-3.5 text-primary + text-sm.
 */

import * as React from "react";
import { Zap, ZapOff } from "lucide-react";
import { useMlArchitecture, useMlStatus, useMlTuning } from "@/hooks/use-ml";
import { useMlSweep } from "@/hooks/use-ml-sweep";
import { formatDateTime } from "@/lib/format";
import type { MarketAssessmentView } from "@/lib/types";
import { nf0, nf2, pct1 } from "@/components/dashboard/ml/shared";
import { buildAlgoSpecs } from "@/components/dashboard/ml/algorithms-tab";

/* ─────────────────── Vỏ dùng chung ─────────────────── */

/**
 * Hàng đọc nhanh — data-quick-read={id} để E2E đếm từng tab; ready=false →
 * ZapOff (chưa có số) thay Zap (đang có số thật).
 */
export function QuickReadRow({
  id,
  ready,
  label,
  children,
}: {
  id: string;
  ready: boolean;
  label: string;
  children: React.ReactNode;
}) {
  const Icon = ready ? Zap : ZapOff;
  return (
    <div
      data-quick-read={id}
      className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2"
      role="note"
      aria-label={`Đọc nhanh tab ${label}`}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-sm leading-relaxed">{children}</p>
    </div>
  );
}

/** " — số 1 · số 2 · số 3" — số đậm tabular, dấu phân cách muted. */
function QuickNums({ items }: { items: (string | null | undefined)[] }) {
  const parts = items.filter((s): s is string => s != null && s !== "");
  if (parts.length === 0) return null;
  return (
    <>
      <span className="text-muted-foreground">{" — "}</span>
      {parts.map((p, i) => (
        <React.Fragment key={`${p}-${i}`}>
          {i > 0 && <span className="text-muted-foreground"> · </span>}
          <span className="font-medium tabular-nums text-foreground">{p}</span>
        </React.Fragment>
      ))}
    </>
  );
}

/** "50%" — tỷ lệ 0..1 làm tròn 0 chữ số (posterior bandit). */
function pct0(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${Math.round(n * 100)}%`;
}

const DIRECTION_LABEL: Record<string, string> = {
  BULLISH: "TĂNG",
  BEARISH: "GIẢM",
  NEUTRAL: "ĐI NGANG",
};

const ACT_LABEL: Record<string, string> = {
  relu: "ReLU",
  tanh: "tanh",
  sigmoid: "sigmoid",
};

function actLabels(acts: string[] | undefined): string {
  if (!acts || acts.length === 0) return "—";
  return acts.map((a) => ACT_LABEL[a] ?? a).join(" · ");
}

/** Chú thích chờ (ZapOff + câu muted) — dùng chung mọi trạng thái chưa sẵn sàng. */
function WaitingText({ children }: { children: React.ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

/* ─────────────────── 2 · Bằng chứng ─────────────────── */

/**
 * Tab Bằng chứng — nhận định + bằng chứng + lịch sử pUp dùng chung nguồn
 * /api/assessment với tab Nhận định (props từ workspace, không query riêng).
 * F-1115-03 (fixbug #111): thêm prop error — trước fix khi API lỗi cũng hiển
 * thị câu "Chưa có nhận định — bấm Tổng hợp lại ngay" (sai ngữ cảnh, §2.5
 * lỗi ≠ trống).
 */
export function EvidenceQuickRead({
  assessment,
  historyCount,
  loading,
  error,
}: {
  assessment: MarketAssessmentView | null;
  historyCount: number;
  loading: boolean;
  error?: boolean;
}) {
  const ready = assessment != null;
  return (
    <QuickReadRow id="evidence" ready={ready} label="Bằng chứng">
      {ready && assessment ? (
        <>
          <span className="font-medium">
            Bằng chứng hiện kéo hướng{" "}
            {DIRECTION_LABEL[assessment.marketDirection] ?? assessment.marketDirection}
          </span>
          <QuickNums
            items={[
              `${nf0.format(assessment.evidenceCount)} bằng chứng`,
              assessment.consensus
                ? `đồng thuận ${pct1(assessment.consensus.ratio)} · ${assessment.consensus.present} cử tri`
                : "chưa đo đồng thuận",
              `${nf0.format(assessment.symbols.length)} mã bậc 3 · ${nf0.format(historyCount)} điểm lịch sử`,
            ]}
          />
        </>
      ) : (
        <WaitingText>
          {error
            ? "Không tải được nhận định Bayes — thử tải lại tab."
            : loading
              ? "Đang tải nhận định Bayes…"
              : "Chưa có nhận định — bấm “Tổng hợp lại ngay” phía trên để thu bằng chứng."}
        </WaitingText>
      )}
    </QuickReadRow>
  );
}

/* ─────────────────── 3 · Học máy ─────────────────── */

/** Tab Học máy — 3 mô hình học thật (MLP · Q-learning · Bandit), nguồn /api/ml/status. */
export function MlQuickRead() {
  const { data, isLoading, isError } = useMlStatus();
  const mlp = data?.dlMlp ?? null;
  const ready = !isLoading && !isError && data != null;
  // 3 mô hình học thật tab này theo dõi: MLP · Q-learning · Bandit.
  const servingCount = ready
    ? [data?.dlMlp, data?.rlQ, data?.bandit].filter(Boolean).length
    : 0;

  return (
    <QuickReadRow id="ml" ready={ready && mlp != null} label="Học máy">
      {!ready ? (
        <WaitingText>
          {isLoading
            ? "Đang tải trạng thái học máy…"
            : "Backend học máy chưa sẵn sàng — tự tải lại mỗi 30 giây."}
        </WaitingText>
      ) : mlp ? (
        <>
          <span className="font-medium">
            MLP serving v{mlp.version} ({mlp.featureSet ?? "—"}) — refit{" "}
            {formatDateTime(mlp.trainedAt)}
          </span>
          <QuickNums
            items={[
              `valAcc ${pct1(mlp.metrics.valAcc)}`,
              `${servingCount}/3 mô hình đang theo dõi`,
              `${nf0.format(data?.pendingSettles ?? 0)} phiếu chờ kết toán`,
            ]}
          />
        </>
      ) : (
        <>
          <span className="font-medium">
            Chưa có mô hình nào được huấn luyện — bấm “Huấn luyện mô hình” ở cuối tab
          </span>
          <QuickNums
            items={[
              `${servingCount}/3 mô hình có bản serving`,
              `${nf0.format(data?.pendingSettles ?? 0)} phiếu chờ kết toán`,
            ]}
          />
        </>
      )}
    </QuickReadRow>
  );
}

/* ─────────────────── 4 · Mạng thần kinh ─────────────────── */

/** Tab Mạng thần kinh — kiến trúc + loss mới nhất (/api/ml/architecture + status). */
export function NetworkQuickRead() {
  const arch = useMlArchitecture();
  const status = useMlStatus();
  const mlp = arch.data?.mlp ?? null;
  const gru = status.data?.gru ?? null;
  const ready = !arch.isLoading && !arch.isError && arch.data != null;
  const gruNote = gru
    ? gru.enabled
      ? "GRU đang phục vụ"
      : `GRU shadow ${nf0.format(gru.shadowSettled)}/60 phiên`
    : "GRU chưa từng train";

  return (
    <QuickReadRow id="network" ready={ready && mlp != null} label="Mạng thần kinh">
      {!ready ? (
        <WaitingText>
          {arch.isLoading
            ? "Đang dựng sơ đồ mạng…"
            : "Không dựng được sơ đồ mạng — thử tải lại tab."}
        </WaitingText>
      ) : mlp ? (
        <>
          <span className="font-medium">
            Bản serving {mlp.archString} ({actLabels(mlp.activations)}) — {gruNote}
          </span>
          <QuickNums
            items={[
              `${nf0.format(mlp.paramCount)} tham số`,
              status.data?.dlMlp?.metrics.valLoss != null
                ? `loss xác thực ${nf2.format(status.data.dlMlp.metrics.valLoss)}`
                : null,
              `${nf0.format(arch.data?.features.count ?? mlp.arch.in)} đặc trưng vào`,
            ]}
          />
        </>
      ) : (
        <span className="font-medium">
          Chưa có bản serving — trình chỉnh sửa kiến trúc bên dưới vẫn hoạt động cho lần
          train kế tiếp
        </span>
      )}
    </QuickReadRow>
  );
}

/* ─────────────────── 5 · Thuật toán ─────────────────── */

/** Tab Thuật toán — số thuật toán (đối chiếu code) + bandit tốt nhất + cổng B2. */
export function AlgorithmsQuickRead() {
  const { data, isLoading, isError } = useMlStatus();
  const specs = buildAlgoSpecs(data);
  const ready = !isLoading && !isError;

  const arms = data?.bandit?.arms ?? [];
  const totalPulls = arms.reduce((sum, a) => sum + a.pulls, 0);
  const topArm =
    arms.length > 0
      ? [...arms].sort((a, b) => b.posteriorMean - a.posteriorMean)[0]
      : null;
  const banditText =
    arms.length === 0
      ? "bandit chưa có arm"
      : totalPulls === 0
        ? `bandit ${nf0.format(arms.length)} arm cùng prior 50% (chưa pull)`
        : `bandit tốt nhất ${topArm?.agentCode ?? "—"} · ${pct0(topArm?.posteriorMean)}`;
  const gate = data?.gate;
  const gateText =
    gate == null
      ? null
      : gate.available !== true
        ? "cổng B2 chưa đo"
        : `cổng B2 ${gate.verdict === "PASS" ? "MỞ (PASS)" : "CHƯA mở (FAIL)"}`;
  const rlq = data?.rlQ ?? null;

  return (
    <QuickReadRow id="algorithms" ready={ready} label="Thuật toán">
      {ready ? (
        <>
          <span className="font-medium">
            {nf0.format(specs.length)} thuật toán đang chạy thật trong code — hằng số
            đối chiếu từng file nguồn
          </span>
          <QuickNums
            items={[
              banditText,
              gateText,
              rlq ? `Q-learning ${nf0.format(rlq.metrics.episodes)} episodes` : null,
            ]}
          />
        </>
      ) : (
        <WaitingText>
          {isLoading
            ? "Đang tải trạng thái thuật toán…"
            : "Không tải được trạng thái — danh sách thuật toán dưới đây vẫn đối chiếu code."}
        </WaitingText>
      )}
    </QuickReadRow>
  );
}

/* ─────────────────── 6 · Dữ liệu ─────────────────── */

/** Tab Dữ liệu — độ phủ + quy mô kiến trúc (/api/ml/architecture + status). */
export function DataQuickRead() {
  const arch = useMlArchitecture();
  const status = useMlStatus();
  const ready = !arch.isLoading && !arch.isError && arch.data != null;
  const db = arch.data?.db;
  const rag = status.data?.rag ?? null;
  const newsGate = status.data?.newsGate ?? null;
  const intraday = status.data?.intraday ?? null;

  return (
    <QuickReadRow id="data" ready={ready} label="Dữ liệu">
      {!ready ? (
        <WaitingText>
          {arch.isLoading
            ? "Đang tải kiến trúc dữ liệu…"
            : "Không tải được kiến trúc dữ liệu — thử tải lại tab."}
        </WaitingText>
      ) : (
        <>
          <span className="font-medium">
            Dữ liệu chảy {nf0.format(arch.data?.pipeline.length ?? 0)} chặng từ nguồn
            tới quyết định
          </span>
          <QuickNums
            items={[
              db
                ? `${nf0.format(db.totalModels)} model · ${nf0.format(db.totalEnums)} enum DB`
                : null,
              rag
                ? `RAG corpus ${nf0.format(rag.corpusMessages + rag.corpusNews)} docs`
                : null,
              newsGate?.available === true
                ? `độ phủ lexicon tin ${pct1(newsGate.coveragePercent)}`
                : intraday && intraday.bars > 0
                  ? `${nf0.format(intraday.bars)} bar 5-phút`
                  : null,
            ]}
          />
        </>
      )}
    </QuickReadRow>
  );
}

/* ─────────────────── 7 · Tinh chỉnh ─────────────────── */

/**
 * Tab Tinh chỉnh — cấu hình hiệu lực + điểm score tốt nhất & lần sweep gần
 * nhất (champion sinh từ chính cấu hình này — /api/ml/sweep, API có sẵn).
 */
export function TuningQuickRead() {
  const tuning = useMlTuning();
  const sweep = useMlSweep();
  const ready = !tuning.isLoading && !tuning.isError && tuning.data != null;
  const eff = tuning.data?.effective.mlp;
  const latest = sweep.data?.runs[0] ?? null;
  const champion = latest?.champion ?? null;

  return (
    <QuickReadRow id="tuning" ready={ready} label="Tinh chỉnh">
      {!ready ? (
        <WaitingText>
          {tuning.isLoading
            ? "Đang tải cấu hình tinh chỉnh…"
            : "Không tải được cấu hình tinh chỉnh — thử tải lại tab."}
        </WaitingText>
      ) : (
        <>
          <span className="font-medium">
            Cấu hình hiệu lực:{" "}
            {eff
              ? `${nf0.format(eff.hidden.length)} lớp ẩn ${eff.hidden.join("-")} (${actLabels(eff.activations)})`
              : "—"}{" "}
            — áp dụng từ lần huấn luyện kế tiếp
          </span>
          <QuickNums
            items={[
              champion
                ? `điểm tốt nhất ${nf2.format(champion.score)} (${champion.tag})`
                : "chưa có đợt sweep nào",
              latest ? `lần sweep ${formatDateTime(latest.startedAt)}` : null,
              tuning.data?.updatedAt
                ? `lưu cấu hình ${formatDateTime(tuning.data.updatedAt)}`
                : "chưa từng ghi đè (mặc định code)",
            ]}
          />
        </>
      )}
    </QuickReadRow>
  );
}

/* ─────────────────── 8 · Tự động tìm kiếm ─────────────────── */

/** Tab Tự động tìm kiếm — kịch bản tốt nhất + tiến độ (/api/ml/sweep). */
export function AutomlQuickRead() {
  const sweep = useMlSweep();
  const ready = !sweep.isLoading && !sweep.isError && sweep.data != null;
  const runs = sweep.data?.runs ?? [];
  const latest = runs[0] ?? null;
  const champion = latest?.champion ?? null;

  return (
    <QuickReadRow id="automl" ready={ready && latest != null} label="Tự động tìm kiếm">
      {!ready ? (
        <WaitingText>
          {sweep.isLoading
            ? "Đang tải trạng thái sweep…"
            : "Không tải được trạng thái sweep — thử tải lại tab."}
        </WaitingText>
      ) : latest == null ? (
        <WaitingText>
          Chưa có đợt sweep nào — đợt đầu tự chạy Chủ nhật 04:15 ICT hoặc bấm “Chạy đợt
          ngay” bên dưới.
        </WaitingText>
      ) : (
        <>
          <span className="font-medium">
            Kịch bản tốt nhất gần nhất:{" "}
            {champion
              ? `${champion.tag} (${champion.arch}) — ${
                  champion.swapProposed
                    ? "đã hoán đổi sang serving (qua cổng 4 điều kiện)"
                    : "chưa qua cổng 4 điều kiện, serving giữ nguyên"
                }`
              : "đợt gần nhất không có ứng viên sống nào"}
          </span>
          <QuickNums
            items={[
              champion ? `điểm ${nf2.format(champion.score)}` : null,
              champion ? `valAcc ${pct1(champion.valAcc)}` : null,
              `${nf0.format(runs.length)} đợt đã lưu`,
            ]}
          />
        </>
      )}
    </QuickReadRow>
  );
}
