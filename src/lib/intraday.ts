/**
 * src/lib/intraday.ts — GOM TICK → BAR 5-PHÚT (bảng IntradayBar, phiên #83).
 *
 * ML_OPS_BLUEPRINT §5.2/§6 "Lớp chuỗi đầy đủ": Quote là latest-only (chỉ trạng
 * thái cuối mỗi mã) → hệ thống chưa có chuỗi giá tần suất phút cho lớp mô hình
 * chuỗi (GRU gated đang khoá vì B2 FAIL ở tần suất NGÀY). Module này mở độ
 * phân giải thời gian THỨ HAI: mỗi tick S4 (10s) gom vào bucket 5-phút theo
 * đồng hồ ICT (floor UTC 5-phút — lệch ICT tròn giờ nên biên trùng khớp),
 * upsert IntradayBar khi bucket đóng + safety-flush 2 phút (restart mất tối
 * đa 2 phút bucket đang chạy — tickCount lộ độ phủ, trung thực).
 *
 * Thiết kế (pattern Perf #64 của tick route):
 *   - recordIntradayTick(): THUẦN cache in-process (0 DB) — merge high/low/
 *     close/volume-delta vào bucket hiện tại; bucket chuyển biên → bucket cũ
 *     lọt hàng flush. volume = DELTA khối lượng dồn phiên (Q3 chỉ tăng ⇒ ≥0).
 *   - flushIntradayBuckets(): upsert chunk 10 — bucket ĐÓNG ghi 1 lần cuối;
 *     bucket ĐANG CHẠY safety-flush mỗi 120s.
 *   - flushAllIntradayBuckets(): dồn toàn bộ (tick ngoài phiên — đóng sổ ngày).
 *
 * Trung thực nguồn (không bịa dữ liệu): source = "realtime-finfo" khi bucket
 * có ≥1 tick giá thật finfo, ngược lại "simulated" (random-walk quanh ref EOD
 * thật — đúng DataSourceStatus mode hiện tại của tick engine).
 *
 * Fail-soft: mọi lỗi DB chỉ log + trả false — KHÔNG bao giờ làm hỏng tick
 * (tick nuôi WS bảng giá + paper matching — quan trọng hơn bar 5-phút).
 */

import { db } from "@/lib/db";

// ─────────────────────────── Hằng số ───────────────────────────

/** Bucket 5-phút — "intraday 5-phút" chốt ở ML_OPS_BLUEPRINT §6/B4. */
export const INTRADAY_BUCKET_MS = 5 * 60_000;
/** Safety-flush bucket đang chạy mỗi 120s (mất tối đa 2 phút khi restart). */
const SAFETY_FLUSH_MS = 120_000;
/** Chunk ghi DB (pattern Perf #64 — pool WAN an toàn). */
const WRITE_CHUNK = 10;

// ─────────────────────────── Bucket cache in-process ───────────────────────────

interface BucketState {
  instrumentId: string;
  startTime: Date; // mốc UTC bắt đầu bucket (floor 5-phút)
  date: Date; // ngày phiên ICT (neo `${iso}T15:00:00.000Z` — cùng Bar)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // delta KLGD dồn phiên trong bucket
  tickCount: number;
  hasRealtime: boolean;
  lastFlushAt: number;
  /** true = bucket đã đóng (chuyển biên) — flush lần cuối rồi xoá. */
  closed: boolean;
}

/** Cache theo instrumentId — 1 bucket đang chạy/mã. */
const buckets = new Map<string, BucketState>();
/** Bucket đóng + bucket đủ hạn safety-flush — chờ ghi DB. */
const flushQueue: BucketState[] = [];

/** Mốc bucket bắt đầu (floor UTC 5-phút — biên trùng khớp ICT tròn giờ). */
export function bucketStartOf(at: Date): Date {
  return new Date(Math.floor(at.getTime() / INTRADAY_BUCKET_MS) * INTRADAY_BUCKET_MS);
}

