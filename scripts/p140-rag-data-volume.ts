/**
 * scripts/p140-rag-data-volume.ts (Task 140 — F-24 assessment) — ĐO KHỐI
 * LƯỢNG DỮ LIỆU THE TRADER trong DB Supabase để đánh giá khả năng nâng cấp
 * RAG BM25 viết tay (src/lib/ml/rag.ts, L1) lên LightRAG hoặc GraphRAG.
 *
 * READ-ONLY tuyệt đối: chỉ SELECT — không INSERT/UPDATE/DELETE bảng nào.
 * Kèm micro-test LLM thực (3 cuộc gọi chat glm-4.6 qua z-ai-web-dev-sdk,
 * mô phỏng prompt trích xuất thực thể kiểu LightRAG) để đo token-thực/chunk
 * thay vì ước lượng trên giấy.
 *
 * Chạy: env -u DATABASE_URL bun scripts/p140-rag-data-volume.ts
 * (env -u: shell sandbox có thể set DATABASE_URL sqlite → bỏ để .env thắng)
 */
import { db } from "../src/lib/db";

/* ─────────────── helpers ─────────────── */
const MB = 1024 * 1024;
const num = (v: unknown): number => (v == null ? 0 : Number(v));
const fmt = (n: number): string => Math.round(n).toLocaleString("en-US");
const mb = (bytes: number): string => `${(bytes / MB).toFixed(1)} MB`;
const days = (from: Date | null, to: Date | null): number =>
  from && to ? Math.max(1, (to.getTime() - from.getTime()) / 86_400_000) : 1;

async function q<T>(sql: string): Promise<T[]> {
  return db.$queryRawUnsafe(sql) as Promise<T[]>;
}

/* ─────────────── A. Tổng quan DB ─────────────── */
async function dbOverview(): Promise<void> {
  const [sz] = await q<{ bytes: string | bigint }>(
    `SELECT pg_database_size(current_database()) AS bytes`
  );
  console.log(`\n════ A. TỔNG QUAN DATABASE ════`);
  console.log(`  Kích thước toàn DB : ${mb(num(sz?.bytes))}`);

  const sizes = await q<{ relname: string; bytes: string | bigint }>(
    `SELECT c.relname, pg_total_relation_size(c.oid) AS bytes
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'trader' AND c.relkind = 'r'
      ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 15`
  );
  console.log(`  Top 15 bảng theo dung lượng:`);
  for (const s of sizes) console.log(`    ${String(s.relname).padEnd(22)} ${mb(num(s.bytes))}`);

  const tables = await q<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'trader' AND table_type = 'BASE TABLE'
      ORDER BY table_name`
  );
  console.log(`  Số bảng: ${tables.length} — số dòng mỗi bảng:`);
  const rows: { table: string; n: number }[] = [];
  for (const t of tables) {
    const ident = `"trader"."${t.table_name}"`;
    const [c] = await q<{ n: string | bigint }>(
      `SELECT COUNT(*) AS n FROM ${ident}`
    );
    rows.push({ table: t.table_name, n: num(c?.n) });
  }
  for (const r of rows.sort((a, b) => b.n - a.n))
    console.log(`    ${r.table.padEnd(22)} ${fmt(r.n)}`);
}

/* ─────────────── B. Corpus RAG hiện tại + mức sử dụng ─────────────── */
async function ragUsage(): Promise<void> {
  console.log(`\n════ B. RAG HIỆN TẠI (L1 BM25) — mức sử dụng thật ════`);
  const [rl] = await q<{
    total: string | bigint;
    used: string | bigint;
    d30: string | bigint;
    used30: string | bigint;
    avgtopk: string | number | null;
  }>(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE "usedInPrompt") AS used,
            COUNT(*) FILTER (WHERE "createdAt" >= now() - interval '30 days') AS d30,
            COUNT(*) FILTER (WHERE "createdAt" >= now() - interval '30 days' AND "usedInPrompt") AS used30,
            AVG("topK") AS avgtopk
       FROM "trader"."RetrievalLog"`
  );
  const [last] = await q<{ createdAt: Date; usedInPrompt: boolean }>(
    `SELECT "createdAt", "usedInPrompt" FROM "trader"."RetrievalLog"
      ORDER BY "createdAt" DESC LIMIT 1`
  );
  const total = num(rl?.total);
  const used = num(rl?.used);
  const d30 = num(rl?.d30);
  const used30 = num(rl?.used30);
  console.log(
    `  RetrievalLog: ${fmt(total)} lần truy hồi · vào prompt ${fmt(used)} (${total ? ((used / total) * 100).toFixed(1) : "0"}%)`
  );
  console.log(
    `  30 ngày    : ${fmt(d30)} lần · vào prompt ${fmt(used30)} (${d30 ? ((used30 / d30) * 100).toFixed(1) : "0"}%) · topK TB ${rl?.avgtopk ? Number(rl.avgtopk).toFixed(1) : "?"}`
  );
  console.log(
    `  Lần cuối   : ${last ? new Date(last.createdAt).toISOString() : "chưa có"} (usedInPrompt=${last?.usedInPrompt ?? "?"})`
  );
}

