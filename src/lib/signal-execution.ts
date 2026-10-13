import { db } from "@/lib/db";
import { getTradingMode, liveTradingGate } from "@/lib/trading-mode";
import { markSource } from "@/lib/sources";
import { getConsensusSetting } from "@/lib/consensus";
// E-P0-1 (REV-2 review #69): literal 0.0015 tại đây là nguồn phí thứ 3/3 —
// chuyển về nguồn đơn src/lib/exec/constants.ts (guard đơn vị percent↔fraction).
// Fixbug #71 F-701-01: POSITION_SIZE_PCT cũng về nguồn đơn (trước đây còn bản
// địa 0.05 tại đây — sizing thật dùng bản địa còn committed view (E-P0-4) dùng
// bản exec/constants → đổi 1 chỗ sẽ lệch ước tính cam kết im lặng).
// Fixbug #73 F-73A-01: TWAP_ADTV_TRIGGER_PCT về nguồn đơn — không còn literal `1`
// ở block return twap (§3.3 tinh thần E-P0-1: 1 sự thật N nguồn là bug).
import { FEE_RATE, POSITION_SIZE_PCT, TWAP_ADTV_TRIGGER_PCT } from "@/lib/exec/constants";
// E-P0-2 (EXECUTION_OPS_BLUEPRINT v1.1): sinh ExecutionPlan khi APPROVE/convert.
// E-P1-2 (v1.2): plan TWAP con cho lệnh lớn > 1% ADTV-20 phiên.
import {
  buildExecutionPlan,
  buildTwapChildPlan,
  planToNote,
  describeExecutionPlan,
  type PlanTwapMeta,
  type ExecutionPlan,
  type SinglePlanReason, // F-73A-13: lý do đi SINGLE cho rationale plan
} from "@/lib/exec/plan";
import {
  adtv20For,
  decideTwap,
  notionalPctAdtv,
  shouldTwap,
  type TwapSliceDraft,
} from "@/lib/exec/twap";
// #107/#108 E-EXEC (COUNCIL_STEWARDSHIP_BLUEPRINT v2.2 §5): vũ trụ giao dịch
// sandbox CHỈ còn CP/ETF VN (chính sách trader #108 — ngoài VN chỉ tham chiếu);
// equity đa thị trường qua markPositionsVND (xử lý cả vị thế lịch sử phi-VN
// nếu còn sót — hiện 0).
import { execRuleFor, markPositionsVND } from "@/lib/exec/market-rules";

/**
 * MỘT NGUỒN DUY NHẤT cho toán tạo lệnh giấy từ tín hiệu
 * (PHASE3_BLUEPRINT §4.5) — dùng chung bởi:
 *   - POST /api/signals/[id]/convert   (sizing "budget50m")
 *   - POST /api/signals/[id]/decision  (sizing "nav5pct" — phê duyệt trader)
 *
 * Toàn bộ logic trích từ convert route: guard vòng đời tín hiệu, gate LIVE,
 * clamp dải trần/sàn + bội 100 (F-202), phí 0,15% (F-201), audit ORDER_CREATED.
 */

/** Round down to board lot of 100 shares (HOSE). */
function roundLot(qty: number): number {
  return Math.max(0, Math.floor(qty / 100) * 100);
}

function round100(v: number): number {
  return Math.max(0, Math.round(v / 100) * 100);
}

/** Thông điệp 409 theo trạng thái vòng đời tín hiệu (§4.1: ACTIVE|ACTED|REJECTED|EXPIRED). */
export function signalStatusConflictMessage(status: string): string {
  switch (status) {
    case "ACTED":
      return "Tín hiệu này đã được chuyển thành lệnh trước đó.";
    case "REJECTED":
      return "Tín hiệu này đã bị từ chối trước đó.";
    case "EXPIRED":
      return "Tín hiệu đã hết hạn.";
    default:
      return "Tín hiệu không ở trạng thái cho phép tạo lệnh.";
  }
}

/**
 * Sweep tín hiệu quá hạn (fix P1 AUD-CODE #1): ACTIVE + expiresAt < now → EXPIRED.
 * Không có sweep thì tín hiệu chết vẫn hiện "đang mở" trong prompt Chủ tịch,
 * notification-officer đếm sai, và trader vẫn phê duyệt được lệnh từ tín hiệu cũ.
 * Idempotent — gọi ở đầu GET /api/signals, chu kỳ agents/run và trước khi tạo lệnh.
 */
