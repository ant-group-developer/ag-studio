CREATE TABLE run (
  id TEXT PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX run_state_idx ON run(state);

CREATE TABLE stage_run (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX stage_run_run_idx ON stage_run(run_id);
CREATE INDEX stage_run_state_idx ON stage_run(state);

CREATE TABLE attempt (
  id TEXT PRIMARY KEY, stage_run_id TEXT NOT NULL, state TEXT NOT NULL, fencing_token INTEGER NOT NULL,
  data TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX attempt_stage_idx ON attempt(stage_run_id);

CREATE TABLE artifact (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, stage_run_id TEXT NOT NULL, state TEXT NOT NULL,
  data TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX artifact_stage_idx ON artifact(stage_run_id);
CREATE INDEX artifact_run_idx ON artifact(run_id);

CREATE TABLE external_operation (
  id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
  data TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE check_result (
  id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX check_result_attempt_idx ON check_result(attempt_id);

CREATE TABLE event (
  id TEXT PRIMARY KEY, run_id TEXT, occurred_at TEXT NOT NULL, event_type TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX event_run_idx ON event(run_id, occurred_at);

CREATE TABLE lease (
  stage_run_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, owner TEXT NOT NULL,
  expires_at TEXT NOT NULL, fencing_token INTEGER NOT NULL
);
