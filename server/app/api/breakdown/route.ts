import { NextRequest } from "next/server";
import { breakdownTranscript } from "@/lib/breakdown";
import { ResolvedVideo } from "@/lib/resolveVideo";
import { withCors, corsPreflight } from "@/lib/cors";

export async function OPTIONS() {
  return corsPreflight();
}

export async function POST(req: NextRequest) {
  let body: { video?: unknown; transcript?: unknown };
  try {
    body = await req.json();
  } catch {
    return withCors({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const { video, transcript } = body;
  if (!video || typeof transcript !== "string") {
    return withCors({ error: "缺少 video / transcript 参数" }, { status: 400 });
  }

  try {
    const result = await breakdownTranscript(video as ResolvedVideo, transcript);
    return withCors({ data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "拆解失败";
    return withCors({ error: message }, { status: 502 });
  }
}
