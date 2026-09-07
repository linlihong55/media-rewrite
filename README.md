# 抖音 / 小红书爆款文案提取与改写

Chrome 插件 + 本地服务：在抖音 / 小红书网页上一键提取视频口播文案（本地 Whisper 转写）、AI 二次改写，并把记录（标题、正文、标签、互动数据、原文案、改写稿、视频链接、记录时间等）自动保存到飞书多维表格。

## 组成

- `extension/` — Chrome 插件（MV3）：页面悬浮面板 + popup，识别当前视频、触发提取 / 改写 / 保存
- `server/` — Next.js 本地服务（端口 3300）：解析、下载、Whisper 转写、LLM 改写、飞书同步
- `e2e/` — Playwright 测试与抖音 Cookie 自动刷新脚本
- `vendor/`（不在仓库内）— 抖音解析依赖的开源服务 [Douyin_TikTok_Download_API](https://github.com/Evil0ctal/Douyin_TikTok_Download_API)，小红书解析不需要它
- `models/`（不在仓库内）— whisper.cpp 模型文件

## 环境准备

1. 安装依赖工具：`ffmpeg`、`whisper-cli`（whisper.cpp，`brew install whisper-cpp`）以及 Docker Desktop（本地 PostgreSQL）
2. 下载 Whisper 模型到 `models/`（推荐 `ggml-large-v3-turbo-q8_0.bin`）
3. 抖音解析需要克隆解析服务到 `vendor/Douyin_TikTok_Download_API` 并按其文档启动（端口 18785）；只用小红书可跳过
4. 配置服务端：

```bash
cd server
cp .env.example .env.local   # 填入自己的飞书 / DeepSeek 等配置
npm install
npm run db:up
npm run db:migrate
npm run dev                  # 启动在 http://localhost:3300
```

5. 安装插件：Chrome → `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选择 `extension/` 目录

## 本地服务开机自启（推荐，免手动启动）

完整功能需要 PostgreSQL 和两个本地服务同时运行。PostgreSQL 首次通过 `npm run db:up && npm run db:migrate` 启动并建表；之后 Docker Desktop 会复用数据卷。

插件相关的两个服务如下：

| 服务 | 端口 | 作用 | 启动脚本 |
| --- | --- | --- | --- |
| Next.js 服务端 | 3300 | 解析/下载/转写/改写/飞书同步 | `server/run-server.sh` |
| 抖音解析服务（vendor） | 18785 | 抖音链接解析（小红书不需要） | `vendor/run-resolver.sh` |

已配置两个 macOS LaunchAgent，**登录后自动启动、崩溃自动拉起**，无需再手动跑 `npm run dev` 或 `start.py`：

- `~/Library/LaunchAgents/com.douyin-hit-extractor.server.plist` → 端口 3300
- `~/Library/LaunchAgents/com.douyin-hit-extractor.resolver.plist` → 端口 18785
- 日志：`~/Library/Logs/douyin-hit-extractor-server.log`、`~/Library/Logs/douyin-hit-extractor-resolver.log`

常用命令（`SVC` 换成 `server` 或 `resolver`）：

```bash
UID=$(id -u)
# 查看状态
launchctl print gui/$UID/com.douyin-hit-extractor.SVC | grep state
# 手动重启
launchctl kickstart -k gui/$UID/com.douyin-hit-extractor.SVC
# 停止自启（卸载）
launchctl bootout gui/$UID/com.douyin-hit-extractor.SVC
# 重新开启自启（加载）
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.douyin-hit-extractor.SVC.plist

# 一键自检两个端口
curl -s localhost:3300/api/health && echo && curl -s -o /dev/null -w "resolver:%{http_code}\n" 127.0.0.1:18785/

# 改过服务端代码后：重新构建并重启 3300
cd server && ./update-server.sh
```

> 说明：常驻服务已占用 3300 / 18785 端口。若还想临时手动调试，需先 `launchctl bootout` 停掉对应常驻服务，避免端口冲突。

## 抖音 Cookie 失效怎么办

抖音解析用的是「游客 Cookie」，有失效周期。表现：抖音链接解析失败（小红书不受影响）。

**多数情况不用管**：服务端解析失败时会自动跑一次刷新脚本（有 10 分钟冷却），成功就自动恢复。

### 方法一：一键刷新（推荐）

```bash
cd douyin-hit-extractor/e2e
node refresh-douyin-cookie.mjs
```

脚本会：无痕浏览器打开抖音拿新游客 Cookie → 写入 `vendor/.../crawlers/douyin/web/config.yaml`（自动备份 `.bak`）→ 用 `launchctl` 重启解析服务 → 用真实视频验证。跑完看到 `✅ Cookie 刷新成功` 就行。

### 方法二：手动换 Cookie（游客 Cookie 被风控时用）

游客 Cookie 有时会被风控，方法一验证失败，就登录后手动复制：

1. Chrome 登录 [douyin.com](https://www.douyin.com)
2. F12 → Network → 刷新页面 → 随便点一个 `www.douyin.com` 的请求 → 复制请求头里的 `Cookie` 整行
3. 打开 `vendor/Douyin_TikTok_Download_API/crawlers/douyin/web/config.yaml`，把第 11 行 `Cookie: ` 后面的内容整段替换（**保留前面的缩进**）
4. 重启解析服务让新 Cookie 生效：
   ```bash
   launchctl kickstart -k gui/$(id -u)/com.douyin-hit-extractor.resolver
   ```
5. 验证：
   ```bash
   curl -s "http://127.0.0.1:18785/api/hybrid/video_data?url=https%3A%2F%2Fv.douyin.com%2FL4FJNR3%2F&minimal=true" | head -c 200
   ```
   返回里有 `"code":200` 就说明好了。

> 关键：改完 config.yaml 一定要执行第 4 步的 `launchctl kickstart` 重启。解析服务只在启动时读一次 Cookie，不重启不会生效。**不要用 `pkill` 杀进程**——常驻服务被 launchd 托管，杀了会用旧配置立刻重启。

## 使用

打开抖音或小红书网页，视频旁会出现悬浮面板：

- **提取文案**：下载视频 → Whisper 转写（临时文件用完即删）
- **改写**：按特征库改写文案，每次保存后自动学习新爆款的特征
- **确认并保存**：记录写入飞书多维表格（缺少的字段会自动创建）
- **批量提取**：粘贴多个链接（抖音 / 小红书均可），逐条提取并同步飞书

注意：小红书链接必须带 `xsec_token` 参数（直接从浏览器地址栏 / 分享面板复制即可）。

## 安全

密钥全部放在 `server/.env.local`（已被 `.gitignore` 忽略）。`vendor/` 内的配置含个人 Cookie，同样不入库。
