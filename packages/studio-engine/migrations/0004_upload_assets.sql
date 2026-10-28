-- Footage from someone's computer (feedback 2026-10-27 item 3): a source of kind `upload_asset`, its file on the bucket.
ALTER TABLE project_sources DROP CONSTRAINT IF EXISTS project_sources_kind_check;
ALTER TABLE project_sources ADD CONSTRAINT project_sources_kind_check
  CHECK (kind IN ('ag_go_project', 'ag_go_asset', 'upload_asset', 'upload'));
