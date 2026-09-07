import { RESOLVER_BASE_URL } from "./paths";
import type { SearchHit } from "./discoveryTypes";

// 抖音关键词搜索：vendor 解析服务已经暴露通用的 X-Bogus 签名接口
// （/douyin/web/generate_x_bogus，对应 crawlers/douyin/web/web_crawler.py 里的 get_x_bogus），
// 不需要改 vendor 的 Python 代码——我们自己拼好搜索请求的完整 URL 交给它签名，
// 签完名之后这边直接带真实登录 Cookie 去请求抖音，真实 Cookie 全程只经过 Node，不落到 vendor 侧。
//
// 搜索接口要求真实登录态（游客 Cookie 会被拒绝，报「请先登录，再继续搜索吧」），
// 真实 Cookie 存在 server/.env.local 的 DOUYIN_LOGIN_COOKIE 里，失效了需要人工重新登录复制。

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// 照抄 crawlers/douyin/web/models.py 里 BaseRequestModel 的默认字段，
// 这样拼出来的请求参数和 vendor 自己发的请求一致，才能被同一套签名算法正确处理。
const BASE_PARAMS: Record<string, string | number> = {
  device_platform: "webapp",
  aid: "6383",
  channel: "channel_pc_web",
  pc_client_type: 1,
  version_code: "290100",
  version_name: "29.1.0",
  cookie_enabled: "true",
  screen_width: 1920,
  screen_height: 1080,
  browser_language: "zh-CN",
  browser_platform: "Win32",
  browser_name: "Chrome",
  browser_version: "130.0.0.0",
  browser_online: "true",
  engine_name: "Blink",
  engine_version: "130.0.0.0",
  os_name: "Windows",
  os_version: "10",
  cpu_core_num: 12,
  device_memory: 8,
  platform: "PC",
  downlink: "10",
  effective_type: "4g",
  from_user_page: "1",
  locate_query: "false",
  need_time_list: "1",
  pc_libra_divert: "Windows",
  publish_video_strategy_type: "2",
  round_trip_time: "0",
  show_live_replay_strategy: "1",
  time_list_query: "0",
  whale_cut_token: "",
  update_version_code: "170400",
};

// msToken 真实值需要请求 Douyin 的专门接口获取；vendor 项目本身在拿不到真实值时
// 也是靠这个「假 msToken」兜底（crawlers/douyin/web/utils.py 的 gen_false_msToken），
// 全项目大部分请求实际都走的这条兜底路径，所以这里直接生成假的，不用额外请求。
function fakeMsToken(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789=_-";
  let s = "";
  for (let i = 0; i < 126; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `${s}==`;
}

function buildSearchUrl(keyword: string, offset: number): string {
  const params: Record<string, string | number> = {
    ...BASE_PARAMS,
    // 中文关键词不先编码会导致 X-Bogus 签名崩溃（bytes must be in range(0, 256)），
    // 必须在拼进 URL 之前就转成 %xx 形式
    keyword: encodeURIComponent(keyword),
    offset,
    count: 20,
    sort_type: "0",
    publish_time: "0", // 不在这里限制发布时间，后面自己按 7 天精确过滤
    filter_duration: "0",
    msToken: fakeMsToken(),
  };
  const query = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return `https://www.douyin.com/aweme/v1/web/general/search/single/?${query}`;
}

async function signWithXBogus(url: string): Promise<string> {
  const endpoint = `${RESOLVER_BASE_URL}/api/douyin/web/generate_x_bogus?url=${encodeURIComponent(
    url
  )}&user_agent=${encodeURIComponent(UA)}`;
  let res: Response;
  try {
    res = await fetch(endpoint, { signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new Error("连不上本地解析服务（端口 18785），请先启动 vendor 目录的 start.py");
  }
  const json = await res.json();
  const signedUrl = json?.data?.url;
  if (!res.ok || typeof signedUrl !== "string") {
    throw new Error(`X-Bogus 签名失败：${json?.detail?.msg || json?.msg || `HTTP ${res.status}`}`);
  }
  return signedUrl;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapAwemeToHit(aweme: any): SearchHit | null {
  if (!aweme?.aweme_id) return null;
  const stats = aweme.statistics ?? {};
  return {
    platform: "douyin",
    contentId: String(aweme.aweme_id),
    url: `https://www.douyin.com/video/${aweme.aweme_id}`,
    roughDiggCount: typeof stats.digg_count === "number" ? stats.digg_count : 0,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function searchDouyinByKeyword(keyword: string): Promise<SearchHit[]> {
  const cookie = process.env.DOUYIN_LOGIN_COOKIE;
  if (!cookie) {
    throw new Error(
      "抖音搜索需要真实登录 Cookie：请在浏览器登录抖音网页版后，把 Cookie 整串复制到 server/.env.local 的 DOUYIN_LOGIN_COOKIE"
    );
  }

  const url = buildSearchUrl(keyword, 0);
  const signedUrl = await signWithXBogus(url);

  let res: Response;
  try {
    res = await fetch(signedUrl, {
      headers: {
        "User-Agent": UA,
        Referer: "https://www.douyin.com/",
        Cookie: cookie,
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error("请求抖音搜索接口失败，请检查网络后重试");
  }

  const json = await res.json();
  if (json?.status_msg?.includes("登录") || json?.status_code === 8) {
    throw new Error(
      "抖音搜索提示需要登录：DOUYIN_LOGIN_COOKIE 可能已失效，需要重新登录抖音网页版并更新 .env.local"
    );
  }
  if (!res.ok || !Array.isArray(json?.data)) {
    throw new Error(`抖音搜索失败（${res.status}）：${json?.status_msg || "返回数据格式不对"}`);
  }

  return json.data
    .map((item: { aweme_info?: unknown }) => mapAwemeToHit(item?.aweme_info))
    .filter((c: SearchHit | null): c is SearchHit => c !== null);
}

// 搜索结果里如果没带粉丝数，反查 vendor 已有的用户主页接口补齐
export async function fetchDouyinFollowerCount(secUid: string): Promise<number | null> {
  try {
    const endpoint = `${RESOLVER_BASE_URL}/api/douyin/web/handler_user_profile?sec_user_id=${encodeURIComponent(
      secUid
    )}`;
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(20_000) });
    const json = await res.json();
    const count = json?.data?.user?.follower_count;
    return typeof count === "number" ? count : null;
  } catch {
    return null;
  }
}
