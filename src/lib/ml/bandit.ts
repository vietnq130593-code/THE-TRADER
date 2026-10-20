/**
 * src/lib/ml/bandit.ts — THOMPSON SAMPLING Beta-Bernoulli cho 7 arm =
 * 6 LLM research agents + ml-forecast (phiên #35 · B7 #38 · A20 #126). KHÔNG
 * gọi LLM, KHÔNG dependencies.
 *
 * Posterior Beta(α+1, β+1) mỗi arm; reward sinh từ kết toán phiếu bầu:
 * đối chiếu direction vote trong MarketAssessment với realized direction
 * của rổ top-10 sau 5 NGÀY GIAO DỊCH (ngưỡng ±0,5%): đúng hướng → 1,
 * sai → 0; vote FLAT & realized FLAT → 0,7; vote FLAT & khác → 0,2.
 * Alpha += reward, beta += (1 − reward) — chuẩn Beta-Bernoulli conjugate.
 *
 * Ban đầu chu kỳ mới chạy → chưa đủ 5 phiên → settle 0 (trung thực);
 * reward tự kết toán khi bar EOD mới về (settlePendingRewards được gọi
 * trước mỗi lần train + trong chu kỳ rl-trainer).
 *
 * B7: arm "ml-forecast" seed Beta(1,1) — weight khiêm tốn ~0,5 khi chưa có
 * track record; BanditEvent.confidence lưu từ phiếu cast (B8 Brier).
 */

import { db } from "@/lib/db";
import { ROSTER_BY_CODE } from "@/lib/agent-roster";
// F-13/F-15 (#129): regime classifier + Wilson CI (analytics — một nguồn).
import { classifyRegime, type MarketRegime } from "@/lib/quant/regime";
import { wilson } from "@/lib/ml/analytics";

/** 7 arm Thompson sampling = 6 agent LLM có phiếu assessment + ml-forecast
 *  (B7 #38 + A20 #126 — đếm BANDIT_ARM_CODES; AUDIT 137 B10 sửa nhãn cũ
 *  "6 arm" sai thực trạng). */
export const BANDIT_ARM_CODES = [
  "market-analyst",
  "fair-value",
  "news-sentiment",
  "liquidity",
  "macro-economist", // #126 A20 — arm cold-start Beta(1,1), tự học từ settle 5 phiên
  "risk-manager",
  "ml-forecast",
] as const;

/** Số phiên chờ trước khi kết toán reward. */
const SETTLE_SESSIONS = 5;
/** Rổ chấm kết quả — 10 mã thanh khoản (P0-2). */
const SETTLE_BASKET_N = 10;
/* ── W1 (#163 · review #162) — RỔ PIT TẠI NGÀY CAST ────────────────────────
 * Trước đây: rổ chấm kết quả = top-10 theo QUOTE VOLUME MỚI NHẤT tại lúc
 * settle → 2 lỗi cộng dồn cho mọi phiếu bầu:
 *   (a) phi-PIT — phiếu bầu 5 phiên trước bị chấm bằng rổ đã TRƯỢT THÀNH PHẦN
 *       (thanh khoản dồn mã khác trong 5 ngày đó) — cử tri bị thưởng/phạt
 *       theo vũ trụ họ KHÔNG hề bầu;
 *   (b) sai định nghĩa so với rổ ML (topByAdtv ADTV-45 EOD — P0-2 "định
 *       nghĩa rổ duy nhất" của toàn hệ thống) → nhãn realized nhiễu, credit
 *       assignment của cả 7 arm bandit + meta-learner F-02 đều nhòe.
 * Giờ: MỖI phiếu chấm bằng top-10 ADTV 45 phiên EOD (Bar.value) tính đúng
 * tại castDate — đúng rổ cử tri đã thấy khi bầu (agent-context dùng
 * topByAdtv hiện tại mỗi chu kỳ). Mirror tinh topByAdtv tail-45: mean 45
 * bar CUỐI ≤ castDate, tối thiểu 10 bar, close>0, value=close×volume khi
 * cột null. Hoàn tác an toàn: phiếu đã settled giữ nguyên (idempotent
 * keys) — chỉ phiếu settle TỪ phiên bản này dùng rổ PIT. */
/** Mirror ADTV_SESSIONS (dated-series P0-2) — 45 phiên EOD. */
const PIT_ADTV_SESSIONS = 45;
/** Mirror ADTV_MIN_BARS — mã dưới 10 bar trong cửa sổ tự loại. */
const PIT_ADTV_MIN_BARS = 10;
/** Cửa sổ nạp bar: 45 phiên ≈ 77 ngày lịch (×1,7) + đệm lễ. */
const PIT_ADTV_LOOKBACK_DAYS = 85;

/**
 * Rổ top-10 ADTV PIT cho từng castDate (W1 #163). 1 truy vấn instrument +
 * 1 truy vấn bar trên toàn bộ vùng [castMin−85d, castMax] — chạy trong đợt
 * settle (≤1 lần/ngày), KHÔNG nằm trên đường nóng status. Trả Map keyed
 * theo castDate.getTime() để vòng settle O(1) tra rổ của từng phiếu.
 */
