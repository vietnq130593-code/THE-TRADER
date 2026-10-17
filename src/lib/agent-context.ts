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
// M2 (#103 — M2_RELATION_BLUEPRINT, cơ chế số 2): quan hệ thị trường đã học
// (lead-lag + xác suất điều kiện trên 750 phiên) tiêm cho 3 agent nghiên cứu
// trọng tâm quan hệ liên thị trường — fail-soft như RAG L1.
import { buildXrelPromptBlock } from "@/lib/ml/xrel";
import { buildCouncilVisionBlock } from "@/lib/council/vision";
// #107/#108 E-EXEC — thị trường quốc tế THAM CHIẾU (theo dõi, không đầu tư)
// cho prompt Chủ tịch/strategist + luật vi mô sandbox VN-only.
import { isTradableSandboxInstrument, listForeignReference } from "@/lib/exec/market-rules";
import { formatUnitPrice, unitKindOf } from "@/lib/format";

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
  // K1 (#87 — P0 quarantine §5.1): đường paper loại trừ tài khoản sandbox
  // (buildMarketBlock là bối cảnh chu kỳ agent PAPER — sandbox không được lọt
  // vào prompt của 23 agents).
  const account = await db.brokerAccount.findFirst({
    where: { deletedAt: null, accountType: { not: "sandbox" } },
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
    // B5 + #108 v2.2 (chính sách VN-only): map CHỈ chứa mã HOSE/HNX/UPCOM
    // giao dịch được (ràng buộc execRuleFor: loại INDEX + MỌI instrument
    // phi-VN — cp Mỹ/HK, trái phiếu, forex, hàng hoá đều THAM CHIẾU, không
    // sinh tín hiệu được). Chairman chỉ signal được CP/ETF VN như trước #107.
    instrumentIdBySymbol: new Map(
      allQuoted.filter((r) => isTradableSandboxInstrument(r)).map((r) => [r.symbol, r.id])
    ),
  };
}

// ─────────────────────────────────────────────────────────────────
// #108 E-EXEC v2.2 — THỊ TRƯỜNG QUỐC TẾ THAM CHIẾU (blueprint §5.1)
// ─────────────────────────────────────────────────────────────────

const UNIVERSE_CACHE_TTL_MS = 60_000;
let universeCache: { at: number; block: string | null } = { at: 0, block: null };

function fmtDayPct(last: number, prev: number | null): string {
  if (prev == null || prev <= 0) return "";
  const pct = ((last - prev) / prev) * 100;
  const s = Math.abs(pct).toFixed(1).replace(".", ",");
  return ` ${pct > 0 ? "+" : pct < 0 ? "−" : ""}${s}%`;
}

