-- Cấu hình của cả Studio, chỉnh trên web (spec local-chat mục 3.2). Một dòng mỗi khoá, value là JSON.
--   claude.max_concurrent — số lượt Claude chạy cùng lúc (1–100); có dòng này thì thắng env STUDIO_CLAUDE_MAX_CONCURRENT.
CREATE TABLE studio_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
