CREATE TABLE source_item (
  id TEXT PRIMARY KEY, checksum TEXT NOT NULL, collection TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX source_item_checksum_idx ON source_item(checksum);

CREATE TABLE content_item (
  id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE content_variant (
  id TEXT PRIMARY KEY, content_id TEXT NOT NULL, profile_id TEXT NOT NULL, variant_key TEXT NOT NULL UNIQUE,
  data TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX content_variant_content_idx ON content_variant(content_id);

ALTER TABLE lease ADD COLUMN resources TEXT NOT NULL DEFAULT '[]';
CREATE INDEX run_variant_idx ON run(json_extract(data, '$.variant_id'));
