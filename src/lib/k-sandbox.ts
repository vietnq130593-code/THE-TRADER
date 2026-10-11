/**
 * src/lib/k-sandbox.ts — K1 "Cơ chế thử nghiệm tiền ảo" (AUTONOMY_BLUEPRINT
 * v1.1 §5 — 8/8 DUYỆT phiên #86, triển khai bậc 2 phiên #87).
 *
 * Ba thế giới tiền tách bạch tuyệt đối (nghiệm thu P0 "paper không đổi một đồng"):
 *   - real   : tương lai (LIVE gate còn chặn — signal-execution.ts S3)
 *   - paper  : trader duyệt TỪNG lệnh (giữ nguyên hoàn toàn)
 *   - sandbox: agents TỰ giao dịch trên tín hiệu của chính mình qua cổng đồng
 *              thuận B9 (Q1 §8), P&L trộn vào vòng học (Q2 — §5.5 2-kênh-reward)
 *
 * Hợp đồng dữ liệu AppSetting key "k-sandbox" (JSON — pattern k-run #86):
 *   { enabled, paused, activatedAt, initialAmount, sizePct,
 *     maxOrdersPerCycle, maxBudgetPctPerCycle }
 *
 *   - enabled=false (chưa từng kích hoạt) → auto-convert + settle im lặng.
 *   - enabled=true + paused=true → "Tạm dừng": auto-convert dừng lệnh MỚI,
 *     vị thế cũ vẫn giữ + vẫn settle equity hằng ngày (§5.2).
 *
 * Tài khoản sandbox = BrokerAccount thứ hai `accountType "sandbox"` (cột String
 * sẵn schema.prisma:151 — 0 migrate, 0 model mới). Mọi query "đường paper"
 * ngoài kia lọc `accountType: { not: "sandbox" }` (quarantine P0 §5.1).
 *
 * Fail-soft mọi hàm public (pattern lib/k-run.ts): lỗi DB → console.error +
 * giá trị mặc định an toàn, KHÔNG ném ra caller.
 */

import { db } from "@/lib/db";
import { createPaperOrderFromSignal } from "@/lib/signal-execution";
// Import một chiều k-sandbox → signal-execution (không vòng: signal-execution
// nhận world/sizePct qua opts — không import ngược lại k-sandbox).

/* ─────────────────────────── Hằng số §5.2 ─────────────────────────── */

export const K_SANDBOX_KEY = "k-sandbox";
export const SANDBOX_ACCOUNT_TYPE = "sandbox";
export const SANDBOX_ACCOUNT_NUMBER = "SANDBOX-K1";

/** Kích hoạt tối thiểu 10 triệu ₫, bội 100.000 ₫ (§5.2 activate). */
export const SANDBOX_MIN_ACTIVATE = 10_000_000;
export const SANDBOX_STEP = 100_000;
/** Nạp thêm tối thiểu 1 triệu ₫ (§5.2 topup). */
export const SANDBOX_MIN_TOPUP = 1_000_000;

/** % NAV sandbox cho MỖI lệnh auto (Q2 §5.2 — mặc định 5, cùng thang POSITION_SIZE_PCT). */
export const SANDBOX_DEFAULT_SIZE_PCT = 5;
/** Hạn mức lệnh auto mỗi chu kỳ (§5.2). */
export const SANDBOX_MAX_ORDERS_PER_CYCLE = 5;
/** Hạn mức ngân sách mỗi chu kỳ — % NAV sandbox (§5.2). */
export const SANDBOX_MAX_BUDGET_PCT_PER_CYCLE = 10;

/** CashSnapshot nguồn结算 hằng ngày của K1 (§5.4). */
export const K1_SNAPSHOT_SOURCE = "k1-daily";
/** Giữ đường cong học 365 ngày (§5.4 — dài hơn 90 ngày của paper). */
const K1_SNAPSHOT_PRUNE_DAYS = 365;

/* ─────────────────────────── Types ─────────────────────────── */

export interface KSandboxStored {
  enabled: boolean;
  paused: boolean;
  activatedAt: string | null;
  /** Số tiền cấp lúc kích hoạt (VND) — mốc tính lãi/lỗ "từ lúc kích hoạt". */
  initialAmount: number;
  /** % NAV mỗi lệnh auto (1..100). */
  sizePct: number;
  maxOrdersPerCycle: number;
  maxBudgetPctPerCycle: number;
}

