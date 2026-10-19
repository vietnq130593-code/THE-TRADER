/** (Task 144 P2-b) — tách từ src/lib/agent-context.ts (pure move)
 *  Khối SNAPSHOT VN30: MarketSnapshot + buildMarketBlock. */

import { db } from "@/lib/db";
import { atr, bollinger, stochastic } from "@/lib/indicators";
import { topByAdtv } from "@/lib/dated-series";
import { latestFeatureSnapshot } from "@/lib/ml/features";
// #107/#108 E-EXEC — thị trường quốc tế THAM CHIẾU (theo dõi, không đầu tư)
// cho prompt Chủ tịch/strategist + luật vi mô sandbox VN-only.
import { isTradableSandboxInstrument } from "@/lib/exec/market-rules";

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
