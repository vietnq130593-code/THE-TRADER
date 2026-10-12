/**
 * src/lib/council/decision-eval.ts — SỔ ĐÁNH GIÁ QUYẾT ĐỊNH D-LEDGER
 * (#106 COUNCIL_STEWARDSHIP_BLUEPRINT §3 — bổ sung đúng chỉ đạo trader:
 * "cơ chế đánh giá tổn thất và lợi ích trong các quyết định — nếu có rồi thì
 * thôi, còn thiếu sót thì bổ sung").
 *
 * Cái ĐÃ CÓ giữ nguyên (không đụng): k1 settle-equity (P&L ngày → bandit
 * kênh-2 per-agent), chairman-scorecard (nhãn runtime), research-scorecard
 * (Brier cử tri). Cái THIẦU được bổ sung ở đây: mỗi Signal có 1 hàng
 * DecisionEvaluation PERSISTED, cập nhật hằng ngày (upsert signalId), với
 * HAI LỚP kết quả song song:
 *
 *  (a) DỰ BÁO — mọi tín hiệu (kể cả chưa thực thi): theo hướng, từ close ngày
 *      quyết định → close mới nhất + đỉnh/đáy dọc đường (peak/trough).
 *  (b) THỰC THI — chỉ tín hiệu có lệnh khớp: dòng tiền VND per-signal đối
 *      xứng netRealisedFromTrades của k-sandbox.ts:747 (BUY: −(notional+fee);
 *      SELL: +(notional−fee−tax)); openQty còn lại đánh giá unrealised tại
 *      close mới nhất. Tín hiệu SELL thực thi → đánh giá bằng VWAP bán so với
 *      giá quyết định (chi phí vốn thuộc tín hiệu MUA trước đó — không quy
 *      gộp giả tạo, ghi rõ trong drivers).
 *
 * Phán quyết WIN/LOSS/NEUTRAL ngưỡng ±0,5% — KHỚP ngưỡng bandit #87 (một hệ
 * ngưỡng toàn hệ thống). Idempotent: chạy 2 lần không đổi kết quả. Engine
 * gọi 16:45 ICT t2–t6 (sau k1 settle 16:30); route POST /api/council/evaluate
 * cho phép chạy tay.
 */

import { db } from "@/lib/db";

/** Ngưỡng phán quyết ±0,5% — khớp bandit #87 (một hệ ngưỡng toàn hệ thống). */
export const VERDICT_THRESHOLD_PCT = 0.5;

/** Chỉ đánh giá tín hiệu trong 90 ngày gần nhất (sổ sống, không đào mộ). */
const LOOKBACK_DAYS = 90;

export interface DecisionEvalSummary {
  evaluated: number;
  byVerdict: { WIN: number; LOSS: number; NEUTRAL: number };
  executed: number;
  unexecuted: number;
  durationMs: number;
}

interface SignalWithRefs {
  id: string;
  direction: string;
  agentId: string | null;
  createdAt: Date;
  consensusGate: string | null;
  status: string;
  instrument: { id: string; symbol: string; market: string; type: string };
}

interface BarLite {
  date: Date;
  close: number;
}

function verdictOf(pnlPct: number | null): "WIN" | "LOSS" | "NEUTRAL" {
  if (pnlPct == null || !Number.isFinite(pnlPct)) return "NEUTRAL";
  if (pnlPct >= VERDICT_THRESHOLD_PCT) return "WIN";
  if (pnlPct <= -VERDICT_THRESHOLD_PCT) return "LOSS";
  return "NEUTRAL";
}

/** Chuỗi bar của instrument từ decidedAt đến nay (asc). */
async function barsSince(
  instrumentId: string,
  since: Date
): Promise<BarLite[]> {
  return db.bar.findMany({
    where: { instrumentId, date: { gte: new Date(since.getTime() - 7 * 86_400_000) } },
    select: { date: true, close: true },
    orderBy: { date: "asc" },
  });
}

/**
 * Đánh giá lại TOÀN BỘ tín hiệu trong lookback — upsert DecisionEvaluation
 * theo signalId (idempotent). Trả tóm tắt cho audit + engine.
 */
