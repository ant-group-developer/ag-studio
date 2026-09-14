-- channel_package.state mirrors ChannelPackage.status (draft|committed); updated directly, never via transition().
CREATE TABLE channel_package (id TEXT PRIMARY KEY, state TEXT NOT NULL, channel_id TEXT NOT NULL, run_id TEXT NOT NULL, library_item_id TEXT NOT NULL, episode_no INTEGER NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX channel_package_channel_idx ON channel_package(channel_id, episode_no);
CREATE INDEX channel_package_run_idx ON channel_package(run_id);
-- publication_job.state is control-plane state: only transition("publication_job", …) changes it.
CREATE TABLE publication_job (id TEXT PRIMARY KEY, state TEXT NOT NULL, channel_id TEXT NOT NULL, library_item_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, scheduled_at TEXT, data TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX publication_job_channel_state_idx ON publication_job(channel_id, state);
CREATE INDEX publication_job_key_idx ON publication_job(idempotency_key);
CREATE TABLE channel_sequence (channel_id TEXT PRIMARY KEY, next_episode_no INTEGER NOT NULL);
