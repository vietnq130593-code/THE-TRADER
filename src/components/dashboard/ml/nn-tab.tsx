"use client";

/**
 * ml/nn-tab.tsx (#89 → #94 · Task 3) — tab "Mạng thần kinh" ĐẠI TU theo phàn
 * nàn trader: "không thể thêm bớt các lớp, chỉnh sửa số nơ-rôn, trọng số loss
 * từng đầu ra, siêu tham số khối train…".
 *
 * HAI khối chính:
 *  (1) SƠ ĐỒ MLP SERVING — cột TÍNH ĐỘNG theo số lớp (in + hidden[1..5] + out
 *      = 3..7 cột, viewBox rộng theo số cột). Mỗi cạnh = 1 trọng số W THẬT từ
 *      blocks của bản serving (API đã map định dạng cũ W1..b3 → blocks tương
 *      đương) — dày/mảnh theo |w|, emerald = dương · rose = âm, animation
 *      dòng chảy (tôn trọng prefers-reduced-motion), tooltip W[i,j]/bias từng
 *      nơ-rôn, subsample EDGE_CAP có ghi chú trung thực.
 *  (2) TRÌNH CHỈNH SỬA KIẾN TRÚC ANN — draft local khởi tạo từ "draft" của
 *      /api/ml/architecture (AppSetting ml-tuning hiệu lực): thêm/xoá lớp
 *      (1..5), stepper nơ-rôn từng lớp (2..96), Select activation từng lớp
 *      (ReLU/tanh/sigmoid), 3 ô trọng số loss [DOWN, FLAT, UP] (0,1..10),
 *      bảng tham số W+b sống + cảnh báo quá tham số hoá > 5.000, sơ đồ nháp
 *      SVG cập nhật ĐỘNG, Lưu kiến trúc (POST /api/ml/tuning), Đặt lại về
 *      mặc định, Huấn luyện ngay (hook useTrainMl — target dl-mlp; F-MLP-01
 *      · fixbug FB-4B: nút BỊ KHOÁ khi nháp chưa lưu — tránh train nhầm arch
 *      cũ đã lưu trong khi màn hình hiển thị bản nháp mới).
 *
 * Trung thực: bản serving giữ nguyên đến khi train lại qua serving-swap guard
 * (valAcc ≥ bản cũ) — ghi chú rõ trên UI. Không có bản serving → empty-state
 * nhưng trình chỉnh sửa vẫn hoạt động đầy đủ (cấu hình cho lần train kế tiếp).
 */

