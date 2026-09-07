import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { PROJECT_ROOT } from "./paths";
import { parseCount } from "./resolveXhs";
import type { SearchHit } from "./discoveryTypes";

const execFileAsync = promisify(execFile);

// 小红书搜索页没有可复用的签名接口，走 e2e/search-xhs.mjs 里的 Playwright 有头脚本，
// 和现有 refreshDouyinCookie() 调用 e2e 脚本的模式一致（execFile 出去跑，解析 stdout）。
export async function searchXhsByKeyword(keyword: string): Promise<SearchHit[]> {
  let stdout: string;
  try {
    const result = await execFileAsync("node", ["search-xhs.mjs", keyword], {
      cwd: path.join(PROJECT_ROOT, "e2e"),
      timeout: 120_000,
      maxBuffer: 1024 * 1024 * 10,
    });
    stdout = result.stdout;
  } catch (err) {
    const stdout2 = (err as { stdout?: string })?.stdout;
    throw new Error(
      `小红书搜索脚本执行失败：${extractErrorMessage(stdout2) || (err instanceof Error ? err.message : String(err))}`
    );
  }

  const errorMessage = extractErrorMessage(stdout);
  if (errorMessage) throw new Error(`小红书搜索失败：${errorMessage}`);

  let items: { noteId: string; url: string; likeText: string }[];
  try {
    items = JSON.parse(stdout.trim().split("\n").pop() || "[]");
  } catch {
    throw new Error("小红书搜索脚本输出格式不对");
  }

  return items.map((it) => ({
    platform: "xhs" as const,
    contentId: it.noteId,
    url: it.url,
    roughDiggCount: parseCount(it.likeText),
  }));
}

function extractErrorMessage(stdout?: string): string | null {
  if (!stdout) return null;
  const lastLine = stdout.trim().split("\n").pop() || "";
  try {
    const parsed = JSON.parse(lastLine);
    return typeof parsed?.error === "string" ? parsed.error : null;
  } catch {
    return null;
  }
}
