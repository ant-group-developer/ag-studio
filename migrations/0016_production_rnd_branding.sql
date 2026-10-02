-- Nghiên cứu trước (ag-studio-series-plan@2.0.0):
--   own_channels: JSON mảng link kênh của nhóm (youtube_channels giữ nghĩa kênh tham khảo)
--   rnd / branding: JSON R&D và branding đang dùng — stage apply-rnd / apply-branding ghi bản người dùng duyệt ở gate,
--     người dùng sửa sau đó thì API ghi đè; các bước AI về sau đọc từ đây
--   *_updated_by: user id, hoặc "gate:<run_id>" khi do stage áp bản duyệt
-- Các cột brief/goal/audience/tone/notes/episode_target_seconds/max_episodes giữ nghĩa "gợi ý người dùng điền trước";
-- brief hiệu lực = gợi ý + định hướng của R&D (effectiveBrief).
ALTER TABLE productions ADD COLUMN own_channels TEXT;
ALTER TABLE productions ADD COLUMN rnd TEXT;
ALTER TABLE productions ADD COLUMN rnd_updated_at TEXT;
ALTER TABLE productions ADD COLUMN rnd_updated_by TEXT;
ALTER TABLE productions ADD COLUMN branding TEXT;
ALTER TABLE productions ADD COLUMN branding_updated_at TEXT;
ALTER TABLE productions ADD COLUMN branding_updated_by TEXT;