function defaultKSandbox(): KSandboxStored {
  return {
    enabled: false,
    paused: false,
    activatedAt: null,
    initialAmount: 0,
    sizePct: SANDBOX_DEFAULT_SIZE_PCT,
    maxOrdersPerCycle: SANDBOX_MAX_ORDERS_PER_CYCLE,
    maxBudgetPctPerCycle: SANDBOX_MAX_BUDGET_PCT_PER_CYCLE,
  };
}

/** Parse khoan dung JSON AppSetting → KSandboxStored (field sai kiểu → mặc định). */
export function parseKSandbox(raw: string | null | undefined): KSandboxStored {
  if (!raw) return defaultKSandbox();
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return defaultKSandbox();
    const d = defaultKSandbox();
    const posInt = (v: unknown, fb: number) =>
      typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fb;
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : d.enabled,
      paused: typeof parsed.paused === "boolean" ? parsed.paused : d.paused,
      activatedAt: typeof parsed.activatedAt === "string" ? parsed.activatedAt : null,
      initialAmount:
        typeof parsed.initialAmount === "number" && Number.isFinite(parsed.initialAmount) && parsed.initialAmount >= 0
          ? parsed.initialAmount
          : 0,
      sizePct: Math.min(100, posInt(parsed.sizePct, d.sizePct)),
      maxOrdersPerCycle: Math.round(posInt(parsed.maxOrdersPerCycle, d.maxOrdersPerCycle)),
      maxBudgetPctPerCycle: Math.min(
        100,
        Math.round(posInt(parsed.maxBudgetPctPerCycle, d.maxBudgetPctPerCycle))
      ),
    };
  } catch {
    return defaultKSandbox();
  }
}

async function readKSandboxRow(): Promise<string | null> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: K_SANDBOX_KEY } });
    return row?.value ?? null;
  } catch (err) {
    console.error(`[lib/k-sandbox] đọc AppSetting "${K_SANDBOX_KEY}" thất bại:`, err);
    return null;
  }
}

async function writeKSandbox(value: KSandboxStored): Promise<boolean> {
  try {
    const json = JSON.stringify(value);
    await db.appSetting.upsert({
      where: { key: K_SANDBOX_KEY },
      create: { key: K_SANDBOX_KEY, value: json },
      update: { value: json },
    });
    return true;
  } catch (err) {
    console.error(`[lib/k-sandbox] ghi AppSetting "${K_SANDBOX_KEY}" thất bại:`, err);
    return false;
  }
}

/** Đọc state k-sandbox (fail-soft → mặc định an toàn khi DB lỗi). */
export async function getKSandbox(): Promise<KSandboxStored> {
  return parseKSandbox(await readKSandboxRow());
}

/* ─────────────────── Tài khoản sandbox (§5.1) ─────────────────── */

/**
 * Tài khoản sandbox — findFirst theo accountType "sandbox".
 * Mọi đường PAPER (ngoài K1) lọc ngược `accountType: { not: "sandbox" }`
 * (quarantine P0 — xem §5.1 blueprint).
 */
export async function getSandboxAccount() {
  try {
    return await db.brokerAccount.findFirst({
      where: { accountType: SANDBOX_ACCOUNT_TYPE, deletedAt: null },
      orderBy: { createdAt: "asc" },
    });
  } catch (err) {
    console.error("[lib/k-sandbox] getSandboxAccount thất bại:", err);
    return null;
  }
}

/** User active mặc định (pattern toàn codebase — single-user hệ thống). */
async function getActiveUserId(): Promise<string | null> {
  try {
    const u = await db.user.findFirst({ where: { isActive: true }, select: { id: true } });
    return u?.id ?? null;
  } catch {
    return null;
  }
}

/** Equity sandbox = cash + Σ(qty × Quote.last) — công thức F-102 như paper. */
export async function computeSandboxEquity(accountId: string): Promise<{
  cash: number;
  positionsMv: number;
  equity: number;
  unrealisedPnl: number;
  openCount: number;
  lastPrices: Map<string, number>;
} | null> {
  try {
    const [account, positions] = await Promise.all([
      db.brokerAccount.findUnique({
        where: { id: accountId },
        select: { cashBalance: true },
      }),
      db.position.findMany({
        where: { brokerAccountId: accountId, status: "OPEN" },
        include: {
          instrument: {
            select: { symbol: true, quotes: { orderBy: { tradedAt: "desc" }, take: 1, select: { last: true } } },
          },
        },
      }),
    ]);
    if (!account) return null;
    const lastPrices = new Map<string, number>();
    let positionsMv = 0;
    let unrealisedPnl = 0;
    for (const p of positions) {
      const last = p.instrument.quotes[0]?.last ?? p.avgPrice;
      lastPrices.set(p.instrument.symbol, last);
      positionsMv += last * p.quantity;
      unrealisedPnl += (last - p.avgPrice) * p.quantity;
    }
    const cash = Number(account.cashBalance);
    return {
      cash,
      positionsMv,
      equity: cash + positionsMv,
      unrealisedPnl,
      openCount: positions.length,
      lastPrices,
    };
  } catch (err) {
    console.error("[lib/k-sandbox] computeSandboxEquity thất bại:", err);
    return null;
  }
}

