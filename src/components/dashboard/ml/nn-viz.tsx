"use client";

/**
 * ml/nn-viz.tsx — F-20 (#134) → F-21 (#135): ENGINE SƠ ĐỒ "DARK HACKER
 * TOPOLOGY" đồng dạng cho MLP serving · ANN nháp (trình chỉnh sửa) · GRU-24
 * (tab Mạng thần kinh).
 *
 * #135 — HAI sửa đổi theo phản hồi chủ sở hữu:
 *  (1) HẠT ĐI ĐÚNG NƠ-RÔN: bản #134 dùng SMIL animateMotion đặt thêm cx/cy
 *      trên phần tử — animateMotion CỘNG phép dịch vào vị trí phần tử, nên
 *      hạt bị đặt ở TỌA ĐỘ GẤP ĐÔI (ax+ax, ay+ay), bay lung tung ngoài nơ-rôn.
 *      Bản này thay bằng circle cx=0 cy=0 + CSS keyframes nn-sig dịch chuyển
 *      theo biến --sx1/--sy1 → --sx2/--sy2: hạt NẢY RA từ đúng tâm nơ-rôn
 *      nguồn và HẠ CÁNH xuống đúng tâm nơ-rôn đích, không bao giờ xuất hiện
 *      ở nơi không có nơ-rôn.
 *  (2) HẠT CHỈ CHẠY KHI MẠNG HOẠT ĐỘNG: hạt không chạy liên tục nữa. Mặc định
 *      NHÀN RỖI (mạng tĩnh — đúng thực tế: bản serving chỉ suy luận theo yêu
 *      cầu, huấn luyện theo lịch). Hạt chỉ xuất hiện trong một LƯỢT hoạt động:
 *      bấm "▸ suy luận" (lan truyền tiến) / "◂ gradient" (lan truyền ngược) /
 *      "⟳ 1 epoch" (tiến rồi ngược) — chạy THEO SÓNG TỪNG LỚP rồi tự về nhàn
 *      rỗi. Lớp đang nhận tín hiệu SÁNG LÊN; nơ-rôn hoạt động mạnh (chuẩn
 *      trọng số vào cao — tính từ trọng số thật bản serving) pulse mạnh,
 *      nơ-rôn yếu gần như im lặng.
 *
 * Màu hạt: lục = tiến (x → ŷ) · hồng = ngược (∂L/∂ŷ → về vào) · hổ = dòng
 * đệ quy GRU (hₜ₋₁ quay lại cổng — BPTT ngược).
 *
 * Kỹ thuật: SVG thuần + CSS animation (biến --sx/--sy truyền per-hạt) —
 * declarative, chạy compositor, điều khiển start/stop bằng React state.
 * Tôn trọng prefers-reduced-motion: tắt toàn bộ hạt, sơ đồ tĩnh.
 * Trung thực kế thừa: mỗi cạnh mang <title> thật (W[i,j] = giá trị), màu dấu
 * trọng số (lục dương · hồng âm), dày = |w|, subsample có ghi chú.
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

/* ─────────────────── Hằng số hình học dùng chung ─────────────────── */

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

/* ─────────────────── Nhịp hoạt động (F-21 #135) ─────────────────── */

/** Thời gian hạt chạy 1 nhịp (từ lớp này sang lớp kế). */
export const VIZ_TRAVEL_S = 1.6;
/** Nghỉ giữa pha tiến và pha ngược của 1 epoch. */
export const VIZ_PAUSE_S = 0.9;
/** Đuôi sau nhịp cuối (để pulse nơ-rôn cuối kịp tắt). */
const TAIL_MS = 1300;
/** Sớm hơn chút so với thời gian hạt hạ cánh — nơ-rôn đích sáng đón sẵn. */
const FIRE_LEAD_MS = 260;

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

/* ─────────────────── Hoạt động của mạng: nhịp + hướng (#135) ─────────────────── */

export type PropMode = "fwd" | "bwd" | "cycle";

/**
 * Một NHỊT của sóng hoạt động: các nhóm cạnh (index trong edgeGroups) có hạt
 * chạy đồng thời + các CỘT nơ-rôn sáng lên khi nhận tín hiệu (tiến) hoặc nhận
 * gradient (ngược) + nhãn hiển thị trên chip trạng thái.
 */
export interface VizHopSpec {
  groups: number[];
  /** Cột sáng khi nhận tín hiệu (lan truyền tiến). */
  fireFwd: number[];
  /** Cột sáng khi nhận gradient (lan truyền ngược). */
  fireBwd: number[];
  label: string;
}

