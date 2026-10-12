import { PrismaClient } from '@prisma/client'

// #94 K3+K4: client sinh MỘT LẦN mỗi lần module được nạp; sau `prisma generate`
// thêm trường (vd AgentTask.schedule #94), tiến trình dev-server cũ có thể còn
// giữ bản sinh trước đó trong require-cache — GET /api/dev/prisma-reload?key=
// k3k4-reload để xoá cache + thả singleton, lần nạp module db kế tiếp dùng
// client mới từ đĩa (không cần restart dev server).
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

// #106 — chạm file để Turbopack nạp lại Prisma client sau generate (enum Market/InstrumentType mở rộng)
