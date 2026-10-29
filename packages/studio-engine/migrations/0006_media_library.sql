-- Media a person uploads (plan 2026-10-29 P1): their own library on the bucket, picked again in any project without
-- uploading it twice. A project's source points at the item it uses (`media_id`); its `meta.key` still names the file.
CREATE TABLE media_items (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('video', 'image', 'audio')),
  key         text NOT NULL UNIQUE,
  name        text NOT NULL,
  bytes       bigint NOT NULL,
  -- a photo's clip (`<id>.clip.mp4` beside it), once a project prepared it
  clip_key    text,
  created_at  timestamptz NOT NULL,
  deleted_at  timestamptz
);
CREATE INDEX media_items_owner ON media_items(owner_id, created_at DESC);

ALTER TABLE project_sources ADD COLUMN IF NOT EXISTS media_id text REFERENCES media_items(id);
CREATE INDEX IF NOT EXISTS project_sources_media ON project_sources(media_id) WHERE media_id IS NOT NULL;

-- The project's words and picture (plan 2026-10-29): every video takes them unless it picked its own.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS text_look jsonb;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS look text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS color_match boolean;
