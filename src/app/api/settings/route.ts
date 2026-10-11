import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { AGENT_ROSTER } from "@/lib/agent-roster";
import { llmStatus } from "@/lib/llm";
import type { SettingsResponse, UpdateSettingsPayload } from "@/lib/types";
import {
  getEffectiveMode,
  getVndirectSettings,
  isMarketDataMode,
  isVndirectConfigured,
  maskSecret,
  saveVndirectSettings,
  setMarketDataMode,
} from "@/lib/settings";
import { getNotifySettings, saveNotifySettings, notifyStatus } from "@/lib/notify";
import { getVnHolidayOverlay, saveVnHolidayOverlay, upcomingHolidays } from "@/lib/vn-calendar";
import { getRiskQuantLimitsStatus, resetRiskQuantLimits } from "@/lib/risk/engine";
// #91 việc 2 — tự động dừng cơ chế thử nghiệm khi lưu cấu hình VNDIRECT thật
import { pauseSandboxForRealTrading } from "@/lib/k-sandbox";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET/PUT /api/settings — module Cài đặt (Phiên #34).
 *
 * GET: trả SettingsResponse — secret VNDIRECT đã mask (4 ký tự đầu + "·"×8;
 * accountNumber là định danh hiển thị nên KHÔNG che), mode dữ liệu hiệu lực,
 * trạng thái LLM/rủi ro/Bayes.
 *
 * PUT: body UpdateSettingsPayload — omit = giữ nguyên, "" = xoá (xem
 * lib/settings.ts); validate mode ∈ {real-eod, realtime-vndirect, simulated}.
 * Đổi sang realtime-vndirect khi chưa configured vẫn lưu — response trả về
 * effectiveMode "real-eod" kèm realtimeOk để UI cảnh báo.
 */

async function buildSettingsResponse(): Promise<SettingsResponse> {
  const [
    vndirect,
    eff,
    lastAssessment,
    riskQuantLimits,
    notifyCfg,
    notifyStat,
    vnOverlay,
    vnUpcoming,
  ] = await Promise.all([
    getVndirectSettings(),
    getEffectiveMode(),
    db.marketAssessment
      .findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } })
      .catch(() => null),
    // Fixbug #52-F5 — trạng thái Beta CRB-7 cho nút reset ở UI Cài đặt
    getRiskQuantLimitsStatus().catch(() => null),
    // P2-1/#62 — kênh thông báo S1 + trạng thái outbox
    getNotifySettings(),
    notifyStatus(),
    // P2-4/#62 — overlay lịch nghỉ lễ VN
    getVnHolidayOverlay(),
    upcomingHolidays(6),
  ]);

  // Risk limits — config của risk-manager (A6, có đủ 3 hạn mức), exposure (A7)
  // bổ sung sector/position khi risk-manager thiếu.
  const riskManager = AGENT_ROSTER.find((a) => a.code === "risk-manager")?.config ?? {};
  const exposure = AGENT_ROSTER.find((a) => a.code === "exposure")?.config ?? {};
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;

  return {
    vndirect: {
      consumerKey: maskSecret(vndirect.consumerKey),
      consumerSecret: maskSecret(vndirect.consumerSecret),
      accessToken: maskSecret(vndirect.accessToken),
      accountNumber: vndirect.accountNumber,
      configured: isVndirectConfigured(vndirect),
      lastTestAt: vndirect.lastTestAt,
      lastTestOk: vndirect.lastTestOk,
      lastTestMessage: vndirect.lastTestMessage,
    },
    marketData: {
      mode: eff.mode,
      effectiveMode: eff.effectiveMode,
      strictSession: process.env.MARKET_STRICT_SESSION !== "false",
      eodSyncAt: process.env.EOD_SYNC_AT ?? "15:45",
      realtimeOk: eff.realtimeOk,
      lastRealtimeAt: eff.lastRealtimeAt,
    },
    notify: {
      enabled: notifyCfg.enabled,
      webhookUrl: notifyCfg.webhookUrl,
      emailTo: notifyCfg.emailTo,
      pendingCount: notifyStat.pendingCount,
      sentCount: notifyStat.sentCount,
      lastSentAt: notifyStat.lastSentAt,
    },
    vnHolidays: {
      extra: vnOverlay.extra,
      remove: vnOverlay.remove,
      upcoming: vnUpcoming,
    },
    llm: await llmStatus(),
    risk: {
      maxSectorWeightPct: num(
        riskManager.maxSectorWeightPct ?? exposure.maxSectorWeightPct,
        40
      ),
      maxPositionPct: num(riskManager.maxPositionPct ?? exposure.maxPositionPct, 25),
      maxDrawdownPct: num(riskManager.maxDrawdownPct, 15),
      riskQuantLimits: (
        [
          ["sector", riskQuantLimits?.sector],
          ["position", riskQuantLimits?.position],
          ["dd", riskQuantLimits?.dd],
          ["dailyLoss", riskQuantLimits?.dailyLoss],
        ] as const
      ).map(([key, s]) => ({
        key,
        alpha: s?.alpha ?? 1,
        beta: s?.beta ?? 99,
        posteriorMean: s?.posteriorMean ?? 0.01,
        mult: s?.mult ?? 1,
      })),
    },
    bayes: {
      enabled: true,
      lastAssessmentAt: lastAssessment?.createdAt?.toISOString() ?? null,
    },
    updatedAt: new Date().toISOString(),
  };
}

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(await buildSettingsResponse());
  } catch (err) {
    console.error("[api/settings:GET]", err);
    return NextResponse.json(
      { error: "Không tải được cài đặt hệ thống." },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request): Promise<NextResponse> {
  try {
    const body = (await req.json().catch(() => null)) as UpdateSettingsPayload | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json(
        { error: "Payload không hợp lệ — cần object JSON { vndirect?, marketData? }." },
        { status: 400 }
      );
    }

    // Validate TRƯỚC khi lưu (trạng thái không đổi khi có lỗi)
    const mode = body.marketData?.mode;
    if (mode !== undefined && !isMarketDataMode(mode)) {
      return NextResponse.json(
        {
          error:
            "Chế độ dữ liệu không hợp lệ — phải là real-eod | realtime-vndirect | simulated.",
        },
        { status: 400 }
      );
    }
    const vnd = body.vndirect;
    if (vnd && typeof vnd !== "object") {
      return NextResponse.json(
        { error: "Trường vndirect phải là object { consumerKey?, consumerSecret?, accessToken?, accountNumber? }." },
        { status: 400 }
      );
    }
    // P2-1/#62 — validate kênh thông báo: webhookUrl phải http(s) khi khác rỗng
    // F-63B-06/07/#63 — kiểu sai → 400 (trước fix nuốt câm); URL phải parse
    // được THẬT (new URL + hostname) — "https://" host rỗng từng lọt qua
    // regex prefix rồi fetch() TypeError → PENDING_EGRESS retry vĩnh viễn.
    const notify = body.notify;
    if (notify !== undefined) {
      if (typeof notify !== "object" || Array.isArray(notify)) {
        return NextResponse.json(
          { error: "Trường notify phải là object { enabled?, webhookUrl?, emailTo? }." },
          { status: 400 }
        );
      }
      const url = notify.webhookUrl;
      if (url !== undefined && typeof url !== "string") {
        return NextResponse.json(
          { error: "notify.webhookUrl phải là chuỗi (hoặc để trống để xoá)." },
          { status: 400 }
        );
      }
      if (typeof url === "string" && url !== "") {
        let parsed: URL | null = null;
        try {
          parsed = new URL(url.trim());
        } catch {
          parsed = null;
        }
        if (
          !parsed ||
          (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
          !parsed.hostname
        ) {
          return NextResponse.json(
            { error: "webhookUrl phải là URL http(s) hợp lệ đầy đủ hostname (hoặc để trống để xoá)." },
            { status: 400 }
          );
        }
      }
      if (notify.enabled !== undefined && typeof notify.enabled !== "boolean") {
        return NextResponse.json({ error: "notify.enabled phải là boolean." }, { status: 400 });
      }
      const emailTo = notify.emailTo;
      if (emailTo !== undefined && typeof emailTo !== "string") {
        return NextResponse.json(
          { error: "notify.emailTo phải là chuỗi (hoặc để trống để xoá)." },
          { status: 400 }
        );
      }
      if (
        typeof emailTo === "string" &&
        emailTo !== "" &&
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTo.trim())
      ) {
        return NextResponse.json(
          { error: "emailTo không đúng định dạng địa chỉ email (hoặc để trống để xoá)." },
          { status: 400 }
        );
      }
    }
    // P2-4/#62 — validate overlay lịch lễ: mảng ISO date TỒN TẠI THẬT
    // (F-63C-09/#63 — "2027-02-31" lọt regex + NaN-check vì Date roll-over;
    // round-trip toISOString bắt ngày không có thật)
    const holidays = body.vnHolidays;
    if (holidays !== undefined) {
      if (typeof holidays !== "object" || Array.isArray(holidays)) {
        return NextResponse.json(
          { error: "Trường vnHolidays phải là object { extra?: string[], remove?: string[] }." },
          { status: 400 }
        );
      }
      const isoOk = (d: string): boolean => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
        const t = new Date(`${d}T00:00:00Z`).getTime();
        return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
      };
      for (const key of ["extra", "remove"] as const) {
        const list = holidays[key];
        if (list === undefined) continue;
        if (!Array.isArray(list) || list.some((d) => typeof d !== "string" || !isoOk(d))) {
          return NextResponse.json(
            { error: `vnHolidays.${key} phải là mảng ngày ISO YYYY-MM-DD thật (vd ["2026-10-20"]).` },
            { status: 400 }
          );
        }
      }
    }

    if (mode !== undefined) {
      await setMarketDataMode(mode);
    }
    if (vnd) {
      // #91 việc 2 — phát hiện chuyển trạng thái "chưa cấu hình → đã cấu hình
      // VNDIRECT thật": đọc TRƯỚC khi lưu để biết mốc chuyển đổi (chỉ auto-pause
      // cơ chế thử nghiệm đúng lúc trader KẾT NỐI THẬT lần đầu — lưu lại creds
      // khi đã configured từ trước không pause thêm, đã pause cũng không đụng).
      const before = await getVndirectSettings();
      const wasConfigured = isVndirectConfigured(before);
      await saveVndirectSettings(vnd);
      const after = await getVndirectSettings();
      const nowConfigured = isVndirectConfigured(after);
      let sandboxAutoPaused = false;
      if (!wasConfigured && nowConfigured) {
        // Hiệu lệnh trader #91: "khi Lưu cấu hình VNDIRECT thật → cơ chế
        // Thử nghiệm tự động dừng". Fail-soft bên trong — lỗi DB sandbox
        // KHÔNG làm hỏng luồng lưu Settings.
        const res = await pauseSandboxForRealTrading();
        sandboxAutoPaused = res.paused;
        if (sandboxAutoPaused) {
          console.log(
            "[api/settings:PUT] VNDIRECT thật vừa cấu hình — cơ chế thử nghiệm K1 tự động tạm dừng (pause §5.2, audit K1_SANDBOX_AUTO_PAUSED_FOR_REAL)"
          );
        }
      }
      const base = await buildSettingsResponse();
      // field transient chỉ PUT trả (không thêm vào GET — client đọc ngay
      // response để toast đúng sự thật đã auto-pause hay không)
      return NextResponse.json({ ...base, sandboxAutoPaused });
    }
    // P2-1/#62 — lưu cấu hình kênh thông báo S1
    if (notify) {
      await saveNotifySettings({
        ...(notify.enabled !== undefined ? { enabled: notify.enabled } : {}),
        ...(notify.webhookUrl !== undefined ? { webhookUrl: notify.webhookUrl } : {}),
        ...(notify.emailTo !== undefined ? { emailTo: notify.emailTo } : {}),
      });
    }
    // P2-4/#62 — lưu overlay lịch nghỉ lễ VN
    if (holidays) {
      await saveVnHolidayOverlay(holidays);
    }
    // Phiên #51 — CRB-7: nút reset thủ công Beta limit-learning (nghiệm thu
    // CRB-7.4) — prior Beta(1,99), ghi AuditLog minh bạch.
    if (body.riskQuantReset === true) {
      await resetRiskQuantLimits();
    }

    return NextResponse.json(await buildSettingsResponse());
  } catch (err) {
    console.error("[api/settings:PUT]", err);
    return NextResponse.json(
      { error: "Lưu cài đặt thất bại." },
      { status: 500 }
    );
  }
}
