-- Studio farm job tracking table (GĐ3 3.1 sign endpoint).
--
-- Tracks ag-farm job IDs submitted by the farm executor for each stage run/attempt.
-- Used by POST /farm/sign to verify that the worker's ticket corresponds to a known
-- production stage, and to derive the authorized storage prefix for signing.
CREATE TABLE studio_farm_jobs (
  id               TEXT PRIMARY KEY,
  -- ag-farm job id (UUID returned by FarmOwnerClient.submitJob)
  farm_job_id      TEXT NOT NULL UNIQUE,
  -- harness run id that owns this job
  run_id           TEXT NOT NULL,
  -- stage key within the run (e.g. 'tts', 'render-preview', 'render-final')
  stage_key        TEXT NOT NULL,
  -- attempt id (= correlation_id used when submitting to ag-farm)
  attempt_id       TEXT NOT NULL,
  -- production id (from stage_config.production_id)
  production_id    TEXT NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  -- farm job type (studio.tts | studio.render_preview | studio.render_final)
  job_type         TEXT NOT NULL,
  -- whether this is a final render (determines footage resolve purpose)
  is_final_render  INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL
);
CREATE INDEX studio_farm_jobs_run_idx        ON studio_farm_jobs(run_id);
CREATE INDEX studio_farm_jobs_production_idx ON studio_farm_jobs(production_id);
CREATE INDEX studio_farm_jobs_attempt_idx    ON studio_farm_jobs(attempt_id);

-- Sign audit log: every POST /farm/sign call is recorded here.
CREATE TABLE sign_audit_log (
  id             TEXT PRIMARY KEY,
  farm_job_id    TEXT NOT NULL,
  production_id  TEXT NOT NULL,
  op             TEXT NOT NULL,   -- JSON: the SignOp that was authorized
  result_url     TEXT,            -- signed URL (null for multipart ops that don't return a URL)
  actor_node_id  TEXT,            -- sub claim from the ticket (worker node id)
  ip             TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX sign_audit_log_job_idx  ON sign_audit_log(farm_job_id);
CREATE INDEX sign_audit_log_prod_idx ON sign_audit_log(production_id, created_at);
