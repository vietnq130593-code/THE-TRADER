"use client";

/**
 * ml/nn-tab.tsx (#89) — tab "Mạng thần kinh": sơ đồ MLP vẽ từ arch + TRỌNG SỐ
 * THẬT của bản serving (GET /api/ml/architecture — mỗi cạnh = 1 trọng số W,
 * dày/mảnh theo |w|, xanh dương-tím? KHÔNG — xanh emerald = dương, đỏ rose =
 * âm), dòng chảy dữ liệu chạy từ trái sang phải (animation dash — tôn trọng
 * prefers-reduced-motion). Kèm sơ đồ GRU-24 (3 cổng) + công thức ensemble.
 *
 * Trung thực: bản serving v8 đang là arch 10-16-8-3 → vẽ đúng 10-16-8-3
 * (không vẽ "đẹp" 16-24-12-3). Không có bản serving → empty-state.
 */

import * as React from "react";
import { Brain, Info, Layers } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useMlArchitecture,
  useMlStatus,
  type MlMlpArchInfo,
  type MlGruArchInfo,
} from "@/hooks/use-ml";
import { formatDateTime } from "@/lib/format";
import { EmptyNote, nf0 } from "./shared";

/* ─────────────────── Hình học sơ đồ MLP ─────────────────── */

const VB_W = 680;
const VB_H = 400;
const TOP = 56; // chừa tiêu đề cột
const BOTTOM = 352; // chừa nhãn đầu ra
const COL_X = [120, 300, 470, 610];
const COL_HEAD = ["Đầu vào", "Lớp ẩn 1 (ReLU)", "Lớp ẩn 2 (ReLU)", "Đầu ra (softmax)"];
const OUT_LABELS = ["Tăng", "Đi ngang", "Giảm"];

interface NodePos {
  x: number;
  y: number;
}

function nodePositions(units: number, x: number): NodePos[] {
  const span = BOTTOM - TOP;
  const gap = units > 1 ? span / (units - 1) : 0;
  const y0 = units > 1 ? TOP : (TOP + BOTTOM) / 2;
  return Array.from({ length: units }, (_, i) => ({ x, y: y0 + i * gap }));
}

function radiusFor(units: number): number {
  const gap = units > 1 ? (BOTTOM - TOP) / (units - 1) : 20;
  return Math.max(2.6, Math.min(6, gap * 0.36));
}

/** Cạnh nối 2 cột — tham số hoá theo trọng số thật (dày/mảnh + màu dấu). */
interface EdgeSpec {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  w: number;
  title: string;
}

function buildEdges(
  from: NodePos[],
  to: NodePos[],
  W: number[] | undefined,
  wTitle: (j: number, k: number) => string
): EdgeSpec[] {
  const edges: EdgeSpec[] = [];
  const useWeights = Array.isArray(W) && W.length === to.length * from.length;
  for (let j = 0; j < to.length; j++) {
    for (let k = 0; k < from.length; k++) {
      const w = useWeights ? (W as number[])[j * from.length + k] : 0;
      edges.push({
        x1: from[k].x,
        y1: from[k].y,
        x2: to[j].x,
        y2: to[j].y,
        w,
        title: wTitle(j, k),
      });
    }
  }
  return edges;
}

/** Giảm số cạnh vẽ khi mạng lớn (vẫn đúng cấu trúc — ghi chú rõ trên UI). */
function subsample<T>(items: T[], cap: number): { items: T[]; stride: number } {
  if (items.length <= cap) return { items, stride: 1 };
  const stride = Math.ceil(items.length / cap);
  return { items: items.filter((_, i) => i % stride === 0), stride };
}

const EDGE_CAP = 1400;

/** Vẽ một lớp cạnh — chuẩn hoá |w| theo max lớp để dày/mảnh tương đối.
 *  (component khai báo ngoài render — react-hooks/static-components). */
function EdgeGroup({ edges }: { edges: EdgeSpec[] }) {
  const wMax = Math.max(1e-9, ...edges.map((e) => Math.abs(e.w)));
  return (
    <g className="nn-edges">
      {edges.map((e, i) => {
        const mag = Math.abs(e.w) / wMax;
        return (
          <line
            key={i}
            x1={e.x1}
            y1={e.y1}
            x2={e.x2}
            y2={e.y2}
            strokeWidth={0.35 + 1.9 * mag}
            strokeOpacity={0.22 + 0.6 * mag}
            className={e.w >= 0 ? "stroke-emerald-500" : "stroke-rose-500"}
          >
            <title>{e.title}</title>
          </line>
        );
      })}
    </g>
  );
}

