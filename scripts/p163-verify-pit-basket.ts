/**
 * scripts/p163-verify-pit-basket.ts — KIỂM ĐỊNH W1 (#163): RỔ PIT TẠI CAST.
 *
 * Câu hỏi review #162: "Bandit reward chấm bằng rổ top-10 tính theo quote
 * volume MỚI NHẤT tại lúc settle — phi-PIT + sai định nghĩa rổ (P0-2)?"
 *
 * Kiểm định ĐO DB THẬT (read-only — KHÔNG settle, KHÔNG ghi gì):
 *   A. Lấy phiếu bầu PENDING già nhất + mới nhất đủ 5 phiên (chưa settled
 *      theo BanditEvent) → castDate từng phiếu theo mốc ICT.
 *   B. Rổ CŨ (trước vá): top-10 theo quote volume mới nhất tại lúc chạy —
 *      đúng cái settle cũ đã/đang dùng.
 *   C. Rổ MỚI (sau vá): top-10 ADTV-45 phiên EOD (Bar.value) tính tại
 *      castDate của từng phiếu — mirror topByAdtv P0-2.
 *   D. Đối chiếu: bao nhiêu mã khác nhau giữa 2 định nghĩa → chênh lệch là
 *      BẰNG CHỨNG nhãn realized nhiễu mà vá loại bỏ.
 *
 * Cách chạy: env -u DATABASE_URL bun scripts/p163-verify-pit-basket.ts
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const ICT_CLOSE_OFFSET_MS = 7 * 3_600_000;
const ictCloseMs = (d: Date): number => d.getTime() + ICT_CLOSE_OFFSET_MS;
const ADTV_SESSIONS = 45;
const ADTV_MIN_BARS = 10;
const LOOKBACK_DAYS = 85;
const BASKET_N = 10;

async function main(): Promise<void> {
  const symById = new Map<string, string>();
  const instruments = await db.instrument.findMany({
    where: { isActive: true, market: "HOSE", type: "STOCK" },
    select: { id: true, symbol: true },
  });
  for (const i of instruments) symById.set(i.id, i.symbol);

  // A. Phiếu pending đủ tuổi (≥5 phiên sau cast) — chọn 1 già + 1 mới
  const ids = await db.marketAssessment.findMany({
    orderBy: { createdAt: "desc" },
    take: 60,
    select: { id: true, createdAt: true },
  });
  const events = await db.banditEvent.findMany({
    where: { assessmentId: { in: ids.map((a) => a.id) } },
    select: { assessmentId: true, settledAt: true },
  });
  const settled = new Set(
    events.filter((e) => e.settledAt != null).map((e) => e.assessmentId)
  );
  const pending = ids.filter((a) => !settled.has(a.id));
  const dates = await db.bar.findMany({
    orderBy: { date: "desc" },
    distinct: ["date"],
    take: 40,
    select: { date: true },
  });
  const castOf = (createdAt: Date): Date | null =>
    dates.find((d) => ictCloseMs(d.date) <= createdAt.getTime())?.date ?? null;
  const futureOf = (createdAt: Date): number =>
    dates.filter((d) => ictCloseMs(d.date) >= createdAt.getTime()).length;
  const eligible = pending
    .map((a) => ({ ...a, castDate: castOf(a.createdAt) }))
    .filter((a) => a.castDate != null && futureOf(a.createdAt) >= 5);

  console.log(
    `Phiếu pending đủ 5 phiên chờ settle: ${eligible.length}/${pending.length} (pending tổng ${pending.length})`
  );
  if (eligible.length === 0) {
    console.log("Không có phiếu eligible — kiểm định rổ bằng mốc 10 phiên trước hôm nay.");
  }
  const anchors: { label: string; castDate: Date }[] = [];
  if (eligible.length > 0) {
    anchors.push({ label: "phiếu PENDING già nhất", castDate: eligible[eligible.length - 1].castDate! });
    anchors.push({ label: "phiếu PENDING mới nhất", castDate: eligible[0].castDate! });
  } else {
    const d = dates[9] ?? dates[0];
    if (d) anchors.push({ label: "mốc 10 phiên trước", castDate: d.date });
  }

  // B. Rổ CŨ — quote volume mới nhất (đúng logic settle trước vá)
  const withQuotes = await db.instrument.findMany({
    where: { isActive: true, market: "HOSE", type: "STOCK" },
    select: {
      id: true,
      quotes: { orderBy: { tradedAt: "desc" }, take: 1, select: { volume: true } },
    },
  });
  const oldBasket = withQuotes
    .map((i) => (i.quotes[0] ? { id: i.id, volume: i.quotes[0].volume } : null))
    .filter((r): r is { id: string; volume: number } => r !== null)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, BASKET_N)
    .map((r) => symById.get(r.id) ?? r.id);
  console.log(`\rổ CŨ (quote volume lúc chạy — settle cũ dùng cái này): ${oldBasket.join(", ")}`);

  // C. Rổ MỚI — ADTV-45 EOD tại từng castDate
  const from = new Date(
    Math.min(...anchors.map((a) => a.castDate.getTime())) - LOOKBACK_DAYS * 86_400_000
  );
  const to = new Date(Math.max(...anchors.map((a) => a.castDate.getTime())));
  const bars = await db.bar.findMany({
    where: { instrumentId: { in: [...symById.keys()] }, date: { gte: from, lte: to } },
    orderBy: [{ instrumentId: "asc" }, { date: "asc" }],
    select: { instrumentId: true, date: true, close: true, volume: true, value: true },
  });
  const seriesById = new Map<string, { ms: number; value: number }[]>();
  for (const b of bars) {
    if (!(b.close > 0)) continue;
    const value = b.value != null ? Number(b.value) : b.close * b.volume;
    if (!(value > 0)) continue;
    const arr = seriesById.get(b.instrumentId) ?? [];
    arr.push({ ms: b.date.getTime(), value });
    seriesById.set(b.instrumentId, arr);
  }

  let anyDiff = false;
  for (const anchor of anchors) {
    const castMs = anchor.castDate.getTime();
    const ranked: { id: string; adtv: number }[] = [];
    for (const [id, arr] of seriesById) {
      const vals: number[] = [];
      for (let i = arr.length - 1; i >= 0 && vals.length < ADTV_SESSIONS; i--) {
        if (arr[i].ms > castMs) continue;
        vals.push(arr[i].value);
      }
      if (vals.length < ADTV_MIN_BARS) continue;
      ranked.push({ id, adtv: vals.reduce((s, v) => s + v, 0) / vals.length });
    }
    ranked.sort((a, b) => b.adtv - a.adtv);
    const newBasket = ranked.slice(0, BASKET_N).map((r) => symById.get(r.id) ?? r.id);
    const diff = newBasket.filter((s) => !oldBasket.includes(s)).length;
    anyDiff = anyDiff || diff > 0;
    console.log(
      `\rổ MỚI PIT tại ${anchor.castDate.toISOString().slice(0, 10)} (${anchor.label}): ${newBasket.join(", ")}`
    );
    console.log(
      `  → KHÁC rổ cũ ${diff}/${BASKET_N} mã${diff > 0 ? " — nhãn realized của phiếu này đã bị chấm lệch vũ trụ dưới logic cũ" : " — trùng hoàn toàn"}`
    );
  }
  console.log(
    anyDiff
      ? "\nKẾT LUẬN: BẰNG CHỨNG rổ trượt thành phần tồn tại thật — vá W1 loại nguồn nhiễu này."
      : "\nKẾT LUẬN: 2 định nghĩa đang trùng tại các mốc đo — vá vẫn đúng (chống trượt tương lai + thống nhất P0-2)."
  );
}

main()
  .catch((e) => {
    console.error("[p163-pit-basket] LỖI:", e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
