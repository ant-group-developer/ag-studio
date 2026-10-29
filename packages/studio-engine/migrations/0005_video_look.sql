-- A video's own words and picture (plan 2026-10-28 P3): what a person picks in its Style tab, over the edit plan and the
-- channel's branding. NULL = not picked: the plan's, else the branding's.
ALTER TABLE videos ADD COLUMN IF NOT EXISTS text_look jsonb;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS look text;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS color_match boolean;
