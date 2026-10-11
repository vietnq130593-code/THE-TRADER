/**
 * mini-services/pg-service — Postgres dev engine cho The Trader (phiên #91).
 *
 * BỐI CẢNH: sandbox reset 2026-10-11 làm mất .env Supabase (DATABASE_URL
 * pooler + OPENCODE_ZEN_API_KEY + GITHUB_PAT). Code #74–#90 an toàn trên
 * GitHub (origin/main febdb65) — đã reset --hard khôi phục; còn kho dữ liệu
 * "bền vững qua reset sandbox" thì nằm trên Supabase cloud, chờ trader cấp
 * lại DATABASE_URL. Để phát triển + nghiệm thu E2E NGAY không phụ thuộc
 * secret, dịch vụ này dựng Postgres THẬT (PGlite — Postgres WASM build nhịn
 * phân phối chính thức) listen TCP 127.0.0.1:5432, dữ liệu bền vững trong
 * /home/z/my-project/db/pglite (gitignored).
 *
 * Khi trader điền lại DATABASE_URL Supabase trong .env → prisma db của app
 * tự quay về cloud; dịch vụ này vô hại (chỉ lắng nghe nội bộ 127.0.0.1).
 *
 * Port cố định 5432 (quy ước mini-services: không env PORT). Bun --hot cho
 * auto-restart khi sửa file (DB dir giữ nguyên → dữ liệu sống qua restart).
 */

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const DATA_DIR = "/home/z/my-project/db/pglite";
const PORT = 5432;
const HOST = "127.0.0.1";
const MAX_CONNECTIONS = 64; // Prisma pool + engine + scripts verify chạy song song

async function main() {
  const db = new PGlite(DATA_DIR, {
    // debug: 1 — bật khi cần soi query wire protocol
  });

  const server = new PGLiteSocketServer({
    db,
    port: PORT,
    host: HOST,
    maxConnections: MAX_CONNECTIONS,
  });

  await server.start();
  console.log(
    `[pg-service] Postgres (PGlite) sống tại ${HOST}:${PORT} — data dir ${DATA_DIR} · max ${MAX_CONNECTIONS} conn`
  );

  // Tạo schema "trader" nếu chưa có — prisma db push sẽ tự tạo, nhưng tạo
  // sẵn để psql/console kết nối tay không lỗi "schema does not exist".
  await db.exec(`CREATE SCHEMA IF NOT EXISTS trader;`);
  console.log("[pg-service] schema trader sẵn sàng");

  // Heartbeat 60s — xác nhận service sống + không rò rỉ connection.
  const conns = new Map<string, number>();
  setInterval(() => {
    const stats = server.getStats();
    const active = stats.activeConnections;
    conns.set(new Date().toISOString(), active);
    if (conns.size > 10) conns.delete(conns.keys().next().value as string);
    console.log(
      `[pg-service] heartbeat · conn=${active}/${MAX_CONNECTIONS} · queue=${stats.queuedQueries}`
    );
  }, 60_000).unref();

  const shutdown = async (signal: string) => {
    console.log(`[pg-service] nhận ${signal} — tắt sạch…`);
    try {
      await server.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[pg-service] FATAL:", err);
  process.exit(1);
});
