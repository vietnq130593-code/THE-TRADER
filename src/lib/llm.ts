/**
 * src/lib/llm.ts — LỚP PROVIDER DUY NHẤT cho mọi cuộc gọi LLM của đội agent.
 *
 * Ba provider, chọn qua env `LLM_PROVIDER` (mặc định `auto`):
 *
 *  1. `opencode-cli` — Opencode CLI (`opencode run --format json`). LÀ CON
 *     ĐƯỜNG DUY NHẤT chạy được model FREE của Opencode Zen: thực đo
 *     2026-10-12 REST API trả 403 FreeTierError "free tier can only be used
 *     from within OpenCode" với MỌI client ngoài (kể cả key oc_sk_ hợp lệ),
 *     trong khi CLI với đúng key đó (qua biến môi trường OPENCODE_API_KEY)
 *     trả lời bình thường, cost 0 — KHÔNG cần đăng nhập OAuth. App tự map
 *     OPENCODE_ZEN_API_KEY → OPENCODE_API_KEY cho tiến trình con. Yêu cầu
 *     duy nhất: lệnh `opencode` trong PATH (`bun add -g opencode-ai`);
 *     ghi đè qua OPENCODE_CLI_BIN.
 *
 *  2. `opencode-zen` — Opencode Zen REST gateway (https://opencode.ai/zen/v1),
 *     OpenAI-compatible, cùng key OPENCODE_ZEN_API_KEY. Qua gateway này
 *     CHỈ dùng được model TRẢ PHÍ (free bị chặn — xem trên).
 *     ⚠️ AUTH: gateway xác thực key `oc_sk_…` qua header `x-api-key` —
 *     `Authorization: Bearer` bị gateway coi là credential upstream
 *     passthrough → 401 "Invalid credential" (thực đo 2026-10-09).
 *
 *  3. `zai` — z-ai-web-dev-sdk (gateway nội bộ sandbox Z.ai), model GLM-4.6.
 *
 * `auto` (mặc định): có key + có lệnh `opencode` → opencode-cli; có key
 * không có lệnh → opencode-zen; không key → zai.
 *
 * ── PHIÊN #93: MODEL ĐỘNG (chọn từ UI "Đội Agent") ──
 * Model không còn khoá cứng theo env: giờ lưu trong AppSetting key
 * "llm-model" (ghi qua POST /api/llm/models), ưu tiên AppSetting → env
 * OPENCODE_CLI_MODEL/OPENCODE_ZEN_MODEL → mặc định space-bunny-free. Cache
 * in-process 5s (pattern market-data trong lib/settings.ts). Toàn bộ 23
 * agent dùng chung một model — chọn ở đâu cũng ăn hiệu lực từ cuộc gọi
 * tiếp theo (không cần restart).
 *
 * ── PHIÊN #93: CHỐNG 429 (rate limit) — 3 LỚP ──
 *  L1 Throttle toàn cục: mọi cuộc gọi đi qua một cổng duy nhất — giãn cách
 *     tối thiểu giữa 2 lượt khởi động (LLM_MIN_SPACING_MS, mặc định 900ms)
 *     + số cuộc gọi đồng hành song song tối đa (LLM_MAX_CONCURRENT, mặc định
 *     2). Chu kỳ 23 agents chạy tuần tự vốn không dồn突发; lớp này chặn nốt
 *     các đường dồn (chạy riêng + chat đồng thời, k-run trùng nhịp).
 *  L2 Retry backoff: hết.slot-429 → thử lại tối đa 3 lần, giãn cách luỹ
 *     tiến 2s → 6s → 15s (+ jitter ±20%), tôn trọng header Retry-After của
 *     gateway khi có (lấy max(backoff, retry-after), trần 60s).
 *  L3 Phát hiện rộng: 429 đến từ REST (HTTP 429) lẫn CLI (stderr/JSON error
 *     chứa "Too Many Requests" / "rate limit" / quota) — cùng một bộ phát
 *     hiện looksLikeRateLimit(). (Lớp chặn 60s/agent theo DB trong
 *     lib/agent-ratelimit.ts vẫn giữ nguyên — ngăn spam từ UI.)
 *
 * Chi phí (costUsd): model đuôi `-free` = $0; GLM-4.6 = $0.6/$2.2 mỗi MTok
 * vào/ra; model Zen trả phí ước lượng $0.6/$2.2 (chưa có bảng giá công khai
 * theo model). Override bằng LLM_PRICE_IN_MTOK / LLM_PRICE_OUT_MTOK.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { db } from "@/lib/db";

export type LlmProviderId = "zai" | "opencode-zen" | "opencode-cli";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmCallResult {
  raw: string;
  tokensIn: number;
  tokensOut: number;
}

/* ────────────────────────── Provider resolution ────────────────────────── */

