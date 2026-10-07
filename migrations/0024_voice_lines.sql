-- Kho giọng theo nội dung (plan pha 5 nhóm D1, ADR-0001 mục 156): mỗi dòng lời dẫn đã đọc một lần, khoá theo sha256 của
-- chữ + ngôn ngữ + giọng mẫu + tốc độ + engine. WAV nằm ở <STUDIO_DATA_ROOT>/voice/<key>.wav (API và worker dùng chung
-- thư mục đó); bảng giữ thời lượng và mốc từng từ (giây tính từ đầu dòng). Sửa một câu chỉ đọc lại câu đó.
CREATE TABLE studio_voice_lines (
  key           TEXT PRIMARY KEY,
  duration_s    REAL NOT NULL,
  words         TEXT NOT NULL DEFAULT '[]',
  language      TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT NOT NULL
);
