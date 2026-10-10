import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET/POST /api/market/engine-state — P0-5 (phiên #57 — DATA_PLATFORM_BLUEPRINT
 * v1.1 §4.2): state scheduler của market-engine chuyển vào `DataSourceStatus.meta`
 * (key "engine-state") — engine đọc lúc BOOT (restart không còn quên "hôm nay đã
 * sync EOD" / backoff intl), ghi sau mỗi sự kiện sync (eod · intl · reprobe).
 *
 * G7 §0.5: engine state in-memory — "kill engine → restart → không refetch EOD
 * đã xong hôm đó" là nghiệm thu P0-5. Route này là kênh đọc/ghi duy nhất —
 * engine không kết nối DB trực tiếp (mini-service tách bạch, chỉ HTTP).
 *
 * Lưu ý: dòng "engine-state" KHÔNG phải nguồn dữ liệu thị trường — phép kiểm
 * nguồn (v) của A9 đọc theo whitelist 7 nguồn có thật, bỏ qua dòng này.
 */

const STATE_KEY = "engine-state";
const STATE_LABEL = "Market-engine scheduler state (P0-5 — không phải nguồn dữ liệu)";

/** Các trường state engine quan tâm (meta JSON — merge từng sự kiện). */
interface EngineState {
  eodSyncDate?: string | null;
  intlSyncDate?: string | null;
  reprobeSunday?: string | null;
  intlFailStreak?: number;
  lastIntlFailAt?: number | null;
  lastEodSyncAt?: string | null;
  lastIntlSyncAt?: string | null;
  lastReprobeAt?: string | null;
  // A1/A4 (#79 — ML_OPS_BLUEPRINT §3): ngày đã settle/retrain + mốc chạy
  // gần nhất — engine hydrate lúc boot (restart không double-settle/retrain).
  lastSettleDate?: string | null;
  lastSettleAt?: string | null;
  lastMlTrainSunday?: string | null;
  lastMlTrainAt?: string | null;
  updatedAt?: string;
}

function parseMeta(raw: string | null): EngineState | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as EngineState;
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    const row = await db.dataSourceStatus.findUnique({ where: { key: STATE_KEY } });
    return NextResponse.json({
      ok: true,
      key: STATE_KEY,
      state: row ? parseMeta(row.meta) : null,
      updatedAt: row?.updatedAt ?? null,
    });
  } catch (err) {
    console.error("[api/market/engine-state] GET lỗi:", err);
    return NextResponse.json({ ok: false, state: null, error: "db" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const patch = (await request.json().catch(() => ({}))) as Partial<EngineState>;
    // Chỉ nhận các trường đã khai báo — chống ghi tùy ý (meta là chuỗi JSON)
    const allowed: (keyof EngineState)[] = [
      "eodSyncDate",
      "intlSyncDate",
      "reprobeSunday",
      "intlFailStreak",
      "lastIntlFailAt",
      "lastEodSyncAt",
      "lastIntlSyncAt",
      "lastReprobeAt",
      // A1/A4 (#79) — lịch settle 16:15 ICT + retrain CN 04:00 ICT (P0-5)
      "lastSettleDate",
      "lastSettleAt",
      "lastMlTrainSunday",
      "lastMlTrainAt",
    ];
    const clean: EngineState = { updatedAt: new Date().toISOString() };
    for (const k of allowed) {
      if (patch[k] !== undefined) (clean as Record<string, unknown>)[k] = patch[k];
    }
    const existing = await db.dataSourceStatus.findUnique({ where: { key: STATE_KEY } });
    const merged: EngineState = {
      ...(existing ? parseMeta(existing.meta) ?? {} : {}),
      ...clean,
    };
    await db.dataSourceStatus.upsert({
      where: { key: STATE_KEY },
      create: {
        key: STATE_KEY,
        label: STATE_LABEL,
        mode: "state", // không phải mode nguồn — A9 bỏ qua khi kiểm nguồn
        meta: JSON.stringify(merged),
      },
      update: {
        label: STATE_LABEL,
        meta: JSON.stringify(merged),
      },
    });
    return NextResponse.json({ ok: true, state: merged });
  } catch (err) {
    console.error("[api/market/engine-state] POST lỗi:", err);
    return NextResponse.json({ ok: false, error: "db" }, { status: 500 });
  }
}
