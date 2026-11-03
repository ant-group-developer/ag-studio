-- Job `image` (plan 2026-11-03 codex-imagegen P3): pictures made by Codex's $imagegen on a ChatGPT login — AI
-- thumbnails of a video, the channel's art. Only a worker with Studio's Codex takes it.
ALTER TABLE project_jobs DROP CONSTRAINT IF EXISTS project_jobs_kind_check;
ALTER TABLE project_jobs ADD CONSTRAINT project_jobs_kind_check
  CHECK (kind IN ('prepare_asset', 'transcribe_upload', 'tts', 'fit', 'render_preview', 'render_final', 'export_premiere', 'research', 'style_watch', 'thumbnail', 'music_beats', 'image'));
