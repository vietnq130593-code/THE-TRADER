/**
 * src/lib/ml/rag.ts — L1 BM25 RAG VIẾT TAY (ML_LEARNING_BLUEPRINT §2 L1, phiên #83).
 *
 * "Tích luỹ tri thức & truy hồi" — lớp yếu nhất đo được ở #49/#50 (A13 chỉ đếm
 * + truy xuất theo thời gian). Bản này lấp đúng khoảng trống đó:
 *   1. Tokenizer tiếng Việt: lowercase, bỏ dấu câu, tách khoảng trắng (KHÔNG
 *      stemming — tin tài chính VN ngắn, stemming dễ sai nghĩa).
 *   1b. F-12a (#129-A): từ điển đồng nghĩa vĩ mô MACRO_SYNONYMS — mở rộng
 *      query TRƯỚC khi chấm BM25 ("lạm phát" trúng doc chỉ chứa "CPI"):
 *      chi phí 0, không đổi index; bit-flip khi query không có từ khoá vĩ mô.
 *   2. Corpus: 500 AgentMessage broadcast gần nhất (memoryWindow A13) + 200
 *      NewsItem gần nhất — index in-process đếm df(t) khi build (≤700 docs,
 *      tính <50ms, không cần index DB).
 *   3. Xếp hạng hybrid (công thức blueprint, k₁=1,5 · b=0,75 chuẩn):
 *        score(d,q) = 0,7·BM25(d,q) + 0,3·recency(d)
 *        recency(d) = exp(−ageHours(d)/72)   — nửa đời 3 ngày
 *   4. Tiêm prompt 5 agent nghiên cứu + Chủ tịch: top-8 dòng rút gọn
 *      (≤1.200 token ≈ cap 3.200 ký tự), nhãn khối "TRI THỨC TRUY HỒI (RAG…)".
 *   5. RetrievalLog MỖI lần truy hồi (query, top-8 id, điểm, usedInPrompt) —
 *      đo được RAG có được nhìn thấy/không (cổng L3 §6: ≥30 ngày & ≥10% chu kỳ).
 *
 * Nguyên tắc (blueprint §1): viết tay TypeScript thuần — BM25 bằng Map, 0
 * dependency ngoài stack; KHÔNG dùng LlamaIndex. Vô hại hoá: nội dung cũ chỉ
 * là NGỮ CẢNH đối chiếu — không thay bằng chứng định lượng Bayes (chống đếm
 * kép T7.5). RAG fail-soft: mọi lỗi của module này KHÔNG bao giờ làm hỏng
 * chu kỳ agent (caller bọc try/catch, block=null → prompt y như trước L1).
 */

import { db } from "@/lib/db";
import { RAG_TUNING_DEFAULT, readMlTuning, type RagTuning } from "@/lib/ml/tuning";

// ─────────────────────────── Hằng số (blueprint §2 L1) ───────────────────────────

/** 500 tin broadcast gần nhất — khớp config A13 memoryWindow: 500. */
const CORPUS_MESSAGES = 500;
/** 200 tin tức gần nhất — cùng nhịp ingest RSS 15 phút.
 * #101: export cho /api/news/archive chỉ báo inRagCorpus (một nguồn sự thật). */
export const CORPUS_NEWS = 200;
/** Top-K mặc định — nguồn sự thật: RAG_TUNING_DEFAULT (ml/tuning.ts #89). */
export const RAG_TOP_K = RAG_TUNING_DEFAULT.topK;
/** BM25 k₁ · b mặc định (Robertsen) — tinh chỉnh được qua AppSetting ml-tuning (#89). */
const BM25_K1 = RAG_TUNING_DEFAULT.k1;
const BM25_B = RAG_TUNING_DEFAULT.b;
const W_RECENCY = RAG_TUNING_DEFAULT.wRecency;
/** Nửa đời recency 72h — tin càng cũ điểm càng thấp. */
const RECENCY_HALF_LIFE_H = 72;
/** Cap ký tự khối RAG ≈ 1.200 token (tiếng Việt ~2,5 ký tự/token — cap nghiêm
 *  3.000 ký tự để ước lượng token KHÔNG bao giờ vượt 1.200). */
