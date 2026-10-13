-- Nhạc riêng của một video (ghi đè nhạc của dự án): JSON như `projects.music` (ProductionMusicSchema), file ghép hoặc
-- bài trong kho nhạc. NULL = dùng nhạc của dự án, không có thì Studio chọn trong kho nhạc theo mood khi dựng timeline.
ALTER TABLE videos ADD COLUMN music TEXT;
