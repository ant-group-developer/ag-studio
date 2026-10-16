-- Job `music_beats` (feedback-vps 2026-10-15 §4.7): the farm finds the beats of a project's or a video's music.
ALTER TABLE project_jobs DROP CONSTRAINT IF EXISTS project_jobs_kind_check;
ALTER TABLE project_jobs ADD CONSTRAINT project_jobs_kind_check
  CHECK (kind IN ('prepare_asset', 'transcribe_upload', 'tts', 'fit', 'render_preview', 'render_final', 'export_premiere', 'research', 'style_watch', 'thumbnail', 'music_beats'));