export const RAG_BLOCK_CHAR_CAP = 3_000;
/** Cap ký tự mỗi dòng snippet (rút gọn "…"). */
const SNIPPET_CHAR_CAP = 340;
/** TTL cache corpus trong process (60s) — chu kỳ 240ph hiếm khi trùng, nhưng
 *  single-run + chat có thể gọi dồn; 700 docs đọc DB ~200-400ms WAN. */
const CORPUS_TTL_MS = 60_000;

// ─────────────────────────── Types ───────────────────────────

export interface RagDoc {
  refTable: "AgentMessage" | "NewsItem";
  refId: string;
  /** Tiêu đề hiển thị dòng (agent code hoặc nguồn tin). */
  label: string;
  /** Đoạn trích hiển thị (content / title — summary). */
  snippet: string;
  /** Mốc tính recency (createdAt message / publishedAt tin). */
  datedAt: Date;
  tokens: string[];
  tf: Map<string, number>;
}

export interface RagIndex {
  docs: RagDoc[];
  df: Map<string, number>;
  avgdl: number;
  builtAt: number;
  /** Số bản ghi nguồn thực tế đọc được (trung thực khi DB ít hơn cửa sổ). */
  messageCount: number;
  newsCount: number;
}

export interface RagHit {
  refTable: "AgentMessage" | "NewsItem";
  refId: string;
  label: string;
  snippet: string;
  datedAt: Date;
  score: number;
  bm25: number;
  recency: number;
}

// ─────────────────────────── 1. Tokenizer tiếng Việt ───────────────────────────

/**
 * Lowercase → bỏ dấu câu (giữ chữ/số — mã cổ phiếu "VCB" → "vcb") → tách
 * khoảng trắng. Không stemming (§2 L1.1). Export cho test/prompt query.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2); // bỏ token 1 ký tự (nhiễu "a", "v"...)
}

// ─────────────────────────── 1b. Từ điển đồng nghĩa vĩ mô — mở rộng query (F-12a #129-A) ───────────────────────────

/**
 * F-12a (#129-A — AI_ENGINEER_REVIEW_BRAIN §F-12, giai đoạn GĐ0): BM25
 * tokenizer tiếng Việt giữ dấu nên query "lạm phát" KHÔNG trúng doc chỉ chứa
 * "CPI". Lấp bằng MỞ RỘNG QUERY (query expansion) TRƯỚC khi chấm BM25 — chi
 * phí 0, không đổi index (token đồng nghĩa chỉ thêm PHÍA QUERY; corpus và
 * tf/df giữ nguyên như cũ).
 *
 * Nhóm 2 CHIỀU: mọi thành viên tra ra nhau ("lạm phát" ↔ "cpi" ↔ "inflation"
 * ↔ "chỉ số giá"). Mục 1 CHIỀU: chỉ map khi hướng ngữ nghĩa rõ (PMI cao ≈
 * sản xuất mở rộng, nhưng "sản xuất" chưa chắc nói PMI; GSO là nguồn thống
 * kê). Key là cụm TIỀN chuẩn hoá cùng tokenize() (lowercase, giữ dấu, mỗi
 * token ≥2 ký tự), dài 1..4 token — "lãi suất", "xuất nhập khẩu", "đầu tư
 * trực tiếp"; "lãi suất điều hành" khớp nhờ bigram "lãi suất" nằm bên trong.
 */
const MACRO_SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ["lạm phát", "cpi", "inflation", "chỉ số giá"],
  ["lãi suất", "rate", "sbv"],
  ["tín dụng", "credit"],
  ["tăng trưởng", "gdp"],
  ["tỷ giá", "fx", "usd", "vnd"],
  ["trái phiếu", "bond", "tpcp"],
  ["thanh khoản", "liquidity"],
  ["dự trữ", "reserve"],
  ["thất nghiệp", "việc làm", "unemployment"],
  ["xnk", "xuất nhập khẩu", "trade"],
  ["fdi", "đầu tư trực tiếp"],
];

// Task 142 (F-24 §6.2): xuất nhóm đồng nghĩa gốc cho L2 — mỗi nhóm là 1 THỰC
// THỂ vĩ mô của đồ thị tri thức (key = macro:<member[0]>, mọi thành viên trỏ
// về cùng key) — additive, không đổi hành vi L1.
export const MACRO_SYNONYM_GROUPS_EXPORT = MACRO_SYNONYM_GROUPS;

