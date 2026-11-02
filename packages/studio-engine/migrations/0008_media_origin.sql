-- Where an item of someone's library came from when Studio fetched it for them instead of their upload (2026-11-01):
-- a track of ag-music `{system: 'ag-music', trackId, fileId, code, type, origin, copyrightStatus}`. The same track
-- picked again is the item already there.
ALTER TABLE media_items ADD COLUMN IF NOT EXISTS origin jsonb;
CREATE INDEX IF NOT EXISTS media_items_origin ON media_items(owner_id, (origin->>'system'), (origin->>'trackId')) WHERE origin IS NOT NULL;