async function pitTopIdsByCast(castDates: Date[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  const distinct = [...new Set(castDates.map((d) => d.getTime()))].sort((a, b) => a - b);
  if (distinct.length === 0) return out;
  const from = new Date(distinct[0] - PIT_ADTV_LOOKBACK_DAYS * 86_400_000);
  const to = new Date(distinct[distinct.length - 1]);
  const instruments = await db.instrument.findMany({
    where: { isActive: true, market: "HOSE", type: "STOCK" },
    select: { id: true },
  });
  if (instruments.length === 0) return out;
  const bars = await db.bar.findMany({
    where: { instrumentId: { in: instruments.map((i) => i.id) }, date: { gte: from, lte: to } },
    orderBy: [{ instrumentId: "asc" }, { date: "asc" }],
    select: { instrumentId: true, date: true, close: true, volume: true, value: true },
  });
  // Chuỗi value từng mã (date tăng dần — orderBy đảm bảo)
  const seriesById = new Map<string, { ms: number; value: number }[]>();
  for (const b of bars) {
    if (!(b.close > 0)) continue;
    const value = b.value != null ? Number(b.value) : b.close * b.volume;
    if (!(value > 0)) continue;
    const arr = seriesById.get(b.instrumentId) ?? [];
    arr.push({ ms: b.date.getTime(), value });
    seriesById.set(b.instrumentId, arr);
  }
  for (const castMs of distinct) {
    const ranked: { id: string; adtv: number }[] = [];
    for (const [id, arr] of seriesById) {
      // tail-45 phiên ≤ castDate (mirror topByAdtv — quét từ cuối, skip bar
      // sau castDate vì chuỗi tăng dần)
      const vals: number[] = [];
      for (let i = arr.length - 1; i >= 0 && vals.length < PIT_ADTV_SESSIONS; i--) {
        if (arr[i].ms > castMs) continue;
        vals.push(arr[i].value);
      }
      if (vals.length < PIT_ADTV_MIN_BARS) continue;
      ranked.push({ id, adtv: vals.reduce((s, v) => s + v, 0) / vals.length });
    }
    ranked.sort((a, b) => b.adtv - a.adtv);
    out.set(castMs, ranked.slice(0, SETTLE_BASKET_N).map((r) => r.id));
  }
  return out;
}
/** Ngưỡng realized direction của rổ (±0,5%). */
const SETTLE_THRESHOLD = 0.005;
/** Số mã tối thiểu có giá tại 2 mốc thời gian để kết toán. */
const SETTLE_MIN_SYMBOLS = 3;
/**
 * AUDIT 137 A2 — mốc giờ chót ICT của một Bar. Convention eod-sync.ts:350-353
 * lưu Bar.date = 15:00 UTC của ngày giao dịch (= 22:00 ICT trên trục UTC),
 * trong khi giờ chốt THẬT là 15:00 ICT = 08:00 UTC = Bar.date − 7h. So phiếu
 * bầu TRỰC TIẾP với Bar.date khiến phiếu sau 15:45 ICT (08:45 UTC — sau
 * eod-sync đã ghi bar ngày D) vẫn thấy bar D là "tương lai" (15:00 UTC >
 * 08:45 UTC) → castDate = D−1, đo [D−1 → D+4]: 1/5 phiên reward là thông tin
 * ĐÃ BIẾT lúc bầu. So theo mốc giờ chót ICT thì bar D "đã chốt" từ 08:00 UTC
 * → castDate = D, cửa sổ đo [D → D+5] đủ 5 phiên tương lai thật.
 */
const ICT_CLOSE_OFFSET_MS = 7 * 3600_000;
function ictCloseMs(d: Date): number {
  return d.getTime() - ICT_CLOSE_OFFSET_MS;
}
/** F-15 (#129): quét N assessment gần nhất khi kết toán — TĂNG 30 → 200:
 *  con trổ backlog thay take-30 quên phiếu cũ (P1-4). ~6 assessment/ngày
 *  → 200 bản ≈ 1 tháng dư địa cho engine chết dài; settledKeys vẫn idempotent.
 *  futureDates query kích thước 5×200+20 — vẫn nhẹ (distinct date). */
const SETTLE_SCAN_LIMIT = 200;
/** F-13 (#129): số pulls tối thiểum MỘT regime để posterior regime có trọng
 *  số (đặc tả F-13 gate: "regime nào chưa đủ 10 pulls → fallback bảng chung"). */
const REGIME_MIN_PULLS = 10;

/** Phiếu bầu của một agent trong assessment (B7: kèm confidence cho Brier B8).
 *  F-07 (#129): meta = vector giọng nói (chỉ ml-forecast) — settle chép vào
 *  BanditEvent.meta làm input cho ensemble-learn meta-learner. */
interface CastVote {
  code: string;
  direction: "UP" | "DOWN" | "FLAT";
  /** 0..1 — lưu vào BanditEvent.confidence lúc settle (ml-forecast = max(pUp,pDown,pFlat)). */
  confidence?: number;
  /** F-07 (#129): vector giọng nói khi cast {pUp,pDown,pFlat,z,score,...}. */
  meta?: Record<string, unknown>;
}

/** Kết quả một lần kết toán. */
export interface SettleResult {
  /** Số assessment đủ 5 phiên tuổi được kết toán trong lần gọi này. */
  settled: number;
  /** Tổng số phiếu được kết toán (reward đã ghi). */
  votes: number;
  /** Chi tiết từng phiếu (narrative cho runner rl-trainer). */
  details?: { agentCode: string; agentName: string; reward: number; assessmentId: string }[];
}

/** Upsert 7 BanditArm nếu thiếu (idempotent — gọi an toàn mọi nơi).
 * Perf #64: TRƯỚC fix upsert 7 arm TUẦN TỰ mỗi lần gọi (~600ms WAN — Comics
 * đóng góp lớn nhất trong 1,4s của /api/ml/status); giờ chạy parallel MỘT
 * lần/process (module flag) — các lần sau 0 query. */
let armsEnsured = false;
export async function ensureArms(): Promise<void> {
  if (armsEnsured) return;
  await Promise.all(
    BANDIT_ARM_CODES.map((code) =>
      db.banditArm.upsert({
        where: { agentCode: code },
        update: {},
        create: { agentCode: code, alpha: 1, beta: 1, pulls: 0, wins: 0 },
      })
    )
  );
  // F-15 (#129)(c): dọn arm mồ côi không nằm trong BANDIT_ARM_CODES (đo
  // 17/10: arm `portfolio-strategist` pulls=0 — xoá vì không mất gì; pulls>0
  // thì GIỮ + khai báo — không xoá track record).
  try {
    const orphans = await db.banditArm.findMany({
      where: { agentCode: { notIn: [...BANDIT_ARM_CODES] } },
      select: { id: true, agentCode: true, pulls: true },
    });
    const removable = orphans.filter((o) => o.pulls === 0).map((o) => o.id);
    if (removable.length > 0) {
      await db.banditArm.deleteMany({ where: { id: { in: removable } } });
      console.log(
        `[ml/bandit] F-15 dọn ${removable.length} arm mồ côi pulls=0 (${orphans
          .filter((o) => o.pulls === 0)
          .map((o) => o.agentCode)
          .join(", ")})`
      );
    }
  } catch (err) {
    console.error("[ml/bandit] dọn arm mồ côi lỗi (fail-soft):", err);
  }
  armsEnsured = true;
}

/**
 * Đọc phiếu bầu từ detail JSON của assessment: hỗ trợ cả dạng detail
 * .agentVotes [{code, direction, confidence}] (persist #38 lưu kèm) và dạng
 * .drivers source "llm-vote:<code>" (cấu trúc cũ) — chỉ giữ phiếu 7 arm bandit.
 */
function parseVotes(detail: string): CastVote[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(detail) as Record<string, unknown>;
  } catch {
    return [];
  }
  const out: CastVote[] = [];
  const isDir = (d: unknown): d is CastVote["direction"] =>
    d === "UP" || d === "DOWN" || d === "FLAT";

  const votes = parsed.agentVotes;
  if (Array.isArray(votes)) {
    for (const v of votes) {
      const row = v as { code?: unknown; direction?: unknown; confidence?: unknown; meta?: unknown };
      if (typeof row.code === "string" && isDir(row.direction)) {
        out.push({
          code: row.code,
          direction: row.direction,
          confidence:
            typeof row.confidence === "number" && Number.isFinite(row.confidence)
              ? Math.max(0, Math.min(1, row.confidence))
              : undefined,
          // F-07 (#129): giữ nguyên voice vector cho phiếu ml-forecast.
          ...(row.meta != null && typeof row.meta === "object" && !Array.isArray(row.meta)
            ? { meta: row.meta as Record<string, unknown> }
            : {}),
        });
      }
    }
    if (out.length > 0) return filterArms(out);
  }
  const drivers = parsed.drivers;
  if (Array.isArray(drivers)) {
    for (const d of drivers) {
      const row = d as { source?: unknown; direction?: unknown };
      if (
        typeof row.source === "string" &&
        row.source.startsWith("llm-vote:") &&
        isDir(row.direction)
      ) {
        out.push({ code: row.source.slice("llm-vote:".length), direction: row.direction });
      }
    }
  }
  return filterArms(out);
}

