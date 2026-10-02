-- Canva Connect (public integration, OAuth 2.0 + PKCE): each Studio user connects their own Canva account.
-- Tokens are encrypted with CANVA_TOKEN_KEY (AES-256-GCM) and never leave the API.
CREATE TABLE canva_connections (
  user_id           TEXT PRIMARY KEY,         -- Studio (Auth0) user
  display_name      TEXT,                     -- Canva profile name, shown in the user menu
  access_token_enc  TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,            -- single use: replaced on every refresh
  expires_at        TEXT NOT NULL,            -- access token expiry (ISO)
  scope             TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- A connection being made: lives 10 minutes, deleted when Canva sends the user back.
CREATE TABLE canva_oauth_states (
  state         TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  return_to     TEXT NOT NULL,                -- a path in the web app
  created_at    TEXT NOT NULL
);

-- The Canva design a user opened for a thumbnail (designs belong to the user's Canva account).
CREATE TABLE thumbnail_canva_designs (
  thumbnail_id TEXT NOT NULL REFERENCES episode_thumbnails(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL,
  design_id    TEXT NOT NULL,
  imported     INTEGER NOT NULL,              -- 1: PDF import with editable words; 0: the flat picture in a new design
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (thumbnail_id, user_id)
);
