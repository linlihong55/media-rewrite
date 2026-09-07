import fs from "fs";
import os from "os";
import path from "path";
import keywordsConfig from "../config/keywords.json";
import { resolveVideo } from "./resolveVideo";
import { downloadVideoFile } from "./downloadVideo";
import { transcribeVideo } from "./transcribe";
import { searchDouyinByKeyword, fetchDouyinFollowerCount } from "./searchDouyin";
import { searchXhsByKeyword } from "./searchXhs";
import { fetchXhsFollowerCount } from "./resolveXhs";
import { findCandidate, createCandidate, updateCandidateStats } from "./feishuDiscovery";
import type { KeywordContext, SearchHit } from "./discoveryTypes";
import { query, queryOne } from "./db";
import { scoreCandidate } from "./scoring";

// 编排整个「关键词驱动的低粉高赞内容自动发现」流程（PRD 第 9 节）。
// 手动触发（/api/discover）和 launchd 定时任务共用这一个函数，每次都是跑全量关键词。

const MAX_FOLLOWER_COUNT = 10_000;
const MIN_DIGG_COUNT = 5000;
const MAX_AGE_DAYS = 7;
// 点赞数「明显增长」才更新已有记录：绝对值和相对涨幅都要达到，避免抖动造成的误判
const GROWTH_MIN_ABS = 500;
const GROWTH_MIN_RATIO = 1.2;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitterSleep = (minMs: number, maxMs: number) => sleep(minMs + Math.random() * (maxMs - minMs));

interface RunSummary {
  keywords: number;
  candidates: number;
  created: number;
  updated: number;
  failed: number;
}

export async function runDiscovery(): Promise<void> {
  const keywordList = flattenKeywords();
  const summary: RunSummary = {
    keywords: keywordList.length,
    candidates: 0,
    created: 0,
    updated: 0,
    failed: 0,
  };
  console.log(`[discover] 开始新一轮自动发现，共 ${keywordList.length} 个关键词`);

  for (const kw of keywordList) {
    for (const platform of ["douyin", "xhs"] as const) {
      try {
        const hits = await searchByPlatform(platform, kw.l3);
        for (const hit of hits) {
          if (hit.roughDiggCount < MIN_DIGG_COUNT) continue;
          summary.candidates++;
          try {
            const outcome = await processCandidate(platform, hit, kw);
            if (outcome === "created") summary.created++;
            else if (outcome === "updated") summary.updated++;
          } catch (err) {
            summary.failed++;
            console.error(
              `[discover] ${platform} "${kw.l3}" 候选 ${hit.url} 处理失败：`,
              err instanceof Error ? err.message : err
            );
          }
          await jitterSleep(4000, 9000);
        }
      } catch (err) {
        summary.failed++;
        console.error(
          `[discover] ${platform} "${kw.l3}" 搜索失败：`,
          err instanceof Error ? err.message : err
        );
      }
      await jitterSleep(15000, 30000);
    }
  }

  console.log(
    `[discover] 本轮结束：关键词 ${summary.keywords}，候选 ${summary.candidates}，新增 ${summary.created}，更新 ${summary.updated}，失败 ${summary.failed}`
  );
}

function flattenKeywords(): KeywordContext[] {
  const result: KeywordContext[] = [];
  for (const l1 of keywordsConfig.l1) {
    for (const l2 of l1.l2) {
      for (const l3 of l2.keywords) {
        result.push({ l1: l1.name, l2: l2.name, l3 });
      }
    }
  }
  return result;
}

function searchByPlatform(platform: "douyin" | "xhs", keyword: string): Promise<SearchHit[]> {
  return platform === "douyin" ? searchDouyinByKeyword(keyword) : searchXhsByKeyword(keyword);
}