/** Chỉ giữ phiếu của 6 arm bandit. */
function filterArms(votes: CastVote[]): CastVote[] {
  const armSet = new Set<string>(BANDIT_ARM_CODES);
  return votes.filter((v) => armSet.has(v.code));
}

/** Perf #64 — memo phiếu bầu theo assessmentId: detail MarketAssessment là
 * JSON ~11KB/row và BẤT BIẾN sau khi tạo (ghi 1 lần mỗi chu kỳ), nhưng
 * pendingSettleCount/settle quét 30 bản gần nhất MỖI LẦN → 340KB WAN
 * (~1,4s /api/ml/status). Memo hoá sau: chỉ assessment MỚI mới cần fetch
 * detail — steady-state ~11KB/lần chu kỳ. Cap 128 entry (quét tối đa 30 —
 * cap dư địa cho chạy dài). */
const voteMemo = new Map<string, CastVote[]>();

function votesOf(a: { id: string }): CastVote[] {
  return voteMemo.get(a.id) ?? [];
}

/** Nạp memo cho các id chưa có — fetch detail CHỈ những row còn thiếu.
 * F-65A-01/#65 — clear-at-128 phải chạy TRƯỚC khi tính missing: trước đây
 * tính missing trước rồi clear → call tự xoá memo của ~29 id đang cần (chỉ
 * còn id vừa fetch) → votesOf() của phần còn lại trả [] → settle bỏ qua
 * phiếu đúng hạn đúng 1 chu kỳ + pendingCountCache undercount 15s. */
