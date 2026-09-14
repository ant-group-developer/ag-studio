-- These three tables mirror the shared library (styles/, requests/, items/ on the kho filesystem).
-- They are written by `syncLibrary` via `upsert*` and are NOT part of the control-plane state
-- machine: `state` here is never touched by `transition()`.
CREATE TABLE edit_style (id TEXT PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX edit_style_state_idx ON edit_style(state);
CREATE TABLE content_request (id TEXT PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX content_request_state_idx ON content_request(state);
CREATE TABLE library_item (id TEXT PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX library_item_state_idx ON library_item(state);
