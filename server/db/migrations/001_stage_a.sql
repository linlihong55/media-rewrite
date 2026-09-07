CREATE TABLE IF NOT EXISTS candidates (
  id BIGSERIAL PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('douyin', 'xhs')),
  content_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  transcript TEXT NOT NULL DEFAULT '',
  author_name TEXT NOT NULL DEFAULT '',
  author_url TEXT NOT NULL DEFAULT '',
  follower_count BIGINT,
  published_at TIMESTAMPTZ,
  l1 TEXT NOT NULL DEFAULT '',
  l2 TEXT NOT NULL DEFAULT '',
  l3 TEXT NOT NULL DEFAULT '',
  digg_count BIGINT NOT NULL DEFAULT 0,
  collect_count BIGINT,
  comment_count BIGINT,
  share_count BIGINT,
  score NUMERIC(5,2),
  score_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
  recommendation JSONB NOT NULL DEFAULT '{}'::jsonb,
  feishu_record_id TEXT,
  feishu_sync_status TEXT NOT NULL DEFAULT 'pending' CHECK (feishu_sync_status IN ('pending','synced','failed')),
  feishu_sync_error TEXT,
  feishu_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(platform, content_id)
);

CREATE TABLE IF NOT EXISTS content_items (
  id BIGSERIAL PRIMARY KEY,
  candidate_id BIGINT REFERENCES candidates(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT '',
  final_script TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'selected' CHECK (status IN ('selected','writing','filming','editing','review','ready','published','retrospective','completed','shelved')),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('high','medium','low')),
  due_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS publications (
  id BIGSERIAL PRIMARY KEY,
  content_item_id BIGINT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('douyin','xhs')),
  post_url TEXT NOT NULL DEFAULT '',
  published_at TIMESTAMPTZ NOT NULL,
  is_promoted BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS metric_snapshots (
  id BIGSERIAL PRIMARY KEY,
  publication_id BIGINT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  window_hours INTEGER NOT NULL CHECK (window_hours IN (24,72,168)),
  views BIGINT NOT NULL DEFAULT 0,
  completion_rate NUMERIC(6,3),
  collects BIGINT NOT NULL DEFAULT 0,
  follower_gain BIGINT NOT NULL DEFAULT 0,
  likes BIGINT NOT NULL DEFAULT 0,
  comments BIGINT NOT NULL DEFAULT 0,
  shares BIGINT NOT NULL DEFAULT 0,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(publication_id, window_hours)
);

CREATE TABLE IF NOT EXISTS reviews (
  id BIGSERIAL PRIMARY KEY,
  publication_id BIGINT NOT NULL UNIQUE REFERENCES publications(id) ON DELETE CASCADE,
  diagnosis JSONB NOT NULL DEFAULT '[]'::jsonb,
  learning_recommendation TEXT NOT NULL DEFAULT '',
  learning_approved BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS metric_snapshots_candidate (
  id BIGSERIAL PRIMARY KEY,
  candidate_id BIGINT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  digg_count BIGINT NOT NULL DEFAULT 0,
  collect_count BIGINT,
  comment_count BIGINT,
  share_count BIGINT,
  follower_count BIGINT,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS candidates_score_idx ON candidates(score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS content_items_status_idx ON content_items(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS metric_snapshots_candidate_idx ON metric_snapshots_candidate(candidate_id, captured_at DESC);
