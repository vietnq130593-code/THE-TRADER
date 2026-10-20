/**
 * scripts/p164-verify-psi-retrain.ts — KIỂM ĐỊNH W3 (#164): AUTO-RETRAIN
 * THEO PSI CÓ GUARD.
 *
 * Câu hỏi review #162: "PSI chỉ cảnh báo — model đóng băng vô thời hạn nếu
 * không ai theo dõi. Vá bằng auto-retrain thì làm sao không thành vòng lặp
 * train失控?"
 *
 * Kiểm định THUẦN LOGIC (0 DB — chỉ import hàm decision của lib
 * psi-retrain.ts; chạy `env -u DATABASE_URL` để không chạm Supabase):
 *   T1. Kill-switch TẮT → skip "disabled" (dù PSI bao nhiêu).
 *   T2. Cooldown 24h: trigger 10h trước → skip "cooldown" + số ms còn lại.
 *   T3. Cooldown hết đúng 24h → ĐƯỢC xem xét tiếp (không khóa vĩnh viễn).
 *   T4. PSI 0,24 < 0,25 → skip "psi-below" (chưa tới ngưỡng dịch-chuyển).
 *   T5. PSI đúng 0,25 (biên ≥) → "proceed" (ngưỡng inclusive như A3).
 *   T6. PSI null (drift unavailable) → skip trung thực, không bịa số.
 *   T7. Đủ điều kiện (BẬT + hết cooldown + PSI 0,31) → "proceed".
 *   T8. windowHash trùng serving → blocked "serving" (train lại vô nghĩa).
 *   T9. windowHash trùng latest + CÙNG featureSet → blocked "latest".
 *   T10. windowHash trùng latest nhưng KHÁC featureSet → KHÔNG blocked
 *        (train lần đầu bộ đặc trưng mới là CẦN THIẾT — mirror B1 #81).
 *
 * Cách chạy: env -u DATABASE_URL bun scripts/p164-verify-psi-retrain.ts
 * Read-only: KHÔNG chạm DB (decision thuần — phần DB của lib không gọi).
 */
import {
  decidePsiRetrainGate,
  psiRetrainWindowBlocked,
  PSI_RETRAIN_COOLDOWN_HOURS,
} from "../src/lib/ml/psi-retrain";
import { PSI_WARN } from "../src/lib/ml/psi";

console.log(
  `== W3 #164 — guards auto-retrain PSI (ngưỡng ${PSI_WARN} · cooldown ${PSI_RETRAIN_COOLDOWN_HOURS}h) ==`
);
console.log(
  `  kill-switch/cooldown/ngưỡng: decidePsiRetrainGate · windowHash: psiRetrainWindowBlocked\n`
);

let fail = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`  ${ok ? "PASS" : "FAIL"} · ${name} — ${detail}`);
  if (!ok) fail++;
};

const now = Date.parse("2026-10-20T10:00:00.000Z");

/* ── G1 kill-switch ── */
const t1 = decidePsiRetrainGate({
  enabled: false,
  lastTriggerAt: null,
  now,
  maxPsi: 0.9, // PSI kinh khủng vẫn KHÔNG train khi kill-switch TẮT
});
check(
  "T1 Kill-switch TẮT chặn tuyệt đối (PSI 0,9 vẫn skip)",
  t1.outcome === "disabled",
  `outcome=${t1.outcome} · ${t1.reason.slice(0, 60)}…`
);

/* ── G2 cooldown 24h ── */
const t2 = decidePsiRetrainGate({
  enabled: true,
  lastTriggerAt: now - 10 * 3_600_000, // 10h trước
  now,
  maxPsi: 0.4,
});
check(
  "T2 Cooldown còn 14h → skip (PSI breach kéo dài không đấm train mỗi 15')",
  t2.outcome === "cooldown" && (t2.cooldownRemainingMs ?? 0) > 13 * 3_600_000,
  `outcome=${t2.outcome} · còn ${((t2.cooldownRemainingMs ?? 0) / 3_600_000).toFixed(2)}h`
);