/* ─────────────────── Vòng đời tiền (§5.2) ─────────────────── */

/** Kích hoạt: tạo/tái bật tài khoản sandbox + cấp tiền lần đầu. */
export async function activateSandbox(
  amount: number
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const current = await getKSandbox();
  if (current.enabled) {
    return {
      ok: false,
      status: 409,
      error: "Tài khoản thử nghiệm đã đang bật — hãy Đặt lại trước khi kích hoạt lại.",
    };
  }
  if (!Number.isFinite(amount) || amount < SANDBOX_MIN_ACTIVATE) {
    return {
      ok: false,
      status: 422,
      error: `Số tiền kích hoạt tối thiểu ${SANDBOX_MIN_ACTIVATE.toLocaleString("vi-VN")} ₫.`,
    };
  }
  if (amount % SANDBOX_STEP !== 0) {
    return {
      ok: false,
      status: 422,
      error: `Số tiền phải là bội số của ${SANDBOX_STEP.toLocaleString("vi-VN")} ₫.`,
    };
  }
  const userId = await getActiveUserId();
  if (!userId) {
    return { ok: false, status: 404, error: "Không tìm thấy người dùng hoạt động." };
  }
  try {
    const before = await getSandboxAccount();
    // Upsert tài khoản sandbox (một dòng duy nhất theo broker+accountNumber).
    // Reset đã xoá sạch order/trade/position/snapshot trước đó — nhưng tái kích
    // hoạt sau reset dùng upsert chống trùng @@unique([broker, accountNumber]).
    const account = await db.brokerAccount.upsert({
      where: { broker_accountNumber: { broker: "VNDIRECT", accountNumber: SANDBOX_ACCOUNT_NUMBER } },
      create: {
        userId,
        broker: "VNDIRECT",
        accountNumber: SANDBOX_ACCOUNT_NUMBER,
        accountType: SANDBOX_ACCOUNT_TYPE,
        cashBalance: BigInt(Math.round(amount)),
        equity: BigInt(Math.round(amount)),
        currency: "VND",
        status: "ACTIVE",
      },
      update: {
        deletedAt: null,
        status: "ACTIVE",
        cashBalance: BigInt(Math.round(amount)),
        marginUsed: BigInt(0),
        equity: BigInt(Math.round(amount)),
      },
    });
    const next: KSandboxStored = {
      ...defaultKSandbox(),
      enabled: true,
      activatedAt: new Date().toISOString(),
      initialAmount: amount,
    };
    await writeKSandbox(next);
    await db.auditLog.create({
      data: {
        userId,
        action: "K1_SANDBOX_FUNDED",
        entity: "BrokerAccount",
        entityId: account.id,
        after: JSON.stringify({
          before: before ? Number(before.cashBalance) : 0,
          after: amount,
          initialAmount: amount,
          accountNumber: SANDBOX_ACCOUNT_NUMBER,
        }),
      },
    });
    return { ok: true };
  } catch (err) {
    console.error("[lib/k-sandbox] activateSandbox thất bại:", err);
    return { ok: false, status: 500, error: "Kích hoạt tài khoản thử nghiệm thất bại." };
  }
}

