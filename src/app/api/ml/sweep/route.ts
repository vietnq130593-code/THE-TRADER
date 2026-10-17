import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isTrainInFlight } from "@/lib/ml/train-mlp";
import { logMlAudit } from "@/lib/ml/tuning";
import {
  readSweepConfig,
  runSweepOnce,
  sanitizeSweepConfigInput,
  writeSweepConfig,
  type SweepChampionInfo,
} from "@/lib/ml/sweep";
// F-18B (#132) — arch-string serving từ weights (parser chuẩn nn.ts).
import { mlpArchString, parseMlpArch } from "@/lib/ml/nn";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
export const runtime = "nodejs";

/**
 * GET/POST /api/ml/sweep — C1 (#99 · ML_AUTOML_BLUEPRINT §4.5/§4.7).
 *
 * GET: cấu hình AppSetting "ml-sweep" + snapshot bản serving dl-mlp + 10
 * đợt SweepRun gần nhất (champion board đầy đủ logJson parse sẵn). Tham số
 * `?configOnly=1` → CHỈ config + serving (payload nhẹ — engine tick 60s
 * đọc kill-switch enabled, không kéo logJson dài).
 *
 * POST (2 action — phân biệt bằng body.action):
 *  - {action: "config", config: {…}} — CẬP NHẬT cấu hình (semantic partial
 *    như tuning route: chỉ trường được cung cấp; sai phạm vi → 422 kèm
 *    fields[]). Quy ước CHỌN: config-update đi qua POST action "config"
 *    (thay vì thêm PUT riêng) — một route một nguồn, FE gọi như POST tuning.
 *  - mặc định (không action) — CHẠY ĐỢT: body {force?: boolean (mặc định
 *    TRUE — nút tay bỏ qua skip-guard), budget?: number (clamp 1..64, ghi
 *    nguyên budget đã xin vào SweepRun.candidates)}. Mutex dùng chung với
 *    train route (F2) đang giữ → 429 kèm Retry-After. Skip-guard (force
 *    false, đường engine CN 04:15 ICT) → 200 {ok, skipped, reason} KHÔNG
 *    tạo hàng. Toàn bộ ghi DB đi qua runSweepOnce (một cửa — route không
 *    tự viết SweepRun/MlModel).
 *
 * POST chạy đợt được phép BẤT KỂ ml-sweep.enabled (nút tay = deterministic
 * + cổng 4 điều kiện — không thể "câu" kết quả); đường ENGINE tự kiểm
 * enabled (kill-switch §1.6) qua GET ?configOnly=1 trước khi bắn POST.
 */

/** Snapshot bản serving dl-mlp cho GET (fail-soft từng trường). */
async function servingSnapshot(): Promise<{
  version: number;
  valAcc: number | null;
  featureSet: string;
  windowHash: string | null;
  /** F-18B (#132) — arch-string thật ("10-16-8-3") từ weights JSON; null khi
   * weights không parse được (FE ẩn ô arch, không phóng đo). */
  archString: string | null;
} | null> {
  try {
    const row = await db.mlModel.findFirst({
      where: { kind: "dl-mlp", status: "serving" },
      orderBy: { version: "desc" },
      select: { version: true, metrics: true, meta: true, weights: true },
    });
    if (!row) return null;
    let valAcc: number | null = null;
    let featureSet = "v1-lag10";
    let windowHash: string | null = null;
    let archString: string | null = null;
    try {
      const m = JSON.parse(row.metrics) as { valAcc?: unknown };
      if (typeof m.valAcc === "number" && Number.isFinite(m.valAcc)) valAcc = m.valAcc;
    } catch {
      // metrics hỏng → null trung thực
    }
    if (row.meta) {
      try {
        const m = JSON.parse(row.meta) as { featureSet?: unknown; windowHash?: unknown };
        if (typeof m.featureSet === "string") featureSet = m.featureSet;
        if (typeof m.windowHash === "string") windowHash = m.windowHash;
      } catch {
        // meta hỏng → giữ mặc định
      }
    }
    // F-18B (#132) — arch từ weights (chuẩn hoá qua parser nn.ts).
    if (row.weights) {
      try {
        const w = JSON.parse(row.weights) as { arch?: unknown };
        if (typeof w.arch === "string") archString = mlpArchString(parseMlpArch(w.arch));
      } catch {
        // weights hỏng → null trung thực
      }
    }
    return { version: row.version, valAcc, featureSet, windowHash, archString };
  } catch (err) {
    console.error("[api/ml/sweep] servingSnapshot lỗi (fail-soft):", err);
    return null;
  }
}

