-- ============================================================================
-- Better Auth tables (phase 2). Mapped in src/lib/auth/better-auth.ts.
--   users                 ← Better Auth "user" (created in 0001)
--   auth_sessions         ← "session"
--   auth_accounts         ← "account" (login methods; password hash lives here)
--   auth_verifications    ← "verification" (password reset / email tokens)
--   auth_rate_limits      ← "rateLimit" (rateLimit.storage = "database")
-- Named auth_* so Better Auth's "account" can't be confused with the CRM's
-- business `accounts` table. Dates are ISO-8601 text (Better Auth writes
-- toISOString() on SQLite), booleans 0/1.
-- These tables have no policy rule, so user sessions can never query them
-- through the data layer; only Better Auth (service access) touches them.
-- ============================================================================

CREATE TABLE auth_sessions (
  id          TEXT PRIMARY KEY NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,
  expires_at  TEXT NOT NULL,
  ip_address  TEXT,
  user_agent  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id);

CREATE TABLE auth_accounts (
  id                        TEXT PRIMARY KEY NOT NULL,
  user_id                   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Provider's id for this login. For email/password ("credential") it is the user id.
  provider_account_id       TEXT NOT NULL,
  provider_id               TEXT NOT NULL,
  -- scrypt hash from Better Auth, or a bcrypt hash ($2a$/$2b$) imported from
  -- Supabase auth.users (verified with bcryptjs, then re-hashed on login).
  password                  TEXT,
  access_token              TEXT,
  refresh_token             TEXT,
  id_token                  TEXT,
  access_token_expires_at   TEXT,
  refresh_token_expires_at  TEXT,
  scope                     TEXT,
  created_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_auth_accounts_user ON auth_accounts(user_id);
CREATE UNIQUE INDEX idx_auth_accounts_provider ON auth_accounts(provider_id, provider_account_id);

CREATE TABLE auth_verifications (
  id          TEXT PRIMARY KEY NOT NULL,
  identifier  TEXT NOT NULL,
  value       TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_auth_verifications_identifier ON auth_verifications(identifier);

-- In-memory rate limiting doesn't work across Workers isolates; keep counters in D1.
CREATE TABLE auth_rate_limits (
  id            TEXT PRIMARY KEY NOT NULL,
  key           TEXT NOT NULL UNIQUE,
  count         INTEGER NOT NULL,
  last_request  INTEGER NOT NULL   -- epoch milliseconds
);
