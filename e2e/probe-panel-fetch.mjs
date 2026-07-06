// 探针：在小红书页面的面板 iframe 内部直接测 localhost:3300 连通性，
// 并点击「提取文案」后持续观察面板状态与 iframe 是否被页面重建
import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, "../extension");
const NOTE_URL = process.argv[2];

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dhe-probe-"));
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  viewport: { width: 1440, height: 900 },
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--lang=zh-CN"],
});

const getPanel = async (page) => {
  for (let i = 0; i < 30; i++) {
    const f = page.frame({ url: (u) => u.href.includes("content/panel.html") });
    if (f) return f;
    await page.waitForTimeout(1000);
  }
  throw new Error("panel 未加载");
};

try {
  const page = context.pages()[0] ?? (await context.newPage());
  await context.route(/xiaohongshu\.com\/(login|404)/, (r) => r.abort());
  await page.goto(NOTE_URL, { waitUntil: "commit", timeout: 45000 }).catch(() => {});

  let panel = await getPanel(page);
  await panel.locator("#dot.on").waitFor({ state: "attached", timeout: 20000 });
  console.log("面板就绪，URL 已识别");

  // 1) 面板内直接测 health 接口
  const health = await panel.evaluate(async () => {
    const t0 = Date.now();
    try {
      const res = await Promise.race([
        fetch("http://localhost:3300/api/health").then((r) => `status=${r.status}`),
        new Promise((_, rej) => setTimeout(() => rej(new Error("10s 超时")), 10000)),
      ]);
      return `${res} 用时${Date.now() - t0}ms`;
    } catch (e) {
      return `失败: ${e.message} 用时${Date.now() - t0}ms`;
    }
  });
  console.log("面板内 fetch /api/health →", health);

  // 2) 点击提取文案，观察 3 分钟
  await panel.locator("#btn-transcribe").click();
  console.log("已点击「提取文案」，开始观察...");
  const frameUrlAt = (f) => f.url().slice(-30);
  let lastStatus = "";
  for (let i = 0; i < 36; i++) {
    await page.waitForTimeout(5000);
    let cur;
    try {
      cur = await getPanel(page);
      const status = await cur.locator("#status").textContent();
      const transcript = await cur.locator("#transcript").inputValue();
      const line = `[${(i + 1) * 5}s] status=「${status}」 transcript=${transcript.length}字 frame=${frameUrlAt(cur)}`;
      if (line.replace(/^\[\d+s\] /, "") !== lastStatus) {
        console.log(line);
        lastStatus = line.replace(/^\[\d+s\] /, "");
      }
      if (/文案提取完成|提取失败/.test(status)) break;
    } catch (e) {
      console.log(`[${(i + 1) * 5}s] 读取失败（iframe 可能重建中）: ${String(e).slice(0, 80)}`);
    }
  }
} finally {
  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
