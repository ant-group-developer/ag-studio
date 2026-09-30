-- GĐ5: YouTube Data API answers cached by request (keyword searches cost 100 quota units each).
--   key:        request without the API key (and the search window), plus the day it covers
--   body:       the raw JSON answer
--   fetched_at: when it was fetched (entries older than 24 h are refetched)
CREATE TABLE youtube_cache (
  key         TEXT PRIMARY KEY,
  body        TEXT NOT NULL,
  fetched_at  TEXT NOT NULL
);
