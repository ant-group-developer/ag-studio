-- Schema Postgres của AG Studio (2026-10-14): các bảng Studio đang dùng, gộp từ migrations/ SQLite 0001–0041 của
-- harness. Bảng harness CLI cũ không còn ở đây. Thời gian là timestamptz, JSON là jsonb, cờ là boolean.
-- Migration sau: 0002_*.sql cùng thư mục, chạy một lần theo thứ tự tên (bảng schema_migrations).

-- ---- Nhóm, thành viên, skill của nhóm ----
CREATE TABLE teams (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);

CREATE TABLE team_members (
  team_id    text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id    text NOT NULL,
  role       text NOT NULL CHECK (role IN ('owner', 'producer', 'editor', 'viewer')),
  joined_at  timestamptz NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_members_user_idx ON team_members(user_id);

CREATE TABLE team_skills (
  id          text PRIMARY KEY,
  team_id     text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name        text NOT NULL,
  purpose     text NOT NULL DEFAULT '',
  applies_to  jsonb NOT NULL DEFAULT '[]',
  content     text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  position    integer NOT NULL DEFAULT 0,
  created_by  text NOT NULL,
  updated_by  text NOT NULL,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL,
  UNIQUE (team_id, name)
);
CREATE INDEX team_skills_team_idx ON team_skills(team_id, position, created_at);

-- ---- Dự án, video, bản lưu timeline ----
CREATE TABLE projects (
  id             text PRIMARY KEY,
  team_id        text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name           text NOT NULL,
  channel_url    text,
  description    text NOT NULL DEFAULT '',
  language       text NOT NULL DEFAULT 'vi',
  aspect         text NOT NULL DEFAULT '16:9' CHECK (aspect IN ('16:9', '9:16')),
  settings       jsonb NOT NULL DEFAULT '{}',
  voice          jsonb,
  music          jsonb,
  owner_user_id  text NOT NULL,
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL,
  archived_at    timestamptz
);
CREATE INDEX projects_team_idx ON projects(team_id, archived_at);

CREATE TABLE videos (
  id           text PRIMARY KEY,
  project_id   text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idx          integer NOT NULL,
  title        text NOT NULL,
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_progress', 'rendering', 'done')),
  music        jsonb,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL,
  archived_at  timestamptz,
  UNIQUE (project_id, idx)
);
CREATE INDEX videos_project_idx ON videos(project_id, archived_at, idx);

CREATE TABLE video_revisions (
  id             text PRIMARY KEY,
  video_id       text NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  revision       integer NOT NULL,
  base_revision  integer NOT NULL,
  data           jsonb NOT NULL,
  author_id      text NOT NULL,
  label          text,
  created_at     timestamptz NOT NULL,
  UNIQUE (video_id, revision)
);

-- ---- Nguồn, đầu vào đã chuẩn bị, file dự án ----
CREATE TABLE project_sources (
  id          text PRIMARY KEY,
  project_id  text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  video_id    text REFERENCES videos(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('ag_go_project', 'ag_go_asset', 'upload')),
  ref         text NOT NULL,
  media_type  text NOT NULL CHECK (media_type IN ('video', 'image', 'audio', 'document', 'mixed')),
  label       text NOT NULL,
  meta        jsonb NOT NULL DEFAULT '{}',
  added_by    text NOT NULL,
  added_at    timestamptz NOT NULL
);
CREATE UNIQUE INDEX project_sources_uniq ON project_sources(project_id, COALESCE(video_id, ''), kind, ref);

CREATE TABLE prepared_assets (
  project_id    text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  asset_id      text NOT NULL,
  status        text NOT NULL CHECK (status IN ('ready', 'failed')),
  name          text,
  duration_s    double precision,
  width         integer,
  height        integer,
  has_audio     boolean,
  shots         integer,
  transcript    boolean NOT NULL DEFAULT false,
  source_kind   text,
  watermarked   boolean,
  error         text,
  prepared_at   timestamptz NOT NULL,
  PRIMARY KEY (project_id, asset_id)
);

-- seq: thứ tự ghi (thay rowid của SQLite), dùng để so một bản với bản ngay trước nó
CREATE TABLE project_file_versions (
  id           text PRIMARY KEY,
  seq          bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  project_id   text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path         text NOT NULL,
  sha256       text NOT NULL,
  size         bigint NOT NULL,
  content      text,
  author_kind  text NOT NULL CHECK (author_kind IN ('user', 'agent', 'studio')),
  author_id    text,
  message_id   text,
  issues       jsonb,
  created_at   timestamptz NOT NULL
);
CREATE INDEX project_file_versions_message_idx ON project_file_versions(message_id);
CREATE INDEX project_file_versions_path_idx ON project_file_versions(project_id, path, created_at);

CREATE TABLE step_marks (
  project_id     text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  video_id       text NOT NULL DEFAULT '',
  step_key       text NOT NULL,
  output_digest  text NOT NULL,
  upstream       jsonb NOT NULL,
  marked_at      timestamptz NOT NULL,
  PRIMARY KEY (project_id, video_id, step_key)
);

-- ---- Chat với agent ----
CREATE TABLE agent_threads (
  id                 text PRIMARY KEY,
  project_id         text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  video_id           text REFERENCES videos(id) ON DELETE CASCADE,
  kind               text NOT NULL CHECK (kind IN ('project', 'video')),
  title              text NOT NULL,
  claude_session_id  text NOT NULL,
  session_started    boolean NOT NULL DEFAULT false,
  session_cwd        text,
  use_lessons        boolean NOT NULL DEFAULT true,
  created_by         text NOT NULL,
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL,
  archived_at        timestamptz
);
CREATE INDEX agent_threads_project_idx ON agent_threads(project_id, archived_at, updated_at);
CREATE UNIQUE INDEX agent_threads_video_main ON agent_threads(video_id) WHERE kind = 'video' AND archived_at IS NULL;

CREATE TABLE thread_refs (
  thread_id      text NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  ref_thread_id  text NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  mode           text NOT NULL CHECK (mode IN ('summary', 'full')),
  added_by       text NOT NULL,
  added_at       timestamptz NOT NULL,
  PRIMARY KEY (thread_id, ref_thread_id)
);

CREATE TABLE thread_summaries (
  thread_id       text PRIMARY KEY REFERENCES agent_threads(id) ON DELETE CASCADE,
  summarized_seq  integer NOT NULL,
  path            text NOT NULL,
  updated_at      timestamptz NOT NULL
);

CREATE TABLE agent_messages (
  id                text PRIMARY KEY,
  thread_id         text NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  seq               integer NOT NULL,
  role              text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  status            text NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed', 'rate_limited', 'cancelled')),
  text              text NOT NULL DEFAULT '',
  parts             jsonb,
  phase             jsonb,
  attachments       jsonb,
  changed_files     jsonb,
  trigger           text NOT NULL DEFAULT 'user' CHECK (trigger IN ('user', 'job', 'action', 'autofix', 'system')),
  not_before        timestamptz,
  error             text,
  cancel_requested  boolean NOT NULL DEFAULT false,
  attempts          integer NOT NULL DEFAULT 0,
  llm_call_id       text,
  cost_usd          double precision,
  created_by        text,
  actor_role        text CHECK (actor_role IN ('viewer', 'editor', 'producer', 'owner')),
  started_at        timestamptz,
  finished_at       timestamptz,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  UNIQUE (thread_id, seq)
);
CREATE INDEX agent_messages_status_idx ON agent_messages(status, not_before);

CREATE TABLE agent_actions (
  id           text PRIMARY KEY,
  project_id   text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  video_id     text REFERENCES videos(id) ON DELETE CASCADE,
  thread_id    text NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  message_id   text REFERENCES agent_messages(id) ON DELETE SET NULL,
  kind         text NOT NULL CHECK (kind IN ('render_final', 'export_premiere', 'delete_video', 'crawl_large', 'reference_download')),
  title        text NOT NULL,
  summary      text NOT NULL,
  params       jsonb NOT NULL,
  revision     integer,
  status       text NOT NULL CHECK (status IN ('proposed', 'confirmed', 'rejected', 'expired', 'failed')),
  decided_by   text,
  decided_at   timestamptz,
  job_id       text,
  error        text,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL
);
CREATE INDEX agent_actions_project_idx ON agent_actions(project_id, status);
CREATE INDEX agent_actions_thread_idx ON agent_actions(thread_id, created_at);

CREATE TABLE lesson_proposals (
  id          text PRIMARY KEY,
  project_id  text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  thread_id   text REFERENCES agent_threads(id) ON DELETE SET NULL,
  text        text NOT NULL,
  status      text NOT NULL CHECK (status IN ('proposed', 'accepted', 'dismissed')),
  decided_by  text,
  decided_at  timestamptz,
  created_at  timestamptz NOT NULL
);
CREATE INDEX lesson_proposals_project_idx ON lesson_proposals(project_id, status);

-- ---- Job của dự án và job farm ----
CREATE TABLE project_jobs (
  id                text PRIMARY KEY,
  project_id        text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  video_id          text REFERENCES videos(id) ON DELETE CASCADE,
  thread_id         text REFERENCES agent_threads(id) ON DELETE SET NULL,
  kind              text NOT NULL CHECK (kind IN ('prepare_asset', 'transcribe_upload', 'tts', 'fit', 'render_preview', 'render_final', 'export_premiere', 'research', 'style_watch', 'thumbnail')),
  status            text NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  title             text NOT NULL,
  request           jsonb NOT NULL,
  result            jsonb,
  error             text,
  phase             jsonb,
  progress          double precision,
  eta_seconds       double precision,
  node_id           text,
  units             double precision,
  farm_job_id       text,
  cancel_requested  boolean NOT NULL DEFAULT false,
  continue_agent    boolean NOT NULL DEFAULT false,
  attempts          integer NOT NULL DEFAULT 0,
  created_by        text NOT NULL,
  actor_role        text,
  created_at        timestamptz NOT NULL,
  started_at        timestamptz,
  finished_at       timestamptz,
  updated_at        timestamptz NOT NULL
);
CREATE INDEX project_jobs_project_idx ON project_jobs(project_id, created_at);
CREATE INDEX project_jobs_status_idx ON project_jobs(status, created_at);

CREATE TABLE project_farm_jobs (
  farm_job_id      text PRIMARY KEY,
  job_id           text NOT NULL REFERENCES project_jobs(id) ON DELETE CASCADE,
  project_id       text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  video_id         text,
  stage_key        text NOT NULL,
  attempt_id       text NOT NULL,
  job_type         text NOT NULL,
  is_final_render  boolean NOT NULL DEFAULT false,
  requirements     jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL
);

-- Ký URL cho máy farm (POST /api/farm/sign)
CREATE TABLE sign_audit_log (
  id             text PRIMARY KEY,
  farm_job_id    text NOT NULL,
  production_id  text NOT NULL,
  op             jsonb NOT NULL,
  result_url     text,
  actor_node_id  text,
  ip             text,
  created_at     timestamptz NOT NULL
);
CREATE INDEX sign_audit_log_job_idx ON sign_audit_log(farm_job_id);
CREATE INDEX sign_audit_log_prod_idx ON sign_audit_log(production_id, created_at);

-- ---- Claude: slot đang chạy/đang chờ, lượt gọi và chi phí ----
-- owner 'agent:<id>' / 'agent-wait:<id>' (claude-slots.ts); các cột khác giữ hình dạng lease của harness.
CREATE TABLE lease (
  stage_run_id   text PRIMARY KEY,
  attempt_id     text NOT NULL,
  owner          text NOT NULL,
  expires_at     timestamptz NOT NULL,
  fencing_token  bigint NOT NULL,
  resources      jsonb NOT NULL DEFAULT '[]'
);

CREATE TABLE llm_calls (
  id                     text PRIMARY KEY,
  created_at             timestamptz NOT NULL,
  source                 text NOT NULL,
  production_id          text,
  episode_id             text,
  run_id                 text NOT NULL,
  stage_key              text NOT NULL,
  attempt_id             text NOT NULL,
  skill                  text NOT NULL,
  model                  text NOT NULL,
  round                  integer NOT NULL,
  outcome                text NOT NULL,
  problems               jsonb NOT NULL DEFAULT '[]',
  input_tokens           integer,
  output_tokens          integer,
  cache_read_tokens      integer,
  cache_creation_tokens  integer,
  num_turns              integer,
  cost_usd               double precision NOT NULL DEFAULT 0,
  wall_seconds           double precision NOT NULL DEFAULT 0,
  payload_key            text,
  user_id                text,
  team_id                text
);
CREATE INDEX llm_calls_production_idx ON llm_calls(production_id, created_at);
CREATE INDEX llm_calls_run_idx ON llm_calls(run_id, stage_key, created_at);
CREATE INDEX llm_calls_source_at_idx ON llm_calls(source, created_at);
CREATE INDEX llm_calls_team_at_idx ON llm_calls(team_id, created_at);
CREATE INDEX llm_calls_user_at_idx ON llm_calls(user_id, created_at);

-- ---- Nhật ký thao tác ----
CREATE TABLE audit_log (
  id           text PRIMARY KEY,
  at           timestamptz NOT NULL,
  actor_kind   text NOT NULL CHECK (actor_kind IN ('user', 'agent', 'studio')),
  actor_id     text,
  kind         text NOT NULL CHECK (kind IN ('http', 'tool', 'turn', 'job')),
  action       text NOT NULL,
  outcome      text NOT NULL CHECK (outcome IN ('ok', 'error')),
  method       text,
  route        text,
  status_code  integer,
  duration_ms  integer,
  team_id      text,
  project_id   text,
  video_id     text,
  thread_id    text,
  message_id   text,
  job_id       text,
  target       text,
  summary      text,
  details      jsonb,
  cost_usd     double precision,
  request_id   text
);
CREATE INDEX audit_log_actor_idx ON audit_log(actor_id, at);
CREATE INDEX audit_log_at_idx ON audit_log(at);
CREATE INDEX audit_log_project_idx ON audit_log(project_id, at);
CREATE INDEX audit_log_team_idx ON audit_log(team_id, at);

-- ---- Thống kê dùng footage gửi ag-go (hộp thư đi) ----
CREATE TABLE ag_go_usage_outbox (
  event_key   text PRIMARY KEY,
  seq         bigint GENERATED ALWAYS AS IDENTITY,
  payload     jsonb NOT NULL,
  created_at  timestamptz NOT NULL,
  sent_at     timestamptz,
  attempts    integer NOT NULL DEFAULT 0,
  next_at     timestamptz NOT NULL,
  last_error  text
);
CREATE INDEX ag_go_usage_outbox_due_idx ON ag_go_usage_outbox(sent_at, next_at);

-- ---- Cài đặt, thư viện, cache ----
CREATE TABLE studio_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL,
  updated_by  text NOT NULL
);

CREATE TABLE user_prefs (
  user_id     text PRIMARY KEY,
  prefs       jsonb NOT NULL DEFAULT '{}',
  updated_at  timestamptz NOT NULL
);

-- ord: thứ tự thêm vào thư viện (thay rowid của SQLite)
CREATE TABLE music_track (
  id          text PRIMARY KEY,
  ord         bigint GENERATED ALWAYS AS IDENTITY,
  data        jsonb NOT NULL,
  active      boolean NOT NULL,
  updated_at  timestamptz NOT NULL
);

CREATE TABLE studio_voice_lines (
  key           text PRIMARY KEY,
  duration_s    double precision NOT NULL,
  words         jsonb NOT NULL DEFAULT '[]',
  language      text NOT NULL,
  created_at    timestamptz NOT NULL,
  last_used_at  timestamptz NOT NULL
);

CREATE TABLE youtube_cache (
  key         text PRIMARY KEY,
  body        jsonb NOT NULL,
  fetched_at  timestamptz NOT NULL
);
