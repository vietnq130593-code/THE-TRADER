/**
 * src/lib/agent-service-runs.ts — HÀM CHẠY DETERMINISTIC cho 16 service agents
 * (mở rộng kiến trúc 23 agents — phần còn lại là execution-manager do chu kỳ
 * xử lý riêng vì cần Signal đầu vào).
 *
 * Mỗi agent dịch vụ tính TOÀN BỘ số liệu thật từ DB (Supabase) —
 * KHÔNG gọi LLM, 0 chi phí tokens, ~0.2–1.5s mỗi lần chạy. Kết quả:
 *  - content    → tin broadcast cho feed đội agent
 *  - reasoning  → cơ sở ngắn (hiển thị phụ)
 *  - sentiment  → bullish/bearish/neutral khi có ý nghĩa
 *  - output     → JSON lưu AgentRun.output (truy vết sau này)
 *
 * Nguồn định nghĩa agents: src/lib/agent-roster.ts (kind: "service").
 */

import { db } from "@/lib/db";
import { llmStatus } from "@/lib/llm";
import { getTradingMode, TRADING_MODE_LABEL } from "@/lib/trading-mode";
import { sessionPhase, SESSION_PHASE_LABEL } from "@/lib/market-session";
import { ROSTER_BY_CODE } from "@/lib/agent-roster";
// E-P0-3/E-P0-4 (EXECUTION_OPS_BLUEPRINT v1.1): A11 ReconciliationReport + A12 CommittedCashView.
import {
  runReconciliation,
  reconcileReportSummary,
  RECONCILE_CHECKPOINT_KEY,
} from "@/lib/exec/reconciliation";
import { computeCommittedCashView, committedViewSummary } from "@/lib/exec/committed";
// E-P1-3 (v1.2): snapshot cash mỗi chu kỳ + CashflowForecast kịch bản A12.
import {
  recordCashSnapshot,
  computeCashflowForecast,
  forecastSummary,
  type CashflowForecast,
} from "@/lib/exec/forecast";
// E-P1-5 (v1.2): quét bất thường giao dịch IQR + z-score (A11 — sau reconciliation).
import {
  detectTradeAnomalies,
  raiseAnomalyAlert,
  anomalyScanSummary,
  type AnomalyScanResult,
} from "@/lib/exec/anomaly";
import { latestFeatures, loadTopSeries, latestFeatureSnapshot } from "@/lib/ml/features";
import { topByAdtv } from "@/lib/dated-series";
import {
  runDataQualityChecks,
  raiseSevereAlerts,
  extractVerdict,
  type DataQualityVerdict,
} from "@/lib/data-quality";
import { liveIngestRegistry } from "@/lib/ingest-pipeline";
import { dispatchDigest, retryPendingOutbox } from "@/lib/notify";
import { MLP } from "@/lib/ml/nn";
import { mlForecastEnsemble } from "@/lib/ml/ensemble";
import { buildBasket, parseQTable, policyStance } from "@/lib/ml/rl";
import {
  banditSnapshot,
  pendingSettleCount,
  settlePendingRewards,
} from "@/lib/ml/bandit";
// L1 (#83): thống kê RAG (corpus + RetrievalLog 30 ngày) cho A13.
import { ragStats } from "@/lib/ml/rag";
import type { RiskQuantResult } from "@/lib/risk/engine";

export interface ServiceRunResult {
  content: string;
  reasoning: string;
  sentiment: "bullish" | "bearish" | "neutral" | null;
  output: Record<string, unknown>;
}

/* ───────────────────────────── Tiện ích chung ───────────────────────────── */