/* ─────────────── C. Kho văn bản toàn bộ (ứng viên corpus) ─────────────── */
interface TextInv {
  agentMsg: { n: number; chars: number; p50: number; p90: number; from: Date | null; to: Date | null; chatN: number; chatChars: number };
  news: { n: number; chars: number; p50: number; p90: number; from: Date | null; to: Date | null };
  signalRationale: { n: number; chars: number };
  assessmentDetail: { n: number; chars: number };
  insightNarrative: { n: number; chars: number };
}
async function textInventory(): Promise<TextInv> {
  console.log(`\n════ C. KHO VĂN BẢN TOÀN BỘ (ứng viên corpus nâng cấp) ════`);
  const [am] = await q<{
    n: string | bigint;
    chars: string | number | null;
    p50: string | number | null;
    p90: string | number | null;
  }>(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(length(content) + COALESCE(length(reasoning), 0)), 0) AS chars,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY length(content)) AS p50,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY length(content)) AS p90
       FROM "trader"."AgentMessage"
      WHERE broadcast = true AND direction = 'AGENT'`
  );
  const [span] = await q<{ from: Date | null; to: Date | null }>(
    `SELECT MIN("createdAt") AS from, MAX("createdAt") AS to FROM "trader"."AgentMessage"`
  );
  const [chat] = await q<{ n: string | bigint; chars: string | number | null }>(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(length(content) + COALESCE(length(reasoning), 0)), 0) AS chars
       FROM "trader"."AgentMessage"
      WHERE NOT broadcast OR direction <> 'AGENT'`
  );
  const [ni] = await q<{
    n: string | bigint;
    chars: string | number | null;
    p50: string | number | null;
    p90: string | number | null;
  }>(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(length(title) + COALESCE(length(summary), 0)), 0) AS chars,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY length(title) + COALESCE(length(summary), 0)) AS p50,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY length(title) + COALESCE(length(summary), 0)) AS p90
       FROM "trader"."NewsItem"`
  );
  const [nspan] = await q<{ from: Date | null; to: Date | null }>(
    `SELECT MIN("publishedAt") AS from, MAX("publishedAt") AS to FROM "trader"."NewsItem"`
  );
  const [sig] = await q<{ n: string | bigint; chars: string | number | null }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(length(rationale)), 0) AS chars FROM "trader"."Signal"`
  );
  const [ma] = await q<{ n: string | bigint; chars: string | number | null }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(length(detail)), 0) AS chars FROM "trader"."MarketAssessment"`
  );
  const [ri] = await q<{ n: string | bigint; chars: string | number | null }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(length(narrative)), 0) AS chars FROM "trader"."RelationInsight"`
  );

  const agentMsg = {
    n: num(am?.n),
    chars: num(am?.chars),
    p50: num(am?.p50),
    p90: num(am?.p90),
    from: span?.from ?? null,
    to: span?.to ?? null,
    chatN: num(chat?.n),
    chatChars: num(chat?.chars),
  };
  const news = {
    n: num(ni?.n),
    chars: num(ni?.chars),
    p50: num(ni?.p50),
    p90: num(ni?.p90),
    from: nspan?.from ?? null,
    to: nspan?.to ?? null,
  };
  const signalRationale = { n: num(sig?.n), chars: num(sig?.chars) };
  const assessmentDetail = { n: num(ma?.n), chars: num(ma?.chars) };
  const insightNarrative = { n: num(ri?.n), chars: num(ri?.chars) };

  console.log(
    `  AgentMessage (broadcast AGENT — corpus RAG hiện lấy 500): ${fmt(agentMsg.n)} tin · ${fmt(agentMsg.chars)} ký tự (${mb(agentMsg.chars)}) · p50 ${fmt(agentMsg.p50)} / p90 ${fmt(agentMsg.p90)} ký tự/tin`
  );
  console.log(
    `    nhịp tăng: ${(agentMsg.n / days(agentMsg.from, agentMsg.to)).toFixed(1)} tin/ngày (${agentMsg.from?.toISOString().slice(0, 10)} → ${agentMsg.to?.toISOString().slice(0, 10)})`
  );
  console.log(
    `    (ngoài corpus: chat 1-1 ${fmt(agentMsg.chatN)} tin · ${fmt(agentMsg.chatChars)} ký tự)`
  );
  console.log(
    `  NewsItem (corpus RAG hiện lấy 200): ${fmt(news.n)} tin · ${fmt(news.chars)} ký tự (${mb(news.chars)}) · p50 ${fmt(news.p50)} / p90 ${fmt(news.p90)} ký tự/tin`
  );
  console.log(
    `    nhịp tăng: ${(news.n / days(news.from, news.to)).toFixed(1)} tin/ngày (${news.from?.toISOString().slice(0, 10)} → ${news.to?.toISOString().slice(0, 10)})`
  );
  console.log(
    `  Tri thức dài hạn (ứng viên L2): Signal.rationale ${fmt(signalRationale.n)} · ${fmt(signalRationale.chars)} ký tự`
  );
  console.log(
    `    MarketAssessment.detail ${fmt(assessmentDetail.n)} · ${fmt(assessmentDetail.chars)} ký tự`
  );
  console.log(
    `    RelationInsight.narrative ${fmt(insightNarrative.n)} · ${fmt(insightNarrative.chars)} ký tự`
  );
  return { agentMsg, news, signalRationale, assessmentDetail, insightNarrative };
}

