/**
 * scripts/p165-verify-rl-holdout.ts — KIỂM ĐỊNH W4 (#165): Q-TABLE HOLDOUT
 * WALK-FORWARD.
 *
 * Câu hỏi review #162: "Q-table v16 train trên toàn chuỗi + avgRewardLast50
 * là số in-training, KHÔNG có holdout walk-forward độc lập như MLP — làm sao
 * biết chính sách có thắng gì ngoài đoạn nó đã học không?"
 *
 * Kiểm định THUẦN LOGIC (0 DB — rl.ts không import db):
 *   T1. qHoldoutBars đúng luật: 10% chuỗi (min 60 · max 200) · n<400 → 0.
 *   T2. trainQTable({holdout}) sinh metrics ngoài mẫu: bars/steps đúng
 *       (steps = bars − 1), mọi số finite.
 *   T3. PIT — Q-table KHÔNG nhìn holdout: 2 chuỗi CÙNG đoạn đầu [0, m),
 *       KHÁC hẳn 100 phiên cuối → Q-table nhị phân BANG NHAU (cùng seed,
 *       cùng không gian học) — đổi holdout không đổi sản phẩm học.
 *   T4. Baseline đúng toán: chuỗi tăng đều +1%/phiên → buyHold = 0,01/bước,
 *       hold50 = 0,005/bước, cash = 0 (đối chiếu công thức tay).
 *   T5. Hành vi cũ giữ nguyên: không truyền holdout ≡ truyền 0 (Q-table
 *       bằng nhau tuyệt đối, không field holdout — additive thuần).
 *   T6. Siêu tham số không đổi: 300 episodes · 48 trạng thái (legacy) ·
 *       3 hành động.
 *
 * Cách chạy: env -u DATABASE_URL bun scripts/p165-verify-rl-holdout.ts
 */
import { qHoldoutBars, trainQTable } from "../src/lib/ml/rl";

console.log("== W4 #165 — Q-table holdout walk-forward ==");

let fail = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`  ${ok ? "PASS" : "FAIL"} · ${name} — ${detail}`);
  if (!ok) fail++;
};

/* ── T1: luật cắt holdout ── */
const t1a = qHoldoutBars(1000);
const t1b = qHoldoutBars(450);
const t1c = qHoldoutBars(399);
const t1d = qHoldoutBars(2500);
check(
  "T1 qHoldoutBars: 1000→100 · 450→60 · 399→0 · 2500→200",
  t1a === 100 && t1b === 60 && t1c === 0 && t1d === 200,
  `${t1a} · ${t1b} · ${t1c} · ${t1d}`
);

/* ── Dựng chuỗi rổ synthetic: random walk 1000 phiên (seed riêng script) ── */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const walk = (n: number, seed: number, drift = 0): number[] => {
  const rng = mulberry32(seed);
  const out: number[] = [100];
  for (let i = 1; i < n; i++) {
    out.push(Math.max(1, out[i - 1] * (1 + drift + (rng() - 0.5) * 0.02)));
  }
  return out;
};
const closes = walk(1000, 42);

/* ── T2: metrics ngoài mẫu sinh đúng ── */
const r2 = trainQTable(closes, { holdout: 100 });
const h2 = r2.holdout;
check(
  "T2 holdout tồn tại: bars=100 · steps=99 · mọi số finite",
  h2 != null &&
    h2.bars === 100 &&
    h2.steps === 99 &&
    [h2.avgRewardPerStep, h2.edgeVsHold50, h2.edgeVsBuyHold,
      h2.baselines.hold50, h2.baselines.buyHold, h2.baselines.cash]
      .every((v) => Number.isFinite(v)),
  h2 != null
    ? `bars=${h2.bars} steps=${h2.steps} · policy ${h2.avgRewardPerStep}/bước · edge giữ50% ${h2.edgeVsHold50} · edge mua-giữ ${h2.edgeVsBuyHold}`
    : "thiếu holdout!"
);

/* ── T3: PIT — Q-table không nhìn holdout ──
 * Cùng đoạn đầu [0, 900), thay 100 phiên cuối bằng chuỗi khác hẳn → Q-table
 * phải BANG NHAU (episode + Bellman chỉ sống trong [0, m); sNext clamp m−1). */
const otherTail = walk(100, 777, -0.005); // đèo sập khác regime
const closes2 = [...closes.slice(0, 900), ...otherTail];
const r3a = trainQTable(closes, { holdout: 100 });
const r3b = trainQTable(closes2, { holdout: 100 });
const sameQ =
  r3a.qTable.length === r3b.qTable.length &&
  r3a.qTable.every((row, s) =>
    row.every((v, a) => Math.abs(v - (r3b.qTable[s]?.[a] ?? NaN)) < 1e-12)
  );