const env = (name: string): string => (process.env[name] ?? "").trim();

const ZEN_DEFAULT_BASE_URL = "https://opencode.ai/zen/v1";
const ZEN_DEFAULT_MODEL = "space-bunny-free";
export const ZAI_MODEL_ID = "glm-4.6";

/** Tìm lệnh `opencode` trong PATH — một lần khi nạp module (sync, không exec). */
const OPENCODE_BIN: string | null = (() => {
  const override = env("OPENCODE_CLI_BIN");
  if (override) return override;
  const names = ["opencode", "opencode.exe", "opencode.cmd", "opencode.bat"];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      try {
        if (existsSync(join(dir, name))) return name;
      } catch {
        /* thư mục không đọc được — bỏ qua */
      }
    }
  }
  return null;
})();

function resolveProvider(): LlmProviderId {
  const wanted = env("LLM_PROVIDER").toLowerCase();
  if (wanted === "opencode-cli" || wanted === "opencode") return "opencode-cli";
  if (wanted === "opencode-zen" || wanted === "zen") return "opencode-zen";
  if (wanted === "zai") return "zai";
  // auto: model free chỉ chạy "from within OpenCode" → ưu tiên CLI khi đủ cả 2 điều kiện
  if (env("OPENCODE_ZEN_API_KEY") && OPENCODE_BIN) return "opencode-cli";
  if (env("OPENCODE_ZEN_API_KEY")) return "opencode-zen";
  return "zai";
}

export const LLM_PROVIDER_ID: LlmProviderId = resolveProvider();

/* ─────────────── Phiên #93 — model động (AppSetting "llm-model") ─────────────── */

/**
 * 12 model FREE đo được trên GET /zen/v1/models ngày 13/10/2026 (danh sách
 * live có thể dài hơn — route /api/llm/models lấy fresh mỗi 60s; đây là
 * fallback khi gateway không gọi được, dùng cả để validate model id).
 */
export const ZEN_FREE_MODELS_FALLBACK: readonly string[] = [
  "space-bunny-free",
  "exo-free",
  "ling-3.1-flash-free",
  "ling-3.0-flash-fin-free",
  "mimo-v2.6-flash-free",
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
  "nemotron-3.5-lightning-free",
  "nemotron-3-ultra-free",
  "jev-1.13-free",
  "step-5-preview-free",
  "longcat-2.5-preview-free",
];

const KEY_LLM_MODEL = "llm-model";
const MODEL_CACHE_TTL_MS = 5_000;
/** Định dạng id model hợp lệ (chữ thường + số + . - /) — chèn được an toàn argv CLI. */
const MODEL_ID_RE = /^[a-z0-9][a-z0-9.\-/]{2,79}$/i;

/** Model mặc định theo env (không đọc DB) — cũng là fallback khi DB lỗi. */
export function defaultZenModelId(): string {
  return env("OPENCODE_CLI_MODEL") || env("OPENCODE_ZEN_MODEL") || ZEN_DEFAULT_MODEL;
}

let cachedModel: { model: string; at: number } | null = null;

function cacheModel(model: string): void {
  cachedModel = { model, at: Date.now() };
}

/**
 * Model HIỆN TẠI của cả đội agent — AppSetting "llm-model" (do UI chọn)
 * → env → space-bunny-free. Provider zai luôn GLM-4.6 (cố định theo SDK).
 */
export async function currentModelId(): Promise<string> {
  if (LLM_PROVIDER_ID === "zai") return ZAI_MODEL_ID;
  if (cachedModel && Date.now() - cachedModel.at < MODEL_CACHE_TTL_MS) {
    return cachedModel.model;
  }
  let model = defaultZenModelId();
  try {
    const row = await db.appSetting.findUnique({ where: { key: KEY_LLM_MODEL } });
    if (row) {
      try {
        const parsed = JSON.parse(row.value) as { model?: unknown };
        if (typeof parsed.model === "string" && MODEL_ID_RE.test(parsed.model)) {
          model = parsed.model;
        }
      } catch {
        /* payload hỏng — dùng env mặc định */
      }
    }
  } catch (err) {
    console.error("[lib/llm] đọc AppSetting llm-model thất bại (dùng env):", err);
  }
  cacheModel(model);
  return model;
}

