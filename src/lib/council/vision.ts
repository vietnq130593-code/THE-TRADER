/**
 * src/lib/council/vision.ts — KHỐI TẦM NHÌN HỘI ĐỒNG C-VISION (#106
 * COUNCIL_STEWARDSHIP_BLUEPRINT §4 — phê duyệt riêng của trader cho thay đổi
 * quarantine P0 §5.1 #87: "Hội đồng không thấy tài khoản thì làm sao đánh giá
 * toàn cục các quyết định mua bán lợi ích hay tổn thất").
 *
 * buildCouncilVisionBlock() — ≤900 ký tự (~360 token, cùng ngân sách XREL
 * #103), 4 phần: (1) tài khoản sandbox K1 · (2) vị thế đang nắm · (3) kết quả
 * 7 quyết định gần nhất từ D-LEDGER · (4) thí nghiệm phân bổ đang chạy + bài
 * học thí nghiệm đóng gần nhất. Tiêm 3 đường (parity XREL): wave E Chủ tịch
 * (route.ts) · single-run portfolio-strategist · chat strategist — fail-soft
 * .catch(() => null), cache in-process 60s.
 *
 * CHỈ ĐỌC: tầm nhìn ≠ quyền thực thi — agents vẫn KHÔNG tự đặt lệnh sandbox
 * ngoài cổng K1 auto-convert B9 hiện hành.
 */

import { db } from "@/lib/db";

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

/** Vị thế sandbox + close mới nhất để tính lãi/lỗ chưa thực hiện. */
async function sandboxPositions(): Promise<
  Array<{ symbol: string; qty: number; avgPrice: number; last: number | null; upnl: number | null }>
> {
  const positions = await db.position.findMany({
    where: {
      status: "OPEN",
      brokerAccount: { accountType: "sandbox", deletedAt: null },
    },
    include: { instrument: { select: { id: true, symbol: true } } },
  });
  const out = [];
  for (const p of positions) {
    const lastBar = await db.bar.findFirst({
      where: { instrumentId: p.instrument.id },
      orderBy: { date: "desc" },
      select: { close: true },
    });
    const last = lastBar?.close ?? null;
    const upnl = last != null ? (last - p.avgPrice) * p.quantity : null;
    out.push({
      symbol: p.instrument.symbol,
      qty: p.quantity,
      avgPrice: p.avgPrice,
      last,
      upnl,
    });
  }
  return out;
}

async function buildVisionBlockInner(): Promise<string | null> {
  // ── (1) Tài khoản sandbox K1 (thế giới Hội đồng đánh giá toàn cục) ──
  const [account, kSetting, positions, decisions, runningExps, lastDone] =
    await Promise.all([
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
      db.allocationExperiment.findMany({
        where: { status: "RUNNING" },
        orderBy: { startedAt: "desc" },
        take: 2,
        include: { snapshots: { orderBy: { date: "desc" }, take: 1 } },
      }),
      db.allocationExperiment.findFirst({
        where: { status: "DONE" },
        orderBy: { endedAt: "desc" },
      }),
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

  // ── (2) Vị thế đang nắm ──
  if (positions.length > 0) {
    const posLines = positions.map(
      (p) =>
        `${p.symbol} ${p.qty}cp @${p.avgPrice.toLocaleString("vi-VN")}` +
        (p.upnl != null
          ? ` → L/L ${p.upnl > 0 ? "+" : p.upnl < 0 ? "−" : ""}${Math.abs(Math.round(p.upnl)).toLocaleString("vi-VN")}₫`
          : "")
    );
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

  // ── (4) Thí nghiệm phân bổ đang chạy + bài học gần nhất ──
  if (runningExps.length > 0) {
    const eLines = runningExps.map((e) => {
      const last = e.snapshots[0];
      const w = (() => {
        try {
          const arr = JSON.parse(e.weightsJson) as Array<{ basket: string; weight: number }>;
          return arr
            .filter((x) => x.weight > 0)
            .map((x) => `${x.basket.replace("_", " ")} ${x.weight}%`)
            .join("/");
        } catch {
          return "?";
        }
      })();
      const ret = last ? fmtPct(last.returnPct) : "0%";
      return `"${e.name}" [${w}] tới nay ${ret}`;
    });
    lines.push(`THÍ NGHIỆM PHÂN BỔ ĐANG CHẠY: ${eLines.join(" · ")}`);
  }
  if (lastDone) {
    const lesson = (lastDone.lesson ?? "").slice(0, 160);
    lines.push(
      `BÀI HỌC THÍ NGHIỆM ĐÓNG GẦN NHẤT ("${lastDone.name}" ${fmtPct(lastDone.returnPct)}): ${lesson || "chưa có bài học"}`
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
