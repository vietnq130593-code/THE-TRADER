/**
 * src/lib/llm.ts — LỚP PROVIDER DUY NHẤT cho mọi cuộc gọi LLM của đội agent.
 *
 * Hai provider, chọn qua env `LLM_PROVIDER` (mặc định `auto`):
 *
 *  1. `opencode-zen` — Opencode Zen gateway (https://opencode.ai/zen/v1),
 *     OpenAI-compatible REST, model mặc định `space-bunny-free` (miễn phí,
 *     zero-retention). CHẠY ĐƯỢC CẢ NGOÀI SANDBOX — chỉ cần
 *     `OPENCODE_ZEN_API_KEY` (lấy tại opencode.ai/zen → sign in → API key).
 *     Đây là provider dành cho môi trường local của trader.
 *     ⚠️ AUTH: gateway xác thực key `oc_sk_…` qua header `x-api-key` —
 *     `Authorization: Bearer` bị gateway coi là credential upstream
 *     passthrough → 401 "Invalid credential" (thực đo 2026-10-09:
 *     Bearer 401 · x-api-key 200 · GET /models chấp nhận cả hai).
 *
 *  2. `zai` — z-ai-web-dev-sdk (gateway nội bộ sandbox Z.ai), model GLM-4.6.
 *     CHỈ chạy bên trong sandbox (đọc config /etc/.z-ai-config). Dùng để
 *     phát triển/kiểm thử trong sandbox khi chưa có key Opencode Zen.
 *
 * `auto` (mặc định): có OPENCODE_ZEN_API_KEY → opencode-zen, ngược lại → zai.
 * Nhờ vậy cùng một codebase chạy ở cả 2 môi trường mà không cần sửa code.
 *
 * Chi phí (costUsd) theo provider: GLM-4.6 = $0.6/MTok vào + $2.2/MTok ra;
 * model free-tier của Zen (đuôi `-free`) = $0. Có thể override bằng
 * `LLM_PRICE_IN_MTOK` / `LLM_PRICE_OUT_MTOK`.
 */

export type LlmProviderId = "zai" | "opencode-zen";

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
const ZAI_MODEL_ID = "glm-4.6";

function resolveProvider(): LlmProviderId {
  const wanted = env("LLM_PROVIDER").toLowerCase();
  if (wanted === "opencode-zen" || wanted === "zen") return "opencode-zen";
  if (wanted === "zai") return "zai";
  // auto: ưu tiên Opencode Zen khi trader đã đặt key (chạy được cả ngoài sandbox)
  return env("OPENCODE_ZEN_API_KEY") ? "opencode-zen" : "zai";
}

export const LLM_PROVIDER_ID: LlmProviderId = resolveProvider();

export const LLM_MODEL_ID: string =
  LLM_PROVIDER_ID === "opencode-zen"
    ? env("OPENCODE_ZEN_MODEL") || ZEN_DEFAULT_MODEL
    : ZAI_MODEL_ID;

/** Nhãn hiển thị trên UI (tooltip/chip). */
export const LLM_MODEL_LABEL: string =
  LLM_PROVIDER_ID === "opencode-zen"
    ? `${LLM_MODEL_ID} · Opencode Zen${LLM_MODEL_ID.endsWith("-free") ? " (free)" : ""}`
    : `${ZAI_MODEL_ID} · Z.ai sandbox`;

const PRICE_IN_MTOK =
  env("LLM_PRICE_IN_MTOK") !== ""
    ? Number(env("LLM_PRICE_IN_MTOK"))
    : LLM_PROVIDER_ID === "opencode-zen" && LLM_MODEL_ID.endsWith("-free")
      ? 0
      : 0.6;
const PRICE_OUT_MTOK =
  env("LLM_PRICE_OUT_MTOK") !== ""
    ? Number(env("LLM_PRICE_OUT_MTOK"))
    : LLM_PROVIDER_ID === "opencode-zen" && LLM_MODEL_ID.endsWith("-free")
      ? 0
      : 2.2;

/** Trạng thái provider cho API/UI — một nguồn duy nhất. */
export function llmStatus(): {
  provider: LlmProviderId;
  model: string;
  modelLabel: string;
  free: boolean;
  priceInMtOk: number;
  priceOutMtOk: number;
  runsOutsideSandbox: boolean;
} {
  return {
    provider: LLM_PROVIDER_ID,
    model: LLM_MODEL_ID,
    modelLabel: LLM_MODEL_LABEL,
    free: PRICE_IN_MTOK === 0 && PRICE_OUT_MTOK === 0,
    priceInMtOk: PRICE_IN_MTOK,
    priceOutMtOk: PRICE_OUT_MTOK,
    runsOutsideSandbox: LLM_PROVIDER_ID === "opencode-zen",
  };
}

/* ───────────────────────────── Tiện ích chung ───────────────────────────── */

