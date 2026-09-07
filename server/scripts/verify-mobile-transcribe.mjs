import fs from "node:fs/promises";

const sourceText = process.argv[2];
if (!sourceText) throw new Error("用法：node scripts/verify-mobile-transcribe.mjs <抖音或小红书视频链接>");
const env = await fs.readFile(".env.local", "utf8");
const token = env.match(/^MOBILE_API_TOKEN=(.+)$/m)?.[1]?.trim();
if (!token) throw new Error("MOBILE_API_TOKEN 未配置");
const base = "http://127.0.0.1:3300";
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

const created = await fetch(`${base}/api/mobile/tasks`, {
  method: "POST",
  headers,
  body: JSON.stringify({ action: "transcribe", idempotencyKey: `real-${Date.now()}`, sourceText }),
});
const createdJson = await created.json();
if (!created.ok) throw new Error(createdJson.error || "创建任务失败");
const { job, draft } = createdJson.data;

let finalDraft;
try {
  for (let attempt = 0; attempt < 900; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const response = await fetch(`${base}/api/mobile/tasks/${job.id}`, { headers });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error || "查询任务失败");
    if (json.data.job.status === "failed") throw new Error(json.data.job.error_message || "提取失败");
    if (json.data.job.status === "succeeded") {
      finalDraft = json.data.draft;
      break;
    }
  }
  if (!finalDraft?.transcript?.trim()) throw new Error("任务完成但没有转写文案");
  console.log(`mobile transcribe verified: title=${finalDraft.video?.title || "未命名"} chars=${finalDraft.transcript.length}`);
} finally {
  await fetch(`${base}/api/mobile/drafts/${draft.id}`, { method: "DELETE", headers });
}

