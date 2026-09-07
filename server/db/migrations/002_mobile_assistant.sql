CREATE TABLE IF NOT EXISTS mobile_drafts (
  id UUID PRIMARY KEY,
  source_text TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('douyin', 'xhs')),
  content_id TEXT,
  video JSONB,
  transcript TEXT NOT NULL DEFAULT '',
  rewritten TEXT NOT NULL DEFAULT '',
  candidate_id BIGINT REFERENCES candidates(id) ON DELETE SET NULL,
  feishu_record_id TEXT,
  feishu_sync_status TEXT NOT NULL DEFAULT 'pending',
  feishu_sync_error TEXT,
  saved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mobile_jobs (
  id UUID PRIMARY KEY,
  draft_id UUID NOT NULL REFERENCES mobile_drafts(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('transcribe', 'rewrite', 'save', 'retry_feishu')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  stage TEXT NOT NULL DEFAULT 'queued',
  idempotency_key TEXT NOT NULL UNIQUE,
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code TEXT,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mobile_jobs_status_created_idx ON mobile_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS mobile_jobs_draft_created_idx ON mobile_jobs(draft_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mobile_drafts_updated_idx ON mobile_drafts(updated_at DESC);

