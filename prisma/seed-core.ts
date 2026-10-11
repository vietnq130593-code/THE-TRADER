/**
 * prisma/seed-core.ts — SEED HẠ TẦNG SẠCH (phiên #91, triết lý #88 "về 0 từ đầu").
 *
 * Sau sandbox reset 2026-10-11 (mất DATABASE_URL Supabase), DB dev PGlite local
 * bắt đầu trống. Script này dựng ĐÚNG hạ tầng tối thiểu cho hệ thống chạy:
 *   1. User trader + BrokerAccount paper VNDIRECT 'VD0029961828'
 *      → cashBalance = 0 · equity = 0 · marginUsed = 0 — VỀ 0 TRÒN TRỈNH
 *      (hiệu lệnh trader #91: "xoá toàn bộ dữ liệu demo cũ, giá trị về đúng 0";
 *      KHÔNG tạo orders/positions/trades/signals demo như prisma/seed.ts cũ).
 *   2. 30 Instrument VN30 (HOSE, sector thật).
 *   3. Watchlist mặc định toàn VN30.
 *   4. 23 agents — uỷ quyền prisma/expand-agents.ts (idempotent).
 *   5. Bars EOD THẬT + Quote neo thật + DataSourceStatus "real" — uỷ quyền
 *      deepBackfillEod() từ src/lib/eod-sync.ts (dchart public, idempotent).
 *
 * Chạy: env -u DATABASE_URL bun prisma/seed-core.ts
 *   (env -u: chống shell poison DATABASE_URL=file:… — bài học Task 31)
 * Idempotent — chạy lại không nhân đôi (upsert theo unique key tự nhiên).
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

/** VN30 — 30 mã (đồng bộ prisma/seed.ts STOCKS; bỏ phần sinh giá mô phỏng). */
const VN30: { symbol: string; name: string; sector: string }[] = [
  { symbol: "VCB", name: "Ngân hàng TMCP Ngoại thương Việt Nam", sector: "Ngân hàng" },
  { symbol: "BID", name: "Ngân hàng TMCP Đầu tư và Phát triển VN", sector: "Ngân hàng" },
  { symbol: "CTG", name: "Ngân hàng TMCP Công thương Việt Nam", sector: "Ngân hàng" },
  { symbol: "TCB", name: "Ngân hàng TMCP Kỹ thương Việt Nam", sector: "Ngân hàng" },
  { symbol: "VPB", name: "Ngân hàng TMCP Việt Nam Thịnh Vượng", sector: "Ngân hàng" },
  { symbol: "VIC", name: "Tổng công ty CP Đầu tư và Kinh doanh nhà Vingroup", sector: "Bất động sản" },
  { symbol: "VHM", name: "Công ty CP Vinhomes", sector: "Bất động sản" },
  { symbol: "VRE", name: "Công ty CP Vincom Retail", sector: "Bất động sản" },
  { symbol: "FPT", name: "Công ty CP FPT", sector: "Công nghệ" },
  { symbol: "CMG", name: "Công ty CP Công nghệ CMG", sector: "Công nghệ" },
  { symbol: "HPG", name: "Công ty CP Tập đoàn Hòa Phát", sector: "Vật liệu" },
  { symbol: "HSG", name: "Công ty CP Tập đoàn Hoa Sen", sector: "Vật liệu" },
  { symbol: "MSN", name: "Công ty CP Masan Group", sector: "Tiêu dùng" },
  { symbol: "MWG", name: "Công ty CP Đầu tư Thế Giới Di Động", sector: "Bán lẻ" },
  { symbol: "VNM", name: "Công ty CP Sữa Việt Nam", sector: "Tiêu dùng" },
  { symbol: "SAB", name: "Công ty CP Bia - Rượu - NGK Sài Gòn", sector: "Tiêu dùng" },
  { symbol: "GAS", name: "Tổng công ty Khí Việt Nam", sector: "Năng lượng" },
  { symbol: "PLX", name: "Tổng công ty CP Xăng dầu Việt Nam", sector: "Năng lượng" },
  { symbol: "VJC", name: "Tổng công ty CP Hàng không Việt Nam", sector: "Hàng không" },
  { symbol: "HVN", name: "Tổng công ty Hàng không Việt Nam", sector: "Hàng không" },
  { symbol: "MBB", name: "Ngân hàng TMCP Quân đội", sector: "Ngân hàng" },
  { symbol: "STB", name: "Ngân hàng TMCP Sài Gòn Thương Tín", sector: "Ngân hàng" },
  { symbol: "PNJ", name: "Công ty CP Vàng bạc Đá quý Phú Nhuận", sector: "Bán lẻ" },
  { symbol: "DHG", name: "Công ty CP Dược Hậu Giang", sector: "Y tế" },
  { symbol: "VIB", name: "Ngân hàng TMCP Quốc tế Việt Nam", sector: "Ngân hàng" },
  { symbol: "TPB", name: "Ngân hàng TMCP Tiên Phong", sector: "Ngân hàng" },
  { symbol: "SHB", name: "Ngân hàng TMCP Sài Gòn - Hà Nội", sector: "Ngân hàng" },
  { symbol: "SSI", name: "Công ty CP Chứng khoán SSI", sector: "Chứng khoán" },
  { symbol: "VND", name: "Công ty CP Chứng khoán VNDIRECT", sector: "Chứng khoán" },
  { symbol: "HCM", name: "Công ty CP Chứng khoán TP.HCM", sector: "Chứng khoán" },
];