async function warmVoteMemo(ids: string[]): Promise<void> {
  if (voteMemo.size > 128) voteMemo.clear();
  const missing = ids.filter((id) => !voteMemo.has(id));
  if (missing.length === 0) return;
  const rows = await db.marketAssessment.findMany({
    where: { id: { in: missing } },
    select: { id: true, detail: true },
  });
  for (const r of rows) voteMemo.set(r.id, parseVotes(r.detail));
  for (const id of missing) if (!voteMemo.has(id)) voteMemo.set(id, []); // row xoá giữa chừng — memo cả negative
}

/**
 * Kết toán mọi phiếu chờ: với mỗi assessment (30 bản gần nhất) chưa có
 * BanditEvent settled mà đã đủ 5 ngày giao dịch tính từ createdAt → tính
 * realized direction rổ top-10 → reward từng phiếu → upsert BanditEvent +
 * cập nhật alpha/beta/pulls/wins BanditArm. Trả {settled, votes, details}.
 *
 * F-801-04 (Fixbug #80 — Vòng 1): 3 caller cùng gọi hàm này — chu kỳ agent
 * Đợt B (agent-service-runs) · nút train (settle-trước-train) · route A1
 * /api/ml/settle (engine 16:15 ICT). Route có mutex riêng nhưng KHÔNG dùng
 * chung với 2 caller kia → 2 lần chạy chồng lấn trong cùng ~2s quét có thể
 * cùng thấy phiếu chưa settle → upsert trùng + BanditArm.increment ×2
 * (double-count reward). Giờ bản thân hàm xếp hàng tuần tự in-process:
 * caller sau chờ caller trước xong rồi quét lại settledKeys — phiếu đã
 * kết toán tự bị bỏ qua (idempotent). Lỗi của một lần chạy vẫn ném về đúng
 * caller đó, chuỗi không đứt.
 */
let settleChain: Promise<unknown> = Promise.resolve();
export function settlePendingRewards(): Promise<SettleResult> {
  const run = settleChain.then(() => settlePendingRewardsRaw());
  settleChain = run.catch(() => undefined); // chuỗi sống qua lỗi của 1 lần chạy
  return run;
}

