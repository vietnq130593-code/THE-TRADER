# OpenCode CLI — setup free models (sandbox + local)

> Task 119 · 16-10-2026. Kết luận nghiên cứu tích hợp OpenCode vào workflow,
> bền qua sandbox reset và tái sử dụng ở máy local.

## TL;DR — 3 nguồn model miễn phí

| Nguồn | Cần key? | Trong sandbox | Ở local | Ghi chú |
|---|---|---|---|---|
| **OpenCode Zen free tier** | ❌ không cần | ✅ **đã verify** | ✅ | 41 model `-free`, ~200 req/5h, chỉ gọi "from within OpenCode" |
| **GitHub Models** (PAT) | ✅ PAT GitHub (đã có trong `.env`) | ❌ sandbox chặn (stub DNS) | ✅ | `models.github.ai/inference`, rate-limit theo model |
| **z.ai GLM** | ✅ ZHIPU_API_KEY (chưa có) | ✅ | ✅ | GLM-4.5-Flash free vĩnh viễn; Coding Plan ~$3-6/tháng cho GLM-4.6/4.7 |

## 1. Cách hoạt động của OpenCode (điều tra thực tế)

- Zen free tier **không cần đăng nhập**: CLI tự định danh khi gọi
  `https://opencode.ai/inference/v1`. Gọi endpoint này bằng curl bên ngoài CLI
  sẽ bị từ chối: `FreeTierError: "free tier can only be used from within OpenCode"`.
- Đã verify E2E trong sandbox (16-10-2026):
  `opencode run -m opencode/nemotron-3.5-lightning-free "Reply with exactly: SANDBOX_OK"`
  → trả đúng `SANDBOX_OK` sau ~2-3 phút.
- **Latency free tier: 1-5 phút/call** (cold-start nặng, dao động theo model —
  glm-5.3-flash-free từng vượt 4 phút). Phù hợp task nhỏ/vừa, hỏi-đáp, viết
  docs; KHÔNG phù hợp coding agent tốc độ cao. Muốn nhanh → Zen paid hoặc
  Coding Plan z.ai.
- Rate limit cộng đồng đo được ≈ **200 request / 5 giờ** (free tier).

## 2. Đã có sẵn trong repo (bền qua reset)

| File | Vai trò |
|---|---|
| `opencode.json` | Config project (root) — model mặc định = Zen free + provider `github-models` (PAT từ env). OpenCode đọc file này tự động, **an toàn commit** |
| `AGENTS.md` | Hướng dẫn repo cho agent: stack, lệnh, quy ước, điều cấm |
| `scripts/setup-opencode.sh` | Bootstrap idempotent: cài CLI + nạp key `.env` + ghi auth.json (nếu có Zen paid) |
| `.env` | `GITHUB_MODELS_TOKEN` (PAT) + placeholder `OPENCODE_API_KEY` / `ZHIPU_API_KEY` |

### Sau sandbox reset

```bash
git pull && bash scripts/setup-opencode.sh   # ~30 giây là dùng lại được
opencode run -m opencode/nemotron-3.5-lightning-free "hello" < /dev/null
```

⚠️ Trong shell không TTY (agent/bash tool) **luôn** thêm `< /dev/null` —
không có nó CLI treo chờ stdin vĩnh viễn (đã mất 30 phút điều tra vì lỗi này).

## 3. Ở máy local (khi đưa The Trader về nhà chạy)

```bash
# 1) Cài OpenCode
curl -fsSL https://opencode.ai/install | bash    # hoặc: npm i -g opencode-ai

# 2) Vào repo — config tự áp dụng (opencode.json + AGENTS.md theo git)
cd THE-TRADER

# 3) Nạp key (PAT GitHub đã nằm trong .env)
bash scripts/setup-opencode.sh

# 4) Dùng — TUI tương tác
opencode
#    Model mặc định: opencode/nemotron-3.5-lightning-free (free)
#    Đổi model: lệnh /models → chọn github-models/openai/gpt-4o-mini (PAT free)
```

### Nâng cấp (tuỳ chọn)

- **Zen paid**: đăng nhập https://opencode.ai/console → Create API key →
  dán vào `.env` (`OPENCODE_API_KEY=...`) → chạy lại setup script. Mở khóa
  toàn bộ curated models (per-request billing, cộng credit).
- **z.ai GLM**: đăng ký https://z.ai → API key → `.env` (`ZHIPU_API_KEY=...`).
  GLM-4.5-Flash free vĩnh viễn; GLM Coding Plan (~$3-6/th) dùng GLM-4.6/4.7
  không đếm token — chính là model mà 23 agents của The Trader đang dùng.
  Ngoài ra: `opencode` → `/connect` → chọn **Z.AI** / **Z.AI Coding Plan**.
- **OpenRouter**: `/connect` → OpenRouter → dán key (free tier 50 req/ngày,
  nạp ≥$10 credit → 1.000 req/ngày; 15 model `:free` — xem danh sách trong
  worklog #118-adjacent research).

## 4. Giới hạn đã xác minh (ràng buộc thật)

1. **Sandbox chặn GitHub Models**: `models.github.ai` bị DNS-pin về
   `glb-*.github.com` stub — mọi request trả `200 text/plain "OK"` kể cả model
   không tồn tại (đã test 5 cách: stream, tools, Accept json, bad model, GET
   / — đều "OK"). Provider `github-models` trong config chỉ có tác dụng ở
   local. Vì vậy luồng OpenCode trong sandbox đi duy nhất qua Zen free.
2. **Free tier không gọi được từ code app**: `FreeTierError` chặn mọi request
   ngoài CLI OpenCode — 23 LLM agents của The Trader KHÔNG thể dùng nguồn này.
   Free models chỉ dành cho workflow dev (chat, gen code, review).
3. **Tính bền của đăng nhập**: free tier không cần login nên không có gì mất
   khi reset. Key trong `.env` (commit theo quyết định #113) — `git pull` là
   tự khôi phục. ⚠️ PAT trong `.env` = ai có repo = có quyền push; repo PHẢI
   private (đang khuyến nghị chờ ở §6.1 CV doc — phương án A).
4. **`opencode` npm cài vào global** (`/usr/local`) — không nằm trong package.json
   của app để không phá dependency tree; script setup cài lại sau reset.

## 5. 41 model free của Zen (snapshot 16-10-2026)

`big-pickle` (SWE 72%) · `cat-jam-free` · `deepseek-v4.1-flash-free` ·
`glm-5.3-flash-free` · `ll-alpha-free` · `longcat-2.5-preview-free` ·
`mimo-v2.6-flash-free` · `muse-spark-1.3-contributor-free` ·
`nemotron-3-ultra-free` · `nemotron-3.5-lightning-free` (mặc định — verify OK) ·
`nemotron-3.5-super-vl-free` · `space-bunny-free` + 29 model khác trong catalog
models.dev (provider `opencode`). Liệt kê hiện tại: `opencode models | grep ^opencode/`.

---
*Nghiên cứu Task 119 — chi tiết điều tra trong `worklog.md`.*
