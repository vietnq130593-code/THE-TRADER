/**
 * src/lib/ml/l2.ts — L2 TRI THỨC DÀI HẠN (Task 142 · F-24 — RAG_UPGRADE_
 * ASSESSMENT §6, thiết kế đã đo thật Task 140/141).
 *
 * LightRAG-style VIẾT TAY đúng triết lý dự án (0 dependency ngoài stack):
 *   1. CORPUS TUYỂN (§6.1) — L1 BM25 chỉ nhớ 3-5 ngày (500+200 doc cuộn);
 *      L2 index corpus dài hạn: broadcast research+executive + tin vĩ mô +
 *      narrative MarketAssessment (kho 773k ký tự chưa từng dùng) + bài học
 *      WIN/LOSS DecisionEvaluation + Signal.rationale + RelationInsight.
 *   2. ĐỒ THỊ THỰC THỂ TỪ ĐIỂN HOÁ (§6.2) — bootstrap từ dữ liệu ĐÃ CÓ:
 *      104 Instrument + 11 nhóm MACRO_SYNONYMS + org thường gặp + 40 cạnh
 *      MarketRelation ĐO ĐƯỢC (cạnh định lượng thật — LLM không bao giờ đè).
 *      Trích xuất LLM bổ sung: SAU này khi credit NIM được xác nhận (§9.5).
 *   3. HYBRID BM25 + VECTOR NIM (§6.4 — Task 141 đo nemotron-3-embed-1b
 *      2048 dim tách nghĩa tiếng Việt 9×): score = 0,45·BM25(chuẩn hoá) +
 *      0,45·cosine + 0,10·độ tươi (nửa đời 30 NGÀY — L2 là trí nhớ dài hạn,
 *      khác nửa đời 72h của L1). Vector lưu Bytes 8KB/chunk, cosine
 *      in-memory (2.291 doc ≈ 19MB — pgvector chỉ cần >50k doc §6.3).
 *   4. FAIL-SOFT 2 TẦNG: NIM lỗi/hết credit → BM25 thuần (chunk sống tiếp);
 *      DB lỗi → block null → prompt y như trước L2. Chu kỳ KHÔNG bao giờ bị phá.
 *   5. TỰ CHỮA (§6.3): mỗi lần truy hồi, index tối đa 32 doc mới (budget
 *      12s) — kho tự lớn theo nhịp +185 doc/ngày, không cần hạ tầng cron mới;
 *      bootstrap ban đầu chạy scripts/p142-l2-bootstrap.ts.
 *   6. ĐO LƯỜNG: RetrievalLog.layer = "L2" (cổng §6.5 sau 30 ngày song song).
 *
 * Vô hại hoá giữ nguyên văn hoá L1: mọi dòng kèm mốc thời gian + ghi chú
 * "NGỮ CẢNH QUÁ KHỨC dùng ĐỐI CHIẾU — không thay bằng chứng định lượng".
 */

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  tokenize,
  expandQueryTokens,
  buildCycleQueryTokensRaw,
  bm25Score,
  MACRO_SYNONYM_GROUPS_EXPORT,
  type RagDoc,
  type RagIndex,
} from "@/lib/ml/rag";
import {
  embedTexts,
  vectorToBytes,
  bytesToVector,
  cosineF32,
  NIM_EMBED_MODEL,
  NIM_EMBED_DIM,
} from "@/lib/ml/nim-embed";

/* ─────────────── Hằng số (§6 — mọi con số đều dẫn chứng đánh giá) ─────────────── */

/** §6.1 — cap mỗi nguồn corpus tuyển. */
const CAP_MESSAGES = 800; // broadcast research+executive (hiện 502)
const CAP_NEWS = 1200; // NewsItem macro+market (hiện 975)
const CAP_ASSESSMENTS = 200; // MarketAssessment narrative (hiện 62 sống)
const CAP_SIGNALS = 300; // Signal.rationale (hiện 51)
const CAP_LESSONS = 300; // DecisionEvaluation (hiện 48)
const CAP_INSIGHTS = 20; // RelationInsight (hiện 1)
/** Cap ký tự nội dung 1 chunk (≈1.100 token — cùng cỡ chunk L1/Task 141). */
const CONTENT_CHAR_CAP = 2_800;
/** Top-K hits khối L2 (đối xứng L1 top-8). */
const L2_TOP_K = 8;
/** Trọng số hybrid (§6.4) — hằng số v1, chưa đưa ml-tuning (cổng §6.5 sau 30 ngày). */
const W_BM25 = 0.45;
const W_VECTOR = 0.45;
const W_RECENCY = 0.1;

/* ── W2 (#163 · review #162) — KIỂM SOÁT ECHO CHAMBER ──────────────────────
 * Review #162 phát hiện: 619/2.044 chunks là CHÍNH output hội đồng
 * (AgentMessage) được index lại làm tri thức → chu kỳ sau truy hồi nhận định
 * cũ của chính mình làm bằng chứng → rủi ro information cascade (thiên kiến
 * tự củng cố). Thành phần recency30 sẵn có (W_RECENCY=0,1) quá yếu để chống:
 * 90% trọng số còn lại thuần theo độ tương đồng — echo 3 tháng tuổi vẫn đứng
 * đầu chỉ cần trùng từ khoá.
 *
 * GIẢI PHÁP phẫu thuật (không phải xoá trí nhớ dài hạn): GIÁNG CẤP điểm của
 * bảng TỰ THAM CHIẾU theo tuổi bằng hệ số nhân nửa đời 45 ngày, sàn 0,25 —
 * tức echo 45 ngày cũ còn 50%, 90 ngày còn 25% (tương thích sổ sống D-LEDGER
 * 90 ngày), nhưng KHÔNG bao giờ về 0: nhận định cũ thật sự liên quan vẫn
 * được truy hồi khi không còn gì tươi hơn. Bảng KIỂM CHỨNG/NGOÀI giữ nguyên
 * trọng lượng: NewsItem (bằng chứng bên ngoài) · DecisionEvaluation (bài
 * học ĐÃ settle theo realized) · Signal · RelationInsight — đây mới là trí
 * nhớ dài hạn thật của hệ thống, tuổi càng lớn giá trị càng bền. */
const ECHO_TABLES = new Set<L2RefTable>(["AgentMessage", "MarketAssessment"]);
/** Nửa đời echo (ngày) — 45d: 90d còn 0,25 · 135d chạm sàn. */
const ECHO_HALF_LIFE_DAYS = 45;
/** Sàn hệ số echo — giáng cấp chứ không xoá (tránh mất trí nhớ dài hạn). */
const ECHO_FLOOR = 0.25;
/** Nửa đời độ tươi L2: 30 ngày (L1 là 72h — L2 là trí nhớ dài hạn). */
const RECENCY_HALF_LIFE_H = 30 * 24;
/** Ngưỡng cosine để doc được coi "liên quan ngữ nghĩa" khi BM25 = 0. */
const COS_FLOOR = 0.3;
/** Cap ký tự khối prompt L2 (~900 token — L1 cap 3.000 ký tự ≈1.200 token). */
export const L2_BLOCK_CHAR_CAP = 2_200;
/** Cap ký tự snippet 1 dòng. */
const SNIPPET_CHAR_CAP = 340;
/** Số dòng đồ thị tối đa trong khối. */
const GRAPH_LINES_CAP = 4;
/** Tự chữa mỗi truy hồi: tối đa 32 doc mới, budget 12s (§6.3). */
const SELF_HEAL_MAX_DOCS = 32;
const SELF_HEAL_BUDGET_MS = 12_000;
/** Số lần thử embed tối đa/doc trước khi chờ rebuild chủ động. */
const MAX_EMBED_ATTEMPTS = 3;
/** Cache chỉ số (status route poll 30s — tránh dồn truy vấn corpus). */
const STATS_TTL_MS = 30_000;
/** Cache vector query theo token (6 agent 1 chu kỳ dựng cùng query). */
const QUERY_VEC_TTL_MS = 60_000;

