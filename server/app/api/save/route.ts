import { NextRequest } from "next/server";
import { saveToFeishu } from "@/lib/feishu";
import { learnFromTranscript } from "@/lib/learn";
import { ResolvedVideo } from "@/lib/resolveVideo";
import { withCors, corsPreflight } from "@/lib/cors";

export async function OPTIONS() {
  return corsPreflight();
}

// 记录只保存到飞书多维表格（本地不再落 md 存档），同步失败直接报错让用户重试
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

  const { video, transcript, rewritten } = body;
  if (!video || typeof transcript !== "string" || typeof rewritten !== "string") {
    return withCors({ error: "缺少 video / transcript / rewritten 参数" }, { status: 400 });
  }

  const resolvedVideo = video as ResolvedVideo;
  const feishu = await saveToFeishu(resolvedVideo, transcript, rewritten);
  if (!feishu.synced) {
    return withCors({ error: feishu.message }, { status: 502 });
  }

  // 后台自动学习这条爆款的特征，更新改写 Skill 的特征库（不阻塞保存）
  void learnFromTranscript(resolvedVideo, transcript).catch((err) =>
    console.error("[learn] 学习失败：", err instanceof Error ? err.message : err)
  );
  return withCors({ data: { feishu } });
}
