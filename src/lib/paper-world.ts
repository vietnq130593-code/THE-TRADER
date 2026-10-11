/**
 * src/lib/paper-world.ts — "Đặt lại thế giới Giấy về 0" (phiên #91, việc 1).
 *
 * HIỆU LỆNH TRADER #91: "Module Danh mục, tab Thử nghiệm đã đúng số vốn
 * nhập, nhưng chọn 'Giấy' vẫn ra dữ liệu demo cũ không thật (trader đã kết
 * nối tài khoản, nạp tiền thật). Cần xoá toàn bộ dữ liệu demo cũ, giá trị
 * về đúng 0 tròn trĩnh."
 *
 * Hợp đồng resetPaperWorld() — pattern resetSandbox() #88 (§5.2) áp cho
 * TOÀN BỘ thế giới giấy:
 *   1. Ghi snapshot tổng kết vào AuditLog TRƯỚC khi xoá (minh bạch — lệnh/
 *      vị thế/P&L của vòng cũ không biến mất âm thầm).
 *   2. Xoá theo thứ tự khóa ngoại: Trade → Order → Position → CashSnapshot
 *      của MỌI tài khoản giấy (accountType ≠ "sandbox", deletedAt null —
 *      đúng filter P0 quarantine §5.1 của route /api/portfolio).
 *   3. cashBalance = equity = marginUsed = 0 trên mọi tài khoản giấy —
 *      "về đúng 0 tròn trĩnh".
 *
 * KHÔNG chạm (tách bạch tuyệt đối):
 *   - Tài khoản sandbox K1 (một đồng không đổi — nghịch chứng P0 #87);
 *   - Signal / AgentRun / BanditArm / AuditLog — lịch sử ĐỀ XUẤT & bài học
 *     của agents giữ nguyên ("mọi bài học từ dữ liệu thử nghiệm hay Thực tế
 *     đều có giá trị như nhau" — trader #91 việc 2);
 *   - Instrument / Bar / Quote / Watchlist — hạ tầng dữ liệu thị trường.
 *
 * Fail-soft: lỗi DB → trả {ok:false} kèm thông điệp tiếng Việt, KHÔNG ném.
 */

import { db } from "@/lib/db";

/** Action audit — một nguồn sự thật cho route + verify. */
export const PAPER_WORLD_RESET_ACTION = "PAPER_WORLD_RESET";

export interface PaperWorldResetSummary {
  /** Số tài khoản giấy đã xoá dữ liệu. */
  accounts: number;
  orders: number;
  trades: number;
  positions: number;
  /** CashSnapshot (đường cong equity EOD/forecast A12) đã xoá. */
  snapshots: number;
  /** Tổng equity tài khoản giấy TRƯỚC khi xoá (snapshot tổng kết). */
  equityBefore: number;
  /** Tổng tiền mặt TRƯỚC khi xoá. */
  cashBefore: number;
}

export type PaperWorldResetResult =
  | { ok: true; summary: PaperWorldResetSummary }
  | { ok: false; status: number; error: string };

/** userId chủ tài khoản — cho AuditLog (pattern k-sandbox getActiveUserId). */
async function getActiveUserId(): Promise<string | null> {
  try {
    const user = await db.user.findFirst({
      where: { isActive: true, deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    return user?.id ?? null;
  } catch (err) {
    console.error("[lib/paper-world] đọc user thất bại:", err);
    return null;
  }
}

/**
 * Xoá toàn bộ dữ liệu giao dịch demo của thế giới Giấy, tiền về 0.
 * Idempotent: chạy trên thế giới đã trống → counts = 0, vẫn ghi audit
 * (bằng chứng thao tác — trader bấm lần thứ hai thấy "đã sạch").
 */
export async function resetPaperWorld(): Promise<PaperWorldResetResult> {
  try {
    // Cùng filter "tài khoản giấy" với GET /api/portfolio (P0 §5.1) — mọi
    // tài khoản không phải sandbox, chưa soft-delete.
    const accounts = await db.brokerAccount.findMany({
      where: { deletedAt: null, accountType: { not: "sandbox" } },
      select: { id: true, cashBalance: true, equity: true, accountNumber: true },
      orderBy: { createdAt: "asc" },
    });
    if (accounts.length === 0) {
      return { ok: false, status: 409, error: "Không tìm thấy tài khoản giấy nào để đặt lại." };
    }
    const accountIds = accounts.map((a) => a.id);
    const userId = await getActiveUserId();

    // ── 1. Snapshot tổng kết TRƯỚC khi xoá (pattern #88 resetSandbox) ──
    const cashBefore = accounts.reduce((s, a) => s + Number(a.cashBalance), 0);
    const equityBefore = accounts.reduce((s, a) => s + Number(a.equity), 0);

    // ── 2. Xoá theo thứ tự khóa ngoại ──
    // Trade cascade qua Order — xoá tường minh trước để không phụ thuộc
    // cascade DB (Prisma deleteMany không chạy ON DELETE CASCADE của Postgres
    // cho quan hệ qua Order? Thực tế cascade DB có chạy — nhưng xoá tường
    // minh 2 bước này là belt-and-suspenders của chính resetSandbox #88.)
    const delTrades = await db.trade.deleteMany({
      where: { order: { brokerAccountId: { in: accountIds } } },
    });
    const delOrders = await db.order.deleteMany({
      where: { brokerAccountId: { in: accountIds } },
    });
    const delPositions = await db.position.deleteMany({
      where: { brokerAccountId: { in: accountIds } },
    });
    const delSnapshots = await db.cashSnapshot.deleteMany({
      where: { brokerAccountId: { in: accountIds } },
    });

    // ── 3. Tiền về 0 TRÒN TRỈNH trên mọi tài khoản giấy ──
    await db.brokerAccount.updateMany({
      where: { id: { in: accountIds } },
      // BigInt(0) thay literal 0n — tsconfig target < ES2020 (pattern k-sandbox)
      data: { cashBalance: BigInt(0), equity: BigInt(0), marginUsed: BigInt(0) },
    });

    // ── 4. Audit minh bạch (fail-soft — audit lỗi không làm hỏng reset) ──
    const summary: PaperWorldResetSummary = {
      accounts: accounts.length,
      orders: delOrders.count,
      trades: delTrades.count,
      positions: delPositions.count,
      snapshots: delSnapshots.count,
      equityBefore,
      cashBefore,
    };
    try {
      await db.auditLog.create({
        data: {
          userId,
          action: PAPER_WORLD_RESET_ACTION,
          entity: "BrokerAccount",
          entityId: accounts[0].id,
          after: JSON.stringify({
            ...summary,
            accountNumbers: accounts.map((a) => a.accountNumber),
            note: "đặt lại thế giới Giấy về 0 — xoá Order/Trade/Position/CashSnapshot mọi tài khoản giấy · cash/equity/margin = 0 · KHÔNG chạm sandbox K1 / Signal / bài học agents",
          }),
        },
      });
    } catch (err) {
      console.error("[lib/paper-world] ghi audit thất bại (fail-soft):", err);
    }

    return { ok: true, summary };
  } catch (err) {
    console.error("[lib/paper-world] resetPaperWorld thất bại:", err);
    return { ok: false, status: 500, error: "Đặt lại thế giới Giấy thất bại." };
  }
}
