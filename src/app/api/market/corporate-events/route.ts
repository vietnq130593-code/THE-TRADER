import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";
import {
  scanCorporateEvents,
  isAutoAdjustEnabled,
  setAutoAdjustEnabled,
  reverseCorporateEvent,
} from "@/lib/corporate-events";

export const dynamic = "force-dynamic";
// F-611A-14/#61 — scan toàn VN (150+ mã × query bars 92 ngày) + khi có
// adjust chạy thêm full A9 (6 phép) — thực đo #60: ~10-60s, vượt maxDuration
// 120 cũ khi DB chậm. Đồng bộ 300 như eod-sync (cùng lớp tải).
export const maxDuration = 300;

/**
 * GET /api/market/corporate-events — danh sách CorporateEvent (P1-1) + trạng
 * thái kill-switch auto-adjust. Query (tuỳ chọn): ?limit=50&status=&symbol=.
 *
 * POST /api/market/corporate-events — chạy scan thủ công (pipeline P1-6 cũng
 * tự chạy sau mỗi eod-sync). Body (tuỳ chọn): { instrumentIds?: string[] }.
 * Cooldown 30s → 429 + Retry-After (pattern intl-sync).
 *
 * PUT /api/market/corporate-events — 2 công cụ an toàn (chốt 8-3b):
 *   { enabled: boolean }               → đặt kill-switch AppSetting
 *                                        "corporate-event-autoadjust";
 *   { reverseEventId: "cuid..." }      → đảo ngược 1 auto-adjust từ AuditLog
 *                                        pre-values (status → REVERSED — scan
 *                                        KHÔNG tự adjust lại sự kiện này).
 */
const COOLDOWN_MS = 30_000;
let lastScanAt = 0;

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") ?? 50) || 50));
    const status = url.searchParams.get("status");
    const symbol = url.searchParams.get("symbol");

    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (symbol) where.instrument = { symbol };

    const [events, total, enabled] = await Promise.all([
      db.corporateEvent.findMany({
        where,
        orderBy: [{ date: "desc" }],
        take: limit,
        include: { instrument: { select: { symbol: true, market: true } } },
      }),
      db.corporateEvent.count({ where }),
      isAutoAdjustEnabled(),
    ]);

    return NextResponse.json(
      toPlain({
        ok: true,
        total,
        enabled,
        // F-612R-10/#61 (Vòng 2) — parse per-row có guard: 1 ô detail hỏng
        // JSON không nên 500 cả danh sách (pattern parse() của data-quality)
        events: events.map((e) => {
          let detail: unknown = {};
          try {
            detail = JSON.parse(e.detail || "{}");
          } catch {
            detail = { parseError: true, raw: (e.detail ?? "").slice(0, 120) };
          }
          return {
            id: e.id,
            symbol: e.instrument.symbol,
            market: e.instrument.market,
            date: e.date,
            kind: e.kind,
            ratio: e.ratio,
            status: e.status,
            source: e.source,
            detail,
            createdAt: e.createdAt,
          };
        }),
      })
    );
  } catch (err) {
    console.error("[api/market/corporate-events] GET lỗi:", err);
    return NextResponse.json({ ok: false, error: "db" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const now = Date.now();
  const sinceLast = now - lastScanAt;
  if (sinceLast < COOLDOWN_MS) {
    const retryAfterSeconds = Math.ceil((COOLDOWN_MS - sinceLast) / 1000);
    return NextResponse.json(
      { error: `Scan vừa chạy cách đây ${Math.floor(sinceLast / 1000)}s. Đợi ${retryAfterSeconds}s.` },
      { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } }
    );
  }
  lastScanAt = now;
  try {
    const body = (await req.json().catch(() => ({}))) as { instrumentIds?: unknown };
    const instrumentIds =
      Array.isArray(body.instrumentIds) &&
      body.instrumentIds.every((v) => typeof v === "string")
        ? (body.instrumentIds as string[])
        : undefined;

    const result = await scanCorporateEvents({ instrumentIds });
    return NextResponse.json(toPlain({ ok: true, result }));
  } catch (err) {
    lastScanAt = 0;
    console.error("[api/market/corporate-events] POST lỗi:", err);
    return NextResponse.json(
      { ok: false, error: "Scan sự kiện doanh nghiệp thất bại — xem log server." },
      { status: 500 }
    );
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      enabled?: unknown;
      reverseEventId?: unknown;
    };

    if (typeof body.enabled === "boolean") {
      await setAutoAdjustEnabled(body.enabled);
      return NextResponse.json({
        ok: true,
        enabled: body.enabled,
        note: body.enabled
          ? "Auto-adjust CorporateEvent ĐÃ BẬT (heuristic mức CAO sẽ tự sửa giá kèm AuditLog)"
          : "Auto-adjust CorporateEvent ĐÃ TẮT — scan chỉ ghi SUSPECTED, không sửa giá",
      });
    }

    if (typeof body.reverseEventId === "string" && body.reverseEventId.length > 0) {
      const result = await reverseCorporateEvent(body.reverseEventId);
      // F-1091-07 (fixbug api #109): map httpStatus từ lib — 404 (event/audit
      // không tồn tại) · 409 (đã REVERSED) · 400 (lỗi pre-values) thay vì
      // flatten mọi thất bại thành 400 như trước.
      return NextResponse.json(result, {
        status: result.ok ? 200 : (result.httpStatus ?? 400),
      });
    }

    return NextResponse.json(
      { ok: false, error: "Body cần { enabled: boolean } hoặc { reverseEventId: string }." },
      { status: 400 }
    );
  } catch (err) {
    console.error("[api/market/corporate-events] PUT lỗi:", err);
    return NextResponse.json({ ok: false, error: "db" }, { status: 500 });
  }
}
