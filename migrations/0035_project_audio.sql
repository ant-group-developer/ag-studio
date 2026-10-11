-- Giọng đọc lời dẫn và nhạc nền của dự án (spec 2026-10-10 agent-workspace §P6), cùng dạng JSON với
-- productions.voice / productions.music (ProductionVoiceSchema, ProductionMusicSchema): người dùng chọn một file audio
-- đã tải lên tab Đầu vào làm giọng mẫu hoặc nhạc nền; agent không tự chọn giọng (nguồn gốc giọng là lời người dùng).
ALTER TABLE projects ADD COLUMN voice TEXT;
ALTER TABLE projects ADD COLUMN music TEXT;
