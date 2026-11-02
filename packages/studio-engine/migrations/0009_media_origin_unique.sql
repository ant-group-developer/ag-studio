-- One item per person and ag-music track (2026-11-01): two requests copying the same track at once (two tabs, a retry
-- while the first is still copying) end with the first item, not two copies and two downloads counted. Deleted items do
-- not count, so a track can be picked again after its item is deleted.
DROP INDEX IF EXISTS media_items_origin;
CREATE UNIQUE INDEX IF NOT EXISTS media_items_origin_unique ON media_items(owner_id, (origin->>'system'), (origin->>'trackId'))
  WHERE origin IS NOT NULL AND deleted_at IS NULL;