async function main() {
  /* ── 1. User + BrokerAccount paper VỀ 0 ─────────────────────────── */
  const user = await db.user.upsert({
    where: { email: "trader@thetrader.vn" },
    create: {
      email: "trader@thetrader.vn",
      name: "Nguyễn Văn Trader",
      passwordHash: "demo-not-a-real-hash",
      phone: "0901234567",
      role: "trader",
    },
    update: { name: "Nguyễn Văn Trader", role: "trader" },
  });

  // Tài khoản GIẤY (paper) — xoá sạch quá khứ demo: cash/equity/margin = 0.
  // QUAN TRỌNG: xoá mọi Order/Position/Trade cũ của tài khoản (nếu DB này
  // được tái sử dụng) để "về 0 trọn vẹn" — cascade theo schema:
  // Position/Order onDelete Cascade từ BrokerAccount.
  const existingPaper = await db.brokerAccount.findFirst({
    where: { broker: "VNDIRECT", accountNumber: "VD0029961828" },
    select: { id: true },
  });
  if (existingPaper) {
    // Xoá luồng giao dịch cũ (Trade cascade từ Order) trước khi xoá account
    // (Position cascade trực tiếp; Order cascade trực tiếp; Trade theo Order).
    await db.order.deleteMany({ where: { brokerAccountId: existingPaper.id } });
    await db.position.deleteMany({ where: { brokerAccountId: existingPaper.id } });
    await db.brokerAccount.delete({ where: { id: existingPaper.id } });
    console.log(
      `[seed-core] xoá tài khoản giấy cũ ${existingPaper.id} (orders/positions/trades demo theo cascade)`
    );
  }
  const paper = await db.brokerAccount.create({
    data: {
      userId: user.id,
      broker: "VNDIRECT",
      accountNumber: "VD0029961828",
      accountType: "margin",
      cashBalance: BigInt(0), // BigInt(0) thay 0n — tsconfig target ES2017
      equity: BigInt(0),
      marginUsed: BigInt(0),
      status: "ACTIVE",
    },
  });
  console.log(
    `[seed-core] tài khoản GIẤY ${paper.id} · cash=0 · equity=0 · margin=0 — VỀ 0 TRÒN TRỈNH`
  );

  /* ── 2. Instruments VN30 ─────────────────────────────────────────── */
  let instCreated = 0;
  const instrumentIds: { id: string; symbol: string }[] = [];
  for (const s of VN30) {
    const inst = await db.instrument.upsert({
      where: { symbol: s.symbol },
      create: {
        symbol: s.symbol,
        name: s.name,
        market: "HOSE",
        type: "STOCK",
        currency: "VND",
        sector: s.sector,
        outstandingShares: BigInt(1_000_000_000),
        isActive: true,
      },
      update: { name: s.name, sector: s.sector, isActive: true },
    });
    instrumentIds.push({ id: inst.id, symbol: inst.symbol });
    if (inst.createdAt.getTime() === inst.updatedAt.getTime()) instCreated++;
  }
  console.log(`[seed-core] instruments VN30: ${instrumentIds.length} mã (${instCreated} mới)`);

  /* ── 3. Watchlist mặc định ───────────────────────────────────────── */
  let wl = await db.watchlist.findFirst({
    where: { userId: user.id, isDefault: true },
    include: { items: true },
  });
  if (!wl) {
    wl = await db.watchlist.create({
      data: { userId: user.id, name: "Danh mục theo dõi", isDefault: true },
      include: { items: true },
    });
  }
  const have = new Set(wl.items.map((i) => i.instrumentId));
  let wlAdded = 0;
  for (const inst of instrumentIds) {
    if (have.has(inst.id)) continue;
    await db.watchlistItem.create({
      data: { watchlistId: wl.id, instrumentId: inst.id },
    });
    wlAdded++;
  }
  console.log(`[seed-core] watchlist '${wl.name}': +${wlAdded} mục (tổng ${have.size + wlAdded})`);

  /* ── Tóm tắt ─────────────────────────────────────────────────────── */
  const [agents, bars, quotes] = await Promise.all([
    db.agent.count(),
    db.bar.count(),
    db.quote.count(),
  ]);
  console.log(
    `[seed-core] XONG: user=${user.email} · paper=0₫ · instruments=${instrumentIds.length} · agents=${agents} (chạy prisma/expand-agents.ts nếu 0) · bars=${bars} · quotes=${quotes} (chạy deepBackfillEod nếu 0)`
  );
}

main()
  .catch((err) => {
    console.error("[seed-core] LỖI:", err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
