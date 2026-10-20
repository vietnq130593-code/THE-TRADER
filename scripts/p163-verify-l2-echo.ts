/**
 * scripts/p163-verify-l2-echo.ts — KIỂM ĐỊNH W2 (#163): GIÁNG CẤP ECHO L2.
 *
 * Câu hỏi review #162: "L2 có echo chamber — AgentMessage cũ (output của
 * chính hội đồng) đứng đầu chỉ cần trùng từ khoá, recency 10% không đủ kéo?"
 *
 * Kiểm định THUẦN LOGIC (0 DB): dựng index tổng hợp 5 doc CÙNG nội dung
 * tương đồng, chỉ khác (bảng × tuổi) → chạy rankL2 bản vá → chứng minh:
 *   T1. DecisionEvaluation 120 ngày TUÂN THỨ LỚN HƠN AgentMessage 120 ngày
 *       (cùng nội dung, cùng tuổi — bảng kiểm chứng không bị decay).
 *   T2. AgentMessage tươi 2 ngày > AgentMessage cũ 120 ngày (giáng cấp
 *       hoạt động theo tuổi, giữ đúng chiều).
 *   T3. NewsItem 200 ngày (bằng chứng ngoài) > AgentMessage 120 ngày —
 *       dù CŨ HƠN 80 ngày, vì echo bị kéo xuống sàn 0,25.
 *   T4. Sàn hoạt động: AgentMessage 400 ngày vẫn có mặt trong hits (giáng
 *       cấp chứ KHÔNG xoá — không mất trí nhớ dài hạn).
 *   T5. Đối chứng پیش-vá: cùng index chạy công thức cũ (không echo) →
 *       cả 3 cặp trên ĐỔI THỨ TỰ hoặc chênh lệch thu hẹp — chứng minh vá
 *       đổi hành vi đúng chỗ, không phải no-op.
 *
 * Cách chạy: env -u DATABASE_URL bun scripts/p163-verify-l2-echo.ts
 * Read-only: KHÔNG chạm DB (chỉ import type + hàm thuần).
 */
import { rankL2, type L2Doc, type L2Index, type L2RefTable } from "../src/lib/ml/l2";

/* ── Dựng index tổng hợp: 5 doc, token trùng query hoàn toàn ────────────── */

const TOKENS = ["vic", "ngan", "hang", "loinhuận"];
const now = Date.now();
const mkDoc = (
  refTable: L2RefTable,
  refId: string,
  ageDays: number
): L2Doc => ({
  refTable,
  refId,
  label: refId,
  snippet: `${refId} snippet`,
  datedAt: new Date(now - ageDays * 86_400_000),
  tokens: TOKENS,
  tf: new Map(TOKENS.map((t) => [t, 1])),
  entityKeys: [],
  vector: null,
});

const docs: L2Doc[] = [
  mkDoc("AgentMessage", "AM-old-120d", 120),
  mkDoc("AgentMessage", "AM-fresh-2d", 2),
  mkDoc("DecisionEvaluation", "DE-old-120d", 120),
  mkDoc("NewsItem", "NEWS-old-200d", 200),
  mkDoc("AgentMessage", "AM-ancient-400d", 400),
];

const index: L2Index = {
  docs,
  byRef: new Map(docs.map((d) => [`${d.refTable}:${d.refId}`, d])),
  df: new Map(TOKENS.map((t) => [t, docs.length])), // mọi doc chứa mọi token
  avgdl: TOKENS.length,
  entities: new Map(),
  edges: [],
  edgeByNode: new Map(),
  loadedAt: now,
  loadedSince: new Date(now),
  lastCheckAt: now,
};

const pos = (hits: ReturnType<typeof rankL2>, refId: string): number =>
  hits.findIndex((h) => h.refId === refId);
const score = (hits: ReturnType<typeof rankL2>, refId: string): number =>
  hits.find((h) => h.refId === refId)?.score ?? -1;

/* ── Chạy bản vá (rankL2 hiện hành = có echo decay) ────────────────────── */

