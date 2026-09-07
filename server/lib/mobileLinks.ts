export type MobilePlatform = "douyin" | "xhs";

const URL_RE = /https?:\/\/[^\s<>"']+/giu;
const TRAILING_PUNCTUATION = /[，。；、！？!?,.;:）)】\]]+$/u;

export function parseSharedVideoLink(sourceText: string): {
  url: string;
  platform: MobilePlatform;
} {
  if (typeof sourceText !== "string" || !sourceText.trim()) throw new Error("请粘贴视频分享链接");
  if (sourceText.length > 8_000) throw new Error("分享内容过长");
  const candidates = (sourceText.match(URL_RE) ?? []).map((url) => url.replace(TRAILING_PUNCTUATION, ""));
  for (const url of candidates) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.protocol !== "https:") continue;
    const host = parsed.hostname.toLowerCase();
    if (host === "v.douyin.com" || host === "www.douyin.com" || host === "douyin.com") {
      return { url: parsed.toString(), platform: "douyin" };
    }
    if (
      host === "xhslink.com" || host.endsWith(".xhslink.com") ||
      host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com")
    ) {
      return { url: parsed.toString(), platform: "xhs" };
    }
  }
  throw new Error("没有识别到受支持的抖音或小红书 HTTPS 链接");
}

