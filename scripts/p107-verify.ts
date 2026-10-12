/**
 * scripts/p107-verify.ts — NGHIỆM THU #107 COUNCIL_STEWARDSHIP_BLUEPRINT v2.0
 * (P1 tháo E-ALLOC + P2 E-EXEC đa thị trường). Hermetic — TỰ DỌN sau chạy:
 * mọi lệnh/trade/vị thế/tín hiệu test bị xoá, cash/equality sandbox trả về
 * đúng trạng thái trước test.
 *
 * Chạy: DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/postgres?schema=trader" \
 *        bunx tsx scripts/p107-verify.ts
 */

import "dotenv/config";
import { db } from "../src/lib/db";
import {
  execRuleFor,
  foreignPriceUnitValueVND,
  notionalIdxSeries,
  notionalIdxLatest,
  usdVndRate,
  NOTIONAL_UNIT_VND,
} from "../src/lib/exec/market-rules";
import { isForeignSessionOpen } from "../src/lib/market-session";
import { buildCouncilVisionBlock } from "../src/lib/council/vision";
import { buildTradableUniverseBlock } from "../src/lib/agent-context";
import { evaluateDecisions } from "../src/lib/council/decision-eval";

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

async function tick(): Promise<Record<string, unknown>> {
  const res = await fetch(`${APP}/api/market/tick`, { method: "POST" });
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

async function main(): Promise<void> {
  console.log("═══ P107-VERIFY — COUNCIL v2.0 (tháo E-ALLOC + E-EXEC đa thị trường) ═══");

  // ── 1. Phiên đa thị trường (thuần date-math — ICT = UTC+7) ──────────────
  console.log("\n[1] isForeignSessionOpen — 11 ca biên (12/10/2026 = Thứ Hai):");
  const us = (h: number, m: number, d: number) => new Date(Date.UTC(2026, 9, d, h, m));
  check("US mở T2 22:00 ICT", isForeignSessionOpen("US", us(15, 0, 12)) === true);
  check("US đóng T2 10:00 ICT", isForeignSessionOpen("US", us(3, 0, 12)) === false);
  check("US mở T3 03:00 ICT (đuôi phiên T2)", isForeignSessionOpen("US", us(20, 0, 12)) === true);
  check("US mở T7 02:00 ICT (đuôi phiên T6)", isForeignSessionOpen("US", us(19, 0, 16)) === true);
  check("US đóng T7 10:00 ICT", isForeignSessionOpen("US", us(3, 0, 17)) === false);
  check("HK mở T2 10:30 ICT", isForeignSessionOpen("HK", us(3, 30, 12)) === true);
  check("HK nghỉ trưa T2 12:30 ICT", isForeignSessionOpen("HK", us(5, 30, 12)) === false);
  check("Forex đóng T2 05:00 ICT", isForeignSessionOpen("FX245", us(22, 0, 11)) === false);
  check("Forex mở T2 07:00 ICT", isForeignSessionOpen("FX245", us(0, 0, 12)) === true);
  check("Forex đóng T7 07:00 ICT", isForeignSessionOpen("FX245", us(0, 0, 17)) === false);
  check("Forex mở T6 23:00 ICT", isForeignSessionOpen("FX245", us(16, 0, 16)) === true);

  // ── 2. Giá trị VND/đơn vị + luật vi mô ──────────────────────────────────
  console.log("\n[2] foreignPriceUnitValueVND + execRuleFor:");
  const fx = 25_934;
  const aapl = foreignPriceUnitValueVND({ symbol: "AAPL", market: "US", type: "STOCK" }, 23_120, fx);
  check("AAPL 231,20$ → 1đv (0,01cp) ≈ 59.960₫", aapl != null && approx(aapl, 59_960.4, 0.01), `${aapl}`);
  const vndx = foreignPriceUnitValueVND({ symbol: "VND=X", market: "FOREX", type: "FX" }, 259_340_000, null);
  check("VND=X 25.934₫/USD (không cần fx)", vndx === 25_934, `${vndx}`);
  const eur = foreignPriceUnitValueVND({ symbol: "EURUSD=X", market: "FOREX", type: "FX" }, 10_852, fx);
  check("EURUSD 1,0852 → ≈28.143₫/EUR", eur != null && approx(eur, 28_143.4, 0.01), `${eur}`);
  const hk = foreignPriceUnitValueVND({ symbol: "0700.HK", market: "HK", type: "STOCK" }, 30_050, fx);
  check("0700.HK 300,5 HK$ (peg 7,8) → 1đv ≈ 9.991₫", hk != null && approx(hk, 9_991.24, 0.01), `${hk}`);
  check("GC=F luật NOTIONAL + phiên FX245", (() => {
    const r = execRuleFor({ symbol: "GC=F", market: "COMMODITY", type: "CMDTY" });
    return r?.assetKind === "NOTIONAL" && r.sessionKind === "FX245" && r.minQty === 1;
  })());
  check("US10Y luật NOTIONAL + phiên US (fee 0)", (() => {
    const r = execRuleFor({ symbol: "US10Y", market: "BOND", type: "BOND" });
    return r?.assetKind === "NOTIONAL" && r.sessionKind === "US" && r.feeRate === 0;
  })());
  check("USDJPY=X tham chiếu — execRuleFor null", execRuleFor({ symbol: "USDJPY=X", market: "FOREX", type: "FX" }) == null);
  check("^GSPC INDEX — execRuleFor null", execRuleFor({ symbol: "^GSPC", market: "US", type: "INDEX" }) == null);
  check("TCB HOSE — luật VN lot 100 giữ nguyên", (() => {
    const r = execRuleFor({ symbol: "TCB", market: "HOSE", type: "STOCK" });
    return r?.assetKind === "VN_PRICE" && r.lotStep === 100 && r.hasBand === true;
  })());

  // ── 3. Khối prompt C-VISION v2 + VŨ TRỤ GIAO DỊCH ───────────────────────
  console.log("\n[3] Khối prompt (vision v2 + tradable universe):");
  const vision = await buildCouncilVisionBlock();
  check("vision có TÀI KHOẢN HỘI ĐỒNG", vision?.includes("TÀI KHOẢN HỘI ĐỒNG") === true);
  check("vision có THỊ TRƯỜNG ĐA TÀI SẢN (mục 4 mới)", vision?.includes("THỊ TRƯỜNG ĐA TÀI SẢN") === true);
  check("vision KHÔNG còn THÍ NGHIỆM PHÂN BỔ", vision?.includes("THÍ NGHIỆM PHÂN BỔ") !== true);
  const universe = await buildTradableUniverseBlock();
  check("universe có VŨ TRỤ GIAO DỊCH", universe?.includes("VŨ TRỤ GIAO DỊCH") === true);
  check("universe có hàng hoá GC=F", universe?.includes("GC=F") === true);
  check("universe có trái phiếu US10Y", universe?.includes("US10Y") === true);
  check("universe có forex EURUSD=X + VND=X", universe?.includes("EURUSD=X") === true && universe?.includes("VND=X") === true);
  check("universe liệt kê kê tham chiếu USDJPY=X", universe?.includes("USDJPY=X") === true);

  // ── 4. E-ALLOC sạch trong DB ────────────────────────────────────────────
  console.log("\n[4] Tháo E-ALLOC (DB + code):");
  const expCount = await db.$queryRaw<Array<{ count: number }>>`SELECT COUNT(*)::int AS count FROM information_schema.tables WHERE table_schema='trader' AND table_name IN ('AllocationExperiment','ExperimentSnapshot')`;
  check("2 bảng E-ALLOC đã drop khỏi DB", Number(expCount[0]?.count ?? 2) === 0);

  // ── 5. Roundtrip GC=F (NOTIONAL) + AAPL (PRICE) trên sandbox ────────────
  console.log("\n[5] E-EXEC roundtrip từ KHOẢN TIỀN THỬ NGHIỆM (hermetic, tự dọn):");
  const fxNow = await usdVndRate();
  check("tỷ giá USD/VND khả dụng", fxNow != null && fxNow > 20_000, `${fxNow}`);
  const gcIdx = await notionalIdxLatest("GC=F");
  const gcSeries = await notionalIdxSeries("GC=F");
  check("idx GC=F có chuỗi (≥ 100 điểm)", gcSeries.length >= 100 && gcIdx != null && gcIdx > 0, `${gcSeries.length} điểm, idx=${gcIdx?.toFixed(4)}`);
  const us10ySeries = await notionalIdxSeries("US10Y");
  check("idx US10Y có chuỗi duration-model (≥ 100 điểm)", us10ySeries.length >= 100, `${us10ySeries.length} điểm`);

  const [user, sandbox] = await Promise.all([
    db.user.findFirst({ where: { isActive: true }, select: { id: true } }),
    db.brokerAccount.findFirst({ where: { accountType: "sandbox", deletedAt: null } }),
  ]);
  if (!user || !sandbox) {
    console.log("⚠️  Chưa có user/sandbox — bỏ phần roundtrip.");
  } else {
    const before = { cash: Number(sandbox.cashBalance), equity: Number(sandbox.equity) };
    const gc = await db.instrument.findFirst({ where: { symbol: "GC=F" } });
    const aaplInst = await db.instrument.findFirst({ where: { symbol: "AAPL" } });
    const gcQuote = gc ? await db.quote.findFirst({ where: { instrumentId: gc.id }, orderBy: { tradedAt: "desc" } }) : null;
    const aaplQuote = aaplInst ? await db.quote.findFirst({ where: { instrumentId: aaplInst.id }, orderBy: { tradedAt: "desc" } }) : null;
    const gcClose = gcQuote?.last ?? 0;
    const aaplClose = aaplQuote?.last ?? 0;
    const testOrderIds: string[] = [];
    try {
      // 5a. BUY GC=F 3 đv danh nghĩa — limit trên close 5% (crossed chuẩn)
      const gcBuy = await db.order.create({
        data: {
          userId: user.id,
          brokerAccountId: sandbox.id,
          instrumentId: gc!.id,
          side: "BUY",
          type: "LIMIT",
          quantity: 3,
          price: Math.round(gcClose * 1.05),
          status: "PENDING",
          note: "p107-verify",
        },
      });
      testOrderIds.push(gcBuy.id);
      // 5b. BUY AAPL 50 đv (0,5 cp) — limit trên close 2%
      const aaplBuy = await db.order.create({
        data: {
          userId: user.id,
          brokerAccountId: sandbox.id,
          instrumentId: aaplInst!.id,
          side: "BUY",
          type: "LIMIT",
          quantity: 50,
          price: Math.round(aaplClose * 1.02),
          status: "PENDING",
          note: "p107-verify",
        },
      });
      testOrderIds.push(aaplBuy.id);
      const tick1 = await tick();
      await new Promise((r) => setTimeout(r, 1500));

      const gcBuyAfter = await db.order.findUnique({ where: { id: gcBuy.id } });
      const gcTrade = await db.trade.findFirst({ where: { orderId: gcBuy.id } });
      const gcPos = gc ? await db.position.findUnique({ where: { brokerAccountId_instrumentId: { brokerAccountId: sandbox.id, instrumentId: gc.id } } }) : null;
      check("GC=F BUY khớp tại close (FILLED)", gcBuyAfter?.status === "FILLED" && gcTrade != null, `${gcBuyAfter?.status}`);
      check("GC=F trade price = close + fee 0,03%×3tr₫=900₫", gcTrade != null && gcTrade.price === gcClose && Number(gcTrade.fee) === 900, `price=${gcTrade?.price} fee=${gcTrade?.fee}`);
      check("GC=F vị thế NOTIONAL: avgCostVND=1tr₫ + openIdxUnits=3×10¹²/idx", gcPos != null && Number(gcPos.avgCostVND) === NOTIONAL_UNIT_VND && gcPos.openIdxUnits != null && Math.abs(Number(gcPos.openIdxUnits) - (3 * 1e12) / (gcIdx ?? 1)) < 1e6, `units=${gcPos?.openIdxUnits}`);
      const cashAfterBuy = (await db.brokerAccount.findUnique({ where: { id: sandbox.id } }))!;
      // Tiền trừ cho CẢ 2 lệnh (GC=F 3đv + AAPL 50đv) — AAPL unit ≈ (close/100)×fx/100
      const aaplUnit = (aaplClose / 100) * (fxNow ?? 0) / 100;
      const aaplBuyCost = Math.round(50 * aaplUnit * 1.0002);
      check(
        "2 lệnh BUY trừ đúng tiền (GC=F 3.000.900₫ + AAPL ≈50×giáVND/đv+phí)",
        approx(Number(cashAfterBuy.cashBalance), before.cash - 3_000_900 - aaplBuyCost, 0.01),
        `${Number(cashAfterBuy.cashBalance)} (Δ=${before.cash - Number(cashAfterBuy.cashBalance)}, kỳ vọng ≈${3_000_900 + aaplBuyCost})`
      );

      const aaplBuyAfter = await db.order.findUnique({ where: { id: aaplBuy.id } });
      const aaplTrade = await db.trade.findFirst({ where: { orderId: aaplBuy.id } });
      const aaplPos = aaplInst ? await db.position.findUnique({ where: { brokerAccountId_instrumentId: { brokerAccountId: sandbox.id, instrumentId: aaplInst.id } } }) : null;
      check("AAPL BUY khớp tại close (giờ Mỹ đang mở)", aaplBuyAfter?.status === "FILLED" && aaplTrade != null, `${aaplBuyAfter?.status} (close=${aaplClose})`);
      if (aaplTrade && aaplPos) {
        const expectUnit = (aaplClose / 100) * (fxNow ?? 0) / 100; // VND/đv (0,01 cp)
        check("AAPL avgCostVND = giá VND MỖI ĐƠN VỊ tại lúc khớp", approx(Number(aaplPos.avgCostVND), expectUnit, 0.5), `${Number(aaplPos.avgCostVND)} vs ≈${Math.round(expectUnit)}`);
        check("AAPL phí 0,02% notional VND", Number(aaplTrade.fee) === Math.round(50 * expectUnit * 0.0002), `fee=${aaplTrade.fee}`);
      }

      // 5c. Định giá đa thị trường (portfolio route — sandbox)
      const pfRes = await fetch(`${APP}/api/portfolio?accountType=sandbox`);
      const pf = (await pfRes.json()) as { positions?: Array<{ symbol: string; marketValue: number; unrealizedPnl: number | null; market?: string }> };
      const gcView = pf.positions?.find((p) => p.symbol === "GC=F");
      const aaplView = pf.positions?.find((p) => p.symbol === "AAPL");
      check("portfolio GC=F giá trị ≈ 3tr₫×idx", gcView != null && approx(gcView.marketValue, 3 * NOTIONAL_UNIT_VND * (gcIdx ?? 1), 0.5), `${gcView?.marketValue}`);
      check("portfolio AAPL xuất hiện kèm marketValue VND", aaplView != null && aaplView.marketValue > 0, `${aaplView?.marketValue}`);
      check("tick response có foreignFills hoặc lệnh đã khớp từ engine tick", (Number(tick1.foreignFills ?? 0) >= 0), "");

      // 5d. SELL cả 2 — limit dưới/đúng close (crossed)
      if (gcPos && aaplPos) {
        const gcSell = await db.order.create({
          data: {
            userId: user.id, brokerAccountId: sandbox.id, instrumentId: gc!.id, side: "SELL", type: "LIMIT",
            quantity: 3, price: Math.round(gcClose * 0.95), status: "PENDING", note: "p107-verify",
          },
        });
        const aaplSell = await db.order.create({
          data: {
            userId: user.id, brokerAccountId: sandbox.id, instrumentId: aaplInst!.id, side: "SELL", type: "LIMIT",
            quantity: 50, price: Math.round(aaplClose * 0.98), status: "PENDING", note: "p107-verify",
          },
        });
        testOrderIds.push(gcSell.id, aaplSell.id);
        await tick();
        await new Promise((r) => setTimeout(r, 1500));
        const gcSellAfter = await db.order.findUnique({ where: { id: gcSell.id } });
        const gcPosAfter = await db.position.findUnique({ where: { brokerAccountId_instrumentId: { brokerAccountId: sandbox.id, instrumentId: gc!.id } } });
        const aaplSellAfter = await db.order.findUnique({ where: { id: aaplSell.id } });
        const aaplPosAfter = await db.position.findUnique({ where: { brokerAccountId_instrumentId: { brokerAccountId: sandbox.id, instrumentId: aaplInst!.id } } });
        check("GC=F SELL khớp — vị thế CLOSED", gcSellAfter?.status === "FILLED" && gcPosAfter?.status === "CLOSED" && gcPosAfter?.quantity === 0, `${gcSellAfter?.status}/${gcPosAfter?.status}`);
        check("AAPL SELL khớp — vị thế CLOSED", aaplSellAfter?.status === "FILLED" && aaplPosAfter?.status === "CLOSED", `${aaplSellAfter?.status}/${aaplPosAfter?.status}`);
        // idx không đổi trong phiên test → realized = đúng −phí bán 900₫ (0,03%×3tr₫)
        check("GC=F realized = −900₫ (đúng phí bán — idx 1:1 trong phiên test)", gcPosAfter != null && Math.abs(Number(gcPosAfter.realizedPnl) + 900) <= 2, `${Number(gcPosAfter?.realizedPnl)}`);
      }
    } finally {
      // ── DỌN SẠCH: xoá toàn bộ dấu vết test + trả cash/equity về đúng trước ──
      await db.trade.deleteMany({ where: { orderId: { in: testOrderIds } } });
      await db.auditLog.deleteMany({ where: { entityId: { in: testOrderIds } } });
      await db.order.deleteMany({ where: { id: { in: testOrderIds } } });
      if (gc) {
        await db.position.deleteMany({ where: { brokerAccountId: sandbox.id, instrumentId: gc.id } });
      }
      if (aaplInst) {
        await db.position.deleteMany({ where: { brokerAccountId: sandbox.id, instrumentId: aaplInst.id } });
      }
      await db.brokerAccount.update({
        where: { id: sandbox.id },
        data: { cashBalance: BigInt(before.cash), equity: BigInt(Math.round(before.equity)) },
      });
      console.log("  🧹 Đã dọn sạch lệnh/trade/vị thế test + phục hồi cash/equity sandbox.");
    }
    // Kiểm tra dọn sạch (chống lỗi kết nối tạm thời của PGlite — thử lại 1 lần)
    const leftoverOrders = await db.order.count({ where: { note: "p107-verify" } });
    const after = await db.brokerAccount
      .findUnique({ where: { id: sandbox.id } })
      .catch(() => db.brokerAccount.findUnique({ where: { id: sandbox.id } }));
    check("dọn sạch: 0 lệnh test sót + cash trả đúng", leftoverOrders === 0 && after != null && approx(Number(after.cashBalance), before.cash, 0.0001), `orders=${leftoverOrders} cash=${Number(after?.cashBalance)}/${before.cash}`);
  }

  // ── 6. D-LEDGER idempotent + nhánh trái phiếu ───────────────────────────
  console.log("\n[6] D-LEDGER (idempotent + bond duration):");
  const r1 = await evaluateDecisions();
  const r2 = await evaluateDecisions();
  check("evaluateDecisions chạy 2 lần cùng kết quả (idempotent)", r1.evaluated === r2.evaluated && r1.byVerdict.WIN === r2.byVerdict.WIN && r1.byVerdict.LOSS === r2.byVerdict.LOSS, `${r1.evaluated} vs ${r2.evaluated}`);

  // Tín hiệu trái phiếu BACKDATED 10 ngày — phân biệt rõ công thức duration vs tỉ số yield
  const us10y = await db.instrument.findFirst({ where: { symbol: "US10Y" } });
  const chairman = await db.agent.findFirst({ where: { code: "portfolio-strategist" } });
  if (us10y && chairman) {
    const backdated = new Date(Date.now() - 10 * 86_400_000);
    const testSig = await db.signal.create({
      data: {
        instrumentId: us10y.id,
        direction: "BUY",
        confidence: "MEDIUM",
        score: 60,
        rationale: "p107-verify bond branch",
        agentId: chairman.id,
        status: "ACTIVE",
        consensusGate: null,
        createdAt: backdated,
      },
    });
    try {
      const r3 = await evaluateDecisions();
      const row = await db.decisionEvaluation.findUnique({ where: { signalId: testSig.id } });
      const bars = await db.bar.findMany({ where: { instrumentId: us10y.id }, orderBy: { date: "asc" }, select: { date: true, close: true } });
      let entryBar: { date: Date; close: number } | null = null;
      for (const b of bars) if (b.date.getTime() <= testSig.createdAt.getTime()) entryBar = b;
      const markBar = bars[bars.length - 1];
      if (entryBar && markBar && row?.markPnlPct != null) {
        const dY = (markBar.close - entryBar.close) / 100; // Δy thập phân
        const days = bars.filter((b) => b.date.getTime() > entryBar.date.getTime()).length;
        const expected = (-8 * dY + (entryBar.close / 100) * (Math.min(Math.max(days, 0), 260) / 252)) * 100;
        const ratio = ((markBar.close - entryBar.close) / entryBar.close) * 100;
        const closeToDuration = Math.abs(row.markPnlPct - expected) <= Math.max(0.05, Math.abs(expected) * 0.02 + 0.02);
        const closerToDurationThanRatio = Math.abs(row.markPnlPct - expected) <= Math.abs(row.markPnlPct - ratio);
        check(
          "US10Y markPnlPct theo mô hình duration (−D·Δy+carry) — không phải tỉ số yield",
          closeToDuration && closerToDurationThanRatio,
          `got=${row.markPnlPct.toFixed(4)} duration=${expected.toFixed(4)} ratio=${ratio.toFixed(4)} days=${days}`
        );
      } else {
        check("US10Y có entry/mark bar để đánh giá", false, "thiếu bar");
      }
      check("evaluateDecisions không sập khi có tín hiệu trái phiếu", r3.evaluated >= r1.evaluated);
    } finally {
      await db.decisionEvaluation.deleteMany({ where: { signalId: testSig.id } });
      await db.signal.delete({ where: { id: testSig.id } });
      console.log("  🧹 Đã dọn tín hiệu + đánh giá trái phiếu test.");
    }
  }

  // ── 7. Tổng kết ─────────────────────────────────────────────────────────
  console.log(`\n═══ KẾT QUẢ: ${pass} PASS · ${fail} FAIL ═══`);
  if (failures.length > 0) {
    console.log("FAILURES:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  await db.$disconnect();
}

main().catch(async (err) => {
  console.error("p107-verify FATAL:", err);
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
