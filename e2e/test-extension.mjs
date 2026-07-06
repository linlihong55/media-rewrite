// 端到端验证浏览器插件：
// 1. 悬浮工具条（三个常驻按钮）在抖音视频页注入并可见
// 2. iframe 内输入框可以正常输入（原 bug：页面脚本拦截键盘事件导致无法输入）
// 3. 按钮点击有响应，并能连通 localhost:3300 本地服务
// 4. popup.html 的输入框可输入
import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, "../extension");
const VIDEO_URL = "https://www.douyin.com/video/7655626030958267686";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dhe-e2e-"));
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
  console.log(`打开 ${VIDEO_URL} ...`);
  await page.goto(VIDEO_URL, { waitUntil: "commit", timeout: 45000 });

  // --- 1. 悬浮面板 iframe 注入 ---
  const frameEl = page.locator("#dhe-frame");
  await frameEl.waitFor({ state: "attached", timeout: 20000 });
  check("悬浮面板 iframe 已注入页面", true);

  const frameSrc = await frameEl.getAttribute("src");
  const extId = new URL(frameSrc).host;
  console.log(`扩展 ID: ${extId}`);

  const panel = page.frame({ url: (u) => u.href.includes("content/panel.html") });
  if (!panel) throw new Error("找不到 panel iframe");

  // --- 2. 三个常驻功能按钮可见 ---
  for (const [id, label] of [
    ["#btn-download", "下载视频"],
    ["#btn-transcribe", "提取文案"],
    ["#btn-rewrite", "改写"],
  ]) {
    const visible = await panel.locator(id).isVisible();
    check(`悬浮按钮「${label}」常驻可见`, visible);
  }

  // --- 3. 自动识别当前视频链接 ---
  await panel
    .locator("#dot.on")
    .waitFor({ state: "attached", timeout: 15000 })
    .catch(() => {});
  const dotOn = (await panel.locator("#dot").getAttribute("class"))?.includes("on");
  const autoUrl = await panel.locator("#url").inputValue();
  check("自动识别当前视频链接", Boolean(dotOn && autoUrl.includes("/video/")), autoUrl);

  // --- 4. 输入框可输入（核心回归：原 bug 无法输入）---
  await panel.locator("#btn-toggle").click();
  await panel.locator("#card").waitFor({ state: "visible", timeout: 5000 });
  const urlInput = panel.locator("#url");
  await urlInput.click();
  await urlInput.fill("");
  await urlInput.pressSequentially("https://www.douyin.com/video/12345678901", { delay: 30 });
  const typed = await urlInput.inputValue();
  check(
    "链接输入框可以逐键输入",
    typed === "https://www.douyin.com/video/12345678901",
    `实际值: ${typed}`
  );

  const transcriptBox = panel.locator("#transcript");
  await transcriptBox.click();
  await transcriptBox.pressSequentially("手动输入的测试文案", { delay: 30 });
  const typedTranscript = await transcriptBox.inputValue();
  check("原文案输入框可以逐键输入", typedTranscript === "手动输入的测试文案", typedTranscript);

  // --- 5. 按钮点击响应 + 本地服务连通（改写接口真实调用）---
  await panel.locator("#btn-rewrite").click();
  await panel
    .locator("#status")
    .filter({ hasText: /改写完成|改写失败/ })
    .waitFor({ timeout: 90000 });
  const statusText = await panel.locator("#status").textContent();
  const rewriteOk = /改写完成/.test(statusText);
  check("「改写」按钮触发本地服务并返回结果", rewriteOk, statusText.trim());

  // --- 6. 批量提取：输入框可输入 + 流程逐行反馈 ---
  const batchBox = panel.locator("#batch-urls");
  await batchBox.click();
  await batchBox.pressSequentially("https://www.douyin.com/video/11111111111", { delay: 20 });
  await batchBox.press("Enter");
  await batchBox.pressSequentially("https://www.douyin.com/video/22222222222", { delay: 20 });
  const batchTyped = await batchBox.inputValue();
  check(
    "批量输入框可逐键输入多行链接",
    batchTyped.split("\n").filter(Boolean).length === 2,
    JSON.stringify(batchTyped)
  );

  await panel.locator("#btn-batch").click();
  await panel
    .locator("#status")
    .filter({ hasText: /批量提取完成/ })
    .waitFor({ timeout: 120000 });
  const batchRows = await panel.locator("#batch-progress div").allTextContents();
  const allSettled =
    batchRows.length === 2 && batchRows.every((t) => t.startsWith("✅") || t.startsWith("❌"));
  check("批量提取逐条执行并给出每行结果", allSettled, batchRows.join(" | "));

  // --- 7. 悬停视频卡片显示博主粉丝数（注入模拟嗅探数据，与 page-hook 同通道）---
  await page.evaluate(() => {
    const a = document.createElement("a");
    a.href = "/video/999888777666555";
    a.id = "dhe-test-card";
    a.style.cssText =
      "position:fixed;left:360px;top:420px;width:220px;height:140px;display:block;z-index:2147483000;background:rgba(0,0,0,0.02)";
    document.body.appendChild(a);
    document.dispatchEvent(
      new CustomEvent("__douyin_hit_extractor_aweme__", {
        detail: {
          ids: ["999888777666555"],
          infos: [{ id: "999888777666555", nickname: "测试博主", followerCount: 123456 }],
        },
      })
    );
  });
  await page.hover("#dhe-test-card");
  await page
    .locator("#dhe-fans:not(.dhe-fans-hidden)")
    .waitFor({ timeout: 5000 })
    .catch(() => {});
  const fansText = (await page.locator("#dhe-fans").textContent()) ?? "";
  check(
    "悬停视频卡片时显示博主粉丝数",
    fansText.includes("测试博主") && fansText.includes("12.3万"),
    fansText || "（浮层未出现）"
  );

  // 移开鼠标后浮层隐藏
  await page.mouse.move(10, 700);
  await page.waitForTimeout(500);
  const fansHidden = await page
    .locator("#dhe-fans")
    .evaluate((el) => el.classList.contains("dhe-fans-hidden"));
  check("鼠标移开后粉丝数浮层隐藏", fansHidden);

  // --- 8. 面板截图留档 ---
  await page.screenshot({ path: path.join(__dirname, "screenshot-douyin-panel.png") });
  console.log("已保存截图 e2e/screenshot-douyin-panel.png");

  // --- 9. popup 页面输入框（单条 + 批量）---
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extId}/popup.html`);
  const popupInput = popupPage.locator("#url-input");
  await popupInput.click();
  await popupInput.pressSequentially("https://v.douyin.com/abc123/", { delay: 30 });
  const popupTyped = await popupInput.inputValue();
  check("popup 弹窗输入框可以逐键输入", popupTyped === "https://v.douyin.com/abc123/", popupTyped);
  const popupBatch = popupPage.locator("#batch-urls");
  await popupBatch.click();
  await popupBatch.pressSequentially("https://v.douyin.com/xyz789/", { delay: 20 });
  check("popup 批量输入框可输入", (await popupBatch.inputValue()).includes("xyz789"));
  await popupPage.close();
} catch (err) {
  check("测试执行", false, err.message);
} finally {
  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
