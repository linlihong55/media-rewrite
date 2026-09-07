#!/bin/zsh
# launchd 定时任务实际执行的脚本：每 3 天触发一轮自动发现。
# server 本身已经是常驻服务（com.douyin-hit-extractor.server），这里只负责打一次请求；
# 真正的抓取过程日志落在 server 自己的日志文件（~/Library/Logs/douyin-hit-extractor-server.log）。
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

curl -sS -X POST http://127.0.0.1:3300/api/discover -o /dev/null