/** Nạp thêm tiền vào tài khoản đang bật. */
export async function topupSandbox(
  amount: number
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const s = await getKSandbox();
  if (!s.enabled) {
    return { ok: false, status: 409, error: "Tài khoản thử nghiệm chưa được kích hoạt." };
  }
  if (!Number.isFinite(amount) || amount < SANDBOX_MIN_TOPUP) {
    return {
      ok: false,
      status: 422,
      error: `Số tiền nạp tối thiểu ${SANDBOX_MIN_TOPUP.toLocaleString("vi-VN")} ₫.`,
    };
  }
  if (amount % SANDBOX_STEP !== 0) {
    return {
      ok: false,
      status: 422,
      error: `Số tiền phải là bội số của ${SANDBOX_STEP.toLocaleString("vi-VN")} ₫.`,
    };
  }
  const userId = await getActiveUserId();
  const account = await getSandboxAccount();
  if (!account || !userId) {
    return { ok: false, status: 409, error: "Tài khoản thử nghiệm không tồn tại." };
  }
  try {
    const before = Number(account.cashBalance);
    await db.brokerAccount.update({
      where: { id: account.id },
      data: { cashBalance: account.cashBalance + BigInt(Math.round(amount)) },
    });
    await db.auditLog.create({
      data: {
        userId,
        action: "K1_SANDBOX_TOPUP",
        entity: "BrokerAccount",
        entityId: account.id,
        after: JSON.stringify({ before, after: before + amount, amount }),
      },
    });
    return { ok: true };
  } catch (err) {
    console.error("[lib/k-sandbox] topupSandbox thất bại:", err);
    return { ok: false, status: 500, error: "Nạp tiền thất bại." };
  }
}

/** Tạm dừng / tiếp tục auto-convert (giữ vị thế — §5.2 pause/resume). */
export async function setSandboxPaused(
  paused: boolean
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const s = await getKSandbox();
  if (!s.enabled) {
    return {
      ok: false,
      status: 409,
      error: "Tài khoản thử nghiệm chưa được kích hoạt.",
    };
  }
  if (s.paused === paused) return { ok: true };
  const next: KSandboxStored = { ...s, paused };
  await writeKSandbox(next);
  const userId = await getActiveUserId();
  try {
    await db.auditLog.create({
      data: {
        userId,
        action: paused ? "K1_SANDBOX_PAUSED" : "K1_SANDBOX_RESUMED",
        entity: "AppSetting",
        entityId: K_SANDBOX_KEY,
        after: JSON.stringify({ note: paused ? "dừng lệnh MỚI, vị thế cũ giữ nguyên" : "tiếp tục auto-convert" }),
      },
    });
  } catch (err) {
    console.error("[lib/k-sandbox] audit pause/resume fail-soft:", err);
  }
  return { ok: true };
}

/** Đặt lại: ghi snapshot tổng kết vào AuditLog TRƯỚC, rồi xoá sạch (§5.2 reset). */
export async function resetSandbox(): Promise<
  { ok: true; summary: { equity: number; realisedPnl: number } } | { ok: false; status: number; error: string }
> {
  const s = await getKSandbox();
  const account = await getSandboxAccount();
  if (!s.enabled || !account) {
    return { ok: false, status: 409, error: "Tài khoản thử nghiệm chưa được kích hoạt." };
  }
  const userId = await getActiveUserId();
  try {
    // Tổng kết trước khi xoá: equity cuối + realised P&L tổng (đường paper không chạm).
    const eq = await computeSandboxEquity(account.id);
    const closedAgg = await db.position.aggregate({
      where: { brokerAccountId: account.id, status: "CLOSED" },
      _sum: { realizedPnl: true },
    });
    const realisedPnl = Number(closedAgg._sum.realizedPnl ?? 0);
    const equity = eq?.equity ?? Number(account.cashBalance);

    // Xoá theo thứ tự khóa ngoại: Trade → Order → Position → CashSnapshot.
    await db.trade.deleteMany({
      where: { order: { brokerAccountId: account.id } },
    });
    await db.order.deleteMany({ where: { brokerAccountId: account.id } });
    await db.position.deleteMany({ where: { brokerAccountId: account.id } });
    await db.cashSnapshot.deleteMany({ where: { brokerAccountId: account.id } });

    // Tài khoản về trắng + enabled:false (giữ settings để lần kích hoạt sau sạch sẽ).
    await db.brokerAccount.update({
      where: { id: account.id },
      data: { cashBalance: BigInt(0), equity: BigInt(0), marginUsed: BigInt(0) },
    });
    await writeKSandbox({ ...defaultKSandbox() });

    await db.auditLog.create({
      data: {
        userId,
        action: "K1_SANDBOX_RESET",
        entity: "BrokerAccount",
        entityId: account.id,
        after: JSON.stringify({
          equity,
          realisedPnl,
          initialAmount: s.initialAmount,
          pnl: s.initialAmount > 0 ? equity - s.initialAmount : null,
          note: "xoá toàn bộ Order/Trade/Position/CashSnapshot sandbox · cash về 0 · enabled:false",
        }),
      },
    });
    return { ok: true, summary: { equity, realisedPnl } };
  } catch (err) {
    console.error("[lib/k-sandbox] resetSandbox thất bại:", err);
    return { ok: false, status: 500, error: "Đặt lại tài khoản thử nghiệm thất bại." };
  }
}

