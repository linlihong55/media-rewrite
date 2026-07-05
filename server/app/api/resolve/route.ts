import { NextRequest } from "next/server";
import { resolveVideo } from "@/lib/resolveVideo";
import { withCors, corsPreflight } from "@/lib/cors";

export async function OPTIONS() {
  return corsPreflight();
}

export async function POST(req: NextRequest) {
  let url: string | undefined;
  try {
    const body = await req.json();
    url = body?.url;
  } catch {
    return withCors({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  if (!url || typeof url !== "string") {
    return withCors({ error: "缺少 url 参数" }, { status: 400 });
  }

  try {
    const data = await resolveVideo(url);
    return withCors({ data });
  } catch (err) {
    const message = err instanceof Error ? err.message : "解析失败";
    return withCors({ error: message }, { status: 502 });
  }
}
