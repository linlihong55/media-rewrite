import { authorizeMobile } from "@/lib/mobileAuth";
import { createMobileJob, type MobileAction } from "@/lib/mobileTasks";

export const runtime = "nodejs";

const ACTIONS = new Set<MobileAction>(["transcribe", "rewrite", "save", "retry_feishu"]);

export async function POST(request: Request) {
  const denied = authorizeMobile(request);
  if (denied) return denied;
  try {
    const body = await request.json();
    if (!ACTIONS.has(body?.action)) {
      return Response.json({ error: "不支持的任务类型" }, { status: 400 });
    }
    const data = await createMobileJob({
      action: body.action,
      idempotencyKey: body.idempotencyKey,
      draftId: body.draftId,
      sourceText: body.sourceText,
      transcript: body.transcript,
      rewritten: body.rewritten,
    });
    return Response.json({ data }, { status: 202 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "创建任务失败";
    return Response.json({ error: message }, { status: 400 });
  }
}

