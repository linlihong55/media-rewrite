import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { query, queryOne } from "./db";
import { downloadVideoFile } from "./downloadVideo";
import { parseSharedVideoLink } from "./mobileLinks";
import { resolveVideo, type ResolvedVideo } from "./resolveVideo";
import { rewriteTranscript } from "./rewrite";
import { saveCandidate } from "./saveCandidate";
import { transcribeVideo } from "./transcribe";

export type MobileAction = "transcribe" | "rewrite" | "save" | "retry_feishu";

export interface MobileDraftRow {
  id: string;
  source_text: string;
  source_url: string;
  platform: string;
  content_id: string | null;
  video: ResolvedVideo | null;
  transcript: string;
  rewritten: string;
  candidate_id: string | null;
  feishu_record_id: string | null;
  feishu_sync_status: string;
  feishu_sync_error: string | null;
  saved_at: string | null;
  created_at: string;
  updated_at: string;
  latest_job?: MobileJobRow | null;
}

export interface MobileJobRow {
  id: string;
  draft_id: string;
  action: MobileAction;
  status: "queued" | "running" | "succeeded" | "failed";
  stage: string;
  idempotency_key: string;
  input: Record<string, unknown>;
  result: Record<string, unknown>;
  error_code: string | null;
  error_message: string | null;
  attempts: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

function cleanText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${name}格式不正确`);
  if (value.length > max) throw new Error(`${name}内容过长`);
  return value;
}

export async function createMobileJob(input: {
  action: MobileAction;
  idempotencyKey: string;
  draftId?: string;
  sourceText?: string;
  transcript?: string;
  rewritten?: string;
}): Promise<{ job: MobileJobRow; draft: MobileDraftRow }> {
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(input.idempotencyKey)) throw new Error("请求编号格式不正确");
  const existing = await queryOne<MobileJobRow>(
    "SELECT * FROM mobile_jobs WHERE idempotency_key=$1",
    [input.idempotencyKey]
  );
  if (existing) {
    const draft = await getMobileDraft(existing.draft_id);
    if (!draft) throw new Error("任务草稿不存在");
    startMobileWorker();
    return { job: existing, draft };
  }

  let draft: MobileDraftRow | null = null;
  if (input.action === "transcribe") {
    const active = await queryOne<{ count: number }>(
      `SELECT COUNT(DISTINCT draft_id)::int AS count FROM mobile_jobs
       WHERE status IN ('queued','running')`
    );
    if ((active?.count ?? 0) >= 3) throw new Error("后台任务已满（最多同时处理3条视频）");
    const sourceText = cleanText(input.sourceText, "分享链接", 8_000);
    const parsed = parseSharedVideoLink(sourceText);
    const draftId = input.draftId || randomUUID();
    draft = await queryOne<MobileDraftRow>(
      `INSERT INTO mobile_drafts(id,source_text,source_url,platform)
       VALUES($1,$2,$3,$4)
       ON CONFLICT(id) DO UPDATE SET source_text=EXCLUDED.source_text,source_url=EXCLUDED.source_url,
         platform=EXCLUDED.platform,video=NULL,content_id=NULL,transcript='',rewritten='',updated_at=now()
       RETURNING *`,
      [draftId, sourceText, parsed.url, parsed.platform]
    );
  } else {
    if (!input.draftId) throw new Error("缺少草稿编号");
    draft = await getMobileDraft(input.draftId);
    if (!draft) throw new Error("草稿不存在");
    if (input.action === "rewrite") {
      const transcript = cleanText(input.transcript, "原文案", 200_000).trim();
      if (!transcript) throw new Error("请先提取或填写原文案");
      draft = await queryOne<MobileDraftRow>(
        "UPDATE mobile_drafts SET transcript=$1,updated_at=now() WHERE id=$2 RETURNING *",
        [transcript, draft.id]
      );
    } else {
      const transcript = cleanText(input.transcript, "原文案", 200_000).trim();
      const rewritten = cleanText(input.rewritten ?? "", "改写稿", 200_000);
      if (!transcript) throw new Error("原文案不能为空");
      if (!draft.video) throw new Error("请先提取文案");
      draft = await queryOne<MobileDraftRow>(
        "UPDATE mobile_drafts SET transcript=$1,rewritten=$2,updated_at=now() WHERE id=$3 RETURNING *",
        [transcript, rewritten, draft.id]
      );
    }
  }
  if (!draft) throw new Error("创建草稿失败");

  const job = await queryOne<MobileJobRow>(
    `INSERT INTO mobile_jobs(id,draft_id,action,idempotency_key,input)
     VALUES($1,$2,$3,$4,$5::jsonb) RETURNING *`,
    [randomUUID(), draft.id, input.action, input.idempotencyKey, JSON.stringify({})]
  );
  if (!job) throw new Error("创建任务失败");
  startMobileWorker();
  return { job, draft };
}

export async function getMobileDraft(id: string): Promise<MobileDraftRow | null> {
  return queryOne<MobileDraftRow>("SELECT * FROM mobile_drafts WHERE id=$1", [id]);
}

export async function getMobileJob(id: string): Promise<{ job: MobileJobRow; draft: MobileDraftRow } | null> {
  const job = await queryOne<MobileJobRow>("SELECT * FROM mobile_jobs WHERE id=$1", [id]);
  if (!job) return null;
  const draft = await getMobileDraft(job.draft_id);
  return draft ? { job, draft } : null;
}

export async function listMobileDrafts(limit = 30): Promise<MobileDraftRow[]> {
  return query<MobileDraftRow>(
    `SELECT d.*, latest.latest_job
     FROM mobile_drafts d
     LEFT JOIN LATERAL (
       SELECT jsonb_build_object(
         'id',j.id,'action',j.action,'status',j.status,'stage',j.stage,
         'error_message',j.error_message,'created_at',j.created_at
       ) AS latest_job
       FROM mobile_jobs j WHERE j.draft_id=d.id ORDER BY j.created_at DESC LIMIT 1
     ) latest ON true
     ORDER BY d.updated_at DESC LIMIT $1`,
    [limit]
  );
}

export async function deleteMobileDraft(id: string): Promise<boolean> {
  const running = await queryOne<{ exists: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM mobile_jobs WHERE draft_id=$1 AND status IN ('queued','running')) AS exists",
    [id]
  );
  if (running?.exists) throw new Error("该草稿仍有任务正在处理，暂时不能删除");
  return (await query<{ id: string }>("DELETE FROM mobile_drafts WHERE id=$1 RETURNING id::text", [id])).length > 0;
}

async function setStage(id: string, stage: string): Promise<void> {
  await query("UPDATE mobile_jobs SET stage=$1,updated_at=now() WHERE id=$2", [stage, id]);
}

function errorCode(action: MobileAction): string {
  return action === "transcribe" ? "TRANSCRIBE_FAILED" :
    action === "rewrite" ? "REWRITE_FAILED" : action === "retry_feishu" ? "FEISHU_RETRY_FAILED" : "SAVE_FAILED";
}

async function runJob(job: MobileJobRow): Promise<Record<string, unknown>> {
  const draft = await getMobileDraft(job.draft_id);
  if (!draft) throw new Error("任务草稿不存在");
  if (job.action === "transcribe") {
    await setStage(job.id, "resolving");
    const video = await resolveVideo(draft.source_url);
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dhe-mobile-"));
    try {
      await setStage(job.id, "downloading");
      const filePath = await downloadVideoFile(
        [video.noWatermarkUrl, video.noWatermarkUrlBackup], video.videoId, tmpDir
      );
      await setStage(job.id, "transcribing");
      const transcript = await transcribeVideo(filePath);
      await query(
        `UPDATE mobile_drafts SET video=$1::jsonb,content_id=$2,transcript=$3,rewritten='',updated_at=now()
         WHERE id=$4`,
        [JSON.stringify(video), video.videoId, transcript, draft.id]
      );
      return { transcript, video };
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  if (job.action === "rewrite") {
    await setStage(job.id, "rewriting");
    if (!draft.transcript.trim()) throw new Error("原文案不能为空");
    const result = await rewriteTranscript(draft.transcript);
    await query("UPDATE mobile_drafts SET rewritten=$1,updated_at=now() WHERE id=$2", [result.rewritten, draft.id]);
    return { rewritten: result.rewritten, skipped: result.skipped };
  }

  await setStage(job.id, job.action === "retry_feishu" ? "retrying_feishu" : "saving");
  if (!draft.video || !draft.transcript.trim()) throw new Error("请先提取文案");
  const saved = await saveCandidate(draft.video, draft.transcript, draft.rewritten, {
    learn: job.action !== "retry_feishu",
  });
  await query(
    `UPDATE mobile_drafts SET candidate_id=$1,feishu_record_id=COALESCE($2,feishu_record_id),
      feishu_sync_status=$3,feishu_sync_error=$4,saved_at=now(),updated_at=now() WHERE id=$5`,
    [saved.candidateId, saved.feishu.recordId ?? null, saved.feishu.synced ? "synced" : "failed",
      saved.feishu.synced ? null : saved.feishu.message, draft.id]
  );
  return { candidateId: saved.candidateId, feishu: saved.feishu };
}

async function claimJob(): Promise<MobileJobRow | null> {
  return queryOne<MobileJobRow>(
    `UPDATE mobile_jobs SET status='running',stage='starting',attempts=attempts+1,
       started_at=now(),updated_at=now(),error_code=NULL,error_message=NULL
     WHERE id=(SELECT id FROM mobile_jobs WHERE status='queued' ORDER BY created_at
       FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`
  );
}

async function drainJobs(): Promise<void> {
  await query(
    `UPDATE mobile_jobs SET status='queued',stage='recovered',updated_at=now()
     WHERE status='running' AND updated_at < now() - interval '30 minutes' AND attempts < 3`
  );
  while (true) {
    const job = await claimJob();
    if (!job) return;
    try {
      const result = await runJob(job);
      await query(
        `UPDATE mobile_jobs SET status='succeeded',stage='completed',result=$1::jsonb,
         finished_at=now(),updated_at=now() WHERE id=$2`,
        [JSON.stringify(result), job.id]
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "任务处理失败";
      console.error(`[mobile:${job.action}]`, message);
      await query(
        `UPDATE mobile_jobs SET status='failed',stage='failed',error_code=$1,error_message=$2,
         finished_at=now(),updated_at=now() WHERE id=$3`,
        [errorCode(job.action), message.slice(0, 500), job.id]
      );
    }
  }
}

const WORKER_CONCURRENCY = 3;
const workerGlobal = globalThis as unknown as { mobileWorker?: Promise<void>; mobileWorkerRerun?: boolean };

export function startMobileWorker(): void {
  if (workerGlobal.mobileWorker) {
    workerGlobal.mobileWorkerRerun = true;
    return;
  }
  workerGlobal.mobileWorker = new Promise((resolve) => setImmediate(resolve))
    .then(async () => {
      await Promise.all(Array.from({ length: WORKER_CONCURRENCY }, () => drainJobs()));
    })
    .catch((err) => console.error("[mobile-worker]", err))
    .finally(() => {
      workerGlobal.mobileWorker = undefined;
      if (workerGlobal.mobileWorkerRerun) {
        workerGlobal.mobileWorkerRerun = false;
        startMobileWorker();
      }
    });
}
