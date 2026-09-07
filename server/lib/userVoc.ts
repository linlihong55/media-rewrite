import { feishuFetch, resolveAuth, type FeishuAuth } from "./feishu";

export type UserVocPlatform = "douyin" | "xhs";

export interface UserVocComment {
  commentId?: string;
  author?: string;
  content: string;
  likeCount?: number;
}

export interface SaveUserVocInput {
  platform: UserVocPlatform;
  contentId: string;
  sourceUrl: string;
  comments: UserVocComment[];
}

export interface SaveUserVocResult {
  tableName: string;
  recordId: string;
  receivedCount: number;
  writtenCount: number;
  duplicateCount: number;
  overflowCount: number;
  fieldCharacterCount: number;
}

const TARGET_APP_TOKEN = "IOEQbJ9EeaVlLfs9FaicqFFVnhU";
const TARGET_TABLE_ID = process.env.USER_VOC_FEISHU_TABLE_ID || "tblHY9afgv0lMXI1";
const TARGET_TABLE_NAME = "01 爆款文案改写记录";
const VIDEO_LINK_FIELD = "视频链接";
const COMMENT_FIELD = "有价值评论";
// 给飞书文本字段预留安全余量，避免在接口侧才因单元格超限而整批失败。
const MAX_FIELD_CHARACTERS = 90_000;

function cleanText(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizedCommentKey(value: unknown): string {
  return cleanText(value).toLocaleLowerCase("zh-CN");
}

export function contentIdFromUrl(url: string, platform: UserVocPlatform): string | null {
  if (platform === "douyin") {
    return url.match(/\/video\/(\d{5,24})/)?.[1] ?? url.match(/[?&]modal_id=(\d{5,24})/)?.[1] ?? null;
  }
  return (
    url.match(/\/(?:explore|discovery\/item|search_result)\/([0-9a-zA-Z]{15,32})/)?.[1] ??
    null
  );
}

function extractCellUrl(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const cell = value as { link?: unknown; text?: unknown };
    if (typeof cell.link === "string") return cell.link;
    if (typeof cell.text === "string" && /^https?:\/\//.test(cell.text)) return cell.text;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = extractCellUrl(item);
      if (url) return url;
    }
  }
  return "";
}

function extractTextCell(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
          return (item as { text: string }).text;
        }
        return "";
      })
      .filter(Boolean)
      .join("");
  }
  if (value && typeof value === "object" && typeof (value as { text?: unknown }).text === "string") {
    return (value as { text: string }).text;
  }
  return "";
}

function existingCommentKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const content = line.replace(/^【[^】]*】\s*/, "");
    const key = normalizedCommentKey(content);
    if (key) keys.add(key);
  }
  return keys;
}

function formatComment(comment: UserVocComment): string {
  const author = cleanText(comment.author) || "匿名用户";
  return `【${author.replace(/[【】]/g, "")}】${cleanText(comment.content)}`;
}

async function pagedItems<T>(auth: FeishuAuth, apiPath: string): Promise<T[]> {
  const items: T[] = [];
  let pageToken = "";
  do {
    const separator = apiPath.includes("?") ? "&" : "?";
    const result = await feishuFetch(
      auth.apiBase,
      auth.token,
      `${apiPath}${pageToken ? `${separator}page_token=${encodeURIComponent(pageToken)}` : ""}`
    );
    const data = (result as {
      data?: { items?: T[]; has_more?: boolean; page_token?: string };
    }).data;
    items.push(...(data?.items ?? []));
    pageToken = data?.has_more ? data.page_token ?? "" : "";
  } while (pageToken);
  return items;
}

