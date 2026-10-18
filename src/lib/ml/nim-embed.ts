/**
 * src/lib/ml/nim-embed.ts — LÕI EMBED NVIDIA NIM (Task 141 đo thật · Task 142
 * đưa vào serving cho lớp L2 tri thức dài hạn — RAG_UPGRADE_ASSESSMENT §9/§6).
 *
 * Model: nvidia/nemotron-3-embed-1b — 2.048 dim, đo thật 18-10-2026 từ sandbox:
 *   · query 572ms / batch 3-doc 789ms · batch nhiều text/request hoạt động
 *   · tách nghĩa tiếng Việt tài chính: doc cùng nghĩa 0,548 vs doc ngoài đề
 *     0,059 (biên 9×) — đúng thứ BM25 lexical thiếu (điểm yếu §2-a)
 *   · input_type "query"|"passage" được server chấp nhận (HTTP 200)
 *
 * Nguyên tắc của dự án áp nguyên vẹn:
 *   1. BACKEND-ONLY — không bao giờ import từ client (key không lộ).
 *   2. Fail-soft — mọi lỗi NẺM ra để CALLER tự bắt và rơi về BM25 thuần;
 *      module này không tự nuốt lỗi (giữ hàng vi rõ ràng để đo).
 *   3. Key SHIM kiểu db.ts #110-g: dev server / engine có thể boot TRƯỚC khi
 *      .env.local tồn tại (Next chỉ nạp env lúc khởi động) — khi process env
 *      thiếu, đọc thẳng .env.local trên đĩa. .env.local được git-ignore
 *      (Task 141: .env CHÍNH đang track theo #113 — tuyệt đối không ghi key đó).
 *   4. 429 → chờ 3s retry đúng 1 lần; hết lượt NẺM để caller đánh dấu
 *      embedAttempts++ (KnowledgeChunk) và tự hồi ở chu kỳ sau (§3 tự chữa).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/* ─────────────── Hằng số (Task 141 — nguồn sự thật số đo) ─────────────── */

export const NIM_EMBED_MODEL = "nvidia/nemotron-3-embed-1b";
export const NIM_EMBED_DIM = 2048;
const NIM_BASE = "https://integrate.api.nvidia.com/v1";
/** Batch mỗi request — đo Task 141: batch 3 doc ổn định; 16 là mức an toàn
 *  cho ~19k ký tự/request, index 2.291 doc chỉ ~150 request. */
export const NIM_BATCH = 16;
/** Timeout mỗi request (đo TB 0,6-1s; để dư dư sala cho batch lớn + WAN). */
const NIM_TIMEOUT_MS = 20_000;
/** Khoảng nghỉ giữa các batch (chống rate-limit). */
const NIM_BATCH_GAP_MS = 250;
/** Chờ 3s rồi retry đúng 1 lần khi 429. */
const NIM_RETRY_429_MS = 3_000;

/* ─────────────── Key (shim .env.local kiểu db.ts #110-g) ─────────────── */

let cachedKey: string | null | undefined;

/** Đọc key NIM: process env → .env.local trên đĩa → null (không có lõi embed). */
export function nimApiKey(): string | null {
  if (cachedKey !== undefined) return cachedKey;
  const env = process.env.NVIDIA_NIM_API_KEY;
  if (env && env.trim()) {
    cachedKey = env.trim();
    return cachedKey;
  }
  try {
    const raw = readFileSync(join(process.cwd(), ".env.local"), "utf8");
    const m = raw.match(/^NVIDIA_NIM_API_KEY\s*=\s*"?([^"\r\n]+)"?/m);
    const fromFile = m?.[1]?.trim() ?? "";
    cachedKey = fromFile || null;
  } catch {
    cachedKey = null;
  }
  return cachedKey;
}

/** Cho test/quản trị: xoá cache key (đổi key trong .env.local không cần restart). */
export function resetNimKeyCache(): void {
  cachedKey = undefined;
}

/* ─────────────── Client ─────────────── */

export interface NimEmbedResult {
  model: string;
  dim: number;
  /** vectors[i] tương ứng texts[i] — cùng thứ tự. */
  vectors: number[][];
  promptTokens: number | null;
  totalTokens: number | null;
  ms: number;
  requests: number;
}

