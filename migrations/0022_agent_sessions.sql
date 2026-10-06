-- Phiên Claude của các stage xem hình (file mode, plan pha 5 nhóm C1, ADR-0001 mục 155): chọn cảnh của tập cắt theo
-- shot mở contact sheet trong workspace của stage; phiên được giữ để vòng sửa và chat ở gate `approve-survey` chạy
-- `claude --resume` mà Claude vẫn nhớ các khung đã xem. Một dòng cho mỗi (run, stage): lần chạy sau ghi đè.
--   cwd: workspace của attempt (phiên Claude gắn với thư mục làm việc; resume phải chạy đúng ở đó)
CREATE TABLE studio_agent_sessions (
  run_id      TEXT NOT NULL,
  stage_key   TEXT NOT NULL,
  attempt_id  TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  cwd         TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (run_id, stage_key)
);

-- Phiên của một câu trả lời chat chạy bằng resume (NULL = chat structured như trước).
ALTER TABLE stage_chat_turns ADD COLUMN session_id TEXT;
