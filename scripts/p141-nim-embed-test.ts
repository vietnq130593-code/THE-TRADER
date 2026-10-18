/**
 * scripts/p141-nim-embed-test.ts (Task 141 — F-24 follow-up) — KIỂM TRA THẬT
 * NVIDIA NIM embeddings API bằng API key chủ sở hữu cung cấp (nvapi-…, đặt
 * trong .env.local KHÔNG commit — .env đang được track theo #113).
 *
 * Câu hỏi cần trả lời bằng số đo, không bằng lý thuyết:
 *   1. Key còn hợp lệ không? Sandbox có egress tới integrate.api.nvidia.com?
 *   2. Có những model embedding nào trên catalogue với key này?
 *   3. Model "2048 dim" chủ sở hữu nhớ (nvidia/llama-3.2-nv-embedqa-1b-v2)
 *      trả THẬT bao nhiêu chiều? Độ trễ từ sandbox bao lâu?
 *   4. Chất lượng NGỮ NGHĨA tiếng Việt tài chính: query "lạm phát CPI" có
 *      gần doc CPI tiếng Việt hơn doc bóng đá không? Cross-lingual VN↔EN ra sao?
 *      → quyết định model nào hợp cho lớp L2 của THE TRADER.
 *
 * READ-ONLY: 0 truy cập DB, 0 file sản phẩm bị sửa. Key không in ra log.
 * Chạy: bun scripts/p141-nim-embed-test.ts (bun tự nạp .env.local)
 */
const KEY = process.env.NVIDIA_NIM_API_KEY ?? "";
const BASE = "https://integrate.api.nvidia.com/v1";

if (!KEY) {
  console.error("✗ Thiếu NVIDIA_NIM_API_KEY trong .env.local");
  process.exit(1);
}

/* ─────────────── helpers ─────────────── */
const mask = (s: string): string => s.replace(/nvapi-(.{8}).*(.{4})/, "nvapi-$1…$2");

