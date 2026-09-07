import fs from "fs";
import path from "path";
import { runLLM } from "./rewrite";
import { OBSIDIAN_RULES_DIR, buildBreakdownFilePath } from "./paths";
import { ResolvedVideo } from "./resolveVideo";

const RULES_PATH = path.join(OBSIDIAN_RULES_DIR, "02_拆解规则.md");

function loadSystemPrompt(): string {
  let rules: string;
  try {
    rules = fs.readFileSync(RULES_PATH, "utf-8");
  } catch {
    throw new Error(
      `读不到拆解规则文件：${RULES_PATH}（请确认 Obsidian 所在的外置硬盘已挂载）`
    );
  }

  return `你是短视频爆款文案拆解专家，需要按照下面的「拆解规则」逐条分析用户提供的口播文案。

# 拆解规则

${rules}

# 输出要求

第一行输出：主题：xxx（8 字以内，概括这条文案的核心主题，用于文件命名，不要包含标点符号）

空一行后，按拆解规则里的问题顺序，逐条给出编号和分析结果，每条尽量具体、结合原文举例，不要泛泛而谈。

全程使用中文，只输出主题行和拆解结果，不要输出其他解释。`;
}

export interface BreakdownResult {
  topic: string;
  breakdown: string;
  filePath: string;
}

function parseTopicAndBody(raw: string): { topic: string; body: string } {
  const lines = raw.trim().split("\n");
  const firstLine = lines[0] ?? "";
  const match = firstLine.match(/^主题[:：]\s*(.+)$/);
  if (!match) {
    return { topic: "未命名", body: raw.trim() };
  }
  const topic = match[1].trim();
  const body = lines.slice(1).join("\n").trim();
  return { topic, body };
}

function formatCount(n: number | null): string {
  return n == null ? "未知" : String(n);
}

function buildMarkdown(video: ResolvedVideo, transcript: string, breakdownBody: string): string {
  const tags = video.hashtags?.length ? video.hashtags.map((t) => `#${t}`).join(" ") : "（无）";
  return `# ${video.title || "（无标题）"}

- 原链接：${video.sourceUrl}
- 标题：${video.title}
- 正文：${video.desc}
- 标签：${tags}
- 发布时间：${video.publishTime}
- 账号：${video.author.nickname}（${video.author.profileUrl}）
- 粉丝数：${formatCount(video.author.followerCount)}
- 点赞数：${video.stats.diggCount}
- 收藏数：${video.stats.collectCount}

## 原文案

${transcript}

## 拆解结果

${breakdownBody}
`;
}

export async function breakdownTranscript(
  video: ResolvedVideo,
  transcript: string
): Promise<BreakdownResult> {
  const raw = await runLLM(loadSystemPrompt(), transcript);
  const { topic, body } = parseTopicAndBody(raw);

  const filePath = buildBreakdownFilePath(topic);
  const markdown = buildMarkdown(video, transcript, body);
  try {
    await fs.promises.writeFile(filePath, markdown, "utf-8");
  } catch (err) {
    throw new Error(
      `写入拆解结果失败：${filePath}（请确认 Obsidian 所在的外置硬盘已挂载）：${
        err instanceof Error ? err.message : err
      }`
    );
  }

  return { topic, breakdown: body, filePath };
}
