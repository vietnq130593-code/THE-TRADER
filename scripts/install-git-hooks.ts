/**
 * scripts/install-git-hooks.ts (Task 144 · P0) — cài pre-commit hook vào
 * .git/hooks/ (copy từ scripts/git-hooks/pre-commit, chmod 755).
 *
 * Được gọi tự động qua script "prepare" của package.json sau mỗi
 * `bun install` — nên clone mới + bun install là hook sẵn sàng, không cần
 * bước thủ công. Nhạy cảm: thiếu .git (vd chạy trong Docker build) → thoát 0.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "scripts", "git-hooks", "pre-commit");
const HOOKS_DIR = join(ROOT, ".git", "hooks");
const DST = join(HOOKS_DIR, "pre-commit");

if (!existsSync(join(ROOT, ".git"))) {
  console.log("[install-git-hooks] không có .git — bỏ qua (vd build container)");
  process.exit(0);
}
if (!existsSync(SRC)) {
  console.error("[install-git-hooks] thiếu scripts/git-hooks/pre-commit");
  process.exit(1);
}
mkdirSync(HOOKS_DIR, { recursive: true });
copyFileSync(SRC, DST);
chmodSync(DST, 0o755);
console.log("[install-git-hooks] đã cài .git/hooks/pre-commit (chặn .env — Task 144)");
