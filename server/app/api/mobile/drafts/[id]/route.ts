import { authorizeMobile } from "@/lib/mobileAuth";
import { deleteMobileDraft, getMobileDraft } from "@/lib/mobileTasks";

export const runtime = "nodejs";

export async function GET(request: Request, context: RouteContext<"/api/mobile/drafts/[id]">) {
  const denied = authorizeMobile(request);
  if (denied) return denied;
  const { id } = await context.params;
  const draft = await getMobileDraft(id);
  return draft ? Response.json({ data: { draft } }) : Response.json({ error: "草稿不存在" }, { status: 404 });
}

export async function DELETE(request: Request, context: RouteContext<"/api/mobile/drafts/[id]">) {
  const denied = authorizeMobile(request);
  if (denied) return denied;
  const { id } = await context.params;
  try {
    const deleted = await deleteMobileDraft(id);
    return deleted ? Response.json({ data: { deleted: true } }) : Response.json({ error: "草稿不存在" }, { status: 404 });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "删除失败" }, { status: 409 });
  }
}
