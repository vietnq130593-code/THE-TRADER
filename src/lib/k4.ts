/**
 * src/lib/k4.ts — K4 "Ban Điều hành giao việc" (AUTONOMY_BLUEPRINT v1.1 §7).
 *
 * Cơ chế "Chủ tịch giao việc" (1 nguồn giao việc — đo được, chịu trách nhiệm
 * được):
 *   - AI GIAO: duy nhất Chủ tịch portfolio-strategist, TRONG chu kỳ 23 agents
 *     (prompt được bổ sung khối "GIAO VIỆC" CHỈ khi k4.enabled — 0 token khi
 *     tắt, đúng §7.2).
 *   - GIAO CHO AI: agents nhóm research/control/platform/ml — CẤM executive
 *     (chống vòng lặp tự giao; đồ thị nhiệm vụ 2 cấp, không đệ quy).
 *   - KILL-SWITCH 2 NHÀ: tắt k4 → prompt biến mất + nhiệm vụ cũ VẪN chạy đúng
 *     lịch K3 (trader tự xoá nếu muốn — không tự huỷ việc đang treo).
 *
 * Hợp đồng dữ liệu AppSetting key "k4" (JSON — pattern k-run/k-sandbox):
 *   { enabled, maxOpenTasksPerAgent (1..10, mặc định 3),
 *     maxTasksPerCycle (1..10, mặc định 5) }
 *
 * Phân lớp trong file (route chỉ gọi — logic thuần dễ verify):
 *   1. AppSetting: parseK4 / getK4 / setK4 — fail-soft mọi nơi.
 *   2. Prompt: buildK4ChairmanPromptBlock() — thuần từ AGENT_ROSTER.
 *   3. Parse: extractAssignTasks(raw) — trích mảng assignTasks từ output
 *      LLM (fenced ```json, JSON object, hoặc bracket-match quanh khoá) —
 *      JSON rác → null (fail-soft tuyệt đối, chu kỳ vẫn COMPLETED).
 *   4. Validate: validateAssignTasks() — THUẦN, không DB (verify script
 *      kiểm trực tiếp): agentCode tồn tại + nhóm cho phép · độ dài · schedule
 *      qua parser chung · +4h tối thiểu · maxOpenTasksPerAgent ·
 *      maxTasksPerCycle. Mọi vi phạm → BỎ nhiệm vụ đó + lý do (không crash).
 *   5. DB: assignChairmanTasks() — đọc agents + đếm task treo, chạy lớp 3+4,
 *      tạo AgentTask (createdByAgentId = Chủ tịch) + AuditLog K4_TASK_ASSIGNED.
 */

import { db } from "@/lib/db";
import { AGENT_ROSTER } from "@/lib/agent-roster";
import { computeNextDueAt, parseScheduleGrammar } from "@/lib/schedule";

/* ─────────────────────── Hằng số §7.1/§7.2 ─────────────────────── */

export const K4_KEY = "k4";
export const K4_DEFAULT_MAX_OPEN_PER_AGENT = 3;
export const K4_DEFAULT_MAX_PER_CYCLE = 5;
/** Giới hạn cấu hình 1..10 (nguyên) — POST /api/k4 validate. */
export const K4_LIMIT_MIN = 1;
export const K4_LIMIT_MAX = 10;
/** Lịch giao tối thiểu +4h từ giờ giao (không chồng chu kỳ đang chạy). */
export const K4_MIN_LEAD_MS = 4 * 3_600_000;
export const K4_TITLE_MAX = 120;
export const K4_DESCRIPTION_MAX = 600;

/** Nhóm được nhận việc — MỌI nhóm trừ executive (quy tắc 2 cấp không đệ quy). */
export const K4_ALLOWED_GROUPS: readonly string[] = ["research", "control", "platform", "ml"];

/* ─────────────────────── 1. AppSetting k4 ─────────────────────── */

export interface K4Stored {
  enabled: boolean;
  maxOpenTasksPerAgent: number;
  maxTasksPerCycle: number;
}

export function defaultK4(): K4Stored {
  return {
    enabled: false,
    maxOpenTasksPerAgent: K4_DEFAULT_MAX_OPEN_PER_AGENT,
    maxTasksPerCycle: K4_DEFAULT_MAX_PER_CYCLE,
  };
}

