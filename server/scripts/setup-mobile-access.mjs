import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const envPath = path.join(process.cwd(), ".env.local");
let env = await fs.readFile(envPath, "utf8").catch(() => "");
const existing = env.match(/^MOBILE_API_TOKEN=(.+)$/m)?.[1]?.trim();
const token = existing || crypto.randomBytes(32).toString("hex");
if (!existing) {
  env = `${env.trimEnd()}\nMOBILE_API_TOKEN=${token}\n`;
  await fs.writeFile(envPath, env, { mode: 0o600 });
}

const host = process.argv[2]?.trim().replace(/\/$/, "") || "http://<Mac的Tailscale名称或IP>:3300";
const output = path.resolve(process.cwd(), "..", "android", "mobile-connection.txt");
await fs.writeFile(output, `电脑地址=${host}\n访问令牌=${token}\n`, { mode: 0o600 });
console.log(`手机连接信息已写入：${output}`);