export async function expireDueSignals(): Promise<number> {
  try {
    const res = await db.signal.updateMany({
      where: { status: "ACTIVE", expiresAt: { lt: new Date() } },
      data: { status: "EXPIRED" },
    });
    return res.count;
  } catch {
    return 0; // không chặn luồng chính vì sweep phụ
  }
}

/** Signal kèm quan hệ cần thiết để map SignalRow (src/lib/types.ts). */
export interface SignalWithRefs {
  id: string;
  instrument: { symbol: string; name: string };
  agent: { code: string; name: string } | null;
  direction: string;
  confidence: string;
  score: number;
  rationale: string;
  targetPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  actedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  status: string;
  rejectedAt: Date | null;
  rejectNote: string | null;
  /** #110 M4.2 — chip đồng thuận CONSENSUS/WEAK_MAJORITY/NO_CONSENSUS. */
  consensusGate: string | null;
  consensusRatio: number | null;
}

/** Map SignalRow (đủ 15 trường cũ + 3 trường mới PHASE3 §4.1) — dùng chung 3 route signals. */
export function mapSignalRow(s: SignalWithRefs) {
  return {
    id: s.id,
    symbol: s.instrument.symbol,
    name: s.instrument.name,
    direction: s.direction as "BUY" | "SELL" | "HOLD",
    confidence: s.confidence,
    score: s.score,
    rationale: s.rationale,
    targetPrice: s.targetPrice,
    stopLoss: s.stopLoss,
    takeProfit: s.takeProfit,
    agentName: s.agent?.name ?? null,
    agentCode: s.agent?.code ?? null,
    actedAt: s.actedAt,
    expiresAt: s.expiresAt,
    createdAt: s.createdAt,
    status: s.status,
    rejectedAt: s.rejectedAt,
    rejectNote: s.rejectNote,
    consensusGate: s.consensusGate ?? null,
    consensusRatio: s.consensusRatio ?? null,
  };
}

export interface CreatedPaperOrder {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  type: string;
  quantity: number;
  price: number | null;
  status: string;
  createdAt: string;
  /** E-P1-2: mô tả sub-plan của Order con (TWAP) hoặc plan SINGLE. */
  plan?: string;
}

export type PaperOrderResult =
  | {
      ok: true;
      order: CreatedPaperOrder;
      /** E-P1-2: đầy đủ mọi Order con (TWAP tách lát) — [order] khi SINGLE. */
      orders: CreatedPaperOrder[];
      /** E-P1-2: null khi SINGLE; mô tả quyết định tách khi TWAP. */
      twap: {
        style: "TWAP";
        sliceCount: number;
        totalQuantity: number;
        adtvVnd: number;
        notionalPctAdtv: number;
        triggerPct: number;
      } | null;
    }
  | { ok: false; status: number; error: string };

// POSITION_SIZE_PCT (5% NAV) — nguồn đơn src/lib/exec/constants.ts (E-P0-4
// cùng nguồn cho sizing thật lẫn ước tính committed view — fixbug #71 F-701-01).

export interface CreatePaperOrderOpts {
  sizing: "budget50m" | "nav5pct" | "sandbox";
  /**
   * K1 (#87 — AUTONOMY_BLUEPRINT v1.1 §5.3): thế giới đích của lệnh.
   *   - "paper" (mặc định): tài khoản giấy của trader — toàn bộ hành vi cũ
   *     bảo toàn (claim Signal → ACTED, F-207 toàn sổ, audit ORDER_CREATED).
   *   - "sandbox": tài khoản thử nghiệm K1 — KHÔNG đổi Signal.status (2 thế
   *     giới độc lập §8-Q1), F-207 chỉ tính lệnh trên CHÍNH tài khoản sandbox,
   *     kèm marker idempotent K1_SANDBOX_AUTO_ORDER trong cùng transaction.
   */
  world?: "paper" | "sandbox";
  /** K1: % NAV mỗi lệnh của sandbox (PERCENT 1..100 — từ AppSetting k-sandbox.sizePct). */
  sizePct?: number;
}

/**
 * Tạo lệnh giấy LIMIT PENDING từ tín hiệu BUY/SELL.
 *
 * opts.sizing:
 *  - "budget50m": BUY ~50tr VND / SELL nửa vị thế (hành vi convert route hiện tại);
 *  - "nav5pct"  : floor((equity×5%)/lastPrice) → lot 100 min 100 (hành vi run route);
 *  - "sandbox"  : K1 §5.3 — floor((equity sandbox×sizePct%)/lastPrice) → lot 100,
 *     clamp dải + phí 0,15% + TWAP E-P1-2 như paper (không ưu đãi — học phải
 *     gặp phí thật, §5.3 guard an toàn).
 */
