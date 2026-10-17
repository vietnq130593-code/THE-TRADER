import { db } from "@/lib/db";

/**
 * Data-source status registry (S4 stale marking — DATA_SOURCES.md §4.2/§6).
 *
 * Mỗi nguồn dữ liệu có một dòng DataSourceStatus duy nhất (theo `key`) ghi
 * chế độ hiện tại: live | simulated | fallback | paper. Nguyên tắc fallback:
 * "serve last cached + mark stale" — không bao giờ render dữ liệu chết như
 * dữ liệu sống.
 */

// F-02 Pha A (#129-D): nguồn vĩ mô VN có 2 chế độ riêng ngoài 5 chế độ nguồn
// giá — "extracted" (đã có ≥1 MacroObservation trích từ tin tức, Pha A) và
// "pending" (đã khai báo chuỗi nhưng chưa trích được số nào). Q13: stale của
// chuỗi vĩ mô đo THEO TẦN SUẤT (monthly > 45 ngày / quarterly > 120 ngày —
// xem macroSeriesSnapshot trong src/lib/macro-vn.ts), KHÔNG dùng ngưỡng
// 30 phút của nguồn giá → staleOf cố tình trả stale=false cho 2 chế độ này
// (rơi vào nhánh mặc định cuối hàm).
export type SourceMode =
  | "live"
  | "real"
  | "simulated"
  | "fallback"
  | "paper"
  | "extracted"
  | "pending";

export interface SourceDef {
  key: string;
  label: string;
  defaultMode: SourceMode;
}

export const SOURCE_DEFS: SourceDef[] = [
  { key: "eod-history", label: "Lịch sử giá EOD thật (VNDIRECT)", defaultMode: "fallback" },
  { key: "market-quotes", label: "Bảng giá VN30", defaultMode: "simulated" },
  { key: "news", label: "Tin tức thị trường", defaultMode: "fallback" },
  { key: "foreign-flows", label: "Dòng khối ngoại", defaultMode: "simulated" },
  { key: "trading", label: "Khớp lệnh", defaultMode: "paper" },
  // F-02 Pha A + F-16 (#129-D): chuỗi vĩ mô nội địa VN (CPI/GDP/SBV/…) —
  // trích xuất có trích dẫn từ tin tức; mode chuyển "extracted" khi ingest
  // đầu tiên ghi được MacroObservation (markSource trong src/lib/macro-vn.ts).
  { key: "macro-vn", label: "Chuỗi vĩ mô VN (trích xuất tin tức)", defaultMode: "pending" },
];

export interface SourceStatusRow {
  key: string;
  label: string;
  mode: SourceMode;
  lastSuccessAt: Date | null;
  lastError: string | null;
  meta: Record<string, unknown> | null;
  updatedAt: Date;
}

/** Upsert trạng thái một nguồn. `success=true` → ghi lastSuccessAt + xoá lỗi cũ. */
export async function markSource(
  key: string,
  patch: {
    mode?: SourceMode;
    success?: boolean;
    lastError?: string | null;
    meta?: Record<string, unknown>;
  }
): Promise<void> {
  const def = SOURCE_DEFS.find((d) => d.key === key);
  const label = def?.label ?? key;
  const now = new Date();
  await db.dataSourceStatus.upsert({
    where: { key },
    create: {
      key,
      label,
      mode: patch.mode ?? def?.defaultMode ?? "fallback",
      lastSuccessAt: patch.success === false ? null : now,
      lastError: patch.lastError ?? null,
      meta: patch.meta ? safeJson(patch.meta) : null,
    },
    update: {
      mode: patch.mode ?? undefined,
      lastSuccessAt: patch.success === false ? undefined : now,
      // F-611-02/#61 — success=true → XOÁ lỗi cũ (đúng như comment hợp đồng
      // khai báo từ đầu). Trước đây update chỉ ghi lastError khi caller truyền
      // rõ → 1 lần finfo chớp nettle ở tick (fallback path) để lastError dính
      // MÃI MÃI: S0 "nguồn lỗi: market-quotes" + registry P1-6 lastError
      // crying wolf mỗi chu kỳ dù nguồn đã hồi phục từ lâu.
      lastError:
        patch.lastError !== undefined
          ? patch.lastError
          : patch.success === true
            ? null
            : undefined, // không đổi (caller chỉ meta/mode)
      meta: patch.meta ? safeJson(patch.meta) : undefined,
    },
  });
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return "{}";
  }
}