/** Sóng mặc định cho mạng feed-forward: hop g = nhóm cạnh g, lớp g+1 sáng. */
export function defaultHops(nCols: number, labels?: string[]): VizHopSpec[] {
  const hops: VizHopSpec[] = [];
  for (let g = 0; g < nCols - 1; g++) {
    hops.push({
      groups: [g],
      fireFwd: [g + 1],
      fireBwd: [g],
      label: labels?.[g + 1] ?? `lớp ${g + 1}`,
    });
  }
  return hops;
}

/**
 * Sóng GRU theo đúng ngữ nghĩa cổng (cột: 0=xₜ · 1=r·z · 2=h̃ · 3=hₜ · 4=Dense
 * · 5=ra): r/z đọc xₜ&hₜ₋₁ → h̃ tanh (nhánh song song x→h̃, r→h̃, z→hₜ) →
 * hợp nhất hₜ → Dense → softmax.
 */
export function gruHops(): VizHopSpec[] {
  return [
    { groups: [0], fireFwd: [1], fireBwd: [0], label: "cổng r·z đọc xₜ và hₜ₋₁" },
    { groups: [1, 2, 3], fireFwd: [2], fireBwd: [1], label: "h̃ₜ ứng viên tanh · zₜ giữ trạng thái" },
    { groups: [4], fireFwd: [3], fireBwd: [2], label: "hₜ hợp nhất (1−z)·hₜ₋₁ + z·h̃ₜ" },
    { groups: [5], fireFwd: [4], fireBwd: [3], label: "Dense đọc trạng thái hₜ" },
    { groups: [6], fireFwd: [5], fireBwd: [4], label: "softmax → p(Giảm/Đi ngang/Tăng)" },
  ];
}

export interface VizActivity {
  /** Đang có một lượt hoạt động (hạt + sóng lớp đang chạy). */
  running: boolean;
  kind: PropMode | null;
  /** Index hop đang nhận tín hiệu (−1 = chưa/nhàn rỗi). */
  hop: number;
  /** Hướng của hop đang chạy. */
  dir: "fwd" | "bwd";
  /** Cột nơ-rôn đang sáng (theo hướng hiện tại). */
  firingCols: number[];
  /** Tăng mỗi lượt — dùng làm key remount lớp hạt. */
  runId: number;
  run: (kind: PropMode) => void;
  stop: () => void;
  /** Chip trạng thái + nút điều khiển (đặt vào toolbar VizShell). */
  controls: React.ReactNode;
}

const KIND_LABEL: Record<PropMode, string> = {
  fwd: "MÔ PHỎNG SUY LUẬN — lan truyền tiến",
  bwd: "MÔ PHỎNG HỌC — lan truyền ngược",
  cycle: "MÔ PHỎNG 1 EPOCH — tiến rồi ngược",
};

/**
 * State machine hoạt động của một sơ đồ: run(kind) lên lịch sóng TỪNG LỚP
 * (timeout chain cập nhật cột đang sáng) rồi TỰ VỀ nhàn rỗi khi hết lượt —
 * hạt KHÔNG chạy liên tục (phản hồi #135: hạt chỉ hiện khi mạng làm việc).
 */
