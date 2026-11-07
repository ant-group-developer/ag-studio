-- Errors that otherwise only reach a container's log (plan 2026-11-07 prod-diagnostics P2): an API request that
-- ended in a 5xx (reads too), a worker's error and warning lines. The same message from one process within a minute
-- adds to `repeats` of the row before instead of a new row. Swept with the activity log (90 days).
CREATE TABLE error_events (
  id         text PRIMARY KEY,
  at         timestamptz NOT NULL,
  last_at    timestamptz NOT NULL,
  service    text NOT NULL,
  level      text NOT NULL CHECK (level IN ('warn', 'error')),
  signature  text NOT NULL,
  message    text NOT NULL,
  context    jsonb,
  project_id text,
  video_id   text,
  request_id text,
  repeats    integer NOT NULL DEFAULT 1
);
CREATE INDEX error_events_at ON error_events (at);
CREATE INDEX error_events_signature_at ON error_events (signature, at);