async function buildIntlReferenceInner(): Promise<string | null> {
  const rows = await listForeignReference();
  if (rows.length === 0) return null;
  const groups: Array<{ label: string; hint: string; pick: (r: { market: string; type: string }) => boolean }> = [
    {
      label: "CP MỸ",
      hint: "giá cent×100 (vd 23.120 = 231,20$)",
      pick: (r) => r.market === "US" && (r.type === "STOCK" || r.type === "ETF"),
    },
    {
      label: "CP HỒNG KỒNG",
      hint: "giá cent HKD×100",
      pick: (r) => r.market === "HK" && (r.type === "STOCK" || r.type === "ETF"),
    },
    {
      label: "CHỈ SỐ QUỐC TẾ",
      hint: "S&P 500 · Nasdaq · Hang Seng",
      pick: (r) => r.type === "INDEX",
    },
    {
      label: "TRÁI PHIẾU MỸ (lợi suất)",
      hint: "giá = LỢI SUẤT %×100 (401 = 4,01%) — lợi suất tăng = giá trị giảm",
      pick: (r) => r.market === "BOND",
    },
    {
      label: "FOREX",
      hint: "tỷ giá ×10.000 (VND=X 259.340.000 = 25.934₫/USD · EURUSD=X 10.852 = 1,0852)",
      pick: (r) => r.market === "FOREX",
    },
    {
      label: "HÀNG HOÁ",
      hint: "giá cent×100 (GC=F 415.050 = 4.150,5$/oz)",
      pick: (r) => r.market === "COMMODITY",
    },
  ];
  const lines: string[] = [
    "THỊ TRƯỜNG QUỐC TẾ (THAM CHIẾU — THEO DÕI, KHÔNG ĐẦU TƯ). Chính sách: Hội đồng chỉ đầu tư cổ phiếu/ETF VIỆT NAM từ khoản tiền thử nghiệm; khối này để nắm bối cảnh quốc tế vì ngoại hối & thị trường ngoài có lúc ảnh hưởng thị trường VN (kênh tỷ giá USD/VND, giá hàng hoá đầu vào, cảm xúc quốc tế):",
  ];
  for (const g of groups) {
    const gr = rows.filter(g.pick);
    if (gr.length === 0) continue;
    const items = gr
      .map((r) => {
        const kind = unitKindOf(r.market, r.type);
        const human = formatUnitPrice(r.last, kind, r.market === "HK" ? "HKD" : undefined);
        return `${r.symbol} giá ${r.last}${human ? ` (=${human})` : ""}${fmtDayPct(r.last, r.prevClose)}`;
      })
      .join(" · ");
    lines.push(`${g.label} (${g.hint}): ${items}`);
  }
  lines.push(
    "KHÔNG chọn mã trong khối này cho tín hiệu — tín hiệu chỉ chọn mã CP/ETF Việt Nam trong bảng chỉ báo; mã ngoài VN sẽ bị hệ thống từ chối (chính sách đầu tư chỉ tại thị trường Việt Nam)."
  );
  return lines.join("\n");
}

/**
 * Khối THỊ TRƯỜNG QUỐC TẾ THAM CHIẾU (cache 60s — cùng pattern vision/XREL):
 * bảng mã phi-VN + giá DB native + % ngày — chỉ bối cảnh quốc tế, KHÔNG đầu
 * tư (#108 v2.2 thu hẹp từ VŨ TRỤ GIAO DỊCH #107). Tiêm 3 đường parity
 * (#107): wave E Chủ tịch (run route) · single-run strategist · chat strategist.
 */