export function useVizActivity(hops: VizHopSpec[], opts?: { reduced?: boolean }): VizActivity {
  const reduced = opts?.reduced ?? false;
  const [st, setSt] = React.useState<{
    running: boolean;
    kind: PropMode | null;
    hop: number;
    dir: "fwd" | "bwd";
    firingCols: number[];
    runId: number;
  }>({ running: false, kind: null, hop: -1, dir: "fwd", firingCols: [], runId: 0 });

  const timers = React.useRef<number[]>([]);
  const clearTimers = React.useCallback(() => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  }, []);

  const stop = React.useCallback(() => {
    clearTimers();
    setSt((s) =>
      s.running ? { running: false, kind: null, hop: -1, dir: "fwd", firingCols: [], runId: s.runId } : s
    );
  }, [clearTimers]);

  React.useEffect(() => clearTimers, [clearTimers]);

  const run = React.useCallback(
    (kind: PropMode) => {
      if (reduced) return;
      clearTimers();
      const m = hops.length;
      if (m === 0) return;
      const T = VIZ_TRAVEL_S * 1000;
      const P = VIZ_PAUSE_S * 1000;
      setSt((s) => ({ running: true, kind, hop: -1, dir: "fwd", firingCols: [], runId: s.runId + 1 }));
      type Evt = { t: number; hop: number; dir: "fwd" | "bwd" };
      const evts: Evt[] = [];
      const addFwd = (off: number) =>
        hops.forEach((h, i) => evts.push({ t: off + (i + 1) * T - FIRE_LEAD_MS, hop: i, dir: "fwd" }));
      const addBwd = (off: number) => {
        for (let s = 0; s < m; s++) {
          evts.push({ t: off + (s + 1) * T - FIRE_LEAD_MS, hop: m - 1 - s, dir: "bwd" });
        }
      };
      if (kind === "fwd") {
        addFwd(0);
      } else if (kind === "bwd") {
        addBwd(0);
      } else {
        addFwd(0);
        addBwd(m * T + P);
      }
      const total =
        kind === "cycle" ? 2 * m * T + P + TAIL_MS : m * T + TAIL_MS;
      evts.forEach((e) => {
        timers.current.push(
          window.setTimeout(() => {
            const h = hops[e.hop]!;
            setSt((s) =>
              s.running
                ? { ...s, hop: e.hop, dir: e.dir, firingCols: e.dir === "fwd" ? h.fireFwd : h.fireBwd }
                : s
            );
          }, e.t)
        );
      });
      timers.current.push(window.setTimeout(() => stop(), total));
    },
    [hops, reduced, clearTimers, stop]
  );

  const controls = React.useMemo(
    () => (
      <ActivityControls
        running={st.running}
        kind={st.kind}
        hopLabel={st.hop >= 0 ? (hops[st.hop]?.label ?? null) : null}
        reduced={reduced}
        onRun={run}
        onStop={stop}
      />
    ),
    [st.running, st.kind, st.hop, hops, reduced, run, stop]
  );

  return { ...st, run, stop, controls };
}

function ActivityControls({
  running,
  kind,
  hopLabel,
  reduced,
  onRun,
  onStop,
}: {
  running: boolean;
  kind: PropMode | null;
  hopLabel: string | null;
  reduced: boolean;
  onRun: (k: PropMode) => void;
  onStop: () => void;
}) {
  if (reduced) {
    return (
      <span
        className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-300/90"
        title="Trình duyệt đang bật giảm chuyển động — hạt tín hiệu tắt, sơ đồ tĩnh đầy đủ cấu trúc & trọng số"
      >
        prefers-reduced-motion — hạt tắt
      </span>
    );
  }
  if (running && kind) {
    const color = kind === "fwd" ? VIZ_PALETTE.fwd : kind === "bwd" ? VIZ_PALETTE.bwd : "#22d3ee";
    return (
      <>
        <span
          aria-live="polite"
          className="flex items-center gap-1.5 rounded border px-2 py-0.5 text-[10px] font-semibold"
          style={{ color, borderColor: `${color}66`, background: `${color}14` }}
        >
          <span
            className="inline-block size-1.5 animate-soft-pulse rounded-full"
            style={{ background: color, boxShadow: `0 0 6px ${color}` }}
            aria-hidden="true"
          />
          {KIND_LABEL[kind]}
          {hopLabel ? <span className="font-normal opacity-80">— {hopLabel}</span> : null}
        </span>
        <button
          type="button"
          onClick={onStop}
          title="Dừng ngay — về nhàn rỗi"
          className="rounded border border-rose-400/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-rose-300/90 transition-colors hover:bg-rose-400/10"
        >
          ■ dừng
        </button>
      </>
    );
  }
  const btn =
    "rounded border border-emerald-500/25 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-300/70 transition-all hover:border-emerald-400/50 hover:text-emerald-200";
  return (
    <>
      <span
        className="rounded border border-emerald-500/20 bg-emerald-500/5 px-2 py-0.5 text-[10px] font-medium text-emerald-300/60"
        title="Mạng tĩnh — hạt tín hiệu chỉ xuất hiện khi mạng đang hoạt động (bấm nút bên để mô phỏng một lượt)"
      >
        ⏸ nhàn rỗi
      </span>
      <button type="button" onClick={() => onRun("fwd")} className={btn} title="Mô phỏng 1 lượt lan truyền tiến: tín hiệu từ lớp vào qua các lớp ẩn đến lớp ra (x → ŷ)">
        ▸ suy luận
      </button>
      <button type="button" onClick={() => onRun("bwd")} className={btn} title="Mô phỏng 1 lượt lan truyền ngược: gradient lỗi đi từ lớp ra về lớp vào (∂L/∂ŷ → ∂L/∂x)">
        ◂ gradient
      </button>
      <button type="button" onClick={() => onRun("cycle")} className={btn} title="Mô phỏng 1 epoch huấn luyện: tiến (tính ŷ và loss) rồi ngược (cập nhật trọng số)">
        ⟳ 1 epoch
      </button>
    </>
  );
}

