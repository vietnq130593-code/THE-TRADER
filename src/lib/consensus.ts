/**
 * src/lib/consensus.ts — CỔNG ĐỒNG THUẬN 80% (B9 — MARKET_EXPANSION_BLUEPRINT v1.1 §3.5).
 *
 * Pool cử tri = 6: market-analyst · fair-value · news-sentiment · liquidity ·
 * risk-manager · ml-forecast (ensemble MLP+linreg — B7). Chủ tịch KHÔNG bầu.
 *
 *   wᵢ = clamp(healthScoreᵢ/100 × posteriorMeanᵢ(bandit), 0.3, 1)   — trùng
 *        công thức weight bằng chứng llm-vote (tái dùng, điền ở evidence.ts)
 *   S(d) = Σ wᵢ·[voteᵢ = d]        cho d ∈ {UP, DOWN, FLAT}
 *   consensusRatio = max_d S(d) / Σ wᵢ
 *   gate: ratio ≥ 0,80 − 1e⁻⁹ → ĐỒNG THUẬN (CONSENSUS)
 *         ratio ∈ [0,50 · 0,80)    → ĐA SỐ YẾU (WEAK_MAJORITY) — tín hiệu ép HOLD
 *         ratio < 0,50             → KHÔNG ĐỒNG THUẬN (NO_CONSENSUS) — HOLD
 *   pool < 4 cử tri có mặt → KHÔNG ĐỒNG THUẬN (fail-safe).
 *   VETO Ủy ban Kiểm soát vẫn TUYỆT ĐỐI — cổng không vượt veto.
 *
 * HAI PHA (v1.1 — review 37-REVIEW): (a) shadow-mode ≥ 10 chu kỳ — cổng tính +
 * lưu detail.consensus + log "shadow: đã-sẽ-chặn" nhưng KHÔNG chặn; (b) sau
 * ≥ 10 chu kỳ shadow → tự bật AppSetting consensus.enforce = true (user đã
 * duyệt trước + tái xác nhận cách đọc dải 50–79,9% = HOLD cứng — phiên #38)
 * kèm thống kê tỉ lệ tín hiệu "đã-sẽ-chặn" để review lại.
 */

import { db } from "@/lib/db";

/** Key AppSetting cho cấu hình cổng đồng thuận. */
export const CONSENSUS_SETTING_KEY = "consensus";

/** Epsilon so ngưỡng 0,80 — tránh dải chết 0,7999… (v1.1 P0 #3). */
export const CONSENSUS_EPSILON = 1e-9;

/** Số cử tri tối thiểu để cổng có hiệu lực (pool < 4 → fail-safe). */
export const CONSENSUS_MIN_POOL = 4;

/**
 * Quy mô pool cử tri đầy đủ — hiển thị "present/total". #126: 7 cử tri
 * (6 agent LLM có phiếu: 5 nghiên cứu + risk-manager … nhưng risk-manager
 * chỉ vào votes khi chu kỳ chạy · ml-forecast luôn vào) — tổng đúng nghĩa
 * = 5 LLM nghiên cứu + risk-manager + ml-forecast = 7 sau khi thêm A20
 * macro-economist (#126). Chỉ dùng HIỂN THỊ — toán cổng hoàn toàn theo
 * phiếu có mặt (weights), không phụ thuộc hằng này.
 */
export const CONSENSUS_POOL_SIZE = 7;

/** Ngưỡng ĐỒNG THUẬN (80%) và ĐA SỐ YẾU (50%). */
export const CONSENSUS_THRESHOLD = 0.8;
export const WEAK_MAJORITY_THRESHOLD = 0.5;

/** Số chu kỳ shadow tối thiểu trước khi auto-enable enforcement. */
export const CONSENSUS_SHADOW_CYCLES = 10;

/** Cấu hình cổng (AppSetting key "consensus", value JSON). */
export interface ConsensusSetting {
  /** false = shadow-mode (mặc định) — cổng tính + log nhưng KHÔNG chặn. */
  enforce: boolean;
  /** Số chu kỳ shadow trước khi auto bật enforce. */
  autoEnableAfter: number;
  /** Thời điểm enforcement được bật (audit). */
  enforcedAt?: string;
}

const DEFAULT_SETTING: ConsensusSetting = {
  enforce: false,
  autoEnableAfter: CONSENSUS_SHADOW_CYCLES,
};

/** Cache in-process 60s — tránh query AppSetting mỗi lần chặn convert. */
let cached: { value: ConsensusSetting; at: number } | null = null;

