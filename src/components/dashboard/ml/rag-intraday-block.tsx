"use client";

/**
 * ml/rag-intraday-block.tsx (#89 — tách từ ml-panel.tsx #83) — khối
 * "Tri thức truy hồi (L1) & chuỗi 5-phút" (tab Dữ liệu & kiến trúc).
 */

import { Database } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/format";
import type { MlIntradayStatus, MlRagStatus } from "@/hooks/use-ml";
import { nf0 } from "./shared";

export function RagIntradayBlock({
  rag,
  intraday,
}: {
  rag: MlRagStatus | null;
  intraday: MlIntradayStatus | null;
}) {
  return (
    <section aria-labelledby="ml-rag-heading" className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <h3
          id="ml-rag-heading"
          className="flex items-center gap-2 text-sm font-semibold"
        >
          <Database className="size-4 text-muted-foreground" aria-hidden="true" />
          Tri thức truy hồi (L1) &amp; chuỗi 5-phút
        </h3>
      </div>

      {/* L1 — BM25 RAG */}
      <div className="rounded-lg border bg-muted/20 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium">BM25 RAG (L1)</span>
          {rag ? (
            <Badge variant="outline" className="shrink-0 text-[10px] text-muted-foreground">
              corpus {nf0.format(rag.corpusMessages + rag.corpusNews)} docs
            </Badge>
          ) : (
            <Badge variant="outline" className="shrink-0 text-[10px] text-muted-foreground">
              chưa đo
            </Badge>
          )}
        </div>
        {rag ? (
          <>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              Corpus: {nf0.format(rag.corpusMessages)} tin broadcast (500 gần nhất) +{" "}
              {nf0.format(rag.corpusNews)} tin tức (200 gần nhất). Xếp hạng 0,7·BM25 +
              0,3·độ tươi (nửa đời 3 ngày) — top-8 tiêm prompt 5 agent nghiên cứu +
              Chủ tịch mỗi chu kỳ (≤1.200 token).
            </p>
            <p className="mt-1 text-[11px] tabular-nums leading-relaxed text-muted-foreground">
              30 ngày qua: {nf0.format(rag.retrievals30d)} lần truy hồi ·{" "}
              {rag.usageRate30d == null
                ? "chưa có mẫu"
                : `${(rag.usageRate30d * 100).toFixed(0)}% được tiêm prompt`}
              {rag.lastRetrievalAt
                ? ` · lần cuối ${formatDateTime(rag.lastRetrievalAt)}`
                : " · chưa từng truy hồi"}
              .
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              Cổng L3 (pgvector semantic) đo trên đây: ≥30 ngày + dùng ≥10% chu kỳ.
            </p>
          </>
        ) : (
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            Thống kê RAG chưa sẵn sàng (truy vấn lỗi — tự hồi phục, không chặn phần còn lại).
          </p>
        )}
      </div>

      {/* Intraday — bar 5-phút */}
      <div className="rounded-lg border border-dashed bg-muted/20 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium">Chuỗi intraday 5-phút</span>
          {intraday && intraday.bars > 0 ? (
            <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
              {nf0.format(intraday.bars)} bar
            </Badge>
          ) : (
            <Badge variant="outline" className="shrink-0 text-[10px] text-muted-foreground">
              chờ phiên giao dịch đầu tiên
            </Badge>
          )}
        </div>
        {intraday && intraday.bars > 0 ? (
          <p className="mt-1 text-[11px] tabular-nums leading-relaxed text-muted-foreground">
            {nf0.format(intraday.symbols)} mã · {nf0.format(intraday.tradingDays)} phiên ·
            phiên gần nhất {nf0.format(intraday.lastDayBars)} bar
            {intraday.lastBarAt ? ` · bar cuối ${formatDateTime(intraday.lastBarAt)}` : ""}
            {intraday.realtime > 0
              ? ` · ${nf0.format(intraday.realtime)} bar nguồn thật`
              : " · nguồn: mô phỏng quanh ref EOD thật"}
            .
          </p>
        ) : (
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            Tick 10s trong phiên được gom thành bar 5-phút (bucket kín tickCount ≥ 25).
            Tích luỹ từ phiên giao dịch kế tiếp — đủ dữ liệu sẽ re-đo cổng bằng chứng
            B2 cho lớp chuỗi GRU (B4).
          </p>
        )}
      </div>
    </section>
  );
}
