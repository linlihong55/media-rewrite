import { withCors } from "@/lib/cors";

export async function GET() {
  return withCors({ ok: true });
}
