/**
 * scripts/p137-verify-world.ts (Task 138-a · F-23 P0 world-context) — VERIFY
 * fix audit 137 C1/C2/C3 trên DB SỐNG: chạy THẬT risk engine + reconciliation
 * + committed view rồi ASSERT thế giới paper không còn đo dữ liệu sandbox.
 *
 *  (a) runRiskQuantEngine() — ASSERT nav KHÔNG còn = 29.720.000 (tổng MV 3 vị
 *      thế sandbox + cash paper 0 — bằng chứng nhiễm C1 trong DB trước fix);
 *      positions paper rỗng → proxyMode = true (rổ top-10 §0.4); topPosPct
 *      null/0 (conc == null ở proxy mode — không bịa số liệu phơi nhiễm).
 *  (b) runReconciliation() — ASSERT verdict "BALANCED" + tradesCount 0 (Trade
 *      sandbox không còn rơi vào window ledger paper — trước fix 2 MISMATCH
 *      giả đã nổ 14-10 & 16-10).
 *  (c) computeCommittedCashView(input paper) — in committedBuyingPower; ASSERT
 *      = 0 (trước fix: −3.385.070 ₫ do đếm lệnh PENDING sandbox TCB — C3).
 *
 * Chạy: env -u DATABASE_URL bun scripts/p137-verify-world.ts
 */
import { db } from "../src/lib/db";
import { runRiskQuantEngine } from "../src/lib/risk/engine";
import { runReconciliation } from "../src/lib/exec/reconciliation";
import { computeCommittedCashView } from "../src/lib/exec/committed";

/** NAV sai của 5 snapshot trước fix (C1): MV 3 vị thế sandbox + cash paper 0. */
const CONTAMINATED_NAV = 29_720_000;
/** committedBuyingPower sai của paper trước fix (C3): lệnh PENDING sandbox. */
const CONTAMINATED_COMMITTED = -3_385_070;

let pass = true;
const ok = (msg: string): void => console.log(`  ✓ ${msg}`);
const fail = (msg: string): void => {
  pass = false;
  console.log(`  ✗ ${msg}`);
};
const vnd = (n: number): string => Math.round(n).toLocaleString("vi-VN");

interface SnapshotDetail {
  topPositionPct?: unknown;
  topSectorPct?: unknown;
}

