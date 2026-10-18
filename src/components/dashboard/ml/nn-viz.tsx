"use client";

/**
 * ml/nn-viz.tsx — F-20 (#134): ENGINE SƠ ĐỒ "DARK HACKER TOPOLOGY" đồng dạng
 * cho MLP serving · ANN nháp (trình chỉnh sửa) · GRU-24 (tab Mạng thần kinh).
 *
 * Yêu cầu chủ sở hữu (#134): ba mô hình hiển thị ĐỒNG DẠNG typology diagram
 * phong cách dark hacker; có HẠT TÍN HIỆU chuyển động giữa các nơ-rôn theo
 * lớp, màu hạt phân biệt cơ chế đang hoạt động:
 *   - hạt lục  = lan truyền TIẾN (x → ŷ — suy luận/dự báo, "não vận hành");
 *   - hạt hồng = lan truyền NGƯỢC (∂L/∂ŷ → ∂L/∂x — học, gradient về phía vào);
 *   - hạt hổ   = dòng đệ quy của GRU (hₜ₋₁ quay lại cổng — BPTT).
 * Ba chế độ bấm được: TIẾN · NGƯỢC · CHU KỲ HUẤN LUYỆN (tiến rồi ngược lặp
 * lại như một epoch thật).
 *
 * Kỹ thuật: SVG thuần + SMIL animateMotion/keyPoints (không JS animation
 * loop — declarative, chạy compositor). Tôn trọng prefers-reduced-motion:
 * tắt toàn bộ hạt, giữ sơ đồ tĩnh + ghi chú trung thực.
 * Trung thực kế thừa bản cũ: mỗi cạnh mang <title> thật (W[i,j] = giá trị),
 * màu dấu trọng số (lục dương · hồng âm), dày = |w|, subsample có ghi chú.
 */

import * as React from "react";
import { cn } from "@/lib/utils";

/* ─────────────────── Palette "dark hacker" (một nguồn) ─────────────────── */

export const VIZ_PALETTE = {
  bg: "#050807",
  grid: "rgba(52,211,153,0.055)",
  border: "rgba(52,211,153,0.30)",
  text: "#d1fae5",
  dim: "rgba(110,231,183,0.78)",
  faint: "rgba(110,231,183,0.55)",
  /** Hạt lan truyền tiến. */
  fwd: "#a3e635",
  /** Hạt lan truyền ngược (gradient). */
  bwd: "#f472b6",
  /** Dòng đệ quy GRU. */
  recur: "#fbbf24",
  wPos: "#34d399",
  wNeg: "#fb7185",
  inStroke: "#22d3ee",
  hidStroke: "#34d399",
  gate: "#fbbf24",
  cand: "#c084fc",
  state: "#22d3ee",
  out: "#34d399",
  outStroke: "#a7f3d0",
} as const;

/* ─────────────────── Hằng số hình học dùng chung (giữ từ bản cũ) ─────────────────── */

/** Cột dọc của sơ đồ serving. */
export const TOP = 56;
export const BOTTOM = 352;
export const COL_GAP = 150;
export const COL_X0 = 110;
/** Trần số cạnh vẽ (mạng lớn — cấu trúc vẫn đúng, có ghi chú). */
export const EDGE_CAP = 1400;
/** Sơ đồ nháp (trình chỉnh sửa) — nhỏ hơn; TOP chừa 2 dòng tiêu đề cột. */
export const DRAFT_TOP = 34;
export const DRAFT_BOTTOM = 160;
export const DRAFT_GAP = 118;
export const DRAFT_X0 = 96;
export const DRAFT_EDGE_CAP = 500;

export interface NodePos {
  x: number;
  y: number;
}

export interface EdgeSpec {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  w: number;
  title: string;
}

export function nodePositions(units: number, x: number, top: number, bottom: number): NodePos[] {
  const span = bottom - top;
  const gap = units > 1 ? span / (units - 1) : 0;
  const y0 = units > 1 ? top : (top + bottom) / 2;
  return Array.from({ length: units }, (_, i) => ({ x, y: y0 + i * gap }));
}

/** Bán kính nơ-rôn theo khoảng cách giữa 2 nơ-rôn liền nhau trong cột. */
export function radiusForNodes(nodes: NodePos[]): number {
  if (nodes.length < 2) return 5;
  const gap = Math.abs(nodes[nodes.length - 1]!.y - nodes[0]!.y) / (nodes.length - 1);
  return Math.max(2.6, Math.min(6, gap * 0.36));
}