/* ─────────────── Types ─────────────── */

export type L2RefTable =
  | "AgentMessage"
  | "NewsItem"
  | "MarketAssessment"
  | "Signal"
  | "DecisionEvaluation"
  | "RelationInsight";

/** Doc L2 — không extends RagDoc (refTable rộng hơn L1: +4 bảng tri thức dài
 *  hạn); khi gọi bm25Score của L1 thì cast unknown (cùng mặt cấu trúc tokens/tf). */
export interface L2Doc {
  refTable: L2RefTable;
  refId: string;
  label: string;
  snippet: string;
  datedAt: Date;
  tokens: string[];
  tf: Map<string, number>;
  entityKeys: string[];
  vector: Float32Array | null;
}

export interface L2GraphEntity {
  key: string;
  name: string;
  type: string;
}

export interface L2GraphEdge {
  sourceKey: string;
  targetKey: string;
  kind: "cooccur" | "market-relation";
  weight: number;
  meta: Record<string, unknown> | null;
}

export interface L2Index {
  docs: L2Doc[];
  byRef: Map<string, L2Doc>;
  df: Map<string, number>;
  avgdl: number;
  entities: Map<string, L2GraphEntity>;
  edges: L2GraphEdge[];
  edgeByNode: Map<string, L2GraphEdge[]>;
  loadedAt: number;
  loadedSince: Date;
  lastCheckAt: number;
}

export interface L2Hit {
  refTable: L2RefTable;
  refId: string;
  label: string;
  snippet: string;
  datedAt: Date;
  score: number;
  bm25: number;
  cosine: number | null;
  recency: number;
  /** W2 (#163) — hệ số giáng cấp echo (1 cho bảng kiểm chứng; <1 theo tuổi
   *  cho AgentMessage/MarketAssessment). Additive: caller cũ bỏ qua được. */
  echoMul?: number;
}

export interface L2Retrieval {
  block: string | null;
  hits: L2Hit[];
  graphLines: string[];
  vectorUsed: boolean;
  queryTokens: string[];
  queryTokensExpanded: string[];
  logId: string | null;
  corpusSize: number;
}

interface CorpusDoc {
  refTable: L2RefTable;
  refId: string;
  label: string;
  content: string;
  datedAt: Date;
}

/* ─────────────── 1. Từ điển thực thể (§6.2 — bootstrap từ dữ liệu đã có) ─────────────── */

/** Tổ chức thường gặp ngoài danh mục Instrument — alias tokenize-key trỏ 1 key. */
const ORG_ENTITIES: readonly { key: string; name: string; aliases: readonly string[] }[] = [
  { key: "org:sbv", name: "Ngân hàng Nhà nước (SBV)", aliases: ["sbv", "ngân hàng nhà nước", "nhnn"] },
  { key: "org:fed", name: "Cục Dự trữ Liên bang Mỹ (Fed)", aliases: ["fed", "cục dự trữ liên bang"] },
  { key: "org:imf", name: "Quỹ Tiền tệ Quốc tế (IMF)", aliases: ["imf", "quỹ tiền tệ quốc tế"] },
  { key: "org:world-bank", name: "Ngân hàng Thế giới", aliases: ["world bank", "ngân hàng thế giới"] },
  { key: "org:mof", name: "Bộ Tài chính", aliases: ["bộ tài chính"] },
  { key: "org:ssc", name: "Ủy ban Chứng khoán Nhà nước", aliases: ["ssc", "ubck", "ủy ban chứng khoán"] },
  { key: "org:hose", name: "Sở GDCK TP.HCM (HOSE)", aliases: ["hose", "sở gdck tp hcm"] },
  { key: "org:hnx", name: "Sở GDCK Hà Nội (HNX)", aliases: ["hnx", "sở gdck hà nội"] },
  { key: "org:vndirect", name: "VNDIRECT", aliases: ["vndirect"] },
  { key: "org:moit", name: "Bộ Công Thương", aliases: ["bộ công thương"] },
];

export interface EntityDict {
  /** cụm token (join " ") → định nghĩa thực thể. */
  byPhrase: Map<string, L2GraphEntity>;
  /** khoá thực thể → định nghĩa (tra O(1) khi seed). */
  byKey: Map<string, L2GraphEntity>;
  maxPhraseTokens: number;
}

let entityDictCache: EntityDict | null = null;

/** Xây từ điển: Instrument + nhóm vĩ mô + org + đỉnh MarketRelation. Fail-soft → rỗng. */
export async function buildEntityDict(): Promise<EntityDict> {
  if (entityDictCache) return entityDictCache;
  const byPhrase = new Map<string, L2GraphEntity>();
  const byKey = new Map<string, L2GraphEntity>();
  const addPhrase = (phrase: string, def: L2GraphEntity) => {
    const p = phrase.trim();
    if (p) byPhrase.set(p, def);
    byKey.set(def.key, def);
  };
  let maxN = 1;
  try {
    const instruments = await db.instrument.findMany({
      where: { isActive: true, deletedAt: null },
      select: { symbol: true, name: true, type: true },
    });
    for (const ins of instruments) {
      const type = ins.type === "INDEX" ? "index" : ins.type === "STOCK" ? "stock" : "asset";
      const def: L2GraphEntity = {
        key: `${type}:${ins.symbol.toLowerCase()}`,
        name: `${ins.symbol} — ${ins.name}`,
        type,
      };
      const phrase = tokenize(ins.symbol).join(" ");
      addPhrase(phrase, def);
    }
  } catch {
    /* fail-soft — từ điển thiếu mã vẫn chạy */
  }
  for (const group of MACRO_SYNONYM_GROUPS_EXPORT) {
    const def: L2GraphEntity = { key: `macro:${group[0]}`, name: group[0], type: "macro" };
    for (const member of group) {
      const toks = tokenize(member);
      maxN = Math.max(maxN, toks.length);
      addPhrase(toks.join(" "), def);
    }
  }
  for (const org of ORG_ENTITIES) {
    const def: L2GraphEntity = { key: org.key, name: org.name, type: "org" };
    for (const alias of org.aliases) {
      const toks = tokenize(alias);
      maxN = Math.max(maxN, toks.length);
      addPhrase(toks.join(" "), def);
    }
  }
  try {
    const rels = await db.marketRelation.findMany({
      select: { sourceKey: true, sourceLabel: true, targetKey: true, targetLabel: true },
    });
    const seen = new Map<string, string>();
    for (const r of rels) {
      seen.set(r.sourceKey, r.sourceLabel);
      seen.set(r.targetKey, r.targetLabel);
    }
    for (const [k, label] of seen) {
      const def: L2GraphEntity = { key: `node:${k}`, name: label || k, type: "node" };
      const toks = tokenize(k);
      maxN = Math.max(maxN, toks.length);
      addPhrase(toks.join(" "), def);
    }
  } catch {
    /* fail-soft */
  }
  entityDictCache = { byPhrase, byKey, maxPhraseTokens: Math.min(4, maxN) };
  return entityDictCache;
}

/** Xoá cache từ điển (test / sau khi Instrument đổi). */
export function resetEntityDictCache(): void {
  entityDictCache = null;
}