const vnd = (n: number): string => Math.round(n).toLocaleString("vi-VN");
const fmtPct = (n: number, digits = 1): string =>
  `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;

function meanOf(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}
function stdOf(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = meanOf(xs);
  return Math.sqrt(meanOf(xs.map((x) => (x - m) * (x - m))));
}

/** Top-N mã thanh khoản cao nhất (kèm quote + closes + volumes 90 phiên).
 *  B5 §3.4: khoá về HOSE-STOCK — universe đa sàn không làm lệch rổ của các
 *  agent dịch vụ đang dùng (market-analyst bảng chỉ báo, ml-forecast…).
 *  P0-2 (phiên #57): xếp hạng qua rổ DUY NHẤT `topByAdtv` (ADTV 45 phiên EOD
 *  từ Bar.value) — thay quote volume từng tick (lớs bug F6 còn sót ở đây). */
interface LiquidSymbol {
  id: string;
  symbol: string;
  sector: string | null;
  last: number;
  volume: number;
  closes: number[];
  volumes: number[];
}
async function topLiquid(n: number): Promise<LiquidSymbol[]> {
  const ranked = await topByAdtv(n, { market: "HOSE", type: "STOCK" });
  if (ranked.length === 0) return [];
  const ids = ranked.map((r) => r.id);
  const [quoteRows, bars] = await Promise.all([
    db.quote
      .findMany({ where: { instrumentId: { in: ids } }, select: { instrumentId: true, last: true, volume: true } })
      .catch(() => []),
    db.bar
      .findMany({
        where: { instrumentId: { in: ids } },
        orderBy: { date: "asc" },
        select: { instrumentId: true, close: true, volume: true },
      })
      .catch(() => []),
  ]);
  const quoteById = new Map(quoteRows.map((q) => [q.instrumentId, q]));
  const series = new Map<string, { closes: number[]; volumes: number[] }>();
  for (const b of bars) {
    if (!(b.close > 0)) continue;
    const entry = series.get(b.instrumentId) ?? { closes: [], volumes: [] };
    entry.closes.push(b.close);
    entry.volumes.push(b.volume);
    series.set(b.instrumentId, entry);
  }
  return ranked.map((t) => {
    const q = quoteById.get(t.id);
    const s = series.get(t.id);
    return {
      ...t,
      last: q?.last ?? 0,
      volume: q?.volume ?? 0,
      closes: s?.closes ?? [],
      volumes: s?.volumes ?? [],
    };
  });
}

/** Vị thế mở + giá hiện tại + NAV (equity tính lại như F-102). */
async function portfolioSnapshot(): Promise<{
  equity: number;
  cash: number;
  marginUsed: number;
  positions: {
    symbol: string;
    sector: string | null;
    quantity: number;
    avgPrice: number;
    last: number;
    mv: number;
    pnlPct: number;
  }[];
  sectorWeights: { sector: string; mv: number; pct: number }[];
}> {
  const [account, positionsAll] = await Promise.all([
    db.brokerAccount.findFirst({
      where: { deletedAt: null },
      select: { id: true, cashBalance: true, equity: true, marginUsed: true },
    }),
    db.position.findMany({
      where: { status: "OPEN" },
      include: {
        instrument: {
          select: {
            symbol: true,
            sector: true,
            quotes: { orderBy: { tradedAt: "desc" }, take: 1, select: { last: true } },
          },
        },
      },
    }),
  ]);
  // F-73R2-03: lọc positions theo tài khoản sống — không trộn vị thế tài khoản
  // khác/soft-delete vào NAV của A12 (filter JS theo id — giữ Promise.all,
  // không thêm truy vấn tuần tự; account trong where gây chicken-egg).
  const positions = account
    ? positionsAll.filter((p) => p.brokerAccountId === account.id)
    : positionsAll;
  const rows = positions.map((p) => {
    const last = p.instrument.quotes[0]?.last ?? p.avgPrice;
    const mv = last * p.quantity;
    const pnlPct = p.avgPrice > 0 ? ((last - p.avgPrice) / p.avgPrice) * 100 : 0;
    return {
      symbol: p.instrument.symbol,
      sector: p.instrument.sector,
      quantity: p.quantity,
      avgPrice: p.avgPrice,
      last,
      mv,
      pnlPct,
    };
  });
  const positionsMv = rows.reduce((s, r) => s + r.mv, 0);
  const cash = account ? Number(account.cashBalance) : 0;
  const equity = cash + positionsMv;
  const bySector = new Map<string, number>();
  for (const r of rows) {
    const key = r.sector ?? "Khác";
    bySector.set(key, (bySector.get(key) ?? 0) + r.mv);
  }
  return {
    equity,
    cash,
    marginUsed: account ? Number(account.marginUsed) : 0,
    positions: rows,
    sectorWeights: [...bySector.entries()]
      .map(([sector, mv]) => ({ sector, mv, pct: equity > 0 ? (mv / equity) * 100 : 0 }))
      .sort((a, b) => b.pct - a.pct),
  };
}

/* ─────────────────────────── Nhóm 4 · platform ─────────────────────────── */

/** S0 Data Collector — chủ kho & điều phối nạp (P0-6 — phiên #57: xuất
 * IngestSummary cấu trúc trong output — đã nạp gì mới · nguồn nào hỏng +
 * lastError · backlog gì — đầu vào lịch sử cho A9 và S1, §1.2 blueprint).
 * B11: + ingest fundamentals finfo tuần trong chu kỳ — try/catch toàn bộ,
 * lỗi mạng → mode pending-egress, KHÔNG bao giờ làm hỏng chu kỳ;
 * DataSourceStatus key "fundamentals" minh bạch. Vẫn 0 request thu thập
 * (registry 10 đường thật đợi P1-6 — engine + API routes là máy móc). */
async function runDataCollector(): Promise<ServiceRunResult> {
  const since24h = new Date(Date.now() - 24 * 3_600_000);
  const [instruments, barCount, quoteRows, news24h, sourceRows, barMaxAgg, barInstrumentGroup, registry] =
    await Promise.all([
      db.instrument.findMany({
        where: { isActive: true },
        select: { id: true, symbol: true, market: true, type: true },
      }),
      db.bar.count(),
      db.quote.findMany({ select: { instrumentId: true, tradedAt: true } }),
      db.newsItem.count({ where: { publishedAt: { gte: since24h } } }),
      // F-612R-08/#61 (Vòng 2) — sourceRows + registry KHÔNG nuốt lỗi: S0 sở
      // hữu việc báo trạng thái nguồn; nuốt → "0 nguồn real/live + không
      // nguồn nào lỗi" (nói dối 2 chiều). Lỗi ném → S0 failed lộ liễu.
      db.dataSourceStatus.findMany(),
      db.bar.aggregate({ _max: { date: true } }).catch(() => ({ _max: { date: null as Date | null } })),
      db.bar.groupBy({ by: ["instrumentId"] }).catch(() => [] as { instrumentId: string }[]),
      // P1-6 — S0 làm CHỦ REGISTRY 10 đường nạp §0.3 (kết thúc "hữu danh vô
      // thực" §1.2): mỗi chu kỳ gắn trạng thái sống vào IngestSummary
      // (liveIngestRegistry giờ tự ném lỗi DB — F-612R-08)
      liveIngestRegistry(),
    ]);
  // Quote update-in-place: 1 dòng/mã — tradedAt lớn nhất = báo giá mới nhất
  const lastQuoteAt = quoteRows.reduce<Date | null>(
    (acc, q) => (acc == null || q.tradedAt > acc ? q.tradedAt : acc),
    null
  );
  const lastBarDate = barMaxAgg._max.date ?? null;
  const barsAtLastDate = lastBarDate
    ? await db.bar.count({ where: { date: lastBarDate } }).catch(() => 0)
    : 0;
  const idsWithBars = new Set(barInstrumentGroup.map((g) => g.instrumentId));
  const quotedIds = new Set(quoteRows.map((q) => q.instrumentId));
  const zeroBarSymbols = instruments
    .filter((i) => !idsWithBars.has(i.id))
    .map((i) => i.symbol);
  const noQuoteCount = instruments.filter((i) => !quotedIds.has(i.id)).length;
  const instrumentCount = instruments.length;
  const ageSec = lastQuoteAt
    ? Math.max(0, Math.round((Date.now() - lastQuoteAt.getTime()) / 1000))
    : null;
  const marketQuotesRow = sourceRows.find((s) => s.key === "market-quotes");
  const mode = marketQuotesRow?.mode ?? "simulated";
  const ageLabel =
    ageSec == null
      ? "chưa có báo giá"
      : ageSec < 90
        ? `${ageSec}s trước`
        : `${Math.round(ageSec / 60)} phút trước`;

  // P0-6 — IngestSummary (AgentRun.output): nạp hôm nay · nguồn hỏng · backlog
  // P1-6 — + registry 10 đường §0.3 (S0 chủ kho & điều phối nạp)
  const failedSources = sourceRows
    .filter((s) => s.lastError)
    .map((s) => ({ key: s.key, mode: s.mode, lastError: s.lastError!.slice(0, 120) }));
  const ingest = {
    asOf: new Date().toISOString(),
    lastBarDate: lastBarDate ? lastBarDate.toISOString().slice(0, 10) : null,
    barsAtLastDate,
    sources: sourceRows.map((s) => ({
      key: s.key,
      mode: s.mode,
      lastSuccessAt: s.lastSuccessAt ? s.lastSuccessAt.toISOString() : null,
      lastError: s.lastError ? s.lastError.slice(0, 120) : null,
    })),
    failedSources,
    backlog: {
      zeroBarCount: zeroBarSymbols.length,
      zeroBarSymbols: zeroBarSymbols.slice(0, 20),
      noQuoteCount,
    },
    // P1-6 — registry 10 đường nạp với trạng thái sống mỗi chu kỳ
    registry: registry.map((r) => ({
      no: r.no,
      name: r.name,
      route: r.route,
      schedule: r.schedule,
      targets: r.targets,
      status: r.status,
    })),
  };

  // B11 — ingest fundamentals finfo (tuần: chỉ chạy Chủ nhật theo lịch ICT)
  const fundNote = await ingestFundamentalsWeekly();

  return {
    content: `Đồng bộ hoàn tất: ${instrumentCount} mã đa sàn (HOSE · HNX · UPCOM · ETF · INDEX · QT) · ${barCount.toLocaleString("vi-VN")} nến lịch sử · báo giá mới nhất ${ageLabel} (chế độ ${mode}) · ${news24h} tin RSS trong 24h qua. Nạp gần nhất: ${ingest.lastBarDate ? `${barsAtLastDate.toLocaleString("vi-VN")} nến ngày ${ingest.lastBarDate}` : "chưa có nến"} · backlog ${zeroBarSymbols.length} mã 0 nến · ${noQuoteCount} mã thiếu báo giá${failedSources.length > 0 ? ` · nguồn lỗi: ${failedSources.map((f) => f.key).join(", ")}` : ""}.${fundNote ? ` Dữ liệu cơ bản: ${fundNote}.` : ""} Registry nạp (P1-6): 10 đường — ${registry.filter((r) => r.status?.mode === "real" || r.status?.mode === "live").length} nguồn real/live${ingest.registry.some((r) => r.status?.lastError) ? `, lưu ý: ${ingest.registry.filter((r) => r.status?.lastError).map((r) => `${r.name} (${r.status!.lastError!.slice(0, 40)}…)`).slice(0, 2).join(" · ")}` : ""}. Dữ liệu sẵn sàng cho Hội đồng Nghiên cứu.`,
    reasoning:
      "P0-6 IngestSummary + P1-6 registry 10 đường §0.3 (S0 chủ kho — ingest-pipeline.ts liveIngestRegistry): đếm Bar theo date mới nhất + DataSourceStatus 7 nguồn (lastError) + backlog 0-bar/thiếu-quote + ingest finfo (B11 pending-egress).",
    sentiment: null,
    output: { instrumentCount, barCount, quoteAgeSec: ageSec, news24h, mode, fundamentals: fundNote, ingest },
  };
}

/** B11 — chạy ingest finfo 1 lần/tuần (Chủ nhật ICT) hoặc khi chưa có row nguồn;
 *  những ngày khác chỉ đọc trạng thái DataSourceStatus (0 request mạng). */
async function ingestFundamentalsWeekly(): Promise<string | null> {
  const { ingestFundamentals } = await import("@/lib/fundamentals");
  const isSunday = new Date(Date.now() + 7 * 3_600_000).getUTCDay() === 0;
  const existing = await db.dataSourceStatus.findUnique({ where: { key: "fundamentals" } });
  if (!isSunday && existing) {
    return existing.mode === "real"
      ? `finfo real (${existing.lastSuccessAt ? "đã sync" : "chưa sync"})`
      : "finfo pending-egress (chờ máy chủ có egress)";
  }
  const res = await ingestFundamentals().catch(() => null);
  if (!res) return "finfo lỗi (đã ghi DataSourceStatus)";
  return res.mode === "real"
    ? `finfo real — ${res.rowsUpserted} dòng ${res.instrumentsUpdated} mã`
    : "finfo pending-egress (chờ máy chủ có egress)";
}

/** S1 Notification Officer — trạm cảnh báo vận hành (P0-7 — phiên #57:
 *  bản tin thêm dòng CHẤT LƯỢNG DỮ LIỆU từ verdict A9 cùng chu kỳ — S1 chạy
 *  nhịp 3 sau A9 theo §3.3; single-run không có ctx → fallback đọc AgentRun
 *  A9 mới nhất ≤ 30 phút). */
async function runNotificationOfficer(ctx?: ServiceRunContext): Promise<ServiceRunResult> {
  const since24h = new Date(Date.now() - 24 * 3_600_000);
  const [activeSignals, openAlerts, failedRuns, dqVerdict] = await Promise.all([
    db.signal.findMany({
      where: { status: "ACTIVE" },
      orderBy: { createdAt: "desc" },
      take: 5,
      include: { instrument: { select: { symbol: true } } },
    }),
    db.riskAlert.count({ where: { acknowledgedAt: null } }),
    db.agentRun.count({ where: { taskStatus: "FAILED", startedAt: { gte: since24h } } }),
    // Fixbug #59 (P0-7 trung thực): chu kỳ truyền ctx nhưng verdict NULL
    // nghĩa là A9 chu kỳ này LỖI CHẠY — KHÔNG được fallback đọc verdict cũ
    // (≤30') mà gán nhãn "chu kỳ này" (nói sai sự thật); chỉ single-run
    // (không ctx) mới đọc verdict A9 gần nhất làm đầu vào.
    ctx?.dataQuality != null
      ? Promise.resolve(ctx.dataQuality)
      : ctx != null
        ? Promise.resolve(null)
        : latestA9Verdict(),
  ]);
  const signalLines = activeSignals.map(
    (s) => `${s.instrument.symbol} ${s.direction} (${s.score}/100)`
  );
  const needAttention = activeSignals.length > 0 || openAlerts > 0;

  // P0-7 — dòng chất lượng dữ liệu: mức + 2 chi tiết lớn nhất từ verdict A9
  const dqParts: string[] = [];
  if (dqVerdict) {
    const top2 = dqVerdict.checks
      .filter((c) => c.level !== "PASS")
      .slice(0, 2)
      .map((c) => {
        const d = c.detail.length > 90 ? `${c.detail.slice(0, 90).trimEnd()}…` : c.detail;
        return `${c.kind}: ${d}`;
      });
    dqParts.push(
      `Chất lượng dữ liệu (A9 chu kỳ này): ${dqVerdict.level}${top2.length > 0 ? ` — ${top2.join(" · ")}` : " — 6 phép kiểm đều đạt"}`
    );
  } else if (ctx != null) {
    dqParts.push(
      "Chất lượng dữ liệu: A9 chu kỳ này KHÔNG hoàn tất (agent lỗi) — coi chu kỳ này là CHƯA KIỂM ĐỊNH"
    );
  }

  const parts = [
    `BẢN TIN CHU KỲ: ${activeSignals.length} tín hiệu chờ phê duyệt`,
    signalLines.length ? `(${signalLines.join(" · ")})` : "",
    `${openAlerts} cảnh báo rủi ro chưa xử lý`,
    `${failedRuns} agent lỗi trong 24h`,
    ...dqParts,
  ].filter(Boolean);

  const digestText =
    parts.join(" · ") +
    (needAttention ? " Cần trader xem xét." : " Không có mục cần xử lý gấp.");

  // P2-1 (phiên #62) — phát bản tin qua kênh webhook/email (pattern
  // pending-egress như finfo: sandbox chặn egress → row NotificationOutbox
  // PENDING_EGRESS, tự retry mỗi chu kỳ). KHÔNG bao giờ làm hỏng S1 — mọi
  // lỗi nằm trong delivery results.
  let delivery: {
    results: { channel: string; status: string; note: string }[];
    pendingCount: number;
    retried?: { sent: number; stillPending: number; note?: string };
  } | null = null;
  try {
    delivery = await dispatchDigest({
      subject: `The Trader — bản tin chu kỳ ${new Date().toISOString()}`,
      body: digestText,
      level: dqVerdict?.level ?? null,
    });
    // Piggyback: quét lại backlog PENDING_EGRESS cũ (webhook) mỗi chu kỳ
    const retry = await retryPendingOutbox(3).catch(() => null);
    // F-65B-03/#65 — giữ nguyên note (nếu có) vào AgentRun.output: trước đây
    // chỉ copy sent/stillPending → thông điệp "vì sao retry tự động ngừng"
    // (F-63B-05: kênh TẮT) không tới nổi người đọc log chu kỳ.
    if (retry)
      delivery.retried = {
        sent: retry.sent,
        stillPending: retry.stillPending,
        ...(retry.note ? { note: retry.note } : {}),
      };
  } catch (err) {
    console.error("[S1 notify] dispatchDigest lỗi (không chặn S1):", err);
  }

  return {
    content: digestText,
    reasoning:
      "Đếm Signal ACTIVE + RiskAlert chưa ack + AgentRun FAILED 24h + verdict A9 cùng chu kỳ (P0-7 — ctx chu kỳ: NULL nghĩa là A9 lỗi chạy, khai báo thẳng; single-run: AgentRun A9 ≤ 30'). P2-1: phát qua kênh webhook/email pending-egress + retry backlog.",
    sentiment: dqVerdict?.level === "SEVERE" || needAttention ? "neutral" : "bullish",
    output: {
      activeSignals: activeSignals.length,
      openAlerts,
      failedRuns24h: failedRuns,
      dataQuality: dqVerdict
        ? { level: dqVerdict.level, asOf: dqVerdict.asOf, checkCount: dqVerdict.checks.length }
        : null,
      delivery,
    },
  };
}

/** P0-7 — verdict A9 mới nhất (≤ 30') cho single-run S1 (chu kỳ truyền ctx). */
async function latestA9Verdict(): Promise<DataQualityVerdict | null> {
  try {
    const agent = await db.agent.findUnique({
      where: { code: "data-integrity" },
      select: { id: true },
    });
    if (!agent) return null;
    const run = await db.agentRun.findFirst({
      where: { agentId: agent.id, taskStatus: "COMPLETED" },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true, output: true },
    });
    if (!run?.output) return null;
    if (Date.now() - run.startedAt.getTime() > 30 * 60_000) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(run.output);
    } catch {
      return null;
    }
    return extractVerdict(parsed);
  } catch {
    return null;
  }
}

/** S2 Feature Store — NGƯỜI PHỤC VỤ ĐẶC TRƯNG (P0-3 — phiên #57): tính qua
 *  FEATURECONTRACT `latestFeatureSnapshot` (ml/features.ts — nơi tính duy
 *  nhất, cùng số với bằng chứng Bayes · bảng chỉ báo prompt · readiness A9);
 *  rổ qua topByAdtv (P0-2). Readiness THẬT: 6 nhóm, RSI14 tính thật Wilder
 *  (roster có nhắc — trước đây KHÔNG tính), bỏ chữ "biến động" suông. */
async function runFeatureStore(): Promise<ServiceRunResult> {
  const basket = await topByAdtv(10, { market: "HOSE", type: "STOCK" });
  const barLists = await Promise.all(
    basket.map((t) =>
      db.bar
        .findMany({
          where: { instrumentId: t.id },
          orderBy: { date: "desc" },
          take: 70,
          select: { close: true, volume: true, date: true },
        })
        .then((rows) => rows.filter((b) => b.close > 0).reverse())
        .catch(() => [] as { close: number; volume: number; date: Date }[])
    )
  );
  const nowIso = new Date().toISOString();
  const ready = basket.map((t, i) => {
    const rows = barLists[i];
    const snap = latestFeatureSnapshot(
      rows.map((b) => b.close),
      rows.map((b) => b.volume)
    );
    return {
      symbol: t.symbol,
      sessions: snap?.sessions ?? 0,
      sma20: snap?.sma20 ?? null,
      sma50: snap?.sma50 ?? null,
      rsi14: snap?.rsi14 ?? null,
      macdHist: snap?.macdHist ?? null,
      mom5Pct: snap?.mom5Pct ?? null,
      volRatio20: snap?.volRatio20 ?? null,
      ready: snap?.ready ?? false,
      lastBarDate: rows.length ? rows[rows.length - 1].date.toISOString().slice(0, 10) : null,
      // §4.2.3 — mốc readiness per mã (invalidation hook, 0 schema)
      featureReadinessAt: snap ? nowIso : null,
    };
  });
  const full = ready.filter((r) => r.ready).length;
  const sample = ready
    .slice(0, 3)
    .map(
      (r) =>
        `${r.symbol} (RSI14 ${r.rsi14 != null ? r.rsi14.toFixed(0) : "—"} · SMA20 ${r.sma20 != null ? Math.round(r.sma20).toLocaleString("vi-VN") : "—"} · MACDh ${r.macdHist != null ? (r.macdHist / 1000).toFixed(1) : "—"} · 5 phiên ${r.mom5Pct != null ? (r.mom5Pct >= 0 ? "+" : "") + r.mom5Pct.toFixed(2) + "%" : "—"} · KL/TL20 ${r.volRatio20 != null ? r.volRatio20.toFixed(2) + "×" : "—"})`
    );

  return {
    content: `Kho đặc trưng (FeatureContract P0-3 · rổ topByAdtv ADTV-45): ${full}/${basket.length} mã top thanh khoản đủ 6 nhóm đặc trưng (SMA20 · SMA50 · RSI14 · MACD hist · động lượng 5 phiên · KL/TL20) — RSI14 Wilder tính thật từ chuỗi EOD, cùng số với bằng chứng Bayes và bảng chỉ báo prompt. Mẫu: ${sample.join(" · ")}.`,
    reasoning:
      "latestFeatureSnapshot (ml/features.ts — hợp đồng) trên rổ topByAdtv(10); mốc featureReadinessAt per mã ghi AgentRun.output (invalidation §4.2.3).",
    sentiment: null,
    output: {
      fullFeatureCount: full,
      checked: basket.length,
      basket: "topByAdtv-45",
      features: ["sma20", "sma50", "rsi14", "macdHist", "mom5", "volRatio20"],
      sample: ready.slice(0, 3),
      featureReadinessAt: Object.fromEntries(ready.map((r) => [r.symbol, r.featureReadinessAt])),
    },
  };
}

/** A9 Data Integrity — KIỂM ĐỊNH VIÊN CHUỖI DỮ LIỆU (P0-4 — phiên #57):
 *  6 phép kiểm thật (freshness theo lịch phiên sàn · gap per-market · outlier
 *  2 lớp · split-nghi-vấn VN · 7 nguồn · readiness FeatureContract) →
 *  DataQualityVerdict JSON CÓ CẤU TRÚC (thay câu text "TOÀN VỆN/CẢNH BÁO"
 *  0 consumer) → (i) lưu AgentRun.output (0 đổi schema — review #56; bảng
 *  DataQualityReport đợi P1-7), (ii) RiskAlert khi SEVERE (ack-bắt-buộc,
 *  dedupe 24h), (iii) route tiêm khối TÍNH TRẠNG DỮ LIỆU vào prompt Wave B
 *  + Chủ tịch (8-1b: KHÔNG hard-stop). A9 không bao giờ đụng VETO (A6/A7/A8).
 *  P1-7 (#60): THÊM persist bảng DataQualityReport {asOf, level, checks,
 *  summary} mỗi chu kỳ (index asOf — lịch sử dài/trend < 100ms) —
 *  AgentRun.output vẫn ghi song song (S1/extractVerdict đọc như cũ). */
async function runDataIntegrity(): Promise<ServiceRunResult> {
  const verdict = await runDataQualityChecks();
  const alertsRaised =
    verdict.level === "SEVERE" ? await raiseSevereAlerts(verdict).catch(() => 0) : 0;

  // P1-7 — persist DataQualityReport (fail-soft: lỗi ghi báo cáo KHÔNG làm
  // hỏng chu kỳ A9 — verdict vẫn trả về AgentRun.output)
  let reportId: string | null = null;
  try {
    const report = await db.dataQualityReport.create({
      data: {
        asOf: new Date(verdict.asOf),
        level: verdict.level,
        checks: JSON.stringify(verdict.checks),
        summary: JSON.stringify(verdict.summary),
      },
    });
    reportId = report.id;
  } catch (err) {
    console.error("[A9 P1-7] ghi DataQualityReport lỗi (bỏ qua):", err);
  }

  const levelVi =
    verdict.level === "SEVERE"
      ? "NGHIÊM TRỌNG (SEVERE)"
      : verdict.level === "DEGRADED"
        ? "GIỚI HẠN (DEGRADED)"
        : "ĐẠT (PASS)";
  const checkLines = verdict.checks.map(
    (c) => `[${c.kind}${c.level !== "PASS" ? `:${c.level}` : ""}] ${c.detail}`
  );

  return {
    content: `Kiểm định dữ liệu 6 phép (P0-4) → ${levelVi}: ${checkLines.join(" · ")}.${
      verdict.level !== "PASS"
        ? " Cờ chất lượng dữ liệu đã vào prompt nghiên cứu + Chủ tịch — khi trích dẫn số liệu, khai báo độ confound (mã thiếu · nguồn fallback) trong luận cứ."
        : ""
    }${alertsRaised > 0 ? ` Đã phát ${alertsRaised} RiskAlert SEVERE bắt buộc ack.` : ""}`,
    reasoning:
      "6 phép (data-quality.ts): freshness theo lịch phiên SÀN (3 trạng thái thiếu/đóng-cửa/cũ) · gap per-market quorum 50% + outage · outlier 2 lớp (cấu trúc+dải sàn — Hampel INFO) · split-nghi-vấn VN (gap vượt dải + volume ≥ 3× ADTV) · 7 nguồn DataSourceStatus · readiness FeatureContract — ngưỡng AppSetting data-quality-thresholds.",
    sentiment: verdict.level === "SEVERE" ? "bearish" : verdict.level === "DEGRADED" ? "neutral" : "bullish",
    output: { verdict, alertsRaised, reportId },
  };
}

/* ─────────────────────── Nhóm 1 · research (service) ─────────────────────── */

/** A15 ML Forecast — ensemble MLP + linreg (B7 — cử tri thứ 6 của Hội đồng
 * Nghiên cứu, phiếu bầu theo số đông · đồng thuận 80%). Xem ml/ensemble.ts
 * cho công thức đầy đủ (score 0,7×(pUp−pDown)+0,3×tanh(z), deadband 0,05,
 * fallback linreg khi chưa có model). */
async function runMlForecast(): Promise<ServiceRunResult> {
  const ens = await mlForecastEnsemble();
  if (!ens) {
    return {
      content: "Chưa đủ dữ liệu chuỗi EOD cho rổ top-10 HOSE để tính ensemble ML (cần ≥ 70 phiên mỗi mã).",
      reasoning: "mlForecastEnsemble trả null — rổ trống hoặc bar chưa sync.",
      sentiment: null,
      output: { horizonDays: 5, ensemble: null },
    };
  }
  const dirVi = ens.direction === "UP" ? "TĂNG" : ens.direction === "DOWN" ? "GIẢM" : "ĐI NGANG";
  const content = [
    `Dự báo động lượng 5 phiên (ensemble MLP + hồi quy tuyến tính, rổ top-${ens.basketSize} thanh khoản HOSE): nghiêng ${dirVi}.`,
    ens.pUp != null && ens.pDown != null
      ? `MLP v${ens.modelVersion}: pTăng ${(ens.pUp * 100).toFixed(1)}% · pGiảm ${(ens.pDown * 100).toFixed(1)}%${ens.pFlat != null ? ` · pNgang ${(ens.pFlat * 100).toFixed(1)}%` : ""}.`
      : "Chưa có MlModel serving — chạy fallback linreg thuần (huấn luyện MLP qua nút Huấn luyện ML để bật thành phần neural).",
    ens.z != null || ens.lastProj != null
      ? `Thành phần tuyến tính: ${ens.lastProj != null ? `proj₅ rổ ${ens.lastProj >= 0 ? "+" : ""}${ens.lastProj.toFixed(2)}%` : ""}${ens.z != null ? ` · z-score ${ens.z.toFixed(2)}` : ""}${ens.score != null ? ` · score tổng ${ens.score >= 0 ? "+" : ""}${ens.score.toFixed(3)} (deadband ±0,05 → ${dirVi})` : ""}.`
      : "",
    "Với tư cách cử tri thứ 6, phiếu này vào Bộ tổng hợp Bayes qua llm-vote:ml-forecast (tín hiệu ML chỉ vào Bayes MỘT lần — T7.5).",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    content,
    reasoning:
      "ensemble score = 0,7×(pUp−pDown) + 0,3×tanh(z), z = z-score proj₅ (slope×5/last×100, cửa sổ 60 phiên); deadband |score|<0,05 → FLAT.",
    sentiment: ens.direction === "UP" ? "bullish" : ens.direction === "DOWN" ? "bearish" : "neutral",
    output: {
      horizonDays: 5,
      ensemble: {
        direction: ens.direction,
        score: ens.score,
        z: ens.z,
        lastProj: ens.lastProj,
        pUp: ens.pUp,
        pDown: ens.pDown,
        pFlat: ens.pFlat,
        confidence: ens.confidence,
        basketSize: ens.basketSize,
      },
      modelVersion: ens.modelVersion,
    },
  };
}

/* ─────────────────────── Nhóm 2 · control (service) ─────────────────────── */

/** Ngữ cảnh chu kỳ truyền vào service agents (phiên #51 — CRB · P0-7 #57). */
export interface ServiceRunContext {
  /** Kết quả RiskQuantEngine của chu kỳ — exposure A7 đọc hạn mức ĐỘNG. */
  riskQuant?: RiskQuantResult | null;
  /** P0-7 (phiên #57) — verdict A9 CÙNG CHU KỲ cho S1 (đợt A nhịp 3 — §3.3
   *  blueprint: S0∥S2 → A9 → S1 đọc verdict vừa lưu). */
  dataQuality?: DataQualityVerdict | null;
}

/** A7 Exposure — VETO phơi nhiễm ngành & vị thế đơn (phiên #51 — CRB: ngưỡng ĐỘNG). */
async function runExposure(ctx?: ServiceRunContext): Promise<ServiceRunResult> {
  // AUD-CODE #15: hạn mức đọc từ roster config — MỘT nguồn duy nhất (không mirror tay)
  const exposureCfg = ROSTER_BY_CODE.get("exposure")?.config as
    | { maxSectorWeightPct?: number; maxPositionPct?: number }
    | undefined;
  const MAX_SECTOR = exposureCfg?.maxSectorWeightPct ?? 40; // % NAV (tĩnh)
  const MAX_POSITION = exposureCfg?.maxPositionPct ?? 25; // % NAV (tĩnh)
  // CRB v1.1 §3: engine ok → ngưỡng VETO dùng hạn mức ĐỘNG (CRB-1 hai chiều
  // hợp nhất CRB-7 min); engine lỗi/thiếu → fallback tĩnh (fail-safe VETO-cứng)
  const rq = ctx?.riskQuant?.ok ? ctx.riskQuant : null;
  const dynSector = rq ? rq.dynMaxSectorPct : MAX_SECTOR;
  const dynPosition = rq ? rq.dynMaxPositionPct : MAX_POSITION;
  const snap = await portfolioSnapshot();
  const topSector = snap.sectorWeights[0];
  const topPosition = [...snap.positions].sort((a, b) => b.mv - a.mv)[0];
  const positionPct =
    topPosition && snap.equity > 0 ? (topPosition.mv / snap.equity) * 100 : 0;

  const breaches: string[] = [];
  if (topSector && topSector.pct > dynSector) {
    breaches.push(`ngành ${topSector.sector} ${topSector.pct.toFixed(1)}% > ${dynSector.toFixed(1)}%`);
  }
  if (topPosition && positionPct > dynPosition) {
    breaches.push(`vị thế ${topPosition.symbol} ${positionPct.toFixed(1)}% > ${dynPosition.toFixed(1)}%`);
  }
  const verdict = breaches.length ? "VETO tín hiệu tăng phơi nhiễm" : "ĐẠT";
  // Hệ số hợp nhất thực tế (CRB-1 volMult × CRB-7 learning, kẹp [0,6 · 1,15])
  const mergedFactor = MAX_POSITION > 0 ? dynPosition / MAX_POSITION : 1;
  const dynNote = rq
    ? ` Hạn mức động CRB: ${dynPosition.toFixed(1).replace(".", ",")}%/vị thế · ${dynSector.toFixed(1).replace(".", ",")}%/ngành (tĩnh ${MAX_POSITION}/${MAX_SECTOR}% × hệ số ${mergedFactor.toFixed(2).replace(".", ",")}${mergedFactor > 1 + 1e-9 ? " — nới theo biến động thấp, đã phát INFO alert" : ""}).`
    : "";

  return {
    content: `Kiểm tra phơi nhiễm (NAV ${vnd(snap.equity)} ₫): ngành lớn nhất ${topSector ? `${topSector.sector} ${topSector.pct.toFixed(1)}%` : "—"} (hạn ${dynSector.toFixed(1).replace(".", ",")}%) · vị thế lớn nhất ${topPosition ? `${topPosition.symbol} ${positionPct.toFixed(1)}%` : "—"} (hạn ${dynPosition.toFixed(1).replace(".", ",")}%) → ${verdict}.${dynNote}${breaches.length ? " Danh mục đã vượt hạn mức — ưu tiên SELL cắt tỷ trọng." : ""}`,
    reasoning: rq
      ? "Tỷ trọng ngành/vị thế từ Position × giá / equity F-102; ngưỡng = hạn mức ĐỘNG CRB-1×CRB-7 — VETO giữ nguyên ngữ nghĩa, chỉ ngưỡng thay đổi."
      : "Tính tỷ trọng ngành/vị thế từ Position × giá hiện tại / equity F-102.",
    sentiment: breaches.length ? "bearish" : "neutral",
    output: {
      verdict,
      breaches,
      topSector,
      topPositionPct: Number(positionPct.toFixed(2)),
      dynamic: rq
        ? {
            enabled: true,
            staticSectorPct: MAX_SECTOR,
            staticPositionPct: MAX_POSITION,
            dynSectorPct: Number(dynSector.toFixed(2)),
            dynPositionPct: Number(dynPosition.toFixed(2)),
            volMult: Number(rq.vol.mult.toFixed(3)),
            mergedMult: Number(mergedFactor.toFixed(3)),
            volRatio: Number(rq.vol.volRatio.toFixed(3)),
            proxyMode: rq.proxyMode,
          }
        : { enabled: false },
    },
  };
}

/** A8 Compliance — VETO tuân thủ chế độ giao dịch & phiên. */
async function runCompliance(): Promise<ServiceRunResult> {
  const mode = getTradingMode();
  const phase = sessionPhase(new Date());
  const snap = await portfolioSnapshot();
  const marginRoom = snap.equity - snap.marginUsed;

  const checks = [
    `chế độ ${TRADING_MODE_LABEL[mode.mode]}`,
    `phiên: ${SESSION_PHASE_LABEL[phase]}`,
    `biên margin ${marginRoom >= 0 ? "duy dương" : "AM"} (${vnd(marginRoom)} ₫)`,
    "phê duyệt trader bắt buộc trước mọi lệnh",
  ];
  const veto = marginRoom < 0 || mode.mode === "live-unconfigured";
  const verdict = veto ? "VETO giao dịch mới" : "ĐẠT";

  return {
    content: `Đối chiếu tuân thủ: ${checks.join(" · ")} → ${verdict}.${veto ? " Tín hiệu chỉ được ghi nhận, không trình duyệt lệnh mới cho đến khi xử lý xong." : ""}`,
    reasoning: "getTradingMode + sessionPhase + biên margin từ tài khoản.",
    sentiment: veto ? "bearish" : null,
    output: { verdict, mode: mode.mode, phase, marginRoom },
  };
}

/* ───────────────────── Nhóm 3 · executive (service) ───────────────────── */

/** A11 Settlement — ReconciliationReport 6 phép idempotent (E-P0-3, v1.1).
 *  Trước P0: reduce Trade cửa sổ 24h trượt theo run — cùng 1 Trade bị đếm ở
 *  nhiều chu kỳ, 0 phép đối chiếu (báo cáo suông). Giờ: checkpoint AppSetting
 *  exec.reconcile + 6 phép (kèm order-fee-ledger REV-8 + whitelist REV-12).
 *  E-P1-5 (v1.2): + quét bất thường giao dịch IQR + z-score ±2σ trên CHÍNH
 *  window reconciliation vừa đóng (lấy checkpoint TRƯỚC khi runReconciliation
 *  ghi checkpoint mới) → RiskAlert INFO nhẹ (không ack-bắt-buộc).
 *  Fail-soft §6.6: lỗi query → DEGRADED, không sập chu kỳ. */
async function runSettlement(): Promise<ServiceRunResult> {
  try {
    // Window của lần đối chiếu SẮP chạy = [checkpoint hiện tại, now) — đọc
    // trước để anomaly scan soi đúng cùng window (không đếm trùng chu kỳ sau).
    const prevCp = await db.appSetting.findUnique({
      where: { key: RECONCILE_CHECKPOINT_KEY },
      select: { value: true },
    });
    let windowFrom: Date | null = null;
    try {
      const parsed = prevCp ? (JSON.parse(prevCp.value) as { lastReconciledAt?: unknown }) : null;
      windowFrom =
        parsed && typeof parsed.lastReconciledAt === "string"
          ? new Date(parsed.lastReconciledAt)
          : null;
    } catch {
      windowFrom = null;
    }

    const report = await runReconciliation();

    // E-P1-5: quét bất thường trên window vừa đối chiếu — fail-soft riêng
    // (lỗi scan KHÔNG làm hỏng reconciliation report).
    let anomaly: AnomalyScanResult | null = null;
    try {
      if (windowFrom != null && !report.baseline) {
        // F-73B-11: dùng đúng mép window reconciliation vừa chạy (report.window.toNow)
        // thay vì new Date() sau đó — không quét trùng trade trong khe giữa 2 mốc.
        const windowTo = report.window.toNow ? new Date(report.window.toNow) : new Date();
        anomaly = await detectTradeAnomalies(windowFrom, windowTo);
        await raiseAnomalyAlert(anomaly);
      }
    } catch (anErr) {
      console.error("[agent-service-runs:settlement:anomaly]", anErr);
    }

    return {
      content:
        reconcileReportSummary(report) +
        (anomaly ? ` ${anomalyScanSummary(anomaly)}` : ""),
      reasoning:
        "ReconciliationReport 6 phép idempotent — checkpoint AppSetting exec.reconcile (E-P0-3 EXECUTION_OPS_BLUEPRINT v1.1)" +
        (anomaly
          ? " + quét bất thường IQR/z-score ±2σ cùng window (E-P1-5 v1.2)"
          : ""),
      sentiment:
        report.verdict === "MISMATCH" || (anomaly != null && anomaly.anomalies.length > 0)
          ? "bearish"
          : null,
      output: {
        ...(report as unknown as Record<string, unknown>),
        ...(anomaly ? { anomaly: anomaly as unknown as Record<string, unknown> } : {}),
      },
    };
  } catch (err) {
    console.error("[agent-service-runs:settlement]", err);
    return {
      content:
        "Bù trừ sổ sách: DEGRADED — lỗi truy vấn dữ liệu đối chiếu (không sập chu kỳ, §6.6 graceful). Chạy lại chu kỳ sau.",
      reasoning: "runReconciliation throw — fail-soft trả verdict DEGRADED.",
      sentiment: null,
      output: { verdict: "DEGRADED", error: err instanceof Error ? err.message : String(err) },
    };
  }
}

/** A12 Cash Management — CommittedCashView (E-P0-4, v1.1 — REV-1):
 *  sức mua KỂ CẢ cam kết tiềm năng (tín hiệu ACTIVE nav5pct + notional còn lại
 *  của lệnh PENDING/PARTIALLY_FILLED — cam kết thật phủ cả 2 đường sizing).
 *  E-P1-3 (v1.2): + snapshot cash mỗi chu kỳ (điều kiện tiên quyết §8) +
 *  CashflowForecast kịch bản {none, half, allApprove} + CI 95% quantile
 *  (TypeScript thuần — §7.5 mặc định trader duyệt; KHÔNG chặn lệnh §6.4). */
async function runCashManagement(): Promise<ServiceRunResult> {
  const snap = await portfolioSnapshot();
  const cashCfg = ROSTER_BY_CODE.get("cash-management")?.config as
    | { marginRoomMinVnd?: number; buyingPowerFactor?: number }
    | undefined;
  const factor = cashCfg?.buyingPowerFactor ?? 0.5;
  const marginMin = cashCfg?.marginRoomMinVnd ?? 500_000_000;

  // Tài khoản sống (để gắn snapshot chuỗi cash đúng brokerAccountId).
  const account = await db.brokerAccount.findFirst({
    where: { deletedAt: null },
    select: { id: true },
  });

  try {
    const view = await computeCommittedCashView({
      cash: snap.cash,
      equity: snap.equity,
      marginUsed: snap.marginUsed,
      buyingPowerFactor: factor,
      marginRoomMinVnd: marginMin,
    });

    // E-P1-3: ghi snapshot cash chu kỳ này (điều kiện tiên quyết dự báo) +
    // tính CashflowForecast từ chuỗi + cam kết hiện tại — fail-soft riêng
    // (lỗi forecast KHÔNG làm hỏng committed view).
    let forecast: CashflowForecast | null = null;
    try {
      if (account) {
        await recordCashSnapshot({
          brokerAccountId: account.id,
          cash: view.cash,
          equity: view.equity,
        });
      }
      forecast = await computeCashflowForecast(
        {
          cash: view.cash,
          committedBuyNotional: view.committedBuyNotional,
          committedSellInflow: view.committedSellInflow,
        },
        account?.id
      );
    } catch (fcErr) {
      console.error("[agent-service-runs:cash-management:forecast]", fcErr);
    }

    return {
      content:
        committedViewSummary(view) +
        (forecast ? ` ${forecastSummary(forecast)}` : ""),
      reasoning:
        "buyingPower = cash + GTTH×factor − margin (AUD-CODE #15b) + committed view tín hiệu ACTIVE & lệnh PENDING (E-P0-4 v1.1 — REV-1)" +
        (forecast
          ? " + CashflowForecast baseline tuyến tính + quantile CI95 (E-P1-3 v1.2 — TS thuần §7.5)"
          : ""),
      sentiment: view.committedTight || view.tight ? "neutral" : null,
      output: {
        ...(view as unknown as Record<string, unknown>),
        ...(forecast ? { forecast: forecast as unknown as Record<string, unknown> } : {}),
      },
    };
  } catch (err) {
    console.error("[agent-service-runs:cash-management]", err);
    // Fallback công thức chuẩn AUD-CODE #15b — không đếm kép cash
    const positionsMv = Math.max(0, snap.equity - snap.cash);
    const buyingPower = snap.cash + positionsMv * factor - snap.marginUsed;
    return {
      content: `Dòng tiền: tiền mặt ${vnd(snap.cash)} ₫ · NAV ${vnd(snap.equity)} ₫ · sức mua ước tính ${vnd(buyingPower)} ₫ (committed view DEGRADED — lỗi truy vấn, §6.6).`,
      reasoning: "computeCommittedCashView throw — fallback công thức AUD-CODE #15b.",
      sentiment: null,
      output: { cash: snap.cash, equity: snap.equity, marginUsed: snap.marginUsed, buyingPower, verdict: "DEGRADED" },
    };
  }
}

/* ───────────── Nhóm 5 · ml + rl (phiên #35 — mô hình học THẬT) ───────────── */

/** Parse JSON metrics của MlModel — null khi hỏng. */
function parseModelMetrics(json: string): Record<string, unknown> | null {
  try {
    const m = JSON.parse(json) as Record<string, unknown>;
    return typeof m === "object" && m !== null ? m : null;
  } catch {
    return null;
  }
}

/** Mô hình serving mới nhất theo kind — null khi chưa từng train. */
async function servingModel(kind: "dl-mlp" | "rl-q") {
  return db.mlModel.findFirst({
    where: { kind, status: "serving" },
    orderBy: { version: "desc" },
  });
}

/** Số giờ (làm tròn) kể từ trainedAt → "x giờ trước". */
function hoursAgo(at: Date): string {
  const h = Math.max(0, Math.round((Date.now() - at.getTime()) / 3_600_000));
  return h <= 0 ? "vừa xong" : `${h} giờ trước`;
}

/** A13 Learning & RAG — ký ức phân tích tích luỹ.
 *  L1 (#83 — ML_LEARNING_BLUEPRINT §2): giờ báo cáo CỔNG RAG thật — corpus
 *  (500 broadcast + 200 tin) + 30 ngày RetrievalLog (đo "RAG được nhìn thấy
 *  chưa" — cổng L3) thay vì chỉ đếm như trước. */
async function runLearningRag(): Promise<ServiceRunResult> {
  // ragStats fail-soft nội bộ (lỗi DB → số 0) — A13 không bao giờ làm hỏng đợt.
  const [stats, broadcastCount, distinctAgents, newsTotal] = await Promise.all([
    ragStats(),
    db.agentMessage.count({ where: { broadcast: true } }),
    db.agentMessage.groupBy({ by: ["fromAgentId"], where: { broadcast: true } }),
    db.newsItem.count(),
  ]);
  const agents = distinctAgents.length;
  const usage =
    stats.usageRate30d == null
      ? "chưa có mẫu"
      : `${(stats.usageRate30d * 100).toFixed(0)}%`;
  const lastAt = stats.lastRetrievalAt
    ? new Date(stats.lastRetrievalAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })
    : "chưa từng";

  return {
    content: `Ký ức đội agent: ${broadcastCount.toLocaleString("vi-VN")} tin broadcast từ ${agents} agent + ${newsTotal.toLocaleString("vi-VN")} tin tức đã nạp. Truy hồi RAG (BM25 + recency, L1): corpus đang lập chỉ mục ${stats.corpusMessages} tin + ${stats.corpusNews} tin; 30 ngày qua ${stats.retrievals30d} lần truy hồi — ${stats.usedInPrompt30d} lần được tiêm vào prompt (tỉ lệ ${usage}); lần cuối ${lastAt}. Top-8 tri thức liên quan đã nối vào prompt 5 agent nghiên cứu + Chủ tịch mỗi chu kỳ.`,
    reasoning:
      "Đếm AgentMessage broadcast + NewsItem; đọc corpus RAG + RetrievalLog 30 ngày (L1).",
    sentiment: null,
    output: {
      broadcastCount,
      agents,
      newsTotal,
      retrievalTopK: 8,
      rag: {
        corpusMessages: stats.corpusMessages,
        corpusNews: stats.corpusNews,
        retrievals30d: stats.retrievals30d,
        usedInPrompt30d: stats.usedInPrompt30d,
        usageRate30d: stats.usageRate30d,
        lastRetrievalAt: stats.lastRetrievalAt?.toISOString() ?? null,
      },
    },
  };
}

/** A14 Backtest — kiểm định chiến lược tham chiếu equal-weight. */
async function runBacktest(): Promise<ServiceRunResult> {
  const top = await topLiquid(10);
  // AUD-CODE #7: top rỗng → Math.min(...[]) = Infinity xuyên qua guard minLen < 31
  if (top.length === 0) {
    return {
      content: "Chưa có dữ liệu bảng giá để kiểm định chiến lược — bỏ qua chu kỳ này.",
      reasoning: "topLiquid trả về rỗng (DB chưa có bar/quote).",
      sentiment: null,
      output: { skipped: true, minLen: 0 },
    };
  }
  const minLen = Math.min(...top.map((t) => t.closes.length));
  if (!Number.isFinite(minLen) || minLen < 31) {
    return {
      content: "Chưa đủ dữ liệu 90 phiên để kiểm định chiến lược tham chiếu — bỏ qua chu kỳ này.",
      reasoning: "Chuỗi closes ngắn hơn 31 phiên.",
      sentiment: null,
      output: { skipped: true, minLen },
    };
  }
  // Basket index: chuẩn hoá mỗi mã về ngày đầu = 1, lấy trung bình
  const align = Math.min(90, minLen);
  const starts = top.map((t) => t.closes[t.closes.length - align]);
  const index: number[] = [];
  for (let i = 0; i < align; i++) {
    const vals = top.map((t, k) => t.closes[t.closes.length - align + i] / starts[k]);
    index.push(meanOf(vals));
  }
  const totalRet = (index[index.length - 1] / index[0] - 1) * 100;
  const ret30 = (index[index.length - 1] / index[Math.max(0, index.length - 31)] - 1) * 100;
  const dailyRets: number[] = [];
  for (let i = 1; i < index.length; i++) dailyRets.push(index[i] / index[i - 1] - 1);
  const volAnn = stdOf(dailyRets) * Math.sqrt(252) * 100;
  let peak = index[0];
  let maxDD = 0;
  for (const v of index) {
    peak = Math.max(peak, v);
    maxDD = Math.min(maxDD, (v / peak - 1) * 100);
  }

  return {
    content: `Kiểm định equal-weight top-10 thanh khoản (${align} phiên): tổng ${fmtPct(totalRet)} · 30 phiên gần ${fmtPct(ret30)} · biến động năm hoá ${volAnn.toFixed(1)}% · drawdown tối đa ${maxDD.toFixed(1)}%. Ngưỡng tham chiếu: drawdown danh mục ≤ 15%.`,
    reasoning: "Basket index chuẩn hoá + stdev×√252 + peak-to-trough.",
    sentiment: ret30 > 1 ? "bullish" : ret30 < -1 ? "bearish" : "neutral",
    output: { totalRetPct: Number(totalRet.toFixed(2)), ret30Pct: Number(ret30.toFixed(2)), volAnnPct: Number(volAnn.toFixed(1)), maxDDPct: Number(maxDD.toFixed(1)) },
  };
}

/** S3 RL Gym — trạng thái môi trường + tổng số episode đã chạy (thật). */
async function runRlGym(): Promise<ServiceRunResult> {
  const model = await servingModel("rl-q");
  if (!model) {
    // Chưa train: mô tả gym chờ huấn luyện (giữ stats môi trường cũ)
    const [instrumentCount, barCount] = await Promise.all([
      db.instrument.count({ where: { isActive: true } }),
      db.bar.count(),
    ]);
    return {
      content: `Môi trường giả lập sẵn sàng: ${instrumentCount} mã · ${barCount.toLocaleString("vi-VN")} phiên lịch sử · 48 trạng thái (xu hướng × bucket RSI rổ × động lượng 5 phiên × phơi nhiễm) × 3 hành động (giảm/hold/tăng exposure ±0,5). Chưa có episode huấn luyện nào — Q-table trống, gym chờ lệnh từ RL Trainer (POST /api/ml/train target rl-q).`,
      reasoning: "Đếm Instrument/Bar làm độ phủ môi trường (chưa có MlModel rl-q).",
      sentiment: null,
      output: { trained: false, instrumentCount, barCount, states: 48, actions: 3 },
    };
  }
  const metrics = parseModelMetrics(model.metrics);
  // Tổng episode mọi phiên bản kind rl-q (kể cả archived) — số thật tích luỹ
  const allVersions = await db.mlModel.findMany({
    where: { kind: "rl-q" },
    select: { metrics: true },
  });
  let episodesTotal = typeof metrics?.episodes === "number" ? (metrics.episodes as number) : 0;
  for (const v of allVersions) {
    const m = parseModelMetrics(v.metrics);
    if (m !== metrics && typeof m?.episodes === "number") episodesTotal += m.episodes as number;
  }
  const epsilonEnd = typeof metrics?.epsilonEnd === "number" ? metrics.epsilonEnd : null;
  const avgRewardLast50 =
    typeof metrics?.avgRewardLast50 === "number" ? metrics.avgRewardLast50 : null;
  return {
    content: `Gym Q-learning 48 trạng thái × 3 hành động: đã chạy tổng cộng ${episodesTotal.toLocaleString("vi-VN")} episode qua ${allVersions.length} phiên bản (bản serving v${model.version}, train ${hoursAgo(model.trainedAt)}) — ε khám phá kết thúc ${epsilonEnd != null ? epsilonEnd.toFixed(2) : "—"}, phần thưởng trung bình 50 episode cuối ${avgRewardLast50 != null ? (avgRewardLast50 >= 0 ? "+" : "") + avgRewardLast50.toFixed(3) : "—"} mỗi episode (~230 bước, reward = exposure×lợi nhuận rổ − 0,1% phí điều chỉnh).`,
    reasoning: "Đọc MlModel rl-q serving + cộng dồn metrics.episodes mọi phiên bản.",
    sentiment: null,
    output: {
      trained: true,
      version: model.version,
      versions: allVersions.length,
      episodesTotal,
      epsilonEnd,
      avgRewardLast50,
      states: 48,
      actions: 3,
    },
  };
}

/** A16 RL Policy — khuyến nghị phơi nhiễm từ Q-table THẬT (tham mưu). */
async function runRlPolicy(): Promise<ServiceRunResult> {
  const model = await servingModel("rl-q");
  if (!model) {
    return {
      content: "Chính sách Q-learning chưa huấn luyện — Q-learning chưa có Q-table, khuyến nghị phơi nhiễm giữ mặc định 0,5. Tín hiệu chu kỳ vẫn do Chủ tịch Hội đồng (LLM) quyết định — dùng nút 'Huấn luyện mô hình' trong workspace Tổng hợp hoặc POST /api/ml/train (target rl-q) để nạp Q-table 48×3.",
      reasoning: "Không có MlModel kind rl-q serving.",
      sentiment: null,
      output: { trained: false, policyVersion: null, states: 48, actions: 3, defaultExposure: 0.5 },
    };
  }
  const metrics = parseModelMetrics(model.metrics);
  const episodes = typeof metrics?.episodes === "number" ? (metrics.episodes as number) : 0;
  let content: string;
  let output: Record<string, unknown> = { trained: true, policyVersion: `v${model.version}`, episodes };
  try {
    const qTable = parseQTable(model.weights);
    const series = await loadTopSeries(10);
    const basket = buildBasket(series.map((s) => s.closes));
    const st = policyStance(qTable, basket, 0.5);
    const [pGiam, pGiu, pTang] = st.probsSoftmax;
    content = `Chính sách Q-learning v${model.version} sau ${episodes.toLocaleString("vi-VN")} episode khuyến nghị ${st.stance.toUpperCase()} phơi nhiễm (exposure ${(st.exposure * 100).toFixed(0)}%, Q-max ${st.qMax.toFixed(2)}, xác suất softmax tăng/giữ/giảm ${(pTang * 100).toFixed(1)}/${(pGiu * 100).toFixed(1)}/${(pGiam * 100).toFixed(1)}%) trên rổ top-10 thanh khoản. Tín hiệu cuối vẫn do Chủ tịch Hội đồng quyết định — RL ở chế độ tham mưu.`;
    output = {
      ...output,
      stance: st.stance,
      exposure: st.exposure,
      qMax: st.qMax,
      probsSoftmax: st.probsSoftmax,
      basketSessions: basket.length,
    };
  } catch {
    content = `Chính sách Q-learning v${model.version} (train ${hoursAgo(model.trainedAt)}) không đọc được Q-table từ kho trọng số — giữ khuyến nghị mặc định exposure 0,5. Tín hiệu cuối vẫn do Chủ tịch Hội đồng quyết định — RL ở chế độ tham mưu.`;
  }
  return {
    content,
    reasoning: "parseQTable(MlModel.weights) + policyStance trên rổ top-10 hiện tại.",
    sentiment: null,
    output,
  };
}

/** A17 DL Trainer — metrics MLP thật + dự đoán hiện tại qua latestFeatures. */
async function runDlTrainer(): Promise<ServiceRunResult> {
  const model = await servingModel("dl-mlp");
  if (!model) {
    return {
      content: "Chưa có mô hình học sâu — dùng nút 'Huấn luyện mô hình' trong workspace Tổng hợp hoặc POST /api/ml/train (target dl-mlp). MLP 10→16 ReLU→8 ReLU→3 softmax sẽ học trên ~50k mẫu EOD top-20 thanh khoản (backprop + Adam, dự báo hướng 5 phiên tới).",
      reasoning: "Không có MlModel kind dl-mlp serving.",
      sentiment: null,
      output: { hasModel: false, hint: "POST /api/ml/train {\"target\":\"dl-mlp\"}" },
    };
  }
  const metrics = parseModelMetrics(model.metrics);
  const num = (k: string): number | null =>
    typeof metrics?.[k] === "number" ? (metrics[k] as number) : null;
  const topSymbols = Array.isArray(metrics?.topSymbols) ? (metrics.topSymbols as string[]) : [];
  let content: string;
  let output: Record<string, unknown> = { hasModel: true, version: model.version, metrics };
  let sentiment: ServiceRunResult["sentiment"] = null;
  try {
    const mlp = MLP.fromJSON(model.weights);
    const feats = await latestFeatures(); // top-10 phiên cuối
    const preds = feats.slice(0, 5).map((f) => ({ symbol: f.symbol, p: mlp.predictProba(f.x) }));
    if (preds.length > 0) {
      const avgUp = meanOf(preds.map((r) => r.p[0]));
      const avgDown = meanOf(preds.map((r) => r.p[2]));
      const diff = avgUp - avgDown;
      const lean =
        diff > 0.05 ? "nghiêng TĂNG" : diff < -0.05 ? "nghiêng GIẢM" : "đi ngang/chưa tách bạch";
      content = `Mạng MLP 10→16→8→3 v${model.version} đang phục vụ (train ${hoursAgo(model.trainedAt)}): ${num("samples")?.toLocaleString("vi-VN") ?? "—"} mẫu · ${num("epochs") ?? "—"} epoch · chính xác kiểm định ${num("valAcc") != null ? ((num("valAcc") as number) * 100).toFixed(1) + "%" : "—"} · mất mát kiểm định ${num("valLoss")?.toFixed(3) ?? "—"}. Mã đóng góp mạnh: ${topSymbols.slice(0, 5).join(", ") || "—"}. Dự đoán hiện tại trên ${preds.length} mã thanh khoản nhất: p(tăng) ${(avgUp * 100).toFixed(1)}% / p(giảm) ${(avgDown * 100).toFixed(1)}% — mô hình ${lean}.`;
      sentiment = diff > 0.05 ? "bullish" : diff < -0.05 ? "bearish" : "neutral";
      output = {
        ...output,
        predictions: preds.map((r) => ({
          symbol: r.symbol,
          pUp: Number(r.p[0].toFixed(4)),
          pFlat: Number(r.p[1].toFixed(4)),
          pDown: Number(r.p[2].toFixed(4)),
        })),
        avgPUp: Number(avgUp.toFixed(4)),
        avgPDown: Number(avgDown.toFixed(4)),
      };
      return {
        content,
        reasoning: "MlModel dl-mlp serving + MLP.fromJSON → predictProba trên latestFeatures().",
        sentiment,
        output,
      };
    }
    content = `Mạng MLP 10→16→8→3 v${model.version} đang phục vụ (train ${hoursAgo(model.trainedAt)}): ${num("samples")?.toLocaleString("vi-VN") ?? "—"} mẫu · ${num("epochs") ?? "—"} epoch · chính xác kiểm định ${num("valAcc") != null ? ((num("valAcc") as number) * 100).toFixed(1) + "%" : "—"}. Mã đóng góp mạnh: ${topSymbols.slice(0, 5).join(", ") || "—"}. Chưa đủ dữ liệu phiên cuối để dự đoán serving.`;
  } catch {
    content = `Mạng MLP v${model.version} (train ${hoursAgo(model.trainedAt)}) không nạp được trọng số từ kho — cần huấn luyện lại qua POST /api/ml/train (target dl-mlp).`;
  }
  return {
    content,
    reasoning: "MlModel dl-mlp serving (metrics thật; serving thiếu dữ liệu/lỗi → trung thực).",
    sentiment,
    output,
  };
}

/** A18 RL Trainer — kết toán bandit Thompson sampling (0 LLM, nhanh). */
async function runRlTrainer(): Promise<ServiceRunResult> {
  let result: Awaited<ReturnType<typeof settlePendingRewards>>;
  try {
    result = await settlePendingRewards();
  } catch (err) {
    console.error("[runRlTrainer] settlePendingRewards lỗi:", err);
    return {
      content: "Kết toán bandit lỗi (truy vấn dữ liệu giá) — thử lại chu kỳ sau. Posterior các arm giữ nguyên.",
      reasoning: "settlePendingRewards throw — không đổi alpha/beta.",
      sentiment: null,
      output: { error: true },
    };
  }
  const pending = await pendingSettleCount().catch(() => 0);
  const snapshot = await banditSnapshot().catch(() => null);
  const topArm = snapshot?.arms[0];

  const rewardLines = (result.details ?? [])
    .map((d) => `${d.agentName}: reward ${d.reward.toFixed(1)}`)
    .join(" · ");
  const parts = [
    `Kết toán bandit Thompson sampling: đối chiếu ${(result.votes + pending).toLocaleString("vi-VN")} phiếu bầu cũ với giá thực tế — ${result.settled} assessment đủ 5 phiên tuổi được kết toán (${result.votes} phiếu), ${pending.toLocaleString("vi-VN")} phiếu chờ tới phiên thứ 5.`,
    topArm
      ? `Posterior hiện tại: ${topArm.name} dẫn đầu ${(topArm.posteriorMean * 100).toFixed(1)}% (α ${topArm.alpha.toFixed(1)} · β ${topArm.beta.toFixed(1)} · ${topArm.pulls} pulls)${snapshot && snapshot.arms.length > 1 ? `, theo sau ${snapshot.arms[1].name} ${(snapshot.arms[1].posteriorMean * 100).toFixed(1)}%` : ""}.`
      : "Chưa có arm bandit nào trong kho.",
    result.votes > 0 && rewardLines ? `Chi tiết phiếu kết toán: ${rewardLines}.` : "",
  ].filter(Boolean);

  return {
    content: parts.join(" "),
    reasoning: "settlePendingRewards (đối chiếu realized rổ top-10 5 phiên) + banditSnapshot posterior Beta(α+1,β+1).",
    sentiment: null,
    output: {
      settled: result.settled,
      votes: result.votes,
      pending,
      arms: snapshot?.arms ?? [],
      details: result.details ?? [],
    },
  };
}

/** A19 Model Registry — sổ đăng ký ĐỘNG (đúng version/status/trainedAt thật). */
async function runModelRegistry(): Promise<ServiceRunResult> {
  const llm = llmStatus();
  const serving = await db.mlModel.findMany({
    where: { status: "serving" },
    orderBy: { kind: "asc" },
  });
  const dl = serving.find((m) => m.kind === "dl-mlp");
  const rl = serving.find((m) => m.kind === "rl-q");

  const models: Record<string, unknown>[] = [
    {
      name: `LLM backbone · ${llm.model}`,
      provider: llm.provider,
      status: llm.free ? "free-tier" : "production",
      version: llm.model,
    },
    {
      name: "Chỉ báo kỹ thuật SMA/RSI/MACD/BOLL",
      provider: "deterministic",
      status: "production",
      version: "indicators-v1",
    },
    {
      name: "Dự báo momentum tuyến tính (ml-forecast)",
      provider: "deterministic",
      status: "serving",
      version: "linreg-v0",
    },
  ];
  if (dl) {
    models.push({
      name: "Mạng nơ-ron MLP dự báo 5 phiên (dl-trainer)",
      provider: "deterministic",
      status: "serving",
      version: `v${dl.version}`,
      trainedAt: dl.trainedAt.toISOString(),
    });
  }
  if (rl) {
    models.push({
      name: "Chính sách Q-learning 48×3 (rl-policy)",
      provider: "deterministic",
      status: "serving",
      version: `v${rl.version}`,
      trainedAt: rl.trainedAt.toISOString(),
    });
  }

  const mlPart = [
    dl
      ? `MLP dl-mlp v${dl.version} (serving, train ${hoursAgo(dl.trainedAt)})`
      : "MLP dl-mlp chưa huấn luyện",
    rl
      ? `Q-learning rl-q v${rl.version} (serving, train ${hoursAgo(rl.trainedAt)})`
      : "Q-learning rl-q chưa huấn luyện",
  ].join(" · ");

  return {
    content: `Sổ đăng ký ${models.length} mô hình đang phục vụ: LLM backbone ${llm.model} (${llm.provider}${llm.free ? ", free-tier" : ""}) · chỉ báo kỹ thuật indicators-v1 (production) · dự báo momentum tuyến tính linreg-v0 (serving) · ${mlPart}. Bandit Thompson sampling 5 arm chạy kèm bộ tổng hợp Bayes (không phải model riêng).`,
    reasoning: "llmStatus() + findMany MlModel status serving (động theo kho thật).",
    sentiment: null,
    output: { models, registryVersion: "2026.1-ml" },
  };
}

/* ───────────────────────────── Cổng gọi chung ───────────────────────────── */

const SERVICE_RUNNERS: Record<string, (ctx?: ServiceRunContext) => Promise<ServiceRunResult>> = {
  "data-collector": runDataCollector,
  "notification-officer": runNotificationOfficer,
  "feature-store": runFeatureStore,
  "data-integrity": runDataIntegrity,
  "ml-forecast": runMlForecast,
  exposure: runExposure,
  compliance: runCompliance,
  settlement: runSettlement,
  "cash-management": runCashManagement,
  "learning-rag": runLearningRag,
  backtest: runBacktest,
  "rl-gym": runRlGym,
  "rl-policy": runRlPolicy,
  "dl-trainer": runDlTrainer,
  "rl-trainer": runRlTrainer,
  "model-registry": runModelRegistry,
};

/**
 * Chạy một service agent (deterministic). Ném lỗi nếu code không phải
 * service agent — caller xử lý persist FAILED như LLM agents. ctx (phiên
 * #51 — CRB) truyền kết quả RiskQuantEngine cho các agent cần (exposure A7).
 */
export function runServiceAgent(
  code: string,
  ctx?: ServiceRunContext
): Promise<ServiceRunResult> {
  const runner = SERVICE_RUNNERS[code];
  if (!runner) {
    throw new Error(`"${code}" không phải service agent (kiểm tra agent-roster.ts kind).`);
  }
  return runner(ctx);
}
