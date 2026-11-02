-- Branch teams (plan 2026-10-30): several Claude accounts, each team runs its agent on its own, and its farm jobs on
-- its own pool of machines. The row `default` is the token of the env (`CLAUDE_CODE_OAUTH_TOKEN`), never stored: a
-- team with no account of its own uses it.
CREATE TABLE claude_accounts (
  id                  text PRIMARY KEY,
  name                text NOT NULL,
  -- `claude setup-token`, sealed with STUDIO_SECRET_KEY (`secret-box.ts`); NULL only for `default`
  token_enc           text,
  -- last 4 characters, to tell tokens apart on the web
  token_hint          text,
  -- turns at once on this account; NULL: only Studio's cap
  max_concurrent      integer CHECK (max_concurrent IS NULL OR max_concurrent BETWEEN 1 AND 100),
  enabled             boolean NOT NULL DEFAULT true,
  -- hit the plan's limit: no turn takes it before then
  rate_limited_until  timestamptz,
  rate_limit_hits     integer NOT NULL DEFAULT 0,
  last_used_at        timestamptz,
  last_error          text,
  last_error_at       timestamptz,
  -- "Kiểm tra" on the web: the worker makes one tiny call and writes how it went
  check_requested_at  timestamptz,
  checked_at          timestamptz,
  check_status        text CHECK (check_status IS NULL OR check_status IN ('ok', 'rate_limited', 'failed')),
  check_error         text,
  created_by          text,
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL
);
INSERT INTO claude_accounts (id, name, created_at, updated_at) VALUES ('default', 'Mặc định', now(), now()) ON CONFLICT (id) DO NOTHING;

CREATE TABLE team_claude_accounts (
  team_id     text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  account_id  text NOT NULL REFERENCES claude_accounts(id) ON DELETE CASCADE,
  position    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (team_id, account_id)
);
CREATE INDEX team_claude_accounts_account ON team_claude_accounts(account_id);

-- the farm's pool of machines the team's jobs run on (`requirements.pool`); NULL: the shared machines
ALTER TABLE teams ADD COLUMN IF NOT EXISTS farm_pool text;

ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS claude_account_id text;
ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS claude_account_id text;
CREATE INDEX IF NOT EXISTS llm_calls_account_at_idx ON llm_calls(claude_account_id, created_at);
