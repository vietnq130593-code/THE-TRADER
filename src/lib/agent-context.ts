import { db } from "@/lib/db";
import { atr, bollinger, stochastic } from "@/lib/indicators";
import { topByAdtv } from "@/lib/dated-series";
import { latestFeatureSnapshot } from "@/lib/ml/features";
import { latestNewsForContext } from "@/lib/news";
import { getForeignFlows, flowsPromptBlock } from "@/lib/flows";
import { loadLatestAssessment } from "@/lib/bayes/persist";
// E-P1-1 (EXECUTION_OPS_BLUEPRINT v1.2): config phân bổ A1 có consumer —
// prompt Chủ tịch đọc targetPositions/rebalanceThresholdPct/style từ nguồn đơn.
import {
  ALLOCATION_TARGET_POSITIONS,
  ALLOCATION_REBALANCE_THRESHOLD_PCT,
  ALLOCATION_STYLE,
} from "@/lib/exec/allocation";
// L1 (#83 — ML_LEARNING_BLUEPRINT §2): BM25 RAG cho single-run của 5 agent
// nghiên cứu + Chủ tịch (chu kỳ tiêm ở api/agents/run — cùng 1 thư viện).
import { retrieveForCycle } from "@/lib/ml/rag";

/**
 * Khối ngữ cảnh + role-prompt DÙNG CHUNG cho single-run & chat
 * (PHASE3_BLUEPRINT §4.6) — trích xuất từ POST /api/agents/run.
 *
 * Các builder lấy dữ liệu thật từ DB (quotes/positions/account/news/flows);
 * không bao giờ bịa số liệu. equity = cash + Σ(qty×last) vị thế mở (F-102).
 *
 * Mở rộng 23 agents: thêm buildValuationBlock (A3 Fair Value) và
 * buildLiquidityBlock (A5 Liquidity); ROLE_PROMPTS đủ 23 agents
 * (LLM agents có system đầy đủ — service agents có identity prompt cho chat).
 */

/** Kết quả snapshot thị trường — kèm map symbol → instrumentId để validate tín hiệu. */
export interface MarketSnapshot {
  /** Khối prompt đầy đủ (chu kỳ / single-run). */
  block: string;
  /** Bản rút gọn ~15 dòng cho chat (§4.4). */
  compact: string;
  /** equity = cash + Σ(qty × last) vị thế mở (F-102). */
  equity: number;
  /** symbol → instrumentId của các mã có báo giá (để đối chiếu tín hiệu strategist). */
  instrumentIdBySymbol: Map<string, string>;
}

/** Snapshot VN30 + bảng chỉ báo top-10 + danh mục + tài khoản + cảnh báo rủi ro.
 *  B5/B10 §3.8: bảng chính giữ top-10 HOSE-STOCK (continuity chuỗi #34) +
 *  1 dòng ĐA THỊ TRƯỜNG gọn cho agent nghiên cứu; instrumentIdBySymbol phủ
 *  TOÀN BỘ mã giao dịch được (trừ INDEX — không có tín hiệu cho chỉ số). */