/**
 * Ghi model mới cho toàn đội agent — AppSetting "llm-model" + AuditLog
 * LLM_MODEL_SET (fail-soft) + invalidate cache in-process ngay (đến lượt
 * gọi tiếp theo ăn hiệu lực). Trả true khi lưu DB thành công.
 */
export async function setLlmModel(model: string): Promise<boolean> {
  if (!MODEL_ID_RE.test(model)) {
    throw new Error("Id model không hợp lệ (chỉ chữ/số và . - /).");
  }
  const before = await currentModelId().catch(() => null);
  cacheModel(model); // hiệu lực tức thì kể cả khi DB lỗi
  let ok = false;
  try {
    await db.appSetting.upsert({
      where: { key: KEY_LLM_MODEL },
      create: { key: KEY_LLM_MODEL, value: JSON.stringify({ model }) },
      update: { value: JSON.stringify({ model }) },
    });
    ok = true;
  } catch (err) {
    console.error("[lib/llm] ghi AppSetting llm-model thất bại:", err);
  }
  try {
    await db.auditLog.create({
      data: {
        action: "LLM_MODEL_SET",
        entity: "AppSetting",
        entityId: KEY_LLM_MODEL,
        ...(before !== null ? { before: JSON.stringify({ model: before }) } : {}),
        after: JSON.stringify({ model, provider: LLM_PROVIDER_ID }),
      },
    });
  } catch {
    /* audit không chặn chính */
  }
  return ok;
}

/* ─────────── Danh sách model Zen (live + cache 60s + fallback) ─────────── */

export interface ZenModelEntry {
  id: string;
  free: boolean;
}

export interface ZenModelList {
  models: ZenModelEntry[];
  source: "live" | "fallback";
}

let zenModelsCache: { list: ZenModelList; at: number } | null = null;

/** GET /zen/v1/models — 60s cache in-process, fallback danh sách 12 model free. */
export async function listZenModels(): Promise<ZenModelList> {
  if (zenModelsCache && Date.now() - zenModelsCache.at < 60_000) {
    return zenModelsCache.list;
  }
  const apiKey = env("OPENCODE_ZEN_API_KEY");
  if (apiKey) {
    const baseUrl = (env("OPENCODE_ZEN_BASE_URL") || ZEN_DEFAULT_BASE_URL).replace(/\/+$/, "");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const res = await fetch(`${baseUrl}/models`, {
        headers: { "x-api-key": apiKey },
        signal: controller.signal,
      });
      if (res.ok) {
        const body = (await res.json()) as { data?: { id?: unknown }[] };
        const ids = (body.data ?? [])
          .map((m) => (typeof m?.id === "string" ? m.id : ""))
          .filter((id) => MODEL_ID_RE.test(id))
          .sort((a, b) => a.localeCompare(b));
        if (ids.length > 0) {
          const list: ZenModelList = {
            models: ids.map((id) => ({ id, free: id.endsWith("-free") })),
            source: "live",
          };
          zenModelsCache = { list, at: Date.now() };
          return list;
        }
      }
    } catch {
      /* mạng lỗi — dùng fallback */
    } finally {
      clearTimeout(timer);
    }
  }
  const list: ZenModelList = {
    models: ZEN_FREE_MODELS_FALLBACK.map((id) => ({ id, free: true })),
    source: "fallback",
  };
  zenModelsCache = { list, at: Date.now() };
  return list;
}

/* ──────────────────────── Giá theo model (động) ──────────────────────── */

function pricesForModel(model: string): { inMtOk: number; outMtok: number } {
  const envIn = env("LLM_PRICE_IN_MTOK");
  const envOut = env("LLM_PRICE_OUT_MTOK");
  if (envIn !== "" || envOut !== "") {
    return {
      inMtOk: envIn !== "" ? Number(envIn) : 0.6,
      outMtok: envOut !== "" ? Number(envOut) : 2.2,
    };
  }
  const free = model.endsWith("-free");
  return { inMtOk: free ? 0 : 0.6, outMtok: free ? 0 : 2.2 };
}

