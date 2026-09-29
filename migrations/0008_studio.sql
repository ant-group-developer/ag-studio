-- Studio team and production management tables (GĐ3 3.1).
--
-- teams: a workspace grouping users around one or more productions.
CREATE TABLE teams (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- team_members: user membership in a team with a named role.
--   role: 'owner' | 'producer' | 'editor' | 'viewer'
CREATE TABLE team_members (
  team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('owner', 'producer', 'editor', 'viewer')),
  joined_at  TEXT NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_members_user_idx ON team_members(user_id);

-- productions: a single video production owned by a team.
--   status: 'draft' | 'in_progress' | 'review' | 'done' | 'archived'
--   canvas: JSON { width, height } — overrides the project-level render.canvas default.
--   run_id: the active harness run for this production (null when idle).
CREATE TABLE productions (
  id            TEXT PRIMARY KEY,
  team_id       TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'in_progress', 'review', 'done', 'archived')),
  canvas        TEXT,        -- JSON { width: number, height: number } or NULL
  brief         TEXT,        -- editorial brief (treatment text)
  run_id        TEXT,        -- active harness run_id, NULL when idle
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX productions_team_idx      ON productions(team_id);
CREATE INDEX productions_status_idx    ON productions(status);
CREATE INDEX productions_run_idx       ON productions(run_id);

-- production_sources: footage folders (ag-go source items) linked to a production.
--   source_id: corresponds to a source_item.source_id in the harness catalog.
CREATE TABLE production_sources (
  production_id  TEXT NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  source_id      TEXT NOT NULL,
  added_at       TEXT NOT NULL,
  PRIMARY KEY (production_id, source_id)
);
CREATE INDEX production_sources_src_idx ON production_sources(source_id);

-- timeline_revisions: append-only history of composition JSON snapshots.
--   revision:       monotonically increasing per production (1, 2, 3…).
--   base_revision:  the revision this was forked from (for conflict detection on optimistic writes).
--   data:           full CompositionSchema JSON.
--   author_id:      user_id of the team member who saved this revision.
--   label:          optional short label ("autosave", "v1-cut", …).
CREATE TABLE timeline_revisions (
  id             TEXT PRIMARY KEY,
  production_id  TEXT NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  revision       INTEGER NOT NULL,
  base_revision  INTEGER NOT NULL DEFAULT 0,
  data           TEXT NOT NULL,   -- CompositionSchema JSON
  author_id      TEXT NOT NULL,
  label          TEXT,
  created_at     TEXT NOT NULL,
  UNIQUE (production_id, revision)
);
CREATE INDEX timeline_revisions_prod_idx ON timeline_revisions(production_id, revision);

-- comments: time-anchored or range-anchored review notes on a production.
--   anchor_start / anchor_end: seconds into the timeline (NULL for general comments).
--   resolved_at:  NULL while open; timestamp when resolved.
CREATE TABLE comments (
  id             TEXT PRIMARY KEY,
  production_id  TEXT NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  author_id      TEXT NOT NULL,
  body           TEXT NOT NULL,
  anchor_start   REAL,    -- seconds, NULL for general comment
  anchor_end     REAL,    -- seconds, NULL when single-point or general
  resolved_at    TEXT,    -- NULL = open
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX comments_production_idx ON comments(production_id, created_at);
CREATE INDEX comments_open_idx       ON comments(production_id, resolved_at)
  WHERE resolved_at IS NULL;