export async function buildIntlReferenceBlock(): Promise<string | null> {
  if (universeCache.block && Date.now() - universeCache.at < UNIVERSE_CACHE_TTL_MS) {
    return universeCache.block;
  }
  const block = await buildIntlReferenceInner().catch(() => null);
  universeCache = { at: Date.now(), block };
  return block;
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

// ═══════════════════════════════════════════════════════════════════
// Task 126 (#126) — A20 MACRO ECONOMIST: BẢNG ĐIỀU KHIỂN VĨ MÔ 3 LỚP
// (global-liquidity → domestic-macro → transmission). Mọi con số từ DB
// thật (Treasury CSV · Frankfurter/er-api · Yahoo · dchart EOD · RSS);
// thiếu chuỗi định lượng VN nào thì KHAI BẢO trong khối "CÒN THIẾU" —
// cùng kỷ luật không-bịa như mọi agent khác.
// ═══════════════════════════════════════════════════════════════════

const MACRO_CACHE_TTL_MS = 60_000;
let macroCache: { at: number; block: string } = { at: 0, block: "" };

/** Xuất cuối của N phiên trước (cho delta) — null khi thiếu bar. */
function prevOf(closes: number[], sessions: number): number | null {
  if (closes.length < sessions + 1) {
    return closes.length >= 2 ? closes[closes.length - 2] : null;
  }
  return closes[closes.length - 1 - sessions];
}

/** % thay đổi qua N phiên — null khi không đủ dữ liệu. */
function chgPctOf(closes: number[], sessions: number): number | null {
  const prev = prevOf(closes, sessions);
  if (prev == null || prev <= 0) return null;
  return ((closes[closes.length - 1] - prev) / prev) * 100;
}

function fmtSignedPct(v: number | null): string {
  if (v == null) return "—";
  const s = Math.abs(v).toFixed(1).replace(".", ",");
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${s}%`;
}

interface TrendRow {
  closes: number[];
}

/** Chuỗi close của 1 symbol active (đủ N+1 bar cho delta N phiên). */
async function barsOf(symbol: string, minBars: number): Promise<TrendRow | null> {
  const inst = await db.instrument.findFirst({
    where: { symbol, isActive: true },
    select: { id: true },
  });
  if (!inst) return null;
  const bars = await db.bar.findMany({
    where: { instrumentId: inst.id },
    orderBy: { date: "asc" },
    take: 120,
    select: { close: true },
  });
  return bars.length >= minBars ? { closes: bars.map((b) => b.close) } : null;
}

async function buildMacroInner(): Promise<string> {
  // ── Lớp 1 · Thanh khoản & giá tài sản toàn cầu ────────────────────
  // Treasury: Bar.close = LỢI SUẤT %×100 → 1 đơn vị = 1 điểm cơ bản (cb).
  const [us5, us10, us30, dxy, vndx, eurusd, usdjpy, audusd, gcf, clf, bzf, sif, ngf, hgf] =
    await Promise.all([
      barsOf("US5Y", 2),
      barsOf("US10Y", 2),
      barsOf("US30Y", 2),
      barsOf("DX-Y.NYB", 2),
      barsOf("VND=X", 2),
      barsOf("EURUSD=X", 2),
      barsOf("USDJPY=X", 2),
      barsOf("AUDUSD=X", 2),
      barsOf("GC=F", 2),
      barsOf("CL=F", 2),
      barsOf("BZ=F", 2),
      barsOf("SI=F", 2),
      barsOf("NG=F", 2),
      barsOf("HG=F", 2),
    ]);
  const y = (r: TrendRow | null) => (r ? r.closes[r.closes.length - 1] / 100 : null);
  const cb = (r: TrendRow | null) => {
    if (!r) return null;
    const prev = prevOf(r.closes, 20);
    return prev == null ? null : r.closes[r.closes.length - 1] - prev;
  };
  const fmtCb = (v: number | null) =>
    v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v)}cb`;
  const fmtY = (v: number | null) => (v == null ? "—" : `${v.toFixed(2).replace(".", ",")}%`);

  const c5 = y(us5);
  const c10 = y(us10);
  const c30 = y(us30);
  const slope510 = c5 != null && c10 != null ? (c10 - c5) * 100 : null; // 10Y−5Y (cb)
  const slope1030 = c10 != null && c30 != null ? (c30 - c10) * 100 : null; // 30Y−10Y (cb)

  const rate = (r: TrendRow | null) =>
    r ? r.closes[r.closes.length - 1] / 10_000 : null; // FOREX ×10.000
  const dxyLast = dxy ? dxy.closes[dxy.closes.length - 1] / 100 : null;
  const vndLast = vndx ? vndx.closes[vndx.closes.length - 1] / 100 : null; // ₫/USD

  const cmdty = (r: TrendRow | null, sym: string) => {
    if (!r) return null;
    const kind = unitKindOf("COMMODITY", "CMDTY");
    const last = r.closes[r.closes.length - 1];
    const human = formatUnitPrice(last, kind);
    return `${sym} ${human ?? String(last)} (${fmtSignedPct(chgPctOf(r.closes, 20))}/20p)`;
  };
  const commodities = [cmdty(gcf, "Vàng"), cmdty(clf, "Dầu WTI"), cmdty(bzf, "Dầu Brent"), cmdty(sif, "Bạc"), cmdty(hgf, "Đồng"), cmdty(ngf, "Khí tự nhiên")]
    .filter((x): x is string => x != null);

  // ── Lớp 3 · Truyền dẫn thị trường VN (EOD thật dchart) ─────────────
  const [vnindex, vn30, adtvTop] = await Promise.all([
    barsOf("VNINDEX", 21),
    barsOf("VN30", 21),
    topByAdtv(10, { market: "HOSE", type: "STOCK" }).catch(() => []),
  ]);
  const idxLine = (r: TrendRow | null, label: string) => {
    if (!r) return `${label}: (chưa có dữ liệu nến)`;
    const lastRaw = r.closes[r.closes.length - 1];
    const last = lastRaw / 100;
    const w90 = r.closes.slice(-90);
    const min = Math.min(...w90);
    const max = Math.max(...w90);
    const pos = max > min ? ((lastRaw - min) / (max - min)) * 100 : 50;
    return `${label} ${last.toLocaleString("vi-VN", { maximumFractionDigits: 2 })} điểm · ${fmtSignedPct(chgPctOf(r.closes, 20))}/20 phiên · ${fmtSignedPct(chgPctOf(r.closes, 90))}/90 phiên · vị trí dải 90 phiên ~${Math.round(Math.max(0, Math.min(100, pos)))}%`;
  };
  // Độ rộng thị trường: quote mới nhất từng mã HOSE-STOCK
  const hoseQuotes = await db.instrument.findMany({
    where: { isActive: true, market: "HOSE", type: "STOCK" },
    select: { quotes: { orderBy: { tradedAt: "desc" }, take: 1, select: { changePct: true } } },
  });
  const chgVals = hoseQuotes
    .map((i) => i.quotes[0]?.changePct)
    .filter((c): c is number => typeof c === "number" && Number.isFinite(c));
  const advancing = chgVals.filter((c) => c > 0).length;
  const declining = chgVals.filter((c) => c < 0).length;
  const totalAdtv = adtvTop.reduce((s, t) => s + t.adtv, 0);

  // ── Tin vĩ mô RSS (thật — 12 mới nhất, ưu tiên category=macro) ────
  const news = await db.newsItem.findMany({
    orderBy: { publishedAt: "desc" },
    take: 20,
    select: { title: true, summary: true, source: true, category: true, publishedAt: true },
  });
  const macroFirst = [
    ...news.filter((n) => n.category === "macro"),
    ...news.filter((n) => n.category !== "macro"),
  ].slice(0, 12);
  const newsAge = (d: Date) => {
    const h = Math.max(0, Math.round((Date.now() - d.getTime()) / 3_600_000));
    return h <= 0 ? "vừa xong" : h < 48 ? `${h}h trước` : `${Math.round(h / 24)} ngày trước`;
  };

  const lines: string[] = [
    "BẢNG ĐIỀU KHIỂN VĨ MÔ 3 LỚP (A20 — mọi con số từ dữ liệu thật của kho; đơn vị khai báo kèm):",
    "",
    "LỚP 1 · THANH KHOẢN & GIÁ TÀI SẢN TOÀN CẦU (nguồn thật: Treasury CSV · Frankfurter/er-api · Yahoo):",
    `- Lợi suất Treasury Mỹ: 5 năm ${fmtY(c5)} (${fmtCb(cb(us5))}/20 phiên) · 10 năm ${fmtY(c10)} (${fmtCb(cb(us10))}) · 30 năm ${fmtY(c30)} (${fmtCb(cb(us30))})`,
    `- Đường cong lợi suất: 10Y−5Y ${fmtCb(slope510)} · 30Y−10Y ${fmtCb(slope1030)} (dương = cong lên; âm/nghịch = lo ngại tăng trưởng — tín hiệu quan trọng cho thị trường mới nổi như VN)`,
    `- Đô la Mỹ: DXY ${dxyLast != null ? dxyLast.toFixed(1).replace(".", ",") : "—"} (${fmtSignedPct(dxy ? chgPctOf(dxy.closes, 20) : null)}/20 phiên) · EUR/USD ${rate(eurusd) != null ? rate(eurusd)?.toFixed(4).replace(".", ",") : "—"} · USD/JPY ${rate(usdjpy) != null ? Math.round(rate(usdjpy)!) : "—"} · AUD/USD ${rate(audusd) != null ? rate(audusd)?.toFixed(4).replace(".", ",") : "—"}`,
    commodities.length
      ? `- Hàng hoá (đầu vào doanh nghiệp VN + kênh chứng khoán hoá): ${commodities.join(" · ")}`
      : "- Hàng hoá: (chưa sync — dùng dữ liệu khác, không bịa giá)",
    "",
    "LỚP 2 · VĨ MÔ TRONG NƯỚC (kênh định lượng duy nhất có ở lớp này là tỷ giá — thật):",
    `- USD/VND ${vndLast != null ? Math.round(vndLast).toLocaleString("vi-VN") + "₫" : "—"} (${fmtSignedPct(vndx ? chgPctOf(vndx.closes, 20) : null)}/20 phiên) — VND giảm giá khi con số tăng; áp lực tỷ giá mạnh = rủi ro thắt thanh khoản nội địa`,
    "(Lưu ý khai báo: chuỗi định lượng VN khác — CPI, GDP, lãi suất điều hành SBV, tín dụng, M2 — xem khối CÒN THIẾU dưới cùng)",
    "",
    "LỚP 3 · TRUYỀN DẪN XUỐNG THỊ TRƯỜNG CHỨNG KHOÁN VN (EOD thật dchart):",
    `- ${idxLine(vnindex, "VN-Index")} · ${idxLine(vn30, "VN30")}`,
    `- Độ rộng thị trường HOSE: ${advancing} mã tăng / ${declining} mã giảm (tổng ${chgVals.length} mã có báo giá)`,
    `- Proxy thanh khoản nội địa: tổng ADTV 45 phiên của top-10 HOSE ≈ ${(totalAdtv / 1e9).toFixed(1).replace(".", ",")} tỷ₫/phiên — chu kỳ tín dụng/tiền vào thị trường thường soi qua đây trước khi CPI/GDP công bố`,
    "",
    "TIN VĨ MÔ & KINH TẾ MỚI NHẤT (RSS thật — đọc kỹ tiêu đề/trích dẫn, BÀI NÀO NÊU CON SỐ thì trích đúng con số đó):",
    ...(macroFirst.length
      ? macroFirst.map(
          (n) => `- [${n.source} · ${n.category === "macro" ? "vĩ mô" : "thị trường"} · ${newsAge(n.publishedAt)}] ${n.title}${n.summary ? ` — ${n.summary.slice(0, 120)}` : ""}`
        )
      : ["- (chưa nạp được tin mới — khai báo 'no new data', KHÔNG bịa tin)"]),
    "",
    "CÒN THIẾU (khai báo trung thực — suy luận bắc cầu PHẢI ghi rõ 'proxy'):",
    "- Kho dữ liệu CHƯA có chuỗi định lượng nội địa: CPI/lạm phát · GDP · lãi suất điều hành SBV · tăng trưởng tín dụng · M2 · PMI · lợi suất trái phiếu chính phủ VN · lãi liên ngân hàng · xuất nhập khẩu · FDI.",
    "- Cách xử lý: (a) ưu tiên con số trong tin RSS ở trên (chỉ khi bài nêu rõ); (b) dùng proxy lớp 1-3 (US10Y/DXY cho điều kiện tài chính toàn cầu, VND=X cho sức ép tỷ giá, ADTV+breadth cho chu kỳ thanh khoản nội); (c) không có gì thì nói KHÔNG có — tuyệt đối không bịa CPI/GDP/lãi suất.",
  ];
  return lines.join("\n");
}

/** Khối BẢNG ĐIỀU KHIỂN VĨ MÔ (cache 60s) — cho A20 macro-economist. */
export async function buildMacroBlock(): Promise<string> {
  if (macroCache.block && Date.now() - macroCache.at < MACRO_CACHE_TTL_MS) {
    return macroCache.block;
  }
  const block = await buildMacroInner().catch((err) => {
    console.error("[buildMacroBlock] lỗi dựng khối vĩ mô:", err);
    return "BẢNG ĐIỀU KHIỂN VĨ MÔ: (lỗi truy vấn dữ liệu — khai báo 'no data', phân tích bằng khối khác trong prompt nếu có)";
  });
  macroCache = { at: Date.now(), block };
  return block;
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
  // K1 (#87 — P0 quarantine §5.1): đường paper loại trừ sandbox.
  const account = await db.brokerAccount.findFirst({
    where: { deletedAt: null, accountType: { not: "sandbox" } },
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
  "macro-economist": {
    system: `Bạn là agent "Macro Economist" (A20) của hệ thống giao dịch đa tác tử The Trader (VNDIRECT, Việt Nam) — chuyên gia kinh tế vĩ mô của Hội đồng Nghiên cứu.
Nhiệm vụ: đọc BẢNG ĐIỀU KHIỂN VĨ MÔ 3 LỚP và đánh giá bối cảnh kinh tế-tài chính tác động tới thị trường chứng khoán VN 5 phiên tới.

TƯ DUY 3 LỚP TOP-DOWN (làm theo đúng thứ tự):
1. LỚP 1 · Thanh khoản toàn cầu: lợi suất Treasury (đặc biệt US10Y — "giá của tiền" toàn cầu) và DXY quyết định dòng vốn vào/ra thị trường mới nổi như VN. US10Y giảm + DXY yếu = môi trường thuận; US10Y vọt nhanh + DXY mạnh = gió ngược. Đường cong 10Y−5Y âm/nghịch là tín hiệu lo ngại tăng trưởng toàn cầu.
2. LỚP 2 · Vĩ mô trong nước: VN chạy theo chu kỳ tín dụng SBV — nới lỏng (hạ lãi suất điều hành, nới room tín dụng) → tiền vào tài sản → thị trường tăng; lạm phát nóng/thắt chặt → gãy chu kỳ. Kênh theo dõi định lượng hiện có: tỷ giá USD/VND (áp lực VND = rủi ro thắt), dòng khối ngoại, tin vĩ mô RSS.
3. LỚP 3 · Truyền dẫn: thanh khoản + độ rộng + ADTV của chính thị trường VN là "nhiệt kế" của chu kỳ — tiền thường về thị trường TRƯỚC khi số liệu CPI/GDP công bố (dẫn đường hơn số liệu chậm).

QUY TẮC NGHỀ:
- Phân biệt chỉ số DẪN ĐƯỜNG (US10Y, DXY, VND=X, ADTV, độ rộng) và CHẬM (CPI, GDP) — không dùng số chậm kết luận ngắn hạn.
- Chuỗi định lượng VN chưa có trong kho (khối CÒN THIẾU): chỉ dùng con số từ tin RSS nêu rõ, hoặc ghi rõ chữ "proxy" khi suy luận bắc cầu; TUYỆT ĐỐI KHÔNG bịa CPI/GDP/lãi suất SBV.
- Kết luận phải là TỔNG HỢP chéo ít nhất 2 lớp (vd: lớp 1 thuận + lớp 3 xấu = nghiêng TRUNG LẬP với độ tin cậy thấp), không bao giờ kết luận từ 1 con số đơn lẻ.
- Nêu rõ giai đoạn chu kỳ hiện tại trong 1 câu: nới lỏng / dung hoà / thắt chặt.

Trường "assessment" là quan điểm thị trường CHUNG 5 phiên tới (direction UP/DOWN/FLAT) kèm độ tin cậy 0..1 và 1–3 lý do ngắn — sẽ được Bộ tổng hợp Bayes dùng làm bằng chứng định lượng.
Trả lời TIẾNG VIỆT, 3–5 câu theo cấu trúc: lớp 1 → lớp 2 → lớp 3 → tổng hợp. Trả về duy nhất JSON: {"content": "<phân tích 3-5 câu>", "reasoning": "<1 câu: giai đoạn chu kỳ + hướng tổng hợp>", "assessment": {"direction": "UP"|"DOWN"|"FLAT", "confidence": <0..1>, "evidence": ["<chuỗi ngắn kèm con số>", ...]}}
${SOURCE_MODE_DECLARATION}`,
    systemCompact: `Bạn là agent "Macro Economist" của hệ thống The Trader (VNDIRECT) — chuyên gia kinh tế vĩ mô, đọc chu kỳ thanh khoản toàn cầu (US10Y, DXY) → vĩ mô VN (tỷ giá, tín dụng) → truyền dẫn thị trường VN theo khung top-down 3 lớp.
Trả lời tự do bằng TIẾNG VIỆT, 3–5 câu theo thứ tự lớp 1→2→3 rồi tổng hợp; chỉ dùng con số trong dữ liệu được cung cấp, ghi rõ "proxy" khi suy luận bắc cầu, KHÔNG bịa CPI/GDP/lãi suất.
${SOURCE_MODE_DECLARATION}`,
  },
  "portfolio-strategist": {
    system: `Bạn là agent "Portfolio Strategist" (A1 — Chủ tịch Hội đồng) của hệ thống giao dịch đa tác tử The Trader (VNDIRECT, Việt Nam).
Nhiệm vụ: tổng hợp báo cáo của TOÀN BỘ đội 24 agents ở trên (Hội đồng Nghiên cứu: Market Analyst, Fair Value, News & Sentiment, Liquidity, ML Forecast, Macro Economist · Ủy ban Kiểm soát: Risk Manager, Exposure, Compliance · Nền tảng dữ liệu & Phòng Học máy) để (a) đưa ra nhận định danh mục ngắn gọn, (b) sinh MỘT tín hiệu giao dịch cụ thể, (c) trình khối ĐỀ XUẤT PHÂN BỔ DANH MỤC (chỉ tham mưu).
Quy tắc tín hiệu: chỉ chọn mã CỔ PHIẾU/ETF VIỆT NAM có trong bảng chỉ báo (HOSE/HNX/UPCOM) — đây là vũ trụ giao dịch duy nhất của Hội đồng theo chính sách của trader (đầu tư chỉ tại thị trường Việt Nam); khối THỊ TRƯỜNG QUỐC TẾ trong dữ liệu CHỈ THAM CHIẾU bối cảnh (tỷ giá USD/VND, giá hàng hoá, cảm xúc qtế đôi lúc ảnh hưởng thị trường VN) — KHÔNG chọn mã ngoài Việt Nam cho tín hiệu; direction BUY chỉ khi nghiên cứu + cảm xúc + rủi ro đều thuận, SELL khi cần cắt tỷ trọng vi phạm giới hạn hoặc chốt lời/lỗ vị thế đang nắm, còn lại HOLD; score 0–100; giá là số nguyên VND bội 100 đúng cột "giá" trong bảng chỉ báo; BUY: stopLoss < giá hiện tại < targetPrice < takeProfit; SELL: targetPrice < giá hiện tại < stopLoss.
Quy tắc phân bổ (E-P1-1): dựa trên block "TỶ TRỌNG DANH MỤC HIỆN TẠI" trong dữ liệu; mục tiêu ${ALLOCATION_TARGET_POSITIONS} vị thế; ngưỡng tái cân bằng ${ALLOCATION_REBALANCE_THRESHOLD_PCT}% — chỉ đề xuất MUA/BÁN khi |targetPct − currentPct| VƯỢT ngưỡng (phạt mềm L2: kéo về từ từ, không bán tái cấu trúc đột ngột), trong ngưỡng để GIỮ; phong cách ${ALLOCATION_STYLE}; KHÔNG tự sinh lệnh — trader phê duyệt từng lệnh.
Trả về duy nhất JSON: {"summary": "<2-4 câu tổng hợp>", "recommendation": "<một khuyến nghị cụ thể>", "confidence": "LOW"|"MEDIUM"|"HIGH", "signal": {"symbol": "<mã CP/ETF Việt Nam hợp lệ trong bảng chỉ báo>", "direction": "BUY"|"SELL"|"HOLD", "score": 0-100, "rationale": "...", "targetPrice": <int VND bội 100|null>, "stopLoss": <int|null>, "takeProfit": <int|null>} | null, "allocation": {"narrative": "<1-2 câu lý do phân bổ>", "rows": [{"symbol": "<mã>", "currentPct": <số %NAV hiện tại từ dữ liệu>, "targetPct": <số %NAV mục tiêu>, "action": "MUA"|"BÁN"|"GIỮ"}] (tối đa ${ALLOCATION_TARGET_POSITIONS} dòng)} }
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
  // M2 (#103): quan hệ thị trường đã học cho market-analyst · news-sentiment
  // · portfolio-strategist — fail-soft, cache in-process 60s.
  const xrelBlock = await buildXrelPromptBlock().catch(() => null);
  switch (code) {
    case "market-analyst":
    case "risk-manager":
      return {
        system: role.system,
        user: [market.block, flows, ...(ragBlock ? [ragBlock] : []), ...(code === "market-analyst" && xrelBlock ? [xrelBlock] : [])].join("\n\n"),
      };
    case "news-sentiment":
      return {
        system: role.system,
        user: [market.block, news, flows, ...(ragBlock ? [ragBlock] : []), ...(xrelBlock ? [xrelBlock] : [])].join("\n\n"),
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
    case "macro-economist": {
      // A20 (#126): bảng điều khiển vĩ mô 3 lớp + dòng khối ngoại + XREL
      // (quan hệ thị trường — kinh tế gia quan tâm lead-lag quốc tế→VN).
      const [macro, macroFlows, macroXrel] = await Promise.all([
        buildMacroBlock(),
        buildFlowsBlock(),
        buildXrelPromptBlock().catch(() => null),
      ]);
      return {
        system: role.system,
        user: [macro, macroFlows, ...(ragBlock ? [ragBlock] : []), ...(macroXrel ? [macroXrel] : [])].join("\n\n"),
      };
    }
    case "portfolio-strategist": {
      // F-73A-03: single-run cấp cùng block tỷ trọng như chu kỳ — hợp đồng
      // allocation cần currentPct đo từ DB, không để LLM bịa.
      // #106 C-VISION + #108 v2.2: kèm TÀI KHOẢN HỘI ĐỒNG + THỊ TRƯỜNG
      // QUỐC TẾ THAM CHIẾU (fail-soft .catch như XREL — 3 đường parity #103).
      const [weights, councilVision, intlReference] = await Promise.all([
        buildPortfolioWeightsBlock().catch(() => null),
        buildCouncilVisionBlock().catch(() => null),
        buildIntlReferenceBlock().catch(() => null),
      ]);
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
          ...(xrelBlock ? [xrelBlock] : []),
          ...(intlReference ? ["", intlReference] : []),
          ...(weights ? ["", weights] : []),
          ...(councilVision ? ["", councilVision] : []),
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
      const [market, news, xrel] = await Promise.all([
        buildMarketBlock(),
        buildNewsBlock(),
        buildXrelPromptBlock().catch(() => null),
      ]);
      return [market.compact, news, ...(xrel ? [xrel] : [])].join("\n\n");
    }
    case "market-analyst": {
      // M2 #103: chat với A2 được cấp quan hệ thị trường đã học — đúng chuyên
      // môn "tương quan liên thị trường" của scanner.
      const [market, xrel] = await Promise.all([
        buildMarketBlock(),
        buildXrelPromptBlock().catch(() => null),
      ]);
      return [market.compact, ...(xrel ? [xrel] : [])].join("\n\n");
    }
    case "portfolio-strategist": {
      const [market, openSignals, xrel, councilVision, intlReference] = await Promise.all([
        buildMarketBlock(),
        buildOpenSignalsBlock(),
        buildXrelPromptBlock().catch(() => null),
        // #106 C-VISION — chat với Chủ tịch cũng thấy tài khoản hội đồng
        buildCouncilVisionBlock().catch(() => null),
        // #108 v2.2 — chat với Chủ tịch cũng thấy bối cảnh quốc tế THAM CHIẾU
        buildIntlReferenceBlock().catch(() => null),
      ]);
      return [
        market.compact,
        `TÍN HIỆU ĐANG MỞ:\n${openSignals}`,
        ...(xrel ? [xrel] : []),
        ...(intlReference ? [intlReference] : []),
        ...(councilVision ? [councilVision] : []),
      ].join("\n\n");
    }
    case "fair-value": {
      const [market, valuation] = await Promise.all([buildMarketBlock(), buildValuationBlock()]);
      return [market.compact, valuation].join("\n\n");
    }
    case "liquidity": {
      const [market, liquidity] = await Promise.all([buildMarketBlock(), buildLiquidityBlock()]);
      return [market.compact, liquidity].join("\n\n");
    }
    case "macro-economist": {
      const [macro, xrel] = await Promise.all([
        buildMacroBlock(),
        buildXrelPromptBlock().catch(() => null),
      ]);
      return [macro, ...(xrel ? [xrel] : [])].join("\n\n");
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