/** Model để tính giá cho llmCostUsd (sync) — cache được currentModelId() làm mới. */
function modelForPricing(): string {
  if (LLM_PROVIDER_ID === "zai") return ZAI_MODEL_ID;
  return cachedModel?.model ?? defaultZenModelId();
}

/** Nhãn hiển thị trên UI (tooltip/chip). */
function modelLabelFor(model: string): string {
  return LLM_PROVIDER_ID === "opencode-cli"
    ? `${model} · Opencode CLI${model.endsWith("-free") ? " (free)" : ""}`
    : LLM_PROVIDER_ID === "opencode-zen"
      ? `${model} · Opencode Zen${model.endsWith("-free") ? " (free)" : ""}`
      : `${ZAI_MODEL_ID} · Z.ai sandbox`;
}

/** Trạng thái provider cho API/UI — một nguồn duy nhất (async: model động #93). */
export async function llmStatus(): Promise<{
  provider: LlmProviderId;
  model: string;
  modelLabel: string;
  free: boolean;
  priceInMtOk: number;
  priceOutMtOk: number;
  runsOutsideSandbox: boolean;
}> {
  const model = await currentModelId();
  const prices = pricesForModel(model);
  return {
    provider: LLM_PROVIDER_ID,
    model,
    modelLabel: modelLabelFor(model),
    free: prices.inMtOk === 0 && prices.outMtok === 0,
    priceInMtOk: prices.inMtOk,
    priceOutMtOk: prices.outMtok,
    runsOutsideSandbox: LLM_PROVIDER_ID !== "zai",
  };
}

/* ───────────────────────────── Tiện ích chung ───────────────────────────── */

/** Ước lượng thô ~4 ký tự/token khi provider không trả usage. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/** Chi phí USD một cuộc gọi — theo bảng giá của model đang chọn. */
export function llmCostUsd(tokensIn: number, tokensOut: number): number {
  const p = pricesForModel(modelForPricing());
  return Number(
    ((tokensIn * p.inMtOk + tokensOut * p.outMtok) / 1_000_000).toFixed(6)
  );
}

function usageOf(completion: unknown): {
  tokensIn: number | null;
  tokensOut: number | null;
} {
  const usage = (
    completion as {
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    } | null
  )?.usage;
  return {
    tokensIn: usage?.prompt_tokens ?? null,
    tokensOut: usage?.completion_tokens ?? null,
  };
}

/* ───────── Phiên #93 L1 — cổng throttle toàn cục chống 429 ───────── */

/**
 * Mọi cuộc gọi LLM đi qua cổng này: (a) giãn cách tối thiểu giữa 2 lượt
 * BẮT ĐẦU (tránh nổ loạt request — nguyên nhân 429); (b) số cuộc gọi chạy
 * song song tối đa. Điều phối thuần in-process trên event loop — không race.
 */
const LLM_MIN_SPACING_MS =
  Number(env("LLM_MIN_SPACING_MS")) > 0 ? Number(env("LLM_MIN_SPACING_MS")) : 900;
const LLM_MAX_CONCURRENT =
  Number(env("LLM_MAX_CONCURRENT")) > 0 ? Number(env("LLM_MAX_CONCURRENT")) : 2;

let llmActive = 0;
let llmLastStart = 0;
const llmWaiters: Array<() => void> = [];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function acquireLlmSlot(): Promise<void> {
  for (;;) {
    if (llmActive < LLM_MAX_CONCURRENT) {
      const wait = llmLastStart + LLM_MIN_SPACING_MS - Date.now();
      if (wait <= 0) {
        llmActive += 1;
        llmLastStart = Date.now();
        return;
      }
      // Chờ đến hết giãn cách tối thiểu (+ jitter nhỏ tránh đồng loạt dậy)
      await sleep(wait + Math.floor(Math.random() * 150));
      continue;
    }
    // Hết slot đồng hành — xếp hàng, được đánh thức khi có cuộc gọi xong
    await new Promise<void>((resolve) => llmWaiters.push(resolve));
  }
}

function releaseLlmSlot(): void {
  llmActive = Math.max(0, llmActive - 1);
  llmWaiters.shift()?.();
}

