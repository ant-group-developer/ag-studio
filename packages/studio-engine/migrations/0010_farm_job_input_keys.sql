-- The `library:` inputs a farm job may read (from its payload and the JSON files it uploaded, e.g. a render's
-- composition): POST /farm/sign signs only these, so a ticket for one job cannot read other people's library files.
-- A JSON array of strings. NULL: a job sent before this column (signed as before, until those jobs are gone).
ALTER TABLE project_farm_jobs ADD COLUMN input_keys jsonb;