async function postEmbeddings(
  key: string,
  model: string,
  texts: string[],
  inputType: "query" | "passage"
): Promise<{ vectors: number[][]; promptTokens: number | null; totalTokens: number | null }> {
  const body = (withType: boolean) =>
    JSON.stringify({
      model,
      input: texts,
      ...(withType ? { input_type: inputType } : {}),
      encoding_format: "float",
    });

  const call = () =>
    fetch(`${NIM_BASE}/embeddings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: body(true),
      signal: AbortSignal.timeout(NIM_TIMEOUT_MS),
    });

  let res = await call();
  // Server không nhận field lạ → thử lại không kèm input_type (mẫu p141).
  if (res.status === 400 || res.status === 422) {
    res = await fetch(`${NIM_BASE}/embeddings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: body(false),
      signal: AbortSignal.timeout(NIM_TIMEOUT_MS),
    });
  }
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, NIM_RETRY_429_MS));
    res = await call();
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    throw new Error(`NIM ${res.status}: ${raw.slice(0, 160)}`);
  }
  const j = (await res.json()) as {
    data?: { embedding?: number[] }[];
    usage?: { prompt_tokens?: number; total_tokens?: number };
  };
  const vectors = (j.data ?? []).map((d) => d.embedding ?? []);
  if (!vectors.length || !vectors[0]?.length) throw new Error("NIM: phản hồi thiếu embedding");
  return {
    vectors,
    promptTokens: j.usage?.prompt_tokens ?? null,
    totalTokens: j.usage?.total_tokens ?? null,
  };
}

/**
 * Embed danh sách text (tự chia batch 16, nghỉ 250ms giữa batch). NẺM lỗi khi:
 * không có key / NIM từ chối sau retry / timeout. Caller chịu trách nhiệm
 * fail-soft (L2: rơi về BM25 thuần — nguyên tắc §6 Task 140).
 */
export async function embedTexts(
  texts: string[],
  inputType: "query" | "passage"
): Promise<NimEmbedResult> {
  if (texts.length === 0) {
    return { model: NIM_EMBED_MODEL, dim: 0, vectors: [], promptTokens: 0, totalTokens: 0, ms: 0, requests: 0 };
  }
  const key = nimApiKey();
  if (!key) throw new Error("NIM: thiếu NVIDIA_NIM_API_KEY (process env + .env.local)");

  const t0 = Date.now();
  const vectors: number[][] = [];
  let promptTokens = 0;
  let totalTokens = 0;
  let requests = 0;
  let dim = 0;
  for (let i = 0; i < texts.length; i += NIM_BATCH) {
    const batch = texts.slice(i, i + NIM_BATCH);
    const r = await postEmbeddings(key, NIM_EMBED_MODEL, batch, inputType);
    requests++;
    if (r.vectors.length !== batch.length) {
      throw new Error(`NIM: trả ${r.vectors.length}/${batch.length} vector`);
    }
    for (const v of r.vectors) {
      if (v.length !== NIM_EMBED_DIM) {
        throw new Error(`NIM: dim ${v.length} ≠ ${NIM_EMBED_DIM} (model đổi?)`);
      }
      vectors.push(v);
    }
    dim = r.vectors[0].length;
    promptTokens += r.promptTokens ?? 0;
    totalTokens += r.totalTokens ?? 0;
    if (i + NIM_BATCH < texts.length) {
      await new Promise((r2) => setTimeout(r2, NIM_BATCH_GAP_MS));
    }
  }
  return { model: NIM_EMBED_MODEL, dim, vectors, promptTokens, totalTokens, ms: Date.now() - t0, requests };
}

/* ─────────────── Bytes ↔ Float32 (lưu DB KnowledgeChunk.embedding) ─────────────── */

/** number[] → Uint8Array Float32 little-endian (8KB cho 2048 dim) — kiểu
 *  ArrayBuffer chặt để khớp Prisma Bytes (TS 5.7 generic Uint8Array). */
export function vectorToBytes(vec: number[]): Uint8Array<ArrayBuffer> {
  const f32 = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) f32[i] = vec[i];
  return new Uint8Array(f32.buffer.slice(0));
}

/** Uint8Array từ Prisma → Float32Array (an toàn byteOffset không căn 4). */
export function bytesToVector(bytes: Uint8Array): Float32Array | null {
  if (!bytes || bytes.length === 0 || bytes.length % 4 !== 0) return null;
  let buf = bytes;
  if (bytes.byteOffset % 4 !== 0 || bytes.byteLength !== bytes.length) {
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    buf = copy;
  }
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, bytes.length / 4);
  return f32;
}

/** Cosine similarity 2 vector (đã chuẩn hoá hay chưa đều đúng công thức). */
export function cosineF32(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}