/* ─────────────── D. Thành phần corpus ─────────────── */
async function composition(): Promise<void> {
  console.log(`\n════ D. THÀNH PHẦN CORPUS ════`);
  const agents = await q<{ code: string; n: string | bigint; chars: string | number | null }>(
    `SELECT a.code, COUNT(*) AS n, SUM(length(m.content)) AS chars
       FROM "trader"."AgentMessage" m JOIN "trader"."Agent" a ON a.id = m."fromAgentId"
      WHERE m.broadcast = true AND m.direction = 'AGENT'
      GROUP BY a.code ORDER BY COUNT(*) DESC LIMIT 10`
  );
  console.log(`  Top 10 agent nói nhiều nhất (broadcast):`);
  for (const a of agents)
    console.log(`    ${a.code.padEnd(20)} ${fmt(num(a.n))} tin · ${fmt(num(a.chars))} ký tự`);
  const sources = await q<{ source: string; n: string | bigint }>(
    `SELECT source, COUNT(*) AS n FROM "trader"."NewsItem" GROUP BY source ORDER BY COUNT(*) DESC`
  );
  console.log(`  NewsItem theo nguồn:`);
  for (const s of sources) console.log(`    ${s.source.padEnd(20)} ${fmt(num(s.n))}`);
  const cats = await q<{ category: string | null; n: string | bigint }>(
    `SELECT category, COUNT(*) AS n FROM "trader"."NewsItem" GROUP BY category ORDER BY COUNT(*) DESC`
  );
  console.log(`  NewsItem theo chuyên mục:`);
  for (const c of cats)
    console.log(`    ${(c.category ?? "(null)").padEnd(20)} ${fmt(num(c.n))}`);
}

