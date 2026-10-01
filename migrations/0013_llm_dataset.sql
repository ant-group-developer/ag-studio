-- Nhật ký gọi model và phần người sửa: để xem lại trên web và để xuất dataset huấn luyện.
--
-- llm_calls: mỗi lần một stage gọi Claude (cả lần sửa, lần chạm hạn mức). Nội dung đầy đủ (prompt, câu trả lời thô,
--   JSON có cấu trúc) nằm trên R2 ở payload_key (JSON nén gzip); bảng chỉ giữ chỉ mục để lọc và tính.
--   outcome: accepted | rejected (bộ kiểm tra từ chối) | failed | rate_limited
CREATE TABLE llm_calls (
  id             TEXT PRIMARY KEY,
  created_at     TEXT NOT NULL,
  source         TEXT NOT NULL,
  production_id  TEXT,
  episode_id     TEXT,
  run_id         TEXT NOT NULL,
  stage_key      TEXT NOT NULL,
  attempt_id     TEXT NOT NULL,
  skill          TEXT NOT NULL,
  model          TEXT NOT NULL,
  round          INTEGER NOT NULL,
  outcome        TEXT NOT NULL,
  problems       TEXT NOT NULL DEFAULT '[]',
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  cost_usd       REAL NOT NULL DEFAULT 0,
  wall_seconds   REAL NOT NULL DEFAULT 0,
  payload_key    TEXT
);
CREATE INDEX llm_calls_production_idx ON llm_calls (production_id, created_at);
CREATE INDEX llm_calls_run_idx ON llm_calls (run_id, stage_key, created_at);

-- human_edits: người chốt lại đầu ra của model (duyệt kế hoạch, lưu YouTube Kit) hoặc bỏ nó (render lại, huỷ tập).
--   before: bản model soạn; after: bản người chốt (null với render lại / huỷ). changed = 0 khi người giữ nguyên.
--   Sửa timeline không ghi ở đây: mọi revision đã nằm trong episode_revisions.
CREATE TABLE human_edits (
  id             TEXT PRIMARY KEY,
  created_at     TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  production_id  TEXT NOT NULL,
  episode_id     TEXT,
  kind           TEXT NOT NULL,
  llm_call_id    TEXT,
  changed        INTEGER NOT NULL,
  before         TEXT,
  after          TEXT
);
CREATE INDEX human_edits_production_idx ON human_edits (production_id, created_at);