/** Mục 1 chiều — chỉ from → to, không đảo ngược (chống nhiễu ngược). */
const MACRO_SYNONYM_ONE_WAY: readonly { from: string; to: readonly string[] }[] = [
  { from: "pmi", to: ["sản xuất"] },
  { from: "gso", to: ["thống kê"] },
  { from: "m2", to: ["tiền tệ"] },
];

/** Gộp nhóm 2 chiều + mục 1 chiều thành 1 map phẳng — tra O(1) khi mở rộng. */
function buildMacroSynonyms(): ReadonlyMap<string, readonly string[]> {
  const map = new Map<string, string[]>();
  const add = (key: string, values: readonly string[]) => {
    const list = map.get(key) ?? [];
    for (const v of values) if (!list.includes(v)) list.push(v);
    map.set(key, list);
  };
  for (const group of MACRO_SYNONYM_GROUPS) {
    for (const member of group) {
      add(member, group.filter((m) => m !== member));
    }
  }
  for (const oneWay of MACRO_SYNONYM_ONE_WAY) add(oneWay.from, oneWay.to);
  return map;
}

/**
 * Từ điển đồng nghĩa vĩ mô 2 chiều (F-12a #129-A) — export cho test/tái sử
 * dụng. Key: cụm chuẩn hoá ("lạm phát", "tỷ giá", "xuất nhập khẩu"…). Value:
 * danh sách cụm đồng nghĩa (chưa tách token — nơi dùng sẽ tokenize cùng chuẩn).
 */
export const MACRO_SYNONYMS: ReadonlyMap<string, readonly string[]> =
  buildMacroSynonyms();

/** Cụm dài nhất trong từ điển (hiện "đầu tư trực tiếp" = 4 token) — trần cửa sổ n-gram khi tra cụm. */
const MACRO_MAX_PHRASE_TOKENS = [...MACRO_SYNONYMS.keys()].reduce(
  (max, key) => Math.max(max, key.split(" ").length),
  1
);

/**
 * Mở rộng token truy vấn bằng đồng nghĩa vĩ mô (F-12a #129-A). Input = output
 * của tokenize() (đã lowercase, giữ dấu tiếng Việt):
 *   - Token đơn: tra trực tiếp ("cpi" → "lạm phát" + "inflation" + "chỉ số giá").
 *   - CỤM liền kề: tại mỗi vị trí quét n-gram dài→ngắn (2..MACRO_MAX_PHRASE_
 *     TOKENS token) — "lãi suất điều hành" chứa bigram "lãi suất" → "rate" +
 *     "sbv"; "xuất nhập khẩu" (3 từ) → "xnk" + "trade"; "đầu tư trực tiếp"
 *     (4 từ) → "fdi".
 *   - Token mở rộng LUÔN qua tokenize() cùng chuẩn (bỏ dấu câu, lọc 1 ký tự),
 *     dedupe bằng Set, append CUỐI mảng — thứ tự token gốc không đổi.
 * Bit-flip: query không chứa từ khoá vĩ mô nào → trả NGUYÊN mảng đầu vào
 * (hành vi trước F-12a giữ tuyệt đối — caller không thấy khác biệt).
 */
export function expandQueryTokens(tokens: string[]): string[] {
  if (tokens.length === 0) return tokens;
  const found: string[] = []; // cụm đồng nghĩa bắt được (chưa tokenize)
  const collect = (phrase: string) => {
    const synonyms = MACRO_SYNONYMS.get(phrase);
    if (synonyms) found.push(...synonyms);
  };
  for (let i = 0; i < tokens.length; i++) {
    // Cụm dài ưu tiên trước — "xuất nhập khẩu" thắng bigram rơi rác bên trong.
    for (let n = MACRO_MAX_PHRASE_TOKENS; n >= 2; n--) {
      if (i + n <= tokens.length) collect(tokens.slice(i, i + n).join(" "));
    }
    // Token đơn tại cùng vị trí — từ điển hiện không có unigram nào nằm trong
    // cụm key nên không xung đột nhóm (Set chống trùng cho chắc nếu thêm sau này).
    collect(tokens[i]);
  }
  if (found.length === 0) return tokens; // bit-flip: không khớp từ điển → y nguyên
  const out = new Set<string>(tokens); // Set giữ thứ tự chèn → token gốc đứng trước
  for (const phrase of found) {
    for (const t of tokenize(phrase)) out.add(t);
  }
  return [...out];
}

