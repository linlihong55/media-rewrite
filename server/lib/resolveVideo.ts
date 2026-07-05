import { RESOLVER_BASE_URL } from "./paths";
import { refreshDouyinCookie } from "./refreshCookie";
import { isXhsUrl, resolveXhsVideo } from "./resolveXhs";

export interface ResolvedVideo {
  videoId: string;
  /** 标题：正文去掉话题标签后的第一行 */
  title: string;
  desc: string;
  /** 话题标签（不含 # 前缀） */
  hashtags: string[];
  createTime: number;
  /** 发布时间，本地时区格式化（YYYY-MM-DD HH:mm） */
  publishTime: string;
  author: {
    nickname: string;
    uniqueId: string;
    secUid: string;
    profileUrl: string;
    /** 博主粉丝数，接口没返回时为 null */
    followerCount: number | null;
  };
  stats: {
    diggCount: number;
    collectCount: number;
    commentCount: number;
    shareCount: number;
  };
  noWatermarkUrl: string;
  /** 备用下载地址（非 HQ），主地址偶发 403 时降级使用 */
  noWatermarkUrlBackup?: string;
  sourceUrl: string;
}

function formatPublishTime(createTime: number): string {
  if (!createTime) return "";
  const d = new Date(createTime * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

interface TextExtraItem {
  hashtag_name?: string;
}

function extractHashtags(desc: string, textExtra: unknown): string[] {
  const fromApi = Array.isArray(textExtra)
    ? (textExtra as TextExtraItem[])
        .map((item) => item?.hashtag_name)
        .filter((name): name is string => Boolean(name))
    : [];
  if (fromApi.length) return [...new Set(fromApi)];
  // 兜底：从正文里解析 #话题
  return [...new Set([...desc.matchAll(/#([^#\s]+)/g)].map((m) => m[1]))];
}

function extractTitle(desc: string): string {
  const withoutTags = desc.replace(/#[^#\s]+/g, " ").replace(/\s+/g, " ").trim();
  return withoutTags.split("\n")[0].trim();
}

// 按链接自动分流：小红书走网页解析（lib/resolveXhs.ts），抖音走本地解析服务。
// 抖音失败时自动刷新 Cookie（最常见的失效原因）并重试一次
export async function resolveVideo(shareUrl: string): Promise<ResolvedVideo> {
  if (isXhsUrl(shareUrl)) return resolveXhsVideo(shareUrl);
  try {
    return await resolveOnce(shareUrl);
  } catch (err) {
    const refreshed = await refreshDouyinCookie();
    if (!refreshed) throw err;
    return await resolveOnce(shareUrl);
  }
}

async function resolveOnce(shareUrl: string): Promise<ResolvedVideo> {
  const endpoint = `${RESOLVER_BASE_URL}/api/hybrid/video_data?url=${encodeURIComponent(
    shareUrl
  )}&minimal=true`;

  let res: Response;
  try {
    res = await fetch(endpoint, { signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new Error("连不上本地解析服务（端口 18785），请先启动 vendor 目录的 start.py");
  }
  if (!res.ok) {
    throw new Error(
      `解析失败（${res.status}）：链接无效或抖音 Cookie 失效（已自动尝试刷新 Cookie）。请确认链接能正常打开后重试`
    );
  }

  const json = await res.json();
  if (json.code !== 200 || !json.data) {
    throw new Error("解析失败：拿到的数据格式不对，可能是链接无效或 Cookie 已过期");
  }

  const data = json.data;
  const stats = data.statistics ?? {};
  const author = data.author ?? {};
  const videoData = data.video_data ?? {};

  const noWatermarkUrl: string | undefined =
    videoData.nwm_video_url_HQ || videoData.nwm_video_url;
  const noWatermarkUrlBackup: string | undefined =
    videoData.nwm_video_url && videoData.nwm_video_url !== noWatermarkUrl
      ? videoData.nwm_video_url
      : undefined;

  if (!noWatermarkUrl) {
    throw new Error("没拿到无水印视频地址，可能这条链接不是视频（比如图集）或解析服务需要更新 Cookie");
  }

  const desc: string = data.desc ?? "";
  const createTime: number = data.create_time ?? 0;

  return {
    videoId: data.video_id,
    title: extractTitle(desc),
    desc,
    hashtags: extractHashtags(desc, data.hashtags),
    createTime,
    publishTime: formatPublishTime(createTime),
    author: {
      nickname: author.nickname ?? "",
      uniqueId: author.unique_id ?? "",
      secUid: author.sec_uid ?? "",
      profileUrl: author.sec_uid
        ? `https://www.douyin.com/user/${author.sec_uid}`
        : "",
      followerCount:
        typeof author.follower_count === "number" ? author.follower_count : null,
    },
    stats: {
      diggCount: stats.digg_count ?? 0,
      collectCount: stats.collect_count ?? 0,
      commentCount: stats.comment_count ?? 0,
      shareCount: stats.share_count ?? 0,
    },
    noWatermarkUrl,
    noWatermarkUrlBackup,
    sourceUrl: shareUrl,
  };
}
