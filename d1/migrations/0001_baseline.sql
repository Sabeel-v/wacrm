-- ============================================================================
-- wacrm D1 baseline schema
-- ============================================================================
-- The FINAL state of Supabase migrations 001–046 (supabase/migrations/),
-- converted to SQLite / Cloudflare D1. This is a fresh baseline, not a
-- replay. Full mapping and rationale: docs/d1-schema.md.
--
-- Conventions
--   ids         TEXT uuid. DEFAULT generates a v4 uuid, so inserts may omit
--               it and read it back with RETURNING id (as PostgREST did).
--               Imported rows keep their Postgres ids.
--   timestamps  TEXT, ISO-8601 UTC with ms: 2026-11-12T06:48:11.163Z
--               (sorts lexically; DEFAULT is "now").
--   booleans    INTEGER 0/1 with CHECK.
--   jsonb       TEXT holding JSON, CHECK json_valid(). Arrays (text[]) are
--               JSON arrays.
--   enums       TEXT + CHECK (account_role_enum → CHECK on 4 values).
--   money       deals.value_cents INTEGER (was NUMERIC(12,2) `value`).
--
-- Not in the database any more (moved to application code, phases 2–5):
--   * RLS policies and is_account_member()  → explicit role checks in the API
--   * all SQL functions / RPCs              → TypeScript (see docs/d1-schema.md)
--   * auth.users + signup trigger           → `users` table + Better Auth hook
--   * notify_conversation_assigned trigger  → app (needs the acting user)
--   * enforce_profile_privilege_columns     → app (no DB roles in D1)
--   * contacts.phone_normalized generated   → app-computed (no regexp in SQLite)
--   * tsvector / pgvector                   → FTS5 table below / Vectorize
--   * member_presence                       → Durable Object storage (phase 5)
--   * Realtime publication, storage buckets → Durable Object / R2
--
-- Foreign keys: D1 enforces them. ON DELETE behaviour matches Postgres.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- users — replaces Supabase auth.users. Better Auth (phase 2) maps its user
-- model onto this table and adds its own session/account/verification
-- tables. Every former auth.users(id) FK points here.
-- ----------------------------------------------------------------------------
CREATE TABLE users (
  id              TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  email           TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name            TEXT NOT NULL DEFAULT '',
  email_verified  INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
  image           TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);