/**
 * Liên kết token → khoá thực thể (dùng cho NỘI DUNG lúc index và CHO QUERY lúc
 * truy hồi — cùng 1 hàm, đối xứng). Quét n-gram dài→ngắn, khớp thì nhích qua
 * n token (chống nhiễu chồng lấp).
 */
export function linkEntities(tokens: string[], dict: EntityDict): string[] {
  const keys = new Set<string>();
  let i = 0;
  while (i < tokens.length) {
    let matched = 0;
    let def: L2GraphEntity | undefined;
    for (let n = dict.maxPhraseTokens; n >= 1; n--) {
      if (i + n > tokens.length) continue;
      const phrase = tokens.slice(i, i + n).join(" ");
      const hit = dict.byPhrase.get(phrase);
      if (hit) {
        def = hit;
        matched = n;
        break;
      }
    }
    if (def && matched > 0) {
      keys.add(def.key);
      i += matched;
    } else {
      i += 1;
    }
  }
  return [...keys];
}

/* ─────────────── 2. Corpus tuyển (§6.1) ─────────────── */

/** narrative từ MarketAssessment.detail JSON — fail-soft null. */
function narrativeOf(detail: string): string | null {
  try {
    const j = JSON.parse(detail) as { narrative?: unknown };
    const n = j?.narrative;
    return typeof n === "string" && n.trim().length > 0 ? n.trim() : null;
  } catch {
    return null;
  }
}

function clip(text: string, cap: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= cap) return t;
  const cut = t.slice(0, cap);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > cap * 0.6 ? cut.slice(0, lastSpace) : cut) + "…";
}

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/** Nạp corpus tuyển — 6 nguồn, mỗi nguồn cap riêng, MỚI NHẤT đứng trước. Fail-soft từng nguồn. */
export async function loadCorpusDocs(): Promise<CorpusDoc[]> {
  const docs: CorpusDoc[] = [];
  try {
    const messages = await db.agentMessage.findMany({
      where: {
        broadcast: true,
        direction: "AGENT",
        fromAgent: { group: { in: ["research", "executive"] } },
      },
      orderBy: { createdAt: "desc" },
      take: CAP_MESSAGES,
      select: {
        id: true,
        content: true,
        reasoning: true,
        createdAt: true,
        fromAgent: { select: { code: true } },
      },
    });
    for (const m of messages) {
      docs.push({
        refTable: "AgentMessage",
        refId: m.id,
        label: m.fromAgent?.code ?? "agent",
        content: [m.content, m.reasoning ?? ""].join("\n").trim(),
        datedAt: m.createdAt,
      });
    }
  } catch {
    /* bỏ nguồn */
  }
  try {
    const news = await db.newsItem.findMany({
      orderBy: { publishedAt: "desc" },
      take: CAP_NEWS,
      select: { id: true, title: true, summary: true, source: true, publishedAt: true },
    });
    for (const n of news) {
      docs.push({
        refTable: "NewsItem",
        refId: n.id,
        label: `tin ${n.source}`,
        content: n.summary ? `${n.title} — ${n.summary}` : n.title,
        datedAt: n.publishedAt,
      });
    }
  } catch {
    /* bỏ nguồn */
  }
  try {
    const assessments = await db.marketAssessment.findMany({
      orderBy: { createdAt: "desc" },
      take: CAP_ASSESSMENTS,
      select: { id: true, detail: true, marketDirection: true, createdAt: true },
    });
    for (const a of assessments) {
      const narrative = narrativeOf(a.detail);
      if (!narrative) continue; // không có narrative → không phải tri thức văn bản
      docs.push({
        refTable: "MarketAssessment",
        refId: a.id,
        label: "nhận định chu kỳ",
        content: `Nhận định hội đồng (${a.marketDirection}) chu kỳ ${isoDate(a.createdAt)}: ${narrative}`,
        datedAt: a.createdAt,
      });
    }
  } catch {
    /* bỏ nguồn */
  }
  try {
    const signals = await db.signal.findMany({
      orderBy: { createdAt: "desc" },
      take: CAP_SIGNALS,
      select: {
        id: true,
        direction: true,
        rationale: true,
        consensusGate: true,
        createdAt: true,
        instrument: { select: { symbol: true } },
      },
    });
    for (const s of signals) {
      docs.push({
        refTable: "Signal",
        refId: s.id,
        label: `tín hiệu ${s.instrument.symbol}`,
        content: `Tín hiệu ${s.direction} ${s.instrument.symbol}${
          s.consensusGate ? ` (cổng ${s.consensusGate})` : ""
        } ngày ${isoDate(s.createdAt)}: ${s.rationale}`,
        datedAt: s.createdAt,
      });
    }
  } catch {
    /* bỏ nguồn */
  }
  try {
    const [lessons, instruments] = await Promise.all([
      db.decisionEvaluation.findMany({
        orderBy: { decidedAt: "desc" },
        take: CAP_LESSONS,
        select: {
          id: true,
          direction: true,
          verdict: true,
          markPnlPct: true,
          executionKind: true,
          world: true,
          decidedAt: true,
          instrumentId: true,
        },
      }),
      db.instrument.findMany({ select: { id: true, symbol: true } }),
    ]);
    const symbolById = new Map(instruments.map((i) => [i.id, i.symbol]));
    for (const l of lessons) {
      const symbol = l.instrumentId ? (symbolById.get(l.instrumentId) ?? "?") : "?";
      docs.push({
        refTable: "DecisionEvaluation",
        refId: l.id,
        label: `bài học ${l.verdict} ${symbol}`,
        content:
          `Bài học tín hiệu ${l.direction} ${symbol} ngày ${isoDate(l.decidedAt)}: phán quyết ${l.verdict}` +
          (l.markPnlPct != null ? ` ${l.markPnlPct.toFixed(1)}% theo hướng` : "") +
          (l.executionKind ? ` · ${l.executionKind}` : "") +
          (l.world ? ` · thế giới ${l.world}` : ""),
        datedAt: l.decidedAt,
      });
    }
  } catch {
    /* bỏ nguồn */
  }
  try {
    const insights = await db.relationInsight.findMany({
      orderBy: { generatedAt: "desc" },
      take: CAP_INSIGHTS,
      select: { id: true, narrative: true, generatedAt: true },
    });
    for (const r of insights) {
      docs.push({
        refTable: "RelationInsight",
        refId: r.id,
        label: "tổng hợp quan hệ",
        content: r.narrative,
        datedAt: r.generatedAt,
      });
    }
  } catch {
    /* bỏ nguồn */
  }
  for (const d of docs) d.content = clip(d.content, CONTENT_CHAR_CAP);
  return docs;
}

/* ─────────────── 3. Indexer (bootstrap + tự chữa) ─────────────── */

export interface L2IndexSummary {
  corpusDocs: number;
  indexed: number;
  embedded: number;
  embedFailed: number;
  tokens: number;
  nimMs: number;
  totalMs: number;
  entitiesTouched: number;
  edgesCooccur: number;
  edgesMarketRelation: number;
  embedError?: string;
}

interface GraphStats {
  entities: Map<string, { key: string; name: string; type: string; mentions: number; first: Date; last: Date }>;
  edges: Map<string, { sourceKey: string; targetKey: string; weight: number; last: Date }>;
}

/** Nạp sẵn thực thể chưa có để cạnh đồ thị không treo lơ lửng (node:*). */
async function seedEntities(
  stats: GraphStats,
  keys: string[],
  dict: EntityDict
): Promise<void> {
  for (const key of keys) {
    if (stats.entities.has(key)) continue;
    const def = dict.byKey.get(key);
    const now = new Date();
    stats.entities.set(key, {
      key,
      name: def?.name ?? key,
      type: def?.type ?? key.split(":")[0],
      mentions: 0,
      first: now,
      last: now,
    });
  }
}

