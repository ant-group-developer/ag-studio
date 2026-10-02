-- Tập thuộc run kế hoạch nào: spawn-episodes chỉ coi là "chạy lại chính nó" khi mọi tập hiện có do đúng run này tạo;
-- một kế hoạch mới (run mới, hoặc chạy lại từ một bước) thay toàn bộ tập của kế hoạch cũ. Tập cũ để NULL.
ALTER TABLE episodes ADD COLUMN plan_run_id TEXT;
