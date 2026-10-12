/**
 * src/lib/council/allocation-session.ts — HỘI NGHỊ PHÂN BỔ ĐA RỔ (#106
 * COUNCIL_STEWARDSHIP_BLUEPRINT §5.3 — E-ALLOC lớp sinh đề xuất).
 *
 * Chủ tịch (portfolio-strategist A1) họp 1 lần/tuần (engine CN 05:50 ICT,
 * sau chuỗi học Chủ nhật 05:00–05:40) hoặc chạy tay qua POST
 * /api/council/allocation-session. Đọc: thống kê 5 rổ 30 phiên · kết quả các
 * thí nghiệm trước (đang chạy + 3 bản đóng gần nhất kèm bài học) · khối tầm
 * nhìn tài khoản C-VISION → tự viết {reflection, lessons[], proposal,
 * narrative} theo JSON hợp đồng.
 *
 * Parse fail-soft kiểu k4.ts (F-K4-01: match MỌI fenced JSON block, không
 * chỉ khối đầu): proposal sai trọng số → vẫn giữ reflection/narrative, ghi
 * parseFail trung thực (pattern AppSetting counter của exec/allocation.ts).
 * Đề xuất hợp lệ → createExperiment(createdBy:"council") + broadcast
 * AgentMessage vào "Luồng thảo luận giữa các agents" — hội đồng tự nói chuyện
 * về việc mình đề xuất. KHÔNG đặt lệnh — thí nghiệm là danh mục giấy riêng.
 */

import { db } from "@/lib/db";
import { callLlmWithRetry, currentModelId } from "@/lib/llm";
import { ROLE_PROMPTS } from "@/lib/agent-context";
import { basketStatsCached, BASKET_KEYS } from "@/lib/council/baskets";
import { buildCouncilVisionBlock } from "@/lib/council/vision";
import { createExperiment } from "@/lib/council/experiments";

export interface CouncilSessionResult {
  ok: boolean;
  created: boolean;
  experimentId?: string;
  experimentName?: string;
  weights?: Array<{ basket: string; weight: number }>;
  reflection?: string;
  narrative?: string;
  lessonsUpdated: number;
  parseFail?: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
}

interface CouncilProposalJson {
  reflection?: string;
  lessons?: Array<{ name?: string; lesson?: string }>;
  proposal?: {
    name?: string;
    hypothesis?: string;
    horizonDays?: number;
    weights?: Array<{ basket?: string; weight?: number }>;
  };
  narrative?: string;
}

/** Trích MỌI fenced JSON block rồi JSON.parse từng khối (F-K4-01 pattern). */
function extractJsonBlocks(text: string): unknown[] {
  const out: unknown[] = [];
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (const m of fenced) {
    const body = m[1].trim();
    try {
      out.push(JSON.parse(body));
    } catch {
      // khối hỏng — thử khối kế
    }
  }
  if (out.length === 0) {
    // fallback: khối { ... } trần đầu tiên (balanced-brace thô)
    const start = text.indexOf("{");
    if (start >= 0) {
      let depth = 0;
      for (let i = start; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") {
          depth--;
          if (depth === 0) {
            try {
              out.push(JSON.parse(text.slice(start, i + 1)));
            } catch {
              // bỏ
            }
            break;
          }
        }
      }
    }
  }
  return out;
}

