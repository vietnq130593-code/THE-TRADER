/**
 * scripts/p137-verify-rl-states.ts — AUDIT 137 B2 (Task 138-b · P1 ML hygiene)
 *
 * Enumeration TOÀN BỘ 96 tổ hợp trạng thái Q-learning (regime 0/1 × trend 0/1
 * × rsi 0..3 × mom 0/1 × exp 0..2) gọi CHÍNH hàm stateIndexAt của
 * src/lib/ml/rl.ts (không copy công thức — import thật):
 *   - assert 96 index DUY NHẤT, max = 95, min = 0;
 *   - đối chứng công thức BỊ lỗi trước đây (36 index duy nhất, 60 va chạm,
 *     max 35 — tái hiện bằng chứng audit 137 B2 bằng enumeration);
 *   - kiểm nhánh 48-state legacy (regimeBit == null): 48 index duy nhất, max 47.
 *
 * Chạy: `env -u DATABASE_URL bun scripts/p137-verify-rl-states.ts`
 * (không cần DB — pure toán). exit 0 = PASS, exit 1 = FAIL.
 */
import { stateIndexAt, RL_STATES_V2, type BasketStats } from "@/lib/ml/rl";

/** Dựng BasketStats 1 phần tử sao cho tổ hợp (trend, rsi, mom) mong muốn. */
function statsOf(trend: number, rsiBucket: number, mom: number): BasketStats {
  const rsiVal = rsiBucket === 0 ? 20 : rsiBucket === 1 ? 40 : rsiBucket === 2 ? 60 : 80;
  return {
    sma20: [trend === 1 ? 2 : 1],
    sma50: [1],
    rsi14: [rsiVal],
    mom5: [mom === 1 ? 0.01 : -0.01],
    retNext: [0],
  };
}

/** exposure đại diện cho từng bucket 0/1/2 (<0,25 · 0,25..0,75 · >0,75). */
const EXPOSURES = [0.1, 0.5, 0.9];

/* ── 1) Công thức MỚI (rl.ts sau vá B2) — gọi hàm thật ─────────────────── */
const seen = new Set<number>();
let max = -1;
let min = Number.POSITIVE_INFINITY;
for (const regimeBit of [0, 1]) {
  for (const trend of [0, 1]) {
    for (let rsiBucket = 0; rsiBucket < 4; rsiBucket++) {
      for (const mom of [0, 1]) {
        for (let expBucket = 0; expBucket < 3; expBucket++) {
          const st = statsOf(trend, rsiBucket, mom);
          const s = stateIndexAt(st, 0, EXPOSURES[expBucket]!, regimeBit);
          seen.add(s);
          if (s > max) max = s;
          if (s < min) min = s;
        }
      }
    }
  }
}
console.log(`[B2 mới]   tổ hợp=${96} index duy nhất=${seen.size} min=${min} max=${max}`);
const passNew =
  seen.size === 96 && max === 95 && min === 0 && seen.size === RL_STATES_V2;

/* ── 2) Tái hiện công thức CŨ (lỗi thiếu ngoặc — bằng chứng audit) ──────── */
const seenOld = new Set<number>();
const oldCollisions: string[] = [];
const oldMap = new Map<number, string>();
for (const regimeBit of [0, 1]) {
  for (const trend of [0, 1]) {
    for (let rsiBucket = 0; rsiBucket < 4; rsiBucket++) {
      for (const mom of [0, 1]) {
        for (let expBucket = 0; expBucket < 3; expBucket++) {
          // công thức cũ rl.ts:168 trước vá:
          // A*2 + mom*3 + expBucket (A = (regime*2+trend)*4+rsi)
          const A = ((regimeBit ? 2 : 0) + trend) * 4 + rsiBucket;
          const s = A * 2 + mom * 3 + expBucket;
          seenOld.add(s);
          const key = `g${regimeBit}t${trend}r${rsiBucket}m${mom}e${expBucket}`;
          const prev = oldMap.get(s);
          if (prev != null && oldCollisions.length < 3) {
            oldCollisions.push(`${prev} ≡ ${key} → index ${s}`);
          }
          oldMap.set(s, key);
        }
      }
    }
  }
}
let maxOld = -1;
for (const v of seenOld) if (v > maxOld) maxOld = v;
console.log(
  `[B2 cũ]    index duy nhất=${seenOld.size}/96 (60 va chạm) max=${maxOld} — ví dụ: ${oldCollisions.join("; ")}`
);
const passOldEvidence = seenOld.size === 36 && maxOld === 35;

/* ── 3) Nhánh 48-state legacy (regimeBit == null) ──────────────────────── */
const seen48 = new Set<number>();
let max48 = -1;
for (const trend of [0, 1]) {
  for (let rsiBucket = 0; rsiBucket < 4; rsiBucket++) {
    for (const mom of [0, 1]) {
      for (let expBucket = 0; expBucket < 3; expBucket++) {
        const st = statsOf(trend, rsiBucket, mom);
        const s = stateIndexAt(st, 0, EXPOSURES[expBucket]!, undefined);
        seen48.add(s);
        if (s > max48) max48 = s;
      }
    }
  }
}
console.log(`[48-state] index duy nhất=${seen48.size} max=${max48}`);
const pass48 = seen48.size === 48 && max48 === 47;

/* ── Kết luận ──────────────────────────────────────────────────────────── */
const pass = passNew && passOldEvidence && pass48;
console.log(
  pass
    ? "PASS — 96 trạng thái DUY NHẤT 0..95 (khớp RL_STATES_V2=96); bản cũ 36/96 đã tái hiện; legacy 48 sạch."
    : "FAIL — stateIndex không phủ đúng không gian trạng thái!"
);
process.exit(pass ? 0 : 1);