export function buildEdges(
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
export function subsample<T>(items: T[], cap: number): { items: T[]; stride: number } {
  if (items.length <= cap) return { items, stride: 1 };
  const stride = Math.ceil(items.length / cap);
  return { items: items.filter((_, i) => i % stride === 0), stride };
}

/* ─────────────────── Chế độ lan truyền + toolbar ─────────────────── */

export type PropMode = "fwd" | "bwd" | "cycle";

const MODES: { id: PropMode; label: string; hint: string; color: string }[] = [
  {
    id: "fwd",
    label: "▸ tiến",
    hint: "Lan truyền tiến — tín hiệu đi từ lớp vào qua các lớp ẩn đến lớp ra (suy luận, dự báo 5 phiên)",
    color: VIZ_PALETTE.fwd,
  },
  {
    id: "bwd",
    label: "◂ ngược",
    hint: "Lan truyền ngược — gradient lỗi đi ngược từ lớp ra về lớp vào (học, cập nhật trọng số)",
    color: VIZ_PALETTE.bwd,
  },
  {
    id: "cycle",
    label: "⟳ chu kỳ",
    hint: "Chu kỳ huấn luyện — tiến (tính ŷ và loss) rồi ngược (gradient) lặp lại như một epoch",
    color: "#22d3ee",
  },
];

function ModeToolbar({ mode, onChange }: { mode: PropMode; onChange: (m: PropMode) => void }) {
  return (
    <>
      {MODES.map((m) => {
        const active = mode === m.id;
        return (
          <button
            key={m.id}
            type="button"
            title={m.hint}
            aria-pressed={active}
            aria-label={m.hint}
            onClick={() => onChange(m.id)}
            className={cn(
              "rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition-all",
              !active &&
                "border-emerald-500/25 text-emerald-300/60 hover:border-emerald-400/50 hover:text-emerald-200"
            )}
            style={
              active
                ? {
                    color: m.color,
                    borderColor: m.color,
                    background: `${m.color}1f`,
                    boxShadow: `0 0 10px ${m.color}40`,
                  }
                : undefined
            }
          >
            {m.label}
          </button>
        );
      })}
    </>
  );
}

/** Trạng thái chế độ + toolbar dựng sẵn (mỗi sơ đồ độc lập một bộ nút). */
export function useVizMode(): { mode: PropMode; setMode: (m: PropMode) => void; toolbar: React.ReactNode } {
  const [mode, setMode] = React.useState<PropMode>("fwd");
  const toolbar = React.useMemo(() => <ModeToolbar mode={mode} onChange={setMode} />, [mode]);
  return { mode, setMode, toolbar };
}

/** prefers-reduced-motion — tắt hạt, giữ sơ đồ tĩnh (useSyncExternalStore). */
export function usePrefersReducedMotion(): boolean {
  const subscribe = React.useCallback((onChange: () => void) => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const getSnapshot = React.useCallback(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    []
  );
  return React.useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/* ─────────────────── Vỏ dark hacker (panel + scanlines + legend) ─────────────────── */

export function VizShell({
  title,
  toolbar,
  legend,
  children,
  className,
}: {
  title: string;
  toolbar?: React.ReactNode;
  legend?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn("relative overflow-hidden rounded-lg border font-mono", className)}
      style={{ background: VIZ_PALETTE.bg, borderColor: VIZ_PALETTE.border }}
    >
      <div
        className="relative z-10 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-3 py-2"
        style={{ borderColor: "rgba(52,211,153,0.18)" }}
      >
        <span
          className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.18em]"
          style={{ color: "#6ee7b7" }}
        >
          <span
            className="inline-block size-1.5 rounded-full"
            style={{ background: VIZ_PALETTE.fwd, boxShadow: `0 0 6px ${VIZ_PALETTE.fwd}` }}
            aria-hidden="true"
          />
          {title}
        </span>
        {toolbar ? <div className="ml-auto flex items-center gap-1">{toolbar}</div> : null}
      </div>
      <div className="custom-scrollbar relative z-10 overflow-x-auto p-2">{children}</div>
      {legend ? (
        <div
          className="relative z-10 flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-3 py-2 text-[10px] leading-relaxed"
          style={{ borderColor: "rgba(52,211,153,0.18)", color: VIZ_PALETTE.dim }}
        >
          {legend}
        </div>
      ) : null}
      {/* Lớp scanline CRT — trang trí, không chắn tương tác */}
      <div aria-hidden="true" className="nn-scanlines pointer-events-none absolute inset-0 z-20" />
    </div>
  );
}

export function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="inline-block size-2 shrink-0 rounded-full"
        style={{ background: color, boxShadow: `0 0 5px ${color}` }}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}

export function LegendLine({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-block h-[2px] w-4 shrink-0" style={{ background: color }} aria-hidden="true" />
      {label}
    </span>
  );
}