export async function createPaperOrderFromSignal(
  signalId: string,
  opts: CreatePaperOrderOpts
): Promise<PaperOrderResult> {
  const signal = await db.signal.findUnique({
    where: { id: signalId },
    include: {
      instrument: {
        select: {
          id: true,
          symbol: true,
          market: true,
          type: true,
          currency: true,
          quotes: {
            orderBy: { tradedAt: "desc" },
            take: 1,
            select: { last: true, floorPrice: true, ceilingPrice: true },
          },
        },
      },
      agent: { select: { code: true, name: true } },
    },
  });

  if (!signal) {
    return { ok: false, status: 404, error: "Không tìm thấy tín hiệu." };
  }

  // P1 AUD-CODE #1: sweep tín hiệu hết hạn NGAY TRƯỚC khi đọc trạng thái —
  // không cho phê duyệt lệnh từ tín hiệu đã chết giữa chừng
  await expireDueSignals();
  if (signal.status === "ACTIVE" && signal.expiresAt && signal.expiresAt < new Date()) {
    signal.status = "EXPIRED";
  }

  // Guard vòng đời (PHASE3 §4.1): chỉ tín hiệu ACTIVE mới được tạo lệnh.
  // K1 sandbox: giữ nguyên guard ACTIVE (auto-convert chạy CUỐI chu kỳ — tín
  // hiệu vừa sinh luôn ACTIVE; hiếm khi trader duyệt nhanh hơn 1 chu kỳ thì
  // sandbox bỏ lượt đó — 2 thế giới độc lập nhưng tín hiệu đã duyệt paper
  // không cần thêm lệnh sandbox trùng).
  if (signal.status !== "ACTIVE") {
    return {
      ok: false,
      status: 409,
      error:
        signalStatusConflictMessage(signal.status) ??
        "Tín hiệu không ở trạng thái cho phép tạo lệnh.",
    };
  }
  if (opts.world !== "sandbox" && signal.actedAt) {
    // Giữ guard cũ của convert (khi status thiếu nhưng actedAt đã set).
    // K1 sandbox KHÔNG bị guard này chặn: actedAt là dấu ấn của THẾ GIỚI PAPER
    // (trader duyệt lệnh giấy) — không được cản đường sandbox (§5.3 2 thế giới).
    return {
      ok: false,
      status: 409,
      error: "Tín hiệu này đã được chuyển thành lệnh trước đó.",
    };
  }

  // B9 — CỔNG ĐỒNG THUẬN 80% (§3.5 MARKET_EXPANSION_BLUEPRINT): chặn convert
  // khi gate (snapshot lúc SINH tín hiệu) ≠ ĐỒNG THUẬN và enforcement đang BẬT
  // (AppSetting consensus.enforce). Gate bind theo assessment tạo ra tín hiệu —
  // KHÔNG đánh giá lại bằng consensus mới hơn. VETO vẫn tối thượng (guard riêng).
  {
    const setting = await getConsensusSetting();
    if (
      setting.enforce &&
      signal.consensusGate != null &&
      signal.consensusGate !== "CONSENSUS" &&
      signal.direction !== "HOLD"
    ) {
      return {
        ok: false,
        status: 409,
        error: `Tín hiệu bị CỔNG ĐỒNG THUẬN chặn (${signal.consensusGate === "WEAK_MAJORITY" ? "đa số yếu" : "không đồng thuận"} — tỉ lệ trọng số số đông ${signal.consensusRatio != null ? `${(signal.consensusRatio * 100).toFixed(1).replace(".", ",")}%` : "?"} < 80%). Tín hiệu sinh ra khi hội đồng chưa đạt đồng thuận 80% → giữ GIỮ, không tạo lệnh.`,
      };
    }
  }
  // F-207 (audit 19-b): tín hiệu đã có lệnh trong sổ (dù actedAt thiếu) → chặn tạo trùng.
  // K1 (#87 §5.3): thế giới sandbox chỉ bị chặn bởi lệnh TRÊN CHÍNH tài khoản
  // sandbox — lệnh paper của trader từ cùng tín hiệu KHÔNG cản đường sandbox.
  // Account fetch trước để có id scope (world-scoped — P0 quarantine §5.1:
  // đường paper loại trừ sandbox, đường sandbox chỉ chọn sandbox).
  const world: "paper" | "sandbox" = opts.world ?? "paper";
  const [user, account] = await Promise.all([
    db.user.findFirst({ where: { isActive: true }, select: { id: true } }),
    db.brokerAccount.findFirst({
      where:
        world === "sandbox"
          ? { accountType: "sandbox", deletedAt: null }
          : { deletedAt: null, accountType: { not: "sandbox" } },
      select: { id: true, cashBalance: true },
    }),
  ]);
  if (!user) {
    return {
      ok: false,
      status: 404,
      error: "Không tìm thấy người dùng hoặc tài khoản môi giới.",
    };
  }
  if (!account) {
    return {
      ok: false,
      status: world === "sandbox" ? 409 : 404,
      error:
        world === "sandbox"
          ? "Chưa kích hoạt tài khoản thử nghiệm (K1) — vào Cài đặt → Cơ chế thử nghiệm để kích hoạt."
          : "Không tìm thấy tài khoản môi giới.",
    };
  }
  const existingOrder = await db.order.findFirst({
    where:
      world === "sandbox"
        ? { signalId: signal.id, brokerAccountId: account.id }
        : { signalId: signal.id },
    select: { id: true, status: true },
  });
  if (existingOrder) {
    return {
      ok: false,
      status: 409,
      error: "Tín hiệu này đã có lệnh liên quan trong sổ lệnh.",
    };
  }
  if (signal.direction === "HOLD") {
    return { ok: false, status: 400, error: "Tín hiệu GIỮ KHÔNG thể chuyển thành lệnh." };
  }

  // ── S3: cổng giao dịch thật (LIVE_TRADING flag — DATA_SOURCES.md §4.1) ──
  // Paper mode (mặc định): tiếp tục tạo lệnh giấy nội bộ bên dưới.
  // Live mode chưa cấu hình đủ: từ chối + audit, không tự ý gửi lệnh thật.
  const gate = liveTradingGate();
  if (gate.mode === "live-unconfigured") {
    const user = await db.user.findFirst({
      where: { isActive: true },
      select: { id: true },
    });
    await db.auditLog.create({
      data: {
        userId: user?.id ?? null,
        action: "LIVE_TRADING_BLOCKED",
        entity: "Signal",
        entityId: signal.id,
        after: JSON.stringify({ symbol: signal.instrument.symbol, reason: gate.error }),
      },
    });
    return { ok: false, status: 503, error: gate.error };
  }
  if (gate.mode === "live") {
    // Đường gửi lệnh thật cần gateway VNDIRECT mini-service (roadmap §8) —
    // hiện chặn với thông báo rõ ràng + audit để không có side-effect mù.
    await db.auditLog.create({
      data: {
        action: "LIVE_ORDER_GATEWAY_UNAVAILABLE",
        entity: "Signal",
        entityId: signal.id,
        after: JSON.stringify({ symbol: signal.instrument.symbol, side: signal.direction }),
      },
    });
    return {
      ok: false,
      status: 501,
      error: "Gateway VNDIRECT chưa kết nối trong môi trường này — lệnh thật tạm bị chặn (audit đã ghi).",
    };
  }

  const side = signal.direction; // BUY | SELL
  const quote = signal.instrument.quotes[0];
  const lastPrice = quote?.last ?? 0;
  const symbol = signal.instrument.symbol;

  // ── #108 E-EXEC v2.2: cổng chính sách VN-only ──────────────────────────
  // Chỉ CP/ETF VN (HOSE/HNX/UPCOM, trừ INDEX) đặt lệnh được. Mọi instrument
  // ngoài VN (cp Mỹ/HK · trái phiếu · forex · hàng hoá) → execRuleFor null →
  // chặn với thông điệp chính sách — không tạo lệnh treo vĩnh viễn.
  const execRule = execRuleFor(signal.instrument);
  if (!execRule) {
    const isForeignMkt =
      signal.instrument.market !== "HOSE" &&
      signal.instrument.market !== "HNX" &&
      signal.instrument.market !== "UPCOM";
    return {
      ok: false,
      status: 400,
      error: isForeignMkt
        ? `Mã ${symbol} thuộc thị trường ngoài Việt Nam (${signal.instrument.market}) — chính sách Hội đồng chỉ đầu tư tại thị trường VN (ngoài VN chỉ theo dõi tham chiếu), không thể tạo lệnh.`
        : `Mã ${symbol} là chỉ số tham chiếu (INDEX) — không thể tạo lệnh.`,
    };
  }

  let quantity: number;
  let price: number;
  let note: string;

  if (opts.sizing === "budget50m") {
    // ── Sizing convert route: BUY ~50tr VND / SELL nửa vị thế ────────
    const rawPrice = signal.targetPrice ?? quote?.last ?? 0;
    if (rawPrice <= 0) {
      return { ok: false, status: 400, error: "Không xác định được giá đặt cho lệnh." };
    }
    // F-202 (audit 19-b): giá lệnh luôn nằm trong dải trần/sàn ±7% (Q2), bội 100 ₫
    const bandLow = quote?.floorPrice ?? round100(rawPrice * 0.93);
    const bandHigh = quote?.ceilingPrice ?? round100(rawPrice * 1.07);
    price = Math.max(bandLow, Math.min(round100(rawPrice), bandHigh));

    if (side === "BUY") {
      quantity = roundLot(50_000_000 / price);
    } else {
      const position = await db.position.findFirst({
        where: {
          brokerAccountId: account.id,
          instrumentId: signal.instrument.id,
          status: "OPEN",
        },
        select: { quantity: true },
      });
      if (!position || position.quantity < 100) {
        return {
          ok: false,
          status: 400,
          error: "Không có vị thế phù hợp để đặt lệnh BÁN.",
        };
      }
      quantity = Math.max(100, roundLot(position.quantity / 2));
    }
    if (quantity < 100) {
      return {
        ok: false,
        status: 400,
        error: "Khối lượng tính toán nhỏ hơn 1 lot (100 cổ phiếu).",
      };
    }
    note = `Từ tín hiệu ${side === "BUY" ? "MUA" : "BÁN"} ${symbol}${
      signal.agent ? ` (agent ${signal.agent.name})` : ""
    }`;
  } else {
    // ── Sizing nav5pct (đúng run route) / sandbox (K1 §5.3 — % NAV sandbox) ──
    // K1: sizeFraction lấy từ opts.sizePct (AppSetting k-sandbox.sizePct —
    // caller truyền vào, không import k-sandbox để tránh vòng import);
    // fallback 5% = cùng mặc định POSITION_SIZE_PCT (an toàn khi caller thiếu).
    if (lastPrice <= 0) {
      return { ok: false, status: 400, error: "Không xác định được giá đặt cho lệnh." };
    }
    const sizeFraction =
      opts.sizing === "sandbox"
        ? (typeof opts.sizePct === "number" && opts.sizePct > 0 && opts.sizePct <= 100
            ? opts.sizePct
            : 5) / 100
        : POSITION_SIZE_PCT;
    // F-102 + #107 E-EXEC: equity = cash + GTTH vị thế mở (markPositionsVND —
    // VN theo giá quote như cũ; vị thế lịch sử phi-VN nếu còn quy VND trung thực).
    const positions = await db.position.findMany({
      where: { brokerAccountId: account.id, status: "OPEN" },
      include: {
        instrument: {
          select: {
            id: true,
            symbol: true,
            market: true,
            type: true,
            currency: true,
            quotes: { orderBy: { tradedAt: "desc" }, take: 1, select: { last: true } },
          },
        },
      },
    });
    const { mv: positionsMv } = await markPositionsVND(
      positions.map((p) => ({
        quantity: p.quantity,
        avgPrice: p.avgPrice,
        avgCostVND: p.avgCostVND,
        openIdxUnits: p.openIdxUnits,
        instrument: p.instrument,
        lastNative: p.instrument.quotes[0]?.last ?? p.avgPrice, // fallback trung thực như portfolio
      }))
    ).catch(() => ({ mv: 0, upl: 0 }));
    const equity = Number(account.cashBalance) + positionsMv;
    if (equity <= 0) {
      return {
        ok: false,
        status: 400,
        error: "Không xác định được giá trị tài sản để định cỡ lệnh.",
      };
    }
    const rawQty = Math.floor((equity * sizeFraction) / lastPrice);
    quantity = Math.max(100, Math.floor(rawQty / 100) * 100);

    // P3-fix (Task 27 E2E): SELL nav5pct phải có vị thế mở — nếu không,
    // fill engine sẽ auto-REJECT INSUFFICIENT_POSITION (F-303) mỗi tick.
    // Chặn sớm với thông điệp rõ ràng thay vì tạo lệnh không thể khớp.
    if (side === "SELL") {
      const held = positions.find((p) => p.instrumentId === signal.instrumentId);
      if (!held || held.quantity < 100) {
        return {
          ok: false,
          status: 400,
          error: `Không có vị thế ${symbol} để đặt lệnh BÁN — hãy chờ tín hiệu MUA hoặc chọn mã đang nắm giữ.`,
        };
      }
      // Cap khối lượng theo vị thế đang giữ (không bán nhiều hơn mức nắm giữ)
      quantity = Math.min(quantity, Math.floor(held.quantity / 100) * 100);
      if (quantity < 100) {
        return {
          ok: false,
          status: 400,
          error: "Vị thế hiện có nhỏ hơn 1 lot (100 cổ phiếu).",
        };
      }
    }

    // F-202 (audit 19-b): giá lệnh luôn nằm trong dải trần/sàn ±7% (Q2) + bội 100 ₫
    const bandLow = quote?.floorPrice ?? round100(lastPrice * 0.93);
    const bandHigh = quote?.ceilingPrice ?? round100(lastPrice * 1.07);
    const basePrice =
      signal.targetPrice && signal.targetPrice > 0
        ? side === "BUY"
          ? Math.min(signal.targetPrice, round100(lastPrice * 1.01))
          : Math.max(signal.targetPrice, round100(lastPrice * 0.99))
        : round100(lastPrice);
    price = Math.max(bandLow, Math.min(basePrice, bandHigh));

    note =
      opts.sizing === "sandbox"
        ? `K1 tự động thực thi từ tín hiệu ${side === "BUY" ? "MUA" : "BÁN"} ${symbol}${
            signal.agent ? ` (agent ${signal.agent.name})` : ""
          }`
        : `Từ phê duyệt tín hiệu ${side === "BUY" ? "MUA" : "BÁN"} ${symbol}${
            signal.agent ? ` (agent ${signal.agent.name})` : ""
          }`;
  }

  // ── E-P1-2 (v1.2): quyết định tách TWAP cho lệnh lớn ────────────────────
  // Notional lệnh > 1% ADTV-20 phiên → tách sliceCount Order con (mỗi con 1
  // plan con TWAP rải afterTick). Dưới ngưỡng / không đủ lot/lát → SINGLE cũ.
  // ADTV đọc Bar EOD (không cache — gọi 1 lần mỗi APPROVE, tần suất thấp).
  // #108 v2.2: sandbox chỉ còn CP VN → mọi lệnh xét TWAP luật HOSE như cũ.
  let twapSlices: TwapSliceDraft[] | null = null;
  let twapAdtv = 0;
  let singleReason: SinglePlanReason = "under-threshold"; // F-73A-13
  try {
    const { adtvVnd } = await adtv20For(signal.instrument.id);
    twapAdtv = adtvVnd;
    twapSlices = decideTwap({ quantity, price, adtvVnd });
  } catch (twapErr) {
    // Fail-soft §6.6: lỗi đo ADTV → đi đường SINGLE an toàn (không chặn duyệt).
    singleReason = "adtv-unavailable";
    console.error("[signal-execution:twap-adtv]", twapErr);
  }
  // F-73A-13 (fixbug #73): phân biệt lý do THẬT đi SINGLE (ADTV thiếu / dưới
  // ngưỡng / không đủ lot-lát) — rationale plan không còn nói sai nguyên nhân.
  if (twapSlices == null) {
    if (twapAdtv <= 0) singleReason = "adtv-unavailable";
    else if (!shouldTwap(quantity * price, twapAdtv)) singleReason = "under-threshold";
    else singleReason = "insufficient-lots";
  }
  const twapNotionalPct = notionalPctAdtv(quantity * price, twapAdtv);
  const twapMeta: PlanTwapMeta | null = twapSlices
    ? {
        totalSlices: twapSlices.length,
        signalId: signal.id,
        notionalPctAdtv: twapNotionalPct,
        adtvVnd: twapAdtv,
      }
    : null;

  // ── AUD-CODE #2 (TOCTOU): claim + tạo lệnh trong MỘT transaction ──
  // Trước đây check existingOrder → create Order → update Signal nằm ngoài tx:
  // 2 request APPROVE đồng thời đều vượt check → 2 lệnh, trừ tiền mặt 2 lần.
  // Claim atomic: updateMany có điều kiện status=ACTIVE && actedAt=null — chỉ
  // MỘT request thắng; request thua nhận 409 đúng nghĩa "đã chuyển lệnh".
  // E-P1-2: TWAP sinh NHIỀU Order con trong CÙNG transaction này — mọi con
  // thuộc 1 phê duyệt (atomic toàn phần: hoặc đủ N con hoặc 0).
  const children = twapSlices ?? [
    { seq: 1, quantity, afterTick: 0 } satisfies TwapSliceDraft,
  ];
  const feeBigInts = children.map(
    (c) => BigInt(Math.round(FEE_RATE * price * c.quantity)) // F-201: phí 0,15% notional — E-P0-1 đơn nguồn
  );
  let createdOrders: Awaited<ReturnType<typeof db.order.create>>[] = [];
  let plans: (ExecutionPlan | null)[] = [];
  try {
    const txOut = await db.$transaction(async (tx) => {
      if (world === "sandbox") {
        // K1 (#87 §5.3): sandbox KHÔNG claim Signal (2 thế giới độc lập —
        // Signal.status giữ "chờ trader duyệt paper" nguyên vẹn). Chống trùng
        // bằng F-207 SCOPE CHÍNH tài khoản sandbox + marker audit trong tx.
        const existingSandbox = await tx.order.findFirst({
          where: { signalId: signal.id, brokerAccountId: account.id },
          select: { id: true },
        });
        if (existingSandbox) {
          throw new Error("SANDBOX_SIGNAL_HAS_ORDER");
        }
      } else {
        // Claim duy quyền chuyển tín hiệu sang ACTED (paper — nguyên vẹn)
        const claimed = await tx.signal.updateMany({
          where: { id: signal.id, status: "ACTIVE", actedAt: null },
          data: { actedAt: new Date(), status: "ACTED" },
        });
        if (claimed.count === 0) {
          throw new Error("SIGNAL_CLAIM_LOST");
        }
        // F-207: lệnh đã tồn tại trong sổ (kể cả khi actedAt bị thiếu) → chặn trùng
        const existing = await tx.order.findFirst({
          where: { signalId: signal.id },
          select: { id: true },
        });
        if (existing) {
          throw new Error("SIGNAL_HAS_ORDER");
        }
      }
      const rows: Awaited<ReturnType<typeof db.order.create>>[] = [];
      const txPlans: (ExecutionPlan | null)[] = [];
      for (let i = 0; i < children.length; i++) {
        const c = children[i];
        const child = await tx.order.create({
          data: {
            userId: user.id,
            brokerAccountId: account.id,
            signalId: signal.id,
            instrumentId: signal.instrument.id,
            side,
            type: "LIMIT",
            quantity: c.quantity,
            price,
            fee: feeBigInts[i],
            status: "PENDING",
            // TWAP: note fallback đánh dấu lát khi ghi plan fail — plan JSON đè
            // lên NGAY trong cùng tx (F-73A-02). Lát ghi seq để truy nguồn từ
            // note fallback bất kỳ lúc nào.
            note:
              children.length > 1
                ? `${note} — TWAP lát ${c.seq}/${children.length}`
                : note,
          },
        });
        // F-73A-02 (fixbug #73): plan + note ghi NGAY trong cùng transaction —
        // không còn cửa sổ lệnh PENDING sống mà chưa có guard afterTick/deadline
        // (tick engine có thể fill lát sau chỉ vài ms sau commit cũ).
        // Fail-soft §6.6 GIỮ: lỗi build/ghi plan 1 con → con đó giữ note fallback,
        // lệnh vẫn sống (chỉ mất guard khi write thật sự fail — hiếm).
        let plan: ExecutionPlan | null = null;
        try {
          plan =
            twapMeta != null
              ? buildTwapChildPlan({
                  orderId: child.id,
                  seq: c.seq,
                  quantity: c.quantity,
                  price,
                  afterTick: c.afterTick,
                  sizing: opts.sizing,
                  humanNote: note,
                  twap: twapMeta,
                  createdAt: child.createdAt ?? new Date(),
                })
              : buildExecutionPlan({
                  orderId: child.id,
                  quantity: c.quantity,
                  price,
                  sizing: opts.sizing,
                  humanNote: note,
                  singleReason, // F-73A-13: rationale nói đúng lý do SINGLE
                  createdAt: child.createdAt ?? new Date(),
                });
          await tx.order.update({ where: { id: child.id }, data: { note: planToNote(plan) } });
        } catch (planErr) {
          console.error("[signal-execution:plan]", planErr);
          plan = null;
        }
        rows.push(child);
        txPlans.push(plan);
      }
      // K1 (#87 §5.3): marker idempotent — 1 tín hiệu → tối đa 1 lần convert
      // sandbox. Ghi TRONG cùng transaction (chống race 2 chu kỳ/2 request:
      // audit-marker + order sinh nguyên tử; caller tra marker trước khi gọi
      // chỉ là fast-path, đây mới là quyết định).
      if (world === "sandbox") {
        await tx.auditLog.create({
          data: {
            userId: user.id,
            action: "K1_SANDBOX_AUTO_ORDER",
            entity: "Signal",
            entityId: signal.id,
            after: JSON.stringify({
              signalId: signal.id,
              orderIds: rows.map((r) => r.id),
              orderId: rows[0]?.id ?? null,
              symbol,
              side,
              quantity,
              price,
              style: twapMeta != null ? "TWAP" : "SINGLE",
              sizePct: opts.sizePct ?? null,
              note: "tự động thực thi K1 — 2 thế giới độc lập với paper (§5.3)",
            }),
          },
        });
      }
      return { rows, txPlans };
    });
    createdOrders = txOut.rows;
    plans = txOut.txPlans;
  } catch (txErr) {
    const msg = txErr instanceof Error ? txErr.message : String(txErr);
    if (msg === "SIGNAL_CLAIM_LOST" || msg === "SIGNAL_HAS_ORDER") {
      return {
        ok: false,
        status: 409,
        error: "Tín hiệu này đã được chuyển thành lệnh trước đó (hoặc đang được xử lý đồng thời).",
      };
    }
    if (msg === "SANDBOX_SIGNAL_HAS_ORDER") {
      // K1: tín hiệu đã có lệnh TRÊN tài khoản sandbox (idempotent — chạy lại
      // convert không sinh lệnh kép; §5.7-2)
      return {
        ok: false,
        status: 409,
        error: "Tín hiệu này đã được tự động thực thi trên tài khoản thử nghiệm trước đó.",
      };
    }
    throw txErr; // lỗi DB thật — để tầng trên xử lý 500
  }
  const order = createdOrders[0];

  // ── E-P0-2/E-P1-2: ExecutionPlan của MỖI lệnh (con) đã ghi NGAY trong tx ──
  // F-73A-02 (fixbug #73): plan cần orderId nên viết ngay SAU create nhưng
  // TRONG cùng transaction (xoá vòng update post-tx cũ) — claim atomic bảo
  // toàn: hoặc đủ N con có guard afterTick/deadline, hoặc 0 con. Fail-soft
  // §6.6 giữ: lỗi build/ghi plan 1 con chỉ làm con đó mất guard (note fallback)
  // — lệnh vẫn sống. `plans` song song cùng độ dài createdOrders (null = fail).

  await db.auditLog.create({
    data: {
      userId: user.id,
      action: "ORDER_CREATED",
      entity: "Order",
      entityId: order.id,
      after: JSON.stringify({
        symbol,
        side,
        quantity,
        price,
        signalId: signal.id,
        mode: getTradingMode().mode,
        sizing: opts.sizing,
        // K1 (#87): thế giới đích — paper (mặc định) | sandbox (tài khoản thử nghiệm)
        world,
        brokerAccountId: account.id,
        // E-P1-2: tóm tắt kế hoạch + danh sách Order con (TWAP) hoặc plan đơn.
        style: twapMeta != null ? "TWAP" : "SINGLE",
        children: createdOrders.map((o, i) => ({
          orderId: o.id,
          seq: children[i].seq,
          quantity: children[i].quantity,
          afterTick: children[i].afterTick,
          plan: plans[i] != null ? describeExecutionPlan(plans[i]!) : null,
        })),
        ...(twapMeta
          ? {
              twap: {
                totalSlices: twapMeta.totalSlices,
                adtvVnd: Math.round(twapMeta.adtvVnd),
                notionalPctAdtv: twapMeta.notionalPctAdtv,
              },
            }
          : {}),
      }),
    },
  });

  await markSource("trading", {
    mode: "paper",
    success: true,
    meta: { lastOrder: order.id, symbol },
  });

  const toCreated = (o: typeof order, i: number): CreatedPaperOrder => ({
    id: o.id,
    symbol,
    side: o.side as "BUY" | "SELL",
    type: o.type,
    quantity: o.quantity,
    price: o.price,
    status: o.status,
    createdAt: o.createdAt.toISOString(),
    ...(plans[i] != null ? { plan: describeExecutionPlan(plans[i]!) } : {}),
  });

  return {
    ok: true,
    order: toCreated(order, 0),
    orders: createdOrders.map((o, i) => toCreated(o, i)),
    twap:
      twapMeta != null
        ? {
            style: "TWAP",
            sliceCount: twapMeta.totalSlices,
            totalQuantity: children.reduce((s, c) => s + c.quantity, 0),
            adtvVnd: Math.round(twapMeta.adtvVnd),
            notionalPctAdtv: twapMeta.notionalPctAdtv,
            triggerPct: TWAP_ADTV_TRIGGER_PCT, // F-73A-01: đơn nguồn §3.3 — import hằng, không literal.
          }
        : null,
  };
}