export interface IntradayTickInput {
  instrumentId: string;
  /** ISO ngày phiên ICT (vnDateIso của tick) — neo date của bucket. */
  tradingDayIso: string;
  /** Giá tick (đã round100 + clamp dải theo Q1/Q2 của tick route). */
  price: number;
  /** Delta khối lượng dồn phiên của tick này (≥ 0 — Q3). */
  volDelta: number;
  /** true khi giá tick đến từ finfo realtime (nguồn thật). */
  isRealtime: boolean;
  /** Thời điểm tick (dùng floor bucket + đánh giá safety-flush). */
  at?: Date;
}

/**
 * Gom 1 tick vào bucket (THUẦN cache — 0 DB call). Trả số bucket đang chờ
 * flush sau lần gom này (caller flushIntradayBuckets khi tiện — thường cuối
 * vòng tick).
 */
export function recordIntradayTick(input: IntradayTickInput): number {
  if (!(input.price > 0)) return flushQueue.length;
  const at = input.at ?? new Date();
  const start = bucketStartOf(at);
  const volDelta = Math.max(0, Math.round(input.volDelta));
  const cur = buckets.get(input.instrumentId);

  if (cur && cur.startTime.getTime() === start.getTime()) {
    // Cùng bucket — merge OHLCV
    cur.high = Math.max(cur.high, input.price);
    cur.low = Math.min(cur.low, input.price);
    cur.close = input.price;
    cur.volume += volDelta;
    cur.tickCount += 1;
    cur.hasRealtime = cur.hasRealtime || input.isRealtime;
    if (at.getTime() - cur.lastFlushAt >= SAFETY_FLUSH_MS && !cur.closed) {
      flushQueue.push(cur);
      cur.lastFlushAt = at.getTime();
    }
  } else {
    // Bucket mới (phiên đầu tiên / chuyển biên 5-phút / sang ngày) — bucket
    // cũ (nếu có) đóng sổ lọt hàng flush lần cuối.
    if (cur && !cur.closed) {
      cur.closed = true;
      flushQueue.push(cur);
    }
    buckets.set(input.instrumentId, {
      instrumentId: input.instrumentId,
      startTime: start,
      date: new Date(`${input.tradingDayIso}T15:00:00.000Z`),
      open: input.price,
      high: input.price,
      low: input.price,
      close: input.price,
      volume: volDelta,
      tickCount: 1,
      hasRealtime: input.isRealtime,
      lastFlushAt: at.getTime(),
      closed: false,
    });
  }
  return flushQueue.length;
}

/** Đổi BucketState → payload upsert Prisma (create/update cùng giá trị —
 *  bucket chạy lại từ đầu process sau restart sẽ ghi đè trung thực phần
 *  process mới nhìn thấy; tickCount lộ độ phủ thật). */
function toUpsert(b: BucketState) {
  const value = BigInt(Math.max(0, Math.round(b.volume))) * BigInt(Math.max(0, Math.round(b.close)));
  const data = {
    instrumentId: b.instrumentId,
    date: b.date,
    startTime: b.startTime,
    open: Math.round(b.open),
    high: Math.round(b.high),
    low: Math.round(b.low),
    close: Math.round(b.close),
    volume: Math.max(0, Math.round(b.volume)),
    value,
    source: b.hasRealtime ? "realtime-finfo" : "simulated",
    tickCount: b.tickCount,
  };
  return {
    where: {
      instrumentId_startTime: {
        instrumentId: b.instrumentId,
        startTime: b.startTime,
      },
    },
    create: data,
    update: {
      open: data.open,
      high: data.high,
      low: data.low,
      close: data.close,
      volume: data.volume,
      value: data.value,
      source: data.source,
      tickCount: data.tickCount,
    },
  };
}

/** Số bucket chờ ghi (test/telemetry). */
export function pendingIntradayFlushes(): number {
  return flushQueue.length;
}

