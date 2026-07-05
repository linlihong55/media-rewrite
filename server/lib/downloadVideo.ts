import fs from "fs";
import path from "path";
import { todayOutputDir } from "./paths";

// 视频 CDN 对不带浏览器头的请求会偶发 403，统一带上 UA + 对应平台的 Referer
function browserHeaders(url: string) {
  const isXhs = /xhscdn\.com|xiaohongshu\.com/.test(url);
  return {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    Referer: isXhs ? "https://www.xiaohongshu.com/" : "https://www.douyin.com/",
  };
}

export async function downloadVideoFile(
  urls: string | (string | undefined)[],
  videoId: string,
  targetDir?: string
): Promise<string> {
  const candidates = (Array.isArray(urls) ? urls : [urls]).filter(
    (u): u is string => Boolean(u)
  );
  if (!candidates.length) throw new Error("没有可用的视频下载地址");

  const dir = targetDir ?? todayOutputDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${videoId}.mp4`);

  // 每个候选地址试两次（网络瞬时失败重试），主地址 403 时自动降级到备用地址
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const url of candidates) {
      try {
        const res = await fetch(url, {
          headers: browserHeaders(url),
          signal: AbortSignal.timeout(120_000),
        });
        if (!res.ok || !res.body) {
          throw new Error(`视频下载失败，状态码 ${res.status}`);
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        await fs.promises.writeFile(filePath, buffer);
        return filePath;
      } catch (err) {
        lastError = err;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("视频下载失败");
}