export async function evaluateDecisions(): Promise<DecisionEvalSummary> {
  const startedAt = Date.now();
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);

  const signals = (await db.signal.findMany({
    where: { createdAt: { gte: cutoff } },
    include: {
      instrument: { select: { id: true, symbol: true, market: true, type: true } },
    },
    orderBy: { createdAt: "desc" },
  })) as SignalWithRefs[];

  const byVerdict = { WIN: 0, LOSS: 0, NEUTRAL: 0 };
  let executed = 0;
  let unexecuted = 0;

  for (const sig of signals) {
    try {
      const bars = await barsSince(sig.instrument.id, sig.createdAt);
      // Entry = close NGÀY QUYẾT ĐỊNH (bar cuối ≤ decidedAt) — PIT đúng
      let entryBar: BarLite | null = null;
      for (const b of bars) {
        if (b.date.getTime() <= sig.createdAt.getTime()) entryBar = b;
      }
      const entry = entryBar?.close ?? null;
      const mark = bars.length > 0 ? bars[bars.length - 1].close : null;

      // ── (a) Kết quả DỰ BÁO theo hướng ──
      let markPnlPct: number | null = null;
      if (entry != null && mark != null && entry > 0) {
        const raw = (mark - entry) / entry;
        markPnlPct = (sig.direction === "SELL" ? -raw : raw) * 100;
      }
      // peak/trough dọc đường (từ sau ngày quyết định)
      let peak: number | null = null;
      let trough: number | null = null;
      if (entry != null && entry > 0) {
        for (const b of bars) {
          if (b.date.getTime() <= sig.createdAt.getTime()) continue;
          const raw = (b.close - entry) / entry;
          const adj = (sig.direction === "SELL" ? -raw : raw) * 100;
          if (peak == null || adj > peak) peak = adj;
          if (trough == null || adj < trough) trough = adj;
        }
      }

      // ── (b) Kết quả THỰC THI — lệnh/trade thuộc signal này ──
      const orders = await db.order.findMany({
        where: { signalId: sig.id },
        include: {
          trades: { select: { side: true, quantity: true, price: true, fee: true, tax: true } },
          brokerAccount: { select: { accountType: true } },
        },
      });
      const trades = orders.flatMap((o) => o.trades);
      let executionKind: string | null = null;
      let cashPnlVND: bigint | null = null;
      let openQty = 0;
      let sellVwapNotional = BigInt(0);
      let sellQty = 0;
      let buyQty = 0;
      let buyCost = BigInt(0); // gồm phí
      let sellProceeds = BigInt(0); // trừ phí + thuế
      const world = orders[0]?.brokerAccount?.accountType === "sandbox" ? "sandbox" : "paper";

      for (const t of trades) {
        const notional = BigInt(t.quantity) * BigInt(t.price);
        if (t.side === "BUY") {
          buyQty += t.quantity;
          buyCost += notional + t.fee;
        } else {
          sellQty += t.quantity;
          sellProceeds += notional - t.fee - t.tax;
          sellVwapNotional += notional;
        }
      }
      if (orders.length === 0 || trades.length === 0) {
        executionKind = "UNEXECUTED";
      } else {
        openQty = Math.max(0, buyQty - sellQty);
        if (sig.direction === "SELL") {
          // SELL thực thi: so VWAP bán với giá quyết định (chi phí vốn thuộc
          // tín hiệu MUA trước — không quy gộp giả tạo, ghi rõ trong drivers)
          executionKind = "EXECUTED_CLOSED";
          if (sellQty > 0 && entry != null && entry > 0) {
            const vwap = Number(sellVwapNotional) / sellQty;
            markPnlPct = ((vwap - entry) / entry) * 100;
          }
          cashPnlVND = null; // trung thực: không gán P&L tiền cho quyết định bán
        } else {
          executionKind = openQty > 0 ? "EXECUTED_OPEN" : "EXECUTED_CLOSED";
          // P&L quy kết = tiền bán thu về + giá trị phần mở (đánh giá mark)
          // − vốn mua (gồm phí) — đối xứng dòng tiền netRealised k-sandbox
          const openValue =
            openQty > 0 && mark != null ? BigInt(Math.round(openQty * mark)) : BigInt(0);
          cashPnlVND = sellProceeds + openValue - buyCost;
        }
      }

      // ── Phán quyết ──
      let verdictPct: number | null = markPnlPct;
      if (
        sig.direction !== "SELL" &&
        executionKind &&
        executionKind !== "UNEXECUTED" &&
        buyQty > 0 &&
        buyCost > BigInt(0)
      ) {
        // P&L tiền quy về % vốn bỏ ra của chính tín hiệu
        verdictPct = (Number(cashPnlVND) / Number(buyCost)) * 100;
      }
      const verdict = verdictOf(verdictPct);

      const drivers = {
        orders: orders.length,
        trades: trades.length,
        buyQty,
        sellQty,
        world: orders.length > 0 ? world : null,
        consensusGate: sig.consensusGate,
        signalStatus: sig.status,
        note:
          sig.direction === "SELL" && executionKind?.startsWith("EXECUTED")
            ? "SELL: đánh giá VWAP bán vs giá quyết định — chi phí vốn thuộc tín hiệu MUA trước đó"
            : null,
      };

      await db.decisionEvaluation.upsert({
        where: { signalId: sig.id },
        create: {
          signalId: sig.id,
          instrumentId: sig.instrument.id,
          direction: sig.direction,
          decidedAt: sig.createdAt,
          agentId: sig.agentId,
          entryPrice: entry,
          markPrice: mark,
          markPnlPct,
          peakPnlPct: peak,
          troughPnlPct: trough,
          executionKind,
          cashPnlVND: sig.direction === "SELL" ? null : cashPnlVND,
          openQty: sig.direction === "SELL" ? null : Math.max(0, openQty),
          world: orders.length > 0 ? world : null,
          verdict,
          driversJson: JSON.stringify(drivers),
          evaluatedAt: new Date(),
        },
        update: {
          entryPrice: entry,
          markPrice: mark,
          markPnlPct,
          peakPnlPct: peak,
          troughPnlPct: trough,
          executionKind,
          cashPnlVND: sig.direction === "SELL" ? null : cashPnlVND,
          openQty: sig.direction === "SELL" ? null : Math.max(0, openQty),
          world: orders.length > 0 ? world : null,
          verdict,
          driversJson: JSON.stringify(drivers),
          evaluatedAt: new Date(),
        },
      });

      byVerdict[verdict]++;
      if (executionKind === "UNEXECUTED") unexecuted++;
      else executed++;
    } catch (err) {
      // 1 tín hiệu lỗi không làm hỏng cả lượt — trung thực ghi log
      console.error(
        `[council/decision-eval] signal ${sig.id} (${sig.instrument.symbol}) lỗi:`,
        err
      );
    }
  }

  return {
    evaluated: signals.length,
    byVerdict,
    executed,
    unexecuted,
    durationMs: Date.now() - startedAt,
  };
}