async function settlePendingRewardsRaw(): Promise<SettleResult> {
  await ensureArms();

  // Perf #64 — hai bước: lấy id trước, fetch detail CHỈ row chưa có trong
  // memo (trước fix kéo full detail 30×~11KB mỗi lần settle).
  const idRows = await db.marketAssessment.findMany({
    orderBy: { createdAt: "desc" },
    take: SETTLE_SCAN_LIMIT,
    select: { id: true, createdAt: true },
  });
  if (idRows.length === 0) return { settled: 0, votes: 0 };
  await warmVoteMemo(idRows.map((a) => a.id));
  const assessments = idRows;

  // Phiếu đã settle (assessmentId:agentCode) — bỏ qua khi quét
  const events = await db.banditEvent.findMany({
    where: { assessmentId: { in: assessments.map((a) => a.id) } },
    select: { assessmentId: true, agentCode: true, settledAt: true },
  });
  const settledKeys = new Set(
    events
      .filter((e) => e.settledAt != null)
      .map((e) => `${e.assessmentId}:${e.agentCode}`)
  );

  // Chỉ assessment còn phiếu chờ mới cần bar
  const pending = assessments.filter((a) => {
    const votes = votesOf(a);
    return votes.some((v) => !settledKeys.has(`${a.id}:${v.code}`));
  });
  if (pending.length === 0) return { settled: 0, votes: 0 };

  // 1 truy vấn distinct date mỗi chiều: đủ phiên cho mọi assessment trong quét
  const oldest = pending.reduce(
    (min, a) => (a.createdAt < min ? a.createdAt : min),
    pending[0].createdAt
  );
  const futureDates = await db.bar.findMany({
    where: { date: { gte: oldest } },
    distinct: ["date"],
    orderBy: { date: "asc" },
    take: SETTLE_SESSIONS * SETTLE_SCAN_LIMIT + 20,
    select: { date: true },
  });
  // Phiên cast của mỗi assessment = phiên giao dịch cuối đã CHỐT (mốc ICT) tại/
  // trước khi bầu (danh sách distinct desc — đủ cho quét).
  // AUDIT 137 A2 — biên SQL lte nới +7h để KHÔNG loại bar có mốc chốt ICT ≤
  // createdAt (Bar.date 15:00 UTC của ngày D có ictClose 08:00 UTC: phiếu bầu
  // 08:45 UTC ngày D cần bar D trong pastDates — lte createdAt thô sẽ loại
  // nó); điều kiện CHẶT vẫn chấm bằng ictCloseMs ở vòng lặp dưới.
  const pastDates = await db.bar.findMany({
    where: { date: { lte: new Date(pending[0].createdAt.getTime() + ICT_CLOSE_OFFSET_MS) } },
    distinct: ["date"],
    orderBy: { date: "desc" },
    take: SETTLE_SCAN_LIMIT,
    select: { date: true },
  });

  // W1 (#163): rổ chấm kết quả = PIT tại castDate từng phiếu (xem pitTopIdsByCast).
  // castDate mỗi assessment tính TRƯỚC vòng (pastDates đã có) → 1 truy vấn bar
  // gộp cho mọi castDate khác nhau.
  const castDateById = new Map<string, Date>();
  for (const a of pending) {
    const castDate = pastDates.find((d) => ictCloseMs(d.date) <= a.createdAt.getTime())?.date;
    if (castDate != null) castDateById.set(a.id, castDate);
  }
  const pitBasket = await pitTopIdsByCast([...castDateById.values()]);

  let settled = 0;
  let votes = 0;
  const details: NonNullable<SettleResult["details"]> = [];

  // F-13 (#129): chuỗi VNINDEX để gán regime cho mỗi phiếu tại thời điểm cast
  // (contextual bandit — posterior theo (arm × regime)); đọc 1 lần/tiến trình
  // (TTL 10 phút — settle 16:15 hằng ngày dùng lại từ nạp đầu trong ngày).
  const vnindex = await loadVnindexCloses();
  // F-13: regimeStats các arm — đọc 1 lần, tích luỹ in-memory rồi ghi 1 lần/cuối.
  const armRows = await db.banditArm.findMany({
    select: { agentCode: true, regimeStats: true },
  }).catch(() => [] as { agentCode: string; regimeStats: string | null }[]);
  const regimeAcc = new Map<string, Map<string, { alpha: number; beta: number; pulls: number }>>();
  for (const row of armRows) {
    try {
      const parsed = row.regimeStats ? (JSON.parse(row.regimeStats) as Record<string, unknown>) : {};
      const blocks = new Map<string, { alpha: number; beta: number; pulls: number }>();
      for (const [key, value] of Object.entries(parsed)) {
        if (value != null && typeof value === "object") {
          const b = value as { alpha?: unknown; beta?: unknown; pulls?: unknown };
          if (typeof b.alpha === "number" && typeof b.beta === "number" && typeof b.pulls === "number") {
            blocks.set(key, { alpha: b.alpha, beta: b.beta, pulls: b.pulls });
          }
        }
      }
      regimeAcc.set(row.agentCode, blocks);
    } catch {
      regimeAcc.set(row.agentCode, new Map());
    }
  }

  for (const a of pending) {
    const votesForAssessment = votesOf(a).filter(
      (v) => !settledKeys.has(`${a.id}:${v.code}`)
    );
    if (votesForAssessment.length === 0) continue;

    // Đủ 5 phiên giao dịch sau createdAt chưa?
    // AUDIT 137 A2 — so theo MỐC GIỜ CHỐT ICT (ictCloseMs), không theo Bar.date
    // 15:00 UTC: phiếu 08:45 UTC (15:45 ICT) sau eod-sync phải coi bar ngày D
    // là ĐÃ CHỐT (castDate = D) — trước đây bar D lọt vào "future" → đo
    // [D−1 → D+4] với 1/5 phiên đã biết. Settle cũ đã chạy thì KHÔNG hồi lại
    // (idempotent keys settledKeys) — chỉ phiếu MỚI được xếp đúng cửa sổ.
    const after = futureDates
      .filter((f) => ictCloseMs(f.date) >= a.createdAt.getTime())
      .slice(0, SETTLE_SESSIONS);
    const castDate = castDateById.get(a.id) ?? null;
    if (after.length < SETTLE_SESSIONS || castDate == null) continue;
    const realizedDate = after[SETTLE_SESSIONS - 1].date;

    // W1 (#163): rổ PIT của riêng phiếu này — top-10 ADTV-45 EOD tại castDate.
    // Không dựng được rổ (lỗ dữ liệu) → HOÃN, tuyệt đối không fallback về rổ
    // khác kiểu cũ (chấm sai còn tệ hơn chậm).
    const topIds = pitBasket.get(castDate.getTime());
    if (!topIds || topIds.length < SETTLE_MIN_SYMBOLS) continue;

    // Realized direction rổ PIT: equal-weight ret mỗi mã cast → realized
    const bars = await db.bar.findMany({
      where: { instrumentId: { in: topIds }, date: { in: [castDate, realizedDate] } },
      select: { instrumentId: true, date: true, close: true },
    });
    const byInstrument = new Map<string, { cast?: number; realized?: number }>();
    for (const b of bars) {
      const entry = byInstrument.get(b.instrumentId) ?? {};
      if (b.date.getTime() === castDate.getTime()) entry.cast = b.close;
      if (b.date.getTime() === realizedDate.getTime()) entry.realized = b.close;
      byInstrument.set(b.instrumentId, entry);
    }
    const rets: number[] = [];
    for (const e of byInstrument.values()) {
      if (e.cast != null && e.realized != null && e.cast > 0) {
        rets.push(e.realized / e.cast - 1);
      }
    }
    if (rets.length < SETTLE_MIN_SYMBOLS) continue; // dữ liệu thưa — hoãn
    const basketRet = rets.reduce((s, r) => s + r, 0) / rets.length;
    const realizedDir: CastVote["direction"] =
      basketRet > SETTLE_THRESHOLD ? "UP" : basketRet < -SETTLE_THRESHOLD ? "DOWN" : "FLAT";

    // Reward từng phiếu theo quy ước Thompson sampling
    for (const v of votesForAssessment) {
      let reward: number;
      if (v.direction === "FLAT") reward = realizedDir === "FLAT" ? 0.7 : 0.2;
      else reward = v.direction === realizedDir ? 1 : 0;

      // F-07 (#129): meta phiếu = vector giọng nói (cast) + realizedDir (Q10
      // point-in-time cho ensemble-learn — phiếu cũ không có meta → cold-start).
      const metaJson = JSON.stringify({
        ...(v.meta ?? {}),
        realizedDir,
      });
      await db.banditEvent.upsert({
        where: { assessmentId_agentCode: { assessmentId: a.id, agentCode: v.code } },
        update: {
          settledAt: new Date(),
          reward,
          direction: v.direction,
          // B8 — độ tự tin phiếu khi cast → đầu vào Brier score (nếu có lưu)
          ...(v.confidence != null ? { confidence: v.confidence } : {}),
          meta: metaJson,
        },
        create: {
          assessmentId: a.id,
          agentCode: v.code,
          direction: v.direction,
          castAt: a.createdAt,
          settledAt: new Date(),
          reward,
          ...(v.confidence != null ? { confidence: v.confidence } : {}),
          meta: metaJson,
        },
      });
      await db.banditArm.update({
        where: { agentCode: v.code },
        data: {
          alpha: { increment: reward },
          beta: { increment: 1 - reward },
          pulls: { increment: 1 },
          wins: { increment: reward },
          lastRewardAt: new Date(),
        },
      });
      // F-13 (#129): tích luỹ posterior theo (arm × regime tại thời điểm cast).
      const regimeKey = regimeOf(vnindex, a.createdAt);
      if (regimeKey != null) {
        let blocks = regimeAcc.get(v.code);
        if (!blocks) {
          blocks = new Map();
          regimeAcc.set(v.code, blocks);
        }
        const blk = blocks.get(regimeKey) ?? { alpha: 0, beta: 0, pulls: 0 };
        blk.alpha += reward;
        blk.beta += 1 - reward;
        blk.pulls += 1;
        blocks.set(regimeKey, blk);
      }
      const roster = ROSTER_BY_CODE.get(v.code);
      details.push({
        agentCode: v.code,
        agentName: roster?.name ?? v.code,
        reward,
        assessmentId: a.id,
      });
      votes++;
    }
    settled++;
  }

  // F-13 (#129): ghi lại regimeStats JSON cho mỗi arm có cập nhật (1 write/
  // arm — không đè alpha/beta cột chung). Fail-soft: lỗi ghi KHÔNG chặn kết
  // toán (reward đã ghi BanditEvent + arm chung).
  for (const [code, blocks] of regimeAcc) {
    if (blocks.size === 0) continue;
    try {
      const json: Record<string, { alpha: number; beta: number; pulls: number }> = {};
      for (const [key, blk] of blocks) {
        json[key] = { alpha: Number(blk.alpha.toFixed(2)), beta: Number(blk.beta.toFixed(2)), pulls: blk.pulls };
      }
      await db.banditArm.update({
        where: { agentCode: code },
        data: { regimeStats: JSON.stringify(json) },
      });
    } catch (err) {
      console.error(`[ml/bandit] ghi regimeStats arm ${code} lỗi (fail-soft):`, err);
    }
  }

  // F-65A-02/#65 — settle là WRITE: reset cả 2 TTL cache 15s để mọi read
  // ngay sau đó (narrative AgentRun đọc pendingSettleCount/banditSnapshot,
  // POST /api/ml/train → GET /api/ml/status) thấy posterior/pending MỚI
  // thay vì cache pre-settle trong 15s (read-after-write).
  snapCache = null;
  pendingCountCache = null;
  return { settled, votes, details };
}