/* ─────────────── E. Đồ thị & chi phí LLM đã có sẵn ─────────────── */
async function graphAndLlmSpend(): Promise<{ cycleCost30d: number; tokens30dIn: number; tokens30dOut: number }> {
  console.log(`\n════ E. ĐỒ THỊ SẴN CÓ + CHI PHÍ LLM ĐÃ CHI 30 NGÀY ════`);
  const [mr] = await q<{ n: string | bigint; kinds: string | null; nodes: string | bigint }>(
    `SELECT COUNT(*) AS n,
            STRING_AGG(DISTINCT kind, ', ') AS kinds,
            COUNT(DISTINCT "sourceKey") + COUNT(DISTINCT "targetKey") AS nodes
       FROM "trader"."MarketRelation"`
  );
  console.log(
    `  MarketRelation (đồ thị quan hệ ĐO ĐƯỢC): ${fmt(num(mr?.n))} cạnh · ${fmt(num(mr?.nodes))} đỉnh · kinds=${mr?.kinds ?? "?"}`
  );
  const [ag] = await q<{ n: string | bigint; groups: string | null }>(
    `SELECT COUNT(*) AS n, STRING_AGG(DISTINCT "group", ', ') AS groups FROM "trader"."Agent"`
  );
  console.log(`  Agent: ${fmt(num(ag?.n))} (${ag?.groups ?? "?"})`);
  const [ins] = await q<{ n: string | bigint; markets: string | null }>(
    `SELECT COUNT(*) AS n, STRING_AGG(DISTINCT market::text, ', ') AS markets FROM "trader"."Instrument"`
  );
  console.log(`  Instrument: ${fmt(num(ins?.n))} (${ins?.markets ?? "?"})`);
  const [sp] = await q<{ n: string | bigint }>(
    `SELECT COUNT(*) AS n FROM "trader"."AgentMessage" WHERE "toAgentId" IS NOT NULL`
  );
  console.log(`  Cạnh agent→agent (tin 1-1): ${fmt(num(sp?.n))}`);
  const [run] = await q<{
    n: string | bigint;
    tin: string | number | null;
    tout: string | number | null;
    cost: string | number | null;
    d30n: string | bigint;
    d30cost: string | number | null;
  }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM("tokensIn"),0) AS tin, COALESCE(SUM("tokensOut"),0) AS tout,
            COALESCE(SUM("costUsd"),0) AS cost,
            COUNT(*) FILTER (WHERE "startedAt" >= now() - interval '30 days') AS d30n,
            COALESCE(SUM("costUsd") FILTER (WHERE "startedAt" >= now() - interval '30 days'),0) AS d30cost
       FROM "trader"."AgentRun"`
  );
  console.log(
    `  AgentRun toàn bộ: ${fmt(num(run?.n))} run · tokensIn ${fmt(num(run?.tin))} · tokensOut ${fmt(num(run?.tout))} · $${num(run?.cost).toFixed(2)}`
  );
  console.log(
    `  AgentRun 30 ngày: ${fmt(num(run?.d30n))} run · $${num(run?.d30cost).toFixed(2)}`
  );
  return { cycleCost30d: num(run?.d30cost), tokens30dIn: num(run?.tin), tokens30dOut: num(run?.tout) };
}

/* ─────────────── F. Micro-test LLM trích xuất thực thể (kiểu LightRAG) ─────────────── */
interface Extraction {
  docKind: string;
  chars: number;
  tokensIn: number | null;
  tokensOut: number | null;
  ms: number;
  entities: number;
  relations: number;
}
async function microTest(): Promise<Extraction[]> {
  console.log(`\n════ F. MICRO-TEST LLM (glm-4.6 qua z-ai-web-dev-sdk) — trích xuất thực thể kiểu LightRAG ════`);
  console.log(`  3 tài liệu đại diện, chunk ≤1.200 ký tự, mô phỏng prompt indexing LightRAG/GraphRAG`);

  const docs: { docKind: string; text: string }[] = [];
  const [am] = await q<{ content: string; reasoning: string | null; code: string | null }>(
    `SELECT m.content, m.reasoning, a.code
       FROM "trader"."AgentMessage" m JOIN "trader"."Agent" a ON a.id = m."fromAgentId"
      WHERE m.broadcast = true AND m.direction = 'AGENT' AND length(m.content) BETWEEN 300 AND 1500
      ORDER BY m."createdAt" DESC LIMIT 1`
  );
  if (am) docs.push({ docKind: `AgentMessage(${am.code})`, text: [am.content, am.reasoning ?? ""].join("\n") });
  for (const cat of ["macro", "company", "market"]) {
    const [ni] = await q<{ title: string; summary: string | null; source: string }>(
      `SELECT title, summary, source FROM "trader"."NewsItem"
        WHERE category = '${cat}' AND length(COALESCE(summary,'')) > 60
        ORDER BY "publishedAt" DESC LIMIT 1`
    );
    if (ni && docs.length < 3)
      docs.push({ docKind: `NewsItem(${cat}/${ni.source})`, text: `${ni.title}\n${ni.summary ?? ""}` });
  }
  while (docs.length < 3) {
    const [ni] = await q<{ title: string; summary: string | null; source: string }>(
      `SELECT title, summary, source FROM "trader"."NewsItem" ORDER BY "publishedAt" DESC LIMIT 1`
    );
    if (!ni) break;
    docs.push({ docKind: `NewsItem(${ni.source})`, text: `${ni.title}\n${ni.summary ?? ""}` });
  }

  const mod = await import("z-ai-web-dev-sdk");
  const ZAI = (mod as { default: { create: () => Promise<unknown> } }).default;
  const zai = (await ZAI.create()) as {
    chat: { completions: { create: (b: unknown) => Promise<unknown> } };
  };

  const SYSTEM =
    "Bạn là module trích xuất thực thể/quan hệ cho đồ thị tri thức tài chính Việt Nam (bước indexing của LightRAG/GraphRAG). " +
    "Đọc đoạn văn và trả về ĐÚNG JSON, không văn thừa: " +
    '{"entities":[{"name":"","type":"ổ chức|chỉ số| cổ phiếu|ngành|sự kiện|chỉ báo vĩ mô","description":""}],' +
    '"relationships":[{"source":"","target":"","description":"","keywords":""}]}. ' +
    "Quan hệ chỉ khi văn bản nêu rõ mối liên hệ nhân quả/ảnh hưởng.";

  const results: Extraction[] = [];
  for (const d of docs) {
    const text = d.text.slice(0, 1200);
    const t0 = Date.now();
    try {
      const completion = (await zai.chat.completions.create({
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: `Đoạn văn:\n"""\n${text}\n"""` },
        ],
      })) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const raw = completion?.choices?.[0]?.message?.content ?? "";
      const m = raw.match(/\{[\s\S]*\}/);
      let entities = 0;
      let relations = 0;
      if (m) {
        try {
          const parsed = JSON.parse(m[0]) as {
            entities?: unknown[];
            relationships?: unknown[];
          };
          entities = parsed.entities?.length ?? 0;
          relations = parsed.relationships?.length ?? 0;
        } catch {
          /* JSON lỗi — vẫn tính token */
        }
      }
      results.push({
        docKind: d.docKind,
        chars: text.length,
        tokensIn: completion?.usage?.prompt_tokens ?? null,
        tokensOut: completion?.usage?.completion_tokens ?? null,
        ms: Date.now() - t0,
        entities,
        relations,
      });
      console.log(
        `  ✓ ${d.docKind}: ${text.length} ký tự → ${entities} thực thể + ${relations} quan hệ · ${completion?.usage?.prompt_tokens ?? "?"} in / ${completion?.usage?.completion_tokens ?? "?"} out token · ${Date.now() - t0}ms`
      );
    } catch (e) {
      console.log(`  ✗ ${d.docKind}: LỖI LLM — ${String(e).slice(0, 120)}`);
    }
  }
  return results;
}

/* ─────────────── G. Mô hình chi phí (từ số đo thật) ─────────────── */
function costModel(inv: TextInv, extractions: Extraction[]): void {
  console.log(`\n════ G. MÔ HÌNH CHI PHÍ INDEXING (từ số đo ở C + F) ════`);
  const CHUNK_CHARS = 3000; // ≈1.200 token tiếng Việt (~2,5 ký tự/token)
  const chunksMsg = Math.max(inv.agentMsg.n, Math.ceil(inv.agentMsg.chars / CHUNK_CHARS));
  const chunksNews = Math.max(inv.news.n, Math.ceil(inv.news.chars / CHUNK_CHARS));
  const chunks = chunksMsg + chunksNews;
  console.log(
    `  Chunk (1.200 token ≈ 3.000 ký tự): ${fmt(chunksMsg)} (AgentMessage) + ${fmt(chunksNews)} (NewsItem) = ${fmt(chunks)} chunk`
  );

  const tin = extractions.filter((e) => e.tokensIn != null);
  const tout = extractions.filter((e) => e.tokensOut != null);
  const avgIn = tin.length ? tin.reduce((s, e) => s + (e.tokensIn ?? 0), 0) / tin.length : 2200;
  const avgOut = tout.length ? tout.reduce((s, e) => s + (e.tokensOut ?? 0), 0) / tout.length : 700;
  console.log(
    `  Token đo được/cuộc trích xuất: ${avgIn.toFixed(0)} in / ${avgOut.toFixed(0)} out (n=${tin.length} cuộc gọi thật; fallback 2.200/700 nếu micro-test lỗi)`
  );

  // GLM-4.6: $0.6/MTok in · $2.2/MTok out (src/lib/llm.ts)
  const costPerCall = (avgIn / 1e6) * 0.6 + (avgOut / 1e6) * 2.2;
  const lightragCalls = 2 * chunks; // trích xuất + 1 vòng gleaning
  const lightragCost = lightragCalls * costPerCall;
  console.log(
    `  LightRAG index trọn bộ : ~${fmt(lightragCalls)} cuộc gọi LLM (2/chunk) ≈ $${lightragCost.toFixed(2)}`
  );
  const graphragCalls = 3.5 * chunks + 40; // trích xuất + gleaning + gộp mô tả + báo cáo cộng đồng
  const graphragCost = graphragCalls * costPerCall;
  console.log(
    `  GraphRAG index trọn bộ : ~${fmt(graphragCalls)} cuộc gọi LLM (≈3,5/chunk + báo cáo cộng đồng) ≈ $${graphragCost.toFixed(2)}`
  );

  // Nhịp tăng hằng ngày (incremental)
  const msgPerDay = inv.agentMsg.n / days(inv.agentMsg.from, inv.agentMsg.to);
  const newsPerDay = inv.news.n / days(inv.news.from, inv.news.to);
  const chunksPerDay = Math.ceil(msgPerDay) + Math.ceil(newsPerDay);
  console.log(
    `  Incremental mỗi ngày  : ~${fmt(chunksPerDay)} chunk mới → LightRAG ~$${(2 * chunksPerDay * costPerCall).toFixed(3)}/ngày · GraphRAG ~$${(3.5 * chunksPerDay * costPerCall).toFixed(3)}/ngày (chưa kể tái phân cụm cộng đồng)`
  );
  console.log(
    `  Query-time            : LightRAG ~1 cuộc gọi/khối (tách từ khoá) — hoặc 0 nếu giữ query-builder BM25 sẵn có`
  );
  console.log(
    `                          GraphRAG global search = map-reduce 10-30 cuộc gọi MỖI truy vấn (không khớp kiến trúc tiêm khối ngữ cảnh của THE TRADER)`
  );
}

/* ─────────────── main ─────────────── */
async function main(): Promise<void> {
  console.log(`╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║ TASK 140 — ĐO KHỐI LƯỢNG DỮ LIỆU THE TRADER (read-only)      ║`);
  console.log(`║ Mục đích: đánh giá nâng cấp RAG BM25 → LightRAG / GraphRAG   ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝`);
  await dbOverview();
  await ragUsage();
  const inv = await textInventory();
  await composition();
  const spend = await graphAndLlmSpend();
  const extractions = await microTest();
  costModel(inv, extractions);
  console.log(`\n  (Tham chiếu: chi phí LLM 30 ngày gần nhất của toàn hệ thống: $${spend.cycleCost30d.toFixed(2)})`);
  await db.$disconnect();
}

main().catch(async (e) => {
  console.error("LỖI:", e);
  try { await db.$disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
