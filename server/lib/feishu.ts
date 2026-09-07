import fs from "fs";
import path from "path";
import { ResolvedVideo } from "./resolveVideo";

// 把改写记录同步到飞书多维表格。两种凭证方式（配在 server/.env.local）：
// 1. FEISHU_PERSONAL_BASE_TOKEN + FEISHU_BITABLE_URL（个人授权码，推荐）
// 2. FEISHU_APP_ID + FEISHU_APP_SECRET + FEISHU_BITABLE_URL（企业自建应用）
// 数据表和字段由程序自动创建，表 ID 记在 server/.feishu-state.json 里复用。

const TABLE_NAME = "爆款文案改写记录";
const STATE_FILE = process.env.FEISHU_STATE_FILE ?? path.join(process.cwd(), ".feishu-state.json");

// 字段类型：1=多行文本 2=数字 5=日期 15=超链接
const TABLE_FIELDS = [
  { field_name: "标题", type: 1 },
  { field_name: "正文", type: 1 },
  { field_name: "标签", type: 1 },
  { field_name: "发布时间", type: 5 },
  { field_name: "账号", type: 1 },
  { field_name: "粉丝数", type: 2 },
  { field_name: "点赞数", type: 2 },
  { field_name: "收藏数", type: 2 },
  { field_name: "原文案", type: 1 },
  { field_name: "改写稿", type: 1 },
  { field_name: "视频链接", type: 15 },
  { field_name: "记录时间", type: 5 },
];

export interface FeishuSyncResult {
  synced: boolean;
  message: string;
  recordId?: string;
}

export interface FeishuField {
  field_name: string;
  type: number;
}

export interface FeishuAuth {
  apiBase: string;
  token: string;
  appToken: string;
  tableId?: string;
}

function parseBitableUrl(url: string): { appToken: string; tableId?: string } | null {
  const appMatch = url.match(/\/base\/([A-Za-z0-9]+)/);
  if (!appMatch) return null;
  const tableMatch = url.match(/[?&]table=(tbl\w+)/);
  return { appToken: appMatch[1], tableId: tableMatch?.[1] };
}