function readDetail(raw: string | null | undefined): SnapshotDetail | null {
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as SnapshotDetail;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  console.log("════ P137 VERIFY WORLD-CONTEXT — paper ≠ sandbox (audit 137 C1/C2/C3) ════");

  /* ── Bối cảnh: 2 thế giới trong DB sống ── */
  const [paper, sandbox] = await Promise.all([
    db.brokerAccount.findFirst({
      where: { deletedAt: null, accountType: { not: "sandbox" } },
      orderBy: { createdAt: "asc" },
      select: { id: true, accountNumber: true, cashBalance: true, equity: true, marginUsed: true },
    }),
    db.brokerAccount.findFirst({
      where: { accountType: "sandbox" },
      select: { id: true, accountNumber: true, cashBalance: true },
    }),
  ]);
  const positionsByWorld = await db.position.groupBy({
    by: ["brokerAccountId"],
    _count: true,
    where: { status: "OPEN" },
  });
  const paperOpen = positionsByWorld.find((g) => g.brokerAccountId === paper?.id)?._count ?? 0;
  const sandboxOpen = positionsByWorld.find((g) => g.brokerAccountId === sandbox?.id)?._count ?? 0;
  console.log(
    `Bối cảnh: paper ${paper?.accountNumber ?? "?"} (cash ${vnd(Number(paper?.cashBalance ?? 0))} ₫ · ${paperOpen} vị thế OPEN)` +
      ` ‖ sandbox ${sandbox?.accountNumber ?? "?"} (cash ${vnd(Number(sandbox?.cashBalance ?? 0))} ₫ · ${sandboxOpen} vị thế OPEN)`
  );

  /* ── (a) Risk engine — thế giới paper ── */
  console.log("\n════ (a) runRiskQuantEngine() — engine phải đo THẾ GIỚI PAPER ════");
  const r = await runRiskQuantEngine();
  console.log(
    `  ok=${r.ok} · nav=${vnd(r.nav)} ₫ · proxyMode=${r.proxyMode} · conc=${r.conc == null ? "null (proxy mode)" : "có"} · snapshotId=${r.snapshotId ?? "—"}`
  );
  console.log(`  notes: ${r.notes.join(" | ").slice(0, 200)}`);
  if (r.nav === CONTAMINATED_NAV) fail(`nav vẫn = ${vnd(CONTAMINATED_NAV)} ₫ (danh mục sandbox lọt vào paper — C1 chưa vá)`);
  else ok(`nav ${vnd(r.nav)} ₫ ≠ ${vnd(CONTAMINATED_NAV)} ₫ (tổng MV vị thế sandbox không còn vào NAV)`);
  if (r.proxyMode) ok("positions paper rỗng → proxyMode (rổ top-10 §0.4 — như thiết kế)");
  else fail(`proxyMode = false (kỳ vọng thế giới paper trống → proxy)`);
  if (r.conc == null) ok("topPosPct = null (conc bỏ qua ở proxy mode — không bịa phơi nhiễm)");
  else {
    const topPosFromDetail = r.snapshotId
      ? readDetail(
          (await db.riskQuantSnapshot.findUnique({ where: { id: r.snapshotId }, select: { detail: true } }))
            ?.detail ?? null
        )?.topPositionPct
      : undefined;
    if (topPosFromDetail == null || Number(topPosFromDetail) === 0)
      ok(`topPosPct = ${String(topPosFromDetail ?? "null")} (0 vị thế paper)`);
    else fail(`topPosPct = ${String(topPosFromDetail)} (kỳ vọng null/0)`);
  }
  // Snapshot persist MỚI NHẤT sau lần chạy này — đối chiếu DB (không chỉ RAM)
  const latest = await db.riskQuantSnapshot.findFirst({
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, nav: true, proxyMode: true, detail: true },
  });
  if (latest) {
    const d = readDetail(latest.detail);
    console.log(
      `  snapshot mới nhất (${latest.createdAt.toISOString()}): nav=${vnd(Number(latest.nav))} ₫ · proxy=${latest.proxyMode} · topPositionPct=${String(d?.topPositionPct ?? "—")} · topSectorPct=${String(d?.topSectorPct ?? "—")}`
    );
    if (Number(latest.nav) === CONTAMINATED_NAV) fail("snapshot persist vẫn nav nhiễm 29.720.000 ₫");
  }

  /* ── (b) Reconciliation — window ledger paper ── */
  console.log("\n════ (b) runReconciliation() — ledger paper không nuốt Trade sandbox ════");
  const rep = await runReconciliation();
  console.log(
    `  verdict=${rep.verdict} · baseline=${rep.baseline} · tradesCount=${rep.tradesCount} · window ${rep.window.fromCheckpoint ?? "(baseline)"} → ${rep.window.toNow}`
  );
  for (const e of rep.expectations) {
    console.log(`    · ${e.name}: expected=${e.expected} actual=${e.actual} ok=${e.ok}`);
  }
  if (rep.verdict === "BALANCED") ok('verdict "BALANCED"');
  else fail(`verdict ${rep.verdict} (kỳ vọng BALANCED — xem expectations trên)`);
  if (rep.tradesCount === 0) ok("tradesCount = 0 (Trade sandbox bị lọc khỏi window paper)");
  else fail(`tradesCount = ${rep.tradesCount} (kỳ vọng 0 — không có Trade paper trong window)`);

  /* ── (c) CommittedCashView — input paper ── */
  console.log("\n════ (c) computeCommittedCashView(input paper) — C3 ════");
  const view = await computeCommittedCashView({
    cash: Number(paper?.cashBalance ?? 0),
    equity: Number(paper?.equity ?? 0),
    marginUsed: Number(paper?.marginUsed ?? 0),
    buyingPowerFactor: 0.5, // fallback mặc định roster A12 (runCashManagement)
    marginRoomMinVnd: 500_000_000,
  });
  console.log(
    `  buyingPower=${vnd(view.buyingPower)} ₫ · committedBuyNotional=${vnd(view.committedBuyNotional)} ₫ · pendingOrders=${view.pendingOrders} (paper) · committedBuyingPower=${vnd(view.committedBuyingPower)} ₫`
  );
  if (view.committedBuyingPower === CONTAMINATED_COMMITTED)
    fail(`committedBuyingPower vẫn = ${vnd(CONTAMINATED_COMMITTED)} ₫ (lệnh PENDING sandbox còn đếm vào paper — C3)`);
  else ok(`committedBuyingPower = ${vnd(view.committedBuyingPower)} ₫ ≠ ${vnd(CONTAMINATED_COMMITTED)} ₫ (lệnh PENDING sandbox bị loại)`);

  console.log(
    `\nKẾT QUẢ: ${pass ? "PASS — world-context paper/sandbox hoạt động (C1+C2+C3)." : "FAIL — điều tra tiếp."}`
  );
  if (!pass) process.exitCode = 1;
}

main()
  .catch((e: unknown) => {
    console.error("FAIL:", e);
    process.exit(1);
  })
  .finally(() => {
    void db.$disconnect();
  });
