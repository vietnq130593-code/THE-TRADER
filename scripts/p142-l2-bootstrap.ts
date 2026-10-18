/**
 * scripts/p142-l2-bootstrap.ts (Task 142 · F-24 §6.3) — BOOTSTRAP KHO L2
 * TRI THỨC DÀI HẠN: index trọn corpus tuyển (~1.600 doc — research/executive
 * + tin vĩ mô + narrative chu kỳ + bài học WIN/LOSS) qua NIM thật.
 *
 * Chạy MỘT LẦN sau khi deploy code (các chu kỳ sau tự chữa ≤32 doc):
 *   env -u DATABASE_URL bun scripts/p142-l2-bootstrap.ts
 *
 * (env -u DATABASE_URL: shell sandbox có thể set sqlite → bỏ cho .env thắng.
 *  bun tự nạp .env.local → NIM key có sẵn.)
 *
 * Read-đọc corpus + GHI 3 bảng Knowledge* + AuditLog L2_INDEX — idempotent
 * theo (refTable, refId): chạy lại chỉ index phần thiếu/vector-null.
 */
import { db } from "../src/lib/db";
import { indexCorpus, l2Stats, relinkGraph, resetL2StatsCache } from "../src/lib/ml/l2";
import { nimApiKey } from "../src/lib/ml/nim-embed";

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║ TASK 142 — BOOTSTRAP L2 TRI THỨC DÀI HẠN (NIM nemotron-3-embed) ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  const key = nimApiKey();
  console.log(`NIM key: ${key ? `${key.slice(0, 12)}… (${key.length} ký tự)` : "THẤT BẠI — sẽ index BM25-only (fail-soft đúng thiết kế)"}`);

  const before = await l2Stats().catch(() => null);
  if (before) {
    console.log(`Trước: ${before.chunks} chunk · ${before.vectorCoverage.withVector} vector · ${before.pending} pending`);
  }

  const summary = await indexCorpus({ maxDocs: 5_000, budgetMs: 600_000 });

  // Đảm bảo đồ thị khớp kho (idempotent — sửa đường khi flush từng fail,
  // 0 cuộc gọi NIM vì đọc entityKeys đã lưu trong chunk).
  const relink = await relinkGraph();
  console.log(
    `\n  Relink đồ thị: ${relink.chunksScanned} chunk quét · ${relink.entities} thực thể · ${relink.cooccurEdges} cạnh cooccur · ${relink.marketRelationEdges} cạnh đo được`
  );

  console.log("\n── KẾT QUẢ BOOTSTRAP ──");
  console.log(`  Corpus tuyển      : ${summary.corpusDocs} doc`);
  console.log(`  Đã index          : ${summary.indexed} chunk`);
  console.log(`  Có vector NIM     : ${summary.embedded} (${summary.indexed ? Math.round((summary.embedded / summary.indexed) * 100) : 0}%)`);
  console.log(`  BM25-only (fail)  : ${summary.embedFailed}`);
  if (summary.embedError) console.log(`  Lỗi embed cuối    : ${summary.embedError}`);
  console.log(`  Token NIM đã dùng : ${summary.tokens.toLocaleString("en-US")} (~$${((summary.tokens / 1e6) * 0.02).toFixed(4)} nếu $0,02/MTok)`);
  console.log(`  Thời gian NIM     : ${(summary.nimMs / 1000).toFixed(1)}s`);
  console.log(`  Thời gian tổng    : ${(summary.totalMs / 1000).toFixed(1)}s`);
  console.log(`  Thực thể sờ tới   : ${summary.entitiesTouched}`);
  console.log(`  Cạnh cooccur      : ${summary.edgesCooccur}`);
  console.log(`  Cạnh đo được (MR) : ${summary.edgesMarketRelation}`);

  resetL2StatsCache();
  const after = await l2Stats().catch(() => null);
  if (after) {
    console.log("\n── SAU BOOTSTRAP (DB thật) ──");
    console.log(`  Chunks: ${after.chunks} · vector ${after.vectorCoverage.withVector} · BM25-only ${after.vectorCoverage.bm25Only} · pending ${after.pending}`);
    console.log(`  Theo nguồn: ${Object.entries(after.byRefTable).map(([k, v]) => `${k}=${v}`).join(" · ")}`);
    console.log(`  Thực thể: ${after.entities.total} (${Object.entries(after.entities.byType).map(([k, v]) => `${k}=${v}`).join(", ")})`);
    console.log(`  Cạnh: cooccur=${after.edges.cooccur} · market-relation=${after.edges.marketRelation}`);
  }

  try {
    await db.auditLog.create({
      data: {
        action: "L2_BOOTSTRAP",
        entity: "KnowledgeChunk",
        after: JSON.stringify(summary),
      },
    });
    console.log("\n  AuditLog L2_BOOTSTRAP đã ghi.");
  } catch {
    console.log("\n  (AuditLog ghi thất bại — không chặn)");
  }
  await db.$disconnect();
}

main().catch(async (e) => {
  console.error("LỖI BOOTSTRAP:", e);
  try { await db.$disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
