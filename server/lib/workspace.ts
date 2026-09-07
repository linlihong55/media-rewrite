import { query, queryOne } from "./db";

export const CONTENT_STATUSES = ["selected","writing","filming","editing","review","ready","published","retrospective","completed","shelved"] as const;
export type ContentStatus = typeof CONTENT_STATUSES[number];

export async function dashboardData() {
  const [summary, candidates, items] = await Promise.all([
    query<{ status: string; count: string }>("SELECT status, count(*)::text count FROM content_items GROUP BY status"),
    query(`SELECT id::text, platform, content_id, title, author_name, follower_count::text,
      digg_count::text, collect_count::text, score::text, recommendation, l2, l3, source_url,
      feishu_sync_status, created_at,
      EXISTS(SELECT 1 FROM content_items ci WHERE ci.candidate_id=candidates.id) AS promoted
      FROM candidates ORDER BY score DESC NULLS LAST, created_at DESC LIMIT 100`),
    query(`SELECT ci.id::text, ci.title, ci.final_script, ci.status, ci.priority, ci.due_at, ci.updated_at,
      c.platform, c.score::text, c.source_url, p.id::text publication_id, p.post_url, p.published_at
      FROM content_items ci LEFT JOIN candidates c ON c.id=ci.candidate_id
      LEFT JOIN publications p ON p.content_item_id=ci.id ORDER BY ci.updated_at DESC LIMIT 200`),
  ]);
  return { summary: Object.fromEntries(summary.map((x) => [x.status, Number(x.count)])), candidates, items };
}

export async function promoteCandidate(candidateId: number) {
  const candidate = await queryOne<{ title: string; transcript: string }>("SELECT title, transcript FROM candidates WHERE id=$1", [candidateId]);
  if (!candidate) throw new Error("候选内容不存在");
  const existing = await queryOne(`SELECT id::text,title,status,priority,updated_at FROM content_items WHERE candidate_id=$1 ORDER BY id LIMIT 1`, [candidateId]);
  if (existing) return existing;
  return queryOne(`INSERT INTO content_items(candidate_id,title,final_script,status)
    VALUES($1,$2,$3,'selected') RETURNING id::text,title,status,priority,updated_at`, [candidateId,candidate.title,candidate.transcript]);
}

export async function updateContent(id: number, input: { status?: string; title?: string; finalScript?: string; priority?: string }) {
  if (input.status && !CONTENT_STATUSES.includes(input.status as ContentStatus)) throw new Error("内容状态无效");
  if (input.priority && !["high", "medium", "low"].includes(input.priority)) throw new Error("优先级无效");
  return queryOne(`UPDATE content_items SET status=COALESCE($2,status),title=COALESCE($3,title),
    final_script=COALESCE($4,final_script),priority=COALESCE($5,priority),updated_at=now() WHERE id=$1
    RETURNING id::text,title,final_script,status,priority,updated_at`,
    [id,input.status ?? null,input.title ?? null,input.finalScript ?? null,input.priority ?? null]);
}

export async function saveMetrics(input: { contentItemId:number; platform:string; postUrl:string; publishedAt:string; windowHours:number; views:number; completionRate:number|null; collects:number; followerGain:number; likes:number; comments:number; shares:number }) {
  if (!Number.isInteger(input.contentItemId) || input.contentItemId <= 0) throw new Error("内容 ID 无效");
  if (!["douyin", "xhs"].includes(input.platform)) throw new Error("发布平台无效");
  if (![24,72,168].includes(input.windowHours)) throw new Error("数据窗口必须是 24、72 或 168 小时");
  const publishedAt = new Date(input.publishedAt);
  if (Number.isNaN(publishedAt.getTime())) throw new Error("发布时间无效");
  const counts = [input.views,input.collects,input.followerGain,input.likes,input.comments,input.shares];
  if (counts.some((value) => !Number.isFinite(value) || value < 0 || !Number.isInteger(value))) throw new Error("数据指标必须是非负整数");
  if (input.completionRate != null && (!Number.isFinite(input.completionRate) || input.completionRate < 0 || input.completionRate > 1)) throw new Error("完播率必须在 0 到 1 之间");
  let publication = await queryOne<{ id:string }>("SELECT id::text FROM publications WHERE content_item_id=$1", [input.contentItemId]);
  if (!publication) publication = await queryOne<{ id:string }>(`INSERT INTO publications(content_item_id,platform,post_url,published_at)
    VALUES($1,$2,$3,$4) RETURNING id::text`, [input.contentItemId,input.platform,input.postUrl,publishedAt]);
  else await query("UPDATE publications SET platform=$1,post_url=$2,published_at=$3 WHERE id=$4", [input.platform,input.postUrl,publishedAt,publication.id]);
  if (!publication) throw new Error("创建发布记录失败");
  await query(`INSERT INTO metric_snapshots(publication_id,window_hours,views,completion_rate,collects,follower_gain,likes,comments,shares)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(publication_id,window_hours) DO UPDATE SET
    views=EXCLUDED.views,completion_rate=EXCLUDED.completion_rate,collects=EXCLUDED.collects,follower_gain=EXCLUDED.follower_gain,
    likes=EXCLUDED.likes,comments=EXCLUDED.comments,shares=EXCLUDED.shares,captured_at=now()`,
    [publication.id,input.windowHours,input.views,input.completionRate,input.collects,input.followerGain,input.likes,input.comments,input.shares]);
  await query("UPDATE content_items SET status='retrospective',updated_at=now() WHERE id=$1", [input.contentItemId]);
  return buildReview(Number(publication.id));
}

async function buildReview(publicationId:number) {
  const m = await queryOne<{ views:string; completion_rate:string|null; collects:string; follower_gain:string; likes:string }>(
    "SELECT views::text,completion_rate::text,collects::text,follower_gain::text,likes::text FROM metric_snapshots WHERE publication_id=$1 ORDER BY window_hours DESC LIMIT 1", [publicationId]);
  if (!m) return null;
  const diagnoses:string[]=[]; const views=Number(m.views), completion=Number(m.completion_rate ?? 0), collects=Number(m.collects), likes=Number(m.likes);
  if (views>0 && completion<0.2) diagnoses.push("播放已有起量，但完播偏弱：缩短铺垫，把核心结果提前到前 5 秒。");
  if (completion>=0.35 && views<1000) diagnoses.push("内容承接较好但初始分发偏弱：优先测试封面、标题和发布时间。");
  if (collects>likes*0.6) diagnoses.push("收藏意愿突出：教程实用性较强，适合继续做系列化内容。");
  if (Number(m.follower_gain)===0 && views>=1000) diagnoses.push("有播放但未形成涨粉：增加账号定位、系列承诺和明确关注理由。");
  if (!diagnoses.length) diagnoses.push("数据暂未出现明显短板，继续补齐后续时间窗口再判断。");
  const recommendation=completion>=0.3||collects>=Math.max(10,likes*0.4)?"建议学习：内容具有较好的完播或收藏信号，请人工确认。":"暂不建议学习：等待更多数据或优化后再评估。";
  return queryOne(`INSERT INTO reviews(publication_id,diagnosis,learning_recommendation) VALUES($1,$2,$3)
    ON CONFLICT(publication_id) DO UPDATE SET diagnosis=EXCLUDED.diagnosis,learning_recommendation=EXCLUDED.learning_recommendation,updated_at=now()
    RETURNING id::text,diagnosis,learning_recommendation,learning_approved`, [publicationId,JSON.stringify(diagnoses),recommendation]);
}
