import fs from "fs";
import os from "os";
import path from "path";

export const RESOLVER_BASE_URL =
  process.env.RESOLVER_BASE_URL ?? "http://127.0.0.1:18785";

export const PROJECT_ROOT = path.join(
  os.homedir(),
  "Codex coding",
  "自媒体爆款",
  "douyin-hit-extractor"
);

export const WHISPER_CLI_PATH =
  process.env.WHISPER_CLI_PATH ?? "/opt/homebrew/bin/whisper-cli";

// 优先用 turbo 量化模型（速度快 4-6 倍，中文准确率几乎无损），没有再退回 large-v3
const TURBO_MODEL = path.join(PROJECT_ROOT, "models", "ggml-large-v3-turbo-q8_0.bin");
const LARGE_MODEL = path.join(PROJECT_ROOT, "models", "ggml-large-v3.bin");

export const WHISPER_MODEL_PATH =
  process.env.WHISPER_MODEL_PATH ?? (fs.existsSync(TURBO_MODEL) ? TURBO_MODEL : LARGE_MODEL);

// 每条视频的产出物（.md 记录 + 视频文件）都落在这里，按日期分文件夹
export const OUTPUT_ROOT = path.join(
  os.homedir(),
  "Codex coding",
  "自媒体爆款",
  "outputs"
);

export function todayOutputDir(): string {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(OUTPUT_ROOT, today);
}
