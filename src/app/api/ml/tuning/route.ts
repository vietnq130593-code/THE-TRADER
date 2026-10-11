import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { resetRagCache } from "@/lib/ml/rag";
import { readGruSetting, writeGruSetting } from "@/lib/ml/ensemble";
import {
  ML_TUNING_KEY,
  MLP_TUNING_DEFAULT,
  MLP_TUNING_FIELDS,
  RAG_TUNING_DEFAULT,
  RAG_TUNING_FIELDS,
  effectiveMlTuning,
  logMlAudit,
  readMlTuning,
  sanitizeTuningInput,
  writeMlTuning,
  type MlTuning,
  type MlpTuning,
} from "@/lib/ml/tuning";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET/POST /api/ml/tuning (phiên #89 → #94 · Task 3 — tab "Tinh chỉnh" +
 * trình chỉnh sửa kiến trúc ở tab "Mạng thần kinh").
 *
 * GET  → cấu hình đang lưu + giá trị HIỆU LỰC (merge mặc định — migrations
 *        h1/h2 → hidden[] chạy trong readMlTuning) + phạm vi hợp lệ từng
 *        trường (UI render ô nhập + validate).
 * POST → body (mọi phần tuỳ chọn, semantic partial — gửi {lr: 0,005} giữ
 *        nguyên hidden đã lưu):
 *   { mlp?: {hidden?: number[], activations?: ("relu"|"tanh"|"sigmoid")[],
 *            lossWeights?: [number, number, number],
 *            epochs?, patience?, batchSize?, lr?, l2?, valFraction?, seed?},
 *     rag?: {topK?, k1?, b?, wRecency?},
 *     resetMlp?: boolean, resetRag?: boolean,
 *     gruEnabled?: boolean,          // kill-switch giọng thứ ba — hiệu lực tức thì
 *     resetBandit?: boolean }        // trả 6 arm BanditArm về prior α=1/β=1
 *
 * Nguyên tắc: validate 422 CHẦN ĐỦ thông tin (field + lý do), audit mọi thao
 * tác (ML_TUNING_UPDATED · ML_GRU_TOGGLE · ML_BANDIT_RESET — fail-soft),
 * reset RAG cache khi tham số RAG đổi (corpus TTL 60s không giữ giá trị cũ).
 */

function buildPayload(saved: MlTuning) {
  const effective = effectiveMlTuning(saved);
  return {
    saved,
    effective,
    defaults: { mlp: MLP_TUNING_DEFAULT, rag: RAG_TUNING_DEFAULT },
    ranges: { mlp: MLP_TUNING_FIELDS, rag: RAG_TUNING_FIELDS },
    updatedAt: saved.updatedAt ?? null,
  };
}

/**
 * Hoà giải activations về đúng độ dài hidden SAU KHI merge (pad relu / cắt) —
 * chỉ chạy khi hidden có mặt; hidden thay đổi mà không gửi activations →
 * phần thiếu tự bổ "relu" (trình chỉnh sửa luôn gửi kèm nhau nên hiếm khi xảy ra).
 */
function reconcileMlpSection(section: Partial<MlpTuning>): Partial<MlpTuning> {
  if (section.hidden == null) return section;
  const acts: MlpTuning["activations"] = [];
  const src = section.activations ?? [];
  for (let i = 0; i < section.hidden.length; i++) {
    const v = src[i];
    acts.push(v === "tanh" || v === "sigmoid" || v === "relu" ? v : "relu");
  }
  return { ...section, activations: acts };
}

export async function GET() {
  const saved = await readMlTuning(); // fail-soft bên trong → {} khi DB hỏng
  return NextResponse.json(buildPayload(saved));
}