/* ─────────────── Auto-convert cuối chu kỳ (§5.3) ─────────────── */

export interface AutoConvertResult {
  converted: number;
  orders: { orderId: string; symbol: string; side: string; quantity: number; price: number }[];
  skipped: { reason: string }[];
}

/**
 * Auto-convert MỘT tín hiệu của chu kỳ vừa sinh sang lệnh sandbox — điểm ghép
 * duy nhất CUỐI chu kỳ (agents/run route). Điều kiện (Q1 §8):
 *   - k-sandbox bật + không tạm dừng + tài khoản sandbox sống
 *   - tín hiệu BUY/SELL (HOLD bỏ) + TRẠNG THÁI ACTIVE
 *   - tín hiệu ĐÃ QỔ CỔNG ĐỒNG THUẬN B9 (consensusGate === "CONSENSUS")
 *   - idempotent: AuditLog K1_SANDBOX_AUTO_ORDER (entity Signal) đã có → bỏ
 *   - hạn mức: sizePct ≤ maxBudgetPctPerCycle (1 tín hiệu/chu kỳ nên
 *     maxOrdersPerCycle phòng xa cho tương lai nhiều tín hiệu)
 *
 * KHÔNG đổi Signal.status — 2 thế giấy độc lập (§5.3): trader vẫn duyệt lệnh
 * paper từ CÙNG tín hiệu như cũ. Fail-soft tuyệt đối: lỗi bất kỳ → skipped,
 * chu kỳ agent không bao giờ hỏng vì K1.
 */
export async function autoConvertSignalToSandbox(signalId: string): Promise<AutoConvertResult> {
  const out: AutoConvertResult = { converted: 0, orders: [], skipped: [] };
  try {
    const s = await getKSandbox();
    if (!s.enabled) {
      out.skipped.push({ reason: "k1-chua-kich-hoat" });
      return out;
    }
    if (s.paused) {
      out.skipped.push({ reason: "k1-tam-dung" });
      return out;
    }
    const account = await getSandboxAccount();
    if (!account) {
      out.skipped.push({ reason: "k1-khong-co-tai-khoan" });
      return out;
    }

    const signal = await db.signal.findUnique({
      where: { id: signalId },
      select: { direction: true, status: true, consensusGate: true },
    });
    if (!signal) {
      out.skipped.push({ reason: "tin-hieu-khong-ton-tai" });
      return out;
    }
    if (signal.direction === "HOLD") {
      out.skipped.push({ reason: "tin-hieu-giu" });
      return out;
    }
    if (signal.status !== "ACTIVE") {
      out.skipped.push({ reason: `trang-thai-${signal.status}` });
      return out;
    }
    // Q1 §8: CHỈ tín hiệu qua cổng đồng thuận B9 mới auto-thực thi.
    if (signal.consensusGate !== "CONSENSUS") {
      out.skipped.push({ reason: `cong-dong-thuan-${signal.consensusGate ?? "null"}` });
      return out;
    }

    // Idempotent: 1 tín hiệu → tối đa 1 lần convert sandbox (audit marker).
    const marker = await db.auditLog.findFirst({
      where: { action: "K1_SANDBOX_AUTO_ORDER", entity: "Signal", entityId: signalId },
      select: { id: true },
    });
    if (marker) {
      out.skipped.push({ reason: "da-convert-truoc-do" });
      return out;
    }

    // Hạn mức ngân sách chu kỳ (§5.3): sizePct phải ≤ maxBudgetPctPerCycle.
    if (s.sizePct > s.maxBudgetPctPerCycle) {
      out.skipped.push({
        reason: `vuoc-han-muc-ngan-sach (${s.sizePct}% > ${s.maxBudgetPctPerCycle}% NAV)`,
      });
      return out;
    }

    // MỘT nguồn tạo lệnh (§5.3): signal-execution.ts tham số hoá world sandbox.
    const res = await createPaperOrderFromSignal(signalId, {
      sizing: "sandbox",
      world: "sandbox",
      sizePct: s.sizePct,
    });
    if (!res.ok) {
      out.skipped.push({ reason: res.error });
      return out;
    }
    out.converted = 1;
    out.orders = res.orders.map((o) => ({
      orderId: o.id,
      symbol: o.symbol,
      side: o.side,
      quantity: o.quantity,
      price: o.price ?? 0,
    }));
    return out;
  } catch (err) {
    console.error("[lib/k-sandbox] autoConvertSignalToSandbox fail-soft:", err);
    out.skipped.push({ reason: "loi-noi-bo (fail-soft)" });
    return out;
  }
}