/** Ảnh chụp posterior các arm (sắp theo posteriorMean giảm dần) + lần settle cuối.
 * Perf #64 — TTL cache 15s: arm chỉ đổi lúc settle (mỗi chu kỳ agent), UI poll
 * /api/ml/status 30s/lần nên cache hấp thụ 1/2 request; stale tối đa 15s
 * hoàn toàn chấp nhận được cho badge trạng thái. */
export type BanditSnapshot = Awaited<ReturnType<typeof banditSnapshotRaw>>;
let snapCache: { at: number; value: BanditSnapshot } | null = null;
const SNAP_TTL_MS = 15_000;

export async function banditSnapshot(): Promise<BanditSnapshot> {
  if (snapCache && Date.now() - snapCache.at < SNAP_TTL_MS) return snapCache.value;
  const value = await banditSnapshotRaw();
  snapCache = { at: Date.now(), value };
  return value;
}

async function banditSnapshotRaw(): Promise<{
  arms: {
    agentCode: string;
    name: string;
    alpha: number;
    beta: number;
    pulls: number;
    wins: number;
    posteriorMean: number;
    /** F-15 (#129): Wilson CI 95% của TỈ LẸ THẮNG wins/pulls — xấp xỉ hợp lý
     *  vì reward là thập phân (0/0,2/0,7/1), KHÔNG phải CI của posteriorMean
     *  (AUDIT 137 B10 sửa nhãn cũ). UI bandit-block hiển thị cạnh posterior +
     *  mốc "≥100 pulls = tin khoảng cách". */
    wilsonLow: number;
    wilsonHigh: number;
    /** F-13 (#129): posterior theo regime hiện tại (null = dùng bảng chung). */
    regimePosteriorMean: number | null;
    /** F-13 (#129): posterior từng regime đã tích luỹ (parse JSON cột). */
    regimeStats: Record<string, { alpha: number; beta: number; pulls: number }> | null;
  }[];
  lastSettleAt: Date | null;
  /** F-13 (#129): regime thị trường hiện tại (ngữ cảnh snapshot). */
  currentRegime: { regime: MarketRegime; label: string } | null;
}> {
  await ensureArms();
  // Perf #64 — 2 query độc lập chạy parallel (trước fix tuần tự 2 RTT)
  const [arms, agg] = await Promise.all([
    db.banditArm.findMany(),
    db.banditEvent.aggregate({ _max: { settledAt: true } }),
  ]);
  // F-13: regime hiện tại — posterior regime chỉ có trọng số khi đủ pulls.
  const current = await currentMarketRegime().catch(() => null);
  const mapped = arms.map((a) => {
    const roster = ROSTER_BY_CODE.get(a.agentCode);
    const posteriorMean = (a.alpha + 1) / (a.alpha + a.beta + 2);
    // F-15: Wilson 95% trên TỈ LẸ THẮNG (wins/pulls — xấp xỉ vì reward thập
    // phân, AUDIT 137 B10) — pulls=0 → khoảng [0,1] trung thực
    // (wilson() ném lỗi khi n ≤ 0 — guard trước, không nuốt silent).
    let ciLow = 0;
    let ciHigh = 1;
    if (a.pulls > 0) {
      try {
        const ci = wilson(Math.max(0, Math.min(1, a.wins / a.pulls)), a.pulls);
        ciLow = ci.lo;
        ciHigh = ci.hi;
      } catch {
        ciLow = 0;
        ciHigh = 1;
      }
    }
    let regimeStats: Record<string, { alpha: number; beta: number; pulls: number }> | null = null;
    if (a.regimeStats) {
      try {
        regimeStats = JSON.parse(a.regimeStats) as Record<string, {
          alpha: number;
          beta: number;
          pulls: number;
        }>;
      } catch {
        regimeStats = null;
      }
    }
    let regimePosteriorMean: number | null = null;
    if (current && regimeStats) {
      const blk = regimeStats[current.regime];
      if (blk && blk.pulls >= REGIME_MIN_PULLS) {
        regimePosteriorMean = Number(((blk.alpha + 1) / (blk.alpha + blk.beta + 2)).toFixed(4));
      }
    }
    return {
      agentCode: a.agentCode,
      name: roster?.name ?? a.agentCode,
      alpha: a.alpha,
      beta: a.beta,
      pulls: a.pulls,
      wins: a.wins,
      posteriorMean: Number(posteriorMean.toFixed(4)),
      wilsonLow: Number(ciLow.toFixed(4)),
      wilsonHigh: Number(ciHigh.toFixed(4)),
      regimePosteriorMean,
      regimeStats,
    };
  });
  mapped.sort((x, y) => y.posteriorMean - x.posteriorMean);
  return {
    arms: mapped,
    lastSettleAt: agg._max.settledAt,
    currentRegime: current ? { regime: current.regime, label: current.label } : null,
  };
}

