-- Chat theo production (spec local-chat mục 3.1): mỗi tin của người, mỗi câu trả lời của Claude, mỗi dòng hệ thống.
--
-- Một "scope" là chỗ đang chat: (production_id, episode_id, run_id, stage_key) cùng loại scope:
--   intake   — production chưa có run (run_id NULL, stage_key 'intake')
--   gate     — một gate đang WAITING_HUMAN (stage_key là key của gate)
--   failed   — một stage agent FAILED
--   timeline — timeline của một tập khi không có gate nào đang chờ
-- turn: số thứ tự trong cả production (tăng dần, dùng để xếp luồng chat).
-- Câu trả lời của Claude là một dòng role 'assistant' tạo cùng lúc với tin người gửi (status 'pending'); vòng chat
-- của worker chạy nó (running → done | failed | rate_limited, chờ tới not_before).
-- proposal: tài liệu Claude (hoặc người, khi sửa tay) đề xuất. Không ghi đè gì cho tới khi người bấm Áp dụng/Duyệt
--   (applied_at). Bản đang hiện của một scope là proposal mới nhất của scope đó.
CREATE TABLE stage_chat_turns (
  id            TEXT PRIMARY KEY,
  production_id TEXT NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  episode_id    TEXT,
  run_id        TEXT,
  scope         TEXT NOT NULL CHECK (scope IN ('intake', 'gate', 'failed', 'timeline')),
  stage_key     TEXT NOT NULL,
  turn          INTEGER NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  text          TEXT NOT NULL DEFAULT '',
  mentions      TEXT NOT NULL DEFAULT '[]',   -- [{kind:'folder', id, name}]
  context       TEXT,                         -- JSON chụp lúc gửi (vd danh sách folder ag-go của người gửi)
  proposal      TEXT,                         -- JSON
  action        TEXT,                         -- answer | revise | suggest_approve | render | export | retry
  status        TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed', 'rate_limited')),
  not_before    TEXT,
  problems      TEXT NOT NULL DEFAULT '[]',   -- [{code, message}] khi Claude chưa sửa được
  llm_call_id   TEXT,
  created_by    TEXT,
  applied_at    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (production_id, turn)
);
CREATE INDEX stage_chat_turns_thread_idx ON stage_chat_turns (production_id, episode_id, turn);
CREATE INDEX stage_chat_turns_queue_idx ON stage_chat_turns (status, not_before);
