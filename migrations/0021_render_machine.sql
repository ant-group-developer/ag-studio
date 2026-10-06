-- Kiểu máy render bản cuối (spec local-chat mục 3.4, plan pha 3). Một dòng cho mỗi (run, stage farm) có người chọn;
-- worker đọc lúc gửi job và đổi thành `requirements` của ag-farm. Không có dòng nào thì job gửi `{}` như trước.
--   machine: any → {} · nvenc → { nvenc: true } · gpu → { gpu: true }
CREATE TABLE studio_render_choices (
  run_id        TEXT NOT NULL,
  stage_key     TEXT NOT NULL,
  production_id TEXT NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  episode_id    TEXT REFERENCES episodes(id) ON DELETE CASCADE,
  machine       TEXT NOT NULL CHECK (machine IN ('any', 'nvenc', 'gpu')),
  chosen_by     TEXT NOT NULL,
  chosen_at     TEXT NOT NULL,
  PRIMARY KEY (run_id, stage_key)
);
CREATE INDEX studio_render_choices_prod_idx ON studio_render_choices(production_id, chosen_at);

-- requirements (JSON) đã gửi cho farm cùng job. NULL = job gửi trước migration này (không rõ).
ALTER TABLE studio_farm_jobs ADD COLUMN requirements TEXT;
