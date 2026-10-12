/**
 * scripts/p108-verify.ts — NGHIỆM THU #108 COUNCIL_STEWARDSHIP_BLUEPRINT v2.2
 * (chính sách ĐẦU TƯ CHỈ TẠI THỊ TRƯỜNG VIỆT NAM — quốc tế/forex THAM CHIẾU).
 * Thay thế p107-verify.ts (đa thị trường đã bị thu hồi theo chỉ thị trader).
 * Hermetic — TỰ DỌN sau chạy: mọi lệnh/tín hiệu test bị xoá, sandbox không
 * đổi cash (lệnh chặn không trừ tiền; lệnh TCB test chỉ tạo PENDING rồi xoá).
 *
 * Chạy: DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/postgres?schema=trader" \
 *        bunx tsx scripts/p108-verify.ts
 */

import "dotenv/config";
import type { Market } from "@prisma/client";
import { db } from "../src/lib/db";
import {
  execRuleFor,
  foreignPriceUnitValueVND,
  notionalIdxSeries,
  usdVndRate,
  isTradableSandboxInstrument,
} from "../src/lib/exec/market-rules";
import { ROLE_PROMPTS } from "../src/lib/agent-context";
import { buildCouncilVisionBlock } from "../src/lib/council/vision";
import { buildIntlReferenceBlock } from "../src/lib/agent-context";
import { evaluateDecisions } from "../src/lib/council/decision-eval";
import { createPaperOrderFromSignal } from "../src/lib/signal-execution";

const APP = process.env.APP_URL ?? "http://127.0.0.1:3000";
let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function approx(a: number, b: number, tolPct: number): boolean {
  const ref = Math.max(1, Math.abs(b));
  return Math.abs(a - b) / ref <= tolPct / 100;
}