import * as React from "react";
import {
  AlertTriangle,
  Brain,
  GitCompareArrows,
  Info,
  Layers,
  Loader2,
  Minus,
  Network,
  Plus,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import {
  useMlArchitecture,
  useMlStatus,
  useSaveMlTuning,
  useTrainMl,
  type MlActivation,
  type MlArchDraft,
  type MlMlpArchInfo,
  type MlGruArchInfo,
} from "@/hooks/use-ml";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { EmptyNote, nf0 } from "./shared";

/* ─────────────────── Hằng số hình học + giới hạn ─────────────────── */

/** Kích thước cột theo chiều dọc — dùng cho CẢ sơ đồ serving lẫn nháp. */
const TOP = 56;
const BOTTOM = 352;
/** Khoảng cách ngang giữa 2 cột + lề trái phải (viewBox rộng theo số cột). */
const COL_GAP = 150;
const COL_X0 = 110;
/** Trần số cạnh vẽ (mạng lớn — cấu trúc vẫn đúng, có ghi chú). */
const EDGE_CAP = 1400;

/** Giới hạn trình chỉnh sửa (mirror MLP_ARCH_LIMITS backend — một ngữ nghĩa). */
const LIMITS = {
  minLayers: 1,
  maxLayers: 5,
  minNeurons: 2,
  maxNeurons: 96,
  lossWeightMin: 0.1,
  lossWeightMax: 10,
  lossWeightStep: 0.1,
  paramWarnThreshold: 5000,
  /** Mẫu EOD danh nghĩa để cảnh báo quá tham số hoá. */
  nominalSamples: 60_000,
} as const;

const ACT_LABEL: Record<MlActivation, string> = {
  relu: "ReLU",
  tanh: "tanh",
  sigmoid: "sigmoid",
};

const CLASS_LABELS: { label: string; tag: string; tone: string }[] = [
  { label: "Giảm", tag: "DOWN · class 0", tone: "text-rose-600 dark:text-rose-400" },
  { label: "Đi ngang", tag: "FLAT · class 1", tone: "text-amber-700 dark:text-amber-400" },
  { label: "Tăng", tag: "UP · class 2", tone: "text-emerald-600 dark:text-emerald-400" },
];

/** Mặc định trình chỉnh sửa — trùng MLP_ARCH_V2/MLP_TUNING_DEFAULT backend. */
const DEFAULT_HIDDEN: number[] = [24, 12];
const DEFAULT_ACTIVATIONS: MlActivation[] = ["relu", "relu"];
const DEFAULT_LOSS_WEIGHTS: [number, number, number] = [1, 1, 1];

/* ─────────────────── Hình học chung ─────────────────── */

interface NodePos {
  x: number;
  y: number;
}

function nodePositions(units: number, x: number, top: number, bottom: number): NodePos[] {
  const span = bottom - top;
  const gap = units > 1 ? span / (units - 1) : 0;
  const y0 = units > 1 ? top : (top + bottom) / 2;
  return Array.from({ length: units }, (_, i) => ({ x, y: y0 + i * gap }));
}

function radiusFor(units: number, top: number, bottom: number): number {
  const gap = units > 1 ? (bottom - top) / (units - 1) : 20;
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

/* ─────────────────── Sơ đồ MLP serving — cột động N-layer ─────────────────── */

function MlpDiagram({ mlp }: { mlp: MlMlpArchInfo }) {
  const { arch, activations, featureNames, weights, outputLabels } = mlp;
  const outLabels = React.useMemo(
    () => (outputLabels.length === 3 ? outputLabels : ["Giảm", "Đi ngang", "Tăng"]),
    [outputLabels]
  );

  const geometry = React.useMemo(() => {
    const sizes = [arch.in, ...arch.hidden, arch.out];
    const heads = [
      "Đầu vào",
      ...arch.hidden.map((_, i) => `Lớp ẩn ${i + 1} (${ACT_LABEL[activations[i] ?? "relu"]})`),
      "Đầu ra (softmax)",
    ];
    const xs = sizes.map((_, i) => COL_X0 + i * COL_GAP);
    const cols = sizes.map((units, i) => nodePositions(units, xs[i], TOP, BOTTOM));
    const groups: EdgeSpec[][] = [];
    for (let l = 0; l < sizes.length - 1; l++) {
      const fromUnits = sizes[l];
      const isLast = l + 1 === sizes.length - 1;
      const srcName = (k: number) =>
        l === 0 ? (featureNames[k] ?? `x[${k}]`) : `ẩn${l}.${k}`;
      const dstName = (j: number) => (isLast ? (outLabels[j] ?? `ra.${j}`) : `ẩn${l + 1}.${j}`);
      groups.push(
        buildEdges(cols[l], cols[l + 1], weights?.blocks?.[l]?.W, (j, k) => {
          const w = weights?.blocks?.[l]?.W?.[j * fromUnits + k];
          return `W${l + 1}[${j},${k}] = ${w ?? "—"} — ${srcName(k)} → ${dstName(j)}`;
        })
      );
    }
    return {
      sizes,
      heads,
      xs,
      cols,
      groups,
      vbW: COL_X0 * 2 + (sizes.length - 1) * COL_GAP,
      lastX: xs[xs.length - 1],
    };
  }, [arch, activations, weights, featureNames, outLabels]);

  const cap = Math.max(180, Math.floor(EDGE_CAP / geometry.groups.length));
  const sampled = geometry.groups.map((g) => subsample(g, cap));
  const totalEdges = geometry.groups.reduce((s, g) => s + g.length, 0);
  const drawn = sampled.reduce((s, g) => s + g.items.length, 0);
  const biasOf = (blockIdx: number, j: number): number | undefined =>
    weights?.blocks?.[blockIdx]?.b?.[j];

  return (
    <div className="overflow-x-auto custom-scrollbar">
      <svg
        viewBox={`0 0 ${geometry.vbW} 400`}
        className="min-w-[620px] max-w-full"
        role="img"
        aria-label={`Sơ đồ mạng MLP ${mlp.archString} — ${geometry.sizes.length} cột, trọng số thật bản serving v${mlp.version}`}
      >
        <style>{`@keyframes nnflow { to { stroke-dashoffset: -44; } }
.nn-edges line { stroke-dasharray: 5 7; animation: nnflow 2.4s linear infinite; }
@media (prefers-reduced-motion: reduce) { .nn-edges line { animation: none; } }`}</style>

        {/* Tiêu đề cột + số nơ-rôn — ĐỘNG theo số lớp */}
        {geometry.heads.map((head, i) => (
          <text
            key={`h-${i}`}
            x={geometry.xs[i]}
            y={30}
            textAnchor="middle"
            className="fill-muted-foreground text-[11px] font-medium"
          >
            {head}
          </text>
        ))}
        {geometry.sizes.map((u, i) => (
          <text
            key={`u-${i}`}
            x={geometry.xs[i]}
            y={45}
            textAnchor="middle"
            className="fill-muted-foreground text-[10px] tabular-nums"
          >
            {u} nơ-rôn
          </text>
        ))}

        {/* Cạnh (vẽ trước — nơ-rôn đè lên) */}
        {sampled.map((g, gi) => (
          <EdgeGroup key={`g-${gi}`} edges={g.items} />
        ))}

        {/* Nơ-rôn từng cột */}
        {geometry.cols.map((col, ci) => {
          // ci = 0 → vào · ci = sizes.length-1 → ra · còn lại lớp ẩn.
          const isInput = ci === 0;
          const isOutput = ci === geometry.sizes.length - 1;
          const hiddenIdx = ci - 1;
          const r = isOutput ? 8 : radiusFor(geometry.sizes[ci], TOP, BOTTOM);
          return col.map((p, j) => {
            if (isInput) {
              return (
                <g key={`n-${ci}-${j}`}>
                  <circle cx={p.x} cy={p.y} r={r} className="fill-muted-foreground stroke-background" strokeWidth={1}>
                    <title>{`x[${j}] ${featureNames[j] ?? ""} — đặc trưng chuẩn hoá z-score`}</title>
                  </circle>
                  <text
                    x={p.x - r - 6}
                    y={p.y + 3}
                    textAnchor="end"
                    className="fill-muted-foreground text-[7.5px]"
                  >
                    {(featureNames[j] ?? `x[${j}]`).slice(0, 22)}
                  </text>
                </g>
              );
            }
            if (isOutput) {
              return (
                <g key={`n-${ci}-${j}`}>
                  <circle cx={p.x} cy={p.y} r={r} className="fill-primary stroke-primary-foreground" strokeWidth={1.5}>
                    <title>{`softmax lớp ${outLabels[j] ?? j} — W·a + b[${j}], thiên lệch b=${biasOf(geometry.sizes.length - 2, j) ?? "—"}`}</title>
                  </circle>
                  <text
                    x={p.x + r + 6}
                    y={p.y + 3.5}
                    className="fill-foreground text-[9.5px] font-medium"
                  >
                    {outLabels[j] ?? `lớp ${j}`}
                  </text>
                </g>
              );
            }
            const act = ACT_LABEL[activations[hiddenIdx] ?? "relu"];
            return (
              <g key={`n-${ci}-${j}`}>
                <DiagramNode p={p} r={r} cls="fill-primary/70 stroke-primary" />
                <title>{`Nơ-rôn ẩn ${hiddenIdx + 1}.${j} — ${act}(W·a + b)[${j}], thiên lệch b=${biasOf(hiddenIdx, j) ?? "—"}`}</title>
              </g>
            );
          });
        })}

        {/* Mũi tên dòng chảy tổng */}
        <g>
          <line x1={geometry.xs[0] + 14} y1={376} x2={geometry.lastX - 18} y2={376} className="stroke-muted-foreground" strokeWidth={1} markerEnd="url(#nnarrow)" />
          <text x={(geometry.xs[0] + geometry.lastX) / 2} y={392} textAnchor="middle" className="fill-muted-foreground text-[9px]">
            hướng dòng chảy dữ liệu: đặc trưng {geometry.sizes.length - 2} lớp ẩn → xác suất 3 lớp
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

/* ─────────────────── Sơ đồ GRU (schematic 3 cổng — giữ nguyên #89) ─────────────────── */

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

/* ─────────────────── Sơ đồ NHÁP (trình chỉnh sửa — cấu trúc, không trọng số) ─────────────────── */

const DRAFT_TOP = 26;
const DRAFT_BOTTOM = 148;
const DRAFT_GAP = 118;
const DRAFT_X0 = 96;
const DRAFT_EDGE_CAP = 500;

function DraftDiagram({
  inUnits,
  hidden,
  activations,
}: {
  inUnits: number;
  hidden: number[];
  activations: MlActivation[];
}) {
  const geometry = React.useMemo(() => {
    const sizes = [inUnits, ...hidden, 3];
    const xs = sizes.map((_, i) => DRAFT_X0 + i * DRAFT_GAP);
    const cols = sizes.map((units, i) => nodePositions(units, xs[i], DRAFT_TOP, DRAFT_BOTTOM));
    const groups: EdgeSpec[][] = [];
    for (let l = 0; l < sizes.length - 1; l++) {
      groups.push(
        buildEdges(cols[l], cols[l + 1], undefined, () => "cạnh cấu trúc — không hiển thị trọng số")
      );
    }
    return {
      sizes,
      xs,
      cols,
      groups,
      vbW: DRAFT_X0 * 2 + (sizes.length - 1) * DRAFT_GAP,
    };
  }, [inUnits, hidden]);

  const cap = Math.max(120, Math.floor(DRAFT_EDGE_CAP / geometry.groups.length));
  const sampled = geometry.groups.map((g) => subsample(g, cap));

  return (
    <div className="overflow-x-auto custom-scrollbar rounded-lg border bg-background/60 p-2">
      <svg
        viewBox={`0 0 ${geometry.vbW} 200`}
        className={cn("max-w-full", geometry.sizes.length > 4 ? "min-w-[560px]" : "min-w-[420px]")}
        role="img"
        aria-label={`Sơ đồ nháp kiến trúc: ${inUnits} vào → ${hidden.join(" → ")} → 3 ra`}
      >
        {geometry.sizes.map((u, i) => {
          const head =
            i === 0
              ? `Vào ${u}`
              : i === geometry.sizes.length - 1
                ? "Ra 3"
                : `Ẩn ${i} · ${u} ${ACT_LABEL[activations[i - 1] ?? "relu"]}`;
          return (
            <text
              key={`dh-${i}`}
              x={geometry.xs[i]}
              y={14}
              textAnchor="middle"
              className="fill-muted-foreground text-[9px] font-medium"
            >
              {head}
            </text>
          );
        })}
        {sampled.map((g, gi) => (
          <g key={`dg-${gi}`} className="stroke-muted-foreground/25" strokeWidth={0.5}>
            {g.items.map((e, i) => (
              <line key={i} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} />
            ))}
          </g>
        ))}
        {geometry.cols.map((col, ci) => {
          const isOutput = ci === geometry.sizes.length - 1;
          const r = isOutput ? 7 : radiusFor(geometry.sizes[ci], DRAFT_TOP, DRAFT_BOTTOM);
          return col.map((p, j) =>
            isOutput ? (
              <g key={`dn-${ci}-${j}`}>
                <circle cx={p.x} cy={p.y} r={r} className="fill-primary stroke-primary-foreground" strokeWidth={1.2} />
                <text
                  x={p.x + r + 5}
                  y={p.y + 3}
                  className="fill-foreground text-[8.5px] font-medium"
                >
                  {CLASS_LABELS[j]?.label ?? j}
                </text>
              </g>
            ) : (
              <circle
                key={`dn-${ci}-${j}`}
                cx={p.x}
                cy={p.y}
                r={r}
                className={ci === 0 ? "fill-muted-foreground/70 stroke-background" : "fill-primary/60 stroke-primary/70"}
                strokeWidth={0.8}
              />
            )
          );
        })}
      </svg>
    </div>
  );
}

/* ─────────────────── Ô nhập số (commit khi rời ô / Enter — tự kẹp phạm vi) ─────────────────── */

function NumberCommitInput({
  value,
  min,
  max,
  step,
  onCommit,
  ariaLabel,
  className,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (v: number) => void;
  ariaLabel: string;
  className?: string;
}) {
  // Chỉ khởi tạo từ prop — caller đặt key={`…-${value}`} để remount khi value
  // đổi từ ngoài (stepper −/+ hoặc hydrate draft sau Lưu) — KHÔNG cần effect
  // sync state (tránh cascading render).
  const [text, setText] = React.useState(String(value));
  const commit = () => {
    const normalized = text.trim().replace(",", ".");
    const n = Number(normalized);
    if (normalized === "" || !Number.isFinite(n)) {
      setText(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, n));
    onCommit(clamped);
    setText(String(clamped));
  };
  return (
    <Input
      type="number"
      inputMode={step >= 1 ? "numeric" : "decimal"}
      min={min}
      max={max}
      step={step}
      value={text}
      aria-label={ariaLabel}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
      className={cn("h-11 text-center font-mono text-xs tabular-nums", className)}
    />
  );
}

/* ─────────────────── Dòng 1 lớp ẩn trong trình chỉnh sửa ─────────────────── */

function LayerRow({
  index,
  neurons,
  activation,
  canDelete,
  onNeurons,
  onActivation,
  onDelete,
}: {
  index: number;
  neurons: number;
  activation: MlActivation;
  canDelete: boolean;
  onNeurons: (n: number) => void;
  onActivation: (a: MlActivation) => void;
  onDelete: () => void;
}) {
  const id = `arch-act-${index}`;
  return (
    <div className="flex flex-wrap items-center gap-2.5 rounded-lg border bg-background/60 px-3 py-2.5 lg:flex-nowrap">
      <Badge variant="secondary" className="h-6 shrink-0 font-mono text-[10px]">
        Ẩn {index + 1}
      </Badge>
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-11"
          aria-label={`Bớt nơ-rôn lớp ẩn ${index + 1}`}
          disabled={neurons <= LIMITS.minNeurons}
          onClick={() => onNeurons(Math.max(LIMITS.minNeurons, neurons - 1))}
        >
          <Minus className="size-4" aria-hidden="true" />
        </Button>
        <NumberCommitInput
          key={`neuron-${index}-${neurons}`}
          value={neurons}
          min={LIMITS.minNeurons}
          max={LIMITS.maxNeurons}
          step={1}
          ariaLabel={`Số nơ-rôn lớp ẩn ${index + 1}`}
          onCommit={onNeurons}
          className="w-20"
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-11"
          aria-label={`Thêm nơ-rôn lớp ẩn ${index + 1}`}
          disabled={neurons >= LIMITS.maxNeurons}
          onClick={() => onNeurons(Math.min(LIMITS.maxNeurons, neurons + 1))}
        >
          <Plus className="size-4" aria-hidden="true" />
        </Button>
      </div>
      <span className="shrink-0 text-[10px] text-muted-foreground">nơ-rôn</span>
      <div className="flex min-w-36 flex-col gap-1">
        <Label htmlFor={id} className="text-[10px] font-medium text-muted-foreground">
          Kích hoạt
        </Label>
        <Select value={activation} onValueChange={(v) => onActivation(v as MlActivation)}>
          <SelectTrigger id={id} className="h-11 w-full font-mono text-xs" aria-label={`Hàm kích hoạt lớp ẩn ${index + 1}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="relu">ReLU</SelectItem>
            <SelectItem value="tanh">tanh</SelectItem>
            <SelectItem value="sigmoid">sigmoid</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="ml-auto size-11 shrink-0 border-rose-500/40 text-rose-600 hover:bg-rose-500/10 hover:text-rose-700 dark:text-rose-400"
        aria-label={`Xoá lớp ẩn ${index + 1}`}
        title={canDelete ? `Xoá lớp ẩn ${index + 1}` : "Phải giữ ít nhất 1 lớp ẩn"}
        disabled={!canDelete}
        onClick={onDelete}
      >
        <Trash2 className="size-4" aria-hidden="true" />
      </Button>
    </div>
  );
}

/* ─────────────────── Trình chỉnh sửa kiến trúc ANN (trái tim #94) ─────────────────── */

function ArchEditor({
  draft,
  featureCount,
}: {
  draft: MlArchDraft | null;
  featureCount: number;
}) {
  const save = useSaveMlTuning();
  const train = useTrainMl();

  const [hidden, setHidden] = React.useState<number[]>(draft?.arch.hidden ?? [...DEFAULT_HIDDEN]);
  const [activations, setActivations] = React.useState<MlActivation[]>(
    draft?.activations ?? [...DEFAULT_ACTIVATIONS]
  );
  const [lossWeights, setLossWeights] = React.useState<[number, number, number]>(
    draft?.lossWeights ?? [...DEFAULT_LOSS_WEIGHTS]
  );

  // Hydrate khi draft server đổi (sau Lưu → invalidate → refetch). KHÔNG đè
  // khi trader đang chỉnh mà draft không đổi (JSON key giữ nguyên).
  const lastHydrated = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!draft) return;
    const key = JSON.stringify([draft.arch.hidden, draft.activations, draft.lossWeights]);
    if (lastHydrated.current === key) return;
    lastHydrated.current = key;
    setHidden([...draft.arch.hidden]);
    setActivations([...draft.activations]);
    setLossWeights([...draft.lossWeights]);
  }, [draft]);

  const serverValues = draft
    ? [draft.arch.hidden, draft.activations, draft.lossWeights]
    : [DEFAULT_HIDDEN, DEFAULT_ACTIVATIONS, DEFAULT_LOSS_WEIGHTS];
  const dirty =
    JSON.stringify([hidden, activations, lossWeights]) !== JSON.stringify(serverValues);

  /* ── Thao tác lớp ── */
  const addLayer = () => {
    if (hidden.length >= LIMITS.maxLayers) return;
    setHidden((prev) => [...prev, 16]);
    setActivations((prev) => [...prev, "relu"]);
  };
  const removeLayer = (i: number) => {
    if (hidden.length <= LIMITS.minLayers) return;
    setHidden((prev) => prev.filter((_, x) => x !== i));
    setActivations((prev) => prev.filter((_, x) => x !== i));
  };
  const setNeurons = (i: number, n: number) =>
    setHidden((prev) => prev.map((v, x) => (x === i ? n : v)));
  const setActivation = (i: number, a: MlActivation) =>
    setActivations((prev) => prev.map((v, x) => (x === i ? a : v)));
  const setLossWeight = (idx: number, v: number) =>
    setLossWeights((prev) => prev.map((v0, x) => (x === idx ? v : v0)) as [number, number, number]);

  /* ── Bảng tham số sống ── */
  const paramRows = React.useMemo(() => {
    const rows: { name: string; shape: string; w: number; b: number }[] = [];
    let from = featureCount;
    hidden.forEach((h, i) => {
      rows.push({
        name: `Lớp ẩn ${i + 1} · ${ACT_LABEL[activations[i] ?? "relu"]}`,
        shape: `W ${h}×${from} + b ${h}`,
        w: h * from,
        b: h,
      });
      from = h;
    });
    rows.push({ name: "Lớp ra · softmax", shape: `W 3×${from} + b 3`, w: 3 * from, b: 3 });
    const total = rows.reduce((s, r) => s + r.w + r.b, 0);
    return { rows, total };
  }, [hidden, activations, featureCount]);
  const perParam = paramRows.total > 0 ? LIMITS.nominalSamples / paramRows.total : Infinity;
  const overParams = paramRows.total > LIMITS.paramWarnThreshold;

  /* ── Lưu / reset / train ── */
  const handleSave = () => {
    if (hidden.length < LIMITS.minLayers || hidden.length > LIMITS.maxLayers) {
      toast.error(`Số lớp ẩn phải ${LIMITS.minLayers}..${LIMITS.maxLayers}`);
      return;
    }
    if (hidden.some((h) => !Number.isInteger(h) || h < LIMITS.minNeurons || h > LIMITS.maxNeurons)) {
      toast.error(`Nơ-rôn mỗi lớp phải trong [${LIMITS.minNeurons} – ${LIMITS.maxNeurons}]`);
      return;
    }
    if (activations.length !== hidden.length) {
      toast.error("Số activation phải khớp số lớp ẩn");
      return;
    }
    if (lossWeights.some((w) => w < LIMITS.lossWeightMin || w > LIMITS.lossWeightMax)) {
      toast.error(`Trọng số loss phải trong [${LIMITS.lossWeightMin} – ${LIMITS.lossWeightMax}]`);
      return;
    }
    save.mutate({ mlp: { hidden: [...hidden], activations: [...activations], lossWeights: [...lossWeights] } });
  };
  const handleReset = () => {
    setHidden([...DEFAULT_HIDDEN]);
    setActivations([...DEFAULT_ACTIVATIONS]);
    setLossWeights([...DEFAULT_LOSS_WEIGHTS]);
    toast.info("Đã đặt nháp về mặc định 16-24-12-3 (relu, loss 1·1·1) — bấm Lưu kiến trúc để ghi.");
  };

  const archLabel = `${featureCount}-${hidden.join("-")}-3`;

  return (
    <section
      aria-labelledby="arch-editor-heading"
      className="flex flex-col gap-3.5 rounded-lg border bg-muted/20 px-3.5 py-3.5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground" aria-hidden="true">
          <Network className="size-4" />
        </span>
        <h4 id="arch-editor-heading" className="text-sm font-semibold">
          Kiến trúc ANN — trình chỉnh sửa
        </h4>
        {dirty ? (
          <Badge variant="outline" className="text-[10px] text-amber-700 dark:text-amber-400">
            chưa lưu
          </Badge>
        ) : (
          <Badge variant="outline" className="text-[10px] text-muted-foreground">
            khớp cấu hình hiệu lực
          </Badge>
        )}
        <Badge variant="outline" className="ml-auto font-mono text-[10px]">
          {archLabel}
        </Badge>
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Thêm/bớt lớp ẩn ({LIMITS.minLayers}..{LIMITS.maxLayers} lớp), chỉnh số nơ-rôn từng lớp
        ({LIMITS.minNeurons}..{LIMITS.maxNeurons}) và hàm kích hoạt riêng từng lớp, trọng số loss
        từng đầu ra. Sơ đồ nháp dưới đây cập nhật theo ngay lập tức.
      </p>

      {/* Sơ đồ nháp — cấu trúc động, không trọng số */}
      <DraftDiagram inUnits={featureCount} hidden={hidden} activations={activations} />

      {/* Danh sách lớp */}
      <div className="flex flex-col gap-2">
        {hidden.map((neurons, i) => (
          <LayerRow
            key={`layer-${i}`}
            index={i}
            neurons={neurons}
            activation={activations[i] ?? "relu"}
            canDelete={hidden.length > LIMITS.minLayers}
            onNeurons={(n) => setNeurons(i, n)}
            onActivation={(a) => setActivation(i, a)}
            onDelete={() => removeLayer(i)}
          />
        ))}
        <Button
          type="button"
          variant="outline"
          className="min-h-11 w-full gap-2 border-dashed"
          disabled={hidden.length >= LIMITS.maxLayers}
          onClick={addLayer}
          aria-label="Thêm lớp ẩn mới (16 nơ-rôn ReLU) sau lớp cuối"
        >
          <Plus className="size-4" aria-hidden="true" />
          Thêm lớp ẩn (16 nơ-rôn ReLU)
          <span className="text-[10px] text-muted-foreground">
            {hidden.length}/{LIMITS.maxLayers} lớp
          </span>
        </Button>
      </div>

      {/* Trọng số loss từng đầu ra — [DOWN, FLAT, UP] */}
      <div className="flex flex-col gap-2 rounded-lg border bg-background/60 px-3 py-3">
        <div className="flex flex-wrap items-baseline gap-2">
          <h5 className="text-xs font-semibold">Trọng số loss từng đầu ra</h5>
          <span className="text-[10px] text-muted-foreground">
            thứ tự class [DOWN · FLAT · UP] — nhân với class-weight tự động 1/tần suất
          </span>
        </div>
        <div className="grid grid-cols-3 gap-2.5">
          {CLASS_LABELS.map((c, idx) => (
            <div key={c.tag} className="flex flex-col gap-1">
              <Label
                htmlFor={`lossw-${idx}`}
                className={cn("text-[11px] font-semibold", c.tone)}
              >
                {c.label}
                <span className="ml-1 font-mono text-[9px] font-normal text-muted-foreground">
                  {c.tag}
                </span>
              </Label>
              <NumberCommitInput
                key={`lossw-${idx}-${lossWeights[idx]}`}
                value={lossWeights[idx] ?? 1}
                min={LIMITS.lossWeightMin}
                max={LIMITS.lossWeightMax}
                step={LIMITS.lossWeightStep}
                ariaLabel={`Trọng số loss đầu ra ${c.label}`}
                onCommit={(v) => setLossWeight(idx, v)}
              />
            </div>
          ))}
        </div>
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          Tăng trọng số của một đầu ra khiến mô hình chịu phạt nặng hơn khi đoán
          sai hướng đó (ví dụ tăng “Giảm” để né bought-the-top). Tổng quá cao so
          với các lớp khác làm loss lệch — nên đổi dần 0,1..0,5 mỗi lần train.
        </p>
      </div>

      {/* Bảng tham số sống */}
      <div className="overflow-x-auto custom-scrollbar rounded-lg border">
        <table className="w-full text-xs">
          <caption className="sr-only">
            Bảng tham số W + b tính động theo kiến trúc đang chỉnh
          </caption>
          <thead className="bg-muted/80 backdrop-blur">
            <tr className="text-left">
              <th className="px-3 py-2 font-medium">Khối</th>
              <th className="px-3 py-2 font-medium">Kích thước</th>
              <th className="px-3 py-2 text-right font-medium">W</th>
              <th className="px-3 py-2 text-right font-medium">b</th>
              <th className="px-3 py-2 text-right font-medium">Tổng</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t">
              <td className="px-3 py-2 font-medium">Lớp vào</td>
              <td className="px-3 py-2 font-mono text-[10px] text-muted-foreground">
                {featureCount} đặc trưng z-score
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">—</td>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">—</td>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">0</td>
            </tr>
            {paramRows.rows.map((r) => (
              <tr key={r.name} className="border-t">
                <td className="px-3 py-2 font-medium">{r.name}</td>
                <td className="px-3 py-2 font-mono text-[10px] text-muted-foreground">{r.shape}</td>
                <td className="px-3 py-2 text-right tabular-nums">{nf0.format(r.w)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{nf0.format(r.b)}</td>
                <td className="px-3 py-2 text-right tabular-nums font-medium">
                  {nf0.format(r.w + r.b)}
                </td>
              </tr>
            ))}
            <tr className="border-t bg-muted/30">
              <td className="px-3 py-2 font-semibold" colSpan={4}>
                Tổng tham số (W + b)
              </td>
              <td className="px-3 py-2 text-right font-semibold tabular-nums">
                {nf0.format(paramRows.total)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      {overParams ? (
        <p
          role="alert"
          className="flex items-start gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {nf0.format(paramRows.total)} tham số — QUÁ THAM SỐ HOÁ so ~{nf0.format(LIMITS.nominalSamples)} mẫu
          EOD (≈{perParam < 10 ? perParam.toFixed(1).replace(".", ",") : nf0.format(Math.round(perParam))} mẫu/tham số).
          Cân nhắc giảm bớt nơ-rôn hoặc thêm L2 weight decay ở tab Tinh chỉnh.
        </p>
      ) : (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          ≈{nf0.format(Math.round(perParam))} mẫu/tham số trên ~{nf0.format(LIMITS.nominalSamples)} mẫu
          EOD — vùng an toàn (dưới ngưỡng {nf0.format(LIMITS.paramWarnThreshold)} tham số).
        </p>
      )}

      {/* Hyper hiệu lực (chỉnh ở tab Tinh chỉnh) */}
      {draft && (
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          Hyper huấn luyện hiện hành: {nf0.format(draft.hyper.epochs)} epoch · patience{" "}
          {nf0.format(draft.hyper.patience)} · batch {nf0.format(draft.hyper.batchSize)} · lr{" "}
          {draft.hyper.lr.toString().replace(".", ",")} · L2 {draft.hyper.l2.toString().replace(".", ",")} ·
          val {draft.hyper.valFraction.toString().replace(".", ",")} · seed {nf0.format(draft.hyper.seed)}
          {draft.featureSet != null ? ` · bộ đặc trưng ${draft.featureSet}` : ""} —
          chỉnh ở tab <strong>Tinh chỉnh</strong>.
        </p>
      )}

      {/* Hành động */}
      <div className="flex flex-wrap items-center gap-2.5 border-t pt-3">
        <Button
          onClick={handleSave}
          disabled={!dirty || save.isPending || train.isPending}
          className="min-h-11 gap-2"
        >
          {save.isPending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Save className="size-4" aria-hidden="true" />
          )}
          {save.isPending ? "Đang lưu…" : "Lưu kiến trúc"}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 gap-2"
          onClick={handleReset}
          disabled={save.isPending || train.isPending}
        >
          <RotateCcw className="size-4" aria-hidden="true" />
          Đặt lại về mặc định
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="min-h-11 gap-2"
          onClick={() => train.mutate("dl-mlp")}
          disabled={dirty || save.isPending || train.isPending}
          title={
            dirty
              ? "Kiến trúc chưa lưu — bấm “Lưu kiến trúc” trước để bản huấn luyện dùng đúng cấu hình đang chỉnh (F-MLP-01)"
              : "Huấn luyện lại MLP với kiến trúc đang lưu (AppSetting ml-tuning) trên dữ liệu EOD thật"
          }
        >
          {train.isPending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Zap className="size-4" aria-hidden="true" />
          )}
          {train.isPending ? "Đang huấn luyện…" : "Huấn luyện ngay"}
        </Button>
      </div>
      {dirty && (
        <p className="text-[11px] font-medium text-amber-700 dark:text-amber-400">
          Kiến trúc chưa lưu — nút Huấn luyện bị khoá đến khi lưu; bấm “Lưu kiến
          trúc” để bản train dùng đúng cấu hình này (F-MLP-01).
        </p>
      )}
      <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        Áp dụng từ lần huấn luyện KẾ TIẾP; bản serving giữ nguyên đến khi train
        lại và qua serving-swap guard (valAcc ≥ bản cũ) — meta bản train ghi rõ
        arch + activations + hyper đã dùng để truy vết.
      </p>
    </section>
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
  const draft = arch.data?.draft ?? null;
  // F-18 (#131): trình chỉnh sửa dùng chiều vào của DRAFT (theo featureSet
  // ml-tuning — NAS đồng bộ v3-macro → 24) thay vì features.count tĩnh của
  // code (luôn 16) — sơ đồ nháp + bảng tham số khớp đúng cấu hình champion.
  const featureCount = draft?.arch.in ?? arch.data?.features.count ?? 16;
  /** F-18 (#131): banner nguồn gốc thiết lập (NAS sweep đồng bộ tự động). */
  const nasSource = draft?.source ?? null;

  if (arch.isLoading) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="h-64 w-full rounded-lg" />
        <Skeleton className="h-80 w-full rounded-lg" />
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
      {/* MLP serving — sơ đồ trọng số thật */}
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
              <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground">
                {mlp.activations.map((a) => ACT_LABEL[a] ?? a).join(" · ")}
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

        {/* F-18B (#132): caption phân vai — bản serving là mô hình ĐANG dự báo,
            trình chỉnh sửa bên dưới là cấu hình lần train KẾ TIẾP (hai đối tượng
            khác nhau — nguyên nhân “kiến trúc khác hẳn” mà chủ sở hữu thấy). */}
        {mlp && (
          <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            Bản này đang trực tiếp dự báo 5 phiên (đưa vào ensemble + prompt
            agents) — được huấn luyện lần cuối {formatDateTime(mlp.trainedAt ?? "")}.
            Trình chỉnh sửa bên dưới là cấu hình cho lần huấn luyện kế tiếp,
            hai phần khác kiến trúc là bình thường — xem dải đối chiếu dưới
            bảng lớp.
          </p>
        )}

        {mlp ? (
          <>
            <MlpDiagram mlp={mlp} />
            {/* Bảng lớp — động theo số lớp từ API */}
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
                      lưu đầy đủ trong MlModel.weights (JSON blocks)
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <EmptyNote>
            Chưa có bản MLP nào đang serving — bấm <strong>Huấn luyện ngay</strong>{" "}
            ở trình chỉnh sửa bên dưới (hoặc nút Huấn luyện ở tab Tổng quan), sau
            đó quay lại đây để xem trọng số.
          </EmptyNote>
        )}
      </section>

      {/* F-18B (#132): dải đối chiếu serving ↔ bản nháp — trả lời trực tiếp
          câu hỏi “số nơ-rôn ML dự báo 5 phiên khác hẳn trình chỉnh sửa, hai
          phần này sẽ luôn khác nhau à?”: khác là ĐÚNG THIẾT KẾ cho tới khi
          champion qua cổng (NAS đồng bộ cả hai) hoặc train tay qua guard. */}
      {mlp != null && draft != null && mlp.archString !== draft.archString ? (
        <div
          className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5"
          role="status"
          aria-label="Đối chiếu kiến trúc serving và bản nháp"
        >
          <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-800 dark:text-amber-300">
            <GitCompareArrows className="size-4 shrink-0" aria-hidden="true" />
            Hai kiến trúc đang khác nhau — đúng thiết kế, không phải lỗi
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-lg border bg-background/60 px-3 py-2">
              <p className="text-[11px] font-semibold">
                Đang phục vụ — dự báo 5 phiên
              </p>
              <p className="mt-0.5 font-mono text-sm font-semibold">
                v{mlp.version} · {mlp.archString}
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                Train cuối {formatDateTime(mlp.trainedAt ?? "")} · chỉ đổi khi
                champion qua cổng 4 điều kiện (tab Tự động tìm kiếm) hoặc train
                lại qua serving-swap guard (valAcc ≥ bản cũ).
              </p>
            </div>
            <div className="rounded-lg border bg-background/60 px-3 py-2">
              <p className="text-[11px] font-semibold">
                Bản nháp — lần huấn luyện kế tiếp
              </p>
              <p className="mt-0.5 font-mono text-sm font-semibold">
                {draft.archString}
                {draft.featureSet != null ? ` · ${draft.featureSet}` : ""}
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                Áp dụng khi bấm “Huấn luyện ngay” hoặc retrain Chủ nhật 04:00
                ICT; NAS champion qua cổng sẽ ghi đè cấu hình này tự động.
              </p>
            </div>
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Hai phần hội tụ về cùng một kiến trúc khi champion qua cổng
            (serving được hoán đổi + thiết lập được NAS ghi tự động — F-18) hoặc
            khi bản train tay qua guard. Kết quả tính toán của các đợt tìm kiếm
            (điểm, Brier, ΔBrier CI, toàn bộ ứng viên kể cả thua) hiển thị công
            khai ở tab <strong>Tự động tìm kiếm — Champion board</strong>.
          </p>
        </div>
      ) : mlp != null && draft != null && mlp.archString === draft.archString ? (
        <p
          className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[11px] leading-relaxed text-emerald-700 dark:text-emerald-400"
          role="status"
        >
          <GitCompareArrows className="size-4 shrink-0" aria-hidden="true" />
          Serving v{mlp.version} và bản nháp cùng kiến trúc {mlp.archString} —
          lần huấn luyện kế tiếp giữ đúng cấu hình đang phục vụ.
        </p>
      ) : null}

      {/* F-18 (#131): banner nguồn gốc thiết lập — NAS đồng bộ tự động */}
      {nasSource != null && (
        <div
          className="flex items-start gap-2.5 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5"
          role="status"
          aria-label="Nguồn gốc thiết lập: NAS tự động tìm kiếm"
        >
          <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
          <div className="flex flex-col gap-0.5 text-xs leading-relaxed">
            <p className="font-semibold">
              Thiết lập này do NAS (tab Tự động tìm kiếm) cập nhật tự động —{" "}
              {formatDateTime(nasSource.at)}
            </p>
            <p className="text-muted-foreground">
              Champion {nasSource.tag} (arch {nasSource.arch})
              {typeof nasSource.modelVersion === "number"
                ? ` — bản v${nasSource.modelVersion} đang serving sau khi qua cổng 4 điều kiện`
                : ""}{" "}
              (đợt sweep {nasSource.runId.slice(0, 10)}…). Kiến trúc, thuật toán
              kích hoạt và tinh chỉnh trong trình chỉnh sửa bên dưới là của
              champion — lần train kế tiếp dùng đúng cấu hình này; chỉnh tay
              rồi Lưu sẽ ghi đè (NAS ghi lại ở đợt đồng bộ kế tiếp).
            </p>
          </div>
        </div>
      )}

      {/* Trình chỉnh sửa kiến trúc ANN — trái tim #94 */}
      <ArchEditor draft={draft} featureCount={featureCount} />

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
