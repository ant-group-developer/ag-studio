-- Ba bảng không còn code nào đọc hay ghi (deferred-items, nợ dọn dẹp):
--   comments            (0008) chưa bao giờ được dùng;
--   timeline_revisions  (0008) lịch sử composition của GĐ4, thay bằng episode_revisions (0011);
--   studio_editor_jobs  (0010) job farm của editor GĐ4, thay bằng episode_jobs (0011).
-- Dòng cũ trong hai bảng sau (production GĐ4) mất theo; không màn nào còn hiện chúng.
DROP INDEX IF EXISTS comments_production_idx;
DROP INDEX IF EXISTS comments_open_idx;
DROP TABLE IF EXISTS comments;
DROP INDEX IF EXISTS timeline_revisions_prod_idx;
DROP TABLE IF EXISTS timeline_revisions;
DROP INDEX IF EXISTS studio_editor_jobs_prod_idx;
DROP TABLE IF EXISTS studio_editor_jobs;