// ─────────────────────────── 2. Corpus (index in-process) ───────────────────────────

let corpusCache: RagIndex | null = null;

/** Xoá cache (test / force reload). */
export function resetRagCache(): void {
  corpusCache = null;
}

function buildDoc(
  refTable: "AgentMessage" | "NewsItem",
  refId: string,
  label: string,
  snippet: string,
  indexedText: string,
  datedAt: Date
): RagDoc {
  const tokens = tokenize(indexedText);
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return { refTable, refId, label, snippet, datedAt, tokens, tf };
}

/** Nạp + index corpus (cache TTL 60s). Fail-soft: lỗi DB → index rỗng. */
export async function loadRagCorpus(): Promise<RagIndex> {
  if (corpusCache && Date.now() - corpusCache.builtAt < CORPUS_TTL_MS) {
    return corpusCache;
  }
  const empty: RagIndex = {
    docs: [],
    df: new Map(),
    avgdl: 0,
    builtAt: Date.now(),
    messageCount: 0,
    newsCount: 0,
  };
  try {
    const [messages, news] = await Promise.all([
      db.agentMessage.findMany({
        where: { broadcast: true, direction: "AGENT" },
        orderBy: { createdAt: "desc" },
        take: CORPUS_MESSAGES,
        select: {
          id: true,
          content: true,
          reasoning: true,
          sentiment: true,
          createdAt: true,
          fromAgent: { select: { code: true } },
        },
      }),
      db.newsItem.findMany({
        orderBy: { publishedAt: "desc" },
        take: CORPUS_NEWS,
        select: {
          id: true,
          title: true,
          summary: true,
          source: true,
          publishedAt: true,
        },
      }),
    ]);

    const docs: RagDoc[] = [];
    for (const m of messages) {
      // Indexed: content + reasoning (bề mặt khớp rộng hơn — §0 "broadcast có
      // reasoning/sentiment"); sentiment word thêm 1 tokenWeight nhẹ tự nhiên.
      const indexed = [m.content, m.reasoning ?? "", m.sentiment ?? ""].join(" ");
      docs.push(
        buildDoc(
          "AgentMessage",
          m.id,
          m.fromAgent?.code ?? "agent",
          m.content,
          indexed,
          m.createdAt
        )
      );
    }
    for (const n of news) {
      docs.push(
        buildDoc(
          "NewsItem",
          n.id,
          `tin ${n.source}`,
          n.summary ? `${n.title} — ${n.summary}` : n.title,
          `${n.title} ${n.summary ?? ""}`,
          n.publishedAt
        )
      );
    }

    const df = new Map<string, number>();
    let totalLen = 0;
    for (const d of docs) {
      totalLen += d.tokens.length;
      for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    }
    const index: RagIndex = {
      docs,
      df,
      avgdl: docs.length ? totalLen / docs.length : 0,
      builtAt: Date.now(),
      messageCount: messages.length,
      newsCount: news.length,
    };
    corpusCache = index;
    return index;
  } catch {
    // Fail-soft (§ header): lỗi corpus → index rỗng, caller coi như không có
    // tri thức truy hồi — chu kỳ agent vẫn chạy y như trước L1.
    corpusCache = empty;
    return empty;
  }
}

// ─────────────────────────── 3. Xếp hạng hybrid BM25 + recency ───────────────────────────

/**
 * BM25 thuần của 1 doc (Float64-compatible, viết tay — §1.1):
 *   Σ_t IDF(t) · f(t,d)·(k₁+1) / (f(t,d) + k₁·(1 − b + b·|d|/avgdl))
 *   IDF(t) = ln(1 + (N − df(t) + 0,5)/(df(t) + 0,5))
 * #89: opts override k₁/b từ AppSetting ml-tuning (mặc định = hằng số module).
 */
export function bm25Score(
  index: RagIndex,
  doc: RagDoc,
  queryTokens: string[],
  opts: { k1?: number; b?: number } = {}
): number {
  const k1 = opts.k1 ?? BM25_K1;
  const b = opts.b ?? BM25_B;
  const N = index.docs.length;
  if (N === 0 || index.avgdl === 0) return 0;
  const dl = doc.tokens.length;
  const lenNorm = k1 * (1 - b + b * (dl / index.avgdl));
  let sum = 0;
  for (const t of queryTokens) {
    const f = doc.tf.get(t);
    if (!f) continue;
    const df = index.df.get(t) ?? 0;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    sum += idf * ((f * (k1 + 1)) / (f + lenNorm));
  }
  return sum;
}

