// 小红书关键词搜索：真实的搜索结果页由前端异步请求带签名（x-s/x-s-common）的接口拿数据，
// 项目里没有实现那套签名算法，所以改用 Playwright 有头模式模拟真人打开搜索页，
// 等结果渲染完之后直接解析 DOM。
//
// 用法：node search-xhs.mjs <关键词>
// 输出：一行 JSON 数组打印到 stdout；失败时打印 {"error": "..."} 并以非零码退出。
//
// 登录态：从 server/.env.local 的 XHS_COOKIE 注入（含 web_session 等 HttpOnly Cookie）。
// Cookie 过期时运行 node setup-xhs-cookie.mjs 重新登录一次即可，无需改代码。
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadXhsCookies() {
  const envPath = path.resolve(__dirname, "../server/.env.local");
  try {
    const content = fs.readFileSync(envPath, "utf-8");
    const line = content.split("\n").find((l) => l.trim().startsWith("XHS_COOKIE="));
    if (!line) return [];
    const cookieStr = line.slice(line.indexOf("=") + 1).trim();
    return cookieStr
      .split(";")
      .map((kv) => kv.trim())
      .filter(Boolean)
      .map((kv) => {
        const eq = kv.indexOf("=");
        return {
          name: kv.slice(0, eq).trim(),
          value: kv.slice(eq + 1).trim(),
          domain: ".xiaohongshu.com",
          path: "/",
          secure: false,
          httpOnly: false,
          sameSite: "Lax",
        };
      });
  } catch {
    return [];
  }
}

function fail(message) {
  console.log(JSON.stringify({ error: message }));
  process.exit(1);
}

const keyword = process.argv[2];
if (!keyword) fail("缺少关键词参数");

// 用 storageState 加载登录态（setup-xhs-cookie.mjs 登录后保存的 JSON）
// 相比复制 Profile，storageState 能精确保存登录时的真实 cookie 值，不受 SQLite 加密/写入延迟影响
const STATE_PATH = path.resolve(__dirname, "../server/xhs-state.json");
if (!fs.existsSync(STATE_PATH)) {
  fail("未找到登录状态文件，请先运行 node setup-xhs-cookie.mjs 完成登录");
}

const browser = await chromium.launch({
  headless: false,
  args: ["--no-first-run", "--no-default-browser-check"],
});
const context = await browser.newContext({
  storageState: STATE_PATH,
  viewport: { width: 1440, height: 900 },
  locale: "zh-CN",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
});

try {
  const page = await context.newPage();
  // 先加载首页让 session 就绪，再跳搜索页（直接跳搜索页有时 commit 会卡死）
  await page
    .goto("https://www.xiaohongshu.com/explore", {
      waitUntil: "commit",
      timeout: 20000,
    })
    .catch(() => {});
  const searchUrl = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(
    keyword
  )}&source=web_explore_feed`;
  await page.goto(searchUrl, { waitUntil: "commit", timeout: 30000 }).catch(() => {});

  // 等有 data-note-id 的真实卡片（骨架屏没有这个属性），最多等 30 秒
  await page
    .waitForSelector("section.note-item[data-note-id]", { timeout: 30000 })
    .catch(async () => {
      // 超时：区分「游客被拦截」和「其他失败」
      const loginBlocked = await page
        .locator("text=登录后查看搜索结果")
        .count()
        .catch(() => 0);
      if (loginBlocked > 0) {
        fail("小红书要求登录才能看搜索结果，请运行 node setup-xhs-cookie.mjs 重新登录");
      }
    });

  const items = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll("section.note-item"));
    return cards
      .map((card) => {
        // noteId 直接从 data 属性拿，最稳定
        const noteId = card.dataset.noteId || "";
        // 标题链接在 .footer .title，href 带 xsec_token，resolve 小红书笔记必须有它
        const titleLink = card.querySelector(".footer .title, .footer a.title");
        const href = titleLink?.getAttribute("href") || "";
        const titleText = titleLink?.textContent?.trim() || "";
        // 点赞数：span.count 是真实文本节点
        const likeEl = card.querySelector("span.count");
        // 作者名
        const authorEl = card.querySelector("span.name");
        return {
          noteId,
          href,
          title: titleText,
          author: authorEl?.textContent?.trim() || "",
          likeText: likeEl?.textContent?.trim() || "0",
        };
      })
      .filter((it) => it.noteId);
  });

  if (!items.length) fail("没有解析到搜索结果，可能是选择器需要更新或被风控拦截（需要登录态）");

  const results = items.slice(0, 20).map((it) => {
    // href 可能是相对路径（/explore/<id>?xsec_token=...），补全为绝对 URL
    const url = it.href.startsWith("http")
      ? it.href
      : `https://www.xiaohongshu.com${it.href}`;
    return {
      noteId: it.noteId,
      url,
      title: it.title,
      author: it.author,
      likeText: it.likeText,
    };
  });

  console.log(JSON.stringify(results));
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
} finally {
  await browser.close();
}
