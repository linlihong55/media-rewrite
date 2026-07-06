// 小红书 UI 全流程：自动识别 → 提取文案 → 改写 → 确认并保存（真实调用本地服务与飞书）
import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, "../extension");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dhe-xhs-"));
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  viewport: { width: 1440, height: 900 },
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    "--lang=zh-CN",
  ],
});

try {
  const page = context.pages()[0] ?? (await context.newPage());
  // 匿名会话看笔记十几秒后会被强制跳去登录页/风控 404，把这类导航拦掉让页面留在笔记上
  await context.route(/xiaohongshu\.com\/(login|404)/, (route) => route.abort());

  // 优先用命令行传入的视频笔记链接（node test-xhs-flow.mjs <url>），否则从信息流里挑
  let noteUrl = process.argv[2];
  if (!noteUrl) {
    await page.goto("https://www.xiaohongshu.com/explore", { waitUntil: "commit", timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(5000);
    const noteHref = await page.evaluate(() => {
      const feeds = window.__INITIAL_STATE__?.feed?.feeds;
      const items = (feeds && (feeds._value ?? feeds)) || [];
      for (const it of items) {
        if (it?.noteCard?.type === "video" && it.xsecToken) {
          return `/explore/${it.id}?xsec_token=${encodeURIComponent(it.xsecToken)}&xsec_source=pc_feed`;
        }
      }
      return null;
    });
    if (!noteHref) throw new Error("信息流里没找到视频笔记");
    noteUrl = new URL(noteHref, "https://www.xiaohongshu.com").href;
  }
  console.log("测试笔记:", noteUrl.slice(0, 90));
  await page.goto(noteUrl, { waitUntil: "commit", timeout: 45000 }).catch(() => {});

  // 匿名会话可能被小红书弹去登录页再弹回来（页面刷新、面板重置），
  // 所以每一步都重新获取面板句柄，发现状态被清空就重按按钮。
  const getPanel = async () => {
    for (let i = 0; i < 30; i++) {
      const f = page.frame({ url: (u) => u.href.includes("content/panel.html") });
      if (f) {
        const ok = await f
          .locator("#bar")
          .waitFor({ state: "attached", timeout: 2000 })
          .then(() => true)
          .catch(() => false);
        if (ok) return f;
      }
      await page.waitForTimeout(1000);
    }
    throw new Error("panel iframe 未加载");
  };

  const readPanel = async (selector) => {
    try {
      const f = await getPanel();
      return (
        (await f.locator(selector).evaluate((el) => el.value ?? el.textContent)) ?? ""
      ).trim();
    } catch {
      return null; // 页面正在跳转，稍后重试
    }
  };

  // 点击按钮直到对应状态出现；页面被刷新导致进度丢失时自动重点
  const clickAndWait = async (btnSel, doneRe, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs;
    let lastClick = 0;
    while (Date.now() < deadline) {
      const status = await readPanel("#status");
      if (status !== null && doneRe.test(status)) return status;
      const needClick =
        status !== null && !/中|等待/.test(status) && Date.now() - lastClick > 20000;
      if (needClick) {
        try {
          const f = await getPanel();
          const collapsed = await f.locator("#card").evaluate((el) => el.classList.contains("hidden"));
          if (collapsed) await f.locator("#btn-toggle").click().catch(() => {});
          await f.locator(btnSel).click();
          lastClick = Date.now();
          console.log(`   ↻ 已点击「${label}」`);
        } catch {}
      }
      await page.waitForTimeout(2000);
    }
    throw new Error(`等待「${label}」结果超时`);
  };

  // 1. 自动识别
  const p0 = await getPanel();
  await p0.locator("#dot.on").waitFor({ state: "attached", timeout: 20000 });
  const autoUrl = await readPanel("#url");
  check("自动识别小红书笔记链接", autoUrl.includes("xiaohongshu.com/explore/"), autoUrl.slice(0, 80));

  // 2. 提取文案（下载 + whisper 转写，可能几分钟）
  let statusText = await clickAndWait(
    "#btn-transcribe",
    /文案提取完成|提取失败/,
    6 * 60 * 1000,
    "提取文案"
  );
  if (/提取失败.*图文笔记/.test(statusText)) {
    check("提取文案（该笔记为图文，错误提示正确）", true, statusText);
    console.log("\n结果：图文笔记场景验证通过，请换视频笔记重跑以覆盖转写。");
    process.exit(0);
  }
  check("提取文案完成", statusText.includes("文案提取完成"), statusText);
  const transcript = await readPanel("#transcript");
  check("原文案已填入", Boolean(transcript && transcript.length > 0), (transcript || "").slice(0, 50));

  // 3. 改写
  statusText = await clickAndWait("#btn-rewrite", /改写完成|改写失败/, 3 * 60 * 1000, "改写");
  check("改写完成", statusText.includes("改写完成"), statusText);

  // 4. 确认并保存（写入飞书）
  const pf = await getPanel();
  await pf.locator("#btn-confirm").click();
  await pf
    .locator("#save-result")
    .filter({ hasText: /✅|失败/ })
    .waitFor({ timeout: 60000 });
  const saveText = (await pf.locator("#save-result").textContent()).trim();
  check("保存到飞书多维表格", saveText.includes("✅"), saveText);
} catch (err) {
  check("测试执行", false, err.message);
} finally {
  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