/** recency = exp(−ageHours/72) — nửa đời 3 ngày. */
export function recencyScore(datedAt: Date, now = Date.now()): number {
  const ageH = Math.max(0, (now - datedAt.getTime()) / 3_600_000);
  return Math.exp(-ageH / RECENCY_HALF_LIFE_H);
}

/** Tuỳ chọn xếp hạng #89 — đọc từ AppSetting ml-tuning tại retrieveForCycle. */
export interface RagRankOptions {
  topK?: number;
  k1?: number;
  b?: number;
  wRecency?: number;
}

/** Xếp hạng hybrid: (1−w)·BM25 + w·recency — top-K điểm cao nhất.
 *  #89: mặc định từng tham số = hằng số module (hành vi trước #89 giữ nguyên). */
export function rankRag(
  index: RagIndex,
  queryTokens: string[],
  opts: RagRankOptions = {}
): RagHit[] {
  const topK = opts.topK ?? RAG_TOP_K;
  const wRecency = opts.wRecency ?? W_RECENCY;
  const wBm25 = 1 - wRecency;
  if (index.docs.length === 0 || queryTokens.length === 0) return [];
  const now = Date.now();
  const hits: RagHit[] = [];
  for (const doc of index.docs) {
    const bm25 = bm25Score(index, doc, queryTokens, { k1: opts.k1, b: opts.b });
    const rec = recencyScore(doc.datedAt, now);
    const score = wBm25 * bm25 + wRecency * rec;
    if (bm25 <= 0) continue; // không khớp token nào → không vào top (chống
    //   "top-8 toàn recency" khi query lạc đề — chỉ hiện cái LIÊN QUAN)
    hits.push({
      refTable: doc.refTable,
      refId: doc.refId,
      label: doc.label,
      snippet: doc.snippet,
      datedAt: doc.datedAt,
      score,
      bm25,
      recency: rec,
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, topK);
}

// ─────────────────────────── 4. Khối prompt (≤1.200 token) ───────────────────────────

/** Rút gọn snippet về SNIPPET_CHAR_CAP, cắt tại ranh giới từ sạch. */
function clip(text: string, cap: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= cap) return t;
  const cut = t.slice(0, cap);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > cap * 0.6 ? cut.slice(0, lastSpace) : cut) + "…";
}

/** "x ngày trước" cho nhãn thời gian dòng RAG. */
function daysAgoLabel(d: Date, now = Date.now()): string {
  const days = Math.max(0, Math.round((now - d.getTime()) / 86_400_000));
  if (days <= 0) return "hôm nay";
  return `${days} ngày trước`;
}

/**
 * Khối prompt top-K — nhãn "TRI THỨC TRUY HỒI (RAG …)" đúng blueprint §2 L1.4,
 * kèm vô hại hoá: "dữ liệu quá hạn dùng để đối chiếu, không phải tin mới".
 * Trả null khi không có hit (caller bỏ qua — prompt y như trước L1).
 */
export function formatRagBlock(hits: RagHit[], now = Date.now()): string | null {
  if (hits.length === 0) return null;
  const lines: string[] = [];
  for (const h of hits) {
    const line = `- [${daysAgoLabel(h.datedAt, now)} · ${h.label}] ${clip(h.snippet, SNIPPET_CHAR_CAP)}`;
    lines.push(line);
  }
  let block =
    "TRI THỨC TRUY HỒI (RAG — tin/tin nhắn cũ LIÊN QUAN, xếp hạng BM25 + thời gian):\n" +
    lines.join("\n") +
    "\nGhi chú vô hại hoá: dữ liệu trên là NGỮ CẢNH QUÁ KHỨC dùng để ĐỐI CHIẾU phương pháp luận — KHÔNG phải tin mới; bằng chứng định lượng của chu kỳ hiện tại vẫn là các khối dữ liệu ở trên.";
  if (block.length > RAG_BLOCK_CHAR_CAP) {
    // Cắt bớt dòng cuối cho vừa cap (hiếm khi xảy ra: 8 × 340 + nhãn ≈ 3.100)
    while (block.length > RAG_BLOCK_CHAR_CAP && lines.length > 1) {
      lines.pop();
      block =
        "TRI THỨC TRUY HỒI (RAG — tin/tin nhắn cũ LIÊN QUAN, xếp hạng BM25 + thời gian):\n" +
        lines.join("\n") +
        "\nGhi chú vô hại hoá: dữ liệu trên là NGỮ CẢNH QUÁ KHỨC dùng để ĐỐI CHIẾU phương pháp luận — KHÔNG phải tin mới; bằng chứng định lượng của chu kỳ hiện tại vẫn là các khối dữ liệu ở trên.";
    }
  }
  return block.length > RAG_BLOCK_CHAR_CAP ? block.slice(0, RAG_BLOCK_CHAR_CAP) : block;
}