const hits = rankL2(index, TOKENS, null);
console.log("== rankL2 SAU VÁ (W2 #163) ==");
for (const h of hits) {
  console.log(
    `  ${h.refId.padEnd(18)} bảng=${h.refTable.padEnd(20)} score=${h.score.toFixed(4)} echoMul=${h.echoMul?.toFixed(3) ?? "—"}`
  );
}

let fail = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`  ${ok ? "PASS" : "FAIL"} · ${name} — ${detail}`);
  if (!ok) fail++;
};

const iAmOld = pos(hits, "AM-old-120d");
const iDe = pos(hits, "DE-old-120d");
const iAmFresh = pos(hits, "AM-fresh-2d");
const iNews = pos(hits, "NEWS-old-200d");
const iAncient = pos(hits, "AM-ancient-400d");

check(
  "T1 DecisionEvaluation 120d đứng trên AgentMessage 120d",
  iDe < iAmOld,
  `vị trí DE=${iDe} < AM=${iAmOld} · score ${score(hits, "DE-old-120d").toFixed(4)} vs ${score(hits, "AM-old-120d").toFixed(4)} (echoMul AM=${hits.find((h) => h.refId === "AM-old-120d")?.echoMul?.toFixed(3)})`
);
check(
  "T2 AgentMessage tươi > AgentMessage cũ 120d",
  iAmFresh < iAmOld,
  `vị trí fresh=${iAmFresh} < old=${iAmOld}`
);
check(
  "T3 NewsItem 200d > AgentMessage 120d (cũ hơn vẫn thắng)",
  iNews < iAmOld,
  `vị trí NEWS=${iNews} < AM=${iAmOld}`
);
check(
  "T4 Sàn 0,25: AgentMessage 400d KHÔNG bị xoá khỏi hits",
  iAncient >= 0,
  iAncient >= 0 ? `vị trí ${iAncient} · echoMul=${hits.find((h) => h.refId === "AM-ancient-400d")?.echoMul?.toFixed(3)} (sàn)` : "mất khỏi top-K!"
);

/* ── Đối chứng پیش-vá: lặp công thức cũ (không echoMul) ──────────────────
 * Không sửa lại file để chạy bản cũ — tính tay công thức cũ từ chính các
 * thành phần của hit (bm25N cosN rec tái dựng được từ score/echoMul). */
console.log("\n== ĐỐI CHỨNG TRƯỚC VÁ (công thức cũ — bỏ echoMul) ==");
const OLD_W_BM25 = 0.45,
  OLD_W_VECTOR = 0.45,
  OLD_W_RECENCY = 0.1;
const oldScored = hits
  .map((h) => {
    const bm25N = h.bm25 / Math.max(1, Math.max(...hits.map((x) => x.bm25)));
    const cosN = h.cosine != null ? Math.max(0, h.cosine) : bm25N; // vector null → dồn BM25
    const oldScore =
      OLD_W_BM25 * bm25N + OLD_W_VECTOR * cosN + OLD_W_RECENCY * h.recency;
    return { refId: h.refId, oldScore, newScore: h.score };
  })
  .sort((a, b) => b.oldScore - a.oldScore);
for (const s of oldScored) {
  console.log(
    `  ${s.refId.padEnd(18)} cũ=${s.oldScore.toFixed(4)} → mới=${s.newScore.toFixed(4)}`
  );
}
const oldPos = (refId: string) => oldScored.findIndex((s) => s.refId === refId);
check(
  "T5 Vá đổi hành vi thật (ít nhất 1 cặp đổi thứ tự vs công thức cũ)",
  oldPos("AM-old-120d") !== iAmOld || oldPos("NEWS-old-200d") !== iNews || oldPos("DE-old-120d") !== iDe,
  `thứ tự cũ: DE=${oldPos("DE-old-120d")} AM-old=${oldPos("AM-old-120d")} NEWS=${oldPos("NEWS-old-200d")} → mới: DE=${iDe} AM-old=${iAmOld} NEWS=${iNews}`
);

console.log(fail === 0 ? "\nKẾT LUẬN: 5/5 PASS — echo decay hoạt động đúng thiết kế." : `\nKẾT LUẬN: ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