async function jfetch(
  url: string,
  init: RequestInit = {},
  timeoutMs = 30_000
): Promise<{ ok: boolean; status: number; json: unknown; raw: string; ms: number }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${KEY}`, ...(init.headers ?? {}) },
      signal: ac.signal,
    });
    const raw = await res.text();
    let json: unknown = null;
    try { json = JSON.parse(raw); } catch { /* không phải JSON */ }
    return { ok: res.ok, status: res.status, json, raw, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

interface EmbedResult {
  model: string;
  dims: number;
  vectors: number[][];
  ms: number;
  promptTokens: number | null;
  totalTokens: number | null;
}

/** POST /v1/embeddings — thử kèm input_type (chuẩn NIM cho model retrieval),
 *  nếu server từ chối field lạ thì thử lại không kèm (OpenAI-compat thuần). */
async function embed(
  model: string,
  texts: string[],
  inputType: "query" | "passage"
): Promise<EmbedResult> {
  const body = (withType: boolean) =>
    JSON.stringify({
      model,
      input: texts,
      ...(withType ? { input_type: inputType } : {}),
      encoding_format: "float",
    });

  let r = await jfetch(`${BASE}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body(true),
  });
  if (r.status === 400 || r.status === 422) {
    const retry = await jfetch(`${BASE}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body(false),
    });
    if (retry.ok || retry.status !== 400) r = retry;
  }
  if (!r.ok) {
    throw new Error(`HTTP ${r.status} — ${r.raw.slice(0, 180)}`);
  }
  const j = r.json as {
    data?: { embedding?: number[] }[];
    usage?: { prompt_tokens?: number; total_tokens?: number };
  };
  const vectors = (j.data ?? []).map((d) => d.embedding ?? []);
  if (!vectors.length || !vectors[0]?.length) throw new Error("Phản hồi thiếu embedding");
  return {
    model,
    dims: vectors[0].length,
    vectors,
    ms: r.ms,
    promptTokens: j.usage?.prompt_tokens ?? null,
    totalTokens: j.usage?.total_tokens ?? null,
  };
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}

/* ─────────────── Bộ test tiếng Việt tài chính ─────────────── */
const QUERY = "lạm phát CPI tháng 9 tăng nóng, dư địa lãi suất điều hành"; // query điển hình 1 chu kỳ
const DOCS: { key: string; text: string; label: string }[] = [
  {
    key: "vn-liên-quan",
    label: "CPI tiếng Việt (cùng chủ đề, khác từ)",
    text: "Tổng cục Thống kê công bố chỉ số giá tiêu dùng tháng 9 tăng 3,25% so với cùng kỳ, giá lõi tăng tốc; Ngân hàng Nhà nước giữ nguyên lãi suất điều hành, dư địa chính sách hẹp lại.",
  },
  {
    key: "en-liên-quan",
    label: "CPI tiếng Anh (cross-lingual)",
    text: "Vietnam September consumer price inflation accelerated while core inflation picked up; the central bank kept its policy rate unchanged, leaving limited room for easing.",
  },
  {
    key: "vn-ngoại-đề",
    label: "Bóng đá (hoàn toàn ngoài đề tài)",
    text: "Tiền đạo ghi bàn ở phút bù giờ thứ ba giúp đội tuyển giành chiến thắng trong trận chung kết đầy kịch tính tối qua.",
  },
];

/* Model ứng viên — 7 model embedding ĐANG SỐNG theo GET /v1/models của chính
 * key này (4 model thế hệ cũ nv-embedqa-1b-v2/e5-v5/bge-m3/nv-embed-v1 đều
 * HTTP 410 Gone — EOL trên catalogue, không gọi được nữa). */
const CANDIDATES = [
  "nvidia/llama-3.2-nv-embedqa-1b-v1",            // thế hệ qa 1B — nhớ "2048 dim" của chủ sở hữu chắc nằm ở họ này
  "nvidia/nemotron-3-embed-1b",                    // Nemotron-3 embed 1B (mới)
  "nvidia/llama-3.2-nemoretriever-1b-vlm-embed-v1",// retrieval 1B VLM
  "nvidia/llama-nemotron-embed-vl-1b-v2",          // embed VL v2
  "nvidia/nv-embedqa-mistral-7b-v2",               // 7B nặng
  "nvidia/embed-qa-4",                             // QA 4 (cũ hơn)
  "snowflake/arctic-embed-l",                      // đa ngữ kiểu khác
];

/* ─────────────── main ─────────────── */
async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║ TASK 141 — KIỂM TRA NVIDIA NIM EMBEDDINGS (API key thật)      ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`Key: ${mask(KEY)} · Endpoint: ${BASE}\n`);

  /* 1. Egress + key hợp lệ: GET /v1/models */
  console.log("── 1. GET /v1/models (kiểm tra egress + quyền) ──");
  const ml = await jfetch(`${BASE}/models`, {}, 20_000);
  if (!ml.ok) {
    console.log(`  ✗ HTTP ${ml.status} — ${ml.raw.slice(0, 200)}`);
    if (ml.status === 401) console.log("  → Key KHÔNG hợp lệ / hết hạn.");
    if (ml.status === 403) console.log("  → Key hợp lệ nhưng thiếu quyền model?");
    process.exit(1);
  }
  console.log(`  ✓ Kết nối được (${ml.ms}ms) — key HỢP LỆ`);
  const models = ((ml.json as { data?: { id?: string }[] }).data ?? [])
    .map((m) => m.id ?? "")
    .filter(Boolean);
  console.log(`  Catalogue: ${models.length} model`);
  const embedModels = models.filter((id) => /embed|bge-|e5|arctic|m3/i.test(id) && !/rerank/i.test(id));
  const rerankModels = models.filter((id) => /rerank/i.test(id));
  console.log(`  Model embedding: ${embedModels.length}`);
  for (const m of embedModels) console.log(`    · ${m}`);
  if (rerankModels.length) {
    console.log(`  Model rerank (bonus cho L2): ${rerankModels.length}`);
    for (const m of rerankModels) console.log(`    · ${m}`);
  }

  /* 2. Embed 4 text (query + 3 doc) trên từng model ứng viên */
  console.log("\n── 2. POST /v1/embeddings — đo dim · latency · token ──");
  console.log(`  Query : "${QUERY.slice(0, 50)}…"`);
  const results: { model: string; dims: number; ms: number; sims: { key: string; label: string; cos: number }[]; promptTokens: number | null }[] = [];
  for (const model of CANDIDATES) {
    try {
      const q = await embed(model, [QUERY], "query");
      const d = await embed(model, DOCS.map((x) => x.text), "passage");
      const sims = DOCS.map((doc, i) => ({
        key: doc.key,
        label: doc.label,
        cos: cosine(q.vectors[0], d.vectors[i]),
      }));
      results.push({ model, dims: q.dims, ms: q.ms + d.ms, sims, promptTokens: q.promptTokens });
      console.log(
        `  ✓ ${model}: ${q.dims} dim · ${(q.ms + d.ms)}ms (query ${q.ms} + docs ${d.ms}) · token ${q.promptTokens ?? "?"}/${d.promptTokens ?? "?"}`
      );
    } catch (e) {
      console.log(`  ✗ ${model}: ${String(e).slice(0, 140)}`);
    }
  }

  /* 3. Bảng cosine — chất lượng ngữ nghĩa tiếng Việt */
  if (results.length) {
    console.log("\n── 3. COSINE SIMILARITY query ↔ doc (cao = đúng nghĩa) ──");
    const widths = results.map((r) => r.model.length + 2);
    const header = `${"model".padEnd(Math.max(...widths))}${"dim".padStart(6)}${DOCS.map((d) => d.key.padStart(16)).join("")}`;
    console.log(`  ${header}`);
    for (const r of results) {
      const line = `${r.model.padEnd(Math.max(...widths))}${String(r.dims).padStart(6)}${r.sims
        .map((s) => s.cos.toFixed(3).padStart(16))
        .join("")}`;
      console.log(`  ${line}`);
    }
    console.log(`\n  Kỳ vọng model hiểu tiếng Việt tài chính:`);
    console.log(`    vn-liên-quan  CAO (≥0,55)   — trúng nghĩa dù khác chữ`);
    console.log(`    en-liên-quan  TRUNG (≥0,4)  — cross-lingual tốt`);
    console.log(`    vn-ngoại-đề  THẤP (≤0,35)  — phân biệt được lạc đề`);
    for (const r of results) {
      const [vn, en, off] = r.sims.map((s) => s.cos);
      // Với RAG, tiêu chí quyết định là BIÊN XẾP HẠNG related-vs-unrelated
      // (không phải trị tuyệt đối — xem §9.3 docs/RAG_UPGRADE_ASSESSMENT.md).
      const pass = vn - off >= 0.15 && en - off >= 0.1;
      console.log(
        `    ${r.model}: ${pass ? "✓ ĐẠT (theo biên xếp hạng)" : "✗ chưa đạt"} — vn−ngoại ${(vn - off).toFixed(3)} · en−ngoại ${(en - off).toFixed(3)} · cross-lingual ${en.toFixed(3)}`
      );
    }
  }

  /* 4. Chi phí ước tính cho L2 của THE TRADER */
  if (results.length) {
    console.log("\n── 4. CHI PHÍ ƯỚC CHO LỚP L2 (từ token đo được) ──");
    const CORPUS_CHARS = 881_635; // 2.291 doc, đo Task 140
    const VN_CHARS_PER_TOKEN = 2.5;
    const corpusTokens = Math.round(CORPUS_CHARS / VN_CHARS_PER_TOKEN);
    console.log(`  Corpus 2.291 doc ≈ ${corpusTokens.toLocaleString("en-US")} token (881.635 ký tự ÷ 2,5)`);
    console.log(`  → One-time embed cả kho: ~$${(corpusTokens / 1e6 * 0.02).toFixed(2)}–$${(corpusTokens / 1e6 * 0.1).toFixed(2)} (giả định $0,02–0,10/MTok — đối chiếu bảng giá NIM trước khi chạy)`);
    console.log(`  → Incremental ~185 doc/ngày (~15k token) + 1 query/chu kỳ (~50 token): không đáng kể`);
    console.log(`  → Lưu ý: NIM catalogue thường tặng credit dev (tra tại build.nvidia.com — cần xác minh số dư của key này)`);
  }
}

main().catch((e) => {
  console.error("LỖI:", String(e).slice(0, 300));
  process.exit(1);
});
