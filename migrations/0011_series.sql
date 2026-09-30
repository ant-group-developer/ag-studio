-- GĐ2: productions become series; episodes, revisions, and episode jobs are new.
--
-- productions: new series fields; run_id now points to the *plan* run
--   (the old narrated/montage run_id is kept so archived productions still link to their run).
-- episodes: one row per planned episode; status is DERIVED from the episode's run (no column).
-- episode_revisions: Timeline v3 revisions per episode (replaces timeline_revisions-per-production
--   for new episodes; the old table stays for archived ones).
-- episode_jobs: farm jobs the editor starts outside the workflow (render_preview now; export_premiere GĐ6).
-- studio_farm_jobs: add episode_id for episode-level jobs.
-- Existing productions: mark as archived so the UI hides them from the new series list.

ALTER TABLE productions ADD COLUMN goal                  TEXT;
ALTER TABLE productions ADD COLUMN audience              TEXT;
ALTER TABLE productions ADD COLUMN tone                  TEXT;
ALTER TABLE productions ADD COLUMN notes                 TEXT;
ALTER TABLE productions ADD COLUMN youtube_channels      TEXT;   -- JSON TEXT[]
ALTER TABLE productions ADD COLUMN keywords              TEXT;   -- JSON TEXT[]
ALTER TABLE productions ADD COLUMN episode_target_seconds REAL;
ALTER TABLE productions ADD COLUMN max_episodes          INTEGER;
ALTER TABLE productions ADD COLUMN trend_report          TEXT;   -- JSON TrendReport, set by spawn-episodes

-- Mark all segment-based productions as archived so they do not interfere with the new series UI.
-- run_id stays unchanged (links to the old ag-studio-production@1.0.0 run).
UPDATE productions SET status = 'archived' WHERE status NOT IN ('archived');

-- Episodes
CREATE TABLE episodes (
  id              TEXT PRIMARY KEY,
  production_id   TEXT NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  idx             INTEGER NOT NULL,
  title           TEXT NOT NULL,
  plan            TEXT NOT NULL,   -- studio.episode/v1 JSON
  run_id          TEXT,            -- the ag-studio-episode@1.0.0 run for this episode
  youtube         TEXT,            -- user-edited YoutubeKit JSON; NULL = use the run's kit
  selected_title  INTEGER,         -- index into YoutubeKit.titles (NULL = 0)
  selected_thumbnail INTEGER,      -- index into YoutubeKit.thumbnails (NULL = 0)
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (production_id, idx)
);
CREATE INDEX episodes_prod_idx ON episodes(production_id, idx);
CREATE INDEX episodes_run_idx  ON episodes(run_id) WHERE run_id IS NOT NULL;

-- Episode Timeline v3 revisions (per episode, not per production)
CREATE TABLE episode_revisions (
  id            TEXT PRIMARY KEY,
  episode_id    TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  revision      INTEGER NOT NULL,
  base_revision INTEGER NOT NULL,
  data          TEXT NOT NULL,   -- TimelineV3 JSON
  author_id     TEXT NOT NULL,
  label         TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (episode_id, revision)
);
CREATE INDEX episode_revisions_ep_idx ON episode_revisions(episode_id, revision);

-- Editor farm jobs per episode
CREATE TABLE episode_jobs (
  id            TEXT PRIMARY KEY,
  episode_id    TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('render_preview', 'export_premiere')),
  farm_job_id   TEXT UNIQUE,
  status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  request       TEXT NOT NULL,
  result        TEXT,
  error         TEXT,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX episode_jobs_ep_idx ON episode_jobs(episode_id, created_at);

-- studio_farm_jobs: add episode_id for episode-level render jobs
ALTER TABLE studio_farm_jobs ADD COLUMN episode_id TEXT;