/** Cấu hình chống 429 đang hiệu lực — lộ lên API cho UI hiển thị minh bạch. */
export function llmGuardConfig(): {
  minSpacingMs: number;
  maxConcurrent: number;
  retryBackoffMs: readonly number[];
} {
  return {
    minSpacingMs: LLM_MIN_SPACING_MS,
    maxConcurrent: LLM_MAX_CONCURRENT,
    retryBackoffMs: RETRY_BACKOFF_MS,
  };
}

/* ───────── Phiên #93 L3 — phát hiện 429 rộng (REST + CLI) ───────── */

/** Lỗi 429 mang retryAfterMs (giây từ header Retry-After của gateway). */
export class LlmRateLimitError extends Error {
  readonly retryAfterMs: number | null;
  constructor(message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = "LlmRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Bộ phát hiện văn bản 429 — khớp cả stderr CLI ("Too Many Requests",
 * "rate limit exceeded", quota) và thông điệp REST ("HTTP 429"). Cần ngữ cảnh
 * http/status/error quanh con số 429 để không bắn nhầm vào token-count 429
 * trong JSONL stdout bình thường.
 */
function looksLikeRateLimit(text: string): boolean {
  if (/too many requests|rate.?limit(?:ed|ing)?|exceeded your (?:current )?quota/i.test(text)) {
    return true;
  }
  return /429/.test(text) && /http|status|error|code|attempt|request/i.test(text);
}

function isRateLimitError(err: unknown): err is LlmRateLimitError {
  if (err instanceof LlmRateLimitError) return true;
  if (!(err instanceof Error)) return false;
  if (/(?:HTTP|status[_ ]?code[": ]+)429\b/i.test(err.message)) return true;
  return looksLikeRateLimit(err.message);
}

/* ───────────────────────── Provider: Opencode Zen ───────────────────────── */

/*
 * Timeout mỗi cuộc gọi Zen. Chu kỳ 23 agents có 6 LLM tuần tự: 45s/call
 * (reasoning_effort=low thực đo ~4s) → tổng an toàn trong maxDuration 300s.
 * Override qua env ZEN_TIMEOUT_MS.
 */
const ZEN_TIMEOUT_MS =
  Number(env("ZEN_TIMEOUT_MS")) > 0 ? Number(env("ZEN_TIMEOUT_MS")) : 45_000;

/**
 * Reasoning effort cho model reasoning (space-bunny = GLM-4.6 fine-tune có
 * chain-of-thought). Đo thực tế: effort "low" → ~40 reasoning tokens ≈ 3.7s/call
 * (nhanh ~5×) mà chất lượng vẫn đủ tốt. Override qua env
 * OPENCODE_ZEN_REASONING_EFFORT = low | medium | high | none (none = không gửi).
 */
function zenReasoningEffort(model: string): string | null {
  const wanted = env("OPENCODE_ZEN_REASONING_EFFORT").toLowerCase();
  if (wanted === "none") return null;
  if (wanted === "low" || wanted === "medium" || wanted === "high") return wanted;
  // Mặc định: model họ space-bunny (reasoning) → "low"; model khác → không gửi
  return model.includes("space-bunny") ? "low" : null;
}

interface ZenChatResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string } | string;
}

async function zenChatCompletions(
  messages: LlmMessage[],
  model: string
): Promise<{ raw: string; tokensIn: number | null; tokensOut: number | null }> {
  const apiKey = env("OPENCODE_ZEN_API_KEY");
  if (!apiKey) {
    throw new Error(
      "OPENCODE_ZEN_API_KEY chưa đặt — lấy key tại opencode.ai/zen (sign in → API key) rồi đặt vào .env để chạy mô hình Opencode Zen."
    );
  }
  const baseUrl = (env("OPENCODE_ZEN_BASE_URL") || ZEN_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const reasoningEffort = zenReasoningEffort(model);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ZEN_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      // x-api-key (không phải Authorization Bearer): Bearer bị Zen gateway
      // từ chối 401 "Invalid credential" với key oc_sk_… (thực đo 2026-10-09)
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      }),
      signal: controller.signal,
    });
    const bodyText = await res.text();
    if (!res.ok) {
      let detail = bodyText.slice(0, 300);
      try {
        const parsed = JSON.parse(bodyText) as ZenChatResponse;
        const err = parsed.error;
        detail =
          typeof err === "string" ? err : (err?.message ?? detail);
      } catch {
        /* giữ bodyText thô */
      }
      // #93 L3 — 429 tách loại riêng + tôn trọng Retry-After (giây) của gateway
      if (res.status === 429) {
        const ra = Number(res.headers.get("retry-after"));
        throw new LlmRateLimitError(
          `Opencode Zen HTTP 429: ${detail}`,
          Number.isFinite(ra) && ra > 0 ? ra * 1000 : null
        );
      }
      throw new Error(`Opencode Zen HTTP ${res.status}: ${detail}`);
    }
    const completion = JSON.parse(bodyText) as ZenChatResponse;
    const raw = completion.choices?.[0]?.message?.content ?? "";
    if (!raw) throw new Error("Phản hồi trống từ mô hình AI.");
    const usage = usageOf(completion);
    return { raw, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut };
  } finally {
    clearTimeout(timer);
  }
}

