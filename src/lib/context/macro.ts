/** (Task 144 P2-b) — tách từ src/lib/agent-context.ts (pure move)
 *  #129 (F-02A + F-10 + F-17): chuỗi vĩ mô VN từ MacroSeries + kênh truyền
 *  dẫn quốc tế XREL + bảng dự báo multi-asset 8 tài sản cho A20 macro-economist.
 *  macroCache TTL 60s giữ nguyên ngữ vi module — semantics cache ĐÚNG. */

import { db } from "@/lib/db";
import { macroSeriesPromptLines } from "@/lib/macro-vn";
import { buildXrelIntlPromptBlock } from "@/lib/ml/xrel";
import { macroAssetForecasts } from "@/lib/ml/macro-forecast";
import { topByAdtv } from "@/lib/dated-series";
import { formatUnitPrice, unitKindOf } from "@/lib/format";

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
  // (F-1892-01 fixbug #189: quotes some — BROAD HOSE không quote khỏi nạp)
  const hoseQuotes = await db.instrument.findMany({
    where: { isActive: true, market: "HOSE", type: "STOCK", quotes: { some: {} } },
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
    "(Lưu ý khai báo: chuỗi định lượng VN — CPI, GDP, lãi suất điều hành SBV, tín dụng, M2... — xem khối VĨ MÔ TRONG NƯỚC · CHUỖI ĐỊNH LƯỢNG dưới cùng; series thiếu được khai báo trung thực)",
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
    ...(await macroPromptTail()),
  ];
  return lines.join("\n");
}

/**
 * #129 (F-02A + F-10 + F-17) — phần đuôi bảng điều khiển vĩ mô A20:
 *  • F-02A: khối "VĨ MÔ TRONG NƯỚC — CHUỖI ĐỊNH LƯỢNG (MacroSeries)" — series
 *    CÓ dữ liệu hiển thị giá trị + Δ + kỳ + nguồn (mode extracted kèm URL);
 *    series còn thiếu sinh động từ DB (thay khối "CÒN THIẾU" tĩnh cũ).
 *  • F-10: khối "KÊNH TRUYỀN DẪN QUỐC TẾ → VN" từ MarketRelation họ intl:*
 *    (lead-lag có chỉnh múi giờ, permutation p + Bonferroni) — null khi chưa
 *    đủ cặp đáng tin (N2 — không bịa quan hệ).
 *  • F-17: bảng "DỰ BÁO 5 PHIÊN 8 TÀI SẢN" (macro-mlp) — mỗi dòng kèm Brier
 *    rolling 60 phiên vs baseline 0,667; tài sản chưa đủ cạnh biên khai báo
 *    rõ (N6 trung thực).
 * Mọi khối fail-soft — lỗi 1 nguồn không phá bảng điều khiển chính.
 */
async function macroPromptTail(): Promise<string[]> {
  const out: string[] = [];
  // F-02A — chuỗi vĩ mô VN từ MacroSeries (đã qua Q10 releaseAt ≤ now).
  try {
    const seriesLines = await macroSeriesPromptLines();
    out.push(...seriesLines);
  } catch (err) {
    console.error("[buildMacroInner] macroSeriesPromptLines lỗi (fail-soft):", err);
  }
  // F-10 — kênh truyền dẫn quốc tế (null = chưa đủ dữ liệu, bỏ im lặng).
  try {
    const intlBlock = await buildXrelIntlPromptBlock();
    if (intlBlock != null) {
      out.push("", intlBlock);
    }
  } catch (err) {
    console.error("[buildMacroInner] buildXrelIntlPromptBlock lỗi (fail-soft):", err);
  }
  // F-17 — dự báo 5 phiên 8 tài sản (đóng kỳ vọng "trái phiếu").
  try {
    const forecast = await macroAssetForecasts();
    if (forecast.assets.length > 0) {
      out.push("", "DỰ BÁO 5 PHIÊN · 8 TÀI SẢN (macro-mlp — model riêng từng tài sản, Brier rolling 60 phiên so baseline đi-ngang 0,667):");
      for (const a of forecast.assets) {
        const dirTxt = a.direction === "UP" ? "TĂNG" : a.direction === "DOWN" ? "GIẢM" : "ĐI NGANG";
        const brierTxt =
          a.brier60 == null
            ? "chưa đủ dữ liệu chấm"
            : `${a.brier60.toFixed(3)}${a.edge ? " (CÓ cạnh biên vs 0,667)" : " (chưa đủ cạnh biên — đọc thận trọng)"}`;
        out.push(
          `- ${a.label}: ${dirTxt} (pT ${((a.pUp ?? 0) * 100).toFixed(0)}% / pN ${((a.pDown ?? 0) * 100).toFixed(0)}%) · Brier60 ${brierTxt}`
        );
      }
      out.push(
        "(Dự báo định lượng từ dữ liệu cũ — KHÔNG phải khuyến nghị; US10Y/US30Y là dự báo LỢI SUẤT trái phiếu: TĂNG = lợi suất tăng = giá trái phiếu giảm.)"
      );
    }
  } catch (err) {
    console.error("[buildMacroInner] macroAssetForecasts lỗi (fail-soft):", err);
  }
  return out.length > 0
    ? out
    : [
        "CÒN THIẾU (khai báo trung thực — suy luận bắc cầu PHẢI ghi rõ 'proxy'):",
        "- Kho dữ liệu CHƯA có chuỗi định lượng nội địa: CPI/lạm phát · GDP · lãi suất điều hành SBV · tăng trưởng tín dụng · M2 · PMI · lợi suất trái phiếu chính phủ VN · lãi liên ngân hàng · xuất nhập khẩu · FDI.",
        "- Cách xử lý: (a) ưu tiên con số trong tin RSS ở trên (chỉ khi bài nêu rõ); (b) dùng proxy lớp 1-3 (US10Y/DXY cho điều kiện tài chính toàn cầu, VND=X cho sức ép tỷ giá, ADTV+breadth cho chu kỳ thanh khoản nội); (c) không có gì thì nói KHÔNG có — tuyệt đối không bịa CPI/GDP/lãi suất.",
      ];
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
