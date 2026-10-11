-- Nhật ký hoạt động: thao tác ghi của người trên API (POST/PUT/PATCH/DELETE), mỗi lần agent gọi tool (tool Studio qua MCP
-- và tool có sẵn của Claude), mỗi lượt chat, mỗi việc nền. Admin Studio xem hết, owner của nhóm xem nhóm mình. Không FK:
-- nhật ký sống lâu hơn dự án hay video đã xoá. Không bao giờ ghi nội dung chat, nội dung file hay giá trị bí mật; `details`
-- là JSON đã che và cắt (≤ 4 KB). Quét dọn theo STUDIO_RETENTION_AUDIT_DAYS.
CREATE TABLE audit_log (
  id           TEXT PRIMARY KEY,
  at           TEXT NOT NULL,
  actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('user', 'agent', 'studio')),
  actor_id     TEXT,
  kind         TEXT NOT NULL CHECK (kind IN ('http', 'tool', 'turn', 'job')),
  action       TEXT NOT NULL,
  outcome      TEXT NOT NULL CHECK (outcome IN ('ok', 'error')),
  method       TEXT,
  route        TEXT,
  status_code  INTEGER,
  duration_ms  INTEGER,
  team_id      TEXT,
  project_id   TEXT,
  video_id     TEXT,
  thread_id    TEXT,
  message_id   TEXT,
  job_id       TEXT,
  target       TEXT,
  summary      TEXT,
  details      TEXT,
  cost_usd     REAL,
  request_id   TEXT
);
CREATE INDEX audit_log_at_idx ON audit_log(at);
CREATE INDEX audit_log_team_idx ON audit_log(team_id, at);
CREATE INDEX audit_log_project_idx ON audit_log(project_id, at);
CREATE INDEX audit_log_actor_idx ON audit_log(actor_id, at);
