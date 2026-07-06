// 诊断脚本：抖音 + 小红书两个平台上，悬浮面板的注入 / 握手 / 自动识别状态
import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, "../extension");
const DOUYIN_URL = "https://www.douyin.com/video/7306059512456744227";

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dhe-diag-"));
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  viewport: { width: 1440, height: 900 },
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    "--lang=zh-CN",
  ],
});

async function inspect(page, label) {
  const logs = [];
  page.on("console", (m) => logs.push(`[page ${m.type()}] ${m.text().slice(0, 200)}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${String(e).slice(0, 200)}`));

  const report = { label };
  try {
    await page.locator("#dhe-frame").waitFor({ state: "attached", timeout: 15000 });
    report.iframe = true;
  } catch {
    report.iframe = false;
  }

  await page.waitForTimeout(4000); // 等 tick + 握手

  const panel = page.frame({ url: (u) => u.href.includes("content/panel.html") });
  if (panel) {
    report.panelFrame = true;
    try {
      report.referrer = await panel.evaluate(() => document.referrer);
      report.dotClass = await panel.locator("#dot").getAttribute("class");
      report.urlValue = await panel.locator("#url").inputValue();
      report.status = await panel.locator("#status").textContent();
    } catch (e) {
      report.panelEvalError = String(e).slice(0, 150);
    }
  } else {
    report.panelFrame = false;
  }
  // iframe 尺寸（握手失败时会是初始值）
  try {
    report.frameRect = await page
      .locator("#dhe-frame")
      .evaluate((el) => `${el.style.width}x${el.style.height} @${el.style.top},${el.style.left}`);
  } catch {}
  report.consoleTail = logs.slice(-8);
  console.log("\n=====", label, "=====\n", JSON.stringify(report, null, 2));
  return report;
}

try {
  // --- 抖音 ---
  const dy = await context.newPage();
  await dy.goto(DOUYIN_URL, { waitUntil: "commit", timeout: 45000 }).catch((e) => console.log("douyin goto:", e.message));
  await inspect(dy, "抖音视频页");

  // --- 小红书：先从 explore 拿一个带 token 的视频笔记链接 ---
  const xhs = await context.newPage();
  await xhs.goto("https://www.xiaohongshu.com/explore", { waitUntil: "commit", timeout: 45000 }).catch((e) => console.log("xhs goto:", e.message));
  await xhs.waitForTimeout(5000);
  const noteHref = await xhs.evaluate(() => {
    const anchors = [...document.querySelectorAll('a[href*="xsec_token"]')];
    const a = anchors.find((el) => el.href.includes("/explore/"));
    return a ? a.getAttribute("href") : null;
  });
  console.log("\n小红书 feed 拿到的笔记链接:", noteHref);
  if (noteHref) {
    await xhs.goto(new URL(noteHref, "https://www.xiaohongshu.com").href, { waitUntil: "commit", timeout: 45000 }).catch((e) => console.log("note goto:", e.message));
  }
  await inspect(xhs, "小红书笔记页");
} finally {
  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
