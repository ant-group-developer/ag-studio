-- Mirror of <kho>/voices/<voice_id>/voice.json (channel role writes the kho; both roles mirror it on sync). Not control-plane state.
CREATE TABLE voice_profile (id TEXT PRIMARY KEY, data TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL);
