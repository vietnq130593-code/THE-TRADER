/**
 * src/lib/council/vision.ts — KHỐI TẦM NHÌN HỘI ĐỒNG C-VISION
 * (#106 COUNCIL_STEWARDSHIP_BLUEPRINT §4 · hiệu chỉnh v2.0 #107 theo làm rõ
 * của trader: "hội đồng ngoài nắm được thông tin các thị trường còn nắm thông
 * tin số tiền hiện có, các khoản đầu tư và giá trị các khoản đầu tư hiện tại
 * đang biến động theo thị trường như thế nào").
 *
 * v2.0 thay đổi so với #106: BỎ mục "thí nghiệm phân bổ đang chạy + bài học"
 * (E-ALLOC đã tháo — khoản tiền thử nghiệm sandbox CHÍNH LÀ thí nghiệm);
 * thêm mục (4) THỊ TRƯỜNG ĐA TÀI SẢN 5 nhóm.
 * v2.2 (#108 — chính sách VN-only): mục (4) đổi chân thành THAM CHIẾU (4 nhóm
 * quốc tế + USD/VND theo dõi vì ảnh hưởng thị trường VN — đầu tư chỉ tại
 * thị trường VN); vị thế hiển thị trung thực mọi thị trường (chống sót dữ
 * liệu lịch sử phi-VN — hiện 0 vị thế như vậy).
 *
 * 4 phần: (1) tài khoản sandbox K1 · (2) vị thế đang nắm mọi thị trường ·
 * (3) kết quả 7 quyết định gần nhất từ D-LEDGER · (4) thị trường đa tài sản.
 * Tiêm 3 đường (parity XREL): wave E Chủ tịch (route.ts) · single-run
 * portfolio-strategist · chat strategist — fail-soft .catch(() => null),
 * cache in-process 60s.
 *
 * CHỈ ĐỌC: tầm nhìn ≠ quyền thực thi — agents vẫn KHÔNG tự đặt lệnh sandbox
 * ngoài cổng K1 auto-convert B9 hiện hành.
 */

import { db } from "@/lib/db";
import { basketStatsCached } from "@/lib/council/baskets";
import { markPositionVND, usdVndRate, execUnitLabel, isForeignMarket } from "@/lib/exec/market-rules";

const CACHE_TTL_MS = 60_000;
let cache: { at: number; block: string | null } = { at: 0, block: null };