// ─────────────────────────── 5. Query từ ngữ cảnh chu kỳ ───────────────────────────

/**
 * Query GỐC từ ngữ cảnh chu kỳ (CHƯA mở rộng đồng nghĩa) — phần dựng query
 * cũ của buildCycleQueryTokens (blueprint §2 L1.3), tách riêng từ F-12a
 * (#129-A) để retrieveForCycle giữ được cả query gốc lẫn bản đã mở rộng.
 * Task 142 (F-24 §6.4): xuất cho L2 — lớp dài hạn dựng query THEO CÙNG ngữ
 * cảnh chu kỳ (một nguồn sự thật token query cho cả 2 lớp) — additive.
 */
export async function buildCycleQueryTokensRaw(): Promise<string[]> {
  const tokens = new Set<string>();
  const addText = (s: string) => {
    for (const t of tokenize(s)) tokens.add(t);
  };
  try {
    const signals = await db.signal.findMany({
      where: { status: "ACTIVE" },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        direction: true,
        instrument: { select: { symbol: true } },
      },
    });
    for (const s of signals)
      addText(`${s.instrument.symbol} ${s.direction === "BUY" ? "mua" : "bán"}`);
  } catch {
    /* bỏ nguồn */
  }
  try {
    const movers = await db.quote.findMany({
      orderBy: { tradedAt: "desc" },
      take: 200,
      select: { instrument: { select: { symbol: true } }, changePct: true },
    });
    const top = movers
      .filter((q) => Math.abs(q.changePct ?? 0) > 0.5)
      .sort((a, b) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0))
      .slice(0, 5);
    for (const q of top) addText(q.instrument.symbol);
  } catch {
    /* bỏ nguồn */
  }
  // Từ khoá cố định theo blueprint (§2 L1.3) — tokenize giữ dấu tiếng Việt.
  for (const t of tokenize("signal veto rủi ro dự báo đồng thuận thị trường")) tokens.add(t);
  return [...tokens];
}

/**
 * Query = [symbol liên quan, từ khoá, "signal", "veto", "rủi ro"] sinh từ
 * ngữ cảnh chu kỳ hiện tại (blueprint §2 L1.3): mã trong tín hiệu MỞ + top
 * mover phiên (|changePct| lớn nhất). Fail-soft từng nguồn (lỗi → bỏ nguồn).
 * F-12a (#129-A): mở rộng đồng nghĩa vĩ mô TRƯỚC khi return — caller nào
 * dùng query này (test/tái sử dụng) cũng được hưởng expansion chi phí 0;
 * bit-flip: query không chứa từ khoá vĩ mô → mảng trả về y như trước F-12a.
 */
export async function buildCycleQueryTokens(): Promise<string[]> {
  return expandQueryTokens([...(await buildCycleQueryTokensRaw())]);
}

// ─────────────────────────── 6. Entry chính + RetrievalLog ───────────────────────────

export interface RagRetrieval {
  /** Khối prompt tiêm (null = không có gì liên quan / lỗi fail-soft). */
  block: string | null;
  hits: RagHit[];
  /** Query GỐC từ ngữ cảnh chu kỳ — chưa mở rộng đồng nghĩa (giữ nghĩa cũ). */
  queryTokens: string[];
  /** Query ĐÃ mở rộng đồng nghĩa vĩ mô — input thật của rankRag + RetrievalLog.query (F-12a #129-A, additive). */
  queryTokensExpanded: string[];
  /** Id dòng RetrievalLog vừa ghi (null khi DB lỗi — không chặn chu kỳ). */
  logId: string | null;
  corpusSize: number;
}