export async function feishuFetch(
  apiBase: string,
  token: string,
  apiPath: string,
  body?: unknown,
  method?: "GET" | "POST" | "PUT"
): Promise<Record<string, unknown>> {
  const res = await fetch(`${apiBase}${apiPath}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json()) as { code?: number; msg?: string };
  if (!res.ok || (typeof json.code === "number" && json.code !== 0)) {
    throw new Error(`飞书接口 ${apiPath} 返回错误：${json.msg || `HTTP ${res.status}`}`);
  }
  return json as Record<string, unknown>;
}

async function getTenantToken(apiBase: string, appId: string, appSecret: string): Promise<string> {
  const res = await fetch(`${apiBase}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = await res.json();
  if (json.code !== 0 || !json.tenant_access_token) {
    throw new Error(`获取飞书应用凭证失败：${json.msg || "未知错误"}`);
  }
  return json.tenant_access_token;
}

export async function resolveAuth(): Promise<FeishuAuth | null> {
  const bitableUrl = process.env.FEISHU_BITABLE_URL || "";
  const parsed = bitableUrl ? parseBitableUrl(bitableUrl) : null;

  const personalToken = process.env.FEISHU_PERSONAL_BASE_TOKEN;
  if (personalToken) {
    if (!parsed) {
      throw new Error(
        "配置了 FEISHU_PERSONAL_BASE_TOKEN 但 FEISHU_BITABLE_URL 缺失或不是 /base/ 链接"
      );
    }
    return {
      apiBase: process.env.FEISHU_API_BASE || "https://base-api.feishu.cn",
      token: personalToken,
      appToken: parsed.appToken,
      tableId: parsed.tableId,
    };
  }

  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (appId && appSecret) {
    if (!parsed) {
      throw new Error("配置了飞书应用凭证但 FEISHU_BITABLE_URL 缺失或不是 /base/ 链接");
    }
    const apiBase = process.env.FEISHU_API_BASE || "https://open.feishu.cn";
    const token = await getTenantToken(apiBase, appId, appSecret);
    return { apiBase, token, appToken: parsed.appToken, tableId: parsed.tableId };
  }

  return null; // 未配置飞书，跳过同步
}

interface FeishuState {
  [appToken: string]: {
    [tableName: string]: string; // 表名 -> 自动创建的 tableId
  };
}

function readState(): FeishuState {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
  // 旧版本每个 appToken 只存一张表的 tableId（纯字符串），迁移成「表名 -> tableId」的嵌套结构，
  // 避免多表化之后把老用户已有的 .feishu-state.json 当成对象用而崩溃/建出重复表
  const migrated: FeishuState = {};
  for (const [appToken, value] of Object.entries(raw)) {
    migrated[appToken] =
      typeof value === "string" ? { [TABLE_NAME]: value } : (value as { [k: string]: string });
  }
  return migrated;
}

// 按「表名 + 字段清单」自动建表（不存在就建，存在就复用 state 里记的 tableId）。
// 同一个 Base 下可以有多张表各自调用这个函数，互不影响。
export async function ensureTableId(
  auth: FeishuAuth,
  tableName: string,
  fields: FeishuField[]
): Promise<string> {
  const state = readState();
  const tables = state[auth.appToken] ?? {};
  if (tables[tableName]) return tables[tableName];

  const created = await feishuFetch(
    auth.apiBase,
    auth.token,
    `/open-apis/bitable/v1/apps/${auth.appToken}/tables`,
    {
      table: {
        name: tableName,
        default_view_name: "全部记录",
        fields,
      },
    }
  );
  const tableId = (created as { data?: { table_id?: string } }).data?.table_id;
  if (!tableId) throw new Error("飞书自动建表失败：接口没有返回 table_id");

  tables[tableName] = tableId;
  state[auth.appToken] = tables;
  await fs.promises.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  return tableId;
}

// 老表可能缺新加的字段，保存前对照补齐。每个表每次进程只检查一次。
const ensuredTables = new Set<string>();

export async function ensureFields(
  auth: FeishuAuth,
  tableId: string,
  fields: FeishuField[]
): Promise<void> {
  if (ensuredTables.has(tableId)) return;

  const listed = await feishuFetch(
    auth.apiBase,
    auth.token,
    `/open-apis/bitable/v1/apps/${auth.appToken}/tables/${tableId}/fields?page_size=100`
  );
  const items =
    (listed as { data?: { items?: { field_name?: string }[] } }).data?.items ?? [];
  const existing = new Set(items.map((f) => f.field_name));

  for (const field of fields) {
    if (existing.has(field.field_name)) continue;
    await feishuFetch(
      auth.apiBase,
      auth.token,
      `/open-apis/bitable/v1/apps/${auth.appToken}/tables/${tableId}/fields`,
      { field_name: field.field_name, type: field.type }
    );
  }
  ensuredTables.add(tableId);
}

export async function saveToFeishu(
  video: ResolvedVideo,
  transcript: string,
  rewritten: string,
  existingRecordId?: string | null
): Promise<FeishuSyncResult> {
  try {
    const auth = await resolveAuth();
    if (!auth) {
      return { synced: false, message: "飞书未配置，已跳过飞书同步" };
    }

    const tableId = auth.tableId ?? (await ensureTableId(auth, TABLE_NAME, TABLE_FIELDS));
    await ensureFields(auth, tableId, TABLE_FIELDS);

    const fields: Record<string, unknown> = {
      标题: video.title || "",
      正文: video.desc || "",
      标签: video.hashtags?.length ? video.hashtags.map((t) => `#${t}`).join(" ") : "",
      账号: `${video.author.nickname}（${video.author.profileUrl}）`,
      点赞数: video.stats.diggCount,
      收藏数: video.stats.collectCount,
      原文案: transcript,
      视频链接: { text: video.sourceUrl, link: video.sourceUrl },
      记录时间: Date.now(),
    };
    if (rewritten.trim()) fields["改写稿"] = rewritten;
    if (video.createTime) fields["发布时间"] = video.createTime * 1000;
    if (video.author.followerCount != null) fields["粉丝数"] = video.author.followerCount;

    const result = await feishuFetch(
      auth.apiBase,
      auth.token,
      `/open-apis/bitable/v1/apps/${auth.appToken}/tables/${tableId}/records${
        existingRecordId ? `/${existingRecordId}` : ""
      }`,
      { fields },
      existingRecordId ? "PUT" : "POST"
    );
    const recordId =
      existingRecordId ??
      (result as { data?: { record?: { record_id?: string } } }).data?.record?.record_id;

    return { synced: true, message: "已同步到飞书多维表格", recordId };
  } catch (err) {
    const message = err instanceof Error ? err.message : "未知错误";
    return { synced: false, message: `飞书同步失败：${message}` };
  }
}