const t3 = decidePsiRetrainGate({
  enabled: true,
  lastTriggerAt: now - PSI_RETRAIN_COOLDOWN_HOURS * 3_600_000, // đúng 24h
  now,
  maxPsi: 0.3,
});
check(
  "T3 Hết cooldown đúng 24h → mở lại (không khóa vĩnh viễn)",
  t3.outcome === "proceed",
  `outcome=${t3.outcome}`
);

/* ── G3 ngưỡng PSI ── */
const t4 = decidePsiRetrainGate({
  enabled: true,
  lastTriggerAt: null,
  now,
  maxPsi: PSI_WARN - 0.01,
});
check(
  `T4 PSI ${PSI_WARN - 0.01} < ${PSI_WARN} → skip "psi-below"`,
  t4.outcome === "psi-below",
  `outcome=${t4.outcome}`
);

const t5 = decidePsiRetrainGate({
  enabled: true,
  lastTriggerAt: null,
  now,
  maxPsi: PSI_WARN, // đúng biên — ngưỡng inclusive như psiLevel A3
});
check(
  `T5 PSI đúng biên ${PSI_WARN} (≥) → proceed`,
  t5.outcome === "proceed",
  `outcome=${t5.outcome}`
);

const t6 = decidePsiRetrainGate({
  enabled: true,
  lastTriggerAt: null,
  now,
  maxPsi: null, // drift unavailable
});
check(
  "T6 PSI unavailable → skip trung thực (không bịa số để quyết định)",
  t6.outcome === "psi-unavailable",
  `outcome=${t6.outcome}`
);

/* ── Đủ điều kiện ── */
const t7 = decidePsiRetrainGate({
  enabled: true,
  lastTriggerAt: now - 25 * 3_600_000, // 25h trước — hết cooldown
  now,
  maxPsi: 0.31,
});
check(
  "T7 Đủ điều kiện (BẬT + hết cooldown + PSI 0,31) → proceed",
  t7.outcome === "proceed",
  `outcome=${t7.outcome} · ${t7.reason}`
);

/* ── G4 windowHash ── */
const w1 = psiRetrainWindowBlocked({
  windowHash: "abc",
  servingHash: "abc",
  latestHash: "zzz",
  latestFeatureSet: "v2-lag16",
  currentFeatureSet: "v2-lag16",
});
check(
  "T8 windowHash trùng SERVING → blocked (cùng cửa sổ đang phục vụ)",
  w1.blocked && w1.matched === "serving",
  `blocked=${w1.blocked} matched=${w1.matched}`
);

const w2 = psiRetrainWindowBlocked({
  windowHash: "abc",
  servingHash: "xxx",
  latestHash: "abc",
  latestFeatureSet: "v2-lag16",
  currentFeatureSet: "v2-lag16",
});
check(
  "T9 windowHash trùng LATEST cùng featureSet → blocked (vừa train, deterministic)",
  w2.blocked && w2.matched === "latest",
  `blocked=${w2.blocked} matched=${w2.matched}`
);

const w3 = psiRetrainWindowBlocked({
  windowHash: "abc",
  servingHash: "xxx",
  latestHash: "abc",
  latestFeatureSet: "v2-lag16",
  currentFeatureSet: "v3-macro", // khác bộ đặc trưng — train lần đầu là CẦN
});
check(
  "T10 Trùng latest nhưng KHÁC featureSet → KHÔNG blocked (mirror B1 #81)",
  !w3.blocked,
  `blocked=${w3.blocked} (hash không đổi khi đổi đặc trưng — phải train)`
);

console.log(
  fail === 0
    ? `\nKẾT LUẬN: 10/10 PASS — auto-retrain PSI đủ 5 guard, không có đường "train失控".`
    : `\nKẾT LUẬN: ${fail} FAIL`
);
process.exit(fail === 0 ? 0 : 1);
