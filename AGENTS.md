# AGENTS.md — hướng dẫn cho AI coding agent (OpenCode) trên repo The Trader

## Dự án là gì

**The Trader** — nền tảng AI đa tác tử (23 LLM agents, 5 nhóm hội đồng) paper trading
chứng khoán Việt Nam, tự vận hành 24/7. Chi tiết kiến trúc: đọc `README.md` và
`worklog.md` (lịch sử 119+ phiên làm việc).

## Stack (KHÔNG đổi)

- Next.js 16 App Router + TypeScript 5 strict — chỉ route `/` (src/app/page.tsx)
- Prisma 6 + **Supabase Postgres** (nguồn dữ liệu CHÍNH — không phải SQLite)
- PM2 nuôi app (cổng 3000) · engine mini-service socket.io (cổng 3003)
- shadcn/ui + Tailwind — UI tiếng Việt

## Lệnh thường dùng

```bash
bun run lint            # ESLint — chạy trước khi commit
bun run dev             # dev server :3000 (qua PM2 đã có sẵn thì không cần)
bun run db:push         # đẩy schema prisma → Supabase
```

- **TUYỆT ĐỐI KHÔNG** chạy `bun run build`.
- Script prisma/next đã bọc `env -u DATABASE_URL` trong package.json — platform
  inject DATABASE_URL sqlite che `.env` Supabase; không bỏ wrapper này.
- Không đụng `.zscripts/` (platform quản lý), không đổi Caddyfile.

## Quy ước code

- API route: `src/app/api/**/route.ts` (hiện 62 endpoint) — dùng `import { db } from '@/lib/db'`
- Client hooks ở `src/hooks/`, component dashboard ở `src/components/dashboard/`
- Comment tiếng Việt, giải thích "tại sao" — đây là truyền thống repo
- Sau mỗi phiên: append `worklog.md` (template `--- / Task ID / Agent / Task / Work Log / Stage Summary`)

## Model & chi phí

Config `opencode.json` (root) mặc định dùng **free tier OpenCode Zen** — không cần
API key, không tốn tiền. Xem `docs/OPENCODE_SETUP.md` để thêm GitHub Models (PAT),
z.ai GLM, hay Zen paid.
