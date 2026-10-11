-- AG Studio làm việc như Claude Code (spec 2026-10-10 agent-workspace, ADR-0001 mục 179–181).
-- Dự án = một kênh YouTube của một team; video thêm dần. Bảng productions/episodes cũ không còn được đọc (mục 180).
--   projects.settings: JSON ProjectSettings (model, target_seconds, team_skills, auto_fix, auto_continue)
--   projects.owner_user_id: Auth0 sub mà Studio "đóng vai" khi gọi ag-go cho dự án (người tạo)
CREATE TABLE projects (
  id             TEXT PRIMARY KEY,
  team_id        TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  channel_url    TEXT,
  description    TEXT NOT NULL DEFAULT '',
  language       TEXT NOT NULL DEFAULT 'vi',
  aspect         TEXT NOT NULL DEFAULT '16:9' CHECK (aspect IN ('16:9', '9:16')),
  settings       TEXT NOT NULL DEFAULT '{}',
  owner_user_id  TEXT NOT NULL,
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  archived_at    TEXT
);
CREATE INDEX projects_team_idx ON projects(team_id, archived_at);

-- Video của một dự án: idx tăng dần trong dự án, status do Studio đặt (không suy từ run).
CREATE TABLE videos (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idx          INTEGER NOT NULL,
  title        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_progress', 'rendering', 'done')),
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  archived_at  TEXT,
  UNIQUE (project_id, idx)
);
CREATE INDEX videos_project_idx ON videos(project_id, archived_at, idx);

-- Đầu vào của dự án (video_id NULL) hoặc của một video: project/asset ag-go, hoặc file tải lên (ref = đường dẫn
-- trong workspace).
CREATE TABLE project_sources (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  video_id    TEXT REFERENCES videos(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('ag_go_project', 'ag_go_asset', 'upload')),
  ref         TEXT NOT NULL,
  media_type  TEXT NOT NULL CHECK (media_type IN ('video', 'image', 'audio', 'document', 'mixed')),
  label       TEXT NOT NULL,
  meta        TEXT NOT NULL DEFAULT '{}',
  added_by    TEXT NOT NULL,
  added_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX project_sources_uniq ON project_sources(project_id, COALESCE(video_id, ''), kind, ref);

-- Timeline của video (chỉ v4), cùng hình với episode_revisions.
CREATE TABLE video_revisions (
  id            TEXT PRIMARY KEY,
  video_id      TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  revision      INTEGER NOT NULL,
  base_revision INTEGER NOT NULL,
  data          TEXT NOT NULL,
  author_id     TEXT NOT NULL,
  label         TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (video_id, revision)
);

-- Mỗi lần một file trong workspace đổi (người sửa trên web, agent ghi, Studio ghi): sha256, nội dung nếu là chữ
-- ≤ 1 MB; sha256 rỗng = file bị xoá. issues: JSON lỗi kiểm file lúc ghi (playbook, pha 3).
CREATE TABLE project_file_versions (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path         TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  size         INTEGER NOT NULL,
  content      TEXT,
  author_kind  TEXT NOT NULL CHECK (author_kind IN ('user', 'agent', 'studio')),
  author_id    TEXT,
  message_id   TEXT,
  issues       TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX project_file_versions_path_idx ON project_file_versions(project_id, path, created_at);
