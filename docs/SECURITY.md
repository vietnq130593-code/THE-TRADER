# docs/SECURITY.md — BẢO MẬT & KHÔI PHỤC MÔI TRƯỜNG

> Task 144 · P0 (2026-10-19) — dỡ theo dõi `.env` khỏi git (#113), thay bằng
> sao lưu mã hoá `.env.enc` + pre-commit hook. **Bài học gốc**: secret plaintext
> nằm trong git history từ commit `a8adea4` (theo yêu cầu khôi phục tức thì
> #113) — lịch sử đã push lên GitHub nên **rotate key là bắt buộc**, untrack
> chỉ chặn rò rỉ TIẾP.

## 1. Trạng thái sau Task 144

| Thành phần | Trước | Sau |
|---|---|---|
| `.env` (plaintext secret) | **TRACK trong git** (lộ trên remote) | untracked, chỉ trên đĩa sandbox |
| `.env.enc` (mã hoá AES-256-GCM) | — | **track an toàn** — khôi phục được sau reset |
| `.env.passphrase` (chìa khoá giải mã) | — | trên đĩa, chmod 600, gitignored |
| `.env.local` (NIM key) | gitignored | giữ nguyên (Task 141) |
| pre-commit hook | — | chặn `.env` vô tình bị add lại (`scripts/git-hooks/pre-commit`, tự cài qua `prepare`) |
| Secret trong git HISTORY | **CÒN** (6 commit: `c82cd5e`, `ef6e48d`, `d56b659`, `6b94f4a`, `a8adea4`, `2eb1f73`) | không xoá — giữ giá trị forensic; **mitigate = rotate hết key** §2 |

Prefix key trong `worklog.md`/docs (8-10 ký tự đầu, đã tự redact từ các task
trước) KHÔNG exploitable — không scrub (kỷ luật append-only của worklog).

## 2. ⚠️ VIỆC CẦN CHỦ SỞ HỮU LÀM (một lần, ~15 phút)

Secret đã nằm trong git history trên GitHub (repo riêng tư nhưng coi như đã
hết kín). **Rotate từng key rồi cập nhật `.env` / `.env.local`:**

1. **Supabase Service Role key** (JWT `eyJ…` — vượt toàn bộ RLS):
   Dashboard → Settings → API → *JWT Settings* → Rotate. ⚠️ Vòng này cũng
   làm đổi anon key — cập nhật cả `SUPABASE_ANON_KEY`.
2. **Supabase Access Token** (`sbp_…` — Management API):
   https://supabase.com/dashboard/account/tokens → revoke cũ → tạo mới.
3. **DB password** (trong `DATABASE_URL` + 2 URL Supavisor):
   Dashboard → Settings → Database → Reset database password → URL-encode
   (ký tự `@` → `%40`) rồi thay vào 3 biến.
4. **GitHub PAT** (`ghp_…` — cũng là credential push trong remote URL):
   GitHub → Settings → Developer settings → Tokens → revoke cũ → tạo mới
   (scope `repo`) rồi:
   ```bash
   git remote set-url origin https://<PAT-MỚI>@github.com/vietnq130593-code/THE-TRADER.git
   ```
5. **NVIDIA NIM key** (`nvapi-…` — đã từng dán trong chat, Task 141 cũng khuyến nghị):
   https://build.nvidia.com → xoá key cũ → tạo key mới → cập nhật `.env.local`.

Sau khi rotate xong, làm mới bản sao lưu mã hoá:
```bash
bun run env:backup    # .env (mới) → .env.enc → commit + push
```

## 3. Quy trình khôi phục sau sandbox reset (thay thế #113)

```bash
git clone https://github.com/vietnq130593-code/THE-TRADER.git && cd THE-TRADER
bun install            # pre-commit hook tự cài qua script "prepare"
bun run env:restore    # .env.enc → .env (cần passphrase — xem .env.passphrase
                       #  trên máy cũ hoặc password manager)
# .env.local (NIM key) tạo lại thủ công — 1 dòng, xem .env.example
bun run dev
```

**Passphrase** là MỘT bí mật chủ sở hữu cần nhớ (thay cho 5 key trước đây).
Nó nằm ở `.env.passphrase` (máy hiện tại) — **cần chép vào password manager
ngay** vì file này không theo repo. Đổi passphrase:

```bash
bun run scripts/env-crypt.ts rekey    # sinh passphrase mới + ghi .env.passphrase
bun run env:backup                    # mã hoá lại .env.enc bằng passphrase mới
```

## 4. Thiết kế crypto (`scripts/env-crypt.ts`)

- **scrypt** (N=2¹⁴, r=8, p=1, salt 16 byte random) → 256-bit key từ
  passphrase. N=2¹⁵ bị chặn bởi giới hạn bộ nhớ OpenSSL của Bun
  (128·N·r ≤ 32MB) — 2¹⁴ cho 16MB vẫn mạnh với passphrase 32 ký tự random.
- **AES-256-GCM**: IV 12 byte random mỗi lần encrypt (không tái sử dụng
  nonce), auth tag 16 byte — phát hiện sai passphrase / file hỏng tức thì
  (GCM final() throw).
- Format `.env.enc`: 1 dòng `ENVCRYPT1.base64(salt).base64(iv).base64(ct).base64(tag)`.
- Verify: `bun run scripts/env-crypt.ts verify` — so byte-identical `.env.enc`
  ↔ `.env` trên đĩa bằng `timingSafeEqual`.
- 0 dependency ngoài `node:crypto`.

## 5. Lộ trình P0-P3 (Task 144) — ĐÃ HOÀN TẤT

- ✅ **P0** — untrack `.env` + `.env.enc` + hook + doc này (commit `face483`).
- ✅ **P1** — bun test Tier 1: 8 file · 213 test · 480 expect (fee/lot/băng
  ±7%/HHI/Kelly/Brier/PAV/RSI-MACD/session ICT/Bayes/cổng 80%) + smoke script
  68/68 routes alive — `bun test` · `bun run smoke`.
- ✅ **P2** — extract-by-seam: `agents/run/route.ts` 1.637→338 (5 module
  `src/lib/agents-run/`) · `agent-context.ts` 1.373→29 barrel (12 module
  `src/lib/context/`) · `synthesis-workspace.tsx` 1.921→333 (12 component
  `src/components/dashboard/synthesis/`) — pure-move kiểm chứng md5/multiset.
- ✅ **P3** — engine CORS cấu hình hoá (D6) + đánh giá HA (§6 dưới).

## 6. P3 — CORS engine & HA (đã triển khai Task 144)

- **D6 CORS** (`mini-services/market-engine/index.ts`): đã cấu hình hoá qua
  biến `ENGINE_CORS_ORIGIN` (mặc định `*` — sandbox chỉ truy cập qua gateway
  Caddy cùng-origin; PM2 --watch restart sạch đã verify: ticks chảy lại, state
  P0-5 phục hồi từ DB). **Trước khi mở public**: đặt
  `ENGINE_CORS_ORIGIN=https://<domain-thật>` trong env engine.
- **HA**: kiến trúc single-instance (1 dev server + 1 engine + PM2 restart +
  giám sát badge 75s + RiskAlert ENGINE_SCHEDULER_STALE). Đủ cho sandbox &
  vận hành nhỏ; lên production thật cần: engine tách process pool + DB
  replica + Caddy health-check active. **Không** thêm middleware khi chưa cần
  (nguyên tắc lean 21 deps — mỗi lớp thêm phải có bài toán thật).
