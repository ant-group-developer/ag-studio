-- Thống kê chat Claude theo nhóm / dự án / video / người chat: mỗi lượt agent (`llm_calls.source = 'claude-agent'`) giữ thêm
-- token ghi/đọc prompt cache, số bước, người lượt đó làm thay (`user_id`, Auth0 sub) và nhóm lúc đó (`team_id`, để số liệu
-- còn đúng khi dự án đã xoá). `input_tokens` vẫn là tổng mọi token vào. Dòng cũ lấy người và nhóm từ tin nhắn, dự án.
ALTER TABLE llm_calls ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE llm_calls ADD COLUMN cache_creation_tokens INTEGER;
ALTER TABLE llm_calls ADD COLUMN num_turns INTEGER;
ALTER TABLE llm_calls ADD COLUMN user_id TEXT;
ALTER TABLE llm_calls ADD COLUMN team_id TEXT;

UPDATE llm_calls SET user_id = (SELECT m.created_by FROM agent_messages m WHERE m.id = llm_calls.attempt_id)
  WHERE source = 'claude-agent' AND user_id IS NULL;
UPDATE llm_calls SET team_id = (SELECT p.team_id FROM projects p WHERE p.id = llm_calls.production_id)
  WHERE source = 'claude-agent' AND team_id IS NULL;

CREATE INDEX llm_calls_source_at_idx ON llm_calls(source, created_at);
CREATE INDEX llm_calls_team_at_idx ON llm_calls(team_id, created_at);
CREATE INDEX llm_calls_user_at_idx ON llm_calls(user_id, created_at);