/** Parse khoan dung chuỗi JSON AppSetting → K4Stored (sai kiểu → mặc định). */
export function parseK4(raw: string | null | undefined): K4Stored {
  if (!raw) return defaultK4();
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return defaultK4();
    const d = defaultK4();
    const limit = (v: unknown, fb: number) =>
      typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) &&
      v >= K4_LIMIT_MIN && v <= K4_LIMIT_MAX
        ? v
        : fb;
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : d.enabled,
      maxOpenTasksPerAgent: limit(parsed.maxOpenTasksPerAgent, d.maxOpenTasksPerAgent),
      maxTasksPerCycle: limit(parsed.maxTasksPerCycle, d.maxTasksPerCycle),
    };
  } catch {
    return defaultK4();
  }
}

/** Đọc k4 — lỗi DB → mặc định an toàn (enabled:false), KHÔNG ném. */
export async function getK4(): Promise<K4Stored> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: K4_KEY } });
    return parseK4(row?.value ?? null);
  } catch (err) {
    console.error(`[lib/k4] đọc AppSetting "${K4_KEY}" thất bại:`, err);
    return defaultK4();
  }
}

/** Ghi k4 (upsert) — trả state SAU ghi, hoặc state đọc được nếu ghi fail. */
export async function setK4(patch: Partial<K4Stored>): Promise<K4Stored> {
  const current = await getK4();
  const next: K4Stored = { ...current, ...patch };
  try {
    await db.appSetting.upsert({
      where: { key: K4_KEY },
      create: { key: K4_KEY, value: JSON.stringify(next) },
      update: { value: JSON.stringify(next) },
    });
    return next;
  } catch (err) {
    console.error(`[lib/k4] ghi AppSetting "${K4_KEY}" thất bại:`, err);
    return current;
  }
}

/** Số nguyên 1..10 hợp lệ cho input giới hạn — null khi sai. */
export function sanitizeK4Limit(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) return null;
  if (v < K4_LIMIT_MIN || v > K4_LIMIT_MAX) return null;
  return v;
}

/* ─────────────────────── 2. Prompt khối GIAO VIỆC ─────────────────────── */

/**
 * Khối prompt tiêm vào user-prompt Chủ tịch (SAU RAG block — §7.1), CHỈ khi
 * k4.enabled (0 token khi tắt). Thuần từ AGENT_ROSTER — không DB, không side
 * -effect. Liệt kê agents nhận việc kèm code + chức danh để Chủ tịch trích
 * agentCode chính xác.
 */
export function buildK4ChairmanPromptBlock(
  k4: K4Stored = defaultK4()
): string {
  const eligible = AGENT_ROSTER.filter((a) => K4_ALLOWED_GROUPS.includes(a.group));
  const lines = eligible.map((a) => `- ${a.code} (${a.gen1} · ${a.group}) — ${a.title}`);
  return [
    "GIAO VIỆC CHO ĐỘI (K4 — BAN ĐIỀU HÀNH GIAO VIỆC):",
    `Ngoài tín hiệu, bạn được giao việc cho agents ngoài Ban Điều hành (tối đa ${k4.maxOpenTasksPerAgent} nhiệm vụ đang treo mỗi agent, ${k4.maxTasksPerCycle} nhiệm vụ mỗi chu kỳ).`,
    "Quy tắc bắt buộc:",
    "- CHỈ giao cho agents trong danh sách dưới đây — KHÔNG giao cho nhóm Ban Điều hành (tự giao việc là cấm).",
    "- Nhiệm vụ là công việc thật (phân tích/kiểm tra/báo cáo/theo dõi) — KHÔNG giao 'nhiệm vụ tạo nhiệm vụ'.",
    `- Lịch tối thiểu 4 giờ từ bây giờ: "HH:MM" hằng ngày hoặc "MON:HH:MM" hằng tuần; bỏ trống/null = nhiệm vụ một lần.`,
    "- Chỉ giao khi thực sự cần thiết — không giao cũng được (mảng rỗng).",
    "Agents nhận việc:",
    ...lines,
    "",
    "Cuối phản hồi, kèm khối JSON (ngoài JSON tín hiệu đã có):",
    '{"assignTasks":[{"agentCode":"liquidity","title":"≤120 ký tự","description":"≤600 ký tự","schedule":"14:00","priority":"medium"}]}',
    'Không giao việc nào → {"assignTasks":[]}.',
  ].join("\n");
}