/** Dòng trạng thái chế độ hiện tại — đặt cuối legend. */
export function ModeLegendText({ mode, reduced }: { mode: PropMode; reduced: boolean }) {
  if (reduced) {
    return (
      <span className="text-amber-300/80">
        prefers-reduced-motion: đang bật — hạt tín hiệu tĩnh, sơ đồ vẫn đầy đủ cấu trúc &amp; trọng số
      </span>
    );
  }
  const m = MODES.find((x) => x.id === mode)!;
  return (
    <span>
      chế độ: <span style={{ color: m.color }} className="font-semibold">{m.label.trim()}</span> —{" "}
      {mode === "fwd"
        ? "não đang vận hành: tín hiệu vào → lớp ra"
        : mode === "bwd"
          ? "não đang học: gradient lớp ra → về phía vào"
          : "mô phỏng 1 epoch: tiến → ngược → lặp"}
    </span>
  );
}

/* ─────────────────── Hạt tín hiệu (SMIL animateMotion) ─────────────────── */

function SignalDot({
  x1,
  y1,
  x2,
  y2,
  dir,
  mode,
  color,
  mag,
  phase,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  dir: "fwd" | "bwd";
  mode: PropMode;
  color: string;
  mag: number;
  phase: number;
}) {
  const ax = dir === "fwd" ? x1 : x2;
  const ay = dir === "fwd" ? y1 : y2;
  const path = `M ${ax} ${ay} L ${dir === "fwd" ? x2 : x1} ${dir === "fwd" ? y2 : y1}`;
  const r = (1.4 + 1.4 * Math.max(0.12, mag)).toFixed(2);
  const dur = mode === "cycle" ? 4 : 2.3;
  // Bảng thời gian theo chế độ: fwd/bwd — chạy suốt vòng lặp; cycle — mỗi hướng
  // nửa chu kỳ (tiến 0→44%, ngược 50→94%) + fade để đọc như sóng tuần tự.
  let kp = "0;1";
  let kt = "0;1";
  let ov = "0;1;1;0";
  let okt = "0;0.1;0.85;1";
  if (mode === "cycle" && dir === "fwd") {
    kp = "0;1;1";
    kt = "0;0.44;1";
    ov = "0;1;1;0;0";
    okt = "0;0.05;0.4;0.5;1";
  } else if (mode === "cycle" && dir === "bwd") {
    kp = "0;0;1";
    kt = "0;0.5;0.94";
    ov = "0;0;1;1;0";
    okt = "0;0.5;0.56;0.88;1";
  }
  return (
    <circle cx={ax} cy={ay} r={r} fill={color} opacity={0}>
      <animateMotion
        path={path}
        dur={`${dur}s`}
        begin={`${(-phase).toFixed(2)}s`}
        repeatCount="indefinite"
        calcMode="linear"
        keyPoints={kp}
        keyTimes={kt}
      />
      <animate
        attributeName="opacity"
        values={ov}
        keyTimes={okt}
        calcMode="linear"
        dur={`${dur}s`}
        begin={`${(-phase).toFixed(2)}s`}
        repeatCount="indefinite"
      />
    </circle>
  );
}

/** Lớp hạt cho một bộ cạnh (đã subsample) — fwd/bwd/cycle theo mode. */
function ParticleLayer({
  groups,
  mode,
  reduced,
  perGap,
  glowId,
}: {
  groups: EdgeSpec[][];
  mode: PropMode;
  reduced: boolean;
  perGap: number;
  glowId: string;
}) {
  if (reduced) return null;
  const dots: React.ReactNode[] = [];
  groups.forEach((group, gi) => {
    if (group.length === 0) return;
    const stride = Math.max(1, Math.ceil(group.length / perGap));
    const wMax = Math.max(1e-9, ...group.map((e) => Math.abs(e.w)));
    const base = mode === "cycle" ? 4 : 2.3;
    for (let j = 0, k = 0; j < group.length; j += stride, k++) {
      const e = group[j]!;
      const mag = Math.abs(e.w) / wMax;
      const phase = (gi * 0.37 + k * 0.61) % base;
      if (mode !== "bwd") {
        dots.push(
          <SignalDot
            key={`f${gi}-${j}`}
            x1={e.x1}
            y1={e.y1}
            x2={e.x2}
            y2={e.y2}
            dir="fwd"
            mode={mode}
            color={VIZ_PALETTE.fwd}
            mag={mag}
            phase={phase}
          />
        );
      }
      if (mode !== "fwd") {
        dots.push(
          <SignalDot
            key={`b${gi}-${j}`}
            x1={e.x1}
            y1={e.y1}
            x2={e.x2}
            y2={e.y2}
            dir="bwd"
            mode={mode}
            color={VIZ_PALETTE.bwd}
            mag={mag}
            phase={(phase + 0.17) % base}
          />
        );
      }
    }
  });
  if (dots.length === 0) return null;
  return (
    <g filter={`url(#${glowId})`} pointerEvents="none">
      {dots}
    </g>
  );
}

/* ─────────────────── defs chung (grid + glow + mũi tên) ─────────────────── */

