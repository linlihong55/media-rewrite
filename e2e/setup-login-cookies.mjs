// 交互式登录脚本：依次帮你把抖音和小红书的登录 Cookie 写入 server/.env.local
// 用法：cd e2e && node setup-login-cookies.mjs
//
// 流程：
//   1. 打开抖音网页，等你扫码/账密登录 → 检测到登录成功 → 自动保存 DOUYIN_LOGIN_COOKIE
//   2. 打开小红书网页，等你登录 → 检测到登录成功 → 自动保存 XHS_COOKIE

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.resolve(__dirname, "../server/.env.local");

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function readEnv() {
  try {
    return fs.readFileSync(ENV_PATH, "utf-8");
  } catch {
    return "";
  }
}

function writeEnvKey(key, value) {
  let content = readEnv();
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(content)) {
    content = content.replace(re, line);
  } else {
    content = content ? `${content.trimEnd()}\n${line}\n` : `${line}\n`;
  }
  fs.writeFileSync(ENV_PATH, content, "utf-8");
}

function cookiesToHeaderString(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

// 轮询直到出现目标 cookie 名称（表示已登录），最多等 maxSec 秒
async function waitForLogin(context, domain, cookieNames, maxSec = 180) {
  const deadline = Date.now() + maxSec * 1000;
  while (Date.now() < deadline) {
    const cookies = await context.cookies(domain);
    if (cookieNames.some((n) => cookies.find((c) => c.name === n && c.value))) {
      return cookies;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

// ─── 抖音 ────────────────────────────────────────────────────────────────────

async function setupDouyin() {
  console.log("\n=== 第 1 步：抖音登录 ===");
  console.log("浏览器会打开抖音首页，请在页面里完成登录（扫码或账密均可）。");
  console.log("登录成功后脚本自动继续，无需任何操作。\n");

  const context = await chromium.launchPersistentContext("", {
    headless: false,
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("https://www.douyin.com/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // 等页面初始化，给用户时间看到页面
    await page.waitForTimeout(3000);

    // 如果已经有登录弹窗，不需要用户额外操作；否则可能需要手动点「登录」
    console.log("等待你登录（最多 3 分钟）...");
    // 抖音登录成功后会有 uid_tt 或 sessionid_ss cookie
    const cookies = await waitForLogin(
      context,
      "https://www.douyin.com",
      ["uid_tt", "sessionid_ss", "passport_uid"],
      180
    );

    if (!cookies) {
      console.error("超时未检测到登录，跳过抖音 Cookie 配置。");
      return false;
    }

    const cookieStr = cookiesToHeaderString(cookies);
    writeEnvKey("DOUYIN_LOGIN_COOKIE", cookieStr);
    console.log(`已保存 ${cookies.length} 个抖音 Cookie 到 .env.local (DOUYIN_LOGIN_COOKIE)`);
    return true;
  } finally {
    await context.close();
  }
}

// ─── 小红书 ──────────────────────────────────────────────────────────────────

async function setupXhs() {
  console.log("\n=== 第 2 步：小红书登录 ===");
  console.log("浏览器会打开小红书首页，请在页面里完成登录。");
  console.log("登录成功后脚本自动继续，无需任何操作。\n");

  const context = await chromium.launchPersistentContext("", {
    headless: false,
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("https://www.xiaohongshu.com/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await page.waitForTimeout(3000);

    console.log("等待你登录（最多 3 分钟）...");
    // 小红书登录后会有 web_session cookie
    const cookies = await waitForLogin(
      context,
      "https://www.xiaohongshu.com",
      ["web_session"],
      180
    );

    if (!cookies) {
      console.error("超时未检测到登录，跳过小红书 Cookie 配置。");
      return false;
    }

    const cookieStr = cookiesToHeaderString(cookies);
    writeEnvKey("XHS_COOKIE", cookieStr);
    console.log(`已保存 ${cookies.length} 个小红书 Cookie 到 .env.local (XHS_COOKIE)`);
    return true;
  } finally {
    await context.close();
  }
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

console.log("Cookie 配置脚本启动");
console.log(`配置文件：${ENV_PATH}\n`);

const douyinOk = await setupDouyin();
const xhsOk = await setupXhs();

console.log("\n=== 完成 ===");
if (douyinOk) console.log("抖音 DOUYIN_LOGIN_COOKIE: 已写入");
else console.log("抖音 DOUYIN_LOGIN_COOKIE: 跳过（需手动配置）");
if (xhsOk) console.log("小红书 XHS_COOKIE: 已写入");
else console.log("小红书 XHS_COOKIE: 跳过（需手动配置）");

if (douyinOk || xhsOk) {
  console.log("\n下一步：重启服务让新 Cookie 生效");
  console.log("  cd ../server && ./update-server.sh");
}