function DiagramNode({ p, r, cls }: { p: NodePos; r: number; cls: string }) {
  return <circle cx={p.x} cy={p.y} r={r} className={cls} />;
}

function MlpDiagram({ mlp }: { mlp: MlMlpArchInfo }) {
  const { arch, featureNames, weights } = mlp;

  const geometry = React.useMemo(() => {
    const inPos = nodePositions(arch.in, COL_X[0]);
    const h1Pos = nodePositions(arch.h1, COL_X[1]);
    const h2Pos = nodePositions(arch.h2, COL_X[2]);
    const outPos = nodePositions(arch.out, COL_X[3]);
    const e1 = buildEdges(inPos, h1Pos, weights?.W1, (j, k) => `W¹[${j},${k}] = ${weights?.W1?.[j * arch.in + k] ?? "—"} — ${featureNames[k] ?? `x[${k}]`} → ẩn1.${j}`);
    const e2 = buildEdges(h1Pos, h2Pos, weights?.W2, (j, k) => `W²[${j},${k}] = ${weights?.W2?.[j * arch.h1 + k] ?? "—"} — ẩn1.${k} → ẩn2.${j}`);
    const e3 = buildEdges(h2Pos, outPos, weights?.W3, (j, k) => `W³[${j},${k}] = ${weights?.W3?.[j * arch.h2 + k] ?? "—"} — ẩn2.${k} → ${OUT_LABELS[j] ?? j}`);
    return { inPos, h1Pos, h2Pos, outPos, e1, e2, e3 };
  }, [arch, weights, featureNames]);

  const totalEdges = geometry.e1.length + geometry.e2.length + geometry.e3.length;
  const s1 = subsample(geometry.e1, Math.floor(EDGE_CAP / 3));
  const s2 = subsample(geometry.e2, Math.floor(EDGE_CAP / 3));
  const s3 = subsample(geometry.e3, Math.floor(EDGE_CAP / 3));
  const drawn = s1.items.length + s2.items.length + s3.items.length;

  const rIn = radiusFor(arch.in);
  const rH1 = radiusFor(arch.h1);
  const rH2 = radiusFor(arch.h2);
  const rOut = 8;

  return (
    <div className="overflow-x-auto custom-scrollbar">
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        className="min-w-[560px] max-w-full"
        role="img"
        aria-label={`Sơ đồ mạng MLP ${mlp.archString} — trọng số thật bản serving v${mlp.version}`}
      >
        <style>{`@keyframes nnflow { to { stroke-dashoffset: -44; } }
.nn-edges line { stroke-dasharray: 5 7; animation: nnflow 2.4s linear infinite; }
@media (prefers-reduced-motion: reduce) { .nn-edges line { animation: none; } }`}</style>

        {/* Tiêu đề cột */}
        {COL_X.map((x, i) => (
          <text
            key={x}
            x={x}
            y={30}
            textAnchor="middle"
            className="fill-muted-foreground text-[11px] font-medium"
          >
            {COL_HEAD[i]}
          </text>
        ))}
        {[arch.in, arch.h1, arch.h2, arch.out].map((u, i) => (
          <text
            key={`u-${i}`}
            x={COL_X[i]}
            y={45}
            textAnchor="middle"
            className="fill-muted-foreground text-[10px] tabular-nums"
          >
            {u} nơ-rôn
          </text>
        ))}

        {/* Cạnh (vẽ trước — nơ-rôn đè lên) */}
        <EdgeGroup edges={s1.items} />
        <EdgeGroup edges={s2.items} />
        <EdgeGroup edges={s3.items} />

        {/* Nơ-rôn */}
        {geometry.inPos.map((p, k) => (
          <g key={`in-${k}`}>
            <circle cx={p.x} cy={p.y} r={rIn} className="fill-muted-foreground stroke-background" strokeWidth={1}>
              <title>{`x[${k}] ${featureNames[k] ?? ""} — đặc trưng chuẩn hoá z-score`}</title>
            </circle>
            <text
              x={p.x - rIn - 6}
              y={p.y + 3}
              textAnchor="end"
              className="fill-muted-foreground text-[7.5px]"
            >
              {(featureNames[k] ?? `x[${k}]`).slice(0, 22)}
            </text>
          </g>
        ))}
        {geometry.h1Pos.map((p, j) => (
          <g key={`h1-${j}`}>
            <DiagramNode p={p} r={rH1} cls="fill-primary/70 stroke-primary" />
            <title>{`Nơ-rôn ẩn 1.${j} — ReLU(W¹·x + b¹)[${j}], thiên lệch b¹=${weights?.b1?.[j] ?? "—"}`}</title>
          </g>
        ))}
        {geometry.h2Pos.map((p, j) => (
          <g key={`h2-${j}`}>
            <DiagramNode p={p} r={rH2} cls="fill-primary/70 stroke-primary" />
            <title>{`Nơ-rôn ẩn 2.${j} — ReLU(W²·h1 + b²)[${j}], thiên lệch b²=${weights?.b2?.[j] ?? "—"}`}</title>
          </g>
        ))}
        {geometry.outPos.map((p, j) => (
          <g key={`out-${j}`}>
            <circle cx={p.x} cy={p.y} r={rOut} className="fill-primary stroke-primary-foreground" strokeWidth={1.5}>
              <title>{`softmax lớp ${OUT_LABELS[j]} — W³·h2 + b³[${j}], thiên lệch b³=${weights?.b3?.[j] ?? "—"}`}</title>
            </circle>
            <text
              x={p.x + rOut + 6}
              y={p.y + 3.5}
              className="fill-foreground text-[9.5px] font-medium"
            >
              {OUT_LABELS[j] ?? `lớp ${j}`}
            </text>
          </g>
        ))}

        {/* Mũi tên dòng chảy tổng */}
        <g>
          <line x1={COL_X[0] + 14} y1={376} x2={COL_X[3] - 18} y2={376} className="stroke-muted-foreground" strokeWidth={1} markerEnd="url(#nnarrow)" />
          <text x={(COL_X[0] + COL_X[3]) / 2} y={392} textAnchor="middle" className="fill-muted-foreground text-[9px]">
            hướng dòng chảy dữ liệu: đặc trưng → ẩn 1 → ẩn 2 → xác suất 3 lớp
          </text>
          <defs>
            <marker id="nnarrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" className="fill-muted-foreground" />
            </marker>
          </defs>
        </g>
      </svg>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
        Mỗi cạnh = 1 trọng số thật của bản serving (di chuột lên nơ-rôn/cạnh để
        xem giá trị) —{" "}
        <span className="text-emerald-600 dark:text-emerald-400">xanh: trọng số dương</span>{" · "}
        <span className="text-rose-600 dark:text-rose-400">đỏ: âm</span> · dày = |trọng số| lớn.
        {drawn < totalEdges
          ? ` Mạng lớn — vẽ ${nf0.format(drawn)}/${nf0.format(totalEdges)} cạnh đại diện (cấu trúc đúng 100%).`
          : ` Đủ ${nf0.format(totalEdges)} cạnh.`}
      </p>
    </div>
  );
}

