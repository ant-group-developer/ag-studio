-- Append-only snapshots read from YouTube Studio (or imported from the legacy channel-metrics.jsonl); never updated.
CREATE TABLE video_metrics (id TEXT PRIMARY KEY, publication_job_id TEXT NOT NULL, channel_id TEXT NOT NULL, collected_at TEXT NOT NULL, age_hours REAL NOT NULL, data TEXT NOT NULL);
CREATE INDEX video_metrics_job_idx ON video_metrics(publication_job_id, age_hours);
CREATE INDEX video_metrics_channel_idx ON video_metrics(channel_id, collected_at);
-- One learned standard per channel, rewritten by learnChannelStandard; not control-plane state.
CREATE TABLE channel_learned (channel_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
