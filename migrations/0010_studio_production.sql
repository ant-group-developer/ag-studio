-- GĐ4: what `intake` needs to freeze a brief, and the editor's own farm jobs.
--
-- productions.owner_user_id: "chủ production"; background stages act as this user towards ag-go (plan 3.1).
--   NULL on productions created before GĐ4: intake then falls back to the team's owner.
-- target_seconds / aspect / language / voice / music: the brief (plan 4.1 `intake`); voice and music are JSON
--   ({ reference, reference_text, speed } / { track, gain_db, ducking }), NULL = defaults / no music.
ALTER TABLE productions ADD COLUMN owner_user_id  TEXT;
ALTER TABLE productions ADD COLUMN target_seconds REAL;
ALTER TABLE productions ADD COLUMN aspect         TEXT CHECK (aspect IS NULL OR aspect IN ('16:9', '9:16'));
ALTER TABLE productions ADD COLUMN language       TEXT;
ALTER TABLE productions ADD COLUMN voice          TEXT;
ALTER TABLE productions ADD COLUMN music          TEXT;

-- studio_editor_jobs: farm jobs the web editor starts outside the workflow (re-TTS one line, render preview).
--   kind:    'tts_line' | 'render_preview'
--   request: JSON -- { line_id, text } for tts_line, { revision } for render_preview
--   result:  JSON once done -- { key, duration } for tts_line, { key, duration_s, watermarked } for a preview
--   status:  'queued' | 'running' | 'completed' | 'failed'
CREATE TABLE studio_editor_jobs (
  id             TEXT PRIMARY KEY,
  production_id  TEXT NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('tts_line', 'render_preview')),
  farm_job_id    TEXT UNIQUE,
  status         TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  request        TEXT NOT NULL,
  result         TEXT,
  error          TEXT,
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX studio_editor_jobs_prod_idx ON studio_editor_jobs(production_id, created_at);