/* ─────────────────── Sơ đồ GRU (schematic 3 cổng) ─────────────────── */

function GruDiagram({ gru }: { gru: MlGruArchInfo }) {
  const { in: IN, h: H, d: D, out: OUT, window } = gru.arch;
  const boxes = [
    {
      x: 16,
      w: 150,
      title: `Chuỗi vào`,
      lines: [`${window} phiên × ${IN} đặc trưng`, "z-score theo chiều đặc trưng"],
      params: "0",
    },
    {
      x: 210,
      w: 190,
      title: `Tế bào GRU ${H} nơ-rôn`,
      lines: ["cổng z — xoá (sigmoid)", "cổng r — cập nhật (sigmoid)", "hₜ — ứng viên (tanh)"],
      params: nf0.format(3 * (H * IN + H * H + H)),
    },
    {
      x: 444,
      w: 100,
      title: `Dense ${D}`,
      lines: ["ReLU", "Wd·h + bd"],
      params: nf0.format(D * H + D),
    },
    {
      x: 584,
      w: 80,
      title: `Ra ${OUT}`,
      lines: ["softmax"],
      params: nf0.format(OUT * D + OUT),
    },
  ];
  const y = 56;
  const h = 168;
  return (
    <div className="overflow-x-auto custom-scrollbar">
      <svg viewBox="0 0 680 260" className="min-w-[560px] max-w-full" role="img" aria-label="Sơ đồ kiến trúc GRU-24">
        {boxes.map((b, i) => {
          const next = boxes[i + 1];
          return (
            <g key={b.x}>
              <rect
                x={b.x}
                y={y}
                width={b.w}
                height={h}
                rx={10}
                className="fill-muted/40 stroke-muted-foreground/60"
                strokeWidth={1.2}
              />
              <text x={b.x + b.w / 2} y={y + 22} textAnchor="middle" className="fill-foreground text-[11px] font-semibold">
                {b.title}
              </text>
              {b.lines.map((line, li) => (
                <text
                  key={li}
                  x={b.x + b.w / 2}
                  y={y + 48 + li * 18}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[9px]"
                >
                  {line}
                </text>
              ))}
              <text x={b.x + b.w / 2} y={y + h - 12} textAnchor="middle" className="fill-muted-foreground text-[9px] tabular-nums">
                {b.params} tham số
              </text>
              {next && (
                <g>
                  <line
                    x1={b.x + b.w + 4}
                    y1={y + h / 2}
                    x2={next.x - 8}
                    y2={y + h / 2}
                    className="stroke-muted-foreground"
                    strokeWidth={1.4}
                    markerEnd="url(#gruarrow)"
                  />
                </g>
              )}
            </g>
          );
        })}
        {/* Vòng lặp thời gian trên tế bào GRU */}
        <path
          d={`M ${210 + 95} ${y - 10} C ${210 + 95} ${y - 34}, ${210 + 95} ${y - 34}, ${210 + 95} ${y - 10}`}
          className="stroke-muted-foreground"
          fill="none"
          strokeWidth={1.2}
          markerEnd="url(#gruarrow)"
        />
        <text x={210 + 95} y={y - 40} textAnchor="middle" className="fill-muted-foreground text-[9px]">
          lặp theo từng phiên t (BPTT viết tay)
        </text>
        <defs>
          <marker id="gruarrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" className="fill-muted-foreground" />
          </marker>
        </defs>
      </svg>
    </div>
  );
}

