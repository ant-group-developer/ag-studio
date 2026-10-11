-- Playbook gợi ý bước và học từ chat cũ (spec 2026-10-10 agent-workspace §4, §6, ADR-0001 mục 184, 186).
--
-- step_marks: lần đầu Studio thấy một bước "xong" với đầu ra hiện tại, nó ghi digest đầu ra và digest các bước
--   bước đó cần (upstream). Sau này bước cần đổi mà bước này chưa đổi → bước này "stale" (đã cũ). Chỉ là bộ nhớ đệm:
--   mất thì tự dựng lại từ file. video_id '' cho bước của dự án.
CREATE TABLE step_marks (
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  video_id       TEXT NOT NULL DEFAULT '',
  step_key       TEXT NOT NULL,
  output_digest  TEXT NOT NULL,
  upstream       TEXT NOT NULL,
  marked_at      TEXT NOT NULL,
  PRIMARY KEY (project_id, video_id, step_key)
);

-- Tóm tắt của mỗi luồng (SUMMARY.md): tới tin số mấy thì đã tóm tắt.
CREATE TABLE thread_summaries (
  thread_id       TEXT PRIMARY KEY REFERENCES agent_threads(id) ON DELETE CASCADE,
  summarized_seq  INTEGER NOT NULL,
  path            TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- Bài học đề xuất từ một luồng: chỉ vào memory/lessons.md khi người bấm "Lưu".
CREATE TABLE lesson_proposals (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  thread_id   TEXT REFERENCES agent_threads(id) ON DELETE SET NULL,
  text        TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'dismissed')),
  decided_by  TEXT,
  decided_at  TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX lesson_proposals_project_idx ON lesson_proposals(project_id, status);
