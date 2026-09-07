import { startDiscovery } from "@/lib/discover";
import { withCors, corsPreflight } from "@/lib/cors";

export async function OPTIONS() {
  return corsPreflight();
}

// 手动触发一轮自动发现（也是 launchd 定时任务实际调用的入口）。
// 一轮跑完可能要跑很久（几十个关键词 × 两个平台 × 限速间隔），所以立即返回，
// 后台跑完的过程日志和结果汇总走 console.log/error，落在本进程已有的 launchd 日志文件里。
export async function POST() {
  const started = startDiscovery();
  return withCors({ data: { started, message: started ? "发现任务已启动" : "已有发现任务正在运行" } });
}
