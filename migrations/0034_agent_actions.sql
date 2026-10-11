-- Việc có tác dụng thật agent đề xuất, người bấm (spec 2026-10-10 agent-workspace §3.5, ADR-0001 mục 183).
-- Agent gọi tool propose_action → một thẻ trong luồng chat → người có vai đủ bấm Xác nhận / Từ chối → Studio làm
-- (thường là xếp một việc nền), ghi tin hệ thống vào luồng và cho agent làm tiếp. Thẻ hết hạn sau 24 giờ, hoặc khi
-- timeline của video đổi (revision) với việc gắn với một bản timeline.
CREATE TABLE agent_actions (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  video_id     TEXT REFERENCES videos(id) ON DELETE CASCADE,
  thread_id    TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  message_id   TEXT REFERENCES agent_messages(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('render_final', 'export_premiere', 'delete_video', 'crawl_large', 'reference_download')),
  title        TEXT NOT NULL,
  summary      TEXT NOT NULL,
  params       TEXT NOT NULL,
  revision     INTEGER,
  status       TEXT NOT NULL CHECK (status IN ('proposed', 'confirmed', 'rejected', 'expired', 'failed')),
  decided_by   TEXT,
  decided_at   TEXT,
  job_id       TEXT,
  error        TEXT,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);
CREATE INDEX agent_actions_thread_idx ON agent_actions(thread_id, created_at);
CREATE INDEX agent_actions_project_idx ON agent_actions(project_id, status);
