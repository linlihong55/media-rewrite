#!/bin/zsh
# 改过服务端代码后运行一次：重新构建并重启常驻服务。
set -e
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> 重新构建..."
npm run build

echo "==> 重启服务..."
launchctl kickstart -k "gui/$(id -u)/com.douyin-hit-extractor.server"

sleep 4
echo -n "==> 健康检查: "
curl -fsS http://localhost:3300/api/health || echo "（服务或数据库尚未就绪，请检查 Docker 与服务日志）"
echo
