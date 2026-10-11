/**
 * src/lib/k-run.ts — K2 "Chế độ chạy liên tục" (AUTONOMY_BLUEPRINT v1.1 §4).
 *
 * Nguồn sự thật điều khiển nhịp chu kỳ 23 agents, theo quyết định trader
 * §8-Q7 (K2 = bậc 1 triển khai #86):
 *
 *   AppSetting key "k-run" (JSON)  ── CHƯA TỪNG TẠO  ──►  env AGENT_CYCLE_MINUTES
 *                                    hiệu lực như hiện tại (mặc định hậu phương,
 *                                    đúng cam kết §8 ML_OPS v1.1: "env thành
 *                                    mặc định hậu phương")
 *                            └─────  ĐÃ TỒN TẠI (kể cả enabled=false)  ──►
 *                                    AppSetting THẮNG TUYỆT ĐỐI — engine đọc
 *                                    state này mỗi tick 60s và nhường quyền
 *                                    env interval (flag kRunKeyExists).
 *
 * Hợp đồng dữ liệu (blueprint §4.1):
 *   { enabled, intervalMinutes, startedAt, lastCycleAt, cyclesRun }
 *
 * - `lastCycleAt` do POST /api/agents/run ghi sau MỖI chu kỳ (kể cả chạy tay
 *   qua nút Header) — markKRunCycle() fail-soft, KHÔNG bao giờ làm hỏng chu
 *   kỳ vì lỗi DB phụ trợ. Key chưa tồn tại → no-op (chế độ env nguyên vẹn).
 * - `nextCycleAt` = max(lastCycleAt ?? startedAt ?? now, startedAt ?? 0)
 *   + intervalMinutes — engine chỉ POST chu kỳ khi now ≥ nextCycleAt.
 *
 * Fail-soft mọi hàm (pattern lib/settings.ts): lỗi DB → console.error +
 * giá trị mặc định an toàn, không ném ra caller.
 */

import { db } from "@/lib/db";

/** Bộ nhịp cho phép (§8-Q4 duyệt) — chặn quota free-tier Zen khỏi 429. */
export const K_RUN_INTERVALS = [60, 120, 240, 480] as const;
export type KRunInterval = (typeof K_RUN_INTERVALS)[number];

const K_RUN_KEY = "k-run";
const DEFAULT_INTERVAL: KRunInterval = 240;

export interface KRunStored {
  enabled: boolean;
  intervalMinutes: KRunInterval;
  startedAt: string | null;
  lastCycleAt: string | null;
  cyclesRun: number;
}

export function isKRunInterval(v: unknown): v is KRunInterval {
  return (
    typeof v === "number" &&
    (K_RUN_INTERVALS as readonly number[]).includes(v)
  );
}

/** Giá trị mặc định khi key chưa tồn tại / JSON hỏng (fail-soft). */
function defaultKRun(): KRunStored {
  return {
    enabled: false,
    intervalMinutes: DEFAULT_INTERVAL,
    startedAt: null,
    lastCycleAt: null,
    cyclesRun: 0,
  };
}

/** Parse khoan dung chuỗi JSON AppSetting → KRunStored (mọi field sai kiểu
 * đều rơi về mặc định an toàn — nguyên tắc "assertion phải được kiểm"). */
export function parseKRun(raw: string | null | undefined): KRunStored {
  if (!raw) return defaultKRun();
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return defaultKRun();
    const d = defaultKRun();
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : d.enabled,
      intervalMinutes: isKRunInterval(parsed.intervalMinutes)
        ? parsed.intervalMinutes
        : d.intervalMinutes,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : null,
      lastCycleAt: typeof parsed.lastCycleAt === "string" ? parsed.lastCycleAt : null,
      cyclesRun:
        typeof parsed.cyclesRun === "number" && Number.isFinite(parsed.cyclesRun) && parsed.cyclesRun >= 0
          ? Math.floor(parsed.cyclesRun)
          : 0,
    };
  } catch {
    return defaultKRun();
  }
}

/** Đọc key k-run thô — trả null khi chưa từng tạo (chế độ env fallback). */
async function readKRunRow(): Promise<string | null> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: K_RUN_KEY } });
    return row?.value ?? null;
  } catch (err) {
    console.error("[lib/k-run] đọc AppSetting \"k-run\" thất bại:", err);
    return null;
  }
}

