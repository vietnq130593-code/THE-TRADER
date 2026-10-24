import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #94 K3+K4: client sinh MỘT LẦN mỗi lần module được nạp; sau `prisma generate`
// thêm trường (vd AgentTask.schedule #94), tiến trình dev-server cũ có thể còn
// giữ bản sinh trước đó trong require-cache — GET /api/dev/prisma-reload?key=
// k3k4-reload để xoá cache + thả singleton, lần nạp module db kế tiếp dùng
// client mới từ đĩa (không cần restart dev server).

// #110-g (P4 — vá hạ tầng, KHÔNG restart dev server): sandbox supervisor có thể
// tự khởi động lại `next dev` với env mặc định DATABASE_URL=file:…db/custom.db
// (SQLite chuẩn fullstack) — biến process-env này override .env của dự án (Next.js:
// process env thắng .env) khiến Prisma 6 (provider postgres) từ chối khởi động →
// mọi API route 500 dù Postgres :5432 vẫn khoẻ. Shim dưới đây CHỈ kích hoạt khi
// env tiến trình không phải postgres URL: đọc lại DATABASE_URL postgres thật từ
// .env và đệm qua `datasources` của PrismaClient. Đường bình thường (env hợp lệ)
// giữ nguyên hành vi cũ 100% — không file nào khác bị đụng, không restart server.
function resolveDatasourceOverride(): { datasources: { db: { url: string } } } | Record<string, never> {
  const envUrl = process.env.DATABASE_URL ?? ''
  if (envUrl.startsWith('postgresql://') || envUrl.startsWith('postgres://')) return {}
  try {
    const raw = readFileSync(join(process.cwd(), '.env'), 'utf8')
    const m = raw.match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m)
    const fileUrl = m?.[1]?.trim() ?? ''
    if (fileUrl.startsWith('postgresql://') || fileUrl.startsWith('postgres://')) {
      return { datasources: { db: { url: fileUrl } } }
    }
  } catch {
    // không đọc được .env — trả {} để Prisma bắn lỗi env như hành vi cũ
  }
  return {}
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  prismaUrlKey: string | undefined
}

// Key đổi khi cấu hình datasource thực sự đổi (env hợp lệ ↔ shim .env) → hot-reload
// file này sẽ disconnect client cũ và sinh client mới theo cấu hình hiện tại
// (bổ sung cho endpoint /api/dev/prisma-reload — F-1111-0A fixbug #111: comment
// cũ nói "đã xoá" là SAI, endpoint vẫn còn và vẫn cần cho `prisma generate`
// thêm trường — xoá require-cache là việc shim này không làm).
const datasourceOverride = resolveDatasourceOverride()
const prismaUrlKey = JSON.stringify(datasourceOverride)

function createPrisma(): PrismaClient {
  const old = globalForPrisma.prisma
  if (old) {
    try {
      void old.$disconnect()?.catch(() => {})
    } catch {
      // client cũ có thể hỏng sẵn (engine không khởi động được) — bỏ qua
    }
  }
  const client = new PrismaClient({
    ...datasourceOverride,
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })
  globalForPrisma.prisma = client
  globalForPrisma.prismaUrlKey = prismaUrlKey
  return client
}

export const db =
  globalForPrisma.prisma && globalForPrisma.prismaUrlKey === prismaUrlKey
    ? globalForPrisma.prisma
    : createPrisma()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

// #106 — chạm file để Turbopack nạp lại Prisma client sau generate (enum Market/InstrumentType mở rộng)
// Task 188 — chạm lần nữa sau db push UniverseTier (enum + Instrument.universeTier):
// prisma-reload xoá require-cache nhưng Turbopack vẫn giữ binding db cũ trong
// module đã nạp; edit file này ép re-evaluate chuỗi dependents.
export const DB_CLIENT_REV = "universe-tier-r1";
