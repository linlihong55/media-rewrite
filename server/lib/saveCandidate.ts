import { query } from "./db";
import { saveToFeishu, type FeishuSyncResult } from "./feishu";
import { learnFromTranscript } from "./learn";
import { isXhsUrl } from "./resolveXhs";
import type { ResolvedVideo } from "./resolveVideo";
import { scoreCandidate } from "./scoring";

export interface SavedCandidate {
  candidateId: string;
  feishu: FeishuSyncResult;
}

export async function saveCandidate(
  resolvedVideo: ResolvedVideo,
  transcript: string,
  rewritten = "",
  options: { learn?: boolean } = {}
): Promise<SavedCandidate> {
  if (!resolvedVideo.videoId || !resolvedVideo.sourceUrl || !resolvedVideo.author || !resolvedVideo.stats) {
    throw new Error("video 数据不完整");
  }
  if (!transcript.trim()) throw new Error("原文案不能为空");

  const platform = isXhsUrl(resolvedVideo.sourceUrl) ? "xhs" : "douyin";
  const scored = scoreCandidate({
    followerCount: resolvedVideo.author.followerCount,
    diggCount: resolvedVideo.stats.diggCount,
    collectCount: resolvedVideo.stats.collectCount,
    commentCount: resolvedVideo.stats.commentCount,
    publishedAt: resolvedVideo.createTime ? new Date(resolvedVideo.createTime * 1000) : null,
    title: resolvedVideo.title,
    transcript,
  });
  const saved = await query<{ id: string; feishu_record_id: string | null }>(
    `INSERT INTO candidates(platform,content_id,source_url,title,transcript,author_name,author_url,
      follower_count,published_at,digg_count,collect_count,comment_count,share_count,score,score_breakdown,recommendation)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT(platform,content_id) DO UPDATE SET
      source_url=EXCLUDED.source_url,title=EXCLUDED.title,transcript=EXCLUDED.transcript,
      author_name=EXCLUDED.author_name,author_url=EXCLUDED.author_url,
      follower_count=EXCLUDED.follower_count,published_at=EXCLUDED.published_at,
      digg_count=EXCLUDED.digg_count,collect_count=EXCLUDED.collect_count,
      comment_count=EXCLUDED.comment_count,share_count=EXCLUDED.share_count,
      score=EXCLUDED.score,score_breakdown=EXCLUDED.score_breakdown,
      recommendation=EXCLUDED.recommendation,updated_at=now()
     RETURNING id::text,feishu_record_id`,
    [platform, resolvedVideo.videoId, resolvedVideo.sourceUrl, resolvedVideo.title, transcript,
      resolvedVideo.author.nickname, resolvedVideo.author.profileUrl, resolvedVideo.author.followerCount,
      resolvedVideo.createTime ? new Date(resolvedVideo.createTime * 1000) : null,
      resolvedVideo.stats.diggCount, resolvedVideo.stats.collectCount, resolvedVideo.stats.commentCount,
      resolvedVideo.stats.shareCount, scored.score, JSON.stringify(scored.breakdown),
      JSON.stringify({ level: scored.level })]
  );
  const candidateId = saved[0].id;

  if (rewritten.trim()) {
    await query(
      `INSERT INTO content_items(candidate_id,title,final_script,status)
       SELECT $1,$2,$3,'writing' WHERE NOT EXISTS (SELECT 1 FROM content_items WHERE candidate_id=$1)`,
      [candidateId, resolvedVideo.title, rewritten]
    );
    await query(
      `UPDATE content_items SET final_script=$1,title=$2,updated_at=now() WHERE candidate_id=$3`,
      [rewritten, resolvedVideo.title, candidateId]
    );
  }

  const feishu = await saveToFeishu(resolvedVideo, transcript, rewritten, saved[0].feishu_record_id);
  await query(
    `UPDATE candidates SET feishu_record_id=COALESCE($1,feishu_record_id),feishu_sync_status=$2,
      feishu_sync_error=$3,feishu_synced_at=CASE WHEN $2='synced' THEN now() ELSE NULL END WHERE id=$4`,
    [feishu.recordId ?? null, feishu.synced ? "synced" : "failed", feishu.synced ? null : feishu.message, candidateId]
  );
  if (options.learn !== false) {
    void learnFromTranscript(resolvedVideo, transcript).catch((err) =>
      console.error("[learn] 学习失败：", err instanceof Error ? err.message : err)
    );
  }
  return { candidateId, feishu };
}
