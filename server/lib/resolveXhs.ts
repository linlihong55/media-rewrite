import type { ResolvedVideo } from "./resolveVideo";

// 解析小红书视频笔记：直接抓笔记网页里的 window.__INITIAL_STATE__，不依赖第三方解析服务。
// 笔记链接需要带 xsec_token 参数（浏览器地址栏 / 分享链接里都有）。
// 匿名抓取偶尔会被风控拦截，可在 server/.env.local 配置 XHS_COOKIE 提高成功率。

const NOTE_PATH_RE = /\/(?:explore|discovery\/item|search_result)\/([0-9a-zA-Z]{15,32})/;

export function isXhsUrl(url: string): boolean {
  return url.includes("xiaohongshu.com") || url.includes("xhslink.com");
}

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9",
};

// 点赞/收藏数在页面数据里是字符串，热门笔记会写成 "1.2万" 这种形式
export function parseCount(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || !value) return 0;
  const m = value.match(/^([\d.]+)\s*(万|亿)?/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  if (m[2] === "亿") return Math.round(n * 1e8);
  if (m[2] === "万") return Math.round(n * 1e4);
  return Math.round(n);
}

function formatPublishTime(createTime: number): string {
  if (!createTime) return "";
  const d = new Date(createTime * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

// __INITIAL_STATE__ 是内联 JS 对象，里面的 undefined 不是合法 JSON，替换后再解析
function extractInitialState(html: string): Record<string, unknown> | null {
  const marker = "window.__INITIAL_STATE__=";
  const idx = html.indexOf(marker);
  if (idx < 0) return null;
  let raw = html.slice(idx + marker.length);
  const end = raw.indexOf("</script>");
  if (end >= 0) raw = raw.slice(0, end);
  raw = raw.trim().replace(/;$/, "");
  try {
    return JSON.parse(raw.replace(/:undefined(?=[,}\]])/g, ":null"));
  } catch {
    return null;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
interface XhsNote {
  type?: string;
  noteId?: string;
  title?: string;
  desc?: string;
  time?: number;
  tagList?: { name?: string }[];
  user?: { userId?: string; nickname?: string; nickName?: string };
  interactInfo?: Record<string, unknown>;
  video?: {
    consumer?: { originVideoKey?: string };
    media?: { stream?: Record<string, { masterUrl?: string; backupUrls?: string[] }[]> };
  };
}

function pickNote(state: Record<string, unknown>, noteId: string | null): XhsNote | null {
  const map = (state as any)?.note?.noteDetailMap;
  if (!map || typeof map !== "object") return null;
  if (noteId && map[noteId]?.note) return map[noteId].note as XhsNote;
  for (const key of Object.keys(map)) {
    if (map[key]?.note) return map[key].note as XhsNote;
  }
  return null;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// 正文里的话题写成 "#美食[话题]#"，清理成普通的 "#美食" 便于阅读
function cleanDesc(desc: string): string {
  return desc.replace(/#([^#\n]+?)\[话题\]#/g, "#$1").trim();
}

function extractHashtags(note: XhsNote, desc: string): string[] {
  const fromApi = (note.tagList ?? [])
    .map((t) => t?.name)
    .filter((name): name is string => Boolean(name));
  if (fromApi.length) return [...new Set(fromApi)];
  return [...new Set([...desc.matchAll(/#([^#\s]+)/g)].map((m) => m[1]))];
}

// 匿名访问时小红书会概率性返回"页面不见了"的风控页（状态码仍是 200，但没有笔记数据）。
// 记住服务端下发的匿名 Cookie 并在失败时自动重试几次，成功率能到 90% 以上。
const cookieJar = new Map<string, string>();

function mergeSetCookies(res: Response) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const kv = c.split(";")[0];
    const eq = kv.indexOf("=");
    if (eq > 0) cookieJar.set(kv.slice(0, eq).trim(), kv.slice(eq + 1));
  }
}

function cookieHeader(): string {
  // 配了真实登录 Cookie 就只用它（最稳），否则用累计的匿名 Cookie
  if (process.env.XHS_COOKIE) return process.env.XHS_COOKIE;
  return [...cookieJar].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function fetchNotePage(shareUrl: string): Promise<{ html: string; finalUrl: string }> {
  const headers = { ...BROWSER_HEADERS };
  const cookie = cookieHeader();
  if (cookie) headers.Cookie = cookie;

  let res: Response;
  try {
    // xhslink.com 短链会 302 到正式笔记页，fetch 默认跟随重定向
    res = await fetch(shareUrl, { headers, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new Error("访问小红书笔记页面失败，请检查网络后重试");
  }
  if (!res.ok) {
    throw new Error(`小红书笔记页面返回 ${res.status}，链接可能已失效`);
  }
  mergeSetCookies(res);
  return { html: await res.text(), finalUrl: res.url || shareUrl };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function resolveXhsVideo(shareUrl: string): Promise<ResolvedVideo> {
  let note: XhsNote | null = null;
  let noteId: string | null = null;

  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !note; attempt++) {
    const { html, finalUrl } = await fetchNotePage(shareUrl);
    noteId = finalUrl.match(NOTE_PATH_RE)?.[1] ?? shareUrl.match(NOTE_PATH_RE)?.[1] ?? null;
    const state = extractInitialState(html);
    note = state ? pickNote(state, noteId) : null;
    if (!note && attempt < MAX_ATTEMPTS) await sleep(800);
  }

  if (!note) {
    throw new Error(
      "解析小红书笔记失败（已自动重试）：链接可能缺少 xsec_token 参数（请直接复制浏览器地址栏的完整链接）、" +
        "笔记已被删除，或被风控拦截（可在 server/.env.local 配置 XHS_COOKIE 后重试）"
    );
  }

  if (note.type !== "video" || !note.video) {
    throw new Error("这条小红书笔记是图文笔记，没有视频可下载或转写");
  }

  // 优先用原片地址（无水印），h264 流地址做备用
  const stream = note.video.media?.stream ?? {};
  const streamMeta = stream.h264?.[0] ?? stream.h265?.[0] ?? stream.av1?.[0];
  const streamUrl = streamMeta?.masterUrl || streamMeta?.backupUrls?.[0];
  const originKey = note.video.consumer?.originVideoKey;
  const originUrl = originKey ? `https://sns-video-bd.xhscdn.com/${originKey}` : undefined;

  const noWatermarkUrl = originUrl || streamUrl;
  if (!noWatermarkUrl) {
    throw new Error("没拿到小红书视频下载地址，可能笔记数据结构有变化");
  }

  const desc = cleanDesc(note.desc ?? "");
  const createTime = note.time ? Math.floor(note.time / 1000) : 0;
  const user = note.user ?? {};
  const nickname = user.nickname || user.nickName || "";
  const interact = note.interactInfo ?? {};

  return {
    videoId: note.noteId || noteId || "",
    title: note.title || desc.split("\n")[0].trim(),
    desc,
    hashtags: extractHashtags(note, desc),
    createTime,
    publishTime: formatPublishTime(createTime),
    author: {
      nickname,
      uniqueId: user.userId ?? "",
      secUid: user.userId ?? "",
      profileUrl: user.userId
        ? `https://www.xiaohongshu.com/user/profile/${user.userId}`
        : "",
      followerCount: null, // 笔记页数据里没有博主粉丝数
    },
    stats: {
      diggCount: parseCount(interact.likedCount),
      collectCount: parseCount(interact.collectedCount),
      commentCount: parseCount(interact.commentCount),
      shareCount: parseCount(interact.shareCount),
    },
    noWatermarkUrl,
    noWatermarkUrlBackup: originUrl && streamUrl ? streamUrl : undefined,
    sourceUrl: shareUrl,
  };
}

// 笔记页数据里没有博主粉丝数（上面 followerCount 写死 null），
// 但匿名抓主页 /user/profile/<userId> 的 __INITIAL_STATE__ 里有，用于自动发现流程的粉丝数过滤。
// 主页展示的是近似值（如 "1万+"），parseCount 已经能处理「万/亿」格式，多出的 "+" 不影响匹配。
export async function fetchXhsFollowerCount(userId: string): Promise<number | null> {
  const profileUrl = `https://www.xiaohongshu.com/user/profile/${userId}`;
  let state: Record<string, unknown> | null = null;
  try {
    const { html } = await fetchNotePage(profileUrl);
    state = extractInitialState(html);
  } catch {
    return null;
  }
  if (!state) return null;

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const interactions: { type?: string; count?: string }[] =
    (state as any)?.user?.userPageData?.interactions ?? [];
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const fans = interactions.find((i) => i?.type === "fans");
  if (!fans?.count) return null;
  return parseCount(fans.count);
}