-- ----------------------------------------------------------------------------
-- Accounts, profiles, invitations (017, 021)
-- ----------------------------------------------------------------------------
CREATE TABLE accounts (
  id                TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  name              TEXT NOT NULL,
  owner_user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  default_currency  TEXT NOT NULL DEFAULT 'USD'
                    CHECK (length(default_currency) = 3 AND default_currency GLOB '[A-Z][A-Z][A-Z]'),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX idx_accounts_one_per_owner ON accounts(owner_user_id);

CREATE TABLE profiles (
  id             TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  user_id        TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  account_id     TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  account_role   TEXT NOT NULL CHECK (account_role IN ('owner', 'admin', 'agent', 'viewer')),
  full_name      TEXT NOT NULL,
  email          TEXT NOT NULL,
  avatar_url     TEXT,
  role           TEXT DEFAULT 'user',   -- legacy (001); account_role is authoritative
  beta_features  TEXT NOT NULL DEFAULT '[]'
                 CHECK (json_valid(beta_features) AND json_type(beta_features) = 'array'),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_profiles_account_role ON profiles(account_id, account_role);

CREATE TABLE account_invitations (
  id                   TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  account_id           TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash           TEXT NOT NULL UNIQUE,
  role                 TEXT NOT NULL CHECK (role IN ('admin', 'agent', 'viewer')),  -- never 'owner'
  created_by_user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  label                TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at           TEXT NOT NULL,
  accepted_at          TEXT,
  accepted_by_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_account_invitations_account_pending
  ON account_invitations(account_id, expires_at) WHERE accepted_at IS NULL;


-- ----------------------------------------------------------------------------
-- Contacts, tags, custom fields, notes (001, 017, 022, 040)
-- ----------------------------------------------------------------------------
CREATE TABLE contacts (
  id                 TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  account_id         TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone              TEXT NOT NULL,
  -- Was GENERATED ALWAYS AS (regexp_replace(phone, '\D', '', 'g')). SQLite
  -- has no regexp, so the app writes it (normalizePhone(): strip every
  -- non-digit). No DEFAULT on purpose: an insert that forgets it fails.
  -- The CHECK guarantees digits only.
  phone_normalized   TEXT NOT NULL CHECK (phone_normalized NOT GLOB '*[^0-9]*'),
  name               TEXT,
  email              TEXT,
  company            TEXT,
  avatar_url         TEXT,
  wa_user_id         TEXT,   -- business-scoped user id (BSUID)
  wa_parent_user_id  TEXT,
  wa_username        TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_contacts_account ON contacts(account_id);
CREATE INDEX idx_contacts_user_id ON contacts(user_id);
CREATE INDEX idx_contacts_phone ON contacts(phone);
CREATE UNIQUE INDEX idx_contacts_account_phone_normalized
  ON contacts(account_id, phone_normalized) WHERE phone_normalized <> '';
CREATE UNIQUE INDEX idx_contacts_account_wa_user_id
  ON contacts(account_id, wa_user_id) WHERE wa_user_id IS NOT NULL;

CREATE TABLE tags (
  id          TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#3b82f6',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_tags_account ON tags(account_id);

CREATE TABLE contact_tags (
  id          TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  contact_id  TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag_id      TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (contact_id, tag_id)
);
-- (contact_id) is served by the UNIQUE index above.
CREATE INDEX idx_contact_tags_tag ON contact_tags(tag_id);

CREATE TABLE custom_fields (
  id             TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  account_id     TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  field_name     TEXT NOT NULL,
  field_type     TEXT NOT NULL DEFAULT 'text',
  field_options  TEXT CHECK (field_options IS NULL OR json_valid(field_options)),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_custom_fields_account ON custom_fields(account_id);

CREATE TABLE contact_custom_values (
  id               TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  contact_id       TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  custom_field_id  TEXT NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
  value            TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (contact_id, custom_field_id)
);

CREATE TABLE contact_notes (
  id          TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id  TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note_text   TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_contact_notes_account ON contact_notes(account_id);


-- ----------------------------------------------------------------------------
-- Conversations, messages, reactions (001, 009, 010, 029, 033, 035–037, 039, 042)
-- ----------------------------------------------------------------------------
CREATE TABLE conversations (
  id                     TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  account_id             TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id             TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status                 TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'closed')),
  assigned_agent_id      TEXT,   -- user id; no FK in Postgres either
  last_message_text      TEXT,
  last_message_at        TEXT,
  unread_count           INTEGER NOT NULL DEFAULT 0,
  ai_autoreply_disabled  INTEGER NOT NULL DEFAULT 0 CHECK (ai_autoreply_disabled IN (0, 1)),
  ai_reply_count         INTEGER NOT NULL DEFAULT 0,
  ai_handoff_summary     TEXT,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- One conversation per contact (036). Also serves (account_id) lookups.
CREATE UNIQUE INDEX idx_conversations_account_contact ON conversations(account_id, contact_id);
CREATE INDEX idx_conversations_user_id ON conversations(user_id);
CREATE INDEX idx_conversations_contact_id ON conversations(contact_id);

CREATE TABLE messages (
  id                    TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  conversation_id       TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_type           TEXT NOT NULL CHECK (sender_type IN ('customer', 'agent', 'bot')),
  sender_id             TEXT,
  content_type          TEXT NOT NULL DEFAULT 'text'
                        CHECK (content_type IN ('text', 'image', 'document', 'audio', 'video',
                                                'location', 'template', 'interactive')),
  content_text          TEXT,
  media_url             TEXT,
  media_type            TEXT,   -- MIME type, inbound media only (039)
  template_name         TEXT,
  message_id            TEXT,   -- Meta wamid; NOT globally unique (see 037)
  status                TEXT NOT NULL DEFAULT 'sent'
                        CHECK (status IN ('sending', 'sent', 'delivered', 'read', 'failed')),
  reply_to_message_id   TEXT REFERENCES messages(id) ON DELETE SET NULL,
  interactive_reply_id  TEXT,
  interactive_payload   TEXT CHECK (interactive_payload IS NULL OR json_valid(interactive_payload)),
  ai_generated          INTEGER NOT NULL DEFAULT 0 CHECK (ai_generated IN (0, 1)),
  error_code            INTEGER,
  error_title           TEXT,
  error_details         TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- Webhook idempotency gate (037). Also serves (conversation_id) lookups.
CREATE UNIQUE INDEX idx_messages_conversation_message_id ON messages(conversation_id, message_id);
CREATE INDEX idx_messages_message_id ON messages(message_id);
CREATE INDEX idx_messages_reply_to ON messages(reply_to_message_id) WHERE reply_to_message_id IS NOT NULL;

CREATE TABLE message_reactions (
  id               TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  message_id       TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  actor_type       TEXT NOT NULL CHECK (actor_type IN ('customer', 'agent')),
  actor_id         TEXT,
  emoji            TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (message_id, actor_type, actor_id)
);
-- (message_id) is served by the UNIQUE index above.
CREATE INDEX idx_message_reactions_conversation ON message_reactions(conversation_id);


-- ----------------------------------------------------------------------------
-- WhatsApp config and templates (001, 013–015, 017, 039)
-- ----------------------------------------------------------------------------
CREATE TABLE whatsapp_config (
  id                       TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  account_id               TEXT NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  user_id                  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone_number_id          TEXT NOT NULL UNIQUE,
  waba_id                  TEXT,
  access_token             TEXT NOT NULL,   -- AES-256-GCM ciphertext (ENCRYPTION_KEY)
  verify_token             TEXT,            -- AES-256-GCM ciphertext
  status                   TEXT NOT NULL DEFAULT 'disconnected'
                           CHECK (status IN ('connected', 'disconnected')),
  connected_at             TEXT,
  registered_at            TEXT,
  subscribed_apps_at       TEXT,
  last_registration_error  TEXT,
  mirror_inbound_media     INTEGER NOT NULL DEFAULT 1 CHECK (mirror_inbound_media IN (0, 1)),
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_whatsapp_config_registered_at ON whatsapp_config(registered_at) WHERE registered_at IS NULL;

CREATE TABLE message_templates (
  id                 TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  account_id         TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  category           TEXT NOT NULL DEFAULT 'Marketing'
                     CHECK (category IN ('Marketing', 'Utility', 'Authentication')),
  language           TEXT DEFAULT 'en_US',
  header_type        TEXT CHECK (header_type IN ('text', 'image', 'video', 'document')),
  header_content     TEXT,
  header_handle      TEXT,
  header_media_url   TEXT,
  body_text          TEXT NOT NULL,
  footer_text        TEXT,
  buttons            TEXT CHECK (buttons IS NULL OR (json_valid(buttons)
                                 AND json_type(buttons) = 'array'
                                 AND json_array_length(buttons) <= 10)),
  sample_values      TEXT CHECK (sample_values IS NULL OR json_valid(sample_values)),
  status             TEXT DEFAULT 'DRAFT'
                     CHECK (status IN ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED',
                                       'PAUSED', 'DISABLED', 'IN_APPEAL', 'PENDING_DELETION')),
  meta_template_id   TEXT,
  rejection_reason   TEXT,
  quality_score      TEXT CHECK (quality_score IS NULL OR quality_score IN ('GREEN', 'YELLOW', 'RED')),
  submission_error   TEXT,
  last_submitted_at  TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX message_templates_user_name_language_key ON message_templates(user_id, name, language);
CREATE INDEX idx_message_templates_account ON message_templates(account_id);
CREATE INDEX idx_message_templates_meta_template_id
  ON message_templates(meta_template_id) WHERE meta_template_id IS NOT NULL;


-- ----------------------------------------------------------------------------
-- Pipelines and deals (001, 002, 004)
-- ----------------------------------------------------------------------------
CREATE TABLE pipelines (
  id          TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_pipelines_account ON pipelines(account_id);

CREATE TABLE pipeline_stages (
  id           TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  pipeline_id  TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  position     INTEGER NOT NULL DEFAULT 0,
  color        TEXT NOT NULL DEFAULT '#3b82f6',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_pipeline_stages_pipeline ON pipeline_stages(pipeline_id);

CREATE TABLE deals (
  id                   TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  account_id           TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pipeline_id          TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  stage_id             TEXT NOT NULL REFERENCES pipeline_stages(id),           -- NO ACTION (as Postgres)
  contact_id           TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id      TEXT REFERENCES conversations(id),                      -- NO ACTION (as Postgres)
  assigned_to          TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  title                TEXT NOT NULL,
  -- Was `value NUMERIC(12,2)`. Stored as integer minor units (cents) to
  -- avoid float rounding; the API converts to/from decimals.
  value_cents          INTEGER NOT NULL DEFAULT 0,
  currency             TEXT DEFAULT 'USD',
  notes                TEXT,
  expected_close_date  TEXT CHECK (expected_close_date IS NULL OR date(expected_close_date) IS expected_close_date),
  status               TEXT DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost')),
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_deals_account ON deals(account_id);
CREATE INDEX idx_deals_pipeline ON deals(pipeline_id);
CREATE INDEX idx_deals_stage ON deals(stage_id);
CREATE INDEX idx_deals_assigned_to ON deals(assigned_to);


-- ----------------------------------------------------------------------------
-- Broadcasts (001, 003–005, 037, 038, 044–046)
-- ----------------------------------------------------------------------------
CREATE TABLE broadcasts (
  id                  TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  account_id          TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  template_name       TEXT NOT NULL,
  template_language   TEXT NOT NULL DEFAULT 'en_US',
  template_variables  TEXT CHECK (template_variables IS NULL OR json_valid(template_variables)),
  audience_filter     TEXT CHECK (audience_filter IS NULL OR json_valid(audience_filter)),
  scheduled_at        TEXT,
  status              TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'failed')),
  -- Counters maintained by the trg_broadcast_recipients_* triggers below.
  total_recipients    INTEGER NOT NULL DEFAULT 0,
  sent_count          INTEGER NOT NULL DEFAULT 0,
  delivered_count     INTEGER NOT NULL DEFAULT 0,
  read_count          INTEGER NOT NULL DEFAULT 0,
  replied_count       INTEGER NOT NULL DEFAULT 0,
  failed_count        INTEGER NOT NULL DEFAULT 0,
  delivery_locked_at  TEXT,   -- delivery-pass lease (038)
  delivery_queued_at  TEXT,   -- last queue pass (046)
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_broadcasts_account ON broadcasts(account_id);

CREATE TABLE broadcast_recipients (
  id                   TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  broadcast_id         TEXT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  contact_id           TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'sent', 'delivered', 'read', 'replied', 'failed')),
  whatsapp_message_id  TEXT,
  template_params      TEXT CHECK (template_params IS NULL OR json_valid(template_params)),
  message_params       TEXT CHECK (message_params IS NULL OR json_valid(message_params)),
  sent_at              TEXT,
  delivered_at         TEXT,
  read_at              TEXT,
  replied_at           TEXT,
  error_message        TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- Also serves (broadcast_id) lookups; the separate idx_broadcast_recipients_broadcast is dropped.
CREATE INDEX idx_broadcast_recipients_broadcast_status ON broadcast_recipients(broadcast_id, status);
CREATE UNIQUE INDEX idx_broadcast_recipients_wamid
  ON broadcast_recipients(whatsapp_message_id) WHERE whatsapp_message_id IS NOT NULL;

CREATE TABLE broadcast_button_clicks (
  id                  TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  account_id          TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  broadcast_id        TEXT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  contact_id          TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  button_index        INTEGER NOT NULL,
  button_name         TEXT NOT NULL,
  button_type         TEXT NOT NULL DEFAULT 'QUICK_REPLY',
  button_payload      TEXT,
  inbound_message_id  TEXT NOT NULL,
  clicked_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX idx_broadcast_button_clicks_inbound_msg ON broadcast_button_clicks(inbound_message_id);
CREATE INDEX idx_broadcast_button_clicks_bcast_btn ON broadcast_button_clicks(broadcast_id, button_index);
CREATE INDEX idx_broadcast_button_clicks_account ON broadcast_button_clicks(account_id);

CREATE TABLE broadcast_url_tokens (
  id               TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  broadcast_id     TEXT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  contact_id       TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  recipient_phone  TEXT,
  button_index     INTEGER NOT NULL,
  button_name      TEXT NOT NULL,
  token            TEXT NOT NULL UNIQUE,   -- duplicate idx_broadcast_url_tokens_token dropped
  destination_url  TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_broadcast_url_tokens_bcast_btn ON broadcast_url_tokens(broadcast_id, button_index);
CREATE INDEX idx_broadcast_url_tokens_account ON broadcast_url_tokens(account_id);


-- ----------------------------------------------------------------------------
-- Automations (006, 017, 020)
-- ----------------------------------------------------------------------------
CREATE TABLE automations (
  id                TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  account_id        TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  description       TEXT,
  trigger_type      TEXT NOT NULL,
  trigger_config    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(trigger_config)),
  is_active         INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  execution_count   INTEGER NOT NULL DEFAULT 0,
  last_executed_at  TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_automations_account ON automations(account_id);
CREATE INDEX idx_automations_user_id ON automations(user_id);
CREATE INDEX idx_automations_active_trigger ON automations(trigger_type) WHERE is_active = 1;
CREATE INDEX idx_automations_account_active_trigger ON automations(account_id, trigger_type) WHERE is_active = 1;

CREATE TABLE automation_steps (
  id              TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  automation_id   TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  parent_step_id  TEXT REFERENCES automation_steps(id) ON DELETE CASCADE,
  branch          TEXT CHECK (branch IN ('yes', 'no')),
  step_type       TEXT NOT NULL,
  step_config     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(step_config)),
  position        INTEGER NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_automation_steps_automation_id ON automation_steps(automation_id, position);
CREATE INDEX idx_automation_steps_parent ON automation_steps(parent_step_id) WHERE parent_step_id IS NOT NULL;

CREATE TABLE automation_logs (
  id              TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  account_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  automation_id   TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id      TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  trigger_event   TEXT NOT NULL,
  steps_executed  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(steps_executed)),
  status          TEXT NOT NULL CHECK (status IN ('success', 'partial', 'failed')),
  error_message   TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_automation_logs_account ON automation_logs(account_id);
CREATE INDEX idx_automation_logs_automation ON automation_logs(automation_id, created_at DESC);
CREATE INDEX idx_automation_logs_user ON automation_logs(user_id);

CREATE TABLE automation_pending_executions (
  id                  TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  account_id          TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  automation_id       TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id          TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  log_id              TEXT REFERENCES automation_logs(id) ON DELETE CASCADE,
  parent_step_id      TEXT REFERENCES automation_steps(id) ON DELETE SET NULL,
  branch              TEXT CHECK (branch IN ('yes', 'no')),
  next_step_position  INTEGER NOT NULL,
  context             TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(context)),
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  run_at              TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_automation_pending_account ON automation_pending_executions(account_id);
CREATE INDEX idx_automation_pending_due ON automation_pending_executions(run_at) WHERE status = 'pending';


-- ----------------------------------------------------------------------------
-- Flows (010, 016, 017, 020, 043)
-- ----------------------------------------------------------------------------
CREATE TABLE flows (
  id                TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  account_id        TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  description       TEXT,
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  trigger_type      TEXT NOT NULL CHECK (trigger_type IN ('keyword', 'first_inbound_message', 'manual')),
  trigger_config    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(trigger_config)),
  entry_node_id     TEXT,
  fallback_policy   TEXT NOT NULL
                    DEFAULT '{"on_unknown_reply":"reprompt","max_reprompts":2,"on_timeout_hours":24,"on_exhaust":"handoff"}'
                    CHECK (json_valid(fallback_policy)),
  execution_count   INTEGER NOT NULL DEFAULT 0,
  last_executed_at  TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_flows_account ON flows(account_id);
CREATE INDEX idx_flows_active_trigger ON flows(user_id, trigger_type) WHERE status = 'active';
CREATE INDEX idx_flows_account_active ON flows(account_id) WHERE status = 'active';

CREATE TABLE flow_nodes (
  id          TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  flow_id     TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  node_key    TEXT NOT NULL,
  node_type   TEXT NOT NULL CHECK (node_type IN ('start', 'send_buttons', 'send_list', 'send_message',
                                                 'send_media', 'collect_input', 'condition', 'set_tag',
                                                 'handoff', 'http_fetch', 'end')),
  config      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config)),
  position_x  INTEGER NOT NULL DEFAULT 0,
  position_y  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (flow_id, node_key)
);
-- (flow_id) is served by the UNIQUE index above; idx_flow_nodes_flow dropped.

CREATE TABLE flow_runs (
  id                      TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  account_id              TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  flow_id                 TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  user_id                 TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id              TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id         TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  status                  TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'completed', 'handed_off', 'timed_out',
                                            'paused_by_agent', 'failed')),
  current_node_key        TEXT,
  last_prompt_message_id  TEXT REFERENCES messages(id) ON DELETE SET NULL,
  vars                    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(vars)),
  reprompt_count          INTEGER NOT NULL DEFAULT 0,
  started_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_advanced_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ended_at                TEXT,
  end_reason              TEXT
);
CREATE INDEX idx_flow_runs_account ON flow_runs(account_id);
CREATE UNIQUE INDEX idx_one_active_run_per_contact ON flow_runs(account_id, contact_id) WHERE status = 'active';
CREATE INDEX idx_flow_runs_active_advanced ON flow_runs(last_advanced_at) WHERE status = 'active';
CREATE INDEX idx_flow_runs_flow_started ON flow_runs(flow_id, started_at DESC);
CREATE INDEX idx_flow_runs_flow_contact ON flow_runs(flow_id, contact_id);

CREATE TABLE flow_run_events (
  id           TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  flow_run_id  TEXT NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  event_type   TEXT NOT NULL CHECK (event_type IN ('started', 'node_entered', 'message_sent', 'reply_received',
                                                   'fallback_fired', 'handoff', 'timeout', 'error', 'completed')),
  node_key     TEXT,
  payload      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_flow_run_events_run_type ON flow_run_events(flow_run_id, event_type);
CREATE INDEX idx_flow_run_events_run_time ON flow_run_events(flow_run_id, created_at DESC);
CREATE INDEX idx_flow_run_events_node_tracking ON flow_run_events(node_key, event_type, created_at DESC);


-- ----------------------------------------------------------------------------
-- API keys, notifications, outbound webhooks (026–028)
-- ----------------------------------------------------------------------------
CREATE TABLE api_keys (
  id            TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  key_prefix    TEXT NOT NULL,          -- display only
  key_hash      TEXT NOT NULL UNIQUE,   -- SHA-256 hex; duplicate api_keys_key_hash_idx dropped
  scopes        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scopes) AND json_type(scopes) = 'array'),
  last_used_at  TEXT,
  expires_at    TEXT,
  revoked_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX api_keys_account_id_idx ON api_keys(account_id);

CREATE TABLE notifications (
  id               TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type             TEXT NOT NULL DEFAULT 'conversation_assigned' CHECK (type IN ('conversation_assigned')),
  conversation_id  TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id       TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  actor_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  title            TEXT NOT NULL,
  body             TEXT,
  read_at          TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_notifications_user_created ON notifications(user_id, created_at DESC);
CREATE INDEX idx_notifications_user_unread ON notifications(user_id) WHERE read_at IS NULL;

CREATE TABLE webhook_endpoints (
  id                TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  account_id        TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  url               TEXT NOT NULL,
  secret            TEXT NOT NULL,   -- AES-256-GCM ciphertext
  -- Was text[] queried with @> (contains). Query with:
  --   EXISTS (SELECT 1 FROM json_each(events) WHERE value = ?)
  events            TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(events) AND json_type(events) = 'array'),
  is_active         INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  last_delivery_at  TEXT,
  failure_count     INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX webhook_endpoints_account_id_idx ON webhook_endpoints(account_id);


-- ----------------------------------------------------------------------------
-- AI reply and knowledge base (029–033)
-- ----------------------------------------------------------------------------
CREATE TABLE ai_configs (
  id                               TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  account_id                       TEXT NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  created_by                       TEXT REFERENCES users(id) ON DELETE SET NULL,
  provider                         TEXT NOT NULL CHECK (provider IN ('openai', 'anthropic')),
  model                            TEXT NOT NULL,
  api_key                          TEXT NOT NULL,   -- AES-256-GCM ciphertext
  embeddings_api_key               TEXT,
  system_prompt                    TEXT,
  is_active                        INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  auto_reply_enabled               INTEGER NOT NULL DEFAULT 0 CHECK (auto_reply_enabled IN (0, 1)),
  auto_reply_max_per_conversation  INTEGER NOT NULL DEFAULT 3 CHECK (auto_reply_max_per_conversation BETWEEN 1 AND 20),
  handoff_agent_id                 TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at                       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at                       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE ai_knowledge_documents (
  id          TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX ai_knowledge_documents_account_id_idx ON ai_knowledge_documents(account_id);

-- `fts tsvector` → ai_knowledge_chunks_fts (FTS5, kept in sync by triggers).
-- `embedding vector(1536)` → Cloudflare Vectorize, keyed by chunk id;
-- `embedded_at` records when the vector was last upserted (NULL = none).
CREATE TABLE ai_knowledge_chunks (
  id           TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  document_id  TEXT NOT NULL REFERENCES ai_knowledge_documents(id) ON DELETE CASCADE,
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  chunk_index  INTEGER NOT NULL DEFAULT 0,
  content      TEXT NOT NULL,
  embedded_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX ai_knowledge_chunks_account_id_idx ON ai_knowledge_chunks(account_id);
CREATE INDEX ai_knowledge_chunks_document_id_idx ON ai_knowledge_chunks(document_id);

-- Full-text index. Stores its own copy of `content` (not external-content)
-- so it never depends on implicit rowids. unicode61 without diacritic
-- folding ≈ Postgres to_tsvector('simple').
-- Search: SELECT chunk_id, content, bm25(ai_knowledge_chunks_fts) AS rank
--         FROM ai_knowledge_chunks_fts
--         WHERE ai_knowledge_chunks_fts MATCH ? AND account_id = ?
--         ORDER BY rank LIMIT ?;
CREATE VIRTUAL TABLE ai_knowledge_chunks_fts USING fts5(
  chunk_id UNINDEXED,
  account_id UNINDEXED,
  content,
  tokenize = 'unicode61 remove_diacritics 0'
);

CREATE TABLE ai_usage_log (
  id                 TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  account_id         TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id    TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  mode               TEXT NOT NULL CHECK (mode IN ('auto_reply', 'draft')),
  provider           TEXT NOT NULL CHECK (provider IN ('openai', 'anthropic')),
  model              TEXT NOT NULL,
  prompt_tokens      INTEGER NOT NULL DEFAULT 0,
  completion_tokens  INTEGER NOT NULL DEFAULT 0,
  total_tokens       INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_ai_usage_log_account_created ON ai_usage_log(account_id, created_at DESC);


-- ----------------------------------------------------------------------------
-- Quick replies (035)
-- ----------------------------------------------------------------------------
CREATE TABLE quick_replies (
  id                   TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  account_id           TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title                TEXT NOT NULL,
  kind                 TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'interactive')),
  content_text         TEXT,
  interactive_payload  TEXT CHECK (interactive_payload IS NULL OR json_valid(interactive_payload)),
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_quick_replies_account ON quick_replies(account_id);


-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- ----------------------------------------------------------------------------
-- updated_at safety net (replaces Postgres BEFORE UPDATE set_updated_at).
-- SQLite triggers can't modify NEW, so the APP sets updated_at on every
-- UPDATE (no extra write). If it forgets, these fire and stamp it, which
-- costs one extra row write. The WHEN clause stops them otherwise.
-- ----------------------------------------------------------------------------
CREATE TRIGGER trg_users_updated_at AFTER UPDATE ON users FOR EACH ROW
WHEN NEW.updated_at IS OLD.updated_at
BEGIN UPDATE users SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;

CREATE TRIGGER trg_accounts_updated_at AFTER UPDATE ON accounts FOR EACH ROW
WHEN NEW.updated_at IS OLD.updated_at
BEGIN UPDATE accounts SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;

CREATE TRIGGER trg_profiles_updated_at AFTER UPDATE ON profiles FOR EACH ROW
WHEN NEW.updated_at IS OLD.updated_at
BEGIN UPDATE profiles SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;

CREATE TRIGGER trg_contacts_updated_at AFTER UPDATE ON contacts FOR EACH ROW
WHEN NEW.updated_at IS OLD.updated_at
BEGIN UPDATE contacts SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;

CREATE TRIGGER trg_conversations_updated_at AFTER UPDATE ON conversations FOR EACH ROW
WHEN NEW.updated_at IS OLD.updated_at
BEGIN UPDATE conversations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;

CREATE TRIGGER trg_whatsapp_config_updated_at AFTER UPDATE ON whatsapp_config FOR EACH ROW
WHEN NEW.updated_at IS OLD.updated_at
BEGIN UPDATE whatsapp_config SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;

CREATE TRIGGER trg_message_templates_updated_at AFTER UPDATE ON message_templates FOR EACH ROW
WHEN NEW.updated_at IS OLD.updated_at
BEGIN UPDATE message_templates SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;

CREATE TRIGGER trg_deals_updated_at AFTER UPDATE ON deals FOR EACH ROW
WHEN NEW.updated_at IS OLD.updated_at
BEGIN UPDATE deals SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;

CREATE TRIGGER trg_broadcasts_updated_at AFTER UPDATE ON broadcasts FOR EACH ROW
WHEN NEW.updated_at IS OLD.updated_at
BEGIN UPDATE broadcasts SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;

CREATE TRIGGER trg_automations_updated_at AFTER UPDATE ON automations FOR EACH ROW
WHEN NEW.updated_at IS OLD.updated_at
BEGIN UPDATE automations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;

CREATE TRIGGER trg_flows_updated_at AFTER UPDATE ON flows FOR EACH ROW
WHEN NEW.updated_at IS OLD.updated_at
BEGIN UPDATE flows SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;

CREATE TRIGGER trg_ai_configs_updated_at AFTER UPDATE ON ai_configs FOR EACH ROW
WHEN NEW.updated_at IS OLD.updated_at
BEGIN UPDATE ai_configs SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;

CREATE TRIGGER trg_ai_knowledge_documents_updated_at AFTER UPDATE ON ai_knowledge_documents FOR EACH ROW
WHEN NEW.updated_at IS OLD.updated_at
BEGIN UPDATE ai_knowledge_documents SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;

CREATE TRIGGER trg_quick_replies_updated_at AFTER UPDATE ON quick_replies FOR EACH ROW
WHEN NEW.updated_at IS OLD.updated_at
BEGIN UPDATE quick_replies SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;


-- ----------------------------------------------------------------------------
-- Broadcast counters (replaces 003/005 broadcast_recipient_aggregate_trigger).
-- Same cumulative semantics as Postgres:
--   sent_count      = recipients in sent | delivered | read | replied
--   delivered_count = recipients in delivered | read | replied
--   read_count      = recipients in read | replied
--   replied_count   = recipients in replied
--   failed_count    = recipients in failed
-- Difference: ONE UPDATE per status change (Postgres did up to 9 separate
-- UPDATEs per transition, see MIGRATION_ASSESSMENT.md §12). Counts are
-- clamped at 0 like GREATEST(0, …). broadcast_id is treated as immutable.
-- Recompute from scratch (old recompute_broadcast_counts):
--   see docs/d1-schema.md.
-- ----------------------------------------------------------------------------
CREATE TRIGGER trg_broadcast_recipients_counts_insert
AFTER INSERT ON broadcast_recipients FOR EACH ROW
WHEN NEW.status <> 'pending'
BEGIN
  UPDATE broadcasts SET
    sent_count      = sent_count      + (NEW.status IN ('sent', 'delivered', 'read', 'replied')),
    delivered_count = delivered_count + (NEW.status IN ('delivered', 'read', 'replied')),
    read_count      = read_count      + (NEW.status IN ('read', 'replied')),
    replied_count   = replied_count   + (NEW.status = 'replied'),
    failed_count    = failed_count    + (NEW.status = 'failed'),
    updated_at      = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = NEW.broadcast_id;
END;

CREATE TRIGGER trg_broadcast_recipients_counts_update
AFTER UPDATE OF status ON broadcast_recipients FOR EACH ROW
WHEN NEW.status IS NOT OLD.status
BEGIN
  UPDATE broadcasts SET
    sent_count      = MAX(0, sent_count
                        + (NEW.status IN ('sent', 'delivered', 'read', 'replied'))
                        - (OLD.status IN ('sent', 'delivered', 'read', 'replied'))),
    delivered_count = MAX(0, delivered_count
                        + (NEW.status IN ('delivered', 'read', 'replied'))
                        - (OLD.status IN ('delivered', 'read', 'replied'))),
    read_count      = MAX(0, read_count
                        + (NEW.status IN ('read', 'replied'))
                        - (OLD.status IN ('read', 'replied'))),
    replied_count   = MAX(0, replied_count + (NEW.status = 'replied') - (OLD.status = 'replied')),
    failed_count    = MAX(0, failed_count  + (NEW.status = 'failed')  - (OLD.status = 'failed')),
    updated_at      = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = NEW.broadcast_id;
END;

CREATE TRIGGER trg_broadcast_recipients_counts_delete
AFTER DELETE ON broadcast_recipients FOR EACH ROW
WHEN OLD.status <> 'pending'
BEGIN
  UPDATE broadcasts SET
    sent_count      = MAX(0, sent_count      - (OLD.status IN ('sent', 'delivered', 'read', 'replied'))),
    delivered_count = MAX(0, delivered_count - (OLD.status IN ('delivered', 'read', 'replied'))),
    read_count      = MAX(0, read_count      - (OLD.status IN ('read', 'replied'))),
    replied_count   = MAX(0, replied_count   - (OLD.status = 'replied')),
    failed_count    = MAX(0, failed_count    - (OLD.status = 'failed')),
    updated_at      = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = OLD.broadcast_id;
END;


-- ----------------------------------------------------------------------------
-- Knowledge-base full-text sync (replaces the generated tsvector column).
-- ----------------------------------------------------------------------------
CREATE TRIGGER trg_ai_knowledge_chunks_fts_insert
AFTER INSERT ON ai_knowledge_chunks FOR EACH ROW
BEGIN
  INSERT INTO ai_knowledge_chunks_fts (chunk_id, account_id, content)
  VALUES (NEW.id, NEW.account_id, NEW.content);
END;

CREATE TRIGGER trg_ai_knowledge_chunks_fts_update
AFTER UPDATE OF content, account_id ON ai_knowledge_chunks FOR EACH ROW
BEGIN
  DELETE FROM ai_knowledge_chunks_fts WHERE chunk_id = OLD.id;
  INSERT INTO ai_knowledge_chunks_fts (chunk_id, account_id, content)
  VALUES (NEW.id, NEW.account_id, NEW.content);
END;

-- Also fires for ON DELETE CASCADE from documents / accounts.
CREATE TRIGGER trg_ai_knowledge_chunks_fts_delete
AFTER DELETE ON ai_knowledge_chunks FOR EACH ROW
BEGIN
  DELETE FROM ai_knowledge_chunks_fts WHERE chunk_id = OLD.id;
END;