/** Ghép thực thể + cạnh đồng xuất hiện của 1 doc vào bộ tích luỹ in-memory. */
function accumulateGraph(doc: CorpusDoc, docEntityKeys: string[], stats: GraphStats): void {
  const now = doc.datedAt;
  for (const key of docEntityKeys) {
    const e = stats.entities.get(key);
    if (e) {
      e.mentions += 1;
      if (now < e.first) e.first = now;
      if (now > e.last) e.last = now;
    }
  }
  for (let a = 0; a < docEntityKeys.length; a++) {
    for (let b = a + 1; b < docEntityKeys.length; b++) {
      const [sourceKey, targetKey] = [docEntityKeys[a], docEntityKeys[b]].sort();
      const pairKey = `${sourceKey}→${targetKey}`;
      const edge = stats.edges.get(pairKey) ?? {
        sourceKey,
        targetKey,
        weight: 0,
        last: now,
      };
      edge.weight += 1;
      if (now > edge.last) edge.last = now;
      stats.edges.set(pairKey, edge);
    }
  }
}

/** id cho raw INSERT — Prisma @default(cuid()) là default CLIENT-side, raw
 *  SQL phải tự sinh (crypto.randomUUID đủ duy nhất cho bảng tri thức). */
function rawId(): string {
  return globalThis.crypto.randomUUID();
}

/** Flush bộ tích luỹ bằng raw multi-row INSERT ... ON CONFLICT (gộp dần). */
async function flushGraphStats(stats: GraphStats): Promise<void> {
  const now = new Date();
  const entities = [...stats.entities.values()];
  for (let i = 0; i < entities.length; i += 500) {
    const rows = entities.slice(i, i + 500);
    await db.$executeRaw`
      INSERT INTO "trader"."KnowledgeEntity"
        ("id", "key", "name", "type", "description", "mentions", "firstSeenAt", "lastSeenAt", "updatedAt")
      VALUES ${Prisma.join(
        rows.map(
          (e) =>
            Prisma.sql`(${rawId()}, ${e.key}, ${e.name}, ${e.type}, NULL, ${e.mentions}, ${e.first}, ${e.last}, ${now})`
        )
      )}
      ON CONFLICT ("key") DO UPDATE SET
        "mentions" = "trader"."KnowledgeEntity"."mentions" + EXCLUDED."mentions",
        "lastSeenAt" = EXCLUDED."lastSeenAt",
        "updatedAt" = EXCLUDED."updatedAt"`;
  }
  const edges = [...stats.edges.values()];
  for (let i = 0; i < edges.length; i += 500) {
    const rows = edges.slice(i, i + 500);
    await db.$executeRaw`
      INSERT INTO "trader"."KnowledgeEdge"
        ("id", "sourceKey", "targetKey", "kind", "description", "weight", "meta", "lastSeenAt", "updatedAt")
      VALUES ${Prisma.join(
        rows.map(
          (e) =>
            Prisma.sql`(${rawId()}, ${e.sourceKey}, ${e.targetKey}, 'cooccur', NULL, ${e.weight}, NULL, ${e.last}, ${now})`
        )
      )}
      ON CONFLICT ("sourceKey", "targetKey", "kind") DO UPDATE SET
        "weight" = "trader"."KnowledgeEdge"."weight" + EXCLUDED."weight",
        "lastSeenAt" = EXCLUDED."lastSeenAt",
        "updatedAt" = EXCLUDED."updatedAt"`;
  }
}

/** Nhập cạnh MarketRelation ĐO ĐƯỢC (kind market-relation — replace semantics). */
async function importMarketRelations(): Promise<number> {
  const rels = await db.marketRelation.findMany();
  if (!rels.length) return 0;
  const now = new Date();
  const nodes = new Map<string, string>();
  for (const r of rels) {
    nodes.set(r.sourceKey, r.sourceLabel);
    nodes.set(r.targetKey, r.targetLabel);
  }
  for (let i = 0; i < [...nodes.keys()].length; i += 500) {
    const rows = [...nodes.entries()].slice(i, i + 500);
    await db.$executeRaw`
      INSERT INTO "trader"."KnowledgeEntity"
        ("id", "key", "name", "type", "description", "mentions", "firstSeenAt", "lastSeenAt", "updatedAt")
      VALUES ${Prisma.join(
        rows.map(
          ([k, label]) =>
            Prisma.sql`(${rawId()}, ${`node:${k}`}, ${label || k}, 'node', NULL, 0, ${now}, ${now}, ${now})`
        )
      )}
      ON CONFLICT ("key") DO UPDATE SET
        "name" = EXCLUDED."name",
        "updatedAt" = EXCLUDED."updatedAt"`;
  }
  for (let i = 0; i < rels.length; i += 200) {
    const rows = rels.slice(i, i + 200);
    await db.$executeRaw`
      INSERT INTO "trader"."KnowledgeEdge"
        ("id", "sourceKey", "targetKey", "kind", "description", "weight", "meta", "lastSeenAt", "updatedAt")
      VALUES ${Prisma.join(
        rows.map((r) =>
          Prisma.sql`(
            ${rawId()},
            ${`node:${r.sourceKey}`}, ${`node:${r.targetKey}`}, 'market-relation',
            ${`${r.sourceLabel} → ${r.targetLabel} (lag ${r.lag})`},
            ${r.strength},
            ${Prisma.sql`${JSON.stringify(
              Object.fromEntries(
                Object.entries({
                  corr: r.corr,
                  condUp: r.condUp,
                  condDown: r.condDown,
                  obs: r.obs,
                  lag: r.lag,
                  shockUpN: r.shockUpN,
                  shockDownN: r.shockDownN,
                  windowFrom: r.windowFrom?.toISOString(),
                  windowTo: r.windowTo?.toISOString(),
                }).filter(([, v]) => v != null)
              )
            )}::jsonb`},
            ${r.computedAt}, ${now}
          )`
        )
      )}
      ON CONFLICT ("sourceKey", "targetKey", "kind") DO UPDATE SET
        "description" = EXCLUDED."description",
        "weight" = EXCLUDED."weight",
        "meta" = EXCLUDED."meta",
        "lastSeenAt" = EXCLUDED."lastSeenAt",
        "updatedAt" = EXCLUDED."updatedAt"`;
  }
  return rels.length;
}

/**
 * DỰNG LẠI ĐỒ THỊ từ entityKeys ĐÃ LƯU trong KnowledgeChunk (0 cuộc gọi NIM —
 * đường sửa chữa khi flush đồ thị fail sau khi chunk đã ghi, hoặc khi chủ sở
 * hữu muốn đồng bộ lại mentions/cạnh với kho hiện tại). Idempotent:
 * xoá cạnh cooccur → đếm lại từ đầu → REPLACE mentions (LEAST/GREATEST giữ
 * biên thời gian rộng nhất) → nhập lại MarketRelation.
 */