/** Số phiếu bầu LLM chờ tới phiên thứ 5 (chưa settle) — 30 assessment gần nhất.
 * Perf #64 — memo phiếu bầu (chỉ assessment MỚI cần fetch detail ~11KB;
 * trước fix kéo 340KB mỗi lần) + TTL cache 15s (số chỉ đổi khi có assessment
 * mới hoặc settle — đều xảy ra trong chu kỳ agent). */
let pendingCountCache: { at: number; value: number } | null = null;

export async function pendingSettleCount(): Promise<number> {
  if (pendingCountCache && Date.now() - pendingCountCache.at < SNAP_TTL_MS) {
    return pendingCountCache.value;
  }
  const ids = await db.marketAssessment.findMany({
    orderBy: { createdAt: "desc" },
    take: SETTLE_SCAN_LIMIT,
    select: { id: true },
  });
  if (ids.length === 0) return 0;
  await warmVoteMemo(ids.map((a) => a.id));
  const events = await db.banditEvent.findMany({
    where: { assessmentId: { in: ids.map((a) => a.id) } },
    select: { assessmentId: true, agentCode: true, settledAt: true },
  });
  const settledKeys = new Set(
    events
      .filter((e) => e.settledAt != null)
      .map((e) => `${e.assessmentId}:${e.agentCode}`)
  );
  let pending = 0;
  for (const a of ids) {
    for (const v of votesOf(a)) {
      if (!settledKeys.has(`${a.id}:${v.code}`)) pending++;
    }
  }
  pendingCountCache = { at: Date.now(), value: pending };
  return pending;
}

/* ═══════════════════════════════════════════════════════════════════
 * F-13 (#129 — AI_ENGINEER_REVIEW_BRAIN §3 F-13) · REGIME + CONTEXTUAL
 * Nhãn chế độ hằng ngày từ VNINDEX (classifyRegime chuẩn hoá có sẵn);
 * contextual bandit: posterior theo (arm × regime) — regime nào chưa đủ
 * REGIME_MIN_PULLS pulls → fallback bảng chung (khai báo UI trung thực).
 * AppSetting "market-regime" rolling ghi hằng ngày trong job settle.
 * ═══════════════════════════════════════════════════════════════════ */

/** Cache chuỗi VNINDEX (TTL 10 phút — settle + evidence + snapshot dùng chung). */
let vnindexCache: { at: number; dates: Date[]; closes: number[] } | null = null;
const VNINDEX_CACHE_TTL_MS = 10 * 60_000;

