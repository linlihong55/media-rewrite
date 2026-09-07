import fs from "fs";
import path from "path";

export const RESOLVER_BASE_URL =
  process.env.RESOLVER_BASE_URL ?? "http://127.0.0.1:18785";

// server/ 目录下运行时，项目根目录就是其父目录；允许部署环境显式覆盖。
export const PROJECT_ROOT =
  process.env.PROJECT_ROOT ?? path.resolve(process.cwd(), "..");

export const WHISPER_CLI_PATH =
  process.env.WHISPER_CLI_PATH ?? "/opt/homebrew/bin/whisper-cli";

export const YTDLP_PATH =
  process.env.YTDLP_PATH ?? "/Library/Frameworks/Python.framework/Versions/3.13/bin/yt-dlp";

// 优先用 turbo 量化模型（速度快 4-6 倍，中文准确率几乎无损），没有再退回 large-v3
const TURBO_MODEL = path.join(PROJECT_ROOT, "models", "ggml-large-v3-turbo-q8_0.bin");
const LARGE_MODEL = path.join(PROJECT_ROOT, "models", "ggml-large-v3.bin");

export const WHISPER_MODEL_PATH =
  process.env.WHISPER_MODEL_PATH ?? (fs.existsSync(TURBO_MODEL) ? TURBO_MODEL : LARGE_MODEL);

// 每条视频的产出物（.md 记录 + 视频文件）都落在这里，按日期分文件夹
export const OUTPUT_ROOT =
  process.env.OUTPUT_ROOT ?? path.join(PROJECT_ROOT, "outputs");

export function todayOutputDir(): string {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(OUTPUT_ROOT, today);
}

// 「拆解」功能读规则、写产物都落在 Obsidian 的自媒体笔记库里（外置硬盘，需先挂载）
export const OBSIDIAN_RULES_DIR =
  process.env.OBSIDIAN_RULES_DIR ??
  path.join(PROJECT_ROOT, "docs", "01_核心规则");

export const OBSIDIAN_BREAKDOWN_DIR =
  process.env.OBSIDIAN_BREAKDOWN_DIR ??
  path.join(PROJECT_ROOT, "docs", "02_爆款原文库");

function sanitizeTopic(topic: string): string {
  const cleaned = topic
    .trim()
    .replace(/[/\\:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 20);
  return cleaned || "未命名";
}

/** 生成 `AI-{主题}-{日期}.md` 路径，同名文件已存在时自动加 -2/-3... 序号，不覆盖旧文件 */
export function buildBreakdownFilePath(topic: string, date = new Date()): string {
  const safeTopic = sanitizeTopic(topic);
  const dateStr = date.toISOString().slice(0, 10); // YYYY-MM-DD
  const base = `AI-${safeTopic}-${dateStr}`;

  let candidate = path.join(OBSIDIAN_BREAKDOWN_DIR, `${base}.md`);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(OBSIDIAN_BREAKDOWN_DIR, `${base}-${n}.md`);
    n++;
  }
  return candidate;
}
