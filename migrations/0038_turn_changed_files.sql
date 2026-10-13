-- Mỗi lượt agent nhớ file nó đã đổi (thẻ "N file đã thay đổi" dưới câu trả lời): JSON
-- `[{path, change: added|modified|deleted, version_id, before_version_id, added?, removed?}]`, tính sau lượt từ các bản
-- `project_file_versions` có `message_id` của lượt so với bản ngay trước lượt. Lượt cũ: NULL (không hiện gì).
ALTER TABLE agent_messages ADD COLUMN changed_files TEXT;

CREATE INDEX project_file_versions_message_idx ON project_file_versions(message_id);
