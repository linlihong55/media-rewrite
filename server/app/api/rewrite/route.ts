import { NextRequest } from "next/server";
import { rewriteTranscript } from "@/lib/rewrite";
import { withCors, corsPreflight } from "@/lib/cors";

export async function OPTIONS() {
  return corsPreflight();
}

export async function POST(req: NextRequest) {
  let text: string | undefined;
  try {
    const body = await req.json();
    text = body?.text;
  } catch {
    return withCors({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  if (!text || typeof text !== "string") {
    return withCors({ error: "缺少 text 参数" }, { status: 400 });
  }

  try {
    const result = await rewriteTranscript(text);
    return withCors({ data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "改写失败";
    return withCors({ error: message }, { status: 502 });
  }
}