function fmtVndShort(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)} tỷ ₫`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} tr ₫`;
  return `${Math.round(n).toLocaleString("vi-VN")} ₫`;
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const s = Math.abs(n).toFixed(2).replace(".", ",");
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${s}%`;
}

/** Vị thế sandbox mọi thị trường + định giá theo luật thị trường (quy VND). */
async function sandboxPositions(): Promise<
  Array<{
    symbol: string;
    market: string;
    qty: number;
    qtyLabel: string;
    avgPrice: number;
    last: number | null;
    valueVND: number;
    upnl: number | null;
    fxRate: number | null;
  }>
> {
  const positions = await db.position.findMany({
    where: {
      status: "OPEN",
      brokerAccount: { accountType: "sandbox", deletedAt: null },
    },
    include: {
      instrument: {
        select: { id: true, symbol: true, market: true, type: true, currency: true },
      },
    },
  });
  const out = [];
  for (const p of positions) {
    const lastBar = await db.bar.findFirst({
      where: { instrumentId: p.instrument.id },
      orderBy: { date: "desc" },
      select: { close: true },
    });
    const last = lastBar?.close ?? null;
    const mark = await markPositionVND({
      quantity: p.quantity,
      avgPrice: p.avgPrice,
      avgCostVND: p.avgCostVND,
      openIdxUnits: p.openIdxUnits,
      instrument: p.instrument,
      lastNative: last ?? p.avgPrice,
    }).catch(() => null);
    out.push({
      symbol: p.instrument.symbol,
      market: p.instrument.market,
      qty: p.quantity,
      qtyLabel: execUnitLabel(p.instrument),
      avgPrice: p.avgPrice,
      last,
      valueVND: mark?.valueVND ?? 0,
      upnl: mark?.unrealisedVND ?? null,
      fxRate: mark?.fxRate ?? null,
    });
  }
  return out;
}

async function buildVisionBlockInner(): Promise<string | null> {
  // ── (1) Tài khoản sandbox K1 (thế giới Hội đồng đánh giá toàn cục) ──
  const [account, kSetting, positions, decisions, basketRows, fx] = await Promise.all([
    db.brokerAccount.findFirst({
      where: { accountType: "sandbox", deletedAt: null },
      select: { cashBalance: true, equity: true },
    }),
    db.appSetting.findUnique({
      where: { key: "k-sandbox" },
      select: { value: true },
    }),
    sandboxPositions(),
    db.decisionEvaluation.findMany({
      orderBy: { decidedAt: "desc" },
      take: 7,
      include: { signal: { include: { instrument: { select: { symbol: true } } } } },
    }),
    basketStatsCached().catch(() => [] as Awaited<ReturnType<typeof basketStatsCached>>),
    usdVndRate().catch(() => null),
  ]);

  const initial = (() => {
    try {
      const v = kSetting?.value ? JSON.parse(kSetting.value) : null;
      return typeof v?.initialAmount === "number" ? v.initialAmount : null;
    } catch {
      return null;
    }
  })();

  const lines: string[] = [];
  lines.push("═══ TÀI KHOẢN HỘI ĐỒNG (sandbox K1 — thế giới thử nghiệm) ═══");
  if (account) {
    const equity = Number(account.equity);
    const cash = Number(account.cashBalance);
    const pnl = initial != null ? equity - initial : null;
    lines.push(
      `Tổng tài sản: ${fmtVndShort(equity)} · Tiền: ${fmtVndShort(cash)}` +
        (pnl != null
          ? ` · L/L từ lúc kích hoạt: ${fmtVndShort(pnl)} (${fmtPct(initial ? (pnl / initial) * 100 : null)})`
          : "")
    );
  } else {
    lines.push("Chưa có tài khoản sandbox — chưa kích hoạt cơ chế thử nghiệm K1.");
  }

  // ── (2) Vị thế đang nắm — MỌI THỊ TRƯỜNG, giá trị quy VND ──
  if (positions.length > 0) {
    const vn = positions.filter((p) => !isForeignMarket(p.market));
    const foreign = positions.filter((p) => isForeignMarket(p.market));
    const posLines: string[] = [];
    if (vn.length > 0) {
      posLines.push(
        ...vn.map(
          (p) =>
            `${p.symbol} ${p.qty}cp @${p.avgPrice.toLocaleString("vi-VN")}` +
            (p.upnl != null
              ? ` → L/L ${p.upnl > 0 ? "+" : p.upnl < 0 ? "−" : ""}${Math.abs(Math.round(p.upnl)).toLocaleString("vi-VN")}₫`
              : "")
        )
      );
    }
    if (foreign.length > 0) {
      const fxNote = fx != null ? ` (quy đổi ${Math.round(fx).toLocaleString("vi-VN")}₫/USD)` : "";
      posLines.push(
        ...foreign.map((p) => {
          const isNotional = p.market === "BOND" || p.market === "COMMODITY";
          const qtyPart = isNotional
            ? `${p.qty}${p.qtyLabel.includes("danh nghĩa") ? " đv danh nghĩa" : " đv"}`
            : `${p.qty} ${p.qtyLabel}`;
          const pricePart = isNotional ? "" : ` @${p.avgPrice.toLocaleString("vi-VN")}`;
          return (
            `${p.symbol} ${qtyPart}${pricePart} → ${fmtVndShort(p.valueVND)}` +
            (p.upnl != null
              ? ` L/L ${p.upnl > 0 ? "+" : p.upnl < 0 ? "−" : ""}${Math.abs(Math.round(p.upnl)).toLocaleString("vi-VN")}₫`
              : "") +
            fxNote
          );
        })
      );
    }
    lines.push(`VỊ THẾ: ${posLines.join(" · ")}`);
  } else {
    lines.push("VỊ THẾ: không nắm giữ mã nào.");
  }

  // ── (3) Kết quả 7 quyết định gần nhất (D-LEDGER) ──
  if (decisions.length > 0) {
    const dLines = decisions.map((d) => {
      const sym = d.signal?.instrument?.symbol ?? "?";
      const v = d.verdict === "WIN" ? "✔" : d.verdict === "LOSS" ? "✘" : "→";
      const pnl = d.executionKind?.startsWith("EXECUTED") && d.cashPnlVND != null
        ? ` ${fmtVndShort(Number(d.cashPnlVND))}`
        : "";
      return `${v}${d.direction} ${sym} ${fmtPct(d.markPnlPct)}${pnl}`;
    });
    lines.push(`KẾT QUẢ QUYẾT ĐỊNH GẦN NHẤT (sổ đánh giá): ${dLines.join(" · ")}`);
  } else {
    lines.push("KẾT QUẢ QUYẾT ĐỊNH: sổ đánh giá chưa có hàng — chưa từng đánh giá.");
  }

  // ── (4) THỊ TRƯỜNG ĐA TÀI SẢN (5 nhóm — v2.0 thay mục thí nghiệm;
  // v2.2: 4 nhóm quốc tế + USD/VND = THAM CHIẾU theo dõi) ──
  if (basketRows.length > 0) {
    const parts = basketRows.map((b) => `${b.short} ${fmtPct(b.ret5d)}/${fmtPct(b.ret30d)}`);
    const fxPart = fx != null ? ` · USD/VND ${Math.round(fx).toLocaleString("vi-VN")}` : "";
    lines.push(
      `THỊ TRƯỜNG ĐA TÀI SẢN (lợi suất 5 phiên/30 phiên): ${parts.join(" · ")}${fxPart} — quốc tế & tỷ giá chỉ THAM CHIẾU (ảnh hưởng thị trường VN qua kênh ngoại hối/hàng hoá/cảm xúc); đầu tư Hội đồng chỉ tại thị trường Việt Nam.`
    );
  }

  const block = lines.filter(Boolean).join("\n");
  return block.length > 0 ? block : null;
}

/** Khối tầm nhìn hội đồng (cache 60s — pattern XREL #103). */
export async function buildCouncilVisionBlock(): Promise<string | null> {
  if (cache.block && Date.now() - cache.at < CACHE_TTL_MS) return cache.block;
  const block = await buildVisionBlockInner().catch(() => null);
  cache = { at: Date.now(), block };
  return block;
}
