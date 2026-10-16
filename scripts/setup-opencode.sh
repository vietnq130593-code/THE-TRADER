#!/usr/bin/env bash
# setup-opencode.sh (Task 119) — bootstrap OpenCode CLI sau sandbox reset.
# Idempotent: chạy lại bao nhiêu lần cũng an toàn.
#
# Nguồn model:
#   1. OpenCode Zen free tier — KHÔNG cần key, chạy được NGAY trong sandbox (đã verify)
#   2. GitHub Models — GITHUB_MODELS_TOKEN trong .env (chỉ hoạt động ở LOCAL:
#      sandbox DNS-pin models.github.ai về stub trả "OK" — không gọi được thật)
#   3. (tuỳ chọn) Zen paid / z.ai GLM — thêm key vào .env
#
# Cách chạy:  bash scripts/setup-opencode.sh
# Sau reset:   git pull && bash scripts/setup-opencode.sh   (~30 giây)

set -euo pipefail
cd "$(dirname "$0")/.."

env_value() { # env_value KEY — đọc giá trị an toàn từ .env (không source)
  [ -f .env ] && grep -E "^${1}=" .env | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true
}

echo "== [1/3] Cài OpenCode CLI (nếu chưa có) =="
if ! command -v opencode >/dev/null 2>&1; then
  npm install -g opencode-ai
fi
echo -n "Phiên bản: "; opencode --version

echo "== [2/3] Nạp key từ .env =="
GITHUB_MODELS_TOKEN="$(env_value GITHUB_MODELS_TOKEN || true)"
OPENCODE_API_KEY="$(env_value OPENCODE_API_KEY || true)"
ZHIPU_API_KEY="$(env_value ZHIPU_API_KEY || true)"
export GITHUB_MODELS_TOKEN OPENCODE_API_KEY ZHIPU_API_KEY

# Zen paid key (tuỳ chọn) → auth.json để OpenCode nhận diện
AUTH_DIR="$HOME/.local/share/opencode"
if [ -n "${OPENCODE_API_KEY:-}" ]; then
  mkdir -p "$AUTH_DIR"
  printf '{ "opencode": { "type": "api", "key": "%s" } }\n' "$OPENCODE_API_KEY" \
    > "$AUTH_DIR/auth.json"
  chmod 600 "$AUTH_DIR/auth.json"
  echo "  OPENCODE_API_KEY  → đã ghi $AUTH_DIR/auth.json (Zen paid)"
else
  echo "  (không có OPENCODE_API_KEY — dùng Zen free tier, không cần đăng nhập)"
fi
if [ -n "${GITHUB_MODELS_TOKEN:-}" ]; then
  echo "  GITHUB_MODELS_TOKEN → sẵn sàng (provider github-models — CHỈ dùng ở local)"
else
  echo "  (thiếu GITHUB_MODELS_TOKEN — provider github-models sẽ 401, Zen free vẫn dùng được)"
fi
[ -n "${ZHIPU_API_KEY:-}" ] && echo "  ZHIPU_API_KEY → sẵn sàng (provider zai)"

echo "== [3/3] Kiểm tra =="
echo "  Free models khả dụng (mẫu):"
opencode models 2>/dev/null | grep "^opencode/" | head -5 || echo "  (lỗi liệt kê model — kiểm tra mạng)"
echo ""
echo "DONE. Thử nhanh (sandbox):"
echo '  opencode run -m opencode/nemotron-3.5-lightning-free "hello" < /dev/null'
echo "  (LUÔN dùng < /dev/null trong shell không TTY — tránh CLI treo chờ stdin)"
