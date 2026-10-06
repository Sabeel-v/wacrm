-- ============================================================
-- 043_flow_node_lead_tracking.sql — Flow Node Lead Tracking & Aggregation
--
-- Provides:
--   1. Composite indexes on `flow_run_events` and `flow_runs`
--      to optimize node tracking queries across high event volumes.
--   2. `get_flow_node_leads` RPC function for performant,
--      database-side aggregation of contacts who reached a specific
--      flow node (calculating first_reached_at, last_reached_at,
--      reach_count, search filtering, date filtering, and pagination).
--
-- Security:
--   SECURITY INVOKER: executes under caller's context, respecting
--   existing RLS policies on flows, flow_runs, flow_run_events, and contacts.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- 1. Performance indexes
CREATE INDEX IF NOT EXISTS idx_flow_run_events_node_tracking
  ON flow_run_events(node_key, event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_flow_runs_flow_contact
  ON flow_runs(flow_id, contact_id);

-- 2. Aggregation RPC for Flow Node Leads
CREATE OR REPLACE FUNCTION public.get_flow_node_leads(
  p_flow_id UUID,
  p_node_key TEXT,
  p_search TEXT DEFAULT NULL,
  p_date_from TIMESTAMPTZ DEFAULT NULL,
  p_date_to TIMESTAMPTZ DEFAULT NULL,
  p_limit INT DEFAULT 50,
  p_offset INT DEFAULT 0
)
RETURNS TABLE (
  contact_id UUID,
  contact_name TEXT,
  contact_phone TEXT,
  first_reached_at TIMESTAMPTZ,
  last_reached_at TIMESTAMPTZ,
  reach_count BIGINT,
  total_count BIGINT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH node_events AS (
    SELECT
      r.contact_id,
      e.created_at
    FROM flow_run_events e
    JOIN flow_runs r ON r.id = e.flow_run_id
    WHERE r.flow_id = p_flow_id
      AND e.event_type = 'node_entered'
      AND e.node_key = p_node_key
      AND r.contact_id IS NOT NULL
      AND (p_date_from IS NULL OR e.created_at >= p_date_from)
      AND (p_date_to IS NULL OR e.created_at <= p_date_to)
  ),
  aggregated AS (
    SELECT
      ne.contact_id,
      MIN(ne.created_at) AS first_reached_at,
      MAX(ne.created_at) AS last_reached_at,
      COUNT(*) AS reach_count
    FROM node_events ne
    GROUP BY ne.contact_id
  ),
  filtered AS (
    SELECT
      a.contact_id,
      c.name AS contact_name,
      c.phone AS contact_phone,
      a.first_reached_at,
      a.last_reached_at,
      a.reach_count
    FROM aggregated a
    JOIN contacts c ON c.id = a.contact_id
    WHERE (
      p_search IS NULL
      OR c.name ILIKE '%' || p_search || '%'
      OR c.phone ILIKE '%' || p_search || '%'
    )
  ),
  counted AS (
    SELECT
      f.contact_id,
      f.contact_name,
      f.contact_phone,
      f.first_reached_at,
      f.last_reached_at,
      f.reach_count,
      COUNT(*) OVER() AS total_count
    FROM filtered f
    ORDER BY f.last_reached_at DESC, f.contact_id
    LIMIT (CASE WHEN p_limit IS NULL OR p_limit <= 0 THEN NULL ELSE p_limit END)
    OFFSET (CASE WHEN p_offset IS NULL OR p_offset < 0 THEN 0 ELSE p_offset END)
  )
  SELECT
    c.contact_id,
    c.contact_name,
    c.contact_phone,
    c.first_reached_at,
    c.last_reached_at,
    c.reach_count,
    c.total_count
  FROM counted c;
$$;

ALTER FUNCTION public.get_flow_node_leads(UUID, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_flow_node_leads(UUID, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_flow_node_leads(UUID, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT, INT) TO authenticated;