function fmtPct(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const s = Math.abs(n).toFixed(2).replace(".", ",");
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${s}%`;
}

/** Biểu diễn gọn weightsJson cho prompt/summary. */
function weightsSummary(json: string): string {
  try {
    const arr = JSON.parse(json) as Array<{ basket: string; weight: number }>;
    return arr
      .filter((w) => w.weight > 0)
      .map((w) => `${w.basket} ${w.weight}%`)
      .join(" · ");
  } catch {
    return "?";
  }
}

export async function runCouncilAllocationSession(): Promise<CouncilSessionResult> {
  const startedAt = Date.now();

  // ── Dữ liệu cho hội nghị ──
  const [stats, vision, running, done, chairman] = await Promise.all([
    basketStatsCached(),
    buildCouncilVisionBlock().catch(() => null),
    db.allocationExperiment.findMany({
      where: { status: "RUNNING" },
      orderBy: { startedAt: "desc" },
      take: 3,
      include: { snapshots: { orderBy: { date: "desc" }, take: 1 } },
    }),
    db.allocationExperiment.findMany({
      where: { status: "DONE" },
      orderBy: { endedAt: "desc" },
      take: 3,
    }),
    db.agent.findUnique({ where: { code: "portfolio-strategist" } }),
  ]);

  const basketTable = stats
    .map(
      (s) =>
        `- ${s.key} (${s.short}): ${s.members.length} thành viên · độ phủ ${s.coverageDays} phiên` +
        ` · 1 phiên ${fmtPct(s.ret1d)} · 5 phiên ${fmtPct(s.ret5d)} · 30 phiên ${fmtPct(s.ret30d)}` +
        ` · vol 30 phiên ${s.vol30d != null ? s.vol30d.toFixed(2).replace(".", ",") + "%" : "—"}` +
        ` · tốt/xấu nhất ${fmtPct(s.bestDay)}/${fmtPct(s.worstDay)}`
    )
    .join("\n");

  const runningBlock = running.length
    ? running
        .map(
          (e) =>
            `- ĐANG CHẠY "${e.name}" [${weightsSummary(e.weightsJson)}] vốn ` +
            `${(Number(e.capitalVND) / 1_000_000).toFixed(0)} tr ₫ · ${e.snapshots.length ? `tới nay ${fmtPct(e.snapshots[0].returnPct)}` : "chưa có snapshot"}` +
            ` · giả thuyết: ${e.hypothesis.slice(0, 140)}`
        )
        .join("\n")
    : "(chưa có thí nghiệm đang chạy)";

  const doneBlock = done.length
    ? done
        .map(
          (e) =>
            `- ĐÃ ĐÓNG "${e.name}" [${weightsSummary(e.weightsJson)}] · kết quả ${fmtPct(e.returnPct)}` +
            ` · maxDD ${e.maxDrawdownPct != null ? e.maxDrawdownPct.toFixed(2).replace(".", ",") + "%" : "—"}` +
            ` · Sharpe ${e.sharpe ?? "—"}` +
            (e.lesson ? ` · bài học cũ: ${e.lesson.slice(0, 120)}` : " · CHƯA có bài học")
        )
        .join("\n")
    : "(chưa có thí nghiệm nào đóng — kỳ này là lần đầu hệ thống học)";

  const sys =
    ROLE_PROMPTS["portfolio-strategist"].system +
    "\n\n" +
    "NHIỆM VỤ PHIÊN NÀY — HỘI NGHỊ PHÂN BỔ ĐA RỔ (khác nhiệm vụ tín hiệu thông thường): " +
    "bạn họp với tư cách Chủ tịch Hội đồng Nghiên cứu, quyết định PHÂN BỔ vốn thử nghiệm " +
    "giữa 5 rổ thị trường: " +
    BASKET_KEYS.join(" · ") +
    ". Hệ thống KHÔNG quy định tỷ trọng — đó là việc của Hội đồng. Đọc số liệu 5 rổ, " +
    "kết quả các thí nghiệm trước (nếu có), tài khoản sandbox hiện tại, rồi tự quyết định. " +
    "Trả lời DUY NHẤT bằng 1 khối JSON (```json ... ```) có dạng: " +
    '{"reflection": "2-4 câu nhìn lại kết quả thí nghiệm trước / bối cảnh", ' +
    '"lessons": [{"name": "tên thí nghiệm đã đóng", "lesson": "bài học 1-2 câu"}], ' +
    '"proposal": {"name": "tên thí nghiệm mới (3-40 ký tự)", "hypothesis": "giả thuyết 15-120 ký tự", ' +
    '"horizonDays": 30, "weights": [{"basket": "VN_EQUITY", "weight": 40}, ...]}, ' +
    '"narrative": "3-5 câu tiếng Việt giải thích lựa chọn phân bổ"}\n' +
    "Quy tắc: weights tổng 95-105, mỗi rổ ∈ [0,100]; lessons CHỈ cho các thí nghiệm ĐÃ ĐÓNG " +
    "trong danh sách (viết lại bài học nếu đã có); proposal là 1 thí nghiệm MỚI duy nhất; " +
    "KHÔNG bịa số liệu ngoài bảng; trung thực khi rổ thiếu dữ liệu (độ phủ phiên ghi rõ).";

  const user =
    `THỐNG KÊ 5 RỔ THỊ TRƯỜNG (30 phiên gần nhất):\n${basketTable}\n\n` +
    `THÍ NGHIỆM PHÂN BỔ:\n${runningBlock}\n${doneBlock}\n\n` +
    (vision ? `${vision}\n\n` : "") +
    "Hãy quyết định phân bổ và trả về khối JSON theo hợp đồng trên.";

  const model = await currentModelId();
  const res = await callLlmWithRetry(sys, user);
  const raw = res.raw.trim();
  if (!raw) {
    throw new Error("LLM trả câu trả lời rỗng.");
  }

  // ── Parse + thực thi (fail-soft từng phần) ──
  const blocks = extractJsonBlocks(raw);
  let parsed: CouncilProposalJson | null = null;
  for (const b of blocks) {
    if (b && typeof b === "object" && ("proposal" in b || "reflection" in b)) {
      parsed = b as CouncilProposalJson;
      break;
    }
  }

  let lessonsUpdated = 0;
  let created = false;
  let experimentId: string | undefined;
  let experimentName: string | undefined;
  let weights: Array<{ basket: string; weight: number }> | undefined;
  let parseFail: string | undefined;

  if (!parsed) {
    parseFail = "không tìm thấy khối JSON hợp lệ trong câu trả lời LLM";
  } else {
    // 1) Bài học cho thí nghiệm đã đóng (match theo tên)
    if (Array.isArray(parsed.lessons)) {
      for (const l of parsed.lessons) {
        const name = typeof l?.name === "string" ? l.name.trim() : "";
        const lesson = typeof l?.lesson === "string" ? l.lesson.trim() : "";
        if (!name || lesson.length < 5) continue;
        await db.allocationExperiment.updateMany({
          where: { status: "DONE", name },
          data: { lesson: lesson.slice(0, 600) },
        });
        lessonsUpdated++;
      }
    }
    // 2) Tạo thí nghiệm mới từ proposal
    const p = parsed.proposal;
    if (p && Array.isArray(p.weights) && p.weights.length > 0) {
      const result = await createExperiment({
        name: String(p.name ?? "").slice(0, 120),
        hypothesis: String(p.hypothesis ?? "").slice(0, 600),
        weights: p.weights.map((w) => ({
          basket: String(w?.basket ?? ""),
          weight: Number(w?.weight ?? 0),
        })),
        capitalVND: 100_000_000, // vốn chuẩn 100 tr ₫ — tham số hoá sau qua UI
        horizonDays: Number(p.horizonDays ?? 30),
        createdBy: "council",
      });
      if (result.ok && result.experiment) {
        created = true;
        experimentId = result.experiment.id;
        experimentName = result.experiment.name;
        weights = JSON.parse(result.experiment.weightsJson) as Array<{
          basket: string;
          weight: number;
        }>;
      } else if (result.error) {
        parseFail = `proposal không hợp lệ: ${result.error}`;
      }
    } else if (!parsed.reflection) {
      parseFail = "JSON không có proposal và không có reflection";
    }
  }

  // ── Broadcast vào "Luồng thảo luận giữa các agents" ──
  if (chairman) {
    const summaryParts: string[] = [];
    if (parsed?.reflection) summaryParts.push(`Nhìn lại: ${parsed.reflection}`);
    if (created && experimentName && weights) {
      summaryParts.push(
        `ĐỀ XUẤT THÍ NGHIỆM MỚI "${experimentName}": ${weights
          .map((w) => `${w.basket} ${w.weight}%`)
          .join(" · ")}`
      );
    }
    if (parsed?.narrative) summaryParts.push(parsed.narrative);
    if (summaryParts.length > 0) {
      await db.agentMessage.create({
        data: {
          fromAgentId: chairman.id,
          broadcast: true,
          direction: "AGENT",
          content: `[Hội nghị phân bổ đa rổ] ${summaryParts.join("\n")}`.slice(0, 2000),
        },
      });
    }
  }

  return {
    ok: true,
    created,
    experimentId,
    experimentName,
    weights,
    reflection: parsed?.reflection,
    narrative: parsed?.narrative,
    lessonsUpdated,
    parseFail,
    model,
    tokensIn: res.tokensIn,
    tokensOut: res.tokensOut,
    durationMs: Date.now() - startedAt,
  };
}