export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    const parsed = (await req.json()) as Record<string, unknown> | null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed;
  } catch {
    // body rỗng/sai JSON → không đổi gì, vẫn xử lý gruEnabled/reset nếu có (không có)
  }

  const applied: string[] = [];
  const saved = await readMlTuning();
  const next: MlTuning = { ...saved };
  let changed = false;
  let ragChanged = false;

  // 1) Reset từng phần về mặc định code (xoá section khỏi AppSetting).
  const resetMlp = body.resetMlp === true;
  const resetRag = body.resetRag === true;
  if (resetMlp && next.mlp != null) {
    delete next.mlp;
    changed = true;
    applied.push("đặt lại MLP về mặc định");
  }
  if (resetRag && next.rag != null) {
    delete next.rag;
    changed = true;
    ragChanged = true;
    applied.push("đặt lại RAG về mặc định");
  }

  // 2) Merge input vào phần còn lại — validate TOÀN BỘ trường được cung cấp.
  const sanitized = sanitizeTuningInput(body);
  if (sanitized.errors.length > 0) {
    return NextResponse.json(
      { error: "Giá trị tinh chỉnh không hợp lệ.", fields: sanitized.errors },
      { status: 422 }
    );
  }
  if (sanitized.mlp != null) {
    const merged: Partial<MlpTuning> = { ...next.mlp, ...sanitized.mlp };
    // Chặn lệch độ dài sau merge (gửi activations mà không gửi hidden khớp).
    if (
      merged.hidden != null &&
      merged.activations != null &&
      merged.hidden.length !== merged.activations.length
    ) {
      return NextResponse.json(
        {
          error: "Giá trị tinh chỉnh không hợp lệ.",
          fields: [
            `mlp.activations: phải cùng độ dài với mlp.hidden (${merged.hidden.length} lớp — nhận ${merged.activations.length} activation)`,
          ],
        },
        { status: 422 }
      );
    }
    next.mlp = reconcileMlpSection(merged) as MlTuning["mlp"];
    changed = true;
    applied.push("MLP");
  }
  if (sanitized.rag != null) {
    next.rag = { ...next.rag, ...sanitized.rag } as MlTuning["rag"];
    changed = true;
    ragChanged = true;
    applied.push("RAG");
  }

  if (changed) {
    const ok = await writeMlTuning(next);
    if (!ok) {
      return NextResponse.json(
        { error: "Không ghi được cấu hình vào cơ sở dữ liệu (AppSetting ml-tuning)." },
        { status: 500 }
      );
    }
    await logMlAudit("ML_TUNING_UPDATED", "AppSetting", ML_TUNING_KEY, {
      applied,
      mlp: next.mlp ?? null,
      rag: next.rag ?? null,
      resetMlp,
      resetRag,
    });
    if (ragChanged) resetRagCache(); // corpus/index không giữ tham số cũ
  }

  // 3) Kill-switch GRU (giọng thứ ba) — hiệu lực tức thì qua ensemble.
  if (typeof body.gruEnabled === "boolean") {
    try {
      const cur = await readGruSetting();
      if (cur.enabled !== body.gruEnabled) {
        await writeGruSetting({ ...cur, enabled: body.gruEnabled });
        await logMlAudit("ML_GRU_TOGGLE", "AppSetting", "ml-gru", { enabled: body.gruEnabled });
        applied.push(body.gruEnabled ? "bật giọng thứ ba GRU" : "tắt giọng thứ ba GRU");
      }
    } catch (err) {
      console.error("[api/ml/tuning] gruEnabled lỗi:", err);
      return NextResponse.json(
        { error: "Không đổi được trạng thái GRU (AppSetting ml-gru).", ...buildPayload(next) },
        { status: 500 }
      );
    }
  }

  // 4) Reset vòng học Bandit — 6 arm về prior Beta(1,1), BanditEvent GIỮ NGUYÊN
  //    (truy vết phiếu-dự-đoán + chặn kết toán lại phiếu cũ — §5.6b AUTONOMY v1.3).
  if (body.resetBandit === true) {
    try {
      const res = await db.banditArm.updateMany({
        data: { alpha: 1, beta: 1, pulls: 0, wins: 0, lastRewardAt: null },
      });
      await logMlAudit("ML_BANDIT_RESET", "BanditArm", null, { arms: res.count });
      applied.push(`đặt lại vòng học Bandit (${res.count} arm)`);
    } catch (err) {
      console.error("[api/ml/tuning] resetBandit lỗi:", err);
      return NextResponse.json(
        { error: "Không đặt lại được vòng học Bandit.", ...buildPayload(next) },
        { status: 500 }
      );
    }
  }

  const savedNow = await readMlTuning();
  return NextResponse.json({ ok: true, applied, ...buildPayload(savedNow) });
}
