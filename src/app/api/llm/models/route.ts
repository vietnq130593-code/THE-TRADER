import { NextResponse } from "next/server";
import {
  currentModelId,
  defaultZenModelId,
  llmCostUsd,
  llmGuardConfig,
  llmStatus,
  listZenModels,
  setLlmModel,
  testLlmModel,
  ZAI_MODEL_ID,
  ZEN_FREE_MODELS_FALLBACK,
  LLM_PROVIDER_ID,
} from "@/lib/llm";
import type { LlmModelsResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * GET/POST /api/llm/models — bộ chọn model cho TOÀN ĐỘI AGENT (phiên #93,
 * nút "Model AI" trong workspace Đội Agent).
 *
 * GET: danh sách model (live từ GET /zen/v1/models, cache 60s, fallback 12
 * model free đo #93) + model hiện tại + cấu hình chống 429 đang hiệu lực.
 *
 * POST body:
 *  - { action: "test", model?: string } — kiểm tra sức khoẻ model (gọi thật
 *    prompt bé qua provider hiện tại, đo độ trễ + tokens + chi phí; vẫn đi
 *    qua throttle toàn cục nên không phá giãn cách chống 429).
 *  - { model: "<id>" } — chuyển toàn đội agent sang model đó: ghi AppSetting
 *    "llm-model" + AuditLog LLM_MODEL_SET; hiệu lực từ cuộc gọi LLM tiếp
 *    theo (không cần restart, chu kỳ đang chạy giữ nguyên model cũ).
 */

async function buildModelsResponse(): Promise<LlmModelsResponse> {
  const [current, list] = await Promise.all([currentModelId(), listZenModels()]);
  const guard = llmGuardConfig();
  return {
    provider: LLM_PROVIDER_ID,
    current,
    defaultModel: defaultZenModelId(),
    canChoose: LLM_PROVIDER_ID !== "zai",
    canTest: true,
    models: list.models,
    source: list.source,
    guard: {
      minSpacingMs: guard.minSpacingMs,
      maxConcurrent: guard.maxConcurrent,
      retryBackoffMs: [...guard.retryBackoffMs],
    },
  };
}

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(await buildModelsResponse());
  } catch (err) {
    console.error("[api/llm/models:GET]", err);
    return NextResponse.json(
      { error: "Không tải được danh sách model AI." },
      { status: 500 }
    );
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const body = (await req.json().catch(() => null)) as
      | { model?: unknown; action?: unknown }
      | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json(
        { error: "Payload không hợp lệ — cần object JSON { model } hoặc { action: \"test\" }." },
        { status: 400 }
      );
    }

    /* ── Hành động kiểm tra sức khoẻ model ── */
    if (body.action === "test") {
      const target =
        typeof body.model === "string" && body.model.trim() !== ""
          ? body.model.trim()
          : await currentModelId();
      if (LLM_PROVIDER_ID === "zai" && target !== ZAI_MODEL_ID) {
        return NextResponse.json(
          { error: "Provider zai chỉ chạy GLM-4.6 (cố định theo sandbox)." },
          { status: 422 }
        );
      }
      try {
        const res = await testLlmModel(target);
        return NextResponse.json({
          ok: true,
          model: target,
          latencyMs: res.latencyMs,
          tokensIn: res.tokensIn,
          tokensOut: res.tokensOut,
          costUsd: llmCostUsd(res.tokensIn, res.tokensOut),
        });
      } catch (err) {
        console.error("[api/llm/models:POST test]", err);
        return NextResponse.json(
          {
            ok: false,
            model: target,
            error:
              err instanceof Error
                ? err.message.slice(0, 300)
                : "Kiểm tra model thất bại.",
          },
          { status: 502 }
        );
      }
    }

    /* ── Chuyển model cho toàn đội agent ── */
    if (body.action !== undefined) {
      return NextResponse.json(
        { error: `action không hợp lệ — chỉ hỗ trợ "test".` },
        { status: 400 }
      );
    }
    if (typeof body.model !== "string" || body.model.trim() === "") {
      return NextResponse.json(
        { error: "Thiếu trường model (chuỗi id model, vd space-bunny-free)." },
        { status: 400 }
      );
    }
    const model = body.model.trim();
    if (LLM_PROVIDER_ID === "zai") {
      return NextResponse.json(
        {
          error:
            "Provider hiện tại là zai (GLM-4.6 cố định trong sandbox) — đặt OPENCODE_ZEN_API_KEY trong .env để chọn được model Opencode.",
        },
        { status: 409 }
      );
    }
    // Validate: model phải nằm trong danh sách live HOẶC fallback free
    // (danh sách live có thể fetch fail — fallback luôn là tập con hợp lệ)
    const list = await listZenModels();
    const known = new Set<string>([
      ...list.models.map((m) => m.id),
      ...ZEN_FREE_MODELS_FALLBACK,
    ]);
    if (!known.has(model)) {
      return NextResponse.json(
        {
          error: `Model "${model}" không có trong danh sách (${list.source}). Chọn model trong danh sách.`,
        },
        { status: 422 }
      );
    }

    const saved = await setLlmModel(model);
    return NextResponse.json({ ok: saved, llm: await llmStatus() });
  } catch (err) {
    console.error("[api/llm/models:POST]", err);
    return NextResponse.json(
      { error: "Thao tác với model AI thất bại." },
      { status: 500 }
    );
  }
}
