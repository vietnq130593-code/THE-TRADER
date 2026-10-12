import { NextRequest, NextResponse } from "next/server";
import { toPlain } from "@/lib/serialize";
import { db } from "@/lib/db";
import {
  INTL_RANGES,
  DEFAULT_INTL_RANGE,
} from "@/lib/intl-eod";
import { syncMultiMarkets } from "@/lib/multi-market-sync";
import { runPostIngestChecks } from "@/lib/ingest-pipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/market/intl-sync — đồng bộ ĐA THỊ TRƯỜNG #106
 * (COUNCIL_STEWARDSHIP_BLUEPRINT §2.3): 3 adapter nhanh (Treasury CSV trái
 * phiếu · Frankfurter forex majors · er-api USD/VND) + Yahoo query2 (hàng
 * hoá + cổ phiếu US/HK + forex phụ) — orchestrator syncMultiMarkets.
 *
 * Body (tuỳ chọn): { range?: string } — whitelist 5d|1mo|3mo|6mo|1y|2y|auto,
 * mặc định "auto": universe phi-VN chưa có bar → "1y" (backfill lần đầu),
 * đã có → "5d" (đủ cho sync hằng ngày 06:15 ICT). Sai whitelist → 400.
 * Được market-engine gọi 06:15 ICT và có thể trigger thủ công. Cooldown 30s
 * giữa 2 lần gọi → 429 kèm Retry-After (pattern /api/assessment/synthesize).
 */
const COOLDOWN_MS = 30_000;
let lastSyncAt = 0;

/** F-441-01 (#44) — mutex in-process: 1 sync chạy tại 1 thời điểm.
 * Trước đây cooldown tính từ lúc BẮT ĐẦU request nên caller cách 60s vẫn lọt
 * qua trong khi lần cũ chưa xong (route ~2-3 phút) → nhiều sync chồng lấn
 * cùng đấm Yahoo 429. Kể từ #44: request mới khi sync đang chạy → 429 ngay. */
let inFlight = false;

export async function POST(req: NextRequest) {
  const now = Date.now();
  if (inFlight) {
    return NextResponse.json(
      { error: "Đồng bộ EOD quốc tế đang chạy (mutex F-441-01) — vui lòng đợi hoàn tất." },
      { status: 429, headers: { "Retry-After": "60" } }
    );
  }
  const sinceLast = now - lastSyncAt;
  if (sinceLast < COOLDOWN_MS) {
    const retryAfterSeconds = Math.ceil((COOLDOWN_MS - sinceLast) / 1000);
    return NextResponse.json(
      {
        error: `Đồng bộ EOD quốc tế vừa chạy cách đây ${Math.floor(sinceLast / 1000)}s. Vui lòng đợi ${retryAfterSeconds}s rồi thử lại.`,
        retryAfterSeconds,
      },
      {
        status: 429,
        headers: { "Retry-After": String(retryAfterSeconds) },
      }
    );
  }

  // Body { range } — tolerant: body rỗng/JSON hỏng dùng default "auto"
  let range: string = "auto";
  try {
    const body = (await req.json()) as { range?: unknown } | null;
    if (body && typeof body.range === "string" && body.range.length > 0) {
      range = body.range;
    }
  } catch {
    // body rỗng — giữ default
  }
  // "auto": chưa có bar phi-VN → backfill "1y"; đã có → "5d" (job 06:15)
  // #106 — đếm cả 4 thị trường phi-VN (US/HK/FOREX/COMMODITY/BOND): chỉ cần
  // 1 rổ còn trống là cần backfill (Treasury/Frankfurter tự lấy đủ lịch sử
  // riêng của chúng bất kể range — range chỉ điều khiển nhịp Yahoo).
  if (range === "auto") {
    const intlBars = await db.bar
      .count({
        where: {
          instrument: { market: { in: ["US", "HK", "FOREX", "COMMODITY", "BOND"] } },
        },
      })
      .catch(() => 0);
    range = intlBars > 0 ? "5d" : DEFAULT_INTL_RANGE;
  }
  if (!INTL_RANGES.includes(range)) {
    return NextResponse.json(
      { error: `range "${range}" không hợp lệ (${INTL_RANGES.join(" | ")} | auto).` },
      { status: 400 }
    );
  }

  lastSyncAt = now;
  inFlight = true;
  try {
    // #106 — orchestrator đa thị trường: 3 adapter nhanh chạy TRƯỚC (Treasury
    // CSV / Frankfurter / er-api — không quota), Yahoo query2 sau cùng. Mọi
    // adapter fail-soft độc lập; kết quả trả đủ 4 khối để audit.
    const multi = await syncMultiMarkets({ yahooRange: range });
    const outcome = multi.yahoo ?? null;
    // Cooldown tính từ lúc HOÀN THÀNH (F-441-01) — không phải lúc bắt đầu
    lastSyncAt = Date.now();
    // P1-6 — chuỗi hậu kiểm một cửa: A9-check cấu trúc cho các mã vừa nạp
    // (US/HK KHÔNG gap-infer — CorporateEvent US/HK đã parse từ payload events
    // bên trong syncIntlEod, P1-1 — nên ở đây TẮT scan gap-infer VN)
    const postCheck = await runPostIngestChecks({
      route: "intl-sync",
      instrumentIds: await intlInstrumentIds(),
      includeCorporateScan: false,
    }).catch((err) => {
      console.error("[api/market/intl-sync] postIngestChecks lỗi (bỏ qua):", err);
      return null;
    });
    // Universe phi-VN chưa seed → kèm note hướng dẫn (outcome vẫn ok=true)
    const anyBars =
      multi.treasury.barsUpserted +
      multi.frankfurter.barsUpserted +
      multi.erapi.barsUpserted +
      (outcome?.barsUpserted ?? 0);
    const note =
      anyBars === 0
        ? "Chạy prisma/expand-universe.ts --intl + scripts/p106-seed-markets.ts để seed universe phi-VN trước"
        : undefined;
    const ok =
      multi.treasury.ok &&
      multi.frankfurter.ok &&
      multi.erapi.ok &&
      (outcome?.ok ?? true);
    const payload = {
      treasury: multi.treasury,
      frankfurter: multi.frankfurter,
      erapi: multi.erapi,
      yahoo: outcome,
      durationMs: multi.durationMs,
      ...(note ? { note } : {}),
    };
    return NextResponse.json(toPlain(postCheck ? { ...payload, postCheck } : payload), {
      status: ok ? 200 : 502,
    });
  } catch (err) {
    // Lỗi hệ thống (throw) — cho phép retry ngay, không giữ cooldown vô ích
    lastSyncAt = 0;
    console.error("[api/market/intl-sync] POST failed:", err);
    return NextResponse.json(
      { error: "Đồng bộ EOD quốc tế thất bại — xem log server để biết chi tiết." },
      { status: 500 }
    );
  } finally {
    inFlight = false;
  }
}

/** Id các instrument phi-VN active (tập hậu kiểm P1-6 của route này). */
async function intlInstrumentIds(): Promise<string[]> {
  const rows = await db.instrument
    .findMany({
      where: {
        isActive: true,
        market: { in: ["US", "HK", "FOREX", "COMMODITY", "BOND"] },
      },
      select: { id: true },
    })
    .catch(() => [] as { id: string }[]);
  return rows.map((r) => r.id);
}
