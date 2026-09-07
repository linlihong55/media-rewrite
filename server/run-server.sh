#!/bin/zsh
# 本地服务启动脚本（供 LaunchAgent 开机自启调用）
# 以生产模式运行 Next.js，端口 3300，稳定、常驻。
set -e

# 保证能找到 node / npm（LaunchAgent 环境 PATH 很干净）
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# 若还没有生产构建，先构建一次
if [ ! -d ".next/BUILD_ID" ] && [ ! -f ".next/BUILD_ID" ]; then
  npm run build
fi

exec npm run start
