import { NextRequest } from "next/server";
import type { ResolvedVideo } from "@/lib/resolveVideo";
import { saveCandidate } from "@/lib/saveCandidate";
import { withCors, corsPreflight } from "@/lib/cors";

export async function OPTIONS() {
  return corsPreflight();
}

export async function POST(req: NextRequest) {
  let body: {
    video?: unknown;
    transcript?: unknown;
    rewritten?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return withCors({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const { video, transcript } = body;
  const rewritten = typeof body.rewritten === "string" ? body.rewritten : "";
  if (!video || typeof transcript !== "string" || !transcript.trim()) {
    return withCors({ error: "缺少 video / transcript 参数" }, { status: 400 });
  }

  try {
    return withCors({ data: await saveCandidate(video as ResolvedVideo, transcript, rewritten) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "保存失败";
    console.error("[save] 保存失败：", err);
    return withCors({ error: message }, { status: 500 });
  }
}