/**
 * Ghi DB các bucket chờ (chunk 10 — pattern Perf #64). Bucket đóng → xoá khỏi
 * cache sau khi ghi. Fail-soft từng bucket (lỗi 1 bucket không chặn phần còn
 * lại; bucket lỗi giữ trong queue thử lần tick sau). Trả số bucket ghi thành công.
 */
export async function flushIntradayBuckets(): Promise<number> {
  let written = 0;
  // Mượn toàn bộ queue — bucket lỗi đẩy lại cuối hàng
  const queue = flushQueue.splice(0, flushQueue.length);
  for (let i = 0; i < queue.length; i += WRITE_CHUNK) {
    const chunk = queue.slice(i, i + WRITE_CHUNK);
    const results = await Promise.all(
      chunk.map(async (b) => {
        try {
          await db.intradayBar.upsert(toUpsert(b));
          return { ok: true as const, b };
        } catch (err) {
          console.error(
            `[intraday] upsert bucket ${b.instrumentId} @ ${b.startTime.toISOString()} lỗi (thử lại tick sau):`,
            err instanceof Error ? err.message : err
          );
          return { ok: false as const, b };
        }
      })
    );
    for (const r of results) {
      if (r.ok) {
        written++;
        // Chỉ xoá khỏi cache khi map ĐANG GIỮ ĐÚNG object này — sau chuyển
        // biên, entry trong map đã là bucket MỚI (buckets.set thay thế), xoá
        // mù theo instrumentId sẽ MẤT bucket mới (bug bắt bằng intraday-verify
        // #83: bucket 09:05 mất tick đầu sau khi flush bucket 09:00 đóng).
        if (r.b.closed && buckets.get(r.b.instrumentId) === r.b) {
          buckets.delete(r.b.instrumentId);
        }
      } else {
        flushQueue.push(r.b); // thử lại lần flush sau
      }
    }
  }
  return written;
}

/** Đóng sổ + ghi TOÀN BỘ bucket đang chạy (tick ngoài phiên — cuối ngày). */
export async function flushAllIntradayBuckets(): Promise<number> {
  for (const b of buckets.values()) {
    if (!b.closed) {
      b.closed = true;
      flushQueue.push(b);
    }
  }
  return flushIntradayBuckets();
}

// ─────────────────────────── Thống kê (ml/status — cổng chuỗi §6) ───────────────────────────

export interface IntradayStats {
  bars: number;
  symbols: number;
  tradingDays: number;
  lastBarAt: Date | null;
  /** Số bar của ngày gần nhất (tiến độ thu thập phiên hiện tại). */
  lastDayBars: number;
  simulated: number;
  realtime: number;
}

/** Đo số liệu bảng intraday — dữ liệu cổng "Lớp chuỗi đầy đủ" quyết định re-đo B2. */
export async function intradayStats(): Promise<IntradayStats> {
  try {
    const [bars, symbols, days, last, lastDay] = await Promise.all([
      db.intradayBar.count(),
      db.intradayBar.groupBy({ by: ["instrumentId"] }).then((g) => g.length),
      db.intradayBar.groupBy({ by: ["date"] }).then((g) => g.length),
      db.intradayBar.findFirst({ orderBy: { startTime: "desc" }, select: { startTime: true } }),
      db.intradayBar.findFirst({ orderBy: { date: "desc" }, select: { date: true } }),
    ]);
    const [lastDayBars, simulated, realtime] = lastDay
      ? await Promise.all([
          db.intradayBar.count({ where: { date: lastDay.date } }),
          db.intradayBar.count({ where: { source: "simulated" } }),
          db.intradayBar.count({ where: { source: "realtime-finfo" } }),
        ])
      : [0, 0, 0];
    return {
      bars,
      symbols,
      tradingDays: days,
      lastBarAt: last?.startTime ?? null,
      lastDayBars,
      simulated,
      realtime,
    };
  } catch {
    return {
      bars: 0,
      symbols: 0,
      tradingDays: 0,
      lastBarAt: null,
      lastDayBars: 0,
      simulated: 0,
      realtime: 0,
    };
  }
}
