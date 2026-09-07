import { withCors } from "@/lib/cors";
import { databaseHealth } from "@/lib/db";

export async function GET() {
  const database = await databaseHealth();
  return withCors({ ok: database, database }, { status: database ? 200 : 503 });
}