/* ──────────────────────── Provider: Opencode CLI ──────────────────────── */

/*
 * Mỗi cuộc gọi = một tiến trình `opencode run` (non-interactive,
 * --format json). Thực đo 2026-10-12 (sandbox): tổng ~8-11s/lệnh gọi
 * (boot CLI ~4-8s + model space-bunny-free ~1-4s). Tokens/chi phí đọc từ
 * event step_finish của CLI (cost 0 với model free). Timeout mặc định 120s
 * (đo thật: agent nặng nhất 27s; sandbox hiện đặt 150s qua env) — override
 * qua OPENCODE_CLI_TIMEOUT_MS.
 */
const CLI_TIMEOUT_MS =
  Number(env("OPENCODE_CLI_TIMEOUT_MS")) > 0
    ? Number(env("OPENCODE_CLI_TIMEOUT_MS"))
    : 120_000;

/** Linux cắt mỗi tham số argv tại ~128KB — chặn sớm với thông điệp rõ ràng. */
const CLI_MAX_PROMPT_CHARS = 100_000;

interface CliJsonEvent {
  type?: string;
  part?: {
    type?: string;
    text?: string;
    tokens?: { input?: number; output?: number; reasoning?: number };
  };
  error?: unknown;
}

/** Đọc dòng JSONL của `opencode run --format json` → văn bản + tokens. */
function parseCliEvents(stdout: string): {
  raw: string;
  tokensIn: number | null;
  tokensOut: number | null;
} {
  let raw = "";
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let ev: CliJsonEvent;
    try {
      ev = JSON.parse(trimmed) as CliJsonEvent;
    } catch {
      continue;
    }
    if (ev.type === "text" && typeof ev.part?.text === "string") {
      raw += ev.part.text;
    } else if (ev.type === "step_finish" && ev.part?.tokens) {
      const t = ev.part.tokens;
      tokensIn = t.input ?? tokensIn;
      const out = (t.output ?? 0) + (t.reasoning ?? 0);
      if (out > 0) tokensOut = out;
    } else if (ev.type === "error") {
      const text = JSON.stringify(ev.error ?? ev.part) ?? "";
      // #93 L3 — lỗi 429 từ upstream Zen truyên qua event error của CLI
      if (looksLikeRateLimit(text)) {
        throw new LlmRateLimitError(`Opencode CLI trả 429: ${text.slice(0, 300)}`);
      }
      throw new Error(
        `Opencode CLI trả lỗi: ${text.slice(0, 300)}`
      );
    }
  }
  return { raw, tokensIn, tokensOut };
}