/* ─────────────────────── 3. Parse output Chủ tịch ─────────────────────── */

/**
 * Trích mảng "assignTasks" từ output thô của Chủ tịch — trả mảng mục (chưa
 * validate) hoặc null khi: không có khoá "assignTasks" (Chủ tịch không giao)
 * hoặc JSON rác đến mức không tách được mảng. Fail-soft tuyệt đối: hàm không
 * ném, chu kỳ vẫn COMPLETED bất kể output thế nào.
 *
 * 3 tầng thử (tăng dần khoan dung): (a) JSON object fenced/toàn văn có khoá
 * assignTasks; (b) bracket-match mảng ngay sau khoá "assignTasks" kể cả khi
 * JSON tổng rác; (c) null.
 */
export function extractAssignTasks(raw: string): unknown[] | null {
  if (!raw || !raw.includes("assignTasks")) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : raw).trim();

  // (a) JSON object hợp lệ chứa khoá assignTasks
  const brace = candidate.match(/\{[\s\S]*\}/);
  if (brace) {
    try {
      const obj = JSON.parse(brace[0]) as Record<string, unknown>;
      if (obj && typeof obj === "object" && "assignTasks" in obj) {
        const arr = obj.assignTasks;
        return Array.isArray(arr) ? arr : null;
      }
    } catch {
      // JSON tổng rác — thử tầng (b)
    }
  }

  // (b) Bracket-match mảng sau khoá — chịu được narrative lẫn lộn quanh JSON
  const idx = candidate.indexOf("assignTasks");
  const open = candidate.indexOf("[", idx);
  if (open === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        try {
          const arr = JSON.parse(candidate.slice(open, i + 1)) as unknown;
          return Array.isArray(arr) ? arr : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/* ─────────────────────── 4. Validate THUẦN ─────────────────────── */

/** Agent tối thiểu cho validate — route/verify nạp từ DB hoặc dữ liệu test. */
export interface K4AgentInfo {
  id: string;
  code: string;
  name: string;
  group: string;
}

/** Nhiệm vụ đã qua validate — đủ dữ liệu tạo AgentTask. */
export interface K4ValidatedTask {
  agentId: string;
  agentCode: string;
  title: string;
  description: string | null;
  schedule: string | null;
  priority: "low" | "medium" | "high";
  nextDueAt: Date | null;
}

export interface K4SkipReason {
  agentCode: string | null;
  reason: string;
}

export interface K4ValidateContext {
  /** Agents hiện có trong hệ thống (khóa theo code). */
  agentsByCode: Map<string, K4AgentInfo>;
  /** Số nhiệm vụ đang treo (PENDING) theo agent code. */
  openTaskCountByCode: Map<string, number>;
  /** Giờ giao (mốc +4h và tính nextDueAt). */
  now: Date;
  k4: K4Stored;
}

export interface K4ValidateResult {
  valid: K4ValidatedTask[];
  skipped: K4SkipReason[];
}

/**
 * Validate TỪNG nhiệm vụ propuestas của Chủ tịch — THUẦN, không DB, không
 * ném. Mọi vi phạm → bỏ nhiệm vụ + lý do (KHÔNG crash chu kỳ):
 *   agentCode tồn tại · nhóm ∈ research/control/platform/ml (cấm executive)
 *   · title 1..120 · description ≤600 · schedule qua parser chung + ≥ +4h
 *   · priority ∈ low|medium|high (thiếu → medium) · maxOpenTasksPerAgent
 *   · maxTasksPerCycle.
 */
export function validateAssignTasks(
  items: unknown[],
  ctx: K4ValidateContext
): K4ValidateResult {
  const valid: K4ValidatedTask[] = [];
  const skipped: K4SkipReason[] = [];
  const createdPerAgent = new Map<string, number>();

  for (const item of items.slice(0, 50)) {
    const tag = (): string | null => {
      if (item && typeof item === "object" && "agentCode" in item) {
        const v = (item as Record<string, unknown>).agentCode;
        return typeof v === "string" ? v : null;
      }
      return null;
    };

    if (!item || typeof item !== "object" || Array.isArray(item)) {
      skipped.push({ agentCode: null, reason: "mục không phải object" });
      continue;
    }
    const t = item as Record<string, unknown>;

    // maxTasksPerCycle — chặn TRƯỚC khi tạo thêm (đếm cả batch này)
    if (valid.length >= ctx.k4.maxTasksPerCycle) {
      skipped.push({ agentCode: tag(), reason: `vượt maxTasksPerCycle (${ctx.k4.maxTasksPerCycle})` });
      continue;
    }

    // agentCode + nhóm
    const agentCode = typeof t.agentCode === "string" ? t.agentCode.trim() : "";
    if (!agentCode) {
      skipped.push({ agentCode: null, reason: "thiếu agentCode" });
      continue;
    }
    const agent = ctx.agentsByCode.get(agentCode);
    if (!agent) {
      skipped.push({ agentCode, reason: `agent "${agentCode}" không tồn tại` });
      continue;
    }
    if (!K4_ALLOWED_GROUPS.includes(agent.group)) {
      skipped.push({ agentCode, reason: `nhóm "${agent.group}" không nhận việc (cấm executive — quy tắc 2 cấp)` });
      continue;
    }

    // title
    const title = typeof t.title === "string" ? t.title.trim() : "";
    if (!title || title.length > K4_TITLE_MAX) {
      skipped.push({ agentCode, reason: `title phải 1..${K4_TITLE_MAX} ký tự` });
      continue;
    }

    // description
    let description: string | null = null;
    if (t.description != null) {
      if (typeof t.description !== "string") {
        skipped.push({ agentCode, reason: "description phải là chuỗi" });
        continue;
      }
      description = t.description.trim() || null;
      if (description && description.length > K4_DESCRIPTION_MAX) {
        skipped.push({ agentCode, reason: `description dài quá ${K4_DESCRIPTION_MAX} ký tự` });
        continue;
      }
    }

    // schedule + tối thiểu +4h
    let schedule: string | null = null;
    let nextDueAt: Date | null = null;
    if (t.schedule != null && t.schedule !== "") {
      if (typeof t.schedule !== "string" || !parseScheduleGrammar(t.schedule)) {
        skipped.push({ agentCode, reason: `schedule "${String(t.schedule)}" không đúng grammar HH:MM / DOW:HH:MM` });
        continue;
      }
      schedule = t.schedule.trim();
      nextDueAt = computeNextDueAt(schedule, ctx.now);
      if (nextDueAt.getTime() < ctx.now.getTime() + K4_MIN_LEAD_MS) {
        skipped.push({ agentCode, reason: `lịch ${schedule} sớm hơn +4h từ giờ giao` });
        continue;
      }
    }

    // priority (thiếu → medium; sai kiểu → bỏ)
    let priority: "low" | "medium" | "high" = "medium";
    if (t.priority != null && t.priority !== "") {
      if (t.priority !== "low" && t.priority !== "medium" && t.priority !== "high") {
        skipped.push({ agentCode, reason: `priority "${String(t.priority)}" không hợp lệ` });
        continue;
      }
      priority = t.priority;
    }

    // maxOpenTasksPerAgent — đếm task đang treo + đã tạo trong batch này
    const open = (ctx.openTaskCountByCode.get(agentCode) ?? 0) + (createdPerAgent.get(agentCode) ?? 0);
    if (open + 1 > ctx.k4.maxOpenTasksPerAgent) {
      skipped.push({ agentCode, reason: `agent đã có ${open} nhiệm vụ treo (max ${ctx.k4.maxOpenTasksPerAgent})` });
      continue;
    }

    createdPerAgent.set(agentCode, (createdPerAgent.get(agentCode) ?? 0) + 1);
    valid.push({ agentId: agent.id, agentCode, title, description, schedule, priority, nextDueAt });
  }
  return { valid, skipped };
}

/* ─────────────────────── 5. DB: giao việc từ output Chủ tịch ─────────────────────── */

export interface AssignChairmanTasksOptions {
  /** Agent id của Chủ tịch (portfolio-strategist) —CreatedByAgentId. */
  chairmanAgentId: string;
  /** Cấu hình k4 hiệu lực (route đọc 1 lần rồi truyền vào — verify inject test). */
  k4: K4Stored;
  /** Giờ giao — mặc định now (verify script inject để test +4h). */
  now?: Date;
}

export interface AssignChairmanTasksResult {
  /** Số mục parse được từ output (trước validate). */
  parsedCount: number;
  created: { taskId: string; agentCode: string; title: string; schedule: string | null }[];
  skipped: K4SkipReason[];
}

/**
 * Điểm ghép duy nhất của K4 trong chu kỳ 23 agents: nhận output THÔ của Chủ
 * tịch → parse (fail-soft: JSON rác → 0 nhiệm vụ) → validate từng mục → tạo
 * AgentTask createdByAgentId = Chủ tịch + AuditLog K4_TASK_ASSIGNED.
 *
 * TUYỆT ĐỐI fail-soft: mọi lỗi (DB, parse, validate) chỉ log/console.error —
 * KHÔNG ném, KHÔNG làm hỏng chu kỳ (JSON rác là dữ liệu đầu vào phải chịu
 * được — §7.1). Lý do bỏ từng nhiệm vụ được trả về để route ghi audit minh bạch.
 */
export async function assignChairmanTasks(
  raw: string,
  opts: AssignChairmanTasksOptions
): Promise<AssignChairmanTasksResult> {
  const now = opts.now ?? new Date();
  const empty: AssignChairmanTasksResult = { parsedCount: 0, created: [], skipped: [] };
  try {
    const items = extractAssignTasks(raw);
    if (items == null || items.length === 0) {
      return { ...empty, parsedCount: items?.length ?? 0 };
    }

    const [agents, openGroups] = await Promise.all([
      db.agent.findMany({
        select: { id: true, code: true, name: true, group: true },
      }),
      db.agentTask.groupBy({
        by: ["agentId"],
        where: { status: "PENDING" },
        _count: { _all: true },
      }),
    ]);
    const agentsByCode = new Map(agents.map((a) => [a.code, a]));
    const idToCode = new Map(agents.map((a) => [a.id, a.code]));
    const openTaskCountByCode = new Map<string, number>();
    for (const g of openGroups) {
      const code = idToCode.get(g.agentId);
      if (code) openTaskCountByCode.set(code, g._count._all);
    }

    const { valid, skipped } = validateAssignTasks(items, {
      agentsByCode,
      openTaskCountByCode,
      now,
      k4: opts.k4,
    });

    const created: AssignChairmanTasksResult["created"] = [];
    for (const v of valid) {
      const task = await db.agentTask.create({
        data: {
          agentId: v.agentId,
          title: v.title,
          description: v.description,
          priority: v.priority,
          status: "PENDING",
          schedule: v.schedule,
          nextDueAt: v.nextDueAt,
          createdByAgentId: opts.chairmanAgentId,
        },
      });
      created.push({
        taskId: task.id,
        agentCode: v.agentCode,
        title: v.title,
        schedule: v.schedule,
      });
      await db.auditLog
        .create({
          data: {
            action: "K4_TASK_ASSIGNED",
            entity: "AgentTask",
            entityId: task.id,
            after: JSON.stringify({
              agentCode: v.agentCode,
              title: v.title,
              schedule: v.schedule,
              priority: v.priority,
              cycleAt: now.toISOString(),
            }),
          },
        })
        .catch((err) => console.error("[lib/k4] audit K4_TASK_ASSIGNED:", err));
      console.log(
        `[lib/k4] Chủ tịch giao việc: ${v.agentCode} — "${v.title}"${v.schedule ? ` (${v.schedule})` : " (một lần)"}`
      );
    }
    for (const s of skipped) {
      console.log(`[lib/k4] bỏ nhiệm vụ Chủ tịch giao (${s.agentCode ?? "?"}): ${s.reason}`);
    }
    return { parsedCount: items.length, created, skipped };
  } catch (err) {
    // Fail-soft tuyệt đối — chu kỳ vẫn COMPLETED
    console.error("[lib/k4] assignChairmanTasks fail-soft:", err);
    return { ...empty, skipped: [{ agentCode: null, reason: "loi-noi-bo (fail-soft)" }] };
  }
}
