-- ============================================================
-- 044_broadcast_button_tracking.sql
--
-- Provides:
--   1. broadcast_button_clicks table for tracking individual WhatsApp
--      button click events on broadcasts.
--   2. Unique index on inbound_message_id for webhook idempotency.
--   3. Indexes on (broadcast_id, button_index) and account_id.
--   4. RLS policies maintaining tenant isolation.
--   5. get_broadcast_button_analytics RPC for efficient aggregation.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS broadcast_button_clicks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  broadcast_id UUID NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  button_index INTEGER NOT NULL,
  button_name TEXT NOT NULL,
  button_type TEXT NOT NULL DEFAULT 'QUICK_REPLY',
  button_payload TEXT,
  inbound_message_id TEXT NOT NULL,
  clicked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotency constraint: Webhook retries from Meta replay the same inbound wamid.
-- This ensures a retried delivery is an ON CONFLICT DO NOTHING no-op.
CREATE UNIQUE INDEX IF NOT EXISTS idx_broadcast_button_clicks_inbound_msg
  ON broadcast_button_clicks(inbound_message_id);

-- Performance index for analytics aggregation (grouped by broadcast_id, button_index)
CREATE INDEX IF NOT EXISTS idx_broadcast_button_clicks_bcast_btn
  ON broadcast_button_clicks(broadcast_id, button_index);

-- Index for tenant-scoped operations
CREATE INDEX IF NOT EXISTS idx_broadcast_button_clicks_account
  ON broadcast_button_clicks(account_id);

-- Enable Row Level Security (RLS)
ALTER TABLE broadcast_button_clicks ENABLE ROW LEVEL SECURITY;

-- Multi-tenant isolation policies
DROP POLICY IF EXISTS broadcast_button_clicks_select ON broadcast_button_clicks;
CREATE POLICY broadcast_button_clicks_select ON broadcast_button_clicks
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS broadcast_button_clicks_insert ON broadcast_button_clicks;
CREATE POLICY broadcast_button_clicks_insert ON broadcast_button_clicks
  FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS broadcast_button_clicks_delete ON broadcast_button_clicks;
CREATE POLICY broadcast_button_clicks_delete ON broadcast_button_clicks
  FOR DELETE USING (is_account_member(account_id, 'agent'));

-- Database aggregation RPC for zero-overhead analytics
CREATE OR REPLACE FUNCTION public.get_broadcast_button_analytics(
  p_account_id UUID,
  p_broadcast_id UUID
)
RETURNS TABLE (
  button_index INTEGER,
  button_name TEXT,
  button_type TEXT,
  total_clicks BIGINT,
  unique_users BIGINT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    c.button_index,
    c.button_name,
    c.button_type,
    COUNT(*) AS total_clicks,
    COUNT(DISTINCT c.contact_id) AS unique_users
  FROM broadcast_button_clicks c
  WHERE c.account_id = p_account_id
    AND c.broadcast_id = p_broadcast_id
  GROUP BY c.button_index, c.button_name, c.button_type;
$$;

REVOKE ALL ON FUNCTION public.get_broadcast_button_analytics(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_broadcast_button_analytics(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_broadcast_button_analytics(UUID, UUID) TO service_role;