function VizDefs({ uid }: { uid: string }) {
  const grid = `vizgrid-${uid}`;
  const glow = `vizglow-${uid}`;
  const arrowF = `vizarrowf-${uid}`;
  const arrowB = `vizarrowb-${uid}`;
  return (
    <defs>
      <pattern id={grid} width="26" height="26" patternUnits="userSpaceOnUse">
        <path d="M 26 0 L 0 0 0 26" fill="none" stroke={VIZ_PALETTE.grid} strokeWidth="0.5" />
      </pattern>
      <filter id={glow} x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur stdDeviation="1.6" result="b" />
        <feMerge>
          <feMergeNode in="b" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      <marker id={arrowF} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
        <path d="M0,0 L7,3.5 L0,7 z" fill={VIZ_PALETTE.fwd} />
      </marker>
      <marker id={arrowB} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
        <path d="M0,0 L7,3.5 L0,7 z" fill={VIZ_PALETTE.bwd} />
      </marker>
      <marker id={`vizarrowr-${uid}`} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
        <path d="M0,0 L7,3.5 L0,7 z" fill={VIZ_PALETTE.recur} />
      </marker>
    </defs>
  );
}

/* ─────────────────── Typology net (MLP serving + ANN nháp) ─────────────────── */

export interface VizColumn {
  nodes: NodePos[];
  label: string;
  sub: string;
  chip?: string;
  kind: "input" | "hidden" | "output";
  /** Nhãn cạnh trái (đặc trưng vào) hoặc phải (nhóm lớp ra). */
  sideLabel?: (j: number) => string | null;
  nodeTitle?: (j: number) => string;
}

