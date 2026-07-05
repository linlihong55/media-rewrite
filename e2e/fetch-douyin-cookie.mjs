// 用无痕浏览器访问抖音，获取一份新鲜的游客 Cookie（含 httpOnly 的 ttwid 等），
// 输出为一行 Cookie 字符串，供解析服务 config.yaml 使用。
import { chromium } from "playwright";

const context = await chromium.launchPersistentContext("", {
  headless: false,
  viewport: { width: 1440, height: 900 },
  locale: "zh-CN",
});

try {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("https://www.douyin.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
  // 等页面 JS 补种 cookie（msToken / s_v_web_id 等）
  await page.waitForTimeout(8000);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(4000);

  const cookies = await context.cookies("https://www.douyin.com");
  const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const names = cookies.map((c) => c.name);
  console.log(`COOKIE_NAMES: ${names.join(",")}`);
  console.log(`COOKIE_STRING_START>>>${cookieStr}<<<COOKIE_STRING_END`);
} finally {
  await context.close();
}
