// 服务端核心链路端到端验证：
// 1. 用 mock 服务代替 DeepSeek / 飞书，不使用真实密钥或真实表格
// 2. 启动独立 Next.js 测试实例，连接本地测试数据库
// 3. 验证改写、保存、飞书同步、重复保存幂等性和工作台读取
import http from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, "../server");
const requireFromServer = createRequire(path.join(SERVER_DIR, "package.json"));
const { Client } = requireFromServer("pg");
const MOCK_PORT = 3399;
const DEV_PORT = 3311;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://creator:creator_local@127.0.0.1:54329/creator_os";
const testRunId = `e2e-pipeline-${Date.now()}`;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dhe-pipeline-"));
const stateFile = path.join(tempDir, "feishu-state.json");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const captured = {
  chat: null,
  tableCreate: null,
  recordCreates: [],
  recordUpdates: [],
  tenantAuth: false,
};

const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const json = body ? JSON.parse(body) : {};
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/chat/completions") {
      captured.chat = json;
      res.end(JSON.stringify({
        choices: [{ message: { content: "标题：\n1. 你家AI还在偷懒吗？3步搭好效率战神\n2. 别再手动改稿了，这个工作流直接搞定\n3. 0基础也能上手的AI改稿流程\n正文：\n这是按照爆款Skill改写后的口播正文，测试专用。" } }],
      }));
    } else if (req.url === "/open-apis/auth/v3/tenant_access_token/internal") {
      captured.tenantAuth = true;
      res.end(JSON.stringify({ code: 0, tenant_access_token: "t-mock-token", expire: 7200 }));
    } else if (req.method === "POST" && /^\/open-apis\/bitable\/v1\/apps\/[^/]+\/tables$/.test(req.url)) {
      captured.tableCreate = json;
      res.end(JSON.stringify({ code: 0, msg: "ok", data: { table_id: "tblMOCK1" } }));
    } else if (req.method === "GET" && /\/tables\/tblMOCK1\/fields\?/.test(req.url)) {
      const items = (captured.tableCreate?.table?.fields ?? []).map((field) => ({
        field_name: field.field_name,
      }));
      res.end(JSON.stringify({ code: 0, msg: "ok", data: { items } }));
    } else if (req.method === "POST" && /\/tables\/tblMOCK1\/records$/.test(req.url)) {
      captured.recordCreates.push(json);
      res.end(JSON.stringify({ code: 0, msg: "ok", data: { record: { record_id: "recMOCK" } } }));
    } else if (req.method === "PUT" && /\/tables\/tblMOCK1\/records\/recMOCK$/.test(req.url)) {
      captured.recordUpdates.push(json);
      res.end(JSON.stringify({ code: 0, msg: "ok", data: { record: { record_id: "recMOCK" } } }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ code: 404, msg: `mock 未实现: ${req.method} ${req.url}` }));
    }
  });
});

await new Promise((resolve, reject) => {
  mock.once("error", reject);
  mock.listen(MOCK_PORT, "127.0.0.1", resolve);
});
console.log(`mock DeepSeek/飞书已启动: http://127.0.0.1:${MOCK_PORT}`);

const dev = spawn("npx", ["next", "dev", "--webpack", "-p", String(DEV_PORT)], {
  cwd: SERVER_DIR,
  detached: true,
  stdio: "ignore",
  env: {
    ...process.env,
    DATABASE_URL,
    REWRITE_PROVIDER: "deepseek",
    DEEPSEEK_API_KEY: "sk-mock",
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    FEISHU_APP_ID: "cli_mock",
    FEISHU_APP_SECRET: "mock_secret",
    FEISHU_API_BASE: `http://127.0.0.1:${MOCK_PORT}`,
    FEISHU_BITABLE_URL: "https://example.feishu.cn/base/bascnMockToken123",
    FEISHU_STATE_FILE: stateFile,
  },
});

