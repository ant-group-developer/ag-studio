-- Phong cách dựng học từ video mẫu (plan 2026-10-08 quality-fixes, series plan 3.2.0, ADR-0001 mục 175):
--   style: JSON studio.style/v1 đang dùng — stage apply-style ghi bản người dùng duyệt ở gate approve-style, người dùng
--     sửa sau đó thì API ghi đè; bản `skipped` (không có kênh mẫu, không tải được…) nghĩa là series không có style
--   style_updated_by: user id, hoặc "gate:<run_id>" khi do stage áp bản duyệt
ALTER TABLE productions ADD COLUMN style TEXT;
ALTER TABLE productions ADD COLUMN style_updated_at TEXT;
ALTER TABLE productions ADD COLUMN style_updated_by TEXT;
