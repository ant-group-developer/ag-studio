-- Luồng chat với agent trong dự án (spec 2026-10-10 agent-workspace §3.2, §4, ADR-0001 mục 182, 186).
--   kind 'video': luồng chính của một video (tạo cùng video); 'project': luồng tự do của dự án ("Kênh", "Chat mới"…)
--   claude_session_id: session của CLI Studio chọn trước (UUID); session_started = 1 sau lượt đầu (lượt sau --resume)
--   use_lessons: 0 = luồng này không nạp memory/lessons.md (người dùng chọn "không học từ chat cũ")
CREATE TABLE agent_threads (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  video_id           TEXT REFERENCES videos(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL CHECK (kind IN ('project', 'video')),
  title              TEXT NOT NULL,
  claude_session_id  TEXT NOT NULL,
  session_started    INTEGER NOT NULL DEFAULT 0,
  session_cwd        TEXT,
  use_lessons        INTEGER NOT NULL DEFAULT 1,
  created_by         TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  archived_at        TEXT
);
CREATE INDEX agent_threads_project_idx ON agent_threads(project_id, archived_at, updated_at);
CREATE UNIQUE INDEX agent_threads_video_main ON agent_threads(video_id) WHERE kind = 'video' AND archived_at IS NULL;

-- Luồng cũ một luồng được "học" từ: tóm tắt hay toàn bộ lịch sử.
CREATE TABLE thread_refs (
  thread_id      TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  ref_thread_id  TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  mode           TEXT NOT NULL CHECK (mode IN ('summary', 'full')),
  added_by       TEXT NOT NULL,
  added_at       TEXT NOT NULL,
  PRIMARY KEY (thread_id, ref_thread_id)
);

-- Tin nhắn của luồng. Một tin assistant là một lượt agent: pending → running → done|failed|rate_limited|cancelled.
--   parts: JSON AgentPart[] (chữ và tool call theo thứ tự); phase: JSON việc agent đang làm khi running
--   trigger: ai kích lượt (user, job xong, thẻ xác nhận, tự sửa, hệ thống)
--   actor_role: vai trong team của người gửi (tin user) / người lượt làm thay (tin assistant); admin Studio = owner
CREATE TABLE agent_messages (
  id                TEXT PRIMARY KEY,
  thread_id         TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  role              TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  status            TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed', 'rate_limited', 'cancelled')),
  text              TEXT NOT NULL DEFAULT '',
  parts             TEXT,
  phase             TEXT,
  attachments       TEXT,
  trigger           TEXT NOT NULL DEFAULT 'user' CHECK (trigger IN ('user', 'job', 'action', 'autofix', 'system')),
  not_before        TEXT,
  error             TEXT,
  cancel_requested  INTEGER NOT NULL DEFAULT 0,
  attempts          INTEGER NOT NULL DEFAULT 0,
  llm_call_id       TEXT,
  cost_usd          REAL,
  created_by        TEXT,
  actor_role        TEXT CHECK (actor_role IN ('viewer', 'editor', 'producer', 'owner')),
  started_at        TEXT,
  finished_at       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (thread_id, seq)
);
CREATE INDEX agent_messages_status_idx ON agent_messages(status, not_before);