/* ─────────── Settle hằng ngày 16:30 ICT (§5.4 + §5.5 kênh 2) ─────────── */

export interface SandboxExecReward {
  positionId: string;
  symbol: string;
  agentCode: string | null;
  agentName: string | null;
  signalId: string | null;
  /** Net realised round-trip: Σ_SELL(thu − phí − thuế) − Σ_BUY(chi + phí) — VND. */
  netRealised: number;
  /** Nhị phân hoá Beta-Bernoulli (§5.5): lãi > 0 → 1, lỗ ≤ 0 → 0. */
  reward: number;
}

export interface SettleSandboxDayResult {
  ok: boolean;
  /** "not-enabled" | "no-account" | "already-settled" | null. */
  skipped: string | null;
  ictDate: string;
  rewards: SandboxExecReward[];
  /** Số position đóng hôm nay đã được kết toán TRƯỚC đó (dedupe — chạy lại $0). */
  rewardsDeduped: number;
  cash: number;
  equity: number;
  unrealisedPnl: number;
  realisedPnlOfDay: number;
  snapshotCreated: boolean;
  snapshotUpdated: boolean;
  prunedSnapshots: number;
  banditArmsTouched: string[];
}

/** Cửa sổ ngày ICT [00:00, 24:00) — ICT = UTC+7. */
export function ictDayWindow(nowMs = Date.now()): { date: string; start: Date; end: Date } {
  const ict = new Date(nowMs + 7 * 3_600_000);
  const date = ict.toISOString().slice(0, 10);
  const start = new Date(`${date}T00:00:00+07:00`);
  const end = new Date(start.getTime() + 24 * 3_600_000);
  return { date, start, end };
}

/**
 * Net realised ROUND-TRIP của MỘT position đã đóng — từ Trade thật của position:
 *   BUY: −(price×qty + fee)   SELL: +(price×qty − fee − tax)
 * (đúng nghĩa "đã trừ phí 0,15% + thuế bán" §5.5 — kế toán tiền mặt tuyệt đối,
 *  không phụ thuộc avgPrice kế toán).
 *
 * F-871-01 (Fixbug #87 Vòng 1 — P1) [verify hermetic]: position là unique
 * (brokerAccountId, instrumentId) nên bị ĐÓNG → MỞ LẠI khi agents quay lại
 * cùng mã — trades của VÒNG CŨ vẫn còn neo positionId. Chỉ đếm trades từ
 * `openedAt` HIỆN TẠI (fill engine reset openedAt mỗi lần upsert lại OPEN —
 * đường BUY-upsert index.ts fillOrder) → tách bạch P&L theo từng vòng, không
 * đếm kép vòng cũ / không sót vòng mới.
 */
function netRealisedFromTrades(
  trades: { side: string; price: number; quantity: number; fee: bigint; tax: bigint; executedAt: Date }[],
  openedAt: Date
): number {
  let net = 0;
  for (const t of trades) {
    // Chỉ tính trade của vòng mở hiện tại (≥ openedAt — trade MUA mở vòng có
    // executedAt == openedAt cùng mốc now của fillOrder → dùng >=).
    if (t.executedAt.getTime() < openedAt.getTime()) continue;
    const notional = t.price * t.quantity;
    const fee = Number(t.fee);
    const tax = Number(t.tax);
    net += t.side === "SELL" ? notional - fee - tax : -(notional + fee);
  }
  return net;
}

/**
 * Job 16:30 ICT — MỘT route BỐN việc (§5.5 thứ tự):
 *   (a) settle-exec-reward kênh 2: position sandbox ĐÃ ĐÓNG trong phiên →
 *       quy về tín hiệu gốc → agent tạo tín hiệu → cộng THÊM vào posterior
 *       Beta của BanditArm (α+1/β+0 hoặc ngược — CÙNG posterior với kênh 1
 *       settle 16:15, đúng Q2 "chiến thắng thật / thất bại thật"). KHÔNG ghi
 *       BanditEvent (bảng đó là phiếu bầu theo assessment — §5.5.3).
 *       Idempotent: AuditLog K1_SANDBOX_EXEC_REWARD (entity Position).
 *   (b) settle-equity: CashSnapshot 1 dòng/ngày (source "k1-daily").
 *   (c) telemetry tổng hợp → dữ liệu cổng L5 AgentLesson + hiển thị trader.
 *   (d) audit K1_SANDBOX_SETTLED tổng kết (kể cả 0 — pattern ML_SETTLE).
 *
 * force=true: bỏ qua cổng "hôm nay đã settle" (test nội bộ §5.7-4) — reward
 * vẫn dedupe per position, snapshot upsert (không bao giờ 2 dòng/ngày).
 */