export async function buildMarketBlock(): Promise<MarketSnapshot> {
  // F-73R2-03 (fixbug #73): positions lọc theo tài khoản sống — không trộn vị
  // thế của tài khoản khác/đã soft-delete (account fetch trước để lọc where).
  const account = await db.brokerAccount.findFirst({
    where: { deletedAt: null },
    select: { id: true, cashBalance: true, equity: true, marginUsed: true },
  });
  const [instruments, positions, alerts] = await Promise.all([
    db.instrument.findMany({
      where: { isActive: true },
      select: {
        id: true,
        symbol: true,
        sector: true,
        market: true,
        type: true,
        quotes: {
          orderBy: { tradedAt: "desc" },
          take: 1,
          select: { last: true, change: true, changePct: true, volume: true, floorPrice: true, ceilingPrice: true },
        },
      },
    }),
    db.position.findMany({
      where: account ? { brokerAccountId: account.id, status: "OPEN" } : { status: "OPEN" },
      include: {
        instrument: {
          select: {
            symbol: true,
            sector: true,
            quotes: { orderBy: { tradedAt: "desc" }, take: 1, select: { last: true, changePct: true } },
          },
        },
      },
    }),
    db.riskAlert.findMany({
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { severity: true, message: true },
    }),
  ]);

  // B5 — toàn bộ mã có quote (đa sàn) cho map tín hiệu + dòng ĐA THỊ TRƯỜNG
  const allQuoted = instruments
    .map((i) => {
      const q = i.quotes[0];
      return q && q.last > 0
        ? { id: i.id, symbol: i.symbol, sector: i.sector, market: i.market, type: i.type, ...q }
        : null;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  // Bảng chính: HOSE-STOCK (continuity #34 — prompt không phình §3.8)
  const quoteRows = allQuoted.filter((r) => r.market === "HOSE" && r.type === "STOCK");

  // P0-2 (phiên #57 — DATA_PLATFORM_BLUEPRINT): top-10 chọn qua rổ DUY NHẤT
  // `topByAdtv` (ADTV 45 phiên EOD từ Bar.value) — thay xếp theo quote volume
  // từng tick (lớp bug F6 còn sót 3 chỗ — §0.5 G2). Mã top-ADTV nhưng chưa có
  // quote → bỏ khỏi bảng (cần giá hiển thị), ghi thiếu ở khối đa thị trường.
  const adtvTop = await topByAdtv(10, { market: "HOSE", type: "STOCK" }).catch(() => []);
  const quotedById = new Map(quoteRows.map((r) => [r.id, r]));
  const top10 = adtvTop
    .map((t) => quotedById.get(t.id))
    .filter((r): r is NonNullable<typeof r> => r != null);

  // 1 dòng ĐA THỊ TRƯỜNG gọn (B5 — agent nghiên cứu thấy các sàn khác)
  const hnxCount = allQuoted.filter((r) => r.market === "HNX" && r.type === "STOCK").length;
  const upcomCount = allQuoted.filter((r) => r.market === "UPCOM" && r.type === "STOCK").length;
  const etfCount = allQuoted.filter((r) => r.type === "ETF").length;
  const vnindex = allQuoted.find((r) => r.symbol === "VNINDEX");
  const vnindexLine = vnindex
    ? `VN-Index ${(vnindex.last / 100).toLocaleString("vi-VN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${vnindex.changePct >= 0 ? "+" : ""}${vnindex.changePct.toFixed(2)}%)`
    : "VN-Index —";
  const multiMarketLine = `- ĐA THỊ TRƯỜNG (B5): HNX ${hnxCount} mã · UPCOM ${upcomCount} mã · ETF ${etfCount} mã · ${vnindexLine}`;

  const advancing = quoteRows.filter((r) => r.changePct > 0).length;
  const declining = quoteRows.filter((r) => r.changePct < 0).length;
  const avgChangePct = quoteRows.length
    ? quoteRows.reduce((s, r) => s + r.changePct, 0) / quoteRows.length
    : 0;
  const totalVolume = quoteRows.reduce((s, r) => s + r.volume, 0);
  const gainers = [...quoteRows].sort((a, b) => b.changePct - a.changePct).slice(0, 5);
  const losers = [...quoteRows].sort((a, b) => a.changePct - b.changePct).slice(0, 5);

  // ── Chỉ báo kỹ thuật top-10 thanh khoản (90 phiên) ──────────────────
  // B6 — MACD hist (×1000) · %B Bollinger · ATR14% · Stoch %K.
  // P0-3 (phiên #57): SMA/RSI/MACD/MOM5/KL-TL20 tính qua FEATURECONTRACT
  // `latestFeatureSnapshot` (ml/features.ts — nơi tính duy nhất); BOLL/ATR/
  // Stoch vẫn từ indicators.ts (vỏ API "giá trị cuối" cho chỉ báo ngoài hợp đồng).
  const barRows = await db.bar.findMany({
    where: { instrumentId: { in: top10.map((t) => t.id) } },
    orderBy: { date: "asc" },
    select: { instrumentId: true, close: true, high: true, low: true, volume: true },
  });
  const barsByInstrument = new Map<string, { closes: number[]; volumes: number[]; bars: { high: number; low: number; close: number }[] }>();
  for (const b of barRows) {
    let entry = barsByInstrument.get(b.instrumentId);
    if (!entry) {
      entry = { closes: [], volumes: [], bars: [] };
      barsByInstrument.set(b.instrumentId, entry);
    }
    entry.closes.push(b.close);
    entry.volumes.push(b.volume);
    entry.bars.push({ high: b.high, low: b.low, close: b.close });
  }
  const lastById = new Map(quoteRows.map((r) => [r.id, r.last]));
  const indicatorLines = top10.map((t) => {
    const bars = barsByInstrument.get(t.id);
    const closes = bars?.closes ?? [];
    const last = lastById.get(t.id) ?? (closes.length ? closes[closes.length - 1] : 0);
    // FEATURECONTRACT — cùng số với S2/evidence/MLP trên cùng chuỗi
    const snap = bars ? latestFeatureSnapshot(closes, bars.volumes) : null;
    const sma20 = snap?.sma20 ?? null;
    const sma50 = snap?.sma50 ?? null;
    const rsi14 = snap?.rsi14 ?? null;
    const chg5d = snap?.mom5Pct ?? null;
    const volRatio = snap?.volRatio20 ?? null;
    // B6 — 4 chỉ báo mở rộng (đơn vị: MACD hist tính theo nghìn ₫ = hist VND/1000;
    // %B 0..100; ATR14 % của giá; Stoch %K 0..100)
    const macdHist = snap?.macdHist ?? null;
    const percentB = bollinger(closes)?.percentB ?? null;
    const atr14 = bars ? atr(bars.bars, 14) : null;
    const atrPct = atr14 != null && last > 0 ? (atr14 / last) * 100 : null;
    const stochK = bars ? stochastic(bars.bars, 14)?.k ?? null : null;
    return [
      `${t.symbol} (${t.sector ?? "—"})`,
      `giá ${last.toLocaleString("vi-VN")}`,
      `HG ${t.changePct >= 0 ? "+" : ""}${t.changePct.toFixed(2)}%`,
      `SMA20 ${sma20 != null ? Math.round(sma20).toLocaleString("vi-VN") : "—"}`,
      `SMA50 ${sma50 != null ? Math.round(sma50).toLocaleString("vi-VN") : "—"}`,
      `RSI14 ${rsi14 != null ? rsi14.toFixed(0) : "—"}`,
      `MACDh ${macdHist != null ? (macdHist / 1000).toFixed(1) : "—"}`,
      `%B ${percentB != null ? (percentB * 100).toFixed(0) : "—"}`,
      `ATR14% ${atrPct != null ? atrPct.toFixed(2).replace(".", ",") : "—"}`,
      `Stoch%K ${stochK != null ? stochK.toFixed(0) : "—"}`,
      `5 phiên ${chg5d != null ? (chg5d >= 0 ? "+" : "") + chg5d.toFixed(2) + "%" : "—"}`,
      `KL/TL20 ${volRatio != null ? volRatio.toFixed(2) : "—"}`,
    ].join(" · ");
  });

  const positionLines = positions.map((p) => {
    const last = p.instrument.quotes[0]?.last ?? p.avgPrice;
    const pnl = (last - p.avgPrice) * p.quantity;
    const pnlPct = p.avgPrice > 0 ? ((last - p.avgPrice) / p.avgPrice) * 100 : 0;
    return `- ${p.instrument.symbol} (${p.instrument.sector ?? "—"}): ${p.quantity} cp @ ${p.avgPrice.toLocaleString("vi-VN")} → ${last.toLocaleString("vi-VN")} ₫ | Lãi/lỗ: ${Math.round(pnl).toLocaleString("vi-VN")} ₫ (${pnlPct.toFixed(2)}%)`;
  });

  // F-102 (audit 19-a): tổng tài sản = tiền mặt + GTTH vị thế mở (equity DB chỉ là snapshot)
  const positionsMv = positions.reduce(
    (s, p) => s + (p.instrument.quotes[0]?.last ?? p.avgPrice) * p.quantity,
    0
  );
  const equity = account ? Number(account.cashBalance) + positionsMv : 0;
  const sectorWeights = new Map<string, number>();
  for (const p of positions) {
    const last = p.instrument.quotes[0]?.last ?? p.avgPrice;
    const mv = last * p.quantity;
    sectorWeights.set(
      p.instrument.sector ?? "Khác",
      (sectorWeights.get(p.instrument.sector ?? "Khác") ?? 0) + mv
    );
  }
  const sectorLines = [...sectorWeights.entries()]
    .map(([sector, mv]) => {
      const pct = equity > 0 ? (mv / equity) * 100 : 0;
      return `- ${sector}: ${Math.round(mv).toLocaleString("vi-VN")} ₫ (~${pct.toFixed(1)}% NAV)`;
    })
    .sort((a, b) => b.localeCompare(a));

  const accountLine = `- Giá trị tài sản: ${equity.toLocaleString("vi-VN")} ₫ | Tiền mặt: ${account ? Number(account.cashBalance).toLocaleString("vi-VN") : 0} ₫ | Margin: ${account ? Number(account.marginUsed).toLocaleString("vi-VN") : 0} ₫`;

  const block = [
    "SNAPSHOT THỊ TRƯỜNG VN30 (HOSE) — PHIÊN HIỆN TẠI",
    `- Số mã: ${quoteRows.length} | Tăng: ${advancing} | Giảm: ${declining} | Biến động TB: ${avgChangePct.toFixed(2)}%`,
    multiMarketLine,
    `- Tổng khối lượng: ${totalVolume.toLocaleString("vi-VN")} cp`,
    `- Top tăng: ${gainers.map((g) => `${g.symbol} +${g.changePct.toFixed(2)}%`).join(", ")}`,
    `- Top giảm: ${losers.map((g) => `${g.symbol} ${g.changePct.toFixed(2)}%`).join(", ")}`,
    "",
    "BẢNG CHỈ BÁO KỸ THUẬT (10 mã thanh khoản cao nhất, 90 phiên — SMA · RSI · MACD hist (nghìn ₫) · %B · ATR14% · Stoch %K):",
    ...indicatorLines,
    "",
    "DANH MỤC ĐANG NẮM GIỮ:",
    positionLines.length ? positionLines.join("\n") : "- (trống)",
    "",
    "TỶ TRỌNG NGÀNH (theo NAV):",
    ...sectorLines,
    "",
    "TÀI KHOẢN VNDIRECT (paper):",
    accountLine,
    "",
    "CẢNH BÁO RỦI RO GẦN NHẤT:",
    alerts.length ? alerts.map((a) => `- [${a.severity}] ${a.message}`).join("\n") : "- (không có)",
  ].join("\n");

  // Bản rút gọn cho chat (§4.4): số mã/tăng/giảm + 5 dòng chỉ báo + 3 vị thế + tài khoản
  const compact = [
    "SNAPSHOT THỊ TRƯỜNG VN30 (HOSE) — RÚT GỌN",
    `- Số mã: ${quoteRows.length} | Tăng: ${advancing} | Giảm: ${declining} | Biến động TB: ${avgChangePct.toFixed(2)}%`,
    multiMarketLine,
    `- Top tăng: ${gainers.map((g) => `${g.symbol} +${g.changePct.toFixed(2)}%`).join(", ")}`,
    `- Top giảm: ${losers.map((g) => `${g.symbol} ${g.changePct.toFixed(2)}%`).join(", ")}`,
    "",
    "BẢNG CHỈ BÁO KỸ THUẬT (5 mã thanh khoản cao nhất, 90 phiên):",
    ...indicatorLines.slice(0, 5),
    "",
    "DANH MỤC ĐANG NẮM GIỮ (tối đa 3):",
    positionLines.length ? positionLines.slice(0, 3).join("\n") : "- (trống)",
    "",
    "TÀI KHOẢN VNDIRECT (paper):",
    accountLine,
  ].join("\n");

  return {
    block,
    compact,
    equity,
    // B5 — map phủ toàn bộ mã GIAO DỊCH được đa sàn (trừ INDEX — không ra
    // tín hiệu cho chỉ số); chairman có thể signal PVS/E1VFVN30… hợp lệ.
    instrumentIdBySymbol: new Map(
      allQuoted.filter((r) => r.type !== "INDEX").map((r) => [r.symbol, r.id])
    ),
  };
}

/** 10 tin RSS mới nhất (S5 · latestNewsForContext) — định dạng như run route. */
export async function buildNewsBlock(): Promise<string> {
  const newsItems = await latestNewsForContext(10);
  const newsAge = (d: Date) => {
    const h = Math.max(0, Math.round((Date.now() - d.getTime()) / 3_600_000));
    return h <= 0 ? "vừa xong" : h < 24 ? `${h}h trước` : `${Math.round(h / 24)} ngày trước`;
  };
  return newsItems.length
    ? [
        `TIN TỨC THỊ TRƯỜNG MỚI NHẤT (S5 · RSS ${[...new Set(newsItems.map((n) => n.source))].join(", ")}):`,
        ...newsItems.map(
          (n) =>
            `- [${n.source} · ${newsAge(n.publishedAt)}] ${n.title}${n.summary ? ` — ${n.summary.slice(0, 140)}` : ""}`
        ),
      ].join("\n")
    : "TIN TỨC THỊ TRƯỜNG: (chưa nạp được tin mới — nếu dùng, khai báo rõ 'no new data' và không bịa tin)";
}

/** Dòng khối ngoại (S6) — nguồn không khả dụng thì khai báo rõ để agent bỏ metric. */
export async function buildFlowsBlock(): Promise<string> {
  const flows = await getForeignFlows().catch(() => null);
  return flows
    ? flowsPromptBlock(flows)
    : "DÒNG KHỐI NGOẠI: (nguồn không khả dụng — bỏ metric này khỏi phân tích)";
}

/** Trung bình / độ lệch chuẩn — cho dải giá 90 phiên (A3 Fair Value). */
function meanOf(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}
function stdOf(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = meanOf(xs);
  return Math.sqrt(meanOf(xs.map((x) => (x - m) * (x - m))));
}

/**
 * Dải định giá 90 phiên cho top-10 thanh khoản (A3 Fair Value — mở rộng 23 agents):
 * giá hiện tại vs min/max/mean/σ, z-score, % so đỉnh/đáy 90 phiên.
 */
export async function buildValuationBlock(): Promise<string> {
  // B5 §3.4 — khoá rổ về HOSE-STOCK (continuity #34; universe đa sàn/index
  // volume ~2,1 tỷ không được tràn vào top-10 định giá)
  const instruments = await db.instrument.findMany({
    where: { isActive: true, market: "HOSE", type: "STOCK" },
    select: {
      id: true,
      symbol: true,
      sector: true,
      quotes: { orderBy: { tradedAt: "desc" }, take: 1, select: { last: true } },
    },
  });
  const quoteRows = instruments
    .map((i) => {
      const q = i.quotes[0];
      return q ? { id: i.id, symbol: i.symbol, sector: i.sector, last: q.last } : null;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  // P0-2 (phiên #57): top-10 qua rổ DUY NHẤT topByAdtv (ADTV 45 phiên
  // Bar.value) — thay xếp theo quote volume (lớp bug F6 còn sót)
  const adtvTop = await topByAdtv(10, { market: "HOSE", type: "STOCK" }).catch(() => []);
  const quotedById = new Map(quoteRows.map((r) => [r.id, r]));
  const top10 = adtvTop
    .map((t) => quotedById.get(t.id))
    .filter((r): r is NonNullable<typeof r> => r != null);

  const bars = await db.bar.findMany({
    where: { instrumentId: { in: top10.map((t) => t.id) } },
    orderBy: { date: "asc" },
    select: { instrumentId: true, close: true },
  });
  const closesBy = new Map<string, number[]>();
  for (const b of bars) {
    const arr = closesBy.get(b.instrumentId) ?? [];
    arr.push(b.close);
    closesBy.set(b.instrumentId, arr);
  }

  // B11 — cột P/E · EPS · BVPS · ROE CHỈ thêm khi nguồn finfo mode=real có dữ liệu
  // (pending-egress trong sandbox → giữ lời khai báo giới hạn trung thực như cũ)
  const fundStatus = await db.dataSourceStatus.findUnique({ where: { key: "fundamentals" } });
  const fundamentalsReal = fundStatus?.mode === "real";
  const fundByInstrument = new Map<
    string,
    { pe: number | null; eps: number | null; bvps: number | null; roe: number | null }
  >();
  if (fundamentalsReal) {
    const fundRows = await db.financialFundamental
      .findMany({
        where: { instrumentId: { in: top10.map((t) => t.id) }, mode: "real" },
        orderBy: [{ year: "desc" }, { period: "desc" }],
        select: { instrumentId: true, pe: true, eps: true, bvps: true, roe: true },
      })
      .catch(() => []);
    for (const f of fundRows) {
      //orderBy year/period desc → bản đầu mỗi instrument là mới nhất
      if (!fundByInstrument.has(f.instrumentId)) {
        fundByInstrument.set(f.instrumentId, { pe: f.pe, eps: f.eps, bvps: f.bvps, roe: f.roe });
      }
    }
  }

  const lines = top10.map((t) => {
    const closes = closesBy.get(t.id) ?? [];
    const last = t.last || (closes.length ? closes[closes.length - 1] : 0);
    if (closes.length < 20 || !last) {
      return `- ${t.symbol}: (không đủ dữ liệu dải giá)`;
    }
    const min = Math.min(...closes);
    const max = Math.max(...closes);
    const m = meanOf(closes);
    const sd = stdOf(closes);
    const z = sd > 0 ? (last - m) / sd : 0;
    const vsHigh = max > 0 ? ((last - max) / max) * 100 : 0;
    const vsLow = min > 0 ? ((last - min) / min) * 100 : 0;
    const band = z > 1.5 ? "ĐẮT bất thường" : z < -1.5 ? "RẺ bất thường" : "trong dải hợp lý";
    const f = fundByInstrument.get(t.id);
    const fundCols =
      fundamentalsReal && f
        ? [
            `P/E ${f.pe != null ? f.pe.toFixed(1).replace(".", ",") : "—"}`,
            `EPS ${f.eps != null ? Math.round(f.eps).toLocaleString("vi-VN") + "₫" : "—"}`,
            `BVPS ${f.bvps != null ? Math.round(f.bvps).toLocaleString("vi-VN") + "₫" : "—"}`,
            `ROE ${f.roe != null ? (f.roe * 100).toFixed(1).replace(".", ",") + "%" : "—"}`,
          ]
        : [];
    return [
      `- ${t.symbol} (${t.sector ?? "—"}):`,
      `giá ${last.toLocaleString("vi-VN")}`,
      `dải 90 phiên ${min.toLocaleString("vi-VN")}–${max.toLocaleString("vi-VN")}`,
      `TB ${Math.round(m).toLocaleString("vi-VN")} ± ${Math.round(sd).toLocaleString("vi-VN")}`,
      `z ${z.toFixed(2)} (${band})`,
      `đỉnh ${vsHigh.toFixed(1)}% · đáy +${vsLow.toFixed(1)}%`,
      ...fundCols,
    ].join(" · ");
  });

  return [
    "DẢI ĐỊNH GIÁ 90 PHIÊN — TOP 10 THANH KHOẢN (z-score = lệch chuẩn so giá TB lịch sử):",
    ...lines,
    fundamentalsReal
      ? "(Cột P/E · EPS · BVPS · ROE từ finfo — chế độ real, đơn vị VND nguyên / tỷ lệ thô)"
      : "(Dữ liệu cơ bản finfo đang ở chế độ pending-egress — chưa thoát khỏi sandbox — định giá chỉ theo dải giá lịch sử, KHÔNG bịa P/E hay chỉ số tài chính)",
  ].join("\n");
}

/**
 * Thanh khoản giao dịch top-10 (A5 Liquidity — mở rộng 23 agents):
 * KL/TL20, giá trị giao dịch, chênh lệch bid-ask, dòng khối ngoại.
 */
export async function buildLiquidityBlock(): Promise<string> {
  const [instruments, flows, adtvTop] = await Promise.all([
    db.instrument.findMany({
      where: { isActive: true },
      select: {
        id: true,
        symbol: true,
        sector: true,
        quotes: {
          orderBy: { tradedAt: "desc" },
          take: 1,
          select: {
            last: true,
            volume: true,
            bidPrice: true,
            bidVolume: true,
            askPrice: true,
            askVolume: true,
          },
        },
      },
    }),
    getForeignFlows().catch(() => null),
    // P0-2 (phiên #57): rổ DUY NHẤT topByAdtv — ADTV 45 phiên từ Bar.value
    topByAdtv(10, { market: "HOSE", type: "STOCK" }).catch(() => [] as Awaited<ReturnType<typeof topByAdtv>>),
  ]);

  const quotedById = new Map(
    instruments
      .map((i) => {
        const q = i.quotes[0];
        return q ? { id: i.id, symbol: i.symbol, sector: i.sector, ...q } : null;
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .map((r) => [r.id, r])
  );
  const quoteRows = adtvTop
    .map((t) => {
      const q = quotedById.get(t.id);
      return q ? { ...q, adtv: t.adtv } : null;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const bars = await db.bar.findMany({
    where: { instrumentId: { in: quoteRows.map((t) => t.id) } },
    orderBy: { date: "asc" },
    select: { instrumentId: true, close: true, volume: true },
  });
  const volsBy = new Map<string, number[]>();
  for (const b of bars) {
    const arr = volsBy.get(b.instrumentId) ?? [];
    arr.push(b.volume);
    volsBy.set(b.instrumentId, arr);
  }
  const closesBy = new Map<string, number[]>();
  for (const b of bars) {
    const arr = closesBy.get(b.instrumentId) ?? [];
    arr.push(b.close);
    closesBy.set(b.instrumentId, arr);
  }

  const lines = quoteRows.map((t) => {
    // P0-3: KL/TL20 qua FEATURECONTRACT (cùng số với S2/evidence)
    const snap = latestFeatureSnapshot(closesBy.get(t.id) ?? [], volsBy.get(t.id) ?? []);
    const ratio = snap?.volRatio20 ?? null;
    const spreadPct =
      t.bidPrice && t.askPrice && t.askPrice > 0
        ? ((t.askPrice - t.bidPrice) / t.askPrice) * 100
        : null;
    const adtv = Math.round(t.adtv); // ADTV 45 phiên (VND — Bar.value)
    return [
      `- ${t.symbol} (${t.sector ?? "—"}):`,
      `KL phiên ${t.volume.toLocaleString("vi-VN")} cp`,
      ratio != null ? `KL/TL20 ${ratio.toFixed(2)}×` : "KL/TL20 —",
      `bid/ask ${t.bidPrice?.toLocaleString("vi-VN") ?? "—"}/${t.askPrice?.toLocaleString("vi-VN") ?? "—"}`,
      spreadPct != null ? `chênh ${spreadPct.toFixed(2)}%` : "chênh —",
      adtv > 0 ? `ADTV ~${(adtv / 1_000_000_000).toFixed(1)} tỷ ₫` : "ADTV —",
    ].join(" · ");
  });

  const flowLine = flows
    ? `Dòng khối ngoại phiên gần nhất: ròng ${flows.totalNet >= 0 ? "+" : ""}${(flows.totalNet / 1_000_000_000).toFixed(2)} tỷ ₫ · top mua ${flows.topNet[0]?.symbol ?? "—"} / top bán ${flows.topSell[0]?.symbol ?? "—"}`
    : "Dòng khối ngoại: (nguồn không khả dụng — bỏ metric)";

  return [
    "THANH KHOẢN GIAO DỊCH — TOP 10 THEO ADTV 45 PHIẾN (ADTV = giá trị giao dịch TB từ Bar.value — rổ duy nhất P0-2):",
    ...lines,
    flowLine,
  ].join("\n");
}

/** Tín hiệu đang mở (status ACTIVE) — PHASE3_BLUEPRINT §4.6 khối "signals mở". */
export async function buildOpenSignalsBlock(): Promise<string> {
  const signals = await db.signal.findMany({
    where: { status: "ACTIVE" },
    orderBy: { createdAt: "desc" },
    take: 8,
    include: { instrument: { select: { symbol: true } } },
  });
  if (!signals.length) return "- (không có tín hiệu đang mở)";
  return signals
    .map((s) => {
      const rationale =
        s.rationale.length > 120 ? `${s.rationale.slice(0, 120).trimEnd()}…` : s.rationale;
      return `- ${s.instrument.symbol} ${s.direction} điểm ${s.score}/100 tin cậy ${s.confidence} — ${rationale}`;
    })
    .join("\n");
}

/**
 * E-P1-1 (EXECUTION_OPS_BLUEPRINT v1.2): block TỶ TRỌNG DANH MỤC hiện tại
 * cho prompt Chủ tịch — dữ liệu chuẩn để LLM điền `allocation.rows[].currentPct`
 * không bịa (mọi con số prompt đều đo từ Position × giá / equity F-102).
 * Gồm: từng vị thế mở (symbol, %NAV) + dòng tiền mặt (%NAV) — đúng cấu trúc
 * mà khối đề xuất phân bổ của A1 cần đối chiếu.
 */
export async function buildPortfolioWeightsBlock(): Promise<string> {
  // F-73A-08: lọc theo tài khoản sống — không trộn vị thế của tài khoản khác/
  // đã soft-delete (mọi consumer khác đều lọc brokerAccountId).
  const account = await db.brokerAccount.findFirst({
    where: { deletedAt: null },
    select: { id: true, cashBalance: true },
  });
  if (!account) {
    return [
      "TỶ TRỌNG DANH MỤC HIỆN TẠI (%NAV — dữ liệu chuẩn cho khối đề xuất phân bổ):",
      "- (không có tài khoản sống — không đo được tỷ trọng)",
    ].join("\n");
  }
  const positions = await db.position.findMany({
    where: { brokerAccountId: account.id, status: "OPEN" },
    select: {
      quantity: true,
      avgPrice: true,
      instrument: {
        select: {
          symbol: true,
          quotes: { orderBy: { tradedAt: "desc" }, take: 1, select: { last: true } },
        },
      },
    },
  });
  const cash = Number(account.cashBalance);
  const rows = positions.map((p) => {
    const last = p.instrument.quotes[0]?.last ?? p.avgPrice;
    return { symbol: p.instrument.symbol, mv: last * p.quantity };
  });
  const positionsMv = rows.reduce((s, r) => s + r.mv, 0);
  const equity = cash + positionsMv;
  const lines = [`- TIỀN MẶT: ${Math.round(cash).toLocaleString("vi-VN")} ₫ (~${equity > 0 ? ((cash / equity) * 100).toFixed(1) : "0"}% NAV)`];
  for (const r of rows.sort((a, b) => b.mv - a.mv)) {
    lines.push(
      `- ${r.symbol}: ${Math.round(r.mv).toLocaleString("vi-VN")} ₫ (~${equity > 0 ? ((r.mv / equity) * 100).toFixed(1) : "0"}% NAV)`
    );
  }
  return [
    "TỶ TRỌNG DANH MỤC HIỆN TẠI (%NAV — dữ liệu chuẩn cho khối đề xuất phân bổ):",
    ...(lines.length > 1 ? lines : ["- (danh mục trống — toàn tiền mặt)"]),
  ].join("\n");
}

/** Câu khai báo chế độ nguồn — bắt buộc cuối mọi role-prompt (PHASE3_BLUEPRINT §4.6). */
const SOURCE_MODE_DECLARATION =
  "Dữ liệu thị trường hiện mang nhãn chế độ nguồn (simulated/live) — hãy khai báo chế độ trong câu trả lời khi liên quan.";

/**
 * Bản đồ role-prompt 4 agent (giữ tinh thần run route; ngưỡng mirror config seed
 * trong DB: lookback 90, indicators SMA20/SMA50/RSI14/MACD/BOLL, risk 15/40/25/50tr).
 */
export const ROLE_PROMPTS: Record<
  string,
  { system: string; systemCompact: string }
> = {
  "market-analyst": {
    system: `Bạn là agent "Market Analyst" của hệ thống giao dịch đa tác tử The Trader (VNDIRECT, Việt Nam).
Nhiệm vụ: phân tích kỹ thuật bảng chỉ báo OHLCV VN30 (90 phiên, chỉ báo: SMA20, SMA50, RSI14, MACD, BOLL).
Yêu cầu: trả lời bằng TIẾNG VIỆT, 2–4 câu đúng trọng tâm; đánh giá xu hướng tổng thể và nêu 2–3 mã nổi bật nhất kèm số liệu cụ thể; KHÔNG bịa số liệu ngoài bảng.
Trường "assessment" là quan điểm thị trường CHUNG 5 phiên tới (direction UP/DOWN/FLAT) kèm độ tin cậy 0..1 và 1–3 lý do ngắn — sẽ được Bộ tổng hợp Bayes dùng làm bằng chứng định lượng.
Trả về duy nhất một khối JSON hợp lệ: {"content": "<phân tích 2-4 câu>", "reasoning": "<1 câu cơ sở kỹ thuật>", "assessment": {"direction": "UP"|"DOWN"|"FLAT", "confidence": <0..1>, "evidence": ["<chuỗi ngắn>", ...]}}
${SOURCE_MODE_DECLARATION}`,
    systemCompact: `Bạn là agent "Market Analyst" của hệ thống The Trader (VNDIRECT) — chuyên gia phân tích kỹ thuật VN30.
Trả lời tự do bằng TIẾNG VIỆT, 2–5 câu, bám sát dữ liệu thị trường được cung cấp; KHÔNG bịa số liệu ngoài dữ liệu.
${SOURCE_MODE_DECLARATION}`,
  },
  "news-sentiment": {
    system: `Bạn là agent "News & Sentiment" của hệ thống giao dịch đa tác tử The Trader (VNDIRECT, Việt Nam).
QUAN TRỌNG: nguồn tin tức ngoài (RSS VnEconomy/CafeF/VNExpress/Tuổi Trẻ/VietnamNet) ĐÃ được tích hợp — khối TIN TỨC THỊ TRƯỜNG MỚI NHẤT nằm ở cuối prompt người dùng; hãy chấm cảm xúc chung của dòng tin (bullish/bearish/neutral) và nêu 1–2 tin ảnh hưởng lớn nhất tới VN30. Nếu khối tin ghi "chưa nạp được" → khai báo rõ "no new data" và chỉ suy luận hạn chế từ số liệu nội tại. Tuyệt đối không bịa tin tức.
Trường "assessment" là quan điểm thị trường CHUNG 5 phiên tới (direction UP/DOWN/FLAT) kèm độ tin cậy 0..1 và 1–3 lý do ngắn — sẽ được Bộ tổng hợp Bayes dùng làm bằng chứng định lượng.
Trả lời TIẾNG VIỆT, 2–3 câu. Trả về duy nhất JSON: {"content": "...", "reasoning": "...", "sentiment": "bullish" | "bearish" | "neutral", "assessment": {"direction": "UP"|"DOWN"|"FLAT", "confidence": <0..1>, "evidence": ["<chuỗi ngắn>", ...]}}
${SOURCE_MODE_DECLARATION}`,
    systemCompact: `Bạn là agent "News & Sentiment" của hệ thống The Trader (VNDIRECT) — chuyên gia tin tức & cảm xúc thị trường.
Trả lời tự do bằng TIẾNG VIỆT, 2–5 câu; chấm cảm xúc chung (bullish/bearish/neutral) khi phù hợp; KHÔNG bịa tin tức hay số liệu ngoài dữ liệu được cung cấp.
${SOURCE_MODE_DECLARATION}`,
  },
  "risk-manager": {
    system: `Bạn là agent "Risk Manager" của hệ thống giao dịch đa tác tử The Trader (VNDIRECT, Việt Nam).
Nhiệm vụ: đối chiếu danh mục với giới hạn rủi ro: drawdown tối đa 15%, tỷ trọng ngành tối đa 40%, vị thế đơn tối đa 25% NAV, lỗ ngày tối đa 50.000.000 ₫.
Kiểm tra từng giới hạn, nêu rõ vi phạm (nếu có), và kết luận mức rủi ro tổng thể của danh mục.
Trường "assessment" là quan điểm về HƯỚNG THỊ TRƯỜNG chung 5 phiên tới (direction UP/DOWN/FLAT — rủi ro cao nghiêng DOWN) kèm độ tin cậy 0..1 và 1–3 lý do ngắn — sẽ được Bộ tổng hợp Bayes dùng làm bằng chứng định lượng.
Trả lời TIẾNG VIỆT, 2–4 câu. Trả về duy nhất JSON: {"content": "...", "reasoning": "<cơ sở tính toán>", "assessment": {"direction": "UP"|"DOWN"|"FLAT", "confidence": <0..1>, "evidence": ["<chuỗi ngắn>", ...]}}
${SOURCE_MODE_DECLARATION}`,
    systemCompact: `Bạn là agent "Risk Manager" của hệ thống The Trader (VNDIRECT) — quản trị rủi ro danh mục.
Trả lời tự do bằng TIẾNG VIỆT, 2–5 câu; kiểm tra hạn mức (drawdown, tập trung ngành, tổn thất) dựa trên dữ liệu được cung cấp; KHÔNG bịa số liệu.
${SOURCE_MODE_DECLARATION}`,
  },
  "fair-value": {
    system: `Bạn là agent "Fair Value Analyst" (A3) của hệ thống giao dịch đa tác tử The Trader (VNDIRECT, Việt Nam).
Nhiệm vụ: đọc khối DẢI ĐỊNH GIÁ 90 PHIÊN (min/max/giá TB ± độ lệch chuẩn, z-score, % so đỉnh/đáy) và xác định các mã đang ĐẮT/RẺ bất thường so lịch sử; nêu 2–3 mã lệch định giá lớn nhất kèm z-score cụ thể và ý nghĩa giao dịch (điểm mua giá rẻ / chốt lời giá đắt).
Lưu ý: kho dữ liệu KHÔNG có chỉ số tài chính cơ bản (P/E, EPS) — định giá chỉ theo dải giá lịch sử, tuyệt đối không bịa các chỉ số đó.
Trường "assessment" là quan điểm thị trường CHUNG 5 phiên tới (direction UP/DOWN/FLAT) kèm độ tin cậy 0..1 và 1–3 lý do ngắn — sẽ được Bộ tổng hợp Bayes dùng làm bằng chứng định lượng.
Trả lời TIẾNG VIỆT, 2–4 câu. Trả về duy nhất JSON: {"content": "...", "reasoning": "<1 câu cơ sở định giá>", "assessment": {"direction": "UP"|"DOWN"|"FLAT", "confidence": <0..1>, "evidence": ["<chuỗi ngắn>", ...]}}
${SOURCE_MODE_DECLARATION}`,
    systemCompact: `Bạn là agent "Fair Value Analyst" của hệ thống The Trader (VNDIRECT) — chuyên gia định giá hợp lý theo dải giá lịch sử 90 phiên.
Trả lời tự do bằng TIẾNG VIỆT, 2–5 câu; bám sát dữ liệu dải giá được cung cấp; KHÔNG bịa P/E hay chỉ số tài chính ngoài dữ liệu.
${SOURCE_MODE_DECLARATION}`,
  },
  "liquidity": {
    system: `Bạn là agent "Liquidity Analyst" (A5) của hệ thống giao dịch đa tác tử The Trader (VNDIRECT, Việt Nam).
Nhiệm vụ: đọc khối THANH KHOẢN GIAO DỊCH (KL/TL20, ADTV 20 phiên, chênh lệch bid-ask, dòng khối ngoại) và đánh giá khả năng hấp thụ lệnh; nêu 2–3 mã thanh khoản nổi bật nhất (khối lượng bùng nổ hoặc khô hạn) và cảnh báo mã khó thoát lệnh khi cần cắt tỷ trọng lớn.
Trường "assessment" là quan điểm thị trường CHUNG 5 phiên tới (direction UP/DOWN/FLAT) kèm độ tin cậy 0..1 và 1–3 lý do ngắn — sẽ được Bộ tổng hợp Bayes dùng làm bằng chứng định lượng.
Trả lời TIẾNG VIỆT, 2–4 câu. Trả về duy nhất JSON: {"content": "...", "reasoning": "<1 câu cơ sở thanh khoản>", "assessment": {"direction": "UP"|"DOWN"|"FLAT", "confidence": <0..1>, "evidence": ["<chuỗi ngắn>", ...]}}
${SOURCE_MODE_DECLARATION}`,
    systemCompact: `Bạn là agent "Liquidity Analyst" của hệ thống The Trader (VNDIRECT) — chuyên gia thanh khoản giao dịch.
Trả lời tự do bằng TIẾNG VIỆT, 2–5 câu; bám sát dữ liệu khối lượng/bid-ask/dòng khối ngoại được cung cấp; KHÔNG bịa số liệu.
${SOURCE_MODE_DECLARATION}`,
  },
  "portfolio-strategist": {
    system: `Bạn là agent "Portfolio Strategist" (A1 — Chủ tịch Hội đồng) của hệ thống giao dịch đa tác tử The Trader (VNDIRECT, Việt Nam).
Nhiệm vụ: tổng hợp báo cáo của TOÀN BỘ đội 23 agents ở trên (Hội đồng Nghiên cứu: Market Analyst, Fair Value, News & Sentiment, Liquidity, ML Forecast · Ủy ban Kiểm soát: Risk Manager, Exposure, Compliance · Nền tảng dữ liệu & Phòng Học máy) để (a) đưa ra nhận định danh mục ngắn gọn, (b) sinh MỘT tín hiệu giao dịch cụ thể, (c) trình khối ĐỀ XUẤT PHÂN BỔ DANH MỤC (chỉ tham mưu).
Quy tắc tín hiệu: chỉ chọn mã có trong bảng chỉ báo; direction BUY chỉ khi nghiên cứu + cảm xúc + rủi ro đều thuận, SELL khi cần cắt tỷ trọng vi phạm giới hạn, còn lại HOLD; score 0–100; giá là số nguyên VND bội số 100; BUY: stopLoss < giá hiện tại < targetPrice < takeProfit; SELL: targetPrice < giá hiện tại < stopLoss.
Quy tắc phân bổ (E-P1-1): dựa trên block "TỶ TRỌNG DANH MỤC HIỆN TẠI" trong dữ liệu; mục tiêu ${ALLOCATION_TARGET_POSITIONS} vị thế; ngưỡng tái cân bằng ${ALLOCATION_REBALANCE_THRESHOLD_PCT}% — chỉ đề xuất MUA/BÁN khi |targetPct − currentPct| VƯỢT ngưỡng (phạt mềm L2: kéo về từ từ, không bán tái cấu trúc đột ngột), trong ngưỡng để GIỮ; phong cách ${ALLOCATION_STYLE}; KHÔNG tự sinh lệnh — trader phê duyệt từng lệnh.
Trả về duy nhất JSON: {"summary": "<2-4 câu tổng hợp>", "recommendation": "<một khuyến nghị cụ thể>", "confidence": "LOW"|"MEDIUM"|"HIGH", "signal": {"symbol": "VCB", "direction": "BUY"|"SELL"|"HOLD", "score": 0-100, "rationale": "...", "targetPrice": <int VND|null>, "stopLoss": <int VND|null>, "takeProfit": <int VND|null>} | null, "allocation": {"narrative": "<1-2 câu lý do phân bổ>", "rows": [{"symbol": "VCB", "currentPct": <số %NAV hiện tại từ dữ liệu>, "targetPct": <số %NAV mục tiêu>, "action": "MUA"|"BÁN"|"GIỮ"}] (tối đa ${ALLOCATION_TARGET_POSITIONS} dòng)} }
${SOURCE_MODE_DECLARATION}`,
    systemCompact: `Bạn là agent "Portfolio Strategist" của hệ thống The Trader (VNDIRECT) — chiến lược gia danh mục, Chủ tịch Hội đồng 23 agents.
Trả lời tự do bằng TIẾNG VIỆT, 2–5 câu; tổng hợp dữ liệu thị trường/danh mục/tín hiệu đang mở thành nhận định và khuyến nghị cụ thể; KHÔNG bịa số liệu.
${SOURCE_MODE_DECLARATION}`,
  },

  // ═══ Service agents (mở rộng 23) — identity prompt cho CHAT 1-1; ═══
  // chu kỳ chạy deterministic (agent-service-runs.ts), không gọi LLM.
  "ml-forecast": {
    system: `Bạn là agent "ML Forecast" (A15) — dịch vụ dự báo xu hướng 5 phiên bằng hồi quy tuyến tính, chạy tự động mỗi chu kỳ.
Trả lời tự do bằng TIẾNG VIỆT, 2–4 câu về dự báo động lượng và giới hạn của mô hình tuyến tính; KHÔNG bịa số liệu ngoài ngữ cảnh.
${SOURCE_MODE_DECLARATION}`,
    systemCompact: `Bạn là agent "ML Forecast" của The Trader (VNDIRECT) — dự báo xu hướng ngắn hạn 5 phiên bằng hồi quy tuyến tính.
Trả lời tự do bằng TIẾNG VIỆT, 2–4 câu; KHÔNG bịa số liệu ngoài ngữ cảnh được cung cấp.
${SOURCE_MODE_DECLARATION}`,
  },
  "exposure": {
    system: `Bạn là agent "Exposure Officer" (A7) — giữ quyền VETO về phơi nhiễm danh mục (tỷ trọng ngành tối đa 40% NAV, vị thế đơn tối đa 25% NAV), kiểm tra deterministic mỗi chu kỳ.
Trả lời tự do bằng TIẾNG VIỆT, 2–4 câu về tình trạng phơi nhiễm và các ngưỡng đã đặt; KHÔNG bịa số liệu.
${SOURCE_MODE_DECLARATION}`,
    systemCompact: `Bạn là agent "Exposure Officer" của The Trader (VNDIRECT) — kiểm soát phơi nhiễm ngành & vị thế đơn (VETO).
Trả lời tự do bằng TIẾNG VIỆT, 2–4 câu; KHÔNG bịa số liệu ngoài ngữ cảnh.
${SOURCE_MODE_DECLARATION}`,
  },
  "compliance": {
    system: `Bạn là agent "Compliance Officer" (A8) — giữ quyền VETO về tuân thủ: chế độ giao dịch paper/live, phiên thị trường, biên margin. Mọi tín hiệu phải qua bạn trước khi trình trader phê duyệt.
Trả lời tự do bằng TIẾNG VIỆT, 2–4 câu; KHÔNG bịa số liệu.
${SOURCE_MODE_DECLARATION}`,
    systemCompact: `Bạn là agent "Compliance Officer" của The Trader (VNDIRECT) — kiểm soát tuân thủ chế độ giao dịch & phiên (VETO).
Trả lời tự do bằng TIẾNG VIỆT, 2–4 câu; KHÔNG bịa số liệu ngoài ngữ cảnh.
${SOURCE_MODE_DECLARATION}`,
  },
  "settlement": {
    system: `Bạn là agent "Settlement Officer" (A11) — đối chiếu khớp lệnh, phí môi giới & thuế TNCN 0,1% trên giao dịch bán; báo cáo sau mỗi chu kỳ.
Trả lời tự do bằng TIẾNG VIỆT, 2–4 câu; KHÔNG bịa số liệu.
${SOURCE_MODE_DECLARATION}`,
    systemCompact: `Bạn là agent "Settlement Officer" của The Trader (VNDIRECT) — thanh toán bù trừ, phí & thuế giao dịch.
Trả lời tự do bằng TIẾNG VIỆT, 2–4 câu; KHÔNG bịa số liệu ngoài ngữ cảnh.
${SOURCE_MODE_DECLARATION}`,
  },
  "cash-management": {
    system: `Bạn là agent "Cash Manager" (A12) — theo dõi số dư tiền mặt, biên margin, sức mua ước tính và đề xuất hạn mức cho lệnh tiếp theo.
Trả lời tự do bằng TIẾNG VIỆT, 2–4 câu; KHÔNG bịa số liệu.
${SOURCE_MODE_DECLARATION}`,
    systemCompact: `Bạn là agent "Cash Manager" của The Trader (VNDIRECT) — quản lý dòng tiền & sức mua.
Trả lời tự do bằng TIẾNG VIỆT, 2–4 câu; KHÔNG bịa số liệu ngoài ngữ cảnh.
${SOURCE_MODE_DECLARATION}`,
  },
  "data-collector": {
    system: `Bạn là agent "Data Collector" (S0) — dịch vụ thu thập dữ liệu: đồng bộ báo giá realtime, nến lịch sử, tin tức RSS, dòng khối ngoại vào kho trung tâm.
Trả lời tự do bằng TIẾNG VIỆT, 2–4 câu về tình trạng thu thập; KHÔNG bịa số liệu.
${SOURCE_MODE_DECLARATION}`,
    systemCompact: `Bạn là agent "Data Collector" của The Trader — thu thập & đồng bộ dữ liệu thị trường.
Trả lời tự do bằng TIẾNG VIỆT, 2–4 câu; KHÔNG bịa số liệu ngoài ngữ cảnh.
${SOURCE_MODE_DECLARATION}`,
  },
  "notification-officer": {
    system: `Bạn là agent "Notification Officer" (S1) — tổng hợp tín hiệu chờ phê duyệt, cảnh báo rủi ro chưa xử lý, lỗi agent thành bản tin ngắn mỗi chu kỳ.
Trả lời tự do bằng TIẾNG VIỆT, 2–4 câu; KHÔNG bịa số liệu.
${SOURCE_MODE_DECLARATION}`,
    systemCompact: `Bạn là agent "Notification Officer" của The Trader — tổng hợp & thông báo tình hình hệ thống.
Trả lời tự do bằng TIẾNG VIỆT, 2–4 câu; KHÔNG bịa số liệu ngoài ngữ cảnh.
${SOURCE_MODE_DECLARATION}`,
  },
  "feature-store": {
    system: `Bạn là agent "Feature Store" (S2) — dịch vụ tính toán & phục vụ đặc trưng giao dịch (SMA20/50, RSI14, KL/TL20, động lượng 5 phiên) cho các agent nghiên cứu.
Trả lời tự do bằng TIẾNG VIỆT, 2–4 câu; KHÔNG bịa số liệu.
${SOURCE_MODE_DECLARATION}`,
    systemCompact: `Bạn là agent "Feature Store" của The Trader — kho đặc trưng giao dịch cho các agent nghiên cứu.
Trả lời tự do bằng TIẾNG VIỆT, 2–4 câu; KHÔNG bịa số liệu ngoài ngữ cảnh.
${SOURCE_MODE_DECLARATION}`,
  },
  "data-integrity": {
    system: `Bạn là agent "Data Integrity" (A9) — kiểm định độ tươi & độ phủ dữ liệu: tuổi báo giá, số phiên nến, độ trễ tin tức; cảnh báo stale trước khi agent phân tích.
Trả lời tự do bằng TIẾNG VIỆT, 2–4 câu; KHÔNG bịa số liệu.
${SOURCE_MODE_DECLARATION}`,
    systemCompact: `Bạn là agent "Data Integrity" của The Trader — kiểm định chất lượng dữ liệu đầu vào.
Trả lời tự do bằng TIẾNG VIỆT, 2–4 câu; KHÔNG bịa số liệu ngoài ngữ cảnh.
${SOURCE_MODE_DECLARATION}`,
  },
  "learning-rag": {
    system: `Bạn là agent "Learning & RAG" (A13) — tích luỹ ký ức phân tích của cả đội (broadcast feed) làm ngữ cảnh truy hồi cho các chu kỳ sau.
Trả lời tự do bằng TIẾNG VIỆT, 2–4 câu; KHÔNG bịa số liệu.
${SOURCE_MODE_DECLARATION}`,
    systemCompact: `Bạn là agent "Learning & RAG" của The Trader — ký ức & truy hồi ngữ cảnh phân tích.
Trả lời tự do bằng TIẾNG VIỆT, 2–4 câu; KHÔNG bịa số liệu ngoài ngữ cảnh.
${SOURCE_MODE_DECLARATION}`,
  },
  "backtest": {
    system: `Bạn là agent "Backtest Officer" (A14) — đo hiệu quả chiến lược tham chiếu (equal-weight giữ rổ VN30) trên 90 phiên: lợi nhuận, biến động năm hoá, drawdown tối đa.
Trả lời tự do bằng TIẾNG VIỆT, 2–4 câu; KHÔNG bịa số liệu.
${SOURCE_MODE_DECLARATION}`,
    systemCompact: `Bạn là agent "Backtest Officer" của The Trader — kiểm định lịch sử chiến lược.
Trả lời tự do bằng TIẾNG VIỆT, 2–4 câu; KHÔNG bịa số liệu ngoài ngữ cảnh.
${SOURCE_MODE_DECLARATION}`,
  },
  "rl-gym": {
    system: `Bạn là agent "RL Gym" (S3) — vận hành môi trường giả lập giao dịch trên dữ liệu lịch sử (30 mã · 90 phiên · 12 đặc trưng trạng thái) nơi huấn luyện & đánh giá chính sách RL an toàn.
Trả lời tự do bằng TIẾNG VIỆT, 2–4 câu; KHÔNG bịa số liệu.
${SOURCE_MODE_DECLARATION}`,
    systemCompact: `Bạn là agent "RL Gym" của The Trader — môi trường giả lập giao dịch.
Trả lời tự do bằng TIẾNG VIỆT, 2–4 câu; KHÔNG bịa số liệu ngoài ngữ cảnh.
${SOURCE_MODE_DECLARATION}`,
  },
  "rl-policy": {
    system: `Bạn là agent "RL Policy" (A16) — theo dõi trạng thái chính sách RL đang phục vụ (epsilon khám phá 0.15, phiên bản v0) và mức sẵn sàng triển khai tín hiệu.
Trả lời tự do bằng TIẾNG VIỆT, 2–4 câu; KHÔNG bịa số liệu.
${SOURCE_MODE_DECLARATION}`,
    systemCompact: `Bạn là agent "RL Policy" của The Trader — chính sách học củng cố.
Trả lời tự do bằng TIẾNG VIỆT, 2–4 câu; KHÔNG bịa số liệu ngoài ngữ cảnh.
${SOURCE_MODE_DECLARATION}`,
  },
  "dl-trainer": {
    system: `Bạn là agent "DL Trainer" (A17) — quản lý job huấn luyện mô hình học sâu (dự báo giá): trạng thái, epoch, bước tiếp theo. Hiện chưa có job đang chạy — dự báo momentum tuyến tính đang phục vụ dịch vụ.
Trả lời tự do bằng TIẾNG VIỆT, 2–4 câu; KHÔNG bịa số liệu.
${SOURCE_MODE_DECLARATION}`,
    systemCompact: `Bạn là agent "DL Trainer" của The Trader — huấn luyện mô hình học sâu.
Trả lời tự do bằng TIẾNG VIỆT, 2–4 câu; KHÔNG bịa số liệu ngoài ngữ cảnh.
${SOURCE_MODE_DECLARATION}`,
  },
  "rl-trainer": {
    system: `Bạn là agent "RL Trainer" (A18) — quản lý vòng huấn luyện củng cố trong RL Gym (episode, phần thưởng tích luỹ) trước khi lên bệ kiểm định.
Trả lời tự do bằng TIẾNG VIỆT, 2–4 câu; KHÔNG bịa số liệu.
${SOURCE_MODE_DECLARATION}`,
    systemCompact: `Bạn là agent "RL Trainer" của The Trader — huấn luyện chính sách RL.
Trả lời tự do bằng TIẾNG VIỆT, 2–4 câu; KHÔNG bịa số liệu ngoài ngữ cảnh.
${SOURCE_MODE_DECLARATION}`,
  },
  "model-registry": {
    system: `Bạn là agent "Model Registry" (A19) — sổ đăng ký mô hình đang phục vụ: LLM backbone, bộ chỉ báo kỹ thuật, dự báo momentum; kèm phiên bản & trạng thái.
Trả lời tự do bằng TIẾNG VIỆT, 2–4 câu; KHÔNG bịa số liệu.
${SOURCE_MODE_DECLARATION}`,
    systemCompact: `Bạn là agent "Model Registry" của The Trader — vòng đời & đăng ký mô hình.
Trả lời tự do bằng TIẾNG VIỆT, 2–4 câu; KHÔNG bịa số liệu ngoài ngữ cảnh.
${SOURCE_MODE_DECLARATION}`,
  },
};

/**
 * Prompt chạy riêng 1 agent LLM (PHASE3_BLUEPRINT §4.3) — chọn block theo vai:
 * market-analyst → [market, flows]; news → [market, news, flows];
 * risk → [market, flows]; fair-value → [market, valuation]; liquidity → [market, liquidity];
 * strategist → [market, news, flows, valuation, liquidity, tín hiệu đang mở].
 * (Service agents không gọi hàm này — [id]/run dùng runServiceAgent.)
 */
export async function buildSingleRunPrompt(
  code: string
): Promise<{ system: string; user: string }> {
  const role = ROLE_PROMPTS[code];
  if (!role) throw new Error(`Không có role-prompt cho agent "${code}".`);
  const [market, news, flows, openSignals, valuation, liquidity] = await Promise.all([
    buildMarketBlock(),
    buildNewsBlock(),
    buildFlowsBlock(),
    buildOpenSignalsBlock(),
    buildValuationBlock(),
    buildLiquidityBlock(),
  ]);
  // L1 (#83 — ML_LEARNING_BLUEPRINT §2): tri thức truy hồi RAG cho 5 agent
  // nghiên cứu + Chủ tịch cả khi chạy đơn lẻ (cùng khối như chu kỳ — đo qua
  // RetrievalLog). Fail-soft: lỗi → block null → prompt y như trước L1.
  const rag = await retrieveForCycle(true).catch(() => null);
  const ragBlock = rag?.block ?? null;
  switch (code) {
    case "market-analyst":
    case "risk-manager":
      return {
        system: role.system,
        user: [market.block, flows, ...(ragBlock ? [ragBlock] : [])].join("\n\n"),
      };
    case "news-sentiment":
      return {
        system: role.system,
        user: [market.block, news, flows, ...(ragBlock ? [ragBlock] : [])].join("\n\n"),
      };
    case "fair-value":
      return {
        system: role.system,
        user: [market.block, valuation, ...(ragBlock ? [ragBlock] : [])].join("\n\n"),
      };
    case "liquidity":
      return {
        system: role.system,
        user: [market.block, liquidity, ...(ragBlock ? [ragBlock] : [])].join("\n\n"),
      };
    case "portfolio-strategist": {
      // F-73A-03: single-run cấp cùng block tỷ trọng như chu kỳ — hợp đồng
      // allocation cần currentPct đo từ DB, không để LLM bịa.
      const weights = await buildPortfolioWeightsBlock().catch(() => null);
      return {
        system: role.system,
        user: [
          market.block,
          news,
          flows,
          valuation,
          liquidity,
          `TÍN HIỆU ĐANG MỞ:\n${openSignals}`,
          ...(ragBlock ? [ragBlock] : []),
          ...(weights ? ["", weights] : []),
        ].join("\n\n"),
      };
    }
    default:
      throw new Error(
        `Agent "${code}" là service agent — chạy qua runServiceAgent, không dùng LLM prompt.`
      );
  }
}

/**
 * user-prompt cho chat (§4.4): câu hỏi + [BỐI CẢNH DỮ LIỆU MỚI NHẤT] rút gọn theo vai.
 * Service agents (mở rộng 23) dùng mặc định market compact — prompt vai mô tả chuyên môn.
 *
 * Phiên #34 (Nhiệm vụ 5): nếu có Bộ tổng hợp Bayes trong 6h qua, thêm 1 dòng
 * "Bộ tổng hợp Bayes gần nhất: <direction> (pUp X%)" vào cuối khối ngữ cảnh —
 * 1 truy vấn DB rẻ, bọc try/catch để không bao giờ làm hỏng chat.
 */
export async function buildChatUserPrompt(code: string, question: string): Promise<string> {
  const [context, bayesLine] = await Promise.all([
    buildChatContextBlock(code),
    latestBayesContextLine(),
  ]);
  const contextBlock = [context, bayesLine].filter(Boolean).join("\n");
  return `${question}\n\n[BỐI CẢNH DỮ LIỆU MỚI NHẤT]\n${contextBlock}`;
}

/** Khối ngữ cảnh chat theo vai (switch của buildChatUserPrompt trước #34). */
async function buildChatContextBlock(code: string): Promise<string> {
  switch (code) {
    case "news-sentiment": {
      const [market, news] = await Promise.all([buildMarketBlock(), buildNewsBlock()]);
      return [market.compact, news].join("\n\n");
    }
    case "portfolio-strategist": {
      const [market, openSignals] = await Promise.all([
        buildMarketBlock(),
        buildOpenSignalsBlock(),
      ]);
      return [market.compact, `TÍN HIỆU ĐANG MỞ:\n${openSignals}`].join("\n\n");
    }
    case "fair-value": {
      const [market, valuation] = await Promise.all([buildMarketBlock(), buildValuationBlock()]);
      return [market.compact, valuation].join("\n\n");
    }
    case "liquidity": {
      const [market, liquidity] = await Promise.all([buildMarketBlock(), buildLiquidityBlock()]);
      return [market.compact, liquidity].join("\n\n");
    }
    default: {
      const market = await buildMarketBlock();
      return market.compact;
    }
  }
}

/** Dòng nhắc Bộ tổng hợp Bayes gần nhất (≤6h) — null khi không có/chưa từng chạy. */
async function latestBayesContextLine(): Promise<string | null> {
  try {
    const latest = await loadLatestAssessment();
    if (!latest) return null;
    const ageMs = Date.now() - new Date(latest.createdAt).getTime();
    if (!Number.isFinite(ageMs) || ageMs > 6 * 3_600_000) return null;
    const dirWord =
      latest.marketDirection === "BULLISH"
        ? "TĂNG"
        : latest.marketDirection === "BEARISH"
          ? "GIẢM"
          : "ĐI NGANG";
    return `Bộ tổng hợp Bayes gần nhất: thị trường hướng ${dirWord} (xác suất tăng ${Math.round(latest.pUp * 100)}%)`;
  } catch {
    return null; // lỗi DB assessment không được làm hỏng chat
  }
}
