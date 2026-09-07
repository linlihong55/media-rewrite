import { authorizeMobile } from "@/lib/mobileAuth";
import { listMobileDrafts } from "@/lib/mobileTasks";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = authorizeMobile(request);
  if (denied) return denied;
  return Response.json({ data: { drafts: await listMobileDrafts() } });
}