/** Dòng trạng thái đặt cuối legend — giải thích HOẠT ĐỘNG hiện tại. */
export function ActivityStatusText({
  activity,
  autoNote,
}: {
  activity: VizActivity;
  autoNote?: string;
}) {
  if (activity.running && activity.kind) {
    const color =
      activity.kind === "fwd" ? VIZ_PALETTE.fwd : activity.kind === "bwd" ? VIZ_PALETTE.bwd : "#22d3ee";
    return (
      <span aria-live="polite">
        ▶{" "}
        <span style={{ color }} className="font-semibold">
          {KIND_LABEL[activity.kind]}
        </span>{" "}
        — hạt nảy ra từ đúng tâm nơ-rôn nguồn, hạ cánh xuống đúng tâm nơ-rôn
        đích; lớp đang nhận tín hiệu sáng lên theo nhịp.
      </span>
    );
  }
  return (
    <span className="text-emerald-300/70">
      ⏸ nhàn rỗi — mạng tĩnh, hạt tín hiệu chỉ xuất hiện khi có hoạt động
      (mô phỏng bấm nút ▸/◂/⟳){autoNote ? <span> · {autoNote}</span> : null}
    </span>
  );
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
        {toolbar ? <div className="ml-auto flex flex-wrap items-center gap-1">{toolbar}</div> : null}
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

/* ─────────────────── Hạt tín hiệu — CSS theo biến, đúng tâm nơ-rôn (#135) ─────────────────── */

/**
 * Một hạt: circle cx=0 cy=0, CSS keyframes nn-sig dịch --sx1/--sy1 → --sx2/--sy2.
 * KHÔNG đặt cx/cy (lỗi #134: animateMotion + cx/cy = tọa độ gấp đôi — hạt bay
 * lệch khỏi nơ-rôn). fill-mode both: trước delay hạt nằm đúng tâm nơ-rôn nguồn
 * với opacity 0 → chỉ "mọc" ra từ nơ-rôn, không xuất hiện giữa hư không.
 */
function SignalDot({
  e,
  dir,
  delay,
  color,
  mag,
}: {
  e: EdgeSpec;
  dir: "fwd" | "bwd";
  delay: number;
  color: string;
  mag: number;
}) {
  const x1 = dir === "fwd" ? e.x1 : e.x2;
  const y1 = dir === "fwd" ? e.y1 : e.y2;
  const x2 = dir === "fwd" ? e.x2 : e.x1;
  const y2 = dir === "fwd" ? e.y2 : e.y1;
  const r = 1.5 + 1.5 * Math.max(0.12, mag);
  const op = 0.5 + 0.5 * Math.max(0.15, mag);
  const style = {
    "--sx1": `${x1}px`,
    "--sy1": `${y1}px`,
    "--sx2": `${x2}px`,
    "--sy2": `${y2}px`,
    "--sig-op": op.toFixed(2),
    animation: `nn-sig ${VIZ_TRAVEL_S}s linear ${delay.toFixed(2)}s both`,
  } as React.CSSProperties;
  return <circle cx={0} cy={0} r={r.toFixed(2)} fill={color} pointerEvents="none" style={style} />;
}

/**
 * Lớp hạt cho một lượt hoạt động: mỗi hop bắt đầu sau hop trước TRAVEL giây —
 * sóng tín hiệu đi TỪNG LỚP như lan truyền thật (không tràn hết mọi cạnh cùng
 * lúc). Nhịp lệch nhỏ giữa các hạt trong cùng hop cho tự nhiên.
 */
function SignalLayer({
  groups,
  hops,
  activity,
  perGap,
  glowId,
}: {
  groups: EdgeSpec[][];
  hops: VizHopSpec[];
  activity: VizActivity;
  perGap: number;
  glowId: string;
}) {
  const { running, kind, runId } = activity;
  if (!running || !kind) return null;
  const m = hops.length;
  if (m === 0) return null;
  const dots: React.ReactNode[] = [];
  const hopOfGroup = (gi: number): number => {
    for (let i = 0; i < m; i++) if (hops[i]!.groups.includes(gi)) return i;
    return -1;
  };
  groups.forEach((group, gi) => {
    if (group.length === 0) return;
    const hop = hopOfGroup(gi);
    if (hop < 0) return;
    const stride = Math.max(1, Math.ceil(group.length / perGap));
    const wMax = Math.max(1e-9, ...group.map((e) => Math.abs(e.w)));
    const renderDir = (dir: "fwd" | "bwd") => {
      if (dir === "fwd" && kind === "bwd") return;
      if (dir === "bwd" && kind === "fwd") return;
      // hop i (fwd): delay = i·T; hop đảo thứ tự (bwd): delay = s·T; cycle cộng offset.
      const idx = dir === "fwd" ? hop : m - 1 - hop;
      const off = dir === "bwd" && kind === "cycle" ? m * VIZ_TRAVEL_S + VIZ_PAUSE_S : 0;
      const base = off + idx * VIZ_TRAVEL_S;
      for (let j = 0, k = 0; j < group.length; j += stride, k++) {
        const e = group[j]!;
        const mag = Math.abs(e.w) / wMax;
        // Nhịp lệch nhỏ trong cùng hop — hạt vẫn nảy từ đúng nơ-rôn nguồn.
        const jitter = (k % 3) * 0.12;
        dots.push(
          <SignalDot
            key={`${dir}-${gi}-${j}-${runId}`}
            e={e}
            dir={dir}
            delay={base + jitter}
            color={dir === "fwd" ? VIZ_PALETTE.fwd : VIZ_PALETTE.bwd}
            mag={mag}
          />
        );
      }
    };
    renderDir("fwd");
    renderDir("bwd");
  });
  if (dots.length === 0) return null;
  return (
    <g key={runId} filter={`url(#${glowId})`} pointerEvents="none">
      {dots}
    </g>
  );
}

/** Sáng nơ-rôn theo hoạt động: idle theo chuẩn trọng số, firing thì bùng sáng. */
function neuronFill(kind: "input" | "hidden" | "output", act: number, firing: boolean): number {
  const base = kind === "output" ? 0.3 + 0.5 * act : 0.15 + 0.45 * act;
  return firing ? Math.min(0.95, base + 0.45) : base;
}
function neuronStroke(act: number, firing: boolean): number {
  return firing ? 1 : 0.45 + 0.55 * act;
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
  /**
   * F-21 (#135) — mức hoạt động từng nơ-rôn 0..1 (chuẩn trọng số vào tính từ
   * trọng số THẬT của bản serving; không có → trung tính 0,55). Nơ-rôn sáng =
   * hoạt động mạnh, tối = gần im lặng — kể cả khi mạng tĩnh.
   */
  act?: number[];
}

export function TypologyNet({
  columns,
  edgeGroups,
  hops,
  activity,
  viewW,
  viewH,
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
  /** Sóng theo lớp; mặc định suy ra từ cột (hop g = nhóm g, lớp g+1 sáng). */
  hops?: VizHopSpec[];
  activity: VizActivity;
  viewW: number;
  viewH: number;
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
  const hopSpecs =
    hops ?? defaultHops(columns.length, columns.map((c) => c.label));
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

      {/* Nơ-rôn theo loại cột — sáng theo mức hoạt động + pulse khi nhận tín hiệu */}
      {columns.map((col, ci) => {
        const r = col.kind === "output" ? 8 : radiusForNodes(col.nodes);
        const firing = activity.firingCols.includes(ci);
        const hot = col.kind === "input" ? VIZ_PALETTE.inStroke : col.kind === "output" ? VIZ_PALETTE.out : VIZ_PALETTE.hidStroke;
        return col.nodes.map((p, j) => {
          const title = col.nodeTitle?.(j);
          const side = col.sideLabel?.(j) ?? null;
          const act = col.act?.[j] ?? 0.55;
          const style = {
            fillOpacity: neuronFill(col.kind, act, firing),
            strokeOpacity: neuronStroke(act, firing),
            "--amp": (0.2 + 0.4 * act).toFixed(2),
            "--hot": hot,
          } as React.CSSProperties;
          if (col.kind === "input") {
            return (
              <g key={`n-${ci}-${j}`}>
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={r}
                  fill="rgba(34,211,238,0.55)"
                  stroke={VIZ_PALETTE.inStroke}
                  strokeWidth={1}
                  className={cn("nn-neuron", firing && "nn-neuron-hot")}
                  style={style}
                >
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
                <circle cx={p.x} cy={p.y} r={r + 3.5} fill="none" stroke={VIZ_PALETTE.out} strokeOpacity={firing ? 0.9 : 0.4} />
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={r}
                  fill={VIZ_PALETTE.out}
                  stroke={VIZ_PALETTE.outStroke}
                  strokeWidth={1.5}
                  className={cn("nn-neuron", firing && "nn-neuron-hot")}
                  style={style}
                >
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
                fill="rgba(52,211,153,0.6)"
                stroke={VIZ_PALETTE.hidStroke}
                strokeWidth={0.9}
                className={cn("nn-neuron", firing && "nn-neuron-hot")}
                style={style}
              >
                {title ? <title>{title}</title> : null}
              </circle>
            </g>
          );
        });
      })}

      {/* Hạt tín hiệu — CHỈ render khi có lượt hoạt động (#135) */}
      <SignalLayer groups={edgeGroups} hops={hopSpecs} activity={activity} perGap={particlesPerGap} glowId={glow} />

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
 * từng cổng giữ đúng trong tooltip.
 *
 * #135: hạt chỉ chạy trong lượt hoạt động; vòng đệ quy HỔ nối ĐÚNG từ tâm
 * nơ-rôn hₜ dưới cùng về đúng tâm nơ-rôn cổng z dưới cùng (bản #134 nối lệch
 * dưới cột 10px); hạt BPTT hồng chạy ngược vòng.
 */
export function GruNet({
  arch,
  hops,
  activity,
}: {
  arch: { in: number; h: number; d: number; out: number; window: number };
  hops: VizHopSpec[];
  activity: VizActivity;
}) {
  const uid = React.useId().replace(/[^a-zA-Z0-9]/g, "");
  const glow = `vizglow-${uid}`;
  const grid = `vizgrid-${uid}`;
  const arrowR = `vizarrowr-${uid}`;
  const svgRef = React.useRef<SVGSVGElement | null>(null);
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

  // Vòng đệ quy hₜ₋₁ (#135): từ ĐÚNG tâm nơ-rôn hₜ dưới cùng → cong dưới →
  // về ĐÚNG tâm nơ-rôn cổng z dưới cùng (hai đầu mút = điểm nơ-rôn thật).
  const loopStart = stateNodes[stateNodes.length - 1]!;
  const loopEnd = zNodes[zNodes.length - 1]!;
  const loopD = `M ${loopStart.x} ${loopStart.y} C ${loopStart.x - 46} ${loopStart.y + 38}, ${loopEnd.x + 46} ${loopEnd.y + 38}, ${loopEnd.x} ${loopEnd.y}`;
  const loopRev = `M ${loopEnd.x} ${loopEnd.y} C ${loopEnd.x + 46} ${loopEnd.y + 38}, ${loopStart.x - 46} ${loopStart.y + 38}, ${loopStart.x} ${loopStart.y}`;

  const headers: { x: number; label: string; sub: string; chip: string }[] = [
    { x: xs.x, label: "xₜ — chuỗi vào", sub: `${W} phiên × ${IN} đặc trưng`, chip: "z-score theo đặc trưng" },
    { x: xs.gates, label: "cổng r · z", sub: `${H} sigmoid ×2`, chip: `${gates.toLocaleString("vi-VN")} tham số` },
    { x: xs.cand, label: "h̃ₜ ứng viên", sub: `${H} tanh`, chip: "trong 3 cổng" },
    { x: xs.state, label: "hₜ trạng thái", sub: `${H} unit đệ quy`, chip: "mang qua phiên sau" },
    { x: xs.dense, label: `Dense ${D}`, sub: "ReLU", chip: `${denseParams.toLocaleString("vi-VN")} tham số` },
    { x: xs.out, label: `Ra ${OUT}`, sub: "softmax", chip: `${outParams.toLocaleString("vi-VN")} tham số` },
  ];

  // Reset timeline SVG mỗi lượt hoạt động để hạt đệ quy (SMIL) nảy từ ĐÚNG đầu
  // vòng (state neuron) thay vì xuất hiện giữa chừng.
  React.useLayoutEffect(() => {
    if (!activity.running) return;
    try {
      svgRef.current?.setCurrentTime?.(0);
    } catch {
      /* trình duyệt cũ không hỗ trợ — chấp nhận hạt bắt đầu giữa vòng */
    }
  }, [activity.runId, activity.running]);

  const firing = activity.firingCols;

  return (
    <svg
      ref={svgRef}
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

      {/* Nơ-rôn theo nhóm màu riêng của GRU — GRU chưa train: cường độ trung tính */}
      {xNodes.map((p, j) => {
        const hot = firing.includes(0);
        return (
          <circle
            key={`gx-${j}`}
            cx={p.x}
            cy={p.y}
            r={radiusForNodes(xNodes)}
            fill="rgba(34,211,238,0.45)"
            stroke={VIZ_PALETTE.inStroke}
            strokeWidth={1}
            className={cn("nn-neuron", hot && "nn-neuron-hot")}
            style={{ "--hot": VIZ_PALETTE.inStroke, "--amp": "0.3" } as React.CSSProperties}
          >
            <title>{`xₜ[${j}] — đặc trưng z-score (1 trong ${IN} chiều, window ${W} phiên)`}</title>
          </circle>
        );
      })}
      {rNodes.map((p, j) => {
        const hot = firing.includes(1);
        return (
          <circle
            key={`gr-${j}`}
            cx={p.x}
            cy={p.y}
            r={5}
            fill="rgba(251,191,36,0.4)"
            stroke={VIZ_PALETTE.gate}
            strokeWidth={1}
            className={cn("nn-neuron", hot && "nn-neuron-hot")}
            style={{ "--hot": VIZ_PALETTE.gate, "--amp": "0.3" } as React.CSSProperties}
          >
            <title>{`rₜ = σ(Wᵣ·[xₜ; hₜ₋₁] + bᵣ) — cổng cập nhật (reset gate), nơ-rôn ${j + 1}/${Math.ceil(hShow / 2)} hiển thị của ${H}`}</title>
          </circle>
        );
      })}
      {zNodes.map((p, j) => {
        const hot = firing.includes(1);
        return (
          <circle
            key={`gz-${j}`}
            cx={p.x}
            cy={p.y}
            r={5}
            fill="rgba(251,191,36,0.4)"
            stroke={VIZ_PALETTE.gate}
            strokeWidth={1}
            className={cn("nn-neuron", hot && "nn-neuron-hot")}
            style={{ "--hot": VIZ_PALETTE.gate, "--amp": "0.3" } as React.CSSProperties}
          >
            <title>{`zₜ = σ(W_z·[xₜ; hₜ₋₁] + b_z) — cổng xoá (update gate), nơ-rôn ${j + 1}/${Math.floor(hShow / 2)} hiển thị của ${H}`}</title>
          </circle>
        );
      })}
      {candNodes.map((p, j) => {
        const hot = firing.includes(2);
        return (
          <circle
            key={`gc-${j}`}
            cx={p.x}
            cy={p.y}
            r={5}
            fill="rgba(192,132,252,0.4)"
            stroke={VIZ_PALETTE.cand}
            strokeWidth={1}
            className={cn("nn-neuron", hot && "nn-neuron-hot")}
            style={{ "--hot": VIZ_PALETTE.cand, "--amp": "0.3" } as React.CSSProperties}
          >
            <title>{`h̃ₜ = tanh(W_h·[xₜ; rₜ ⊙ hₜ₋₁] + b_h) — ứng viên trạng thái mới, nơ-rôn ${j + 1}/${hShow} hiển thị của ${H}`}</title>
          </circle>
        );
      })}
      {stateNodes.map((p, j) => {
        const hot = firing.includes(3);
        return (
          <circle
            key={`gs-${j}`}
            cx={p.x}
            cy={p.y}
            r={5.5}
            fill="rgba(34,211,238,0.45)"
            stroke={VIZ_PALETTE.state}
            strokeWidth={1.2}
            className={cn("nn-neuron", hot && "nn-neuron-hot")}
            style={{ "--hot": VIZ_PALETTE.state, "--amp": "0.32" } as React.CSSProperties}
          >
            <title>{`hₜ = (1−zₜ) ⊙ hₜ₋₁ + zₜ ⊙ h̃ₜ — trạng thái mới, truyền sang phiên t+1, nơ-rôn ${j + 1}/${hShow} hiển thị của ${H}`}</title>
          </circle>
        );
      })}
      {denseNodes.map((p, j) => {
        const hot = firing.includes(4);
        return (
          <circle
            key={`gd-${j}`}
            cx={p.x}
            cy={p.y}
            r={5}
            fill="rgba(52,211,153,0.45)"
            stroke={VIZ_PALETTE.hidStroke}
            strokeWidth={1}
            className={cn("nn-neuron", hot && "nn-neuron-hot")}
            style={{ "--hot": VIZ_PALETTE.hidStroke, "--amp": "0.3" } as React.CSSProperties}
          >
            <title>{`a = ReLU(Wd·hₜ + bd) — nơ-rôn Dense ${j + 1}/${D}`}</title>
          </circle>
        );
      })}
      {outNodes.map((p, j) => {
        const hot = firing.includes(5);
        return (
          <g key={`go-${j}`}>
            <circle cx={p.x} cy={p.y} r={9} fill="none" stroke={VIZ_PALETTE.out} strokeOpacity={hot ? 0.9 : 0.4} />
            <circle
              cx={p.x}
              cy={p.y}
              r={7}
              fill={VIZ_PALETTE.out}
              stroke={VIZ_PALETTE.outStroke}
              strokeWidth={1.5}
              className={cn("nn-neuron", hot && "nn-neuron-hot")}
              style={{ "--hot": VIZ_PALETTE.out, "--amp": "0.3" } as React.CSSProperties}
            >
              <title>{`p = softmax(Wo·a + bo) — ${["Giảm (DOWN)", "Đi ngang (FLAT)", "Tăng (UP)"][j] ?? j}`}</title>
            </circle>
            <text x={p.x + 13} y={p.y + 3.5} fill={VIZ_PALETTE.text} fontSize={9.5} fontWeight={600}>
              {["Giảm", "Đi ngang", "Tăng"][j] ?? j}
            </text>
          </g>
        );
      })}

      {/* Nhãn nhóm cổng r/z bên trái cột gates */}
      <text x={xs.gates - 34} y={(TOP + halfTop) / 2 + 3} textAnchor="end" fill={VIZ_PALETTE.gate} fontSize={9} fontWeight={600}>
        rₜ
      </text>
      <text x={xs.gates - 34} y={(halfBot + BOTTOM) / 2 + 3} textAnchor="end" fill={VIZ_PALETTE.gate} fontSize={9} fontWeight={600}>
        zₜ
      </text>

      {/* Vòng đệ quy hₜ₋₁ — hai đầu mút ĐÚNG tâm nơ-rôn (#135) */}
      <path d={loopD} fill="none" stroke={VIZ_PALETTE.recur} strokeOpacity={0.75} strokeWidth={1.4} markerEnd={`url(#${arrowR})}`}>
        <title>hₜ₋₁ — trạng thái phiên trước quay lại cổng r/z và phép blend (đệ quy theo thời gian, BPTT viết tay)</title>
      </path>
      <text x={(xs.gates + xs.state) / 2} y={BOTTOM + 52} textAnchor="middle" fill={VIZ_PALETTE.recur} fillOpacity={0.9} fontSize={9}>
        hₜ₋₁ — trạng thái phiên trước quay lại cổng (đệ quy theo thời gian)
      </text>

      {/* Hạt tín hiệu — CHỈ trong lượt hoạt động (#135) */}
      <SignalLayer groups={groups} hops={hops} activity={activity} perGap={7} glowId={glow} />
      {/* Hạt dòng đệ quy: tiến (hổ phách) khi suy luận/chu kỳ · BPTT hồng ngược */}
      {activity.running && (
        <g key={`loop-${activity.runId}`} filter={`url(#${glow})}`} pointerEvents="none">
          {activity.kind !== "bwd" ? (
            <circle r={2.6} fill={VIZ_PALETTE.recur} opacity={0}>
              <animateMotion path={loopD} dur="2.4s" begin="0s" repeatCount="indefinite" calcMode="linear" />
              <animate
                attributeName="opacity"
                values="0;1;1;0"
                keyTimes="0;0.12;0.82;1"
                calcMode="linear"
                dur="2.4s"
                repeatCount="indefinite"
              />
            </circle>
          ) : null}
          {activity.kind !== "fwd" ? (
            <circle r={2.2} fill={VIZ_PALETTE.bwd} opacity={0}>
              <animateMotion path={loopRev} dur="2.4s" begin="0s" repeatCount="indefinite" calcMode="linear" />
              <animate
                attributeName="opacity"
                values="0;1;1;0"
                keyTimes="0;0.12;0.82;1"
                calcMode="linear"
                dur="2.4s"
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
