-- Mirrors of <kho>/brands/<channel_id>/brand.json and <kho>/music/<track_id>/track.json (channel role writes
-- the kho; both roles mirror on sync). Not control-plane state.
CREATE TABLE brand_profile (channel_id TEXT PRIMARY KEY, data TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE music_track (id TEXT PRIMARY KEY, data TEXT NOT NULL, active INTEGER NOT NULL, updated_at TEXT NOT NULL);