/** Đọc cấu hình cổng từ AppSetting (fallback mặc định shadow-mode). */
export async function getConsensusSetting(): Promise<ConsensusSetting> {
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  let setting = DEFAULT_SETTING;
  try {
    const row = await db.appSetting.findUnique({ where: { key: CONSENSUS_SETTING_KEY } });
    if (row) {
      const parsed = JSON.parse(row.value) as Partial<ConsensusSetting>;
      setting = {
        enforce: parsed.enforce === true,
        autoEnableAfter:
          typeof parsed.autoEnableAfter === "number" && parsed.autoEnableAfter > 0
            ? Math.floor(parsed.autoEnableAfter)
            : DEFAULT_SETTING.autoEnableAfter,
        enforcedAt: typeof parsed.enforcedAt === "string" ? parsed.enforcedAt : undefined,
      };
    }
  } catch {
    // AppSetting hỏng/missing → mặc định shadow (an toàn)
  }
  cached = { value: setting, at: Date.now() };
  return setting;
}

/** Ghi đè cấu hình (dùng bởi auto-enable; cũng dùng toggle thủ công sau này). */
export async function setConsensusSetting(next: ConsensusSetting): Promise<void> {
  await db.appSetting.upsert({
    where: { key: CONSENSUS_SETTING_KEY },
    update: { value: JSON.stringify(next), updatedAt: new Date() },
    create: { key: CONSENSUS_SETTING_KEY, value: JSON.stringify(next) },
  });
  cached = { value: next, at: Date.now() };
}

/**
 * Pha (a)→(b): đếm số chu kỳ đã chạy cổng (assessment có detail.consensus);
 * khi đủ `autoEnableAfter` và enforce vẫn false → TỰ BẬT enforcement (user đã
 * duyệt trước ở phiên #38) + trả thống kê shadow để log review.
 */
export async function maybeAutoEnableConsensus(): Promise<{
  enabled: boolean;
  shadowCycles: number;
  wouldBlockRate: number;
  reason: string;
}> {
  const setting = await getConsensusSetting();
  // Đếm assessment đã có snapshot cổng (chuỗi "consensus":{ trong detail JSON)
  const shadowCycles = await db.marketAssessment
    .count({ where: { detail: { contains: '"consensus":{' } } })
    .catch(() => 0);
  if (setting.enforce) {
    return {
      enabled: false,
      shadowCycles,
      wouldBlockRate: -1,
      reason: "Enforcement đã BẬT từ trước — cổng đang chặn tín hiệu thật.",
    };
  }
  if (shadowCycles < setting.autoEnableAfter) {
    return {
      enabled: false,
      shadowCycles,
      wouldBlockRate: -1,
      reason: `Shadow-mode: ${shadowCycles}/${setting.autoEnableAfter} chu kỳ — cổng tính + log "đã-sẽ-chặn", KHÔNG chặn.`,
    };
  }
  // Đủ chu kỳ shadow → bật enforcement (user duyệt trước — phiên #38)
  await setConsensusSetting({
    ...setting,
    enforce: true,
    enforcedAt: new Date().toISOString(),
  });
  // Thống kê tỉ lệ "đã-sẽ-chặn" trong các chu kỳ shadow (review sau khi bật)
  let wouldBlock = 0;
  // AUDIT 137 A7 — wouldBlockRate sai mẫu: tử số đếm trên ≤200 rows gần nhất
  // nhưng mẫu số (shadowCycles) là count() VÔ HẠN + gộp cả assessment manual
  // (POST /api/assessment/synthesize cũng ghi detail.consensus) → khi tổng
  // chu kỳ > 200, tỉ lệ bị chặn ceiling 200/total (400 chu kỳ 100% chặn →
  // báo 50%). Sửa semantics: CHỈ đếm assessment source "cycle" (đúng nghĩa
  // "chu kỳ") và tử/mẫu CÙNG CỬA SỔ — wouldBlock / rows.length (≤200 chu kỳ
  // cycle mới nhất). shadowCycles giữ nguyên vai trò cũ (đếm tổng cho gate
  // autoEnableAfter).
  let scannedRows = 0;
  try {
    const rows = await db.marketAssessment.findMany({
      where: { detail: { contains: `"consensus":{` }, source: "cycle" },
      select: { detail: true },
      take: 200,
      orderBy: { createdAt: "desc" },
    });
    scannedRows = rows.length;
    for (const r of rows) {
      const parsed = JSON.parse(r.detail) as { consensus?: { wouldBlock?: boolean } };
      if (parsed.consensus?.wouldBlock === true) wouldBlock++;
    }
  } catch {
    // thống kê tốt-to-have — không chặn luồng bật
  }
  const wouldBlockRate = scannedRows > 0 ? wouldBlock / scannedRows : 0;
  return {
    enabled: true,
    shadowCycles,
    wouldBlockRate,
    reason: `Đủ ${shadowCycles} chu kỳ shadow → ĐÃ BẬT consensus.enforce (user duyệt trước #38). Tỉ lệ tín hiệu "đã-sẽ-chặn" trong shadow: ${(wouldBlockRate * 100).toFixed(1)}%.`,
  };
}

/** Xoá cache setting (dùng khi test/thay đổi cấu hình ngoài tiến trình). */
export function clearConsensusCache(): void {
  cached = null;
}