export async function relinkGraph(): Promise<{
  chunksScanned: number;
  entities: number;
  cooccurEdges: number;
  marketRelationEdges: number;
}> {
  await db.knowledgeEdge.deleteMany({ where: { kind: "cooccur" } });
  const rows = await db.knowledgeChunk.findMany({
    select: { refTable: true, refId: true, entityKeys: true, datedAt: true },
  });
  const stats: GraphStats = { entities: new Map(), edges: new Map() };
  const dict = await buildEntityDict();
  for (const r of rows) {
    const keys = Array.isArray(r.entityKeys) ? (r.entityKeys as string[]) : [];
    await seedEntities(stats, keys, dict);
    accumulateGraph(
      { refTable: r.refTable as L2RefTable, refId: r.refId, label: "", content: "", datedAt: r.datedAt },
      keys,
      stats
    );
  }
  const now = new Date();
  const entities = [...stats.entities.values()];
  for (let i = 0; i < entities.length; i += 500) {
    const part = entities.slice(i, i + 500);
    await db.$executeRaw`
      INSERT INTO "trader"."KnowledgeEntity"
        ("id", "key", "name", "type", "description", "mentions", "firstSeenAt", "lastSeenAt", "updatedAt")
      VALUES ${Prisma.join(
        part.map(
          (e) =>
            Prisma.sql`(${rawId()}, ${e.key}, ${e.name}, ${e.type}, NULL, ${e.mentions}, ${e.first}, ${e.last}, ${now})`
        )
      )}
      ON CONFLICT ("key") DO UPDATE SET
        "mentions" = EXCLUDED."mentions",
        "firstSeenAt" = LEAST("trader"."KnowledgeEntity"."firstSeenAt", EXCLUDED."firstSeenAt"),
        "lastSeenAt" = GREATEST("trader"."KnowledgeEntity"."lastSeenAt", EXCLUDED."lastSeenAt"),
        "updatedAt" = EXCLUDED."updatedAt"`;
  }
  const edges = [...stats.edges.values()];
  for (let i = 0; i < edges.length; i += 500) {
    const part = edges.slice(i, i + 500);
    await db.$executeRaw`
      INSERT INTO "trader"."KnowledgeEdge"
        ("id", "sourceKey", "targetKey", "kind", "description", "weight", "meta", "lastSeenAt", "updatedAt")
      VALUES ${Prisma.join(
        part.map(
          (e) =>
            Prisma.sql`(${rawId()}, ${e.sourceKey}, ${e.targetKey}, 'cooccur', NULL, ${e.weight}, NULL, ${e.last}, ${now})`
        )
      )}
      ON CONFLICT ("sourceKey", "targetKey", "kind") DO UPDATE SET
        "weight" = EXCLUDED."weight",
        "lastSeenAt" = EXCLUDED."lastSeenAt",
        "updatedAt" = EXCLUDED."updatedAt"`;
  }
  const marketRelationEdges = await importMarketRelations();
  return {
    chunksScanned: rows.length,
    entities: entities.length,
    cooccurEdges: edges.length,
    marketRelationEdges,
  };
}

let indexMutex: Promise<unknown> | null = null;

/**
 * Index corpus L2: nạp corpus → lọc doc CHƯA có (hoặc vector null + attempts
 * <3) → embed theo batch 16 (fail từng batch → BM25-only) → ghi chunk →
 * tích luỹ thực thể/cạnh → flush + nhập MarketRelation. Idempotent theo
 * (refTable, refId). Mutex in-process chống 2 đợt đè nhau.
 */
export async function indexCorpus(
  opts: { rebuild?: boolean; maxDocs?: number; budgetMs?: number } = {}
): Promise<L2IndexSummary> {
  const run = (async (): Promise<L2IndexSummary> => {
    const t0 = Date.now();
    const budgetMs = opts.budgetMs ?? 600_000;
    const maxDocs = opts.maxDocs ?? 5_000;
    if (opts.rebuild) {
      await db.knowledgeEdge.deleteMany();
      await db.knowledgeEntity.deleteMany();
      await db.knowledgeChunk.deleteMany();
      resetL2Cache();
    }
    const dict = await buildEntityDict();
    // Chỉ chọn dim (không kéo embedding 8KB/doc — 13MB mỗi đợt): dim ≠ null
    // ⇔ embedding ≠ null vì 2 cột luôn ghi cùng nhau (indexCorpus).
    const [corpus, existing] = await Promise.all([
      loadCorpusDocs(),
      db.knowledgeChunk.findMany({
        select: { refTable: true, refId: true, dim: true, embedAttempts: true },
      }),
    ]);
    const existingMap = new Map(existing.map((c) => [`${c.refTable}:${c.refId}`, c]));
    const pending = corpus.filter((d) => {
      const row = existingMap.get(`${d.refTable}:${d.refId}`);
      if (!row) return true;
      return row.dim == null && row.embedAttempts < MAX_EMBED_ATTEMPTS;
    });
    const targets = pending.slice(0, maxDocs);

    const summary: L2IndexSummary = {
      corpusDocs: corpus.length,
      indexed: 0,
      embedded: 0,
      embedFailed: 0,
      tokens: 0,
      nimMs: 0,
      totalMs: 0,
      entitiesTouched: 0,
      edgesCooccur: 0,
      edgesMarketRelation: 0,
    };

    // Embed theo batch — fail TỪNG batch (đó là tính năng fail-soft §4).
    const vectors: (Uint8Array<ArrayBuffer> | null)[] = new Array(targets.length).fill(null);
    const BATCH = 16;
    for (let i = 0; i < targets.length; i += BATCH) {
      if (Date.now() - t0 > budgetMs) break;
      const batch = targets.slice(i, i + BATCH);
      try {
        const r = await embedTexts(
          batch.map((d) => d.content),
          "passage"
        );
        summary.tokens += r.totalTokens ?? 0;
        summary.nimMs += r.ms;
        for (let j = 0; j < batch.length; j++) {
          vectors[i + j] = vectorToBytes(r.vectors[j]);
        }
      } catch (e) {
        summary.embedFailed += batch.length;
        summary.embedError = String(e).slice(0, 160);
      }
    }

    const stats: GraphStats = { entities: new Map(), edges: new Map() };
    const rows: {
      refTable: string;
      refId: string;
      label: string;
      content: string;
      embedding: Uint8Array<ArrayBuffer> | null;
      embedModel: string | null;
      dim: number | null;
      embedAttempts: number;
      entityKeys: string[];
      datedAt: Date;
    }[] = [];
    for (let i = 0; i < targets.length; i++) {
      const d = targets[i];
      const keys = linkEntities(tokenize(d.content), dict);
      await seedEntities(stats, keys, dict);
      accumulateGraph(d, keys, stats);
      rows.push({
        refTable: d.refTable,
        refId: d.refId,
        label: d.label,
        content: d.content,
        embedding: vectors[i],
        embedModel: vectors[i] ? NIM_EMBED_MODEL : null,
        dim: vectors[i] ? NIM_EMBED_DIM : null,
        embedAttempts: 1,
        entityKeys: keys,
        datedAt: d.datedAt,
      });
    }

    // Ghi chunk: createMany cho đợt bootstrap (bảng rỗng) → upsert an toàn
    // khi đụng hàng đã có do đợt chạy song song khác (rẻ hơn nhiều vòng upsert).
    for (let i = 0; i < rows.length; i += 200) {
      const part = rows.slice(i, i + 200);
      await db.knowledgeChunk.createMany({ data: part }).catch(async () => {
        for (const r of part) {
          await db.knowledgeChunk.upsert({
            where: { refTable_refId: { refTable: r.refTable, refId: r.refId } },
            create: r,
            update: {
              label: r.label,
              content: r.content,
              embedding: r.embedding,
              embedModel: r.embedModel,
              dim: r.dim,
              embedAttempts: r.embedAttempts,
              entityKeys: r.entityKeys,
              datedAt: r.datedAt,
            },
          });
        }
      });
    }
    summary.indexed = rows.length;
    summary.embedded = rows.filter((r) => r.embedding != null).length;

    if (rows.length > 0) await flushGraphStats(stats);
    summary.edgesMarketRelation = await importMarketRelations();
    summary.entitiesTouched = stats.entities.size;
    summary.edgesCooccur = stats.edges.size;
    summary.totalMs = Date.now() - t0;

    // Cập nhật cache in-process (không cần reload toàn kho).
    if (rows.length > 0) {
      await appendToCache(rows).catch(() => {
        resetL2Cache();
      });
    }
    return summary;
  })();
  indexMutex = run;
  try {
    return await run;
  } finally {
    indexMutex = null;
  }
}

