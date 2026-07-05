# 抖音 / 小红书爆款文案提取与改写

Chrome 插件 + 本地服务：在抖音 / 小红书网页上一键提取视频口播文案（本地 Whisper 转写）、AI 二次改写，并把记录（标题、正文、标签、互动数据、原文案、改写稿、视频链接、记录时间等）自动保存到飞书多维表格。

## 组成

- `extension/` — Chrome 插件（MV3）：页面悬浮面板 + popup，识别当前视频、触发提取 / 改写 / 保存
- `server/` — Next.js 本地服务（端口 3300）：解析、下载、Whisper 转写、LLM 改写、飞书同步
- `e2e/` — Playwright 测试与抖音 Cookie 自动刷新脚本
- `vendor/`（不在仓库内）— 抖音解析依赖的开源服务 [Douyin_TikTok_Download_API](https://github.com/Evil0ctal/Douyin_TikTok_Download_API)，小红书解析不需要它
- `models/`（不在仓库内）— whisper.cpp 模型文件

## 环境准备

1. 安装依赖工具：`ffmpeg`、`whisper-cli`（whisper.cpp，`brew install whisper-cpp`）
2. 下载 Whisper 模型到 `models/`（推荐 `ggml-large-v3-turbo-q8_0.bin`）
3. 抖音解析需要克隆解析服务到 `vendor/Douyin_TikTok_Download_API` 并按其文档启动（端口 18785）；只用小红书可跳过
4. 配置服务端：

```bash
cd server
cp .env.example .env.local   # 填入自己的飞书 / DeepSeek 等配置
npm install
npm run dev                  # 启动在 http://localhost:3300
```

5. 安装插件：Chrome → `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选择 `extension/` 目录

## 使用

打开抖音或小红书网页，视频旁会出现悬浮面板：

- **提取文案**：下载视频 → Whisper 转写（临时文件用完即删）
- **改写**：按特征库改写文案，每次保存后自动学习新爆款的特征
- **确认并保存**：记录写入飞书多维表格（缺少的字段会自动创建）
- **批量提取**：粘贴多个链接（抖音 / 小红书均可），逐条提取并同步飞书

注意：小红书链接必须带 `xsec_token` 参数（直接从浏览器地址栏 / 分享面板复制即可）。

## 安全

密钥全部放在 `server/.env.local`（已被 `.gitignore` 忽略）。`vendor/` 内的配置含个人 Cookie，同样不入库。