async function validateTarget(auth: FeishuAuth): Promise<void> {
  if (auth.appToken !== TARGET_APP_TOKEN) {
    throw new Error("当前飞书配置不是 user_voc 指定的多维表格 Base，已停止写入");
  }

  const tables = await pagedItems<{ table_id?: string; name?: string }>(
    auth,
    `/open-apis/bitable/v1/apps/${auth.appToken}/tables?page_size=100`
  );
  const table = tables.find((item) => item.table_id === TARGET_TABLE_ID);
  if (!table || table.name !== TARGET_TABLE_NAME) {
    throw new Error(
      `目标数据表校验失败：期望“${TARGET_TABLE_NAME}”(${TARGET_TABLE_ID})，已停止写入`
    );
  }

  const fields = await pagedItems<{ field_name?: string; type?: number }>(
    auth,
    `/open-apis/bitable/v1/apps/${auth.appToken}/tables/${TARGET_TABLE_ID}/fields?page_size=100`
  );
  const videoField = fields.find((field) => field.field_name === VIDEO_LINK_FIELD);
  const commentField = fields.find((field) => field.field_name === COMMENT_FIELD);
  if (!videoField) throw new Error(`目标表缺少“${VIDEO_LINK_FIELD}”字段，无法匹配原视频`);
  if (!commentField || commentField.type !== 1) {
    throw new Error(`目标表“${COMMENT_FIELD}”字段不存在或不是多行文本，已停止写入`);
  }
}

async function findMatchingRecord(
  auth: FeishuAuth,
  platform: UserVocPlatform,
  contentId: string
): Promise<{ recordId: string; fields: Record<string, unknown> } | null> {
  const records = await pagedItems<{
    record_id?: string;
    fields?: Record<string, unknown>;
  }>(
    auth,
    `/open-apis/bitable/v1/apps/${auth.appToken}/tables/${TARGET_TABLE_ID}/records?page_size=500`
  );
  for (const record of records) {
    const url = extractCellUrl(record.fields?.[VIDEO_LINK_FIELD]);
    if (!url || contentIdFromUrl(url, platform) !== contentId) continue;
    if (!record.record_id) continue;
    return { recordId: record.record_id, fields: record.fields ?? {} };
  }
  return null;
}

export async function saveUserVoc(input: SaveUserVocInput): Promise<SaveUserVocResult> {
  const auth = await resolveAuth();
  if (!auth) throw new Error("飞书未配置，请先配置现有爆款文案改写本地服务");
  await validateTarget(auth);

  const submittedUrlId = contentIdFromUrl(input.sourceUrl, input.platform);
  if (submittedUrlId && submittedUrlId !== input.contentId) {
    throw new Error("当前页面的视频 ID 与提交链接不一致，已停止写入");
  }

  const record = await findMatchingRecord(auth, input.platform, input.contentId);
  if (!record) {
    throw new Error(
      `“${TARGET_TABLE_NAME}”中没有找到该${input.platform === "douyin" ? "抖音视频" : "小红书笔记"}的视频链接；请先用“爆款文案改写”保存原内容`
    );
  }

  const existingText = extractTextCell(record.fields[COMMENT_FIELD]).trim();
  const knownKeys = existingCommentKeys(existingText);
  const incoming = new Map<string, UserVocComment>();
  for (const comment of input.comments) {
    const content = cleanText(comment.content);
    const key = normalizedCommentKey(content);
    if (!key || incoming.has(key)) continue;
    incoming.set(key, { ...comment, content, author: cleanText(comment.author) });
  }

  let merged = existingText;
  let writtenCount = 0;
  let overflowCount = 0;
  for (const [key, comment] of incoming) {
    if (knownKeys.has(key)) continue;
    const line = formatComment(comment);
    const candidate = merged ? `${merged}\n${line}` : line;
    if (candidate.length > MAX_FIELD_CHARACTERS) {
      overflowCount++;
      continue;
    }
    merged = candidate;
    knownKeys.add(key);
    writtenCount++;
  }

  if (writtenCount > 0) {
    await feishuFetch(
      auth.apiBase,
      auth.token,
      `/open-apis/bitable/v1/apps/${auth.appToken}/tables/${TARGET_TABLE_ID}/records/${record.recordId}`,
      { fields: { [COMMENT_FIELD]: merged } },
      "PUT"
    );
  }

  const receivedCount = input.comments.length;
  return {
    tableName: TARGET_TABLE_NAME,
    recordId: record.recordId,
    receivedCount,
    writtenCount,
    duplicateCount: Math.max(0, receivedCount - writtenCount - overflowCount),
    overflowCount,
    fieldCharacterCount: merged.length,
  };
}
