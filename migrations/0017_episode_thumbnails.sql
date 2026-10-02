-- Thumbnail của tập (ag-studio-episode@1.2.0): mọi ảnh người dùng có thể chọn làm thumbnail.
--   kind: frame (khung sạch cắt từ video final) | suggestion (3 gợi ý của gói YouTube, chữ do Studio vẽ)
--         | composed (người dùng thêm chữ lên một ảnh) | upload (ảnh tải lên) | canva (bản lấy về từ Canva)
--         | ai (để dành: ảnh tạo bằng AI)
--   base_key: ảnh sạch dưới chữ (vẽ lại chữ, gửi Canva); null với ảnh tải lên / từ Canva / 3 ảnh cũ chữ đốt sẵn
--   image_key: ảnh cuối trong bucket Studio (duy nhất: ghi lại cùng file là không làm gì)
--   style: JSON ThumbnailStyle (vị trí, cỡ, màu, dải nền, chữ hoa) khi ảnh có chữ do Studio vẽ
CREATE TABLE episode_thumbnails (
  id             TEXT PRIMARY KEY,
  episode_id     TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('frame', 'suggestion', 'composed', 'upload', 'canva', 'ai')),
  source_run_id  TEXT,
  parent_id      TEXT REFERENCES episode_thumbnails(id) ON DELETE SET NULL,
  t_s            REAL,
  asset_id       TEXT,
  base_key       TEXT,
  image_key      TEXT NOT NULL UNIQUE,
  text           TEXT,
  style          TEXT,
  width          INTEGER NOT NULL,
  height         INTEGER NOT NULL,
  size_bytes     INTEGER NOT NULL,
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX episode_thumbnails_episode_idx ON episode_thumbnails (episode_id, created_at);

-- Thumbnail đang dùng của tập (thay cho selected_thumbnail = chỉ số 0..2 của 3 ảnh cũ, giữ lại cho tập cũ).
ALTER TABLE episodes ADD COLUMN selected_thumbnail_id TEXT;
