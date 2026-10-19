/** (Task 144 P2-b) — tách từ src/lib/agent-context.ts (pure move)
 *  #108 E-EXEC v2.2 — THỊ TRƯỜNG QUỐC TẾ THAM CHIẾU: buildIntlReferenceBlock
 *  + universeCache TTL 60s (giữ nguyên ngữ vi module — semantics cache ĐÚNG). */

import { listForeignReference } from "@/lib/exec/market-rules";
import { formatUnitPrice, unitKindOf } from "@/lib/format";

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
