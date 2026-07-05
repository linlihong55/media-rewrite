import fs from "fs";
import { ResolvedVideo } from "./resolveVideo";
import { runLLM, LEARNED_PATH } from "./rewrite";

// 每次存档后自动学习：把新提取的爆款文案交给模型分析，
// 增量更新特征库 learned-patterns.md（容量封顶），改写时自动带上。
const ANALYST_PROMPT = `你是短视频爆款文案分析师。你维护着一份「爆款文案特征库」，用于指导后续的文案改写。

用户会给你两部分内容：
1. 现有的特征库（可能为空）
2. 一条新的真实爆款视频口播文案（附带互动数据）

请把新文案中值得复用的特征合并进特征库，输出更新后的完整特征库。要求：
- 保持以下五个固定小节：## 标题特征、## 开头钩子、## 结构套路、## 语言风格、## 高频词与句式
- 每条特征一行，句式具体可复用（写成可直接套用的模式，不写空泛结论）
- 与现有条目重复或相近的，合并成一条并在行尾用（出现N次）累计次数；次数多的排前面
- 每个小节最多 8 条，优先保留出现次数多、互动数据高的特征
- 总长度不超过 2500 字
- 只输出特征库 markdown 本身，不要任何解释和开场白`;

export async function learnFromTranscript(
  video: ResolvedVideo,
  transcript: string
): Promise<void> {
  if (!transcript || transcript.trim().length < 50) return; // 太短的没有学习价值

  let existing = "（特征库目前为空）";
  try {
    existing = fs.readFileSync(LEARNED_PATH, "utf-8");
  } catch {
    // 首次学习
  }

  const user = `# 现有特征库

${existing}

# 新爆款文案

标题：${video.title || "（无）"}
互动数据：点赞 ${video.stats.diggCount}，收藏 ${video.stats.collectCount}，作者粉丝 ${
    video.author.followerCount ?? "未知"
  }

口播文案：
${transcript}`;

  const updated = await runLLM(ANALYST_PROMPT, user);
  // 模型偶尔会包一层代码块，剥掉
  const cleaned = updated.replace(/^```(?:markdown)?\s*/, "").replace(/\s*```$/, "").trim();
  if (!cleaned.includes("## 标题特征")) {
    throw new Error("学习结果格式不对，本次不更新特征库");
  }
  await fs.promises.writeFile(LEARNED_PATH, `${cleaned}\n`, "utf-8");
  console.log(`[learn] 特征库已更新（${cleaned.length} 字），来源视频：${video.videoId}`);
}
