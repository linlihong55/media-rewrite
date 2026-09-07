import fs from "node:fs/promises";

const env = await fs.readFile(".env.local", "utf8");
const token = env.match(/^MOBILE_API_TOKEN=(.+)$/m)?.[1]?.trim();
if (!token) throw new Error("MOBILE_API_TOKEN 未配置");
const base = process.argv[2] || "http://127.0.0.1:3300";

const unauthorized = await fetch(`${base}/api/mobile/health`);
if (unauthorized.status !== 401) throw new Error(`未授权请求应返回 401，实际 ${unauthorized.status}`);

const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const health = await fetch(`${base}/api/mobile/health`, { headers });
const healthJson = await health.json();
if (!health.ok || healthJson?.data?.ok !== true) throw new Error("授权健康检查失败");

const invalid = await fetch(`${base}/api/mobile/tasks`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    action: "transcribe",
    idempotencyKey: `verify-${Date.now()}`,
    sourceText: "https://example.com/not-supported",
  }),
});
if (invalid.status !== 400) throw new Error(`非法来源应返回 400，实际 ${invalid.status}`);

console.log("mobile api verified: auth=ok health=ok url-allowlist=ok");

