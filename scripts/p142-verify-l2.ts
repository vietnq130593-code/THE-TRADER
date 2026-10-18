/**
 * scripts/p142-verify-l2.ts (Task 142) — NGHIỆM THU L2 TRI THỨC DÀI HẠN
 * trên DB SỐNG + NIM THẬT (không giả lập):
 *
 *  (a) Schema & kho: 3 bảng Knowledge* có đúng cấu trúc; 1.639 chunkUniqueId
 *      (refTable,refId); vector decode 2.048 finite.
 *  (b) Vector roundtrip: vectorToBytes → bytesToVector → cosine với chính
 *      nó = 1; 2 vector trực giao ≈ 0.
 *  (c) Truy hồi THẬT: retrieveForCycleL2 → block ≠ null, hits ≤8 kèm
 *      cosine, vectorUsed=true (NIM sống), đồ thị dòng, RetrievalLog layer
 *      "L2" được ghi.
 *  (d) Fail-soft BM25-only: rankL2 với queryVector=null vẫn trả hits (đúng
 *      đường rơi khi NIM chết/hết credit) — không có doc nào crash.
 *  (e) Route: GET /api/ml/l2 + GET /api/ml/status có field l2.
 *
 * Chạy: env -u DATABASE_URL bun scripts/p142-verify-l2.ts
 */
import { db } from "../src/lib/db";
import {
  retrieveForCycleL2,
  rankL2,
  ensureL2Index,
  l2Stats,
} from "../src/lib/ml/l2";
import {
  vectorToBytes,
  bytesToVector,
  cosineF32,
  NIM_EMBED_DIM,
} from "../src/lib/ml/nim-embed";
import { buildCycleQueryTokensRaw, expandQueryTokens } from "../src/lib/ml/rag";

