// 一键刷新抖音 Cookie：解析视频报「Cookie 过期」时运行本脚本即可。
// 流程：无痕浏览器访问抖音拿新游客 Cookie → 更新解析服务 config.yaml →
//       重启解析服务（start.py）→ 用真实视频验证解析成功。
// 用法：cd e2e && node refresh-douyin-cookie.mjs
import { chromium } from "playwright";
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = path.resolve(__dirname, "../vendor/Douyin_TikTok_Download_API");
const CONFIG_PATH = path.join(VENDOR_DIR, "crawlers/douyin/web/config.yaml");
const TEST_VIDEO = "https://www.douyin.com/video/7651595506838322787";

// 1. 取新 Cookie
console.log("1/4 打开抖音获取新的游客 Cookie...");
const context = await chromium.launchPersistentContext("", {
  headless: false,
  viewport: { width: 1440, height: 900 },
  locale: "zh-CN",
});
let cookieStr;
try {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("https://www.douyin.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(8000);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(4000);
  const cookies = await context.cookies("https://www.douyin.com");
  cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  if (!cookieStr.includes("ttwid=")) throw new Error("没拿到 ttwid，请重试");
} finally {
  await context.close();
}
console.log(`   拿到 ${cookieStr.split("; ").length} 个 Cookie`);

// 2. 更新配置（自动备份）
console.log("2/4 更新解析服务配置...");
const config = fs.readFileSync(CONFIG_PATH, "utf-8");
fs.writeFileSync(`${CONFIG_PATH}.bak`, config);
const updated = config.replace(/^(\s*)Cookie: .*$/m, (_, indent) => `${indent}Cookie: ${cookieStr}`);
if (updated === config) throw new Error("config.yaml 里没找到 Cookie 行");
fs.writeFileSync(CONFIG_PATH, updated);

// 3. 重启解析服务，让新 Cookie 生效
// 解析服务由 LaunchAgent 托管（KeepAlive），必须用 launchctl 重启才能重新读取 config.yaml；
// 直接 pkill 会被 launchd 用旧配置立刻拉起，且会和常驻进程抢 18785 端口。
console.log("3/4 重启解析服务...");
try {
  const uid = execSync("id -u").toString().trim();
  execSync(`launchctl kickstart -k gui/${uid}/com.douyin-hit-extractor.resolver`, {
    shell: "/bin/zsh",
  });
} catch {
  // 没用 LaunchAgent 托管时（比如别的机器上手动跑），退回手动重启
  try {
    execSync("pkill -f 'uvicorn app.main:app'; pkill -f 'python start.py'; true", {
      shell: "/bin/zsh",
    });
  } catch {
    // 服务本来没在跑也没关系
  }
  await new Promise((r) => setTimeout(r, 2000));
  const resolver = spawn(path.join(VENDOR_DIR, ".venv/bin/python"), ["start.py"], {
    cwd: VENDOR_DIR,
    detached: true,
    stdio: "ignore",
  });
  resolver.unref();
}

for (let i = 0; i < 30; i++) {
  try {
    const res = await fetch("http://localhost:18785/docs");
    if (res.ok) break;
  } catch {
    // 还在启动
  }
  await new Promise((r) => setTimeout(r, 1000));
}

// 4. 验证
console.log("4/4 验证解析...");
const res = await fetch(
  `http://localhost:18785/api/hybrid/video_data?url=${encodeURIComponent(TEST_VIDEO)}&minimal=true`,
  { signal: AbortSignal.timeout(40000) }
);
const json = await res.json();
if (json.code === 200 && json.data?.video_id) {
  console.log(`✅ Cookie 刷新成功，解析正常（测试视频作者：${json.data.author?.nickname}）`);
} else {
  console.log(`❌ 解析仍失败：${JSON.stringify(json).slice(0, 200)}`);
  console.log("   游客 Cookie 可能被风控，建议在浏览器登录抖音后手动复制 Cookie 到 config.yaml");
  process.exit(1);
}
