import { authorizeMobile } from "@/lib/mobileAuth";
import { databaseHealth } from "@/lib/db";
import { startMobileWorker } from "@/lib/mobileTasks";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = authorizeMobile(request);
  if (denied) return denied;
  const database = await databaseHealth();
  if (database) startMobileWorker();
  return Response.json(
    { data: { ok: database, database, mobileApi: true } },
    { status: database ? 200 : 503 }
  );
}

