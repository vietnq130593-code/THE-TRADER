"use client";

/**
 * ml/data-tab.tsx (#89) — tab "Dữ liệu & kiến trúc": dòng chảy dữ liệu 8 chặng
 * (nguồn → lưu trữ → đặc trưng → mô hình → ensemble → bandit → tổng hợp →
 * quyết định, số dòng sống) + trình duyệt 34 model Prisma (tìm kiếm · lọc
 * nhóm · mở chi tiết trường/quan hệ/index) + khối RAG & intraday (#83).
 *
 * Dữ liệu từ GET /api/ml/architecture — parse schema.prisma runtime + đếm
 * dòng CHÍNH XÁC (UNION ALL một truy vấn) — UI là CỬA SỔ vào DB thật.
 */

import * as React from "react";
import { ArrowDown, Database, Search, Table2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useMlArchitecture, useMlStatus, type MlDbModelInfo } from "@/hooks/use-ml";
import { formatDateTime } from "@/lib/format";
import { EmptyNote, nf0 } from "./shared";
import { RagIntradayBlock } from "./rag-intraday-block";
// C2-pipeline (#99 — ML_AUTOML_BLUEPRINT §5.1/Q4): khối tiến độ cổng dữ liệu
// "tin tức → đặc trưng v3-news22" — tự chín theo crawler RSS 15 phút/lần.
import { NewsGateBlock } from "./news-gate-block";

const GROUP_LABELS: Record<string, string> = {
  market: "Thị trường",
  agents: "Agent",
  trading: "Giao dịch",
  ml: "Học máy",
  ops: "Hệ thống",
};