function opencodeCliComplete(
  messages: LlmMessage[],
  model: string
): Promise<{ raw: string; tokensIn: number | null; tokensOut: number | null }> {
  const apiKey = env("OPENCODE_ZEN_API_KEY");
  if (!apiKey) {
    throw new Error(
      "OPENCODE_ZEN_API_KEY chưa đặt — lấy key tại opencode.ai/zen (sign in → API key) rồi đặt vào .env để chạy model Opencode."
    );
  }
  if (!OPENCODE_BIN) {
    throw new Error(
      "Không tìm thấy lệnh `opencode` trong PATH — cài đặt CLI: `bun add -g opencode-ai` (hoặc `npm i -g opencode-ai`) rồi khởi động lại app; ghi đè đường dẫn qua OPENCODE_CLI_BIN nếu cài chỗ khác."
    );
  }
  const message = messages.map((m) => m.content).join("\n\n---\n\n");
  if (message.length > CLI_MAX_PROMPT_CHARS) {
    throw new Error(
      `Prompt quá dài cho Opencode CLI (${message.length} ký tự > giới hạn ${CLI_MAX_PROMPT_CHARS}).`
    );
  }
  const args = [
    "run",
    message,
    "--model",
    `opencode/${model}`,
    "--format",
    "json",
    "--pure",
    "--title",
    "the-trader",
  ];
  // Reasoning effort cho model reasoning (vd space-bunny): mặc định CLI đã
  // nhanh (~40 reasoning tokens); truyền --variant nếu trader muốn tinh chỉnh.
  const variant = env("OPENCODE_CLI_VARIANT");
  if (variant) args.push("--variant", variant);

  return new Promise((resolve, reject) => {
    // cwd = thư mục tạm: giữ CLI là "đường ống LLM thuần", không đọc repo.
    // stdin "ignore" = /dev/null — QUAN TRỌNG: stdin là pipe hở sẽ khiến CLI
    // treo chờ đọc vĩnh viễn (thực đo #93 khi test bằng bash pipe).
    const child = spawn(OPENCODE_BIN, args, {
      cwd: tmpdir(),
      env: { ...process.env, OPENCODE_API_KEY: apiKey },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (
      err: Error | null,
      out?: { raw: string; tokensIn: number | null; tokensOut: number | null }
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(out!);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* tiến trình đã thoát */
      }
      finish(
        new Error(
          `Opencode CLI quá ${CLI_TIMEOUT_MS}ms không phản hồi — tăng OPENCODE_CLI_TIMEOUT_MS hoặc đổi model nhẹ hơn (nút "Model AI" trong Đội Agent).`
        )
      );
    }, CLI_TIMEOUT_MS);
    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < 20 * 1024 * 1024) stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += d.toString("utf8");
    });
    child.on("error", (err: Error) =>
      finish(
        new Error(
          `Không khởi động được Opencode CLI (${OPENCODE_BIN}): ${err.message}. Kiểm tra OPENCODE_CLI_BIN.`
        )
      )
    );
    child.on("close", (code: number | null) => {
      if (code !== 0) {
        const tail = ((stderr || stdout).trim() || "không có log").slice(-400);
        // #93 L3 — stderr CLI chứa "Too Many Requests"/"rate limit" từ Zen
        if (looksLikeRateLimit(tail)) {
          finish(new LlmRateLimitError(`Opencode CLI 429 (rate limit): ${tail}`));
          return;
        }
        finish(new Error(`Opencode CLI thoát với mã ${code ?? "?"}: ${tail}`));
        return;
      }
      try {
        const parsed = parseCliEvents(stdout);
        if (!parsed.raw) throw new Error("Phản hồi trống từ mô hình AI.");
        finish(null, parsed);
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

/* ──────────────────────────── Provider: zai ──────────────────────────── */

type ZaiInstance = Awaited<ReturnType<(typeof import("z-ai-web-dev-sdk"))["default"]["create"]>>;
let zaiInstancePromise: Promise<ZaiInstance> | null = null;

async function getZai(): Promise<ZaiInstance> {
  // Cache instance — tránh đọc lại config file mỗi cuộc gọi
  if (!zaiInstancePromise) {
    zaiInstancePromise = (async () => {
      const mod = await import("z-ai-web-dev-sdk");
      const ZAI = mod.default;
      return ZAI.create();
    })();
    zaiInstancePromise.catch(() => {
      zaiInstancePromise = null; // cho phép thử lại ở call sau
    });
  }
  return zaiInstancePromise;
}

async function zaiChatCompletions(
  messages: LlmMessage[]
): Promise<{ raw: string; tokensIn: number | null; tokensOut: number | null }> {
  let zai: ZaiInstance;
  try {
    zai = await getZai();
  } catch {
    throw new Error(
      "Không khởi tạo được z-ai-web-dev-sdk (chỉ khả dụng trong sandbox Z.ai). Trên máy local hãy đặt OPENCODE_ZEN_API_KEY trong .env để chạy mô hình Opencode Zen."
    );
  }
  const completion = await zai.chat.completions.create({ messages });
  const raw: string =
    (completion as { choices?: { message?: { content?: string } }[] })?.choices?.[0]
      ?.message?.content ?? "";
  if (!raw) throw new Error("Phản hồi trống từ mô hình AI.");
  const usage = usageOf(completion);
  return { raw, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut };
}

/* ─────────────── Cổng gọi thống nhất (đi qua throttle #93 L1) ─────────────── */

async function completeWithModel(
  messages: LlmMessage[],
  model: string
): Promise<LlmCallResult> {
  await acquireLlmSlot();
  try {
    const { raw, tokensIn, tokensOut } =
      LLM_PROVIDER_ID === "opencode-cli"
        ? await opencodeCliComplete(messages, model)
        : LLM_PROVIDER_ID === "opencode-zen"
          ? await zenChatCompletions(messages, model)
          : await zaiChatCompletions(messages);
    const promptText = messages.map((m) => m.content).join("\n");
    return {
      raw,
      tokensIn: tokensIn ?? estimateTokens(promptText),
      tokensOut: tokensOut ?? estimateTokens(raw),
    };
  } finally {
    releaseLlmSlot();
  }
}

async function complete(messages: LlmMessage[]): Promise<LlmCallResult> {
  // Làm mới cache model rồi gọi — bảo đảm model mới chọn ăn hiệu lực ngay
  const model = await currentModelId();
  return completeWithModel(messages, model);
}

/** Gọi LLM dạng system + user (chu kỳ & chạy riêng). */
export async function callLlm(
  systemPrompt: string,
  userPrompt: string
): Promise<LlmCallResult> {
  return complete([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ]);
}

/** Gọi LLM với lịch sử thread (chat 1-1) — raw text là câu trả lời. */
export async function callChatLlm(messages: LlmMessage[]): Promise<LlmCallResult> {
  const { raw, tokensIn, tokensOut } = await complete(messages);
  return { raw: raw.trim(), tokensIn, tokensOut };
}

/**
 * Kiểm tra sức khoẻ một model (nút "Kiểm tra" trong UI Đội Agent): gọi
 * thật một prompt bé, đo độ trễ + tokens. Vẫn đi qua throttle toàn cục
 * (không phá giãn cách chống 429) nhưng KHÔNG retry — lỗi hiện nguyên văn.
 */
export async function testLlmModel(
  model: string
): Promise<{ latencyMs: number; tokensIn: number; tokensOut: number }> {
  const target = LLM_PROVIDER_ID === "zai" ? ZAI_MODEL_ID : model;
  const t0 = Date.now();
  const res = await completeWithModel(
    [
      {
        role: "user",
        content:
          "Kiểm tra kết nối: trả lời đúng một từ OK, không giải thích thêm.",
      },
    ],
    target
  );
  return {
    latencyMs: Date.now() - t0,
    tokensIn: res.tokensIn,
    tokensOut: res.tokensOut,
  };
}

/* ───────── Phiên #93 L2 — retry 429: 3 lần, backoff luỹ tiến + jitter ───────── */

const RETRY_BACKOFF_MS: readonly number[] = [2_000, 6_000, 15_000];
const RETRY_BACKOFF_CAP_MS = 60_000;

async function withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    if (attempt > 0) {
      const caught = lastErr instanceof LlmRateLimitError ? lastErr : null;
      const base =
        caught?.retryAfterMs != null
          ? Math.max(caught.retryAfterMs, RETRY_BACKOFF_MS[attempt - 1])
          : RETRY_BACKOFF_MS[attempt - 1];
      // trần 60s + jitter ±20% — tránh cả đội agent dậy đánh cùng lúc
      const capped = Math.min(base, RETRY_BACKOFF_CAP_MS);
      const delay = Math.round(capped * (0.8 + Math.random() * 0.4));
      await sleep(delay);
    }
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimitError(err)) throw err;
      lastErr = err;
      console.warn(
        `[lib/llm] 429 rate limit (lần ${attempt + 1}/${RETRY_BACKOFF_MS.length + 1}) — ${
          attempt < RETRY_BACKOFF_MS.length ? "thử lại sau backoff" : "đã hết lượt thử"
        }`
      );
    }
  }
  throw lastErr;
}

/** Gọi LLM kèm chống 429: throttle toàn cục + retry backoff 3 lần (#93). */
export async function callLlmWithRetry(
  systemPrompt: string,
  userPrompt: string
): Promise<LlmCallResult> {
  return withRateLimitRetry(() => callLlm(systemPrompt, userPrompt));
}

/** Bản retry cho chat 1-1. */
export async function callChatLlmWithRetry(
  messages: LlmMessage[]
): Promise<LlmCallResult> {
  return withRateLimitRetry(() => callChatLlm(messages));
}
