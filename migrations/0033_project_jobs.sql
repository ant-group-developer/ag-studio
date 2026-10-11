-- Việc nặng của dự án chạy nền và đầu vào đã chuẩn bị (spec 2026-10-10 agent-workspace §3.4, §5, ADR-0001 mục 187–188).
--
-- project_jobs: một việc (chuẩn bị video đầu vào, render, đọc lời dẫn…) do agent hoặc người khởi động; worker chạy.
--   phase/progress/eta_seconds/node_id: hiện cho người xem (ai làm, tới đâu, còn bao lâu); units: độ lớn của việc
--   (giây video…) để ước tính theo các việc cùng loại đã xong. thread_id: luồng chat được báo khi xong;
--   continue_agent: báo xong thì agent làm tiếp (nếu cài đặt dự án cho phép).
CREATE TABLE project_jobs (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  video_id          TEXT REFERENCES videos(id) ON DELETE CASCADE,
  thread_id         TEXT REFERENCES agent_threads(id) ON DELETE SET NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('prepare_asset', 'transcribe_upload', 'tts', 'fit', 'render_preview', 'render_final', 'export_premiere', 'research', 'style_watch', 'thumbnail')),
  status            TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  title             TEXT NOT NULL,
  request           TEXT NOT NULL,
  result            TEXT,
  error             TEXT,
  phase             TEXT,
  progress          REAL,
  eta_seconds       REAL,
  node_id           TEXT,
  units             REAL,
  farm_job_id       TEXT,
  cancel_requested  INTEGER NOT NULL DEFAULT 0,
  continue_agent    INTEGER NOT NULL DEFAULT 0,
  attempts          INTEGER NOT NULL DEFAULT 0,
  created_by        TEXT NOT NULL,
  actor_role        TEXT,
  created_at        TEXT NOT NULL,
  started_at        TEXT,
  finished_at       TEXT,
  updated_at        TEXT NOT NULL
);
CREATE INDEX project_jobs_status_idx ON project_jobs(status, created_at);
CREATE INDEX project_jobs_project_idx ON project_jobs(project_id, created_at);

-- Job farm của dự án: /farm/sign tìm ở đây (sau studio_farm_jobs) để biết dự án, chủ dự án và tiền tố
-- productions/<project_id>/jobs/<stage_key>/<attempt_id>/{in,out}/ (giữ nguyên quy ước farm, project = production).
CREATE TABLE project_farm_jobs (
  farm_job_id      TEXT PRIMARY KEY,
  job_id           TEXT NOT NULL REFERENCES project_jobs(id) ON DELETE CASCADE,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  video_id         TEXT,
  stage_key        TEXT NOT NULL,
  attempt_id       TEXT NOT NULL,
  job_type         TEXT NOT NULL,
  is_final_render  INTEGER NOT NULL DEFAULT 0,
  requirements     TEXT NOT NULL DEFAULT '{}',
  created_at       TEXT NOT NULL
);

-- Video ag-go đã chuẩn bị trong inputs/<asset>/ của dự án (một lần cho mọi video của dự án).
CREATE TABLE prepared_assets (
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  asset_id      TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('ready', 'failed')),
  name          TEXT,
  duration_s    REAL,
  width         INTEGER,
  height        INTEGER,
  has_audio     INTEGER,
  shots         INTEGER,
  transcript    INTEGER NOT NULL DEFAULT 0,
  source_kind   TEXT,
  watermarked   INTEGER,
  error         TEXT,
  prepared_at   TEXT NOT NULL,
  PRIMARY KEY (project_id, asset_id)
);
