/**
 * src/lib/ml/bandit.ts — THOMPSON SAMPLING Beta-Bernoulli cho 6 arm =
 * 5 LLM research agents + ml-forecast (phiên #35 · B7 #38). KHÔNG gọi LLM,
 * KHÔNG dependencies.
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

/** 6 arm Thompson sampling = 5 agent LLM có phiếu assessment + ml-forecast (B7). */
export const BANDIT_ARM_CODES = [
  "market-analyst",
  "fair-value",
  "news-sentiment",
  "liquidity",
  "risk-manager",
  "ml-forecast",
] as const;

/** Số phiên chờ trước khi kết toán reward. */
const SETTLE_SESSIONS = 5;
/** Ngưỡng realized direction của rổ (±0,5%). */
const SETTLE_THRESHOLD = 0.005;
/** Số mã tối thiểu có giá tại 2 mốc thời gian để kết toán. */
const SETTLE_MIN_SYMBOLS = 3;
/** Quét N assessment gần nhất khi kết toán (phiếu cũ hơn coi như bỏ quên). */
const SETTLE_SCAN_LIMIT = 30;

/** Phiếu bầu của một agent trong assessment (B7: kèm confidence cho Brier B8). */
interface CastVote {
  code: string;
  direction: "UP" | "DOWN" | "FLAT";
  /** 0..1 — lưu vào BanditEvent.confidence lúc settle (ml-forecast = max(pUp,pDown,pFlat)). */
  confidence?: number;
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

/** Upsert 6 BanditArm nếu thiếu (idempotent — gọi an toàn mọi nơi).
 * Perf #64: TRƯỚC fix upsert 6 arm TUẦN TỰ mỗi lần gọi (~600ms WAN — Comics
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
  armsEnsured = true;
}

/**
 * Đọc phiếu bầu từ detail JSON của assessment: hỗ trợ cả dạng detail
 * .agentVotes [{code, direction, confidence}] (persist #38 lưu kèm) và dạng
 * .drivers source "llm-vote:<code>" (cấu trúc cũ) — chỉ giữ phiếu 6 arm bandit.
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
      const row = v as { code?: unknown; direction?: unknown; confidence?: unknown };
      if (typeof row.code === "string" && isDir(row.direction)) {
        out.push({
          code: row.code,
          direction: row.direction,
          confidence:
            typeof row.confidence === "number" && Number.isFinite(row.confidence)
              ? Math.max(0, Math.min(1, row.confidence))
              : undefined,
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
  // Phiên cast của mỗi assessment = phiên giao dịch cuối tại/b trước khi bầu
  // (danh sách distinct desc — đủ cho 30 assessment trong quét)
  const pastDates = await db.bar.findMany({
    where: { date: { lte: pending[0].createdAt } },
    distinct: ["date"],
    orderBy: { date: "desc" },
    take: SETTLE_SCAN_LIMIT,
    select: { date: true },
  });

  // Rổ top-10 thanh khoản theo quote volume mới nhất — B5 §3.4: khoá về
  // HOSE-STOCK (chuỗi settle lịch sử + tránh volume index ~2,1 tỷ tràn vào top)
  const instruments = await db.instrument.findMany({
    where: { isActive: true, market: "HOSE", type: "STOCK" },
    select: {
      id: true,
      quotes: { orderBy: { tradedAt: "desc" }, take: 1, select: { volume: true } },
    },
  });
  const topIds = instruments
    .map((i) => (i.quotes[0] ? { id: i.id, volume: i.quotes[0].volume } : null))
    .filter((r): r is { id: string; volume: number } => r !== null)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 10)
    .map((r) => r.id);

  let settled = 0;
  let votes = 0;
  const details: NonNullable<SettleResult["details"]> = [];

  for (const a of pending) {
    const votesForAssessment = votesOf(a).filter(
      (v) => !settledKeys.has(`${a.id}:${v.code}`)
    );
    if (votesForAssessment.length === 0) continue;

    // Đủ 5 phiên giao dịch sau createdAt chưa?
    const after = futureDates.filter((f) => f.date >= a.createdAt).slice(0, SETTLE_SESSIONS);
    const castDate = pastDates.find((d) => d.date <= a.createdAt)?.date;
    if (after.length < SETTLE_SESSIONS || castDate == null) continue;
    const realizedDate = after[SETTLE_SESSIONS - 1].date;

    // Realized direction rổ top-10: equal-weight ret mỗi mã cast → realized
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

      await db.banditEvent.upsert({
        where: { assessmentId_agentCode: { assessmentId: a.id, agentCode: v.code } },
        update: {
          settledAt: new Date(),
          reward,
          direction: v.direction,
          // B8 — độ tự tin phiếu khi cast → đầu vào Brier score (nếu có lưu)
          ...(v.confidence != null ? { confidence: v.confidence } : {}),
        },
        create: {
          assessmentId: a.id,
          agentCode: v.code,
          direction: v.direction,
          castAt: a.createdAt,
          settledAt: new Date(),
          reward,
          ...(v.confidence != null ? { confidence: v.confidence } : {}),
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
  }[];
  lastSettleAt: Date | null;
}> {
  await ensureArms();
  // Perf #64 — 2 query độc lập chạy parallel (trước fix tuần tự 2 RTT)
  const [arms, agg] = await Promise.all([
    db.banditArm.findMany(),
    db.banditEvent.aggregate({ _max: { settledAt: true } }),
  ]);
  const mapped = arms.map((a) => {
    const roster = ROSTER_BY_CODE.get(a.agentCode);
    return {
      agentCode: a.agentCode,
      name: roster?.name ?? a.agentCode,
      alpha: a.alpha,
      beta: a.beta,
      pulls: a.pulls,
      wins: a.wins,
      posteriorMean: Number(((a.alpha + 1) / (a.alpha + a.beta + 2)).toFixed(4)),
    };
  });
  mapped.sort((x, y) => y.posteriorMean - x.posteriorMean);
  return { arms: mapped, lastSettleAt: agg._max.settledAt };
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
