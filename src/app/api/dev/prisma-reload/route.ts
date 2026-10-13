import { NextResponse } from "next/server";
// #94 K3+K4 — TIỆN ÍCH DEV (giữ lại): dev server chạy dài không restart,
// nên sau `prisma generate` thêm trường mới (vd AgentTask.schedule #94),
// tiến trình còn giữ Prisma Client CŨ trong require-cache → 500
// "Unknown argument <trường mới>". Route này xoá require-cache các module
// prisma + thả singleton globalThis.prisma; sau đó sửa file bất kỳ import db
// (hoặc chỉ cần đợi lần nạp lại route có db) để module db.ts tái tạo client
// MỚI từ đĩa — KHÔNG restart dev server.
import { createRequire } from "node:module";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  // F-1091-11 (fixbug api #109): route phá require-cache + thả singleton —
  // tiệm ích DEV-ONLY. Giờ khoá kép: (1) chỉ chạy khi NODE_ENV=development
  // (production build trả 404 — không ship công cụ phá client ra ngoài);
  // (2) key bí mật từ env PRISMA_RELOAD_KEY (fallback giá trị dev cũ cho
  // môi trường sandbox chưa set env). Bỏ process.pid khỏi response.
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const expectedKey = process.env.PRISMA_RELOAD_KEY ?? "k3k4-reload";
  if (url.searchParams.get("key") !== expectedKey) {
    return NextResponse.json({ error: "unauthorized" }, { status: 403 });
  }
  const nodeRequire = createRequire(`${process.cwd()}/package.json`);
  const ids = Object.keys(nodeRequire.cache).filter(
    (k) =>
      k.includes("/.prisma/") ||
      k.includes("/node_modules/@prisma/client") ||
      k.includes("/node_modules/@prisma/engines")
  );
  for (const id of ids) delete nodeRequire.cache[id];
  const g = globalThis as unknown as { prisma?: unknown };
  const hadInstance = g.prisma != null;
  g.prisma = undefined;
  return NextResponse.json({
    ok: true,
    clearedModules: ids.length,
    hadInstance,
    note: "require-cache prisma đã xoá + globalThis.prisma thả — lần nạp module db kế tiếp sẽ dùng client mới.",
  });
}