/**
 * Truy hồi 1 lần cho chu kỳ: load corpus → build query → rank → format →
 * ghi RetrievalLog (query, top-K id + điểm, usedInPrompt). Caller tiêm block
 * vào prompt 5 agent nghiên cứu + Chủ tịch; `usedInPrompt` = block đã vào ≥1
 * prompt (caller truyền true khi block !== null — route luôn append khi có).
 * F-12a (#129-A): query được MỞ RỘNG đồng nghĩa vĩ mô trước khi rank —
 * rankRag + RetrievalLog.query dùng bản mở rộng; payload giữ cả query gốc
 * (queryTokens) lẫn bản mở rộng (queryTokensExpanded).
 */
export async function retrieveForCycle(
  usedInPrompt: boolean
): Promise<RagRetrieval> {
  const index = await loadRagCorpus();
  // F-12a (#129-A): giữ query gốc cho payload; bản MỞ RỘNG đồng nghĩa vĩ mô
  // mới vào rankRag + RetrievalLog.query ("lạm phát" trúng doc chỉ có "CPI").
  const queryTokens = await buildCycleQueryTokensRaw();
  const queryTokensExpanded = expandQueryTokens([...queryTokens]);
  // #89 — tham số RAG từ AppSetting ml-tuning (fail-soft → mặc định module).
  const tuning = await readMlTuning();
  const ragTuning = tuning.rag as Partial<RagTuning> | undefined;
  const hits = rankRag(index, queryTokensExpanded, {
    topK: ragTuning?.topK,
    k1: ragTuning?.k1,
    b: ragTuning?.b,
    wRecency: ragTuning?.wRecency,
  });
  const block = formatRagBlock(hits);
  let logId: string | null = null;
  try {
    const row = await db.retrievalLog.create({
      data: {
        // #129-A: ghi mảng ĐÃ mở rộng — token gốc đứng đầu nên 1 trường Json
        // đọc được cả query gốc lẫn phần expansion.
        query: queryTokensExpanded,
        topK: ragTuning?.topK ?? RAG_TOP_K,
        results: hits.map((h) => ({
          refTable: h.refTable,
          refId: h.refId,
          score: Number(h.score.toFixed(4)),
        })),
        usedInPrompt: usedInPrompt && block !== null,
      },
      select: { id: true },
    });
    logId = row.id;
  } catch {
    // Log fail → chu kỳ vẫn chạy (fail-soft) — chỉ mất đo lường lần này.
  }
  return { block, hits, queryTokens, queryTokensExpanded, logId, corpusSize: index.docs.length };
}

// ─────────────────────────── 7. Thống kê cho A13 + ml/status ───────────────────────────

export interface RagStats {
  corpusMessages: number;
  corpusNews: number;
  retrievals30d: number;
  usedInPrompt30d: number;
  usageRate30d: number | null; // null khi chưa đủ mẫu (n=0)
  lastRetrievalAt: Date | null;
  lastQuery: string[] | null;
}

/** Thống kê corpus + 30 ngày RetrievalLog (cổng L3 đo trên đây). Fail-soft. */
export async function ragStats(): Promise<RagStats> {
  const index = await loadRagCorpus();
  try {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const [retrievals, last] = await Promise.all([
      db.retrievalLog.count({ where: { createdAt: { gte: since } } }),
      db.retrievalLog.findFirst({
        orderBy: { createdAt: "desc" },
        select: { createdAt: true, query: true, usedInPrompt: true },
      }),
    ]);
    let used = 0;
    if (retrievals > 0) {
      used = await db.retrievalLog.count({
        where: { createdAt: { gte: since }, usedInPrompt: true },
      });
    }
    return {
      corpusMessages: index.messageCount,
      corpusNews: index.newsCount,
      retrievals30d: retrievals,
      usedInPrompt30d: used,
      usageRate30d: retrievals > 0 ? used / retrievals : null,
      lastRetrievalAt: last?.createdAt ?? null,
      lastQuery: Array.isArray(last?.query) ? (last!.query as string[]) : null,
    };
  } catch {
    return {
      corpusMessages: index.messageCount,
      corpusNews: index.newsCount,
      retrievals30d: 0,
      usedInPrompt30d: 0,
      usageRate30d: null,
      lastRetrievalAt: null,
      lastQuery: null,
    };
  }
}
