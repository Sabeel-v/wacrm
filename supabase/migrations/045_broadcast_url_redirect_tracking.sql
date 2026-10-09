-- ============================================================
-- 045_broadcast_url_redirect_tracking.sql
--
-- Provides:
--   1. broadcast_url_tokens table mapping short URL tokens to
--      (account_id, broadcast_id, contact_id, button_index, destination_url).
--   2. Unique index on token for fast O(1) public redirect resolution.
--   3. Composite index on (broadcast_id, button_index) and account_id.
--   4. Tenant RLS policies maintaining account isolation.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS broadcast_url_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  broadcast_id UUID NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  recipient_phone TEXT,
  button_index INTEGER NOT NULL,
  button_name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  destination_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast O(1) lookup on short redirect token
CREATE UNIQUE INDEX IF NOT EXISTS idx_broadcast_url_tokens_token
  ON broadcast_url_tokens(token);

-- Performance index for broadcast button token lookups
CREATE INDEX IF NOT EXISTS idx_broadcast_url_tokens_bcast_btn
  ON broadcast_url_tokens(broadcast_id, button_index);

-- Index for tenant operations
CREATE INDEX IF NOT EXISTS idx_broadcast_url_tokens_account
  ON broadcast_url_tokens(account_id);

-- Enable Row Level Security (RLS)
ALTER TABLE broadcast_url_tokens ENABLE ROW LEVEL SECURITY;

-- Multi-tenant isolation policies
DROP POLICY IF EXISTS broadcast_url_tokens_select ON broadcast_url_tokens;
CREATE POLICY broadcast_url_tokens_select ON broadcast_url_tokens
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS broadcast_url_tokens_insert ON broadcast_url_tokens;
CREATE POLICY broadcast_url_tokens_insert ON broadcast_url_tokens
  FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS broadcast_url_tokens_delete ON broadcast_url_tokens;
CREATE POLICY broadcast_url_tokens_delete ON broadcast_url_tokens
  FOR DELETE USING (is_account_member(account_id, 'agent'));

-- Permissions
GRANT ALL ON TABLE broadcast_url_tokens TO authenticated;
GRANT ALL ON TABLE broadcast_url_tokens TO service_role;