export function TypologyNet({
  columns,
  edgeGroups,
  viewW,
  viewH,
  mode,
  reduced,
  structural = false,
  ariaLabel,
  particlesPerGap = 9,
  flowArrows = true,
  headersAt = [30, 45],
  minW = 620,
}: {
  columns: VizColumn[];
  /** ĐÃ subsample — độ dài = columns.length − 1. */
  edgeGroups: EdgeSpec[][];
  viewW: number;
  viewH: number;
  mode: PropMode;
  reduced: boolean;
  /** true = sơ đồ cấu trúc (không trọng số — cạnh trung tính). */
  structural?: boolean;
  ariaLabel: string;
  particlesPerGap?: number;
  flowArrows?: boolean;
  headersAt?: [number, number];
  minW?: number;
}) {
  const uid = React.useId().replace(/[^a-zA-Z0-9]/g, "");
  const glow = `vizglow-${uid}`;
  const grid = `vizgrid-${uid}`;
  const arrowF = `vizarrowf-${uid}`;
  const arrowB = `vizarrowb-${uid}`;
  const firstX = columns[0]?.nodes[0]?.x ?? 0;
  const lastX = columns[columns.length - 1]?.nodes[0]?.x ?? viewW;
  const arrowY = viewH - 16;

  return (
    <svg
      viewBox={`0 0 ${viewW} ${viewH}`}
      className="max-w-full"
      style={{ minWidth: minW }}
      role="img"
      aria-label={ariaLabel}
    >
      <VizDefs uid={uid} />
      <rect x={0} y={0} width={viewW} height={viewH} rx={6} fill={VIZ_PALETTE.bg} />
      <rect x={0} y={0} width={viewW} height={viewH} rx={6} fill={`url(#${grid})`} />

      {/* Tiêu đề cột */}
      {columns.map((col, ci) => {
        const x = col.nodes[0]?.x ?? 0;
        return (
          <g key={`h-${ci}`}>
            <text x={x} y={headersAt[0]} textAnchor="middle" fill="#a7f3d0" fontSize={11} fontWeight={600}>
              {col.label}
            </text>
            <text x={x} y={headersAt[1]} textAnchor="middle" fill="rgba(110,231,183,0.7)" fontSize={10} className="tabular-nums">
              {col.sub}
            </text>
            {col.chip ? (
              <text x={x} y={headersAt[1] + 13} textAnchor="middle" fill="rgba(110,231,183,0.5)" fontSize={8.5}>
                {col.chip}
              </text>
            ) : null}
          </g>
        );
      })}

      {/* Cạnh (vẽ trước — nơ-rôn đè lên) */}
      {edgeGroups.map((group, gi) => {
        const wMax = Math.max(1e-9, ...group.map((e) => Math.abs(e.w)));
        return (
          <g key={`eg-${gi}`}>
            {group.map((e, i) => {
              const mag = Math.abs(e.w) / wMax;
              const stroke = structural
                ? "rgba(52,211,153,0.45)"
                : e.w >= 0
                  ? VIZ_PALETTE.wPos
                  : VIZ_PALETTE.wNeg;
              const opacity = structural ? 0.2 : 0.22 + 0.55 * mag;
              const width = structural ? 0.5 : 0.35 + 1.9 * mag;
              return (
                <line
                  key={i}
                  x1={e.x1}
                  y1={e.y1}
                  x2={e.x2}
                  y2={e.y2}
                  stroke={stroke}
                  strokeOpacity={opacity}
                  strokeWidth={width}
                >
                  {e.title ? <title>{e.title}</title> : null}
                </line>
              );
            })}
          </g>
        );
      })}

      {/* Nơ-rôn theo loại cột */}
      {columns.map((col, ci) => {
        const r = col.kind === "output" ? 8 : radiusForNodes(col.nodes);
        return col.nodes.map((p, j) => {
          const title = col.nodeTitle?.(j);
          const side = col.sideLabel?.(j) ?? null;
          if (col.kind === "input") {
            return (
              <g key={`n-${ci}-${j}`}>
                <circle cx={p.x} cy={p.y} r={r} fill="rgba(34,211,238,0.20)" stroke={VIZ_PALETTE.inStroke} strokeWidth={1}>
                  {title ? <title>{title}</title> : null}
                </circle>
                {side ? (
                  <text x={p.x - r - 6} y={p.y + 3} textAnchor="end" fill="rgba(110,231,183,0.75)" fontSize={7.5}>
                    {side}
                  </text>
                ) : null}
              </g>
            );
          }
          if (col.kind === "output") {
            return (
              <g key={`n-${ci}-${j}`}>
                <circle cx={p.x} cy={p.y} r={r + 3.5} fill="none" stroke={VIZ_PALETTE.out} strokeOpacity={0.4} />
                <circle cx={p.x} cy={p.y} r={r} fill={VIZ_PALETTE.out} stroke={VIZ_PALETTE.outStroke} strokeWidth={1.5}>
                  {title ? <title>{title}</title> : null}
                </circle>
                {side ? (
                  <text x={p.x + r + 6} y={p.y + 3.5} fill={VIZ_PALETTE.text} fontSize={9.5} fontWeight={600}>
                    {side}
                  </text>
                ) : null}
              </g>
            );
          }
          return (
            <g key={`n-${ci}-${j}`}>
              <circle
                cx={p.x}
                cy={p.y}
                r={r}
                fill="rgba(52,211,153,0.30)"
                stroke={VIZ_PALETTE.hidStroke}
                strokeWidth={0.9}
              >
                {title ? <title>{title}</title> : null}
              </circle>
            </g>
          );
        });
      })}

      {/* Hạt tín hiệu */}
      <ParticleLayer groups={edgeGroups} mode={mode} reduced={reduced} perGap={particlesPerGap} glowId={glow} />

      {/* Cặp mũi tên cơ chế */}
      {flowArrows && (
        <g>
          <line
            x1={firstX}
            y1={arrowY}
            x2={viewW / 2 - 60}
            y2={arrowY}
            stroke={VIZ_PALETTE.fwd}
            strokeOpacity={0.55}
            strokeWidth={1.1}
            markerEnd={`url(#${arrowF})`}
          />
          <text
            x={(firstX + viewW / 2 - 60) / 2}
            y={arrowY - 5}
            textAnchor="middle"
            fill={VIZ_PALETTE.fwd}
            fillOpacity={0.8}
            fontSize={8.5}
          >
            lan truyền tiến — x → ŷ
          </text>
          <line
            x1={lastX}
            y1={arrowY}
            x2={viewW / 2 + 60}
            y2={arrowY}
            stroke={VIZ_PALETTE.bwd}
            strokeOpacity={0.55}
            strokeWidth={1.1}
            markerEnd={`url(#${arrowB})`}
          />
          <text
            x={(lastX + viewW / 2 + 60) / 2}
            y={arrowY - 5}
            textAnchor="middle"
            fill={VIZ_PALETTE.bwd}
            fillOpacity={0.8}
            fontSize={8.5}
          >
            lan truyền ngược — ∂L/∂ŷ → vào
          </text>
        </g>
      )}
    </svg>
  );
}

/* ─────────────────── GRU net — typology cổng + đệ quy ─────────────────── */

/**
 * Sơ đồ GRU typology đồng dạng: cột đặc trưng → cổng r/z (sigmoid) → ứng viên
 * h̃ (tanh) → trạng thái hₜ (đệ quy — vòng hₜ₋₁ quay lại) → Dense → softmax.
 * Hiển thị ĐẠI DIỆN nơ-rôn (10/16 đặc trưng · 12/24 mỗi cổng) — công thức
 * từng cổng giữ đúng trong tooltip. Hạt: tiến (lục) · ngược BPTT (hồng) ·
 * dòng đệ quy (hổ phách) luôn chạy ở chế độ tiến/chu kỳ.
 */
