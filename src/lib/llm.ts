/**
 * src/lib/llm.ts — LỚP PROVIDER DUY NHẤT cho mọi cuộc gọi LLM của đội agent.
 *
 * Ba provider, chọn qua env `LLM_PROVIDER` (mặc định `auto`):
 *
 *  1. `opencode-cli` — Opencode CLI (`opencode run --format json`), model
 *     mặc định `space-bunny-free`. LÀ CON ĐƯỜNG DUY NHẤT chạy được model
 *     FREE của Opencode Zen: thực đo 2026-10-12 REST API trả 403
 *     FreeTierError "free tier can only be used from within OpenCode" với
 *     MỌI client ngoài (kể cả key oc_sk_ hợp lệ), trong khi CLI với đúng
 *     key đó (qua biến môi trường OPENCODE_API_KEY) trả lời bình thường,
 *     cost 0 — KHÔNG cần đăng nhập OAuth tài khoản OpenCode (sửa kết luận
 *     #91). App tự map OPENCODE_ZEN_API_KEY → OPENCODE_API_KEY cho tiến
 *     trình con. Yêu cầu duy nhất: lệnh `opencode` trong PATH (cài:
 *     `bun add -g opencode-ai` hoặc `npm i -g opencode-ai`); ghi đè đường
 *     dẫn qua OPENCODE_CLI_BIN. 9 model free đo được (đổi qua
 *     OPENCODE_ZEN_MODEL): space-bunny-free · ling-3.1-flash-free ·
 *     mimo-v2.6-flash-free · muse-spark-1.2-contributor-free ·
 *     muse-spark-1.3-contributor-free · nemotron-3.5-lightning-free ·
 *     jev-1.13-free · step-5-preview-free · longcat-2.5-preview-free.
 *
 *  2. `opencode-zen` — Opencode Zen REST gateway (https://opencode.ai/zen/v1),
 *     OpenAI-compatible, cùng key OPENCODE_ZEN_API_KEY. Qua gateway này
 *     CHỈ dùng được model TRẢ PHÍ (free bị chặn — xem trên).
 *     ⚠️ AUTH: gateway xác thực key `oc_sk_…` qua header `x-api-key` —
 *     `Authorization: Bearer` bị gateway coi là credential upstream
 *     passthrough → 401 "Invalid credential" (thực đo 2026-10-09:
 *     Bearer 401 · x-api-key 200 · GET /models chấp nhận cả hai).
 *
 *  3. `zai` — z-ai-web-dev-sdk (gateway nội bộ sandbox Z.ai), model GLM-4.6.
 *     CHỈ chạy bên trong sandbox (đọc config /etc/.z-ai-config). Dùng để
 *     phát triển/kiểm thử trong sandbox khi chưa có key Opencode.
 *
 * `auto` (mặc định): có key + có lệnh `opencode` → opencode-cli; có key
 * không có lệnh → opencode-zen (lúc đó phải tự đặt model trả phí qua
 * OPENCODE_ZEN_MODEL); không key → zai. Nhờ vậy cùng một codebase chạy ở
 * cả sandbox lẫn máy local của trader mà không cần sửa code.
 *
 * Chi phí (costUsd) theo provider: GLM-4.6 = $0.6/MTok vào + $2.2/MTok ra;
 * model Zen đuôi `-free` (qua CLI) = $0. Có thể override bằng
 * `LLM_PRICE_IN_MTOK` / `LLM_PRICE_OUT_MTOK`.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

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
const ZAI_MODEL_ID = "glm-4.6";

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

export const LLM_MODEL_ID: string =
  LLM_PROVIDER_ID === "zai"
    ? ZAI_MODEL_ID
    : env("OPENCODE_CLI_MODEL") || env("OPENCODE_ZEN_MODEL") || ZEN_DEFAULT_MODEL;

/** Nhãn hiển thị trên UI (tooltip/chip). */
export const LLM_MODEL_LABEL: string =
  LLM_PROVIDER_ID === "opencode-cli"
    ? `${LLM_MODEL_ID} · Opencode CLI${LLM_MODEL_ID.endsWith("-free") ? " (free)" : ""}`
    : LLM_PROVIDER_ID === "opencode-zen"
      ? `${LLM_MODEL_ID} · Opencode Zen${LLM_MODEL_ID.endsWith("-free") ? " (free)" : ""}`
      : `${ZAI_MODEL_ID} · Z.ai sandbox`;

const MODEL_IS_FREE = LLM_PROVIDER_ID !== "zai" && LLM_MODEL_ID.endsWith("-free");

const PRICE_IN_MTOK =
  env("LLM_PRICE_IN_MTOK") !== ""
    ? Number(env("LLM_PRICE_IN_MTOK"))
    : MODEL_IS_FREE
      ? 0
      : 0.6;
const PRICE_OUT_MTOK =
  env("LLM_PRICE_OUT_MTOK") !== ""
    ? Number(env("LLM_PRICE_OUT_MTOK"))
    : MODEL_IS_FREE
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
    runsOutsideSandbox: LLM_PROVIDER_ID !== "zai",
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

/* ──────────────────────── Provider: Opencode CLI ──────────────────────── */

/*
 * Mỗi cuộc gọi = một tiến trình `opencode run` (non-interactive,
 * --format json). Thực đo 2026-10-12 (sandbox): tổng ~8-11s/lệnh gọi
 * (boot CLI ~4-8s + model space-bunny-free ~1-4s) — chu kỳ 23 agents có
 * 6 LLM tuần tự → ~60s/chu kỳ, nằm an toàn trong maxDuration 300s.
 * Tokens/chi phí đọc từ event step_finish của CLI (cost 0 với model free).
 * Timeout mặc định 120s (đo thật: agent nặng nhất portfolio-strategist 27s,
 * một lần nghẽn tạm đã vượt 60s) — override qua OPENCODE_CLI_TIMEOUT_MS.
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
      throw new Error(
        `Opencode CLI trả lỗi: ${JSON.stringify(ev.error ?? ev.part).slice(0, 300)}`
      );
    }
  }
  return { raw, tokensIn, tokensOut };
}

function opencodeCliComplete(
  messages: LlmMessage[]
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
    `opencode/${LLM_MODEL_ID}`,
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
    // cwd = thư mục tạm: giữ CLI là "đường ống LLM thuần", không đọc repo
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
          `Opencode CLI quá ${CLI_TIMEOUT_MS}ms không phản hồi — tăng OPENCODE_CLI_TIMEOUT_MS hoặc đổi model nhẹ hơn (OPENCODE_ZEN_MODEL).`
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
        finish(
          new Error(
            `Opencode CLI thoát với mã ${code ?? "?"}: ${((stderr || stdout).trim() || "không có log").slice(-400)}`
          )
        );
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

/* ─────────────────────────── Cổng gọi thống nhất ─────────────────────────── */

async function complete(messages: LlmMessage[]): Promise<LlmCallResult> {
  const { raw, tokensIn, tokensOut } =
    LLM_PROVIDER_ID === "opencode-cli"
      ? await opencodeCliComplete(messages)
      : LLM_PROVIDER_ID === "opencode-zen"
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