export async function settleSandboxDay(opts: { force?: boolean } = {}): Promise<SettleSandboxDayResult> {
  const win = ictDayWindow();
  const base: SettleSandboxDayResult = {
    ok: true,
    skipped: null,
    ictDate: win.date,
    rewards: [],
    rewardsDeduped: 0,
    cash: 0,
    equity: 0,
    unrealisedPnl: 0,
    realisedPnlOfDay: 0,
    snapshotCreated: false,
    snapshotUpdated: false,
    prunedSnapshots: 0,
    banditArmsTouched: [],
  };
  try {
    const s = await getKSandbox();
    if (!s.enabled) {
      return { ...base, skipped: "not-enabled" };
    }
    const account = await getSandboxAccount();
    if (!account) {
      return { ...base, skipped: "no-account" };
    }

    // Cổng "hôm nay đã settle" (no-force): snapshot k1-daily của ngày đã tồn tại.
    if (!opts.force) {
      const existing = await db.cashSnapshot.findFirst({
        where: {
          brokerAccountId: account.id,
          source: K1_SNAPSHOT_SOURCE,
          createdAt: { gte: win.start, lt: win.end },
        },
        select: { id: true },
      });
      if (existing) {
        return { ...base, skipped: "already-settled" };
      }
    }

    /* (a) Kênh 2 — position sandbox đã đóng trong phiên ICT hôm nay.
     * F-871-01: lấy cả openedAt (mốc vòng mở HIỆN TẠI) để tách bạch round-trip
     * khi position bị đóng → mở lại (trades vòng cũ vẫn neo positionId). */
    const closedToday = await db.position.findMany({
      where: {
        brokerAccountId: account.id,
        status: "CLOSED",
        closedAt: { gte: win.start, lt: win.end },
      },
      include: {
        instrument: { select: { symbol: true } },
        trades: {
          include: { order: { select: { signalId: true } } },
          orderBy: { executedAt: "asc" },
        },
      },
    });

    const userId = await getActiveUserId();
    const touched = new Set<string>();
    for (const pos of closedToday) {
      const net = netRealisedFromTrades(pos.trades, pos.openedAt);
      base.realisedPnlOfDay += net;
      // F-871-01: marker theo SỰ KIỆN ĐÓNG (positionId + closedAt ISO) — cùng
      // lần đóng chạy lại settle → dedupe; position mở lại + đóng lần khác →
      // marker MỚI (vòng mới được reward đúng, vòng cũ không bị đếm kép).
      const rewardMarkerId = `${pos.id}:${pos.closedAt?.toISOString() ?? ""}`;
      const dup = await db.auditLog.findFirst({
        where: { action: "K1_SANDBOX_EXEC_REWARD", entity: "Position", entityId: rewardMarkerId },
        select: { id: true },
      });
      if (dup) {
        base.rewardsDeduped++;
        continue;
      }

      // Attribution: lệnh BÁN đóng position = "lựa chọn" chốt lời/lỗ → tín hiệu
      // của lệnh bán được credit; fallback tín hiệu lệnh MUA đầu (mở position).
      const sellSignalId =
        [...pos.trades].reverse().find((t) => t.side === "SELL" && t.order.signalId)?.order.signalId ?? null;
      const buySignalId = pos.trades.find((t) => t.side === "BUY" && t.order.signalId)?.order.signalId ?? null;
      const signalId = sellSignalId ?? buySignalId;
      let agentCode: string | null = null;
      let agentName: string | null = null;
      if (signalId) {
        const sig = await db.signal.findUnique({
          where: { id: signalId },
          select: { agent: { select: { code: true, name: true } } },
        });
        agentCode = sig?.agent?.code ?? null;
        agentName = sig?.agent?.name ?? null;
      }

      // Nhị phân hoá đúng thang Beta-Bernoulli (§5.5): lãi > 0 → 1 · lỗ ≤ 0 → 0.
      const reward = net > 0 ? 1 : 0;
      if (agentCode) {
        // Cộng THÊM vào posterior Beta của arm (cùng posterior kênh 1 — Q2).
        await db.banditArm.upsert({
          where: { agentCode },
          update: {
            alpha: { increment: reward },
            beta: { increment: 1 - reward },
            pulls: { increment: 1 },
            wins: { increment: reward },
            lastRewardAt: new Date(),
          },
          create: {
            agentCode,
            alpha: 1 + reward,
            beta: 1 + (1 - reward),
            pulls: 1,
            wins: reward,
            lastRewardAt: new Date(),
          },
        });
        touched.add(agentCode);
      }

      await db.auditLog.create({
        data: {
          userId,
          action: "K1_SANDBOX_EXEC_REWARD",
          entity: "Position",
          // F-871-02 (Fixbug #87 Vòng 2 — P1): ghi ĐÚNG rewardMarkerId
          // (positionId:closedAtISO) mà lệnh dedupe phía trên đọc — trước đây
          // ghi pos.id trần nên settle chạy lại KHÔNG tìm thấy marker → cộng
          // kép posterior (verify V5 hụt đúng phép này).
          entityId: rewardMarkerId,
          after: JSON.stringify({
            symbol: pos.instrument.symbol,
            signalId,
            agentCode,
            netRealised: net,
            reward,
            channel: "k1-exec",
            note: agentCode
              ? "kênh 2 — thực thi sandbox cộng vào posterior Beta arm (Q2 §5.5)"
              : "kênh 2 — position không truy vết được agent tạo tín hiệu (chỉ telemetry)",
          }),
        },
      });
      base.rewards.push({
        positionId: pos.id,
        symbol: pos.instrument.symbol,
        agentCode,
        agentName,
        signalId,
        netRealised: net,
        reward,
      });
    }
    base.banditArmsTouched = [...touched];

    /* (b) Settle-equity — CashSnapshot 1 dòng/ngày (upsert khi force) */
    const eq = await computeSandboxEquity(account.id);
    base.cash = eq?.cash ?? 0;
    base.equity = eq?.equity ?? 0;
    base.unrealisedPnl = eq?.unrealisedPnl ?? 0;
    const existingSnap = await db.cashSnapshot.findFirst({
      where: {
        brokerAccountId: account.id,
        source: K1_SNAPSHOT_SOURCE,
        createdAt: { gte: win.start, lt: win.end },
      },
      select: { id: true },
    });
    const snapData = {
      cash: BigInt(Math.round(base.cash)),
      equity: BigInt(Math.round(base.equity)),
    };
    if (existingSnap) {
      await db.cashSnapshot.update({ where: { id: existingSnap.id }, data: snapData });
      base.snapshotUpdated = true;
    } else {
      await db.cashSnapshot.create({
        data: { brokerAccountId: account.id, source: K1_SNAPSHOT_SOURCE, ...snapData },
      });
      base.snapshotCreated = true;
    }

    // Prune > 365 ngày (§5.4 — đường cong học dài hạn, dung lượng nhỏ).
    const pruneBefore = new Date(Date.now() - K1_SNAPSHOT_PRUNE_DAYS * 86_400_000);
    const pruned = await db.cashSnapshot.deleteMany({
      where: { brokerAccountId: account.id, createdAt: { lt: pruneBefore } },
    });
    base.prunedSnapshots = pruned.count;

    /* (c)+(d) Telemetry + audit tổng kết (kể cả 0 — truy vết "chạy đúng lịch") */
    await db.auditLog.create({
      data: {
        userId,
        action: "K1_SANDBOX_SETTLED",
        entity: "BrokerAccount",
        entityId: account.id,
        after: JSON.stringify({
          ictDate: win.date,
          cash: base.cash,
          equity: base.equity,
          unrealisedPnl: base.unrealisedPnl,
          realisedPnlOfDay: base.realisedPnlOfDay,
          rewards: base.rewards,
          rewardsDeduped: base.rewardsDeduped,
          banditArmsTouched: base.banditArmsTouched,
          snapshot: base.snapshotCreated ? "created" : base.snapshotUpdated ? "updated" : "skipped",
          prunedSnapshots: base.prunedSnapshots,
          force: Boolean(opts.force),
        }),
      },
    });
    return base;
  } catch (err) {
    console.error("[lib/k-sandbox] settleSandboxDay thất bại:", err);
    return { ...base, ok: false };
  }
}