export function GruNet({
  arch,
  mode,
  reduced,
}: {
  arch: { in: number; h: number; d: number; out: number; window: number };
  mode: PropMode;
  reduced: boolean;
}) {
  const uid = React.useId().replace(/[^a-zA-Z0-9]/g, "");
  const glow = `vizglow-${uid}`;
  const grid = `vizgrid-${uid}`;
  const arrowR = `vizarrowr-${uid}`;
  const { in: IN, h: H, d: D, out: OUT, window: W } = arch;

  const TOP = 70;
  const BOTTOM = 318;
  const MID_GAP = 14;
  const xs = { x: 86, gates: 252, cand: 418, state: 566, dense: 714, out: 856 };
  const viewW = 952;
  const viewH = 402;

  const xShow = Math.min(IN, 10);
  const hShow = Math.min(H, 12);
  const dShow = Math.min(D, 8);
  const xNodes = nodePositions(xShow, xs.x, TOP, BOTTOM);
  const halfTop = (TOP + BOTTOM) / 2 - MID_GAP;
  const halfBot = (TOP + BOTTOM) / 2 + MID_GAP;
  const rNodes = nodePositions(Math.ceil(hShow / 2), xs.gates, TOP, halfTop);
  const zNodes = nodePositions(Math.floor(hShow / 2), xs.gates, halfBot, BOTTOM);
  const gateNodes = [...rNodes, ...zNodes];
  const candNodes = nodePositions(hShow, xs.cand, TOP, BOTTOM);
  const stateNodes = nodePositions(hShow, xs.state, TOP, BOTTOM);
  const denseNodes = nodePositions(dShow, xs.dense, TOP, BOTTOM);
  const outNodes = nodePositions(OUT, xs.out, TOP + 60, BOTTOM - 60);

  const gates = 3 * (H * IN + H * H + H);
  const denseParams = D * H + D;
  const outParams = OUT * D + OUT;

  const mk = (from: NodePos[], to: NodePos[], title: string): EdgeSpec[] => {
    const out: EdgeSpec[] = [];
    for (const a of from) for (const b of to) out.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, w: 0, title });
    return out;
  };
  const groups: EdgeSpec[][] = [
    subsample(mk(xNodes, gateNodes, "cổng đọc toàn bộ xₜ và hₜ₋₁ — W·[x; hₜ₋₁] + b"), 120).items,
    subsample(mk(xNodes, candNodes, "h̃ đọc xₜ — W_h·xₜ"), 50).items,
    subsample(mk(rNodes, candNodes, "rₜ điều chế hₜ₋₁ trước khi vào h̃ — rₜ ⊙ hₜ₋₁"), 36).items,
    subsample(mk(zNodes, stateNodes, "zₜ quyết định bao nhiêu trạng thái cũ được giữ — (1−zₜ) ⊙ hₜ₋₁"), 36).items,
    subsample(mk(candNodes, stateNodes, "ứng viên h̃ₜ hợp nhất vào hₜ — zₜ ⊙ h̃ₜ"), 36).items,
    subsample(mk(stateNodes, denseNodes, "Dense đọc trạng thái cuối — Wd·hₜ + bd"), 48).items,
    mk(denseNodes, outNodes, "softmax(Wo·a + bo) → p(Giảm/Đi ngang/Tăng)"),
  ];

  // Vòng đệ quy hₜ₋₁: từ đáy cột trạng thái → cong xuống → ngược vào cổng.
  const loopD = `M ${xs.state} ${BOTTOM + 10} C ${xs.state - 40} ${BOTTOM + 44}, ${xs.gates + 40} ${BOTTOM + 44}, ${xs.gates} ${BOTTOM + 10}`;
  const loopRev = `M ${xs.gates} ${BOTTOM + 10} C ${xs.gates + 40} ${BOTTOM + 44}, ${xs.state - 40} ${BOTTOM + 44}, ${xs.state} ${BOTTOM + 10}`;

  const headers: { x: number; label: string; sub: string; chip: string }[] = [
    { x: xs.x, label: "xₜ — chuỗi vào", sub: `${W} phiên × ${IN} đặc trưng`, chip: "z-score theo đặc trưng" },
    { x: xs.gates, label: "cổng r · z", sub: `${H} sigmoid ×2`, chip: `${gates.toLocaleString("vi-VN")} tham số` },
    { x: xs.cand, label: "h̃ₜ ứng viên", sub: `${H} tanh`, chip: "trong 3 cổng" },
    { x: xs.state, label: "hₜ trạng thái", sub: `${H} unit đệ quy`, chip: "mang qua phiên sau" },
    { x: xs.dense, label: `Dense ${D}`, sub: "ReLU", chip: `${denseParams.toLocaleString("vi-VN")} tham số` },
    { x: xs.out, label: `Ra ${OUT}`, sub: "softmax", chip: `${outParams.toLocaleString("vi-VN")} tham số` },
  ];

  return (
    <svg
      viewBox={`0 0 ${viewW} ${viewH}`}
      className="max-w-full"
      style={{ minWidth: 720 }}
      role="img"
      aria-label={`Sơ đồ typology GRU-${H}: ${W} phiên × ${IN} đặc trưng → cổng r/z sigmoid → h̃ tanh → hₜ đệ quy → Dense ${D} → softmax ${OUT}`}
    >
      <VizDefs uid={uid} />
      <rect x={0} y={0} width={viewW} height={viewH} rx={6} fill={VIZ_PALETTE.bg} />
      <rect x={0} y={0} width={viewW} height={viewH} rx={6} fill={`url(#${grid})`} />

      {/* Tiêu đề cột */}
      {headers.map((h) => (
        <g key={h.x}>
          <text x={h.x} y={26} textAnchor="middle" fill="#a7f3d0" fontSize={11} fontWeight={600}>
            {h.label}
          </text>
          <text x={h.x} y={42} textAnchor="middle" fill="rgba(110,231,183,0.7)" fontSize={10} className="tabular-nums">
            {h.sub}
          </text>
          <text x={h.x} y={56} textAnchor="middle" fill="rgba(110,231,183,0.5)" fontSize={8.5}>
            {h.chip}
          </text>
        </g>
      ))}

      {/* Cạnh cấu trúc */}
      {groups.map((group, gi) => (
        <g key={`geg-${gi}`}>
          {group.map((e, i) => (
            <line
              key={i}
              x1={e.x1}
              y1={e.y1}
              x2={e.x2}
              y2={e.y2}
              stroke="rgba(52,211,153,0.45)"
              strokeOpacity={0.22}
              strokeWidth={0.55}
            >
              <title>{e.title}</title>
            </line>
          ))}
        </g>
      ))}

      {/* Nơ-rôn theo nhóm màu riêng của GRU */}
      {xNodes.map((p, j) => (
        <circle
          key={`gx-${j}`}
          cx={p.x}
          cy={p.y}
          r={radiusForNodes(xNodes)}
          fill="rgba(34,211,238,0.20)"
          stroke={VIZ_PALETTE.inStroke}
          strokeWidth={1}
        >
          <title>{`xₜ[${j}] — đặc trưng z-score (1 trong ${IN} chiều, window ${W} phiên)`}</title>
        </circle>
      ))}
      {rNodes.map((p, j) => (
        <circle key={`gr-${j}`} cx={p.x} cy={p.y} r={5} fill="rgba(251,191,36,0.22)" stroke={VIZ_PALETTE.gate} strokeWidth={1}>
          <title>{`rₜ = σ(Wᵣ·[xₜ; hₜ₋₁] + bᵣ) — cổng cập nhật (reset gate), nơ-rôn ${j + 1}/${Math.ceil(hShow / 2)} hiển thị của ${H}`}</title>
        </circle>
      ))}
      {zNodes.map((p, j) => (
        <circle key={`gz-${j}`} cx={p.x} cy={p.y} r={5} fill="rgba(251,191,36,0.22)" stroke={VIZ_PALETTE.gate} strokeWidth={1}>
          <title>{`zₜ = σ(W_z·[xₜ; hₜ₋₁] + b_z) — cổng xoá (update gate), nơ-rôn ${j + 1}/${Math.floor(hShow / 2)} hiển thị của ${H}`}</title>
        </circle>
      ))}
      {candNodes.map((p, j) => (
        <circle key={`gc-${j}`} cx={p.x} cy={p.y} r={5} fill="rgba(192,132,252,0.22)" stroke={VIZ_PALETTE.cand} strokeWidth={1}>
          <title>{`h̃ₜ = tanh(W_h·[xₜ; rₜ ⊙ hₜ₋₁] + b_h) — ứng viên trạng thái mới, nơ-rôn ${j + 1}/${hShow} hiển thị của ${H}`}</title>
        </circle>
      ))}
      {stateNodes.map((p, j) => (
        <g key={`gs-${j}`}>
          <circle cx={p.x} cy={p.y} r={5.5} fill="rgba(34,211,238,0.25)" stroke={VIZ_PALETTE.state} strokeWidth={1.2}>
            <title>{`hₜ = (1−zₜ) ⊙ hₜ₋₁ + zₜ ⊙ h̃ₜ — trạng thái mới, truyền sang phiên t+1, nơ-rôn ${j + 1}/${hShow} hiển thị của ${H}`}</title>
          </circle>
        </g>
      ))}
      {denseNodes.map((p, j) => (
        <circle key={`gd-${j}`} cx={p.x} cy={p.y} r={5} fill="rgba(52,211,153,0.30)" stroke={VIZ_PALETTE.hidStroke} strokeWidth={1}>
          <title>{`a = ReLU(Wd·hₜ + bd) — nơ-rôn Dense ${j + 1}/${D}`}</title>
        </circle>
      ))}
      {outNodes.map((p, j) => (
        <g key={`go-${j}`}>
          <circle cx={p.x} cy={p.y} r={9} fill="none" stroke={VIZ_PALETTE.out} strokeOpacity={0.4} />
          <circle cx={p.x} cy={p.y} r={7} fill={VIZ_PALETTE.out} stroke={VIZ_PALETTE.outStroke} strokeWidth={1.5}>
            <title>{`p = softmax(Wo·a + bo) — ${["Giảm (DOWN)", "Đi ngang (FLAT)", "Tăng (UP)"][j] ?? j}`}</title>
          </circle>
          <text x={p.x + 13} y={p.y + 3.5} fill={VIZ_PALETTE.text} fontSize={9.5} fontWeight={600}>
            {["Giảm", "Đi ngang", "Tăng"][j] ?? j}
          </text>
        </g>
      ))}

      {/* Nhãn nhóm cổng r/z bên trái cột gates */}
      <text x={xs.gates - 34} y={(TOP + halfTop) / 2 + 3} textAnchor="end" fill={VIZ_PALETTE.gate} fontSize={9} fontWeight={600}>
        rₜ
      </text>
      <text x={xs.gates - 34} y={(halfBot + BOTTOM) / 2 + 3} textAnchor="end" fill={VIZ_PALETTE.gate} fontSize={9} fontWeight={600}>
        zₜ
      </text>

      {/* Vòng đệ quy hₜ₋₁ */}
      <path d={loopD} fill="none" stroke={VIZ_PALETTE.recur} strokeOpacity={0.75} strokeWidth={1.4} markerEnd={`url(#${arrowR})`}>
        <title>hₜ₋₁ — trạng thái phiên trước quay lại cổng r/z và phép blend (đệ quy theo thời gian, BPTT viết tay)</title>
      </path>
      <text x={(xs.gates + xs.state) / 2} y={BOTTOM + 46} textAnchor="middle" fill={VIZ_PALETTE.recur} fillOpacity={0.9} fontSize={9}>
        hₜ₋₁ — trạng thái phiên trước quay lại cổng (đệ quy theo thời gian)
      </text>

      {/* Hạt tín hiệu */}
      <ParticleLayer groups={groups} mode={mode} reduced={reduced} perGap={7} glowId={glow} />
      {/* Hạt dòng đệ quy: tiến (hổ phách) luôn chạy trừ chế độ ngược → BPTT hồng chạy ngược */}
      {!reduced && (
        <g filter={`url(#${glow})}`} pointerEvents="none">
          {mode !== "bwd" ? (
            <circle r={2.6} fill={VIZ_PALETTE.recur} opacity={0}>
              <animateMotion path={loopD} dur="2.6s" repeatCount="indefinite" calcMode="linear" />
              <animate
                attributeName="opacity"
                values="0;1;1;0"
                keyTimes="0;0.1;0.85;1"
                calcMode="linear"
                dur="2.6s"
                repeatCount="indefinite"
              />
            </circle>
          ) : null}
          {mode !== "fwd" ? (
            <circle r={2.2} fill={VIZ_PALETTE.bwd} opacity={0}>
              <animateMotion path={loopRev} dur="2.6s" begin="-1.1s" repeatCount="indefinite" calcMode="linear" />
              <animate
                attributeName="opacity"
                values="0;1;1;0"
                keyTimes="0;0.1;0.85;1"
                calcMode="linear"
                dur="2.6s"
                begin="-1.1s"
                repeatCount="indefinite"
              />
            </circle>
          ) : null}
        </g>
      )}

      {/* Cặp mũi tên cơ chế */}
      <g>
        <line
          x1={xs.x}
          y1={viewH - 20}
          x2={viewW / 2 - 60}
          y2={viewH - 20}
          stroke={VIZ_PALETTE.fwd}
          strokeOpacity={0.55}
          strokeWidth={1.1}
          markerEnd={`url(#vizarrowf-${uid})`}
        />
        <text
          x={(xs.x + viewW / 2 - 60) / 2}
          y={viewH - 25}
          textAnchor="middle"
          fill={VIZ_PALETTE.fwd}
          fillOpacity={0.8}
          fontSize={8.5}
        >
          lan truyền tiến — xₜ qua cổng → hₜ → ŷ
        </text>
        <line
          x1={xs.out}
          y1={viewH - 20}
          x2={viewW / 2 + 60}
          y2={viewH - 20}
          stroke={VIZ_PALETTE.bwd}
          strokeOpacity={0.55}
          strokeWidth={1.1}
          markerEnd={`url(#vizarrowb-${uid})`}
        />
        <text
          x={(xs.out + viewW / 2 + 60) / 2}
          y={viewH - 25}
          textAnchor="middle"
          fill={VIZ_PALETTE.bwd}
          fillOpacity={0.8}
          fontSize={8.5}
        >
          lan truyền ngược — BPTT ∂L về từng phiên
        </text>
      </g>
    </svg>
  );
}