/* ─────────────────── Tab ─────────────────── */

export function NnTab() {
  const arch = useMlArchitecture();
  const status = useMlStatus();
  const gruEnabled = status.data?.gru?.enabled === true;
  const gru = arch.data?.gru;
  const ensemble = arch.data?.ensemble;
  const mlp = arch.data?.mlp ?? null;

  if (arch.isLoading) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="h-64 w-full rounded-lg" />
        <Skeleton className="h-40 w-full rounded-lg" />
      </div>
    );
  }

  if (arch.isError || arch.data == null) {
    return (
      <EmptyNote>
        Không dựng được sơ đồ mạng ({arch.error?.message ?? "API /api/ml/architecture chưa sẵn sàng"}) —
        thử tải lại tab.
      </EmptyNote>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {/* MLP */}
      <section aria-labelledby="nn-mlp-heading" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id="nn-mlp-heading" className="flex items-center gap-2 text-sm font-semibold">
            <Layers className="size-4 text-muted-foreground" aria-hidden="true" />
            MLP dự báo 5 phiên — kiến trúc &amp; trọng số thật
          </h3>
          {mlp ? (
            <>
              <Badge variant="secondary" className="font-mono text-[10px]">
                v{mlp.version}
              </Badge>
              <Badge variant="outline" className="font-mono text-[10px]">
                {mlp.archString}
              </Badge>
              <Badge variant="outline" className="text-[10px] text-muted-foreground">
                {nf0.format(mlp.paramCount)} tham số
              </Badge>
              <span className="ml-auto text-[11px] text-muted-foreground">
                serving · train {formatDateTime(mlp.trainedAt ?? "")}
              </span>
            </>
          ) : (
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              chưa có bản serving
            </Badge>
          )}
        </div>

        {mlp ? (
          <>
            <MlpDiagram mlp={mlp} />
            {/* Bảng lớp */}
            <div className="max-h-56 overflow-y-auto custom-scrollbar rounded-lg border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                  <tr className="text-left">
                    <th className="px-3 py-2 font-medium">Lớp</th>
                    <th className="px-3 py-2 font-medium">Nơ-rôn</th>
                    <th className="px-3 py-2 font-medium">Kích hoạt</th>
                    <th className="px-3 py-2 text-right font-medium">Tham số</th>
                    <th className="px-3 py-2 font-medium">Ghi chú</th>
                  </tr>
                </thead>
                <tbody>
                  {mlp.layers.map((layer) => (
                    <tr key={layer.name} className="border-t">
                      <td className="px-3 py-2 font-medium">{layer.name}</td>
                      <td className="px-3 py-2 tabular-nums">{layer.units}</td>
                      <td className="px-3 py-2">{layer.activation}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{nf0.format(layer.params)}</td>
                      <td className="px-3 py-2 text-muted-foreground">{layer.note}</td>
                    </tr>
                  ))}
                  <tr className="border-t bg-muted/30">
                    <td className="px-3 py-2 font-semibold" colSpan={3}>
                      Tổng (W + b)
                    </td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">
                      {nf0.format(mlp.paramCount)}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      lưu đầy đủ trong MlModel.weights (JSON)
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <EmptyNote>
            Chưa có bản MLP nào đang serving — bấm <strong>Huấn luyện</strong> ở tab
            Tổng quan, sau đó quay lại đây để xem trọng số.
          </EmptyNote>
        )}
      </section>

      {/* GRU */}
      {gru && (
        <section aria-labelledby="nn-gru-heading" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id="nn-gru-heading" className="flex items-center gap-2 text-sm font-semibold">
              <Brain className="size-4 text-muted-foreground" aria-hidden="true" />
              GRU-24 — giọng thứ ba (mô hình chuỗi)
            </h3>
            <Badge variant="outline" className="font-mono text-[10px]">
              {nf0.format(gru.paramCount)} tham số
            </Badge>
            {gru.version != null && (
              <Badge variant="outline" className="font-mono text-[10px]">
                v{gru.version} · {gru.status ?? "archived"}
              </Badge>
            )}
            <span className="ml-auto text-[11px] text-muted-foreground">{gru.note}</span>
          </div>
          <GruDiagram gru={gru} />
        </section>
      )}

      {/* Ensemble */}
      {ensemble && (
        <section aria-labelledby="nn-ens-heading" className="flex flex-col gap-2.5">
          <h3 id="nn-ens-heading" className="text-sm font-semibold">
            Kết hợp 3 giọng (ensemble.ts)
          </h3>
          <div className="rounded-lg border bg-muted/20 px-3 py-2.5 text-xs leading-relaxed">
            <p className="font-mono">
              điểm ={" "}
              {gruEnabled ? (
                <>
                  <span className="font-semibold">
                    {ensemble.threeVoice.mlp.toString().replace(".", ",")}·MLP
                  </span>{" "}
                  +{" "}
                  <span className="font-semibold">
                    {ensemble.threeVoice.gru.toString().replace(".", ",")}·GRU
                  </span>{" "}
                  +{" "}
                  <span className="font-semibold">
                    {ensemble.threeVoice.linreg.toString().replace(".", ",")}·linreg
                  </span>
                </>
              ) : (
                <>
                  <span className="font-semibold">
                    {ensemble.twoVoice.mlp.toString().replace(".", ",")}·MLP
                  </span>{" "}
                  +{" "}
                  <span className="font-semibold">
                    {ensemble.twoVoice.linreg.toString().replace(".", ",")}·linreg
                  </span>
                </>
              )}
              {"  ·  |điểm| < "}
              {ensemble.deadband.toString().replace(".", ",")} → Đi ngang
            </p>
            <p className="mt-1.5 text-muted-foreground">
              Dữ liệu chảy: rổ top-10 thanh khoản → {arch.data.features.count} đặc trưng{" "}
              {arch.data.features.setLabel} → 3 giọng dự báo (MLP softmax · GRU chuỗi ·
              hồi quy tuyến tính proj₅) → điểm −1…+1 → hướng rổ cho Bộ tổng hợp Bayes.
            </p>
            <p className="mt-1 flex items-start gap-1.5 text-[11px] text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              Đang dùng công thức{" "}
              {gruEnabled ? "3 giọng (GRU đang phục vụ)" : "2 giọng (GRU shadow/tắt)"} —
              bật/tắt giọng GRU ở tab Tinh chỉnh.
            </p>
          </div>
        </section>
      )}
    </div>
  );
}