function PipelineFlow({
  stages,
}: {
  stages: { id: string; title: string; items: { label: string; value: string }[] }[];
}) {
  return (
    <div className="flex flex-col gap-2" role="list" aria-label="Dòng chảy dữ liệu 8 chặng">
      {stages.map((stage, i) => (
        <React.Fragment key={stage.id}>
          <div
            role="listitem"
            className="rounded-lg border bg-muted/20 px-3.5 py-2.5"
          >
            <h4 className="text-xs font-semibold">{stage.title}</h4>
            <div className="mt-1.5 grid gap-1 sm:grid-cols-2 lg:grid-cols-4">
              {stage.items.map((item) => (
                <div key={item.label} className="min-w-0 rounded-md border bg-background/60 px-2 py-1">
                  <div className="truncate text-[10px] text-muted-foreground" title={item.label}>
                    {item.label}
                  </div>
                  <div className="truncate font-mono text-[11px] font-medium tabular-nums" title={item.value}>
                    {item.value}
                  </div>
                </div>
              ))}
            </div>
          </div>
          {i < stages.length - 1 && (
            <div className="flex justify-center" aria-hidden="true">
              <ArrowDown className="size-3.5 text-muted-foreground" />
            </div>
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

function ModelDetailDialog({
  model,
  onOpenChange,
}: {
  model: MlDbModelInfo | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={model != null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2 font-mono text-base">
            <Table2 className="size-4 text-muted-foreground" aria-hidden="true" />
            {model?.name ?? ""}
            {model && (
              <Badge variant="outline" className="text-[10px]">
                {GROUP_LABELS[model.group] ?? model.group}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            {model
              ? `${model.fields.length} trường · ${model.relations.length} quan hệ · ${model.indexes.length} ràng buộc index${model.rowCount != null ? ` · ${nf0.format(model.rowCount)} dòng` : ""}`
              : ""}
          </DialogDescription>
        </DialogHeader>
        {model && (
          <ScrollArea className="max-h-[60vh]">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-background/95 backdrop-blur">
                <tr className="text-left">
                  <th className="px-2 py-1.5 font-medium">Trường</th>
                  <th className="px-2 py-1.5 font-medium">Kiểu</th>
                  <th className="px-2 py-1.5 font-medium">Thuộc tính</th>
                </tr>
              </thead>
              <tbody>
                {model.fields.map((f) => (
                  <tr key={f.name} className="border-t">
                    <td className="px-2 py-1.5 font-mono">
                      {f.name}
                      {f.relation && (
                        <Badge variant="outline" className="ml-1.5 text-[9px] text-muted-foreground">
                          FK
                        </Badge>
                      )}
                    </td>
                    <td className="px-2 py-1.5 font-mono text-muted-foreground">{f.type}</td>
                    <td className="max-w-52 truncate px-2 py-1.5 font-mono text-[10px] text-muted-foreground" title={f.attrs}>
                      {f.attrs || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {model.indexes.length > 0 && (
              <div className="mt-3">
                <p className="text-[11px] font-medium">Chỉ mục &amp; ràng buộc</p>
                <div className="mt-1 flex flex-col gap-1">
                  {model.indexes.map((ix) => (
                    <code key={ix} className="rounded border bg-muted/40 px-2 py-1 font-mono text-[10px]">
                      {ix}
                    </code>
                  ))}
                </div>
              </div>
            )}
            {model.relations.length > 0 && (
              <div className="mt-3">
                <p className="text-[11px] font-medium">Quan hệ tới</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {model.relations.map((rel) => (
                    <Badge key={rel} variant="outline" className="font-mono text-[10px]">
                      {rel}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DbBrowser({
  models,
  approximate,
  countedAt,
}: {
  models: MlDbModelInfo[];
  approximate: boolean;
  countedAt: string;
}) {
  const [query, setQuery] = React.useState("");
  const [group, setGroup] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<MlDbModelInfo | null>(null);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return models.filter((m) => {
      if (group != null && m.group !== group) return false;
      if (q === "") return true;
      return (
        m.name.toLowerCase().includes(q) ||
        m.fields.some((f) => f.name.toLowerCase().includes(q))
      );
    });
  }, [models, query, group]);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-44 flex-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Tìm model hoặc trường…"
            className="h-9 pl-8 text-xs"
            aria-label="Tìm model hoặc trường trong schema"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button
            variant={group == null ? "secondary" : "outline"}
            size="sm"
            className="h-8 px-2.5 text-[11px]"
            aria-pressed={group == null}
            onClick={() => setGroup(null)}
          >
            Tất cả
          </Button>
          {Object.entries(GROUP_LABELS).map(([id, label]) => (
            <Button
              key={id}
              variant={group === id ? "secondary" : "outline"}
              size="sm"
              className="h-8 px-2.5 text-[11px]"
              aria-pressed={group === id}
              onClick={() => setGroup(group === id ? null : id)}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>

      <div className="max-h-96 overflow-y-auto custom-scrollbar rounded-lg border">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 bg-muted/90 backdrop-blur">
            <tr className="text-left">
              <th className="px-3 py-2 font-medium">Model</th>
              <th className="hidden px-3 py-2 font-medium sm:table-cell">Nhóm</th>
              <th className="px-3 py-2 font-medium">Trường</th>
              <th className="hidden px-3 py-2 font-medium sm:table-cell">Quan hệ</th>
              <th className="px-3 py-2 text-right font-medium">Số dòng</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((m) => (
              <tr
                key={m.name}
                className="cursor-pointer border-t transition-colors hover:bg-muted/40"
                onClick={() => setSelected(m)}
              >
                <td className="px-3 py-2 font-mono font-medium">{m.name}</td>
                <td className="hidden px-3 py-2 text-muted-foreground sm:table-cell">
                  {GROUP_LABELS[m.group] ?? m.group}
                </td>
                <td className="px-3 py-2 tabular-nums text-muted-foreground">{m.fields.length}</td>
                <td className="hidden px-3 py-2 tabular-nums text-muted-foreground sm:table-cell">
                  {m.relations.length}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {m.rowCount != null ? nf0.format(m.rowCount) : "—"}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                  Không tìm thấy model nào khớp “{query}”.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Bấm một model để xem đầy đủ trường · kiểu · chỉ mục · quan hệ. Số dòng{" "}
        {approximate ? "≈ (pg_stat — gần đúng)" : "chính xác (đếm trực tiếp)"} · đếm lúc{" "}
        {formatDateTime(countedAt)} · tự làm mới mỗi 2 phút.
      </p>

      <ModelDetailDialog model={selected} onOpenChange={(open) => !open && setSelected(null)} />
    </div>
  );
}

export function DataTab() {
  const arch = useMlArchitecture();
  const status = useMlStatus();
  const rag = status.data?.rag ?? null;
  const intraday = status.data?.intraday ?? null;
  const l2 = status.data?.l2 ?? null;
  const newsGate = status.data?.newsGate ?? null;

  if (arch.isLoading) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="h-48 w-full rounded-lg" />
        <Skeleton className="h-56 w-full rounded-lg" />
        <Skeleton className="h-32 w-full rounded-lg" />
      </div>
    );
  }

  if (arch.isError || arch.data == null) {
    return (
      <EmptyNote>
        Không tải được kiến trúc dữ liệu ({arch.error?.message ?? "API /api/ml/architecture chưa sẵn sàng"}) —
        thử tải lại tab.
      </EmptyNote>
    );
  }

  const { db, pipeline } = arch.data;

  return (
    <div className="flex flex-col gap-5">
      {/* Dòng chảy dữ liệu */}
      <section aria-labelledby="data-pipeline-heading" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id="data-pipeline-heading" className="flex items-center gap-2 text-sm font-semibold">
            <Database className="size-4 text-muted-foreground" aria-hidden="true" />
            Dòng chảy dữ liệu — từ nguồn tới quyết định
          </h3>
          <Badge variant="outline" className="text-[10px] text-muted-foreground">
            {pipeline.length} chặng
          </Badge>
        </div>
        <PipelineFlow stages={pipeline} />
      </section>

      {/* Kiến trúc DB */}
      <section aria-labelledby="data-db-heading" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id="data-db-heading" className="flex items-center gap-2 text-sm font-semibold">
            <Table2 className="size-4 text-muted-foreground" aria-hidden="true" />
            Kiến trúc cơ sở dữ liệu (Prisma · Supabase Postgres)
          </h3>
          <Badge variant="outline" className="text-[10px] text-muted-foreground">
            {nf0.format(db.totalModels)} model · {nf0.format(db.totalEnums)} enum
          </Badge>
          {db.approximate && (
            <Badge variant="outline" className="text-[10px] text-amber-700 dark:text-amber-400">
              số dòng ≈
            </Badge>
          )}
        </div>
        <DbBrowser models={db.models} approximate={db.approximate} countedAt={db.countedAt} />
      </section>

      {/* RAG + Intraday (#83) */}
      <section aria-label="Tri thức truy hồi và chuỗi 5 phút" className="flex flex-col gap-3">
        <RagIntradayBlock rag={rag} intraday={intraday} l2={l2} />
      </section>

      {/* C2-pipeline (#99) — cổng dữ liệu tin tức → đặc trưng */}
      <section aria-label="Cổng dữ liệu tin tức sang đặc trưng" className="flex flex-col gap-3">
        <NewsGateBlock newsGate={newsGate} />
      </section>
    </div>
  );
}