function parseMeta(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Đọc toàn bộ trạng thái nguồn (tự tạo dòng mặc định nếu chưa có). */
export async function readSources(): Promise<SourceStatusRow[]> {
  const existing = await db.dataSourceStatus.findMany();
  const byKey = new Map(existing.map((s) => [s.key, s]));
  for (const def of SOURCE_DEFS) {
    if (!byKey.has(def.key)) {
      const created = await db.dataSourceStatus.create({
        data: { key: def.key, label: def.label, mode: def.defaultMode },
      });
      byKey.set(def.key, created);
    }
  }
  return SOURCE_DEFS.map((def) => {
    const s = byKey.get(def.key)!;
    return {
      key: s.key,
      label: s.label,
      mode: s.mode as SourceMode,
      lastSuccessAt: s.lastSuccessAt,
      lastError: s.lastError,
      meta: parseMeta(s.meta),
      updatedAt: s.updatedAt,
    };
  });
}

export interface StaleCheck {
  stale: boolean;
  ageMinutes: number | null;
}

/**
 * Quy tắc stale (DATA_SOURCES.md §6):
 * - mode "fallback" → luôn stale (đang dùng cache);
 * - mode "live" nhưng lastSuccessAt quá 30 phút → stale;
 * - mode "simulated"/"paper" → không stale (đã khai báo mô phỏng);
 * - mode "extracted"/"pending" (macro-vn, F-02A #129-D) → không stale theo
 *   ngưỡng nguồn giá — Q13 đo stale riêng THEO TẦN SUẤT CHUỖI ở
 *   macroSeriesSnapshot() (monthly > 45 ngày / quarterly > 120 ngày).
 */
export function staleOf(row: {
  mode: SourceMode;
  lastSuccessAt: Date | null;
}): StaleCheck {
  const ageMinutes = row.lastSuccessAt
    ? Math.floor((Date.now() - row.lastSuccessAt.getTime()) / 60_000)
    : null;
  if (row.mode === "fallback") return { stale: true, ageMinutes };
  if (row.mode === "live") return { stale: (ageMinutes ?? 999) > 30, ageMinutes };
  return { stale: false, ageMinutes };
}

/**
 * Escalate (§6.4): nguồn stale kéo dài quá 4 tiếng trong phiên → tạo
 * RiskAlert WARNING `DATA_SOURCE_STALE` (dedupe: tối đa 1 alert/24h).
 */
export async function escalateStaleSources(): Promise<number> {
  const sources = await readSources();
  let created = 0;
  for (const s of sources) {
    const { stale, ageMinutes } = staleOf(s);
    if (!stale || ageMinutes == null || ageMinutes < 240) continue;
    const since = new Date(Date.now() - 24 * 3_600_000);
    // F-119 (audit 19-b): dedupe THEO NGUỒN (code + metricKey) — trước đây chỉ
    // theo code nên 2 nguồn cùng stale thì nguồn thứ 2 không bao giờ có alert
    const dup = await db.riskAlert.findFirst({
      where: {
        code: "DATA_SOURCE_STALE",
        metricKey: `source.${s.key}.stale_minutes`,
        createdAt: { gte: since },
      },
      select: { id: true },
    });
    if (dup) continue;
    const alert = await db.riskAlert.create({
      data: {
        severity: "WARNING",
        code: "DATA_SOURCE_STALE",
        message: `Nguồn "${s.label}" stale hơn ${Math.floor(ageMinutes / 60)} giờ — hệ thống đang phục vụ bản cache cuối. Kiểm tra kết nối nguồn ngoài trước khi tiếp tục paper-run.`,
        metricKey: `source.${s.key}.stale_minutes`,
        metricValue: ageMinutes,
        threshold: 240,
      },
    });
    // F-206 (audit 19-b): phủ audit runtime cho mọi RiskAlert được tạo
    await db.auditLog
      .create({
        data: {
          action: "RISK_ALERT_RAISED",
          entity: "RiskAlert",
          entityId: alert.id,
          after: JSON.stringify({ code: alert.code, source: s.key, ageMinutes }),
        },
      })
      .catch(() => undefined);
    created++;
  }
  return created;
}
