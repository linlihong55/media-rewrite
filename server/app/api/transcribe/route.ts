import fs from "fs";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";
import { resolveVideo } from "@/lib/resolveVideo";
import { downloadVideoFile } from "@/lib/downloadVideo";
import { transcribeVideo } from "@/lib/transcribe";
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

  // 转写需要先把视频落到磁盘，但记录只存飞书，所以视频/音频放临时目录，用完即删。
  // 想保留视频文件请用「下载视频」功能。
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dhe-"));
  try {
    const video = await resolveVideo(url);
    const filePath = await downloadVideoFile(
      [video.noWatermarkUrl, video.noWatermarkUrlBackup],
      video.videoId,
      tmpDir
    );
    const transcript = await transcribeVideo(filePath);
    return withCors({ data: { ...video, transcript } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "转写失败";
    return withCors({ error: message }, { status: 502 });
  } finally {
    void fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
