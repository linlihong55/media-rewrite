import fs from "node:fs/promises";

const env = await fs.readFile(".env.local", "utf8");
const token = env.match(/^MOBILE_API_TOKEN=(.+)$/m)?.[1]?.trim();
if (!token) throw new Error("MOBILE_API_TOKEN 未配置");
const base = process.argv[2] || "http://127.0.0.1:3300";
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const idempotencyKey = `queue-verify-${Date.now()}`;
const payload = {
  action: "transcribe",
  idempotencyKey,
  sourceText: "测试链接 https://www.xiaohongshu.com/explore/000000000000000000000000",
};

async function postTask() {
  const response = await fetch(`${base}/api/mobile/tasks`, { method: "POST", headers, body: JSON.stringify(payload) });
  const json = await response.json();
  if (response.status !== 202) throw new Error(json.error || `创建任务失败 ${response.status}`);
  return json.data;
}

const first = await postTask();
const repeated = await postTask();
if (first.job.id !== repeated.job.id) throw new Error("相同幂等编号创建了重复任务");

let terminal;
for (let attempt = 0; attempt < 30; attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const response = await fetch(`${base}/api/mobile/tasks/${first.job.id}`, { headers });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || "查询任务失败");
  if (["succeeded", "failed"].includes(json.data.job.status)) {
    terminal = json.data.job;
    break;
  }
}
if (!terminal) throw new Error("任务未在预期时间进入终态");
if (terminal.status !== "failed" || !terminal.error_code) throw new Error("无效视频没有留下可追踪失败状态");

const deleted = await fetch(`${base}/api/mobile/drafts/${first.draft.id}`, { method: "DELETE", headers });
if (!deleted.ok) throw new Error("清理验证草稿失败");
console.log("mobile queue verified: persisted=ok idempotency=ok failure-state=ok cleanup=ok");