/** Đang có đợt index chạy? (route trả 409 thay vì xếp hàng — mẫu A8 #138). */
export function isIndexing(): boolean {
  return indexMutex != null;
}

/* ─────────────── 4. Cache index in-memory (tăng dần) ─────────────── */

let l2Cache: L2Index | null = null;

export function resetL2Cache(): void {
  l2Cache = null;
}

function refKey(refTable: string, refId: string): string {
  return `${refTable}:${refId}`;
}

function docFromRow(row: {
  refTable: string;
  refId: string;
  label: string;
  content: string;
  embedding: Uint8Array | null;
  entityKeys: unknown;
  datedAt: Date;
}): L2Doc {
  const tokens = tokenize(row.content);
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  const entityKeys = Array.isArray(row.entityKeys) ? (row.entityKeys as string[]) : [];
  return {
    refTable: row.refTable as L2RefTable,
    refId: row.refId,
    label: row.label,
    snippet: clip(row.content, SNIPPET_CHAR_CAP),
    datedAt: row.datedAt,
    tokens,
    tf,
    entityKeys,
    vector: row.embedding ? bytesToVector(row.embedding) : null,
  };
}

function mergeDocIntoIndex(index: L2IndexInternal, doc: L2Doc): void {
  const key = refKey(doc.refTable, doc.refId);
  const old = index.byRef.get(key);
  if (old) {
    // cập nhật: trừ thống kê cũ, thay bằng mới
    for (const t of old.tf.keys()) {
      const df = index.df.get(t) ?? 0;
      if (df <= 1) index.df.delete(t);
      else index.df.set(t, df - 1);
    }
    index.docs = index.docs.filter((d) => d !== old);
    index.totalLen -= old.tokens.length;
  }
  index.docs.push(doc);
  index.byRef.set(key, doc);
  index.totalLen += doc.tokens.length;
  for (const t of doc.tf.keys()) index.df.set(t, (index.df.get(t) ?? 0) + 1);
}

// Mở rộng L2Index với trường nội bộ (giữ interface công khai gọn).
interface L2IndexInternal extends L2Index {
  totalLen: number;
}

async function loadGraphInto(index: L2IndexInternal): Promise<void> {
  const [entities, edges] = await Promise.all([
    db.knowledgeEntity.findMany({ select: { key: true, name: true, type: true } }),
    db.knowledgeEdge.findMany({
      select: { sourceKey: true, targetKey: true, kind: true, weight: true, meta: true },
    }),
  ]);
  index.entities = new Map(entities.map((e) => [e.key, { key: e.key, name: e.name, type: e.type }]));
  index.edges = edges.map((e) => ({
    sourceKey: e.sourceKey,
    targetKey: e.targetKey,
    kind: e.kind as "cooccur" | "market-relation",
    weight: e.weight,
    meta: (e.meta as Record<string, unknown> | null) ?? null,
  }));
  const byNode = new Map<string, L2GraphEdge[]>();
  for (const e of index.edges) {
    for (const k of [e.sourceKey, e.targetKey]) {
      const list = byNode.get(k) ?? [];
      list.push(e);
      byNode.set(k, list);
    }
  }
  index.edgeByNode = byNode;
}

/**
 * Đảm bảo cache sống: lần đầu nạp toàn bộ; những lần sau chỉ nạp chunk MỚI/
 * ĐỔI (updatedAt > loadedSince) + đồ thị nhỏ (2 bảng vài trăm hàng) — giữa
 * 2 chu kỳ không thay đổi gì thì chỉ tốn 3 truy vấn nhẹ (re-check ≥60s).
 */
export async function ensureL2Index(): Promise<L2Index> {
  const now = Date.now();
  if (!l2Cache) {
    const rows = await db.knowledgeChunk.findMany({
      orderBy: { updatedAt: "asc" },
      select: {
        refTable: true,
        refId: true,
        label: true,
        content: true,
        embedding: true,
        entityKeys: true,
        datedAt: true,
        updatedAt: true,
      },
    });
    const index: L2IndexInternal = {
      docs: [],
      byRef: new Map(),
      df: new Map(),
      avgdl: 0,
      entities: new Map(),
      edges: [],
      edgeByNode: new Map(),
      loadedAt: now,
      loadedSince: rows.length ? rows[rows.length - 1].updatedAt : new Date(0),
      lastCheckAt: now,
      totalLen: 0,
    };
    for (const r of rows) mergeDocIntoIndex(index, docFromRow(r));
    index.avgdl = index.docs.length ? index.totalLen / index.docs.length : 0;
    await loadGraphInto(index);
    l2Cache = index;
    return index;
  }
  if (now - l2Cache.lastCheckAt < 60_000) return l2Cache;
  l2Cache.lastCheckAt = now;
  const fresh = await db.knowledgeChunk.findMany({
    where: { updatedAt: { gt: l2Cache.loadedSince } },
    orderBy: { updatedAt: "asc" },
    select: {
      refTable: true,
      refId: true,
      label: true,
      content: true,
      embedding: true,
      entityKeys: true,
      datedAt: true,
      updatedAt: true,
    },
  });
  const internal = l2Cache as L2IndexInternal;
  for (const r of fresh) mergeDocIntoIndex(internal, docFromRow(r));
  if (fresh.length) {
    internal.loadedSince = fresh[fresh.length - 1].updatedAt;
    internal.avgdl = internal.docs.length ? internal.totalLen / internal.docs.length : 0;
  }
  await loadGraphInto(internal).catch(() => {
    /* giữ đồ thị cũ */
  });
  return l2Cache;
}

async function appendToCache(
  rows: {
    refTable: string;
    refId: string;
    label: string;
    content: string;
    embedding: Uint8Array<ArrayBuffer> | null;
    entityKeys: string[];
    datedAt: Date;
  }[]
): Promise<void> {
  const index = await ensureL2Index();
  const internal = index as L2IndexInternal;
  for (const r of rows) {
    mergeDocIntoIndex(
      internal,
      docFromRow({
        refTable: r.refTable,
        refId: r.refId,
        label: r.label,
        content: r.content,
        embedding: r.embedding,
        entityKeys: r.entityKeys,
        datedAt: r.datedAt,
      })
    );
  }
  internal.avgdl = internal.docs.length ? internal.totalLen / internal.docs.length : 0;
  await loadGraphInto(internal).catch(() => {
    /* giữ đồ thị cũ */
  });
  internal.loadedSince = new Date();
}

/* ─────────────── 5. Xếp hạng hybrid (§6.4) ─────────────── */

function recency30(datedAt: Date, now = Date.now()): number {
  const ageH = Math.max(0, (now - datedAt.getTime()) / 3_600_000);
  return Math.exp(-ageH / RECENCY_HALF_LIFE_H);
}

/** W2 (#163): hệ số giáng cấp echo theo tuổi — 1 cho bảng kiểm chứng/ngoài;
 * bảng tự tham chiếu giảm nửa đời 45 ngày, sàn 0,25. Tuổi không hợp lệ →
 * sàn (fail-safe "không bịa chất lượng": doc không xác định được tuổi coi
 * như cũ, không cho nó đứng đầu bằng cách nào). */