/** gateSummary tiện lợi cho UI (dẫn xuất từ championJson — không tính lại). */
function gateSummaryOf(champion: SweepChampionInfo | null): {
  pass: boolean;
  reasons: string[];
  deltaBrier: { mean: number; ciLow: number; ciHigh: number } | null;
  serving: { valAcc: number | null; paramCount: number | null; version: number | null } | null;
} | null {
  if (!champion) return null;
  return {
    pass: champion.swapProposed,
    reasons: champion.swapReason ? [champion.swapReason] : [],
    deltaBrier: champion.deltaBrier ?? null,
    serving: champion.serving ?? null,
  };
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const configOnly = url.searchParams.get("configOnly") === "1";
    const config = await readSweepConfig();
    const serving = await servingSnapshot();
    if (configOnly) {
      // Engine tick 60s (kill-switch §1.6) — payload tối thiểu.
      return NextResponse.json({ ok: true, config, serving });
    }
    const runs = await db.sweepRun.findMany({
      orderBy: { startedAt: "desc" },
      take: 10,
    });
    const mapped = runs.map((r) => {
      let champion: SweepChampionInfo | null = null;
      let log: unknown[] = [];
      if (r.championJson) {
        try {
          champion = JSON.parse(r.championJson) as SweepChampionInfo;
        } catch {
          champion = null; // JSON hỏng → trung thực null
        }
      }
      if (r.logJson) {
        try {
          const parsed = JSON.parse(r.logJson) as unknown;
          if (Array.isArray(parsed)) log = parsed;
        } catch {
          log = []; // JSON hỏng → bảng trống trung thực
        }
      }
      return {
        id: r.id,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        status: r.status,
        candidates: r.candidates,
        evaluated: r.evaluated,
        seed: r.seed,
        windowHash: r.windowHash,
        featureSet: r.featureSet,
        champion,
        gateSummary: gateSummaryOf(champion),
        // logJson parse sẵn cho champion board (card 3 FE — mọi ứng viên kể cả thua §2.10).
        log,
      };
    });
    return NextResponse.json({ ok: true, config, serving, runs: mapped });
  } catch (err) {
    console.error("[api/ml/sweep] GET lỗi:", err);
    return NextResponse.json(
      { ok: false, error: "Không tải được trạng thái sweep (lỗi DB)." },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    const parsed = (await req.json()) as Record<string, unknown> | null;
    if (parsed && typeof parsed === "object") body = parsed;
  } catch {
    // body rỗng — chạy đợt với mặc định (force true, budget từ config)
  }

  /* ── Action "config": cập nhật AppSetting ml-sweep (không đụng DB model) ── */
  if (body.action === "config") {
    const sanitized = sanitizeSweepConfigInput(body.config);
    if (sanitized.errors.length > 0) {
      return NextResponse.json(
        { ok: false, error: "Cấu hình sweep chưa hợp lệ.", fields: sanitized.errors },
        { status: 422 }
      );
    }
    try {
      const saved = await readSweepConfig();
      const merged = { ...saved, ...(sanitized.config ?? {}) };
      const ok = await writeSweepConfig(merged);
      if (!ok) {
        return NextResponse.json(
          { ok: false, error: "Không ghi được AppSetting ml-sweep (lỗi DB)." },
          { status: 500 }
        );
      }
      const config = await readSweepConfig();
      // Audit fail-soft (pattern tuning route — lỗi audit không chặn chính).
      void logMlAudit("ML_SWEEP_CONFIG_UPDATED", "AppSetting", null, sanitized.config ?? {}).catch(
        () => undefined
      );
      return NextResponse.json({ ok: true, applied: Object.keys(sanitized.config ?? {}), config });
    } catch (err) {
      console.error("[api/ml/sweep] POST config lỗi:", err);
      return NextResponse.json(
        { ok: false, error: "Cập nhật cấu hình sweep thất bại (lỗi DB)." },
        { status: 500 }
      );
    }
  }

  /* ── Mặc định: CHẠY ĐỢT (nút tay force=true mặc định; engine gửi force=false) ── */
  const force = typeof body.force === "boolean" ? body.force : true;
  let budgetOverride: number | undefined;
  if (typeof body.budget === "number" && Number.isFinite(body.budget)) {
    // Clamp 1..64 — giá trị THẬT ghi vào SweepRun.candidates (trung thực).
    budgetOverride = Math.min(64, Math.max(1, Math.round(body.budget)));
  }
  // F-01 (#129): featureSet của đợt — "v3-macro" → ứng viên 24 chiều (8 chiều
  // vĩ mô) đấu sweep fair với serving; mặc định v2-lag16 (đường engine CN 04:15).
  const featureSet: string | undefined =
    body.featureSet === "v3-macro" ? "v3-macro" : undefined;

  /** F-00 (#129): audit ML_SWEEP_AUTO (đường engine force=false) — outcome
   *  skipped/done/failed + runId + featureSet — "2 Chủ nhật liên tiếp có audit
   *  + dòng SweepRun mới" là gate nghiệm thu F-00. */
  const auditAuto = async (after: Record<string, unknown>): Promise<void> => {
    if (force !== false) return; // gọi tay giữ hành vi cũ (không audit)
    try {
      await db.auditLog.create({
        data: { action: "ML_SWEEP_AUTO", entity: "SweepRun", entityId: null, after: JSON.stringify(after) },
      });
    } catch {
      // audit fail-soft
    }
  };

  // Mutex dùng chung với train route (F2 — nghiệm thu §4.7-6/7): train hoặc
  // sweep khác đang chạy → 429 kèm Retry-After (engine không đánh dấu Chủ
  // nhật, phút sau tự thử lại — pattern A4/F-481-01).
  if (isTrainInFlight()) {
    return NextResponse.json(
      {
        error: "Sweep đang chạy… (hoặc huấn luyện đang giữ mutex dùng chung) — vui lòng đợi hoàn tất.",
        retryAfterSeconds: 30,
      },
      { status: 429, headers: { "Retry-After": "30" } }
    );
  }

  try {
    const summary = await runSweepOnce({ force, budgetOverride, featureSet });
    if (summary.busy === true) {
      return NextResponse.json(
        {
          error: "Sweep đang chạy… (mutex dùng chung vừa bị chiếm) — vui lòng đợi.",
          retryAfterSeconds: 30,
        },
        { status: 429, headers: { "Retry-After": "30" } }
      );
    }
    if (summary.skipped === true) {
      await auditAuto({
        outcome: "skipped-no-new-window",
        reason: summary.reason ?? "windowHash unchanged",
        windowHash: summary.windowHash ?? null,
        featureSet: featureSet ?? "v2-lag16",
        durationMs: summary.durationMs ?? null,
      });
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: summary.reason ?? "windowHash unchanged",
        windowHash: summary.windowHash,
        durationMs: summary.durationMs,
      });
    }
    if (!summary.ok) {
      // Lỗi chặn (runner đã ghi SweepRun "failed" + logJson) — 500 thân thiện.
      await auditAuto({
        outcome: "failed",
        runId: summary.runId ?? null,
        status: summary.status ?? "failed",
        featureSet: featureSet ?? "v2-lag16",
        reason: summary.reason ?? null,
      });
      return NextResponse.json(
        {
          ok: false,
          error: summary.reason ?? "Đợt sweep thất bại giữa chừng — xem SweepRun logJson.",
          runId: summary.runId,
          status: summary.status,
          log: summary.log,
        },
        { status: 500 }
      );
    }
    await auditAuto({
      outcome: "done",
      runId: summary.runId ?? null,
      featureSet: featureSet ?? "v2-lag16",
      candidates: summary.candidates ?? null,
      evaluated: summary.evaluated ?? null,
      champion: summary.champion?.tag ?? null,
      swapped: summary.swapped === true,
      durationMs: summary.durationMs ?? null,
    });
    return NextResponse.json(summary);
  } catch (err) {
    console.error("[api/ml/sweep] POST run lỗi:", err);
    await auditAuto({
      outcome: "failed",
      featureSet: featureSet ?? "v2-lag16",
      reason: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { ok: false, error: "Đợt sweep thất bại (lỗi ngoài dự kiến)." },
      { status: 500 }
    );
  }
}
