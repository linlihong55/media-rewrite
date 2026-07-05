// 服务端链路端到端验证（不需要真实密钥）：
// 1. 起一个 mock 服务，模拟 DeepSeek /chat/completions 和飞书开放平台接口
// 2. 起第二个 next dev 实例（端口 3311），注入指向 mock 的环境变量
// 3. 验证 /api/rewrite：系统提示词包含改写 Skill 方法论、调用 DeepSeek、返回改写稿
// 4. 验证 /api/save：自动建表 + 10 个字段全部写入飞书
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, "../server");
const MOCK_PORT = 3399;
const DEV_PORT = 3311;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---------- mock DeepSeek + 飞书 ----------

const captured = { chat: null, tableCreate: null, record: null, tenantAuth: false };

const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const json = body ? JSON.parse(body) : {};
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/chat/completions") {
      captured.chat = json;
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  "标题：\n1. 你家AI还在偷懒吗？3步搭好效率战神\n2. 别再手动改稿了，这个工作流直接搞定\n3. 0基础也能上手的AI改稿流程\n正文：\n这是按照爆款Skill改写后的口播正文，测试专用。",
              },
            },
          ],
        })
      );
    } else if (req.url === "/open-apis/auth/v3/tenant_access_token/internal") {
      captured.tenantAuth = true;
      res.end(JSON.stringify({ code: 0, tenant_access_token: "t-mock-token", expire: 7200 }));
    } else if (/^\/open-apis\/bitable\/v1\/apps\/[^/]+\/tables$/.test(req.url)) {
      captured.tableCreate = json;
      res.end(JSON.stringify({ code: 0, msg: "ok", data: { table_id: "tblMOCK1" } }));
    } else if (/\/tables\/tblMOCK1\/records$/.test(req.url)) {
      captured.record = json;
      res.end(JSON.stringify({ code: 0, msg: "ok", data: { record: { record_id: "recMOCK" } } }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ code: 404, msg: `mock 未实现: ${req.url}` }));
    }
  });
});
await new Promise((resolve) => mock.listen(MOCK_PORT, resolve));
console.log(`mock DeepSeek/飞书已启动: http://127.0.0.1:${MOCK_PORT}`);

// ---------- 启动测试用 next dev（注入 mock 环境变量） ----------

const dev = spawn("npx", ["next", "dev", "-p", String(DEV_PORT)], {
  cwd: SERVER_DIR,
  detached: true,
  stdio: "ignore",
  env: {
    ...process.env,
    DEEPSEEK_API_KEY: "sk-mock",
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    FEISHU_APP_ID: "cli_mock",
    FEISHU_APP_SECRET: "mock_secret",
    FEISHU_API_BASE: `http://127.0.0.1:${MOCK_PORT}`,
    FEISHU_BITABLE_URL: "https://example.feishu.cn/base/bascnMockToken123",
  },
});

async function waitForHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://localhost:${DEV_PORT}/api/health`);
      if (res.ok) return;
    } catch {
      // 还没起来，继续等
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("测试用 next dev 启动超时");
}

const cleanupFiles = [path.join(SERVER_DIR, ".feishu-state.json")];

try {
  await waitForHealth();
  console.log(`测试服务已就绪: http://localhost:${DEV_PORT}`);

  // --- /api/rewrite：走 DeepSeek + 改写 Skill ---
  const rewriteRes = await fetch(`http://localhost:${DEV_PORT}/api/rewrite`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "今天教大家用AI工具自动改稿，先打开工具，然后粘贴文案。" }),
  });
  const rewriteJson = await rewriteRes.json();
  check(
    "改写调用 DeepSeek 并返回改写稿（非 skipped）",
    rewriteRes.ok && rewriteJson.data?.skipped === false,
    `skipped=${rewriteJson.data?.skipped}`
  );
  check(
    "改写稿内容来自模型输出（标题+正文结构）",
    Boolean(rewriteJson.data?.rewritten?.includes("效率战神")),
    (rewriteJson.data?.rewritten || "").slice(0, 40)
  );

  const systemPrompt = captured.chat?.messages?.find((m) => m.role === "system")?.content || "";
  check(
    "系统提示词包含 ai-viral-copywriter Skill 方法论",
    systemPrompt.includes("强结果开场") && systemPrompt.includes("Quality checklist"),
    `提示词长度 ${systemPrompt.length}`
  );
  check(
    "系统提示词包含爆款模板库（viral_templates.md）",
    systemPrompt.includes("痛点解决型") && systemPrompt.includes("保姆级教程型")
  );
  check("改写模型为 deepseek-chat", captured.chat?.model === "deepseek-chat", captured.chat?.model);

  // --- /api/save：本地 md + 飞书自动建表 + 写入记录 ---
  const video = {
    videoId: "e2e-pipeline-test",
    title: "测试标题",
    desc: "测试标题 #AI #AI技巧",
    hashtags: ["AI", "AI技巧"],
    createTime: 1750000000,
    publishTime: "2025-06-16 00:26",
    author: {
      nickname: "AI周周酱",
      profileUrl: "https://www.douyin.com/user/xxx",
      followerCount: 123456,
    },
    stats: { diggCount: 15000, collectCount: 815 },
    sourceUrl: "https://www.douyin.com/video/123",
  };
  const saveRes = await fetch(`http://localhost:${DEV_PORT}/api/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ video, transcript: "原文案内容", rewritten: "改写稿内容" }),
  });
  const saveJson = await saveRes.json();
  if (saveJson.data?.mdPath) cleanupFiles.push(saveJson.data.mdPath);

  check(
    "保存接口返回飞书同步成功",
    saveRes.ok && saveJson.data?.feishu?.synced === true,
    saveJson.data?.feishu?.message
  );
  check("走企业自建应用凭证获取了 tenant_access_token", captured.tenantAuth === true);

  const createdFields = (captured.tableCreate?.table?.fields || []).map((f) => f.field_name);
  const expectedFields = [
    "标题", "正文", "标签", "发布时间", "账号",
    "粉丝数", "点赞数", "收藏数", "原文案", "改写稿",
  ];
  check(
    "自动建表包含全部 10 个字段",
    expectedFields.every((f) => createdFields.includes(f)),
    createdFields.join("/")
  );

  const recordFields = captured.record?.fields || {};
  const fieldChecks = [
    ["标题", "测试标题"],
    ["正文", "测试标题 #AI #AI技巧"],
    ["标签", "#AI #AI技巧"],
    ["发布时间", 1750000000000],
    ["账号", "AI周周酱（https://www.douyin.com/user/xxx）"],
    ["粉丝数", 123456],
    ["点赞数", 15000],
    ["收藏数", 815],
    ["原文案", "原文案内容"],
    ["改写稿", "改写稿内容"],
  ];
  const wrong = fieldChecks.filter(([k, v]) => recordFields[k] !== v);
  check(
    "飞书记录 10 个字段值全部正确",
    wrong.length === 0,
    wrong.length ? `不匹配: ${wrong.map(([k]) => k).join(",")}` : ""
  );
} catch (err) {
  check("测试执行", false, err.message);
} finally {
  try {
    process.kill(-dev.pid, "SIGTERM");
  } catch {
    // 进程可能已退出
  }
  mock.close();
  for (const f of cleanupFiles) {
    fs.rmSync(f, { force: true });
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