async function loadVnindexCloses(): Promise<{ dates: Date[]; closes: number[] }> {
  if (vnindexCache && Date.now() - vnindexCache.at < VNINDEX_CACHE_TTL_MS) {
    return vnindexCache;
  }
  try {
    const inst = await db.instrument.findFirst({
      where: { symbol: "VNINDEX", isActive: true },
      select: { id: true },
    });
    if (!inst) return { dates: [], closes: [] };
    const bars = await db.bar.findMany({
      where: { instrumentId: inst.id },
      orderBy: { date: "asc" },
      select: { date: true, close: true },
    });
    // AUDIT 137 B10 — lọc bar rắc (close ≤ 0) TRƯỚC rồi map CẢ HAI mảng từ
    // CÙNG danh sách: bản cũ filter riêng closes → dates.length ≠
    // closes.length khi có bar rắc → regimeOf trả null VĨNH VIÊN (fail-safe
    // nhưng chết chức năng regime) + currentMarketRegime lấy dates[last] của
    // bar đã bị lọc ra (nhãn asOf sai phiên).
    const clean = bars.filter((b) => b.close > 0);
    const out = {
      dates: clean.map((b) => b.date),
      closes: clean.map((b) => b.close),
    };
    vnindexCache = { at: Date.now(), ...out };
    return out;
  } catch (err) {
    console.error("[ml/bandit] loadVnindexCloses lỗi (fail-soft):", err);
    return { dates: [], closes: [] };
  }
}

/** Regime tại thời điểm cast (dùng closes VNINDEX ≤ castAt — PIT N4). */
function regimeOf(
  vnindex: { dates: Date[]; closes: number[] },
  at: Date
): MarketRegime | null {
  if (vnindex.closes.length < 21 || vnindex.dates.length !== vnindex.closes.length) return null;
  let idx = -1;
  for (let i = vnindex.dates.length - 1; i >= 0; i--) {
    if (vnindex.dates[i]!.getTime() <= at.getTime()) {
      idx = i;
      break;
    }
  }
  if (idx < 20) return null;
  return classifyRegime(vnindex.closes.slice(0, idx + 1)).regime;
}

/** F-13 (#129): regime thị trường HIỆN TẠI (phiên cuối VNINDEX). */
export async function currentMarketRegime(): Promise<{
  regime: MarketRegime;
  label: string;
  asOf: string | null;
} | null> {
  const vnindex = await loadVnindexCloses();
  if (vnindex.closes.length < 21) return null;
  const result = classifyRegime(vnindex.closes);
  const lastDate = vnindex.dates[vnindex.dates.length - 1] ?? null;
  return {
    regime: result.regime,
    label: result.label,
    asOf: lastDate ? lastDate.toISOString().slice(0, 10) : null,
  };
}

/**
 * F-13 (#129): posterior contextual cho chu kỳ — regime hiện tại đủ pulls
 * (≥ REGIME_MIN_PULLS) ở arm → dùng posterior regime; ngược lại bảng chung
 * (fallback khai báo — không bịa ngữ cảnh). evidence.ts thay thế map
 * posteriorByCode cũ bằng hàm này (một nguồn sự thật regime-aware).
 */
export async function posteriorByCodeForCycle(): Promise<Map<string, number>> {
  const arms = await db.banditArm.findMany().catch(() => []);
  const current = await currentMarketRegime().catch(() => null);
  const out = new Map<string, number>();
  for (const a of arms) {
    let mean = (a.alpha + 1) / (a.alpha + a.beta + 2);
    if (current && a.regimeStats) {
      try {
        const blocks = JSON.parse(a.regimeStats) as Record<
          string,
          { alpha?: unknown; beta?: unknown; pulls?: unknown }
        >;
        const blk = blocks[current.regime];
        if (
          blk &&
          typeof blk.alpha === "number" &&
          typeof blk.beta === "number" &&
          typeof blk.pulls === "number" &&
          blk.pulls >= REGIME_MIN_PULLS
        ) {
          mean = (blk.alpha + 1) / (blk.alpha + blk.beta + 2);
        }
      } catch {
        // regimeStats hỏng → bảng chung (fail-soft)
      }
    }
    out.set(a.agentCode, mean);
  }
  return out;
}

/**
 * F-13 (#129)(a): ghi AppSetting "market-regime" rolling (job settle 16:15
 * hằng ngày gọi) — {regime, label, asOf, vol20} cho UI/narrative.
 */
export async function persistMarketRegime(): Promise<{
  regime: MarketRegime;
  label: string;
} | null> {
  const vnindex = await loadVnindexCloses();
  if (vnindex.closes.length < 21) return null;
  const result = classifyRegime(vnindex.closes);
  const lastDate = vnindex.dates[vnindex.dates.length - 1] ?? null;
  try {
    await db.appSetting.upsert({
      where: { key: "market-regime" },
      create: {
        key: "market-regime",
        value: JSON.stringify({
          regime: result.regime,
          label: result.label,
          asOf: lastDate ? lastDate.toISOString().slice(0, 10) : null,
          vol20: Number(result.vol20.toFixed(4)),
          updatedAt: new Date().toISOString(),
        }),
      },
      update: {
        value: JSON.stringify({
          regime: result.regime,
          label: result.label,
          asOf: lastDate ? lastDate.toISOString().slice(0, 10) : null,
          vol20: Number(result.vol20.toFixed(4)),
          updatedAt: new Date().toISOString(),
        }),
      },
    });
  } catch (err) {
    console.error("[ml/bandit] persistMarketRegime lỗi (fail-soft):", err);
  }
  return { regime: result.regime, label: result.label };
}
