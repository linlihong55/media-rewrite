import { NextRequest } from "next/server";
import { corsPreflight, withCors } from "@/lib/cors";
import {
  saveUserVoc,
  type SaveUserVocInput,
  type UserVocComment,
  type UserVocPlatform,
} from "@/lib/userVoc";

export async function OPTIONS() {
  return corsPreflight();
}

function isPlatform(value: unknown): value is UserVocPlatform {
  return value === "douyin" || value === "xhs";
}

function parseComments(value: unknown): UserVocComment[] {
  if (!Array.isArray(value)) throw new Error("comments 必须是数组");
  return value.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`第 ${index + 1} 条评论格式错误`);
    const raw = item as Record<string, unknown>;
    if (typeof raw.content !== "string" || !raw.content.trim()) {
      throw new Error(`第 ${index + 1} 条评论缺少正文`);
    }
    return {
      commentId: typeof raw.commentId === "string" ? raw.commentId : "",
      author: typeof raw.author === "string" ? raw.author : "匿名用户",
      content: raw.content,
      likeCount: typeof raw.likeCount === "number" ? raw.likeCount : 0,
    };
  });
}

export async function POST(request: NextRequest) {
  try {
    const raw = (await request.json()) as Record<string, unknown>;
    if (!isPlatform(raw.platform)) throw new Error("platform 必须是 douyin 或 xhs");
    if (typeof raw.contentId !== "string" || !raw.contentId.trim()) {
      throw new Error("缺少当前内容 ID");
    }
    if (typeof raw.sourceUrl !== "string" || !/^https:\/\//.test(raw.sourceUrl)) {
      throw new Error("当前内容链接无效");
    }
    const input: SaveUserVocInput = {
      platform: raw.platform,
      contentId: raw.contentId.trim(),
      sourceUrl: raw.sourceUrl,
      comments: parseComments(raw.comments),
    };
    if (!input.comments.length) throw new Error("没有可写入的评论");

    const data = await saveUserVoc(input);
    return withCors({ data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "评论保存失败";
    console.error("[user_voc] 保存失败：", message);
    return withCors({ error: message }, { status: 400 });
  }
}
