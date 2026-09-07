import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, "../../user_voc");
const videoId = "7662298104951033094";
const videoUrl = `https://www.douyin.com/video/${videoId}`;
const noteId = "6a69cfaf000000000f03e803";
const noteUrl = `https://www.xiaohongshu.com/explore/${noteId}`;
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "user-voc-e2e-"));
const savedPayloads = [];

function check(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`✅ ${message}`);
}

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  viewport: { width: 1200, height: 800 },
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    "--lang=zh-CN",
  ],
});

try {
  await context.route("http://127.0.0.1:3300/api/user-voc", async (route) => {
    const savedPayload = JSON.parse(route.request().postData() || "{}");
    savedPayloads.push(savedPayload);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          receivedCount: savedPayload.comments?.length || 0,
          writtenCount: savedPayload.comments?.length || 0,
          duplicateCount: 0,
          overflowCount: 0,
        },
      }),
    });
  });

  await context.route("https://www.douyin.com/aweme/v1/web/comment/list/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        comments: [
          { cid: "c1", text: "这个方法很实用", user: { nickname: "用户甲" }, digg_count: 12 },
          { cid: "c2", text: "想看完整教程", user: { nickname: "用户乙" }, digg_count: 3 },
          { cid: "c3", text: "这个方法很实用", user: { nickname: "重复用户" }, digg_count: 1 },
        ],
      }),
    });
  });

  await context.route(videoUrl, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html>
        <html><body style="margin:0;background:#eee">
          <div data-e2e="comment-list" style="height:260px;overflow-y:auto">
            <div style="height:520px;padding:16px">
              <div data-e2e="comment-item"><span class="username">用户丙</span><span class="comment-text">求工具名称</span></div>
              <div data-e2e="comment-item"><span class="username">用户甲</span><span class="comment-text">这个方法很实用</span></div>
              <div style="margin-top:430px">没有更多</div>
            </div>
          </div>
          <script>
            setTimeout(() => fetch('/aweme/v1/web/comment/list/?aweme_id=${videoId}'), 100);
          </script>
        </body></html>`,
    });
  });

  await context.route("https://www.xiaohongshu.com/api/sns/web/v2/comment/page**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          comments: [
            { id: "x1", content: "参数可以分享吗", user_info: { nickname: "薯友甲" }, like_count: 8 },
            { id: "x2", content: "已收藏准备试试", user_info: { nickname: "薯友乙" }, like_count: 5 },
          ],
        },
      }),
    });
  });

  await context.route(noteUrl, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html>
        <html><body>
          <div class="comments-container" style="height:260px;overflow-y:auto">
            <div style="height:520px;padding:16px">
              <div class="comment-item"><span class="username">薯友丙</span><span class="content">这个适合新手吗</span></div>
              <div style="margin-top:450px">没有更多</div>
            </div>
          </div>
          <script>
            setTimeout(() => fetch('/api/sns/web/v2/comment/page?note_id=${noteId}'), 100);
          </script>
        </body></html>`,
    });
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(videoUrl, { waitUntil: "domcontentloaded" });
  await page.locator("#user-voc-panel").waitFor({ state: "visible", timeout: 10_000 });
  check(true, "user_voc 面板已注入");

  const beforeDrag = await page.locator("#user-voc-panel").boundingBox();
  const titleBox = await page.locator("#user-voc-title").boundingBox();
  if (!beforeDrag || !titleBox) throw new Error("无法读取面板位置");
  await page.mouse.move(titleBox.x + titleBox.width / 2, titleBox.y + titleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(titleBox.x - 180, titleBox.y - 120, { steps: 8 });
  await page.mouse.up();
  const afterDrag = await page.locator("#user-voc-panel").boundingBox();
  check(
    Boolean(afterDrag && afterDrag.x < beforeDrag.x - 100 && afterDrag.y < beforeDrag.y - 60),
    "标题栏可拖动面板"
  );

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#user-voc-panel").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(300);
  const restored = await page.locator("#user-voc-panel").boundingBox();
  check(
    Boolean(
      restored &&
        afterDrag &&
        Math.abs(restored.x - afterDrag.x) < 4 &&
        Math.abs(restored.y - afterDrag.y) < 4
    ),
    "刷新页面后恢复上次位置"
  );

  await page.locator("#user-voc-action").click();
  await page
    .locator("#user-voc-status")
    .filter({ hasText: "完成：" })
    .waitFor({ timeout: 20_000 });

  const douyinPayload = savedPayloads[0];
  check(douyinPayload?.platform === "douyin", "提交平台为抖音");
  check(douyinPayload?.contentId === videoId, "提交的视频 ID 与当前页面一致");
  const contents = douyinPayload.comments.map((comment) => comment.content).sort();
  check(contents.length === 3, "网络响应与 DOM 评论合并后按正文去重");
  check(contents.includes("这个方法很实用"), "保留接口评论");
  check(contents.includes("求工具名称"), "保留 DOM 兜底评论");
  check(contents.includes("想看完整教程"), "保留其余唯一评论");

  await page.goto(noteUrl, { waitUntil: "domcontentloaded" });
  await page.locator("#user-voc-panel").waitFor({ state: "visible", timeout: 10_000 });
  await page.locator("#user-voc-action").click();
  await page
    .locator("#user-voc-status")
    .filter({ hasText: "完成：" })
    .waitFor({ timeout: 20_000 });

  const xhsPayload = savedPayloads[1];
  check(xhsPayload?.platform === "xhs", "提交平台为小红书");
  check(xhsPayload?.contentId === noteId, "提交的笔记 ID 与当前页面一致");
  const xhsContents = xhsPayload.comments.map((comment) => comment.content).sort();
  check(xhsContents.length === 3, "小红书接口与 DOM 评论合并成功");
  check(xhsContents.includes("参数可以分享吗"), "解析小红书接口评论");
  check(xhsContents.includes("这个适合新手吗"), "保留小红书 DOM 兜底评论");
} finally {
  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