// ─────────────────────────────────────────────────────────────────
// Sổ đọc API (GET /api/council/overview) — có lọc khoảng from/to ngày ICT
// ─────────────────────────────────────────────────────────────────

export interface DecisionLedgerRow {
  id: string;
  signalId: string;
  symbol: string;
  direction: string;
  decidedAt: string;
  agentName: string | null;
  verdict: string;
  markPnlPct: number | null;
  peakPnlPct: number | null;
  troughPnlPct: number | null;
  cashPnlVND: string | null; // BigInt → chuỗi cho JSON
  openQty: number | null;
  executionKind: string | null;
  world: string | null;
  evaluatedAt: string;
}

export interface DecisionLedgerStats {
  total: number;
  WIN: number;
  LOSS: number;
  NEUTRAL: number;
  winRate: number | null; // WIN / (WIN+LOSS)
  executed: number;
  totalCashPnlVND: string; // cộng các dòng có cashPnl (BUY thực thi)
}

export async function getDecisionLedger(
  from?: Date,
  to?: Date,
  limit = 60
): Promise<{ rows: DecisionLedgerRow[]; stats: DecisionLedgerStats }> {
  const where = {
    decidedAt: {
      ...(from ? { gte: from } : {}),
      ...(to ? { lte: to } : {}),
    },
  };
  const [evals, agentById] = await Promise.all([
    db.decisionEvaluation.findMany({
      where,
      orderBy: { decidedAt: "desc" },
      take: limit,
      include: {
        signal: { include: { instrument: { select: { symbol: true } } } },
      },
    }),
    db.agent.findMany({ select: { id: true, name: true } }),
  ]);
  const nameOf = new Map(agentById.map((a) => [a.id, a.name]));
  const rows: DecisionLedgerRow[] = evals.map((e) => ({
    id: e.id,
    signalId: e.signalId,
    symbol: e.signal?.instrument?.symbol ?? "—",
    direction: e.direction,
    decidedAt: e.decidedAt.toISOString(),
    agentName: e.agentId ? nameOf.get(e.agentId) ?? null : null,
    verdict: e.verdict,
    markPnlPct: e.markPnlPct,
    peakPnlPct: e.peakPnlPct,
    troughPnlPct: e.troughPnlPct,
    cashPnlVND: e.cashPnlVND != null ? e.cashPnlVND.toString() : null,
    openQty: e.openQty,
    executionKind: e.executionKind,
    world: e.world,
    evaluatedAt: e.evaluatedAt.toISOString(),
  }));
  const all = await db.decisionEvaluation.findMany({ where, select: { verdict: true, cashPnlVND: true, executionKind: true } });
  const WIN = all.filter((e) => e.verdict === "WIN").length;
  const LOSS = all.filter((e) => e.verdict === "LOSS").length;
  const NEUTRAL = all.filter((e) => e.verdict === "NEUTRAL").length;
  const totalCash = all.reduce(
    (acc, e) => acc + (e.cashPnlVND ?? BigInt(0)),
    BigInt(0)
  );
  return {
    rows,
    stats: {
      total: all.length,
      WIN,
      LOSS,
      NEUTRAL,
      winRate: WIN + LOSS > 0 ? WIN / (WIN + LOSS) : null,
      executed: all.filter((e) => e.executionKind && e.executionKind !== "UNEXECUTED").length,
      totalCashPnlVND: totalCash.toString(),
    },
  };
}