// 搜索结果只带粗略信号，先用 resolveVideo()（现有单条链接解析逻辑，两个平台都支持）
// 拿权威数据 + 下载直链，再套硬性条件；这样也顺带拿到了后面下载视频要用的无水印地址。
async function processCandidate(
  platform: "douyin" | "xhs",
  hit: SearchHit,
  keyword: KeywordContext
): Promise<"created" | "updated" | "skipped"> {
  const video = await resolveVideo(hit.url);

  let followerCount = video.author.followerCount;
  if (followerCount == null) {
    followerCount =
      platform === "douyin"
        ? await fetchDouyinFollowerCount(video.author.secUid)
        : await fetchXhsFollowerCount(video.author.secUid);
  }
  if (followerCount == null || followerCount > MAX_FOLLOWER_COUNT) return "skipped";
  if (video.stats.diggCount < MIN_DIGG_COUNT) return "skipped";
  if (!isWithinDays(video.createTime, MAX_AGE_DAYS)) return "skipped";

  const existingLocal = await queryOne<{ id: string; digg_count: string }>(
    "SELECT id, digg_count FROM candidates WHERE platform = $1 AND content_id = $2",
    [platform, video.videoId]
  );
  const existing = existingLocal ? { recordId: "", diggCount: Number(existingLocal.digg_count) } : await findCandidate(video.videoId).catch(() => null);
  if (!existing) {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dhe-discover-"));
    try {
      const filePath = await downloadVideoFile(
        [video.noWatermarkUrl, video.noWatermarkUrlBackup],
        video.videoId,
        tmpDir
      );
      const transcript = await transcribeVideo(filePath);
      const scored = scoreCandidate({
        followerCount,
        diggCount: video.stats.diggCount,
        collectCount: video.stats.collectCount,
        commentCount: video.stats.commentCount,
        publishedAt: video.createTime ? new Date(video.createTime * 1000) : null,
        title: video.title,
        transcript,
      });
      const rows = await query<{ id: string }>(
        `INSERT INTO candidates
          (platform, content_id, source_url, title, transcript, author_name, author_url, follower_count,
           published_at, l1, l2, l3, digg_count, collect_count, comment_count, share_count, score,
           score_breakdown, recommendation)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (platform, content_id) DO UPDATE SET
           digg_count=EXCLUDED.digg_count, collect_count=EXCLUDED.collect_count,
           comment_count=EXCLUDED.comment_count, share_count=EXCLUDED.share_count,
           score=EXCLUDED.score, score_breakdown=EXCLUDED.score_breakdown, updated_at=now()
         RETURNING id`,
        [platform, video.videoId, video.sourceUrl, video.title, transcript, video.author.nickname,
         video.author.profileUrl, followerCount, video.createTime ? new Date(video.createTime * 1000) : null,
         keyword.l1, keyword.l2, keyword.l3, video.stats.diggCount, video.stats.collectCount,
         video.stats.commentCount, video.stats.shareCount, scored.score, JSON.stringify(scored.breakdown),
         JSON.stringify({ level: scored.level })]
      );
      const candidateId = rows[0].id;
      await query(`INSERT INTO metric_snapshots_candidate
        (candidate_id,digg_count,collect_count,comment_count,share_count,follower_count)
        VALUES ($1,$2,$3,$4,$5,$6)`, [candidateId, video.stats.diggCount, video.stats.collectCount,
        video.stats.commentCount, video.stats.shareCount, followerCount]);
      void createCandidate(platform, video, keyword, transcript, followerCount)
        .then((recordId) => recordId
          ? query("UPDATE candidates SET feishu_record_id=$1, feishu_sync_status='synced', feishu_synced_at=now() WHERE id=$2", [recordId, candidateId])
          : query("UPDATE candidates SET feishu_sync_status='failed', feishu_sync_error='飞书接口未返回记录 ID' WHERE id=$1", [candidateId]))
        .catch((err) => query("UPDATE candidates SET feishu_sync_status='failed', feishu_sync_error=$1 WHERE id=$2", [err instanceof Error ? err.message : String(err), candidateId]));
      return "created";
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  const grewEnough =
    video.stats.diggCount - existing.diggCount >= GROWTH_MIN_ABS &&
    video.stats.diggCount >= existing.diggCount * GROWTH_MIN_RATIO;
  if (!grewEnough) return "skipped";

  if (existingLocal) {
    await query("UPDATE candidates SET digg_count=$1, follower_count=$2, updated_at=now() WHERE id=$3", [video.stats.diggCount, followerCount, existingLocal.id]);
    await query("INSERT INTO metric_snapshots_candidate (candidate_id,digg_count,collect_count,comment_count,share_count,follower_count) VALUES ($1,$2,$3,$4,$5,$6)", [existingLocal.id, video.stats.diggCount, video.stats.collectCount, video.stats.commentCount, video.stats.shareCount, followerCount]);
  }
  if (existing.recordId) await updateCandidateStats(existing.recordId, video.stats.diggCount, followerCount);
  return "updated";
}

let activeDiscovery: Promise<void> | null = null;

export function startDiscovery(): boolean {
  if (activeDiscovery) return false;
  activeDiscovery = runDiscovery()
    .catch((err) => console.error("[discover] 本轮执行失败：", err instanceof Error ? err.message : err))
    .finally(() => {
      activeDiscovery = null;
    });
  return true;
}

function isWithinDays(createTimeSec: number, days: number): boolean {
  if (!createTimeSec) return false;
  const ageMs = Date.now() - createTimeSec * 1000;
  return ageMs >= 0 && ageMs <= days * 24 * 60 * 60 * 1000;
}
