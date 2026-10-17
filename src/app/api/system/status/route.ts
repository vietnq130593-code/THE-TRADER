import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { escalateStaleSources, readSources, staleOf } from "@/lib/sources";
import { getTradingMode, TRADING_MODE_LABEL } from "@/lib/trading-mode";
import { sessionPhase, SESSION_PHASE_LABEL, isTradingSession } from "@/lib/market-session";
import { getEffectiveMode } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * F-00 (#129 — AI_ENGINEER_REVIEW_BRAIN §3 F-00 mục 3): kiểm tra sức khoẻ
 * vòng tự học Chủ nhật — quá 8 NGÀY không có audit ML_TRAIN_AUTO → RiskAlert
 * WARNING `ML_CYCLE_STALLED` (dedupe 7 ngày, cùng khuôn DATA_SOURCE_STALE).
 * Bài học E2 (v3): SweepRun 0 dòng + 19 version timestamp thủ công — vòng
 * tự học là trọng tài của mọi nâng cấp não; im lặng ≠ chạy đúng.
 * Trả {healthy, lastTrainAuditAt, stalledDays, alertCreated} cho footer/monitoring.
 */
async function mlCycleHealth(): Promise<{
  healthy: boolean;
  lastTrainAuditAt: string | null;
  stalledDays: number | null;
  alertCreated: boolean;
}> {
  try {
    const [lastAuto, firstAudit] = await Promise.all([
      db.auditLog.findFirst({
        where: { action: "ML_TRAIN_AUTO" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
      db.auditLog.findFirst({
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      }),
    ]);
    const DAY = 86_400_000;
    // Hệ thống chưa từng chạy ML auto (audit chưa tồn tại): chỉ báo động khi
    // hệ thống ĐÃ hoạt động > 8 ngày (tránh false alarm ngay sau triển khai).
    const systemAgeDays = firstAudit ? (Date.now() - firstAudit.createdAt.getTime()) / DAY : 0;
    const lastAt = lastAuto?.createdAt ?? null;
    const stalledDays = lastAt ? (Date.now() - lastAt.getTime()) / DAY : systemAgeDays;
    const hasHistory = lastAt != null || systemAgeDays > 8;
    const stalled = hasHistory && stalledDays > 8;
    let alertCreated = false;
    if (stalled) {
      const since = new Date(Date.now() - 7 * DAY);
      const dup = await db.riskAlert.findFirst({
        where: { code: "ML_CYCLE_STALLED", createdAt: { gte: since } },
        select: { id: true },
      });
      if (!dup) {
        const alert = await db.riskAlert.create({
          data: {
            severity: "WARNING",
            code: "ML_CYCLE_STALLED",
            message: `Vòng tự học ML đã ${Math.floor(stalledDays)} ngày không chạy (slot SUN 04:00 ICT không có audit ML_TRAIN_AUTO) — mọi sweep gate đang là lý thuyết. Kiểm tra market-engine + route /api/ml/train.`,
            metricKey: "ml.cycle.stalled_days",
            metricValue: Math.floor(stalledDays),
            threshold: 8,
          },
        });
        await db.auditLog
          .create({
            data: {
              action: "RISK_ALERT_RAISED",
              entity: "RiskAlert",
              entityId: alert.id,
              after: JSON.stringify({ code: alert.code, stalledDays: Math.floor(stalledDays) }),
            },
          })
          .catch(() => undefined);
        alertCreated = true;
      }
    }
    return {
      healthy: !stalled,
      lastTrainAuditAt: lastAt ? lastAt.toISOString() : null,
      stalledDays: stalled ? Math.floor(stalledDays) : null,
      alertCreated,
    };
  } catch (err) {
    console.error("[api/system/status] mlCycleHealth lỗi (fail-soft):", err);
    return { healthy: true, lastTrainAuditAt: null, stalledDays: null, alertCreated: false };
  }
}

/**
 * GET /api/system/status — tổng hợp trạng thái toàn hệ thống cho footer
 * và panel monitoring (S4 stale marking + S3 trading mode):
 *   - sources[]: mỗi nguồn → mode + stale + tuổi lần thành công cuối
 *   - trading: paper | live | live-unconfigured
 *   - counts: quy mô dữ liệu hiện có
 * Gọi kèm escalateStaleSources() (§6.4 DATA_SOURCES) trước khi đọc.
 */
export async function GET() {
  try {
    const escalated = await escalateStaleSources();
    // Perf #64 — getEffectiveMode ĐỘC LẬP với escalate/readSources (chỉ đọc
    // AppSetting) nên ghép vào cùng Promise.all (trước fix chạy tuần tự sau
    // nhóm — phí thêm 1 RTT WAN ~100ms mỗi lần footer poll).
    const [sources, newsCount, signalCount, orderCount, messageCount, eff, mlCycle] =
      await Promise.all([
        readSources(),
        db.newsItem.count(),
        db.signal.count(),
        db.order.count(),
        db.agentMessage.count(),
        getEffectiveMode(),
        mlCycleHealth(),
      ]);

    const trading = getTradingMode();

    return NextResponse.json({
      sources: sources.map((s) => {
        const { stale, ageMinutes } = staleOf(s);
        return {
          key: s.key,
          label: s.label,
          mode: s.mode,
          stale,
          ageMinutes,
          lastSuccessAt: s.lastSuccessAt?.toISOString() ?? null,
          lastError: s.lastError,
          providers: (s.meta?.providers as string[] | undefined) ?? [],
          updatedAt: s.updatedAt.toISOString(),
        };
      }),
      trading: {
        ...trading,
        label: TRADING_MODE_LABEL[trading.mode],
      },
      market: {
        phase: sessionPhase(new Date()),
        phaseLabel: SESSION_PHASE_LABEL[sessionPhase(new Date())],
        inSession: isTradingSession(new Date()),
        strictSession: process.env.MARKET_STRICT_SESSION === "true",
        // Phiên #34 (additive — không phá shape cũ): mode dữ liệu hiệu lực +
        // trạng thái realtime finfo để footer/monitoring hiển thị cảnh báo fallback.
        effectiveMode: eff.effectiveMode,
        realtimeOk: eff.realtimeOk,
      },
      counts: {
        news: newsCount,
        signals: signalCount,
        orders: orderCount,
        agentMessages: messageCount,
      },
      // F-00 (#129): sức khoẻ vòng tự học Chủ nhật (ml-train 04:00 + ml-sweep
      // 04:15) — footer/monitoring hiển thị cùng các nguồn dữ liệu.
      mlCycle,
      escalatedAlerts: escalated,
      serverTime: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[api/system/status]", err);
    return NextResponse.json(
      { error: "Không tải được trạng thái hệ thống." },
      { status: 500 }
    );
  }
}