check(
  "T3 PIT: đổi 100 phiên holdout → Q-table BANG NHAU (Q không nhìn đoạn cuối)",
  sameQ,
  sameQ
    ? "đoạn học [0,900) giống nhau → cùng sản phẩm học (đổi holdout không đổi Q)"
    : "Q-table khác — có leakage!"
);
// Đối chứng: holdout metrics PHẢI khác (đo trên 2 đoạn cuối khác nhau) —
// chứng minh T3 không phải no-op vô nghĩa.
check(
  "T3b Đối chứng: holdout metrics KHÁC nhau (2 đoạn cuối khác dữ liệu)",
  r3a.holdout != null &&
    r3b.holdout != null &&
    (Math.abs(r3a.holdout.avgRewardPerStep - r3b.holdout.avgRewardPerStep) > 0 ||
      Math.abs(r3a.holdout.baselines.buyHold - r3b.holdout.baselines.buyHold) > 0),
  `chính sách ${r3a.holdout?.avgRewardPerStep} vs ${r3b.holdout?.avgRewardPerStep} · mua-giữ ${r3a.holdout?.baselines.buyHold} vs ${r3b.holdout?.baselines.buyHold}`
);

/* ── T4: baseline đúng toán trên chuỗi tăng đều +1%/phiên ── */
const up = Array.from({ length: 600 }, (_, i) => 100 * 1.01 ** i);
const r4 = trainQTable(up, { holdout: qHoldoutBars(600) }); // H=60, steps=59
const h4 = r4.holdout;
const eps = 2e-6; // dung sai toFixed(6)
check(
  "T4 Baseline đúng công thức tay: mua-giữ 0,01/bước · giữ 50% 0,005 · cash 0",
  h4 != null &&
    Math.abs(h4.baselines.buyHold - 0.01) < eps &&
    Math.abs(h4.baselines.hold50 - 0.005) < eps &&
    h4.baselines.cash === 0,
  h4 != null
    ? `mua-giữ ${h4.baselines.buyHold} · giữ50% ${h4.baselines.hold50} · cash ${h4.baselines.cash}`
    : "thiếu holdout!"
);
// Chính sách trên chuỗi chỉ-tăng: Q học exposure 1 → thưởng/bước ≈ 0,01 trừ
// chi phí giao dịch nhỏ; edge vs mua-giữ nằm [−0,001, 0] (chỉ tốn cost đi vào).
check(
  "T4b Chính sách hợp lý trên chuỗi chỉ-tăng: edge mua-giữ ∈ (−0,001·2, 0]",
  h4 != null && h4.edgeVsBuyHold <= 0 && h4.edgeVsBuyHold > -0.0021,
  h4 != null
    ? `edge mua-giữ ${h4.edgeVsBuyHold} (chỉ损失的 cost vào vị thế ~0,001/bước đầu)`
    : "thiếu holdout!"
);

/* ── T5: hành vi cũ giữ nguyên (holdout=0 ≡ không truyền) ── */
const r5a = trainQTable(closes, {});
const r5b = trainQTable(closes, { holdout: 0 });
const sameOld =
  r5a.qTable.every((row, s) =>
    row.every((v, a) => Math.abs(v - (r5b.qTable[s]?.[a] ?? NaN)) < 1e-12)
  ) &&
  r5a.avgRewardLast50 === r5b.avgRewardLast50 &&
  r5a.holdout === undefined &&
  r5b.holdout === undefined;
check(
  "T5 Hành vi cũ nguyên vẹn: {} ≡ {holdout:0} (Q-table + reward bằng tuyệt đối)",
  sameOld,
  sameOld
    ? `avgRewardLast50 ${r5a.avgRewardLast50} — đường legacy không đổi`
    : "đường cũ bị đổi!"
);

/* ── T6: siêu tham số không đổi ── */
check(
  "T6 Siêu tham số giữ nguyên: 300 episodes · 48 states (legacy) · 3 actions",
  r2.episodes === 300 && r2.states === 48 && r2.actions === 3,
  `episodes=${r2.episodes} · states=${r2.states} · actions=${r2.actions}`
);

console.log(
  fail === 0
    ? `\nKẾT LUẬN: 8/8 PASS — Q-table có số ngoài mẫu trung thực (cut theo thời gian, baseline đối chứng, đường cũ nguyên vẹn).`
    : `\nKẾT LUẬN: ${fail} FAIL`
);
process.exit(fail === 0 ? 0 : 1);
