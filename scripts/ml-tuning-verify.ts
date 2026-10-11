/**
 * scripts/ml-tuning-verify.ts (#89) — nghiệm thu tích hợp AppSetting
 * "ml-tuning" ↔ RAG THẬT (không LLM, không đụng chu kỳ agent):
 *
 *  T1 — GET /api/ml/tuning trả saved rỗng + effective = mặc định.
 *  T2 — POST {rag: {topK: 5, wRecency: 0.4}} → saved ghi đúng, effective đổi.
 *  T3 — retrieveForCycle() chạy THẬT (corpus DB + BM25 + recency) →
 *       hits ≤ 5 (topK 5) + RetrievalLog.topK = 5 (bằng chứng dùng tuning).
 *  T4 — POST {resetRag: true} → saved.rag xoá, effective về mặc định 8/0,3.
 *  T5 — dọn RetrievalLog dòng test (giữ sạch số liệu 30 ngày).
 *
 * Chạy: bun scripts/ml-tuning-verify.ts
 */

import { db } from "../src/lib/db";
import { retrieveForCycle } from "../src/lib/ml/rag";

const API = "http://localhost:3000/api/ml/tuning";
const results: string[] = [];

async function getTuning(): Promise<{
  saved: { rag?: Record<string, number> };
  effective: { rag: { topK: number; wRecency: number } };
}> {
  const res = await fetch(API, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET tuning ${res.status}`);
  return (await res.json()) as never;
}

async function postTuning(body: Record<string, unknown>) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { ok?: boolean; fields?: string[]; error?: string };
  if (!res.ok || data.ok !== true) {
    throw new Error(`POST tuning ${res.status}: ${data.error ?? ""} ${(data.fields ?? []).join("; ")}`);
  }
  return data;
}

async function main() {
  const fail = (name: string, detail: string) => {
    results.push(`✗ ${name}: ${detail}`);
    throw new Error(detail);
  };

  // Dọn trước — idempotent khi chạy lại sau lần fail (vòng trước có thể để
  // lại saved.rag từ T2). ResetRag xoá section — trạng thái về sạch như chưa
  // từng có key.
  await postTuning({ resetRag: true });

  // T1 — trạng thái sạch ban đầu
  const t1 = await getTuning();
  if (t1.saved.rag != null || t1.effective.rag.topK !== 8 || t1.effective.rag.wRecency !== 0.3) {
    fail("T1", `saved=${JSON.stringify(t1.saved)} effective=${JSON.stringify(t1.effective.rag)}`);
  }
  results.push("T1 PASS — saved rỗng · effective = mặc định (topK 8 · wRecency 0,3)");

  // T2 — ghi tuning RAG mới
  await postTuning({ rag: { topK: 5, wRecency: 0.4 } });
  const t2 = await getTuning();
  if (t2.saved.rag?.topK !== 5 || t2.saved.rag?.wRecency !== 0.4) {
    fail("T2", `saved.rag=${JSON.stringify(t2.saved.rag)}`);
  }
  if (t2.effective.rag.topK !== 5) fail("T2", `effective.topK=${t2.effective.rag.topK}`);
  results.push("T2 PASS — POST {topK 5, wRecency 0,4} ghi AppSetting + effective phản ánh");

  // T3 — retrieval THẬT dùng tuning (corpus + BM25 + log)
  const retrieval = await retrieveForCycle(false);
  if (retrieval.hits.length > 5) {
    fail("T3", `hits=${retrieval.hits.length} > topK 5`);
  }
  if (retrieval.logId == null) fail("T3", "không tạo RetrievalLog");
  const logRow = await db.retrievalLog.findUnique({ where: { id: retrieval.logId! } });
  if (logRow?.topK !== 5) fail("T3", `RetrievalLog.topK=${logRow?.topK} ≠ 5`);
  results.push(
    `T3 PASS — retrieveForCycle thật: ${retrieval.hits.length} hits (≤5) · RetrievalLog.topK=5 · corpus ${retrieval.corpusSize} docs`
  );

  // T4 — reset về mặc định
  await postTuning({ resetRag: true });
  const t4 = await getTuning();
  if (t4.saved.rag != null || t4.effective.rag.topK !== 8 || t4.effective.rag.wRecency !== 0.3) {
    fail("T4", `saved=${JSON.stringify(t4.saved)} effective=${JSON.stringify(t4.effective.rag)}`);
  }
  results.push("T4 PASS — resetRag → saved.rag xoá · effective về 8/0,3");

  // T5 — dọn dòng log test
  if (retrieval.logId != null) {
    await db.retrievalLog.delete({ where: { id: retrieval.logId } });
  }
  results.push("T5 PASS — xoá RetrievalLog dòng test (số liệu 30 ngày giữ sạch)");

  console.log(results.join("\n"));
  console.log(`\nKẾT QUẢ: ${results.length}/${results.length} PASS`);
}

main()
  .catch((err) => {
    console.error("VERIFY FAILED:", err instanceof Error ? err.message : err);
    console.error(results.join("\n"));
    process.exitCode = 1;
  })
  .finally(() => {
    void db.$disconnect();
  });
