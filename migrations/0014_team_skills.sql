-- Quy chuẩn & skill của nhóm: các file markdown nhóm tự viết (mục đích, quy tắc làm video). Mỗi lần một stage Claude
-- của production thuộc nhóm chạy, các file đang bật và áp dụng cho bước đó được chèn vào prompt (đọc lúc gọi, không
-- chụp vào run: luôn là bản mới nhất; log Claude giữ đúng bản đã dùng).
--   applies_to: JSON mảng bước ("trend-report", "rnd", "branding", "plan-episodes", "youtube-kit"); [] = mọi bước
--   position:   thứ tự trong prompt và trên web (nhỏ trước, rồi theo lúc tạo)
CREATE TABLE team_skills (
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  purpose     TEXT NOT NULL DEFAULT '',
  applies_to  TEXT NOT NULL DEFAULT '[]',
  content     TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  position    INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT NOT NULL,
  updated_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (team_id, name)
);
CREATE INDEX team_skills_team_idx ON team_skills (team_id, position, created_at);
