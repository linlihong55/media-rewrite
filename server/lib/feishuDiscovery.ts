import {
  ensureFields,
  ensureTableId,
  feishuFetch,
  resolveAuth,
  type FeishuField,
} from "./feishu";
import type { KeywordContext } from "./discoveryTypes";
import type { ResolvedVideo } from "./resolveVideo";

// 自动发现候选池：与「爆款文案改写记录」表分开的独立表（同一个飞书 Base 下）。
// 表结构/建表逻辑复用 feishu.ts 里参数化后的 ensureTableId/ensureFields/feishuFetch。

const TABLE_NAME = "自动发现候选池";

// 字段类型：1=多行文本 2=数字 5=日期 15=超链接
const TABLE_FIELDS: FeishuField[] = [
  { field_name: "平台", type: 1 },
  { field_name: "L1赛道", type: 1 },
  { field_name: "L2方向", type: 1 },
  { field_name: "L3关键词", type: 1 },
  { field_name: "账号昵称", type: 1 },
  { field_name: "账号主页链接", type: 15 },
  { field_name: "粉丝数", type: 2 },
  { field_name: "点赞数", type: 2 },
  { field_name: "发布时间", type: 5 },
  { field_name: "内容链接", type: 15 },
  { field_name: "内容ID", type: 1 },
  { field_name: "转写文案", type: 1 },
  { field_name: "抓取时间", type: 5 },
  { field_name: "去重状态", type: 1 },
];

export interface CandidateRecord {
  recordId: string;
  diggCount: number;
}

async function auth() {
  const a = await resolveAuth();
  if (!a) throw new Error("飞书未配置（配置见 server/.env.local）");
  const tableId = await ensureTableId(a, TABLE_NAME, TABLE_FIELDS);
  await ensureFields(a, tableId, TABLE_FIELDS);
  return { ...a, tableId };
}

export async function findCandidate(contentId: string): Promise<CandidateRecord | null> {
  const a = await auth();
  const result = await feishuFetch(
    a.apiBase,
    a.token,
    `/open-apis/bitable/v1/apps/${a.appToken}/tables/${a.tableId}/records/search`,
    {
      filter: {
        conjunction: "and",
        conditions: [{ field_name: "内容ID", operator: "is", value: [contentId] }],
      },
    }
  );
  const items =
    (result as { data?: { items?: { record_id?: string; fields?: Record<string, unknown> }[] } })
      .data?.items ?? [];
  const item = items[0];
  if (!item?.record_id) return null;
  const diggCount = item.fields?.["点赞数"];
  return { recordId: item.record_id, diggCount: typeof diggCount === "number" ? diggCount : 0 };
}

export async function createCandidate(
  platform: "douyin" | "xhs",
  video: ResolvedVideo,
  keyword: KeywordContext,
  transcript: string,
  followerCount: number | null
): Promise<string | null> {
  const a = await auth();
  const fields: Record<string, unknown> = {
    平台: platform === "douyin" ? "抖音" : "小红书",
    L1赛道: keyword.l1,
    L2方向: keyword.l2,
    L3关键词: keyword.l3,
    账号昵称: video.author.nickname,
    账号主页链接: video.author.profileUrl
      ? { text: video.author.profileUrl, link: video.author.profileUrl }
      : "",
    点赞数: video.stats.diggCount,
    内容链接: { text: video.sourceUrl, link: video.sourceUrl },
    内容ID: video.videoId,
    转写文案: transcript,
    抓取时间: Date.now(),
    去重状态: "新增",
  };
  if (video.createTime) fields["发布时间"] = video.createTime * 1000;
  if (followerCount != null) fields["粉丝数"] = followerCount;

  const result = await feishuFetch(
    a.apiBase,
    a.token,
    `/open-apis/bitable/v1/apps/${a.appToken}/tables/${a.tableId}/records`,
    { fields }
  );
  return (result as { data?: { record?: { record_id?: string } } }).data?.record?.record_id ?? null;
}

export async function updateCandidateStats(
  recordId: string,
  diggCount: number,
  followerCount: number | null
): Promise<void> {
  const a = await auth();
  const fields: Record<string, unknown> = {
    点赞数: diggCount,
    抓取时间: Date.now(),
    去重状态: "更新",
  };
  if (followerCount != null) fields["粉丝数"] = followerCount;

  await feishuFetch(
    a.apiBase,
    a.token,
    `/open-apis/bitable/v1/apps/${a.appToken}/tables/${a.tableId}/records/${recordId}`,
    { fields },
    "PUT"
  );
}
