import { authorizeMobile } from "@/lib/mobileAuth";
import { getMobileJob, startMobileWorker } from "@/lib/mobileTasks";

export const runtime = "nodejs";

export async function GET(request: Request, context: RouteContext<"/api/mobile/tasks/[id]">) {
  const denied = authorizeMobile(request);
  if (denied) return denied;
  const { id } = await context.params;
  const data = await getMobileJob(id);
  if (!data) return Response.json({ error: "任务不存在" }, { status: 404 });
  if (data.job.status === "queued") startMobileWorker();
  return Response.json({ data });
}