/** Ước lượng thô ~4 ký tự/token khi provider không trả usage. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/** Chi phí USD một cuộc gọi — theo bảng giá của provider đang chạy. */
export function llmCostUsd(tokensIn: number, tokensOut: number): number {
  return Number(
    ((tokensIn * PRICE_IN_MTOK + tokensOut * PRICE_OUT_MTOK) / 1_000_000).toFixed(6)
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

/* ───────────────────────── Provider: Opencode Zen ───────────────────────── */

/*
 * Timeout mỗi cuộc gọi Zen. Chu kỳ 23 agents có 6 LLM tuần tự: 45s/call
 * (reasoning_effort=low thực đo ~4s) → tổng an toàn trong maxDuration 300s;
 * trước đây 110s có thể kéo tổng chu kỳ tới ~11 phút nếu gateway đình trệ.
 * Override qua env ZEN_TIMEOUT_MS.
 */
const ZEN_TIMEOUT_MS =
  Number(env("ZEN_TIMEOUT_MS")) > 0 ? Number(env("ZEN_TIMEOUT_MS")) : 45_000;

/**
 * Reasoning effort cho model reasoning (space-bunny-free = GLM-4.6 fine-tune có
 * chain-of-thought). Đo thực tế: không set → ~1433 reasoning tokens ≈ 19s/call;
 * effort "low" → ~40 reasoning tokens ≈ 3.7s/call (nhanh ~5×) mà chất lượng
 * trả lời vẫn đủ tốt cho phân tích ngắn của agent. Override qua env
 * OPENCODE_ZEN_REASONING_EFFORT = low | medium | high | none (none = không gửi).
 */
function zenReasoningEffort(): string | null {
  const wanted = env("OPENCODE_ZEN_REASONING_EFFORT").toLowerCase();
  if (wanted === "none") return null;
  if (wanted === "low" || wanted === "medium" || wanted === "high") return wanted;
  // Mặc định: model họ space-bunny (reasoning) → "low"; model khác → không gửi
  return LLM_MODEL_ID.includes("space-bunny") ? "low" : null;
}

interface ZenChatResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string } | string;
}

async function zenChatCompletions(
  messages: LlmMessage[]
): Promise<{ raw: string; tokensIn: number | null; tokensOut: number | null }> {
  const apiKey = env("OPENCODE_ZEN_API_KEY");
  if (!apiKey) {
    throw new Error(
      "OPENCODE_ZEN_API_KEY chưa đặt — lấy key tại opencode.ai/zen (sign in → API key) rồi đặt vào .env để chạy mô hình Opencode Zen."
    );
  }
  const baseUrl = (env("OPENCODE_ZEN_BASE_URL") || ZEN_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const reasoningEffort = zenReasoningEffort();
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
        model: LLM_MODEL_ID,
        messages,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      }),
      signal: controller.signal,
    });
    const bodyText = await res.text();
    if (!res.ok) {
      // Nhét status vào message để tầng retry bắt "429" (pattern cũ giữ nguyên)
      let detail = bodyText.slice(0, 300);
      try {
        const parsed = JSON.parse(bodyText) as ZenChatResponse;
        const err = parsed.error;
        detail =
          typeof err === "string" ? err : (err?.message ?? detail);
      } catch {
        /* giữ bodyText thô */
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

/* ─────────────────────────── Cổng gọi thống nhất ─────────────────────────── */

async function complete(messages: LlmMessage[]): Promise<LlmCallResult> {
  const { raw, tokensIn, tokensOut } =
    LLM_PROVIDER_ID === "opencode-zen"
      ? await zenChatCompletions(messages)
      : await zaiChatCompletions(messages);
  const promptText = messages.map((m) => m.content).join("\n");
  return {
    raw,
    tokensIn: tokensIn ?? estimateTokens(promptText),
    tokensOut: tokensOut ?? estimateTokens(raw),
  };
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

function isRateLimitError(err: unknown): boolean {
  // Chỉ match "HTTP 429" có ranh giới từ — tránh false-positive kiểu "14290"
  return err instanceof Error && /(?:HTTP|status[_ ]?code[": ]+)429\b/i.test(err.message);
}

/** Retry một lần khi 429 (giữ pattern cũ — budget request của gateway thấp). */
export async function callLlmWithRetry(
  systemPrompt: string,
  userPrompt: string
): Promise<LlmCallResult> {
  try {
    return await callLlm(systemPrompt, userPrompt);
  } catch (err) {
    if (!isRateLimitError(err)) throw err;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    return callLlm(systemPrompt, userPrompt);
  }
}

/** Bản retry cho chat 1-1. */
export async function callChatLlmWithRetry(
  messages: LlmMessage[]
): Promise<LlmCallResult> {
  try {
    return await callChatLlm(messages);
  } catch (err) {
    if (!isRateLimitError(err)) throw err;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    return callChatLlm(messages);
  }
}
