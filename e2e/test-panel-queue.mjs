import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const panelUrl = pathToFileURL(path.resolve(__dirname, "../extension/content/panel.html")).href;
const videoA = "https://www.douyin.com/video/7000000000000000001";
const videoB = "https://www.douyin.com/video/7000000000000000002";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function videoData(url) {
  const videoId = url.split("/").pop();
  return {
    videoId,
    sourceUrl: url,
    title: `标题-${videoId.slice(-1)}`,
    desc: `正文-${videoId.slice(-1)}`,
    hashtags: ["测试"],
    publishTime: "2026-08-23 12:00",
    filePath: `/tmp/${videoId}.mp4`,
    transcript: `原文-${videoId.slice(-1)}`,
    author: { nickname: `账号-${videoId.slice(-1)}`, profileUrl: url, followerCount: 1000 },
    stats: { diggCount: 100, collectCount: 20 },
  };
}

const browser = await chromium.launch({ headless: true, args: ["--disable-web-security"] });
const page = await browser.newPage();

await page.route("http://localhost:3300/**", async (route) => {
  const requestUrl = new URL(route.request().url());
  const body = route.request().postDataJSON?.() ?? {};
  let data = {};
  let delay = 0;

  if (requestUrl.pathname === "/api/health") {
    data = { ok: true };
  } else if (requestUrl.pathname === "/api/transcribe") {
    delay = body.url === videoA ? 700 : 500;
    data = videoData(body.url);
  } else if (requestUrl.pathname === "/api/rewrite") {
    delay = 600;
    data = { rewritten: `改写-${body.text.slice(-1)}`, skipped: false };
  } else if (requestUrl.pathname === "/api/breakdown") {
    delay = 600;
    data = { breakdown: `拆解-${body.transcript.slice(-1)}`, filePath: "/tmp/breakdown.md" };
  }

  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({ data }),
  });
});

try {
  await page.goto(panelUrl);
  await page.locator("#btn-toggle").click();

  await page.locator("#url").fill(videoA);
  await page.locator("#url").dispatchEvent("change");
  await page.locator("#btn-transcribe").click();
  await page.locator(`.task-item[title="${videoA}"] .task-stage`).waitFor();

  await page.locator("#url").fill(videoB);
  await page.locator("#url").dispatchEvent("change");
  await page.locator("#btn-transcribe").click();

  assert((await page.locator(".task-item").count()) === 2, "切换视频后应保留两个任务");
  const runningStages = await page.locator(".task-stage").allTextContents();
  assert(runningStages.every((text) => text.includes("提取中")), "两个提取任务应同时在后台运行");

  await page
    .locator(".task-stage")
    .filter({ hasText: "提取完成" })
    .nth(1)
    .waitFor({ timeout: 5000 });

  await page.locator(`.task-item[title="${videoA}"]`).click();
  assert((await page.locator("#transcript").inputValue()) === "原文-1", "应恢复视频 A 的原文");

  await page.locator("#btn-rewrite").click();
  await page.locator("#btn-breakdown").click();
  await page.locator(`.task-item[title="${videoB}"]`).click();

  const backgroundStage = await page
    .locator(`.task-item[title="${videoA}"] .task-stage`)
    .textContent();
  assert(
    backgroundStage.includes("改写") && backgroundStage.includes("拆解"),
    "切走后视频 A 的改写和拆解应继续运行"
  );

  await page
    .locator(`.task-item[title="${videoA}"] .task-stage`)
    .filter({ hasText: "拆解完成" })
    .waitFor({ timeout: 5000 });
  await page.locator(`.task-item[title="${videoA}"]`).click();

  assert((await page.locator("#rewrite").inputValue()) === "改写-1", "应恢复视频 A 的改写结果");
  assert((await page.locator("#breakdown").inputValue()) === "拆解-1", "应恢复视频 A 的拆解结果");

  const scrollState = await page.locator("#card").evaluate((card) => {
    const overflowY = getComputedStyle(card).overflowY;
    card.scrollTop = card.scrollHeight;
    return {
      clientHeight: card.clientHeight,
      scrollHeight: card.scrollHeight,
      scrollTop: card.scrollTop,
      overflowY,
    };
  });
  assert(scrollState.overflowY === "auto", "长面板应启用纵向滚动");
  assert(scrollState.scrollHeight > scrollState.clientHeight, "长内容应限制在视口高度内");
  assert(scrollState.scrollTop > 0, "面板应能滚动到底部查看批量提取区域");

  await page.screenshot({ path: "/tmp/dhe-panel-queue.png", fullPage: true });
  console.log("✅ 后台任务队列与长面板滚动回归测试通过");
} finally {
  await browser.close();
}
