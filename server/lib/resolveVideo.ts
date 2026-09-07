import { execFile } from "child_process";
import { promisify } from "util";
import { RESOLVER_BASE_URL, YTDLP_PATH } from "./paths";
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

const execFileAsync = promisify(execFile);

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
    if (refreshed) {
      try {
        return await resolveOnce(shareUrl);
      } catch {
        // 游客 Cookie 被风控时，继续使用本机 Chrome 登录态兜底。
      }
    }
    try {
      return await resolveWithYtDlp(shareUrl);
    } catch (fallbackError) {
      const detail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`抖音解析失败；Chrome 登录态备用解析也未成功：${detail}`, { cause: err });
    }
  }
}

interface YtDlpInfo {
  id?: string;
  title?: string;
  description?: string;
  timestamp?: number;
  upload_date?: string;
  uploader?: string;
  uploader_id?: string;
  channel_id?: string;
  webpage_url?: string;
  url?: string;
  like_count?: number;
  comment_count?: number;
  repost_count?: number;
  hashtags?: string[];
}

async function resolveWithYtDlp(shareUrl: string): Promise<ResolvedVideo> {
  const browser = process.env.DOUYIN_YTDLP_BROWSER ?? "chrome";
  const { stdout } = await execFileAsync(
    YTDLP_PATH,
    ["--cookies-from-browser", browser, "--no-playlist", "--dump-single-json", "--socket-timeout", "30", shareUrl],
    { timeout: 90_000, maxBuffer: 20 * 1024 * 1024 }
  );
  const data = JSON.parse(stdout) as YtDlpInfo;
  if (!data.id || !data.url) throw new Error("yt-dlp 未返回视频编号或下载地址");

  const desc = data.description ?? data.title ?? "";
  let createTime = data.timestamp ?? 0;
  if (!createTime && data.upload_date && /^\d{8}$/.test(data.upload_date)) {
    const d = data.upload_date;
    createTime = Math.floor(new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T00:00:00+08:00`).getTime() / 1000);
  }
  const authorId = data.uploader_id ?? data.channel_id ?? "";

  return {
    videoId: data.id,
    title: extractTitle(desc),
    desc,
    hashtags: Array.isArray(data.hashtags) ? data.hashtags.filter(Boolean) : extractHashtags(desc, null),
    createTime,
    publishTime: formatPublishTime(createTime),
    author: {
      nickname: data.uploader ?? "",
      uniqueId: authorId,
      secUid: data.channel_id ?? "",
      profileUrl: "",
      followerCount: null,
    },
    stats: {
      diggCount: data.like_count ?? 0,
      collectCount: 0,
      commentCount: data.comment_count ?? 0,
      shareCount: data.repost_count ?? 0,
    },
    noWatermarkUrl: data.url,
    sourceUrl: data.webpage_url ?? shareUrl,
  };
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