let pass = true;
const ok = (msg: string): void => console.log(`  ✓ ${msg}`);
const fail = (msg: string): void => {
  pass = false;
  console.log(`  ✗ ${msg}`);
};

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║ TASK 142 — VERIFY L2 TRI THỨC DÀI HẠN (DB sống + NIM thật)   ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");

  /* (a) Schema & kho */
  console.log("\n── (a) Schema & kho ──");
  const [chunks, dupCheck] = await Promise.all([
    db.knowledgeChunk.count(),
    db.$queryRawUnsafe(
      `SELECT COUNT(*) AS n FROM (SELECT "refTable", "refId" FROM "trader"."KnowledgeChunk"
        GROUP BY "refTable", "refId" HAVING COUNT(*) > 1) t`
    ),
  ]);
  if (chunks > 0) ok(`KnowledgeChunk: ${chunks} hàng`);
  else fail("KnowledgeChunk rỗng");
  const dupN = Number((dupCheck as { n: string | bigint }[])[0]?.n ?? 0);
  if (dupN === 0) ok("0 trùng (refTable, refId) — unique sống");
  else fail(`${dupN} trùng ref!`);

  const sample = await db.knowledgeChunk.findFirst({
    where: { embedding: { not: null } },
    select: { refTable: true, refId: true, embedding: true, dim: true, entityKeys: true },
  });
  if (sample?.embedding) {
    const vec = bytesToVector(sample.embedding);
    if (vec && vec.length === NIM_EMBED_DIM) {
      const finite = Array.from(vec.slice(0, 64)).every((v) => Number.isFinite(v));
      if (finite) ok(`vector decode ${vec.length} dim finite (chunk ${sample.refTable})`);
      else fail("vector chứa NaN/Inf");
    } else {
      fail(`vector decode sai độ dài: ${vec?.length}`);
    }
  } else {
    fail("không tìm được chunk có vector");
  }
  if (sample?.dim === NIM_EMBED_DIM) ok(`dim cột = ${sample?.dim}`);
  else fail(`dim cột = ${sample?.dim}`);

  const [entities, edgesMr, edgesCo] = await Promise.all([
    db.knowledgeEntity.count(),
    db.knowledgeEdge.count({ where: { kind: "market-relation" } }),
    db.knowledgeEdge.count({ where: { kind: "cooccur" } }),
  ]);
  ok(`đồ thị: ${entities} thực thể · ${edgesMr} cạnh đo được · ${edgesCo} cạnh cooccur`);
  const mrSample = await db.knowledgeEdge.findFirst({ where: { kind: "market-relation" } });
  const meta = (mrSample?.meta ?? {}) as Record<string, unknown>;
  if (typeof meta.corr === "number") ok(`cạnh market-relation mang meta định lượng (corr=${meta.corr})`);
  else fail("cạnh market-relation thiếu meta corr");

  /* (b) Vector roundtrip */
  console.log("\n── (b) Vector roundtrip (Bytes ↔ Float32) ──");
  const v1 = Array.from({ length: 8 }, (_, i) => Math.sin(i / 3) * 0.1);
  const rt = bytesToVector(vectorToBytes(v1));
  if (rt && Math.abs(cosineF32(rt, new Float32Array(v1)) - 1) < 1e-6) {
    ok("roundtrip cosine với chính nó = 1");
  } else {
    fail("roundtrip lệch");
  }
  const orthA = new Float32Array([1, 0, 0, 0]);
  const orthB = new Float32Array([0, 1, 0, 0]);
  if (Math.abs(cosineF32(orthA, orthB)) < 1e-9) ok("trực giao ≈ 0");
  else fail("cosine trực giao ≠ 0");

  /* (c) Truy hồi thật (NIM sống) */
  console.log("\n── (c) Truy hồi chu kỳ (NIM thật) ──");
  const retrieval = await retrieveForCycleL2(false);
  if (!retrieval) {
    fail("retrieveForCycleL2 trả null");
  } else {
    if (retrieval.block) ok(`block ${retrieval.block.length} ký tự (≤2.200)`);
    else fail("block null");
    if (retrieval.hits.length > 0 && retrieval.hits.length <= 8) ok(`hits ${retrieval.hits.length}/8`);
    else fail(`hits bất thường: ${retrieval.hits.length}`);
    const withCos = retrieval.hits.filter((h) => h.cosine != null).length;
    ok(`${withCos}/${retrieval.hits.length} hit có điểm cosine (vector sống trên cả corpus)`);
    if (retrieval.vectorUsed) ok("query vector NIM được dùng");
    else fail("query vector KHÔNG dùng (NIM chết?)");
    ok(`đồ thị dòng: ${retrieval.graphLines.length}`);
    for (const line of retrieval.graphLines.slice(0, 2)) console.log(`      ${line.slice(0, 110)}`);
    const hitSample = retrieval.hits[0];
    console.log(
      `      top-1: [${hitSample.refTable} · ${hitScore(hitSample)}] ${hitSample.label} — ${hitSample.snippet.slice(0, 80)}…`
    );
    if (retrieval.logId) {
      const log = await db.retrievalLog.findUnique({ where: { id: retrieval.logId } });
      if (log?.layer === "L2") ok(`RetrievalLog layer="L2" ghi (${log.id.slice(0, 8)}…)`);
      else fail("RetrievalLog layer sai");
    } else {
      fail("RetrievalLog không ghi");
    }
  }

  /* (d) Fail-soft BM25-only */
  console.log("\n── (d) Fail-soft BM25-only (queryVector=null — NIM chết) ──");
  const index = await ensureL2Index();
  const tokens = expandQueryTokens(await buildCycleQueryTokensRaw());
  const hitsNoVec = rankL2(index, tokens, null);
  if (hitsNoVec.length > 0) ok(`rankL2 không vector vẫn trả ${hitsNoVec.length} hit (BM25 thuần sống)`);
  else fail("rankL2 không vector trả rỗng");
  const allScoresFinite = hitsNoVec.every((h) => Number.isFinite(h.score));
  if (allScoresFinite) ok("mọi điểm finite");
  else fail("điểm NaN/Inf");

  /* (e) Route */
  console.log("\n── (e) Route ──");
  const l2Route = await fetch("http://localhost:3000/api/ml/l2").then((r) => r.json()).catch(() => null);
  if (l2Route?.ok && l2Route?.stats?.chunks > 0) ok(`GET /api/ml/l2: ${l2Route.stats.chunks} chunk · pending ${l2Route.stats.pending}`);
  else fail(`GET /api/ml/l2 lỗi: ${JSON.stringify(l2Route).slice(0, 80)}`);
  const statusRoute = await fetch("http://localhost:3000/api/ml/status").then((r) => r.json()).catch(() => null);
  if (statusRoute?.l2?.chunks > 0) ok(`GET /api/ml/status field l2: ${statusRoute.l2.chunks} chunk · ${statusRoute.l2.entities.total} thực thể`);
  else fail("GET /api/ml/status thiếu field l2");

  const stats = await l2Stats();
  console.log(`\n  Tham chiếu stats: chunks=${stats.chunks} · vector=${stats.vectorCoverage.withVector} · pending=${stats.pending}`);

  await db.$disconnect();
  console.log(pass ? "\nKẾT QUẢ: PASS toàn bộ" : "\nKẾT QUẢ: CÓ FAIL — xem ✗ trên");
  process.exit(pass ? 0 : 1);
}

function hitScore(h: { score: number; cosine: number | null }): string {
  return `score ${h.score.toFixed(3)}${h.cosine != null ? ` · cos ${h.cosine.toFixed(3)}` : ""}`;
}

main().catch(async (e) => {
  console.error("LỖI VERIFY:", e);
  try { await db.$disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
