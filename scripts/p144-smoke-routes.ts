/**
 * scripts/p144-smoke-routes.ts (Task 144-P1) — TIER 3 SMOKE 68 API ROUTES
 * theo docs/SECURITY.md §5 (lộ trình test):
 *
 *  (a) Glob tự động mọi file route.ts dưới src/app/api → danh sách route →
 *      URL /api/… (dynamic segment giữ nguyên literal — 404 vẫn là "sống"
 *      vì route tồn tại, chỉ thiếu tham số).
 *  (b) Dev server ĐANG CHẠY tại http://localhost:3000 (KHÔNG khởi động
 *      server mới, KHÔNG đụng PM2 — mô phỏng đúng môi trường vận hành).
 *  (c) GET từng route (CHỈ GET — không POST để tránh side-effect chạy
 *      Order/Signal thật), timeout 8s, concurrency 4 (nhẹ với dev server).
 *  (d) ALIVE = HTTP status < 500 (200/400/401/404/405/429 đều là "sống" —
 *      405 = route tồn tại nhưng chỉ nhận POST).
 *  (e) In bảng kết quả + tổng kết "PASS n/m routes alive" — exit code 1
 *      nếu có bất kỳ 5xx / timeout / connection-refused.
 *
 * Chạy: bun run smoke  (≈ bun run scripts/p144-smoke-routes.ts)
 */
import { join } from "node:path";

const BASE_URL = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const TIMEOUT_MS = 8_000;
const CONCURRENCY = 4;
const API_ROOT = join(import.meta.dir, "..", "src", "app", "api");

interface Row {
  route: string; // URL path /api/...
  status: number | null; // null = timeout / connection refused
  ms: number;
  err?: string;
}

/** Glob route files → URL path (src/app/api prefix bị lược bỏ). */
async function listRoutes(): Promise<string[]> {
  const glob = new Bun.Glob("**/route.ts");
  const files: string[] = [];
  for await (const rel of glob.scan({ cwd: API_ROOT })) {
    files.push(rel);
  }
  return files
    .sort()
    .map((rel) => rel.replace(/[/\\]route\.ts$/, "").replace(/\\/g, "/"))
    .map((seg) => `/api${seg ? `/${seg}` : ""}`);
}

/** GET 1 route với timeout 8s — không ném exception (fail-soft thành hàng). */
async function probe(route: string): Promise<Row> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE_URL}${route}`, {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": "p144-smoke/1.0" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { route, status: res.status, ms: Date.now() - t0 };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { route, status: null, ms: Date.now() - t0, err: msg };
  }
}

/** Chạy pool concurrency hạn chế, giữ thứ tự kết quả theo danh sách route. */
async function probeAll(routes: string[]): Promise<Row[]> {
  const rows: Row[] = new Array(routes.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, routes.length) }, async () => {
    while (cursor < routes.length) {
      const i = cursor++;
      rows[i] = await probe(routes[i]!);
      // tiến trình in dòng tiến thao tác tuỳ chọn: mỗi route xong in chấm
      process.stdout.write(".");
    }
  });
  await Promise.all(workers);
  process.stdout.write("\n");
  return rows;
}

function statusLabel(row: Row): string {
  if (row.status != null) return String(row.status);
  return row.err?.includes("abort") || row.err?.toLowerCase().includes("timeout")
    ? "TIMEOUT"
    : "CONN-REFUSED";
}

function isAlive(row: Row): boolean {
  return row.status != null && row.status < 500;
}

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║ TASK 144-P1 — SMOKE 68 API ROUTES (GET · dev :3000)         ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`  Base URL: ${BASE_URL} · timeout ${TIMEOUT_MS / 1000}s · ALIVE = status < 500\n`);

  const routes = await listRoutes();
  console.log(`  Glob mọi route.ts dưới src/app/api → ${routes.length} route\n`);
  console.log("  Đang GET từng route (chỉ GET — không side-effect):");

  const rows = await probeAll(routes);

  /* Retry pass — dev server Turbopack có thể reload giữa chừng (file đang
   * được refactor song song) làm socket đứt tuần tự: chờ 3s rồi thăm lại
   * MỘT lượt các route chưa sống để loại false-negative nhất thời. */
  const deadIdx = rows.map((r, i) => (isAlive(r) ? -1 : i)).filter((i) => i >= 0);
  if (deadIdx.length > 0) {
    console.log(`\n  ${deadIdx.length} route chưa sống — đợi 3s rồi RETRY 1 lượt…`);
    await Bun.sleep(3_000);
    for (const i of deadIdx) {
      rows[i] = await probe(routes[i]!);
    }
  }

  /* Bảng kết quả */
  console.log("\n── Bảng kết quả ──");
  const wRoute = Math.max(...routes.map((r) => r.length), 10);
  console.log(`  ${"GET".padEnd(5)} ${"STATUS".padEnd(13)} ${"MS".padStart(5)}  ROUTE`);
  for (const row of rows) {
    const mark = isAlive(row) ? "✓" : "✗";
    console.log(
      `  ${mark} GET ${statusLabel(row).padEnd(13)} ${String(row.ms).padStart(5)}  ${row.route.padEnd(wRoute)}${row.err ? `  — ${row.err.slice(0, 60)}` : ""}`
    );
  }

  /* Phân nhóm status */
  const byStatus = new Map<number, number>();
  for (const r of rows) {
    if (r.status != null) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  }
  const dead = rows.filter((r) => !isAlive(r));

  console.log("\n── Phân bố status ──");
  const dist = [...byStatus.entries()].sort((a, b) => a[0] - b[0]);
  for (const [code, n] of dist) {
    console.log(`  ${code}: ${n} route`);
  }
  const nTimeout = rows.filter((r) => r.status == null && statusLabel(r) === "TIMEOUT").length;
  const nRefused = rows.filter((r) => r.status == null && statusLabel(r) === "CONN-REFUSED").length;
  if (nTimeout || nRefused) {
    console.log(`  TIMEOUT: ${nTimeout} · CONN-REFUSED: ${nRefused}`);
  }

  /* Tổng kết */
  const alive = rows.length - dead.length;
  console.log(`\n  KẾT QUẢ: PASS ${alive}/${rows.length} routes alive`);
  if (dead.length > 0) {
    console.log("  Route KHÔNG sống (5xx / timeout / conn-refused):");
    for (const r of dead) {
      console.log(`    ✗ ${r.route} → ${statusLabel(r)}${r.err ? ` (${r.err.slice(0, 80)})` : ""}`);
    }
    console.log("\nKẾT QUẢ: CÓ FAIL — xem ✗ trên");
    process.exit(1);
  }
  console.log("\nKẾT QUẢ: PASS toàn bộ — mọi route đều phản hồi < 500");
  process.exit(0);
}

main().catch((e) => {
  console.error("LỖI SMOKE:", e);
  process.exit(1);
});