async function writeKRun(value: KRunStored): Promise<boolean> {
  try {
    const json = JSON.stringify(value);
    await db.appSetting.upsert({
      where: { key: K_RUN_KEY },
      create: { key: K_RUN_KEY, value: json },
      update: { value: json },
    });
    return true;
  } catch (err) {
    console.error("[lib/k-run] ghi AppSetting \"k-run\" thất bại:", err);
    return false;
  }
}

/** nextCycleAt = max(lastCycleAt, startedAt, [khi cả hai null: now]) + nhịp.
 *  Gốc "kể từ chu kỳ gần nhất" khiến việc bấm tay chu kỳ trước khi bật cũng
 *  dịch mốc due kế tiếp — đúng blueprint §4.3 (mỗi chu kỳ kéo nextCycleAt). */
export function computeNextCycleAt(s: KRunStored, nowMs = Date.now()): number {
  const anchors: number[] = [];
  if (s.lastCycleAt) {
    const t = Date.parse(s.lastCycleAt);
    if (Number.isFinite(t)) anchors.push(t);
  }
  if (s.startedAt) {
    const t = Date.parse(s.startedAt);
    if (Number.isFinite(t)) anchors.push(t);
  }
  const base = anchors.length > 0 ? Math.max(...anchors) : nowMs;
  return base + s.intervalMinutes * 60_000;
}

/** Bật chế độ liên tục — giữ lastCycleAt/cyclesRun cũ nếu có (blueprint
 *  §4.2: start KHÔNG reset mốc; enabled bật lại sau stop tính nhịp từ mốc
 *  gần nhất). Trả state sau ghi (hoặc state đọc được nếu ghi fail). */
export async function startKRun(
  intervalMinutes: KRunInterval
): Promise<KRunStored> {
  const current = parseKRun(await readKRunRow());
  const next: KRunStored = {
    ...current,
    enabled: true,
    intervalMinutes,
    startedAt: new Date().toISOString(),
  };
  await writeKRun(next);
  return next;
}

/** Tắt — tạo key enabled:false kể cả khi chưa từng tồn tại (blueprint §4.2:
 *  "Tắt khi key chưa từng tạo vẫn tạo key" → AppSetting thắng tuyệt đối →
 *  env interval nhường quyền → chu kỳ dừng hẳn — đúng "chỉ ngừng khi trader
 *  tự tay bấm tắt"). Giữ nguyên intervalMinutes cho lần bật lại. */
export async function stopKRun(): Promise<KRunStored> {
  const current = parseKRun(await readKRunRow());
  const next: KRunStored = { ...current, enabled: false };
  await writeKRun(next);
  return next;
}

/** Đổi nhịp khi đang bật (không đổi enabled/startedAt — chỉ nhịp). */
export async function setKRunInterval(
  intervalMinutes: KRunInterval
): Promise<KRunStored> {
  const current = parseKRun(await readKRunRow());
  const next: KRunStored = { ...current, intervalMinutes };
  await writeKRun(next);
  return next;
}

/**
 * Ghi mốc "một chu kỳ vừa bắt đầu" — gọi từ POST /api/agents/run SAU khi
 * qua cooldown + validate (chu kỳ THẬT SỰ chạy — AUD-CODE #10), KỂ CẢ tay.
 * Key chưa từng tạo → no-op hoàn toàn (env fallback không bị đụng).
 * Fail-soft tuyệt đối: không ném, không chặn chu kỳ.
 */
export async function markKRunCycle(at: Date = new Date()): Promise<void> {
  try {
    const raw = await db.appSetting.findUnique({ where: { key: K_RUN_KEY } });
    if (!raw) return; // chế độ env fallback — nguyên vẹn
    const current = parseKRun(raw.value);
    const next: KRunStored = {
      ...current,
      lastCycleAt: at.toISOString(),
      cyclesRun: current.cyclesRun + 1,
    };
    await writeKRun(next);
  } catch (err) {
    console.error("[lib/k-run] markKRunCycle fail-soft:", err);
  }
}