function echoDecay(refTable: L2RefTable, datedAt: Date, now = Date.now()): number {
  if (!ECHO_TABLES.has(refTable)) return 1;
  const t = datedAt.getTime();
  if (!Number.isFinite(t)) return ECHO_FLOOR;
  const ageDays = Math.max(0, (now - t) / 86_400_000);
  return Math.max(ECHO_FLOOR, Math.pow(0.5, ageDays / ECHO_HALF_LIFE_DAYS));
}

export function rankL2(
  index: L2Index,
  queryTokens: string[],
  queryVector: Float32Array | null
): L2Hit[] {
  if (index.docs.length === 0 || queryTokens.length === 0) return [];
  const compat = {
    docs: index.docs as unknown as RagDoc[],
    df: index.df,
    avgdl: index.avgdl,
    builtAt: 0,
    messageCount: 0,
    newsCount: 0,
  } as unknown as RagIndex;
  const now = Date.now();
  interface Scored {
    doc: L2Doc;
    bm25: number;
    cos: number | null;
    rec: number;
  }
  const scored: Scored[] = [];
  let maxBm25 = 0;
  for (const doc of index.docs) {
    const bm25 = bm25Score(compat, doc as unknown as RagDoc, queryTokens);
    if (bm25 <= 0 && !queryVector) continue; // không có đường nào chạm doc
    const cos = queryVector && doc.vector ? cosineF32(queryVector, doc.vector) : null;
    if (bm25 <= 0 && (cos == null || cos < COS_FLOOR)) continue;
    if (bm25 > maxBm25) maxBm25 = bm25;
    scored.push({ doc, bm25, cos, rec: recency30(doc.datedAt, now) });
  }
  const hits: L2Hit[] = scored.map(({ doc, bm25, cos, rec }) => {
    const bm25N = maxBm25 > 0 ? bm25 / maxBm25 : 0;
    const cosN = cos != null ? Math.max(0, cos) : 0;
    // W2 (#163): nhân hệ số giáng cấp echo SAU cộng hybrid — mọi thành phần
    // (BM25/vector/recency) cùng bị kéo xuống theo tuổi của bảng tự tham
    // chiếu, giữ nguyên thứ tương đối giữa các doc cùng bảng.
    const echoMul = echoDecay(doc.refTable, doc.datedAt, now);
    const score =
      (W_BM25 * bm25N +
        W_VECTOR * (cos != null ? cosN : bm25N) + // không có vector → dồn sang BM25
        W_RECENCY * rec) *
      echoMul;
    return {
      refTable: doc.refTable,
      refId: doc.refId,
      label: doc.label,
      snippet: doc.snippet,
      datedAt: doc.datedAt,
      score,
      bm25,
      cosine: cos,
      recency: rec,
      echoMul,
    };
  });
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, L2_TOP_K);
}

/* ─────────────── 6. Khối đồ thị cho query ─────────────── */

function fmtEdge(index: L2Index, edge: L2GraphEdge): string | null {
  const src = index.entities.get(edge.sourceKey);
  const dst = index.entities.get(edge.targetKey);
  if (!src || !dst) return null;
  if (edge.kind === "market-relation") {
    const m = edge.meta ?? {};
    const parts: string[] = [];
    if (typeof m.corr === "number") parts.push(`corr ${m.corr.toFixed(2)}`);
    if (typeof m.condDown === "number")
      parts.push(`P(đích↓|nguồn rơi)=${m.condDown.toFixed(2)}`);
    if (typeof m.condUp === "number") parts.push(`P(đích↑|nguồn bật)=${m.condUp.toFixed(2)}`);
    if (typeof m.obs === "number") parts.push(`n=${m.obs}`);
    if (typeof m.lag === "number") parts.push(`lag ${m.lag}`);
    const win =
      typeof m.windowFrom === "string" && typeof m.windowTo === "string"
        ? ` · cửa sổ ${m.windowFrom.slice(0, 10)}→${m.windowTo.slice(0, 10)}`
        : "";
    return `- Đồ thị đo được: ${src.name} —(${parts.join(" · ")})→ ${dst.name}${win}`;
  }
  return `- Đồ thị đồng xuất hiện: ${src.name} ↔ ${dst.name} (${Math.round(edge.weight)} văn bản L2)`;
}

function graphLinesForQuery(index: L2Index, queryEntityKeys: string[]): string[] {
  if (queryEntityKeys.length === 0 || index.edges.length === 0) return [];
  const lines: string[] = [];
  const seen = new Set<string>();
  // market-relation ưu tiên trước (cạnh định lượng THẬT — §6.2)
  const kinds: ("market-relation" | "cooccur")[] = ["market-relation", "cooccur"];
  for (const kind of kinds) {
    for (const key of queryEntityKeys) {
      if (lines.length >= GRAPH_LINES_CAP) break;
      const nodeEdges = (index.edgeByNode.get(key) ?? [])
        .filter((e) => e.kind === kind)
        .sort((a, b) => b.weight - a.weight);
      for (const e of nodeEdges) {
        const dedupe = `${e.sourceKey}|${e.targetKey}|${e.kind}`;
        if (seen.has(dedupe)) continue;
        const line = fmtEdge(index, e);
        if (!line) continue;
        seen.add(dedupe);
        lines.push(line);
        if (lines.length >= GRAPH_LINES_CAP) break;
      }
    }
  }
  return lines;
}

/* ─────────────── 7. Khối prompt ─────────────── */

function daysAgoLabel(d: Date, now = Date.now()): string {
  const days = Math.max(0, Math.round((now - d.getTime()) / 86_400_000));
  if (days <= 0) return "hôm nay";
  if (days < 7) return `${days} ngày trước`;
  if (days < 30) return `${Math.round(days / 7)} tuần trước`;
  return `${Math.round(days / 30)} tháng trước`;
}

export function formatL2Block(
  hits: L2Hit[],
  graphLines: string[],
  vectorUsed: boolean
): string | null {
  if (hits.length === 0 && graphLines.length === 0) return null;
  const lines: string[] = [];
  for (const h of hits) {
    lines.push(`- [${daysAgoLabel(h.datedAt)} · ${h.label}] ${h.snippet}`);
  }
  lines.push(...graphLines);
  const header =
    `TRI THỨC DÀI HẠN (L2 — corpus nghiên cứu/vĩ mô/bài học nhiều tuần, xếp hạng hybrid BM25${
      vectorUsed ? " + vector ngữ nghĩa" : ""
    } + đồ thị thực thể):\n` +
    lines.join("\n") +
    `\nGhi chú vô hại hoá: dữ liệu trên là NGỮ CẢNH QUÁ KHỨC (tuần/tháng trước) dùng để ĐỐI CHIẾU phương pháp luận — KHÔNG phải tin mới; bằng chứng định lượng của chu kỳ hiện tại vẫn là các khối dữ liệu ở trên.`;
  if (header.length <= L2_BLOCK_CHAR_CAP) return header;
  const kept: string[] = [];
  let budget = L2_BLOCK_CHAR_CAP - 400; // chừa chỗ ghi chú
  for (const l of lines) {
    if (budget - l.length < 0 || kept.length >= 12) break;
    kept.push(l);
    budget -= l.length + 1;
  }
  return (
    `TRI THỨC DÀI HẠN (L2 — corpus nghiên cứu/vĩ mô/bài học nhiều tuần, xếp hạng hybrid BM25${
      vectorUsed ? " + vector ngữ nghĩa" : ""
    } + đồ thị thực thể):\n` +
    kept.join("\n") +
    `\nGhi chú vô hại hoá: dữ liệu trên là NGỮ CẢNH QUÁ KHỨC (tuần/tháng trước) dùng để ĐỐI CHIẾU phương pháp luận — KHÔNG phải tin mới; bằng chứng định lượng của chu kỳ hiện tại vẫn là các khối dữ liệu ở trên.`
  );
}