async function waitForHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEV_PORT}/api/health`);
      if (response.ok) return;
    } catch {
      // 服务仍在启动。
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("测试用 Next.js 服务启动超时或数据库未就绪");
}

async function cleanupDatabase() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const rows = await client.query(
      "SELECT id FROM candidates WHERE platform='douyin' AND content_id=$1",
      [testRunId]
    );
    for (const row of rows.rows) {
      await client.query("DELETE FROM content_items WHERE candidate_id=$1", [row.id]);
    }
    await client.query("DELETE FROM candidates WHERE platform='douyin' AND content_id=$1", [testRunId]);
  } finally {
    await client.end();
  }
}

try {
  await waitForHealth();
  console.log(`测试服务已就绪: http://127.0.0.1:${DEV_PORT}`);

  const rewriteRes = await fetch(`http://127.0.0.1:${DEV_PORT}/api/rewrite`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "今天教大家用AI工具自动改稿，先打开工具，然后粘贴文案。" }),
  });
  const rewriteJson = await rewriteRes.json();
  check("改写调用模型并返回结果", rewriteRes.ok && rewriteJson.data?.skipped === false);
  check("改写稿来自模型输出", Boolean(rewriteJson.data?.rewritten?.includes("效率战神")));

  const systemPrompt = captured.chat?.messages?.find((message) => message.role === "system")?.content || "";
  check("系统提示词包含新版改写 Skill", systemPrompt.includes("强结果开场") && systemPrompt.includes("质量检查清单"));
  check("系统提示词使用 Skill 的当前规则", systemPrompt.includes("痛点解决型") && systemPrompt.includes("爆款标题：提供 5—10 个"));
  check("服务端不再用旧标题数量覆盖 Skill", !systemPrompt.includes("先给出 3 个爆款标题候选"));
  check("改写模型为 deepseek-chat", captured.chat?.model === "deepseek-chat", captured.chat?.model);

  const video = {
    videoId: testRunId,
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
    stats: { diggCount: 15000, collectCount: 815, commentCount: 120, shareCount: 45 },
    sourceUrl: `https://www.douyin.com/video/${testRunId}`,
  };

  const save = async (rewritten) => {
    const response = await fetch(`http://127.0.0.1:${DEV_PORT}/api/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video, transcript: "原文案内容", rewritten }),
    });
    return { response, json: await response.json() };
  };

  const first = await save("改写稿内容");
  check("保存接口写入本地并同步飞书", first.response.ok && first.json.data?.feishu?.synced === true, first.json.error || first.json.data?.feishu?.message);
  check("获取了飞书 tenant_access_token", captured.tenantAuth === true);

  const createdFields = (captured.tableCreate?.table?.fields || []).map((field) => field.field_name);
  const expectedFields = ["标题", "正文", "标签", "发布时间", "账号", "粉丝数", "点赞数", "收藏数", "原文案", "改写稿", "视频链接", "记录时间"];
  check("自动建表包含全部 12 个字段", expectedFields.every((field) => createdFields.includes(field)), createdFields.join("/"));

  const recordFields = captured.recordCreates[0]?.fields || {};
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
  const wrong = fieldChecks.filter(([key, value]) => recordFields[key] !== value);
  check("飞书记录字段值正确", wrong.length === 0, wrong.map(([key]) => key).join(","));

  const second = await save("第二次改写稿");
  check("重复保存仍成功", second.response.ok && second.json.data?.feishu?.synced === true);
  check("重复保存更新飞书原记录而非新增", captured.recordCreates.length === 1 && captured.recordUpdates.length === 1);

  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  const localCounts = await client.query(
    `SELECT
      (SELECT count(*)::int FROM candidates WHERE platform='douyin' AND content_id=$1) candidate_count,
      (SELECT count(*)::int FROM content_items ci JOIN candidates c ON c.id=ci.candidate_id WHERE c.platform='douyin' AND c.content_id=$1) item_count`,
    [testRunId]
  );
  await client.end();
  check("重复保存只保留一个候选和一个创作任务", localCounts.rows[0].candidate_count === 1 && localCounts.rows[0].item_count === 1, JSON.stringify(localCounts.rows[0]));

  const workspaceRes = await fetch(`http://127.0.0.1:${DEV_PORT}/api/workspace`);
  const workspace = await workspaceRes.json();
  const candidate = workspace.data?.candidates?.find((item) => item.content_id === testRunId);
  check("工作台能读取新记录并标记已进入看板", workspaceRes.ok && candidate?.promoted === true);
} catch (err) {
  check("测试执行", false, err instanceof Error ? err.message : String(err));
} finally {
  try {
    process.kill(-dev.pid, "SIGTERM");
  } catch {
    // 子进程可能已自行退出。
  }
  await new Promise((resolve) => mock.close(resolve));
  await cleanupDatabase().catch((err) => console.error("测试数据清理失败：", err.message));
  fs.rmSync(tempDir, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
