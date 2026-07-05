import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { PROJECT_ROOT } from "./paths";

const execFileAsync = promisify(execFile);

// 解析失败时自动刷新抖音游客 Cookie（e2e/refresh-douyin-cookie.mjs：
// 取新 Cookie → 更新解析服务配置 → 重启解析服务 → 验证）。
// 冷却时间 + 单例锁，防止连续失败时反复拉起浏览器。
const COOLDOWN_MS = 10 * 60 * 1000;
let lastAttempt = 0;
let inFlight: Promise<boolean> | null = null;

export function refreshDouyinCookie(): Promise<boolean> {
  if (inFlight) return inFlight;
  if (Date.now() - lastAttempt < COOLDOWN_MS) return Promise.resolve(false);
  lastAttempt = Date.now();

  inFlight = (async () => {
    try {
      console.log("[cookie] 解析失败，自动刷新抖音 Cookie...");
      await execFileAsync("node", ["refresh-douyin-cookie.mjs"], {
        cwd: path.join(PROJECT_ROOT, "e2e"),
        timeout: 180_000,
      });
      console.log("[cookie] 刷新成功");
      return true;
    } catch (err) {
      console.error("[cookie] 自动刷新失败：", err instanceof Error ? err.message : err);
      return false;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
