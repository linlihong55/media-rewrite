// 小红书登录设置：登录一次，后续 search-xhs.mjs 和服务端均自动复用。
// 用法：cd e2e && node setup-xhs-cookie.mjs
//
// 做两件事：
//   1. 用固定 Profile 目录打开浏览器 → 你扫码登录 → Profile 持久保存登录态
//      （后续 search-xhs.mjs 直接复用，无需再次登录）
//   2. 把登录 Cookie 同步写入 server/.env.local 的 XHS_COOKIE
//      （服务端 resolveXhs.ts 用这个做 HTTP fetch 鉴权）
//
// Cookie 过期时重新运行本脚本即可。
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.resolve(__dirname, "../server/.env.local");
const STATE_PATH = path.resolve(__dirname, "../server/xhs-state.json");

// 与 search-xhs.mjs 共用同一个固定目录
const XHS_PROFILE_DIR = path.join(os.homedir(), ".config", "dhe-xhs-profile");

function writeEnvKey(key, value) {
  let content = "";
  try { content = fs.readFileSync(ENV_PATH, "utf-8"); } catch {}
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  content = re.test(content)
    ? content.replace(re, line)
    : (content ? `${content.trimEnd()}\n${line}\n` : `${line}\n`);
  fs.writeFileSync(ENV_PATH, content, "utf-8");
}

// 记录当前 web_session（若存在），用于检测新登录
let oldWebSession = "";
try {
  const envContent = fs.readFileSync(ENV_PATH, "utf-8");
  const line = envContent.split("\n").find((l) => l.trim().startsWith("XHS_COOKIE="));
  if (line) {
    const cookieStr = line.slice(line.indexOf("=") + 1).trim();
    const m = cookieStr.match(/(?:^|;)\s*web_session=([^;]+)/);
    if (m) oldWebSession = m[1].trim();
  }
} catch {}

console.log("打开小红书，请在浏览器里完成登录...");
if (oldWebSession) {
  console.log("（已有旧 session，等待新 web_session 被设置后才算登录成功）");
}
console.log("登录成功后触发 /tmp/xhs-login-done 文件即可。\n");

// 用固定 Profile 目录持久保存登录态，search-xhs.mjs 复制这个目录来用
fs.mkdirSync(XHS_PROFILE_DIR, { recursive: true });

const context = await chromium.launchPersistentContext(XHS_PROFILE_DIR, {
  headless: false,
  viewport: { width: 1440, height: 900 },
  locale: "zh-CN",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
});

try {
  const page = context.pages()[0] ?? (await context.newPage());
  // 搜索页会强制弹登录框，确保用户必须完成真实登录才能看到结果
  await page.goto(
    "https://www.xiaohongshu.com/search_result?keyword=AI&source=web_explore_feed",
    { waitUntil: "domcontentloaded", timeout: 60000 }
  ).catch(() => {});

  await page.waitForTimeout(3000);

  const SENTINEL = "/tmp/xhs-login-done";
  try { fs.unlinkSync(SENTINEL); } catch {}

  console.log("请在浏览器里完成登录（扫码或手机号均可）。");
  console.log("登录成功、看到搜索结果后，脚本会在 30 秒内自动检测到；");
  console.log("也可以手动在另一个终端运行 touch /tmp/xhs-login-done 加速。\n");

  // 检测登录：调用 user/me API，确认 guest=false 才算真正登录
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    if (fs.existsSync(SENTINEL)) break;

    // 通过 fetch user/me 判断是否是真实登录用户（guest=false）
    const isLoggedIn = await page.evaluate(async () => {
      try {
        const resp = await fetch("https://edith.xiaohongshu.com/api/sns/web/v2/user/me", {
          credentials: "include",
        });
        const json = await resp.json();
        return json?.data?.guest === false && !!json?.data?.user_id;
      } catch {
        return false;
      }
    }).catch(() => false);

    if (isLoggedIn) break;
  }
  try { fs.unlinkSync(SENTINEL); } catch {}

  const cookies = await context.cookies("https://www.xiaohongshu.com");
  if (!cookies.length) {
    console.error("没有拿到 Cookie，请确认已在浏览器里完成登录。");
    process.exit(1);
  }

  // 同步到 .env.local 供服务端 HTTP 请求使用
  const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  writeEnvKey("XHS_COOKIE", cookieStr);

  // 保存完整 storageState（含 cookie + localStorage），供 search-xhs.mjs 加载
  await context.storageState({ path: STATE_PATH });

  console.log(`已保存 ${cookies.length} 个 Cookie`);
  console.log(`  storageState：${STATE_PATH}  （search-xhs.mjs 加载此文件复用登录态）`);
  console.log(`  .env.local：XHS_COOKIE 已更新（服务端 HTTP 鉴权用）`);
  console.log("\n下一步：重启服务让新 Cookie 生效");
  console.log("  cd ../server && ./update-server.sh");
} finally {
  await context.close();
  // 不删除 XHS_PROFILE_DIR，search-xhs.mjs 需要复制它来复用登录态
}
