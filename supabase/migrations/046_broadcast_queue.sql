-- ============================================================
-- 046_broadcast_queue
--
-- Server-side broadcast delivery through QStash. When QSTASH_TOKEN is
-- set, the wizard no longer drives the send loop from the browser tab:
-- it persists the recipients and hands the campaign to a QStash-driven
-- worker (`/api/whatsapp/broadcast/[id]/worker`) that sends one capped
-- pass per invocation and chains the next pass until nothing is
-- pending. Two things the schema didn't record:
--
--   1. broadcast_recipients.message_params — the structured per-send
--      values (header media URL, per-recipient URL-button tracking
--      tokens). The browser loop built these in memory, so a
--      server-side pass — QStash or a manual resume — sent without the
--      media header and without click tracking.
--
--   2. broadcasts.delivery_queued_at — stamped on enqueue and on every
--      worker pass. The detail page reads a recent stamp as "being
--      delivered in the background" rather than as a stalled campaign
--      that needs Resume.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE broadcast_recipients
  ADD COLUMN IF NOT EXISTS message_params JSONB;

COMMENT ON COLUMN broadcast_recipients.message_params IS
  'Structured per-send template values (SendTimeParams: headerMediaUrl, buttonParams, ...), frozen when the broadcast was planned. NULL means body params only (template_params). See 046_broadcast_queue.sql.';

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS delivery_queued_at TIMESTAMPTZ;

COMMENT ON COLUMN broadcasts.delivery_queued_at IS
  'Last time a QStash delivery pass was enqueued or ran for this broadcast; NULL for browser-driven sends. See 046_broadcast_queue.sql.';