/* ─────────────── 8. Tự chữa + truy hồi chu kỳ ─────────────── */

/** Số doc corpus đang chờ index (mới hoặc vector thiếu + chưa hết lượt thử). */
export async function countPendingL2(): Promise<number> {
  try {
    const [corpus, existing] = await Promise.all([
      loadCorpusDocs(),
      // dim thay embedding — không kéo 8KB/doc (ghi chú ở indexCorpus).
      db.knowledgeChunk.findMany({
        select: { refTable: true, refId: true, dim: true, embedAttempts: true },
      }),
    ]);
    const existingMap = new Map(existing.map((c) => [`${c.refTable}:${c.refId}`, c]));
    return corpus.filter((d) => {
      const row = existingMap.get(`${d.refTable}:${d.refId}`);
      if (!row) return true;
      return row.dim == null && row.embedAttempts < MAX_EMBED_ATTEMPTS;
    }).length;
  } catch {
    return 0;
  }
}

/** Tự chữa: index tối đa SELF_HEAL_MAX_DOCS doc mới trong budget chặt. */
async function selfHeal(): Promise<number> {
  try {
    const pending = await countPendingL2();
    if (pending === 0) return 0;
    const summary = await indexCorpus({
      maxDocs: SELF_HEAL_MAX_DOCS,
      budgetMs: SELF_HEAL_BUDGET_MS,
    });
    return summary.indexed;
  } catch {
    return 0;
  }
}

/** Cache vector query theo token (6 agent 1 chu kỳ dùng cùng query). */
let queryVecCache: { key: string; vec: Float32Array; at: number } | null = null;

async function queryVector(tokens: string[]): Promise<Float32Array | null> {
  const key = tokens.join("|");
  if (queryVecCache && queryVecCache.key === key && Date.now() - queryVecCache.at < QUERY_VEC_TTL_MS) {
    return queryVecCache.vec;
  }
  try {
    const r = await embedTexts([tokens.join(" ")], "query");
    const vec = new Float32Array(r.vectors[0]);
    queryVecCache = { key, vec, at: Date.now() };
    return vec;
  } catch {
    return null; // fail-soft → BM25 thuần (§4)
  }
}

/**
 * Truy hồi L2 cho 1 chu kỳ: tự chữa → load index → query (đồng nghĩa mở rộng
 * như L1) → hybrid rank → khối prompt + đồ thị → RetrievalLog layer "L2".
 * KHÔNG bao giờ ném (caller giữ chu kỳ chạy như trước L2 khi mọi thứ lỗi).
 */
export async function retrieveForCycleL2(usedInPrompt: boolean): Promise<L2Retrieval | null> {
  try {
    await selfHeal();
    const index = await ensureL2Index();
    if (index.docs.length === 0) return null;
    const queryTokens = await buildCycleQueryTokensRaw();
    const queryTokensExpanded = expandQueryTokens([...queryTokens]);
    const qvec = await queryVector(queryTokensExpanded);
    const hits = rankL2(index, queryTokensExpanded, qvec);
    const dict = await buildEntityDict();
    const queryEntityKeys = linkEntities(queryTokensExpanded, dict);
    const graphLines = graphLinesForQuery(index, queryEntityKeys);
    const block = formatL2Block(hits, graphLines, qvec != null);
    let logId: string | null = null;
    try {
      const row = await db.retrievalLog.create({
        data: {
          query: queryTokensExpanded,
          topK: L2_TOP_K,
          results: hits.map((h) => ({
            refTable: h.refTable,
            refId: h.refId,
            score: Number(h.score.toFixed(4)),
            cosine: h.cosine != null ? Number(h.cosine.toFixed(4)) : null,
            // W2 (#163) — hệ số giáng cấp echo (additive trong JSON: log cũ
            // không có, script đọc phải dùng null-check).
            echoMul: h.echoMul != null ? Number(h.echoMul.toFixed(3)) : null,
          })),
          usedInPrompt: usedInPrompt && block != null,
          layer: "L2",
        },
        select: { id: true },
      });
      logId = row.id;
    } catch {
      /* log fail → chu kỳ vẫn chạy */
    }
    return {
      block,
      hits,
      graphLines,
      vectorUsed: qvec != null,
      queryTokens,
      queryTokensExpanded,
      logId,
      corpusSize: index.docs.length,
    };
  } catch {
    return null;
  }
}

/* ─────────────── 9. Thống kê (status route + UI) ─────────────── */

export interface L2Stats {
  chunks: number;
  byRefTable: Record<string, number>;
  vectorCoverage: { withVector: number; bm25Only: number };
  entities: { total: number; byType: Record<string, number> };
  edges: { cooccur: number; marketRelation: number };
  retrievals30d: number;
  usedInPrompt30d: number;
  usageRate30d: number | null;
  lastRetrievalAt: string | null;
  pending: number;
  embedModel: string;
  dim: number;
  cache: { docs: number; vectors: number } | null;
}

let statsCache: { at: number; stats: L2Stats } | null = null;

export async function l2Stats(): Promise<L2Stats> {
  if (statsCache && Date.now() - statsCache.at < STATS_TTL_MS) return statsCache.stats;
  const [chunks, entityRows, edgeRows, rl, last, pending] = await Promise.all([
    db.knowledgeChunk.groupBy({ by: ["refTable"], _count: { _all: true } }),
    db.knowledgeEntity.groupBy({ by: ["type"], _count: { _all: true } }),
    db.knowledgeEdge.groupBy({ by: ["kind"], _count: { _all: true } }),
    db.retrievalLog.count({ where: { layer: "L2", createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } } }),
    db.retrievalLog.findFirst({ where: { layer: "L2" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    countPendingL2(),
  ]);
  const [withVector, total] = await Promise.all([
    db.knowledgeChunk.count({ where: { embedding: { not: null } } }),
    db.knowledgeChunk.count(),
  ]);
  const used = rl > 0
    ? await db.retrievalLog.count({
        where: { layer: "L2", usedInPrompt: true, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
      })
    : 0;
  const byRefTable: Record<string, number> = {};
  for (const g of chunks) byRefTable[g.refTable] = g._count._all;
  const byType: Record<string, number> = {};
  let entityTotal = 0;
  for (const g of entityRows) {
    byType[g.type] = g._count._all;
    entityTotal += g._count._all;
  }
  const edgeKinds: Record<string, number> = {};
  for (const g of edgeRows) edgeKinds[g.kind] = g._count._all;
  const stats: L2Stats = {
    chunks: total,
    byRefTable,
    vectorCoverage: { withVector, bm25Only: total - withVector },
    entities: { total: entityTotal, byType },
    edges: {
      cooccur: edgeKinds["cooccur"] ?? 0,
      marketRelation: edgeKinds["market-relation"] ?? 0,
    },
    retrievals30d: rl,
    usedInPrompt30d: used,
    usageRate30d: rl > 0 ? used / rl : null,
    lastRetrievalAt: last?.createdAt ? last.createdAt.toISOString() : null,
    pending,
    embedModel: NIM_EMBED_MODEL,
    dim: NIM_EMBED_DIM,
    cache: l2Cache
      ? {
          docs: l2Cache.docs.length,
          vectors: l2Cache.docs.filter((d) => d.vector != null).length,
        }
      : null,
  };
  statsCache = { at: Date.now(), stats };
  return stats;
}

export function resetL2StatsCache(): void {
  statsCache = null;
}
