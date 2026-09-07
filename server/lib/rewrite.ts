import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// 改写模型双通道：
//   REWRITE_PROVIDER=claude   → 本机 claude CLI 无头模式（复用 Claude Code 订阅账号，无需 API Key）
//   REWRITE_PROVIDER=deepseek → DeepSeek OpenAI 兼容接口（需 DEEPSEEK_API_KEY）
// 主通道失败时自动降级到另一个可用通道。
// 改写方法论 = ai-viral-copywriter Skill + 自动学习的爆款特征库（learned-patterns.md）
const SKILL_DIR = path.join(process.cwd(), "skills", "ai-viral-copywriter");
const SKILL_PATH = path.join(SKILL_DIR, "SKILL.md");
export const LEARNED_PATH = path.join(SKILL_DIR, "learned-patterns.md");

let promptCache: { cacheKey: string; prompt: string } | null = null;

function fileMtime(pathname: string): number {
  try {
    return fs.statSync(pathname).mtimeMs;
  } catch {
    return 0;
  }
}

function loadSystemPrompt(): string {
  const skillMtime = fileMtime(SKILL_PATH);
  if (!skillMtime) {
    throw new Error(`读不到改写 Skill：${SKILL_PATH}`);
  }

  const cacheKey = `${skillMtime}:${fileMtime(LEARNED_PATH)}`;
  if (promptCache?.cacheKey === cacheKey) return promptCache.prompt;

  let skillMd: string;
  try {
    skillMd = fs.readFileSync(SKILL_PATH, "utf-8").replace(/^---[\s\S]*?---\s*/, "");
  } catch (err) {
    throw new Error(
      `读取改写 Skill 失败：${err instanceof Error ? err.message : String(err)}`
    );
  }

  let learned = "";
  try {
    learned = fs.readFileSync(LEARNED_PATH, "utf-8");
  } catch {
    // 尚未积累
  }

  const prompt = `你是短视频爆款文案改写专家，必须严格按照下面的「改写 Skill」方法论工作。

${skillMd}

${learned ? `# 从历史爆款中自动学习的最新特征（优先参考，这些来自近期真实爆款）\n\n${learned}\n` : ""}
# 本次任务

用户会提供一条短视频的原始口播文案。请执行 Skill 中的「改写文案」流程，把它改写成一条新的爆款短视频文案。

严格遵循 Skill 当前定义的标题数量、口播风格和质量检查规则，不要使用服务端旧规则覆盖 Skill。保留原文的核心信息，但不要逐句照抄。只输出爆款标题和完整口播正文，不输出结构拆解或其他解释。`;

  promptCache = { cacheKey, prompt };
  return prompt;
}

// ---------- 模型通道 ----------

function callClaude(system: string, user: string): Promise<string> {
  const bin = process.env.CLAUDE_CLI_PATH || "/usr/local/bin/claude";
  const env = { ...process.env };
  // 从 Claude Code 会话里启动 server 时会带上这个变量，触发嵌套保护，去掉即可
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  const args = ["-p", `${system}\n\n---\n\n${user}`, "--output-format", "text"];
  if (process.env.CLAUDE_MODEL) args.push("--model", process.env.CLAUDE_MODEL);

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: os.tmpdir(), env });
    child.stdin.end(); // CLI 会等 stdin 关闭，不关会一直挂着

    let out = "";
    let errOut = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (errOut += d));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("claude CLI 调用超时（180 秒）"));
    }, 180_000);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`claude CLI 退出码 ${code}：${errOut.trim().slice(0, 200)}`));
      }
      const text = out.trim();
      if (!text) return reject(new Error("claude CLI 返回内容为空"));
      resolve(text);
    });
  });
}

async function callDeepSeek(system: string, user: string): Promise<string> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("未配置 DEEPSEEK_API_KEY");
  const baseUrl = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
  const model = process.env.DEEPSEEK_MODEL || "deepseek-chat";

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 4096,
      temperature: 1.0,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let detail = body.slice(0, 200);
    try {
      detail = JSON.parse(body)?.error?.message || detail;
    } catch {
      // 非 JSON 错误体，用原文
    }
    throw new Error(`DeepSeek 接口返回 ${res.status}：${detail}`);
  }

  const json = await res.json();
  const content: string | undefined = json?.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek 返回内容为空");
  return content.trim();
}

/** 按配置的主通道调用模型，失败自动降级到备用通道。学习模块也复用这个入口。 */
export async function runLLM(system: string, user: string): Promise<string> {
  const provider = (process.env.REWRITE_PROVIDER || "claude").toLowerCase();
  const chain: Array<[string, (s: string, u: string) => Promise<string>]> =
    provider === "deepseek"
      ? [["deepseek", callDeepSeek], ["claude", callClaude]]
      : [["claude", callClaude], ["deepseek", callDeepSeek]];

  let lastError: unknown;
  for (const [name, fn] of chain) {
    try {
      return await fn(system, user);
    } catch (err) {
      console.error(`[rewrite] ${name} 通道失败：`, err instanceof Error ? err.message : err);
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("所有模型通道都不可用");
}

export interface RewriteResult {
  rewritten: string;
  skipped: boolean;
}

export async function rewriteTranscript(transcript: string): Promise<RewriteResult> {
  const rewritten = await runLLM(loadSystemPrompt(), transcript);
  return { rewritten, skipped: false };
}