async function api(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${APP}${path}`);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const FOREIGN_MARKETS: Market[] = ["US", "HK", "BOND", "FOREX", "COMMODITY"];

async function main(): Promise<void> {
  console.log("═══ P108-VERIFY — COUNCIL v2.2 (đầu tư chỉ tại thị trường VN, quốc tế tham chiếu) ═══");

  // ── 1. Cổng luật vi mô VN-only (execRuleFor) ─────────────────────────────
  console.log("\n[1] execRuleFor — chính sách VN-only:");
  const tcbRule = execRuleFor({ symbol: "TCB", market: "HOSE", type: "STOCK" });
  check("TCB HOSE — luật VN còn nguyên (lot 100 · phí 0,15% · băng)", tcbRule != null && tcbRule.lotStep === 100 && tcbRule.minQty === 100 && tcbRule.feeRate === 0.0015 && tcbRule.hasBand === true);
  const etfRule = execRuleFor({ symbol: "E1VFVN30", market: "HNX", type: "ETF" });
  check("ETF HNX — luật VN (như hiện hành)", etfRule != null && etfRule.lotStep === 100);
  check("VNINDEX INDEX — null (tham chiếu)", execRuleFor({ symbol: "VNINDEX", market: "HOSE", type: "INDEX" }) == null);
  const nullCases: Array<[string, string, string]> = [
    ["AAPL", "US", "STOCK"],
    ["0700.HK", "HK", "STOCK"],
    ["US10Y", "BOND", "BOND"],
    ["EURUSD=X", "FOREX", "FX"],
    ["VND=X", "FOREX", "FX"],
    ["GC=F", "COMMODITY", "CMDTY"],
    ["USDJPY=X", "FOREX", "FX"],
    ["DX-Y.NYB", "FOREX", "FX"],
    ["^GSPC", "US", "INDEX"],
  ];
  for (const [sym, mkt, type] of nullCases) {
    check(`${sym} (${mkt}) — null = THAM CHIẾU, không đặt lệnh`, execRuleFor({ symbol: sym, market: mkt, type }) == null);
  }

  // ── 2. Map tín hiệu (instrumentIdBySymbol) tự loại phi-VN ───────────────
  console.log("\n[2] Map tín hiệu — chỉ CP/ETF VN:");
  const insts = await db.instrument.findMany({
    where: { isActive: true },
    select: { symbol: true, market: true, type: true },
  });
  const tradable = insts.filter((i) => isTradableSandboxInstrument(i));
  check("mọi mã hợp lệ đều HOSE/HNX/UPCOM", tradable.length > 0 && tradable.every((i) => ["HOSE", "HNX", "UPCOM"].includes(i.market)), `${tradable.length} mã`);
  check("0 mã phi-VN trong map tín hiệu", tradable.filter((i) => FOREIGN_MARKETS.includes(i.market)).length === 0);
  check("0 mã INDEX trong map tín hiệu", tradable.filter((i) => i.type === "INDEX").length === 0);

  // ── 3. Bộ định giá lịch sử phi-VN GIỮ NGUYÊN (hiển thị trung thực + D-LEDGER) ──
  console.log("\n[3] Bộ định giá VND đa thị trường (lịch sử):");
  const fx = await usdVndRate();
  check("tỷ giá USD/VND còn khả dụng (theo dõi)", fx != null && fx > 20_000, `${fx}`);
  if (fx != null) {
    const aapl = foreignPriceUnitValueVND({ symbol: "AAPL", market: "US", type: "STOCK" }, 23_120, fx);
    check("AAPL 23.120 cents → 1đv (0,01cp) ≈ 59.960₫", aapl != null && approx(aapl, (23_120 / 100) * fx / 100, 0.01), `${aapl}`);
    const eur = foreignPriceUnitValueVND({ symbol: "EURUSD=X", market: "FOREX", type: "FX" }, 10_852, fx);
    check("EURUSD 1,0852 → ≈28.143₫/đv", eur != null && approx(eur, (10_852 / 10_000) * fx, 0.01), `${eur}`);
    const hk = foreignPriceUnitValueVND({ symbol: "0700.HK", market: "HK", type: "STOCK" }, 30_050, fx);
    check("0700.HK peg 7,8 → ≈9.991₫/đv", hk != null && approx(hk, (30_050 / 100) / 7.8 * fx / 100, 0.01), `${hk}`);
  }
  const vndx = foreignPriceUnitValueVND({ symbol: "VND=X", market: "FOREX", type: "FX" }, 259_340_000, null);
  check("VND=X 25.934₫/USD (không cần fx)", vndx === 25_934, `${vndx}`);
  const gcSeries = await notionalIdxSeries("GC=F");
  check("idx GC=F còn chuỗi duration/spot (≥ 100 điểm)", gcSeries.length >= 100, `${gcSeries.length} điểm`);

  // ── 4. Prompt — vision + THỊ TRƯỜNG QUỐC TẾ THAM CHIẾU + quy tắc Chủ tịch ──
  console.log("\n[4] Prompt:");
  const vision = await buildCouncilVisionBlock();
  check("vision có TÀI KHOẢN HỘI ĐỒNG", vision?.includes("TÀI KHOẢN HỘI ĐỒNG") === true);
  check("vision có THỊ TRƯỜNG ĐA TÀI SẢN (theo dõi 5 nhóm)", vision?.includes("THỊ TRƯỜNG ĐA TÀI SẢN") === true);
  check("vision ghi rõ đầu tư chỉ tại thị trường VN", vision?.includes("chỉ tại thị trường Việt Nam") === true);
  check("vision KHÔNG còn THÍ NGHIỆM PHÂN BỔ", vision?.includes("THÍ NGHIỆM PHÂN BỔ") !== true);
  const intl = await buildIntlReferenceBlock();
  check("khối THỊ TRƯỜNG QUỐC TẾ (THAM CHIẾU)", intl?.includes("THỊ TRƯỜNG QUỐC TẾ (THAM CHIẾU") === true);
  check("khối ghi KHÔNG ĐẦU TƯ", intl?.includes("KHÔNG ĐẦU TƯ") === true);
  check("khối có ≥ 3 nhóm phi-VN (CP MỸ · TRÁI PHIẾU · FOREX · HÀNG HOÁ…)", ["CP MỸ", "TRÁI PHIẾU", "FOREX", "HÀNG HOÁ"].filter((g) => intl?.includes(g)).length >= 3);
  check("khối liệt kê GC=F + US10Y + VND=X (giá tham chiếu)", intl?.includes("GC=F") === true && intl?.includes("US10Y") === true && intl?.includes("VND=X") === true);
  check("khối liệt kê cả USDJPY=X/DXY (toàn bộ tham chiếu)", intl?.includes("USDJPY=X") === true || intl?.includes("DX-Y.NYB") === true);
  check("khối KHÔNG còn chữ VŨ TRỤ GIAO DỊCH", intl?.includes("VŨ TRỤ GIAO DỊCH") !== true);
  const chairman = ROLE_PROMPTS["portfolio-strategist"].system;
  check("prompt Chủ tịch: chỉ chọn mã CP/ETF VIỆT NAM", chairman.includes("chỉ chọn mã CỔ PHIẾU/ETF VIỆT NAM") === true);
  check("prompt Chủ tịch: THỊ TRƯỜNG QUỐC TẾ chỉ THAM CHIẾU", chairman.includes("THỊ TRƯỜNG QUỐC TẾ") === true && chairman.includes("KHÔNG chọn mã ngoài Việt Nam") === true);
  check("prompt Chủ tịch: KHÔNG còn VŨ TRỤ GIAO DỊCH/đa thị trường", chairman.includes("VŨ TRỤ GIAO DỊCH") !== true);

  // ── 5. Cổng chặn lệnh phi-VN (P0 — heart of v2.2) ────────────────────────
  console.log("\n[5] createPaperOrderFromSignal — chặn phi-VN:");
  const sb = await db.brokerAccount.findFirst({ where: { accountType: "sandbox" } });
  const chairmanAgent = await db.agent.findFirst({ where: { code: "portfolio-strategist" } });
  const before = sb ? { cash: Number(sb.cashBalance), equity: Number(sb.equity) } : null;
  if (!sb || !chairmanAgent || !before) {
    console.log("  ⚠ SKIP — thiếu sandbox/agent (bỏ nhóm 5-6)");
  } else {
    const blocked: Array<[string, string]> = [
      ["EURUSD=X", "p108-verify-fx"],
      ["GC=F", "p108-verify-gc"],
    ];
    for (const [sym, rationale] of blocked) {
      const inst = await db.instrument.findFirst({ where: { symbol: sym } });
      if (!inst) {
        check(`tín hiệu ${sym} bị chặn`, false, "không tìm thấy instrument");
        continue;
      }
      const sig = await db.signal.create({
        data: {
          instrumentId: inst.id, direction: "BUY", confidence: "HIGH", score: 70,
          rationale, agentId: chairmanAgent.id, status: "ACTIVE",
          consensusGate: "CONSENSUS", consensusRatio: 0.9,
        },
      });
      const res = await createPaperOrderFromSignal(sig.id, { sizing: "sandbox", world: "sandbox", sizePct: 5 });
      const orderCount = await db.order.count({ where: { signalId: sig.id } });
      check(`${sym} BUY → CHẶN (ok:false + 400 + thông điệp chính sách)`, res.ok === false && res.status === 400 && typeof res.error === "string" && res.error.includes("chính sách") && res.error.includes("ngoài Việt Nam"), JSON.stringify(res).slice(0, 160));
      check(`${sym} — 0 lệnh được tạo`, orderCount === 0, `${orderCount}`);
      await db.signal.delete({ where: { id: sig.id } }).catch(() => {});
    }

    // ── 6. Hồi quy CP VN — lệnh TCB lot-100 như cũ ──────────────────────────
    console.log("\n[6] Hồi quy CP VN (lệnh TCB):");
    const tcb = await db.instrument.findFirst({ where: { symbol: "TCB" } });
    if (!tcb) {
      check("lệnh TCB tạo đúng luật", false, "không tìm thấy TCB");
    } else {
      const quote = await db.quote.findFirst({ where: { instrumentId: tcb.id }, orderBy: { tradedAt: "desc" } });
      const sig = await db.signal.create({
        data: {
          instrumentId: tcb.id, direction: "BUY", confidence: "HIGH", score: 70,
          rationale: "p108-verify-tcb", agentId: chairmanAgent.id, status: "ACTIVE",
          consensusGate: "CONSENSUS", consensusRatio: 0.9,
        },
      });
      const res = await createPaperOrderFromSignal(sig.id, { sizing: "sandbox", world: "sandbox", sizePct: 5 });
      const o = (res as { order?: { id: string; quantity: number; price: number; fee?: bigint } }).order;
      check("TCB BUY → ok:true (lệnh tạo được)", res.ok === true && o != null, JSON.stringify(res).slice(0, 200));
      if (o) {
        check("TCB lot-100 (qty bội 100, ≥ 100)", o.quantity % 100 === 0 && o.quantity >= 100, `${o.quantity}`);
        check("TCB giá bội 100₫ + trong băng ±7%", o.price % 100 === 0 && quote != null && (quote.floorPrice ?? 0) > 0 && (quote.ceilingPrice ?? 0) > 0 && o.price >= (quote.floorPrice ?? 0) * 0.99 && o.price <= (quote.ceilingPrice ?? 0) * 1.01, `price=${o.price} band=${quote?.floorPrice}–${quote?.ceilingPrice}`);
        await db.auditLog.deleteMany({ where: { entityId: o.id } });
        await db.order.deleteMany({ where: { id: o.id } });
      }
      await db.signal.delete({ where: { id: sig.id } }).catch(() => {});
    }
    const after = await db.brokerAccount.findUnique({ where: { id: sb.id } });
    check("sandbox cash KHÔNG đổi sau ca test (hermetic)", after != null && Number(after.cashBalance) === before.cash, `${Number(after?.cashBalance)} vs ${before.cash}`);
  }

  // ── 7. DB sạch chính sách ────────────────────────────────────────────────
  console.log("\n[7] DB sạch:");
  const foreignOpen = await db.position.count({
    where: { status: "OPEN", instrument: { market: { in: FOREIGN_MARKETS } } },
  });
  check("0 vị thế phi-VN mở", foreignOpen === 0, `${foreignOpen}`);
  const foreignPending = await db.order.count({
    where: { status: { in: ["PENDING", "PARTIALLY_FILLED"] }, instrument: { market: { in: FOREIGN_MARKETS } } },
  });
  check("0 lệnh phi-VN chờ khớp", foreignPending === 0, `${foreignPending}`);
  let dropped = false;
  try {
    await db.$queryRaw`SELECT count(*) FROM "AllocationExperiment"`;
  } catch {
    dropped = true;
  }
  check("bảng AllocationExperiment đã drop (giữ từ v2.1)", dropped);

  // ── 8. D-LEDGER idempotent + API hồi quy ────────────────────────────────
  console.log("\n[8] D-LEDGER + API:");
  // P1017 (server closed connection) xảy ra ngẫu nhiên với script dài trên
  // pgbouncer — reconnect + retry 1 lần trước khi kết luận (bài học #107).
  const evalOnce = async () => {
    try {
      return await evaluateDecisions();
    } catch {
      await db.$disconnect().catch(() => {});
      await db.$connect().catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
      return await evaluateDecisions();
    }
  };
  const r1 = await evalOnce();
  const r2 = await evalOnce();
  check("evaluateDecisions idempotent (2 lần cùng kết quả)", r1.evaluated === r2.evaluated && r1.byVerdict.WIN === r2.byVerdict.WIN && r1.byVerdict.LOSS === r2.byVerdict.LOSS, `${r1.evaluated} vs ${r2.evaluated}`);
  const ledger = await (async () => {
    try {
      return await db.decisionEvaluation.findMany({ select: { verdict: true, markPnlPct: true } });
    } catch {
      await db.$disconnect().catch(() => {});
      await db.$connect().catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
      return await db.decisionEvaluation.findMany({ select: { verdict: true, markPnlPct: true } });
    }
  })();
  check("sổ phán quyết còn nguyên (≥ 9 hàng)", ledger.length >= 9, `${ledger.length}`);

  const ov = await api("/api/council/overview?from=2026-10-01&to=2026-10-31");
  check("GET /api/council/overview?from&to → 200", ov.status === 200, `${ov.status}`);
  const ovBad = await api("/api/council/overview?from=2026-13-01");
  check("GET /api/council/overview validate sai → 422", ovBad.status === 422, `${ovBad.status}`);
  const baskets = await api("/api/council/baskets");
  check("GET /api/council/baskets → 200 (thống kê 5 nhóm còn nguyên)", baskets.status === 200, `${baskets.status}`);
  const portfolio = await api("/api/portfolio?accountType=sandbox");
  check("GET /api/portfolio?accountType=sandbox → 200", portfolio.status === 200, `${portfolio.status}`);
  const tickRes = await fetch(`${APP}/api/market/tick`, { method: "POST" });
  const tickBody = (await tickRes.json().catch(() => ({}))) as Record<string, unknown>;
  check("POST /api/market/tick → 200 (không còn nhánh khớp phi-VN)", tickRes.status === 200, `${tickRes.status}`);
  check("tick response KHÔNG còn foreignFills", !("foreignFills" in tickBody), JSON.stringify(tickBody).slice(0, 80));

  // ── Tổng kết ─────────────────────────────────────────────────────────────
  console.log(`\n═══ KẾT QUẢ: ${pass} PASS · ${fail} FAIL ═══`);
  if (failures.length > 0) {
    console.log("FAILURES:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
  await db.$disconnect();
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
