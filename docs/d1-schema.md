# D1 schema (migration phase 1)

The D1 schema is a **baseline migration**, [`d1/migrations/0001_baseline.sql`](../d1/migrations/0001_baseline.sql), plus [`0002_auth.sql`](../d1/migrations/0002_auth.sql) for Better Auth's tables (`auth_sessions`, `auth_accounts`, `auth_verifications`, `auth_rate_limits`; see [data-layer.md](data-layer.md)). It recreates the **final** state of the original Supabase migrations `001`–`046` (removed from the repo; see git history) directly; it does not replay them. Future schema changes are new numbered files in `d1/migrations/` (`npm run db:new -- <name>`).

| Item | Postgres (after 046) | D1 baseline |
|---|---|---|
| App tables | 37 | 38 (`member_presence` removed, `users` added) |
| Indexes (explicit) | 80 | 68: 9 redundant ones dropped, plus `member_presence`'s index and the GIN/HNSW vector indexes, which no longer apply. `sqlite_schema` lists 119 because UNIQUE/PK constraints add automatic indexes. |
| Triggers | 17 | 20 (14 `updated_at`, 3 broadcast counters, 3 FTS sync) |
| SQL functions | 30 | 0 (moved to TypeScript, see below) |
| RLS policies | ~90 | 0 (moved to API role checks, phase 3) |

## Commands

```bash
npm run db:reset:local
```
Wipes local D1, applies migrations, loads the seed.

```bash
npm run db:migrate:local
```
Applies new migrations only.

```bash
npm run db:seed:local
```
Loads `d1/seed/dev.sql`.

```bash
npm run db:new -- add_something
```
Creates the next numbered migration file.

```bash
npx vitest run d1
```
Schema behaviour tests (26), on in-memory SQLite via `node:sqlite`.

The seed creates one account, **Demo Business**, with four users: `owner@`, `admin@`, `agent@` and `viewer@wacrm.test`. It also adds 3 contacts, 2 conversations, a template, a pipeline with a deal, a broadcast with mixed recipient statuses, an automation, a flow, a notification and a knowledge-base document. The login password is in the seed file. There is no WhatsApp config (tokens must be real `ENCRYPTION_KEY` ciphertext).

## Type mapping

| Postgres | D1 | Rule for application code |
|---|---|---|
| `UUID` + `uuid_generate_v4()` | `TEXT PRIMARY KEY NOT NULL DEFAULT (<v4 expression>)` | Omit `id` on insert and use `RETURNING id`, or pass `crypto.randomUUID()`. |
| `TIMESTAMPTZ DEFAULT NOW()` | `TEXT` ISO-8601 UTC ms (`2026-11-12T06:48:11.163Z`) | Always write `new Date().toISOString()`. Never write local time or `+00:00`; values must sort lexically. |
| `BOOLEAN` | `INTEGER` 0/1 + CHECK | Convert to and from `boolean` in the data layer (D1 returns numbers). |
| `JSONB` | `TEXT` + `CHECK (json_valid(...))` | `JSON.stringify` on write, `JSON.parse` on read. |
| `TEXT[]` (`profiles.beta_features`, `api_keys.scopes`, `webhook_endpoints.events`) | `TEXT` JSON array + CHECK `json_type = 'array'` | Filter with `EXISTS (SELECT 1 FROM json_each(col) WHERE value = ?)`. |
| `account_role_enum` | `TEXT CHECK (IN ('owner','admin','agent','viewer'))` | |
| `deals.value NUMERIC(12,2)` | **`deals.value_cents INTEGER`** (renamed) | API converts: `value_cents = Math.round(value * 100)`. |
| `DATE` (`deals.expected_close_date`) | `TEXT` `YYYY-MM-DD`, CHECK it is a real date | |
| `contacts.phone_normalized GENERATED (regexp_replace(phone,'\D','','g'))` | `TEXT NOT NULL CHECK (digits only)`, **no default** | The data layer derives it from `phone` on every insert / upsert / update (`COMPUTED` in `src/lib/db/engine.ts`), like the generated column did. Raw SQL (seed, import scripts) must set it itself. |
| `ai_knowledge_chunks.fts tsvector` + GIN | `ai_knowledge_chunks_fts` FTS5 table, synced by triggers | Query: `WHERE ai_knowledge_chunks_fts MATCH ? AND account_id = ? ORDER BY bm25(ai_knowledge_chunks_fts)` |
| `ai_knowledge_chunks.embedding vector(1536)` + HNSW | removed; `embedded_at TEXT` added | Vectors go to **Vectorize** keyed by chunk id (phase 3/AI). VERIFY: Vectorize has no full local emulation, so local dev falls back to FTS-only retrieval, which the app already supports. |
| `auth.users(id)` FKs | `users(id)` | Better Auth maps its user model onto `users` (phase 2). |

## Triggers kept in the database

- **`updated_at` safety net (14 tables).** SQLite can't modify `NEW` in a trigger, so the **app sets `updated_at`** on every UPDATE. If it forgets, an AFTER UPDATE trigger stamps it, at the cost of one extra row write.
- **Broadcast counters (3 triggers on `broadcast_recipients`).** Same cumulative meaning as Postgres (`sent_count` counts sent, delivered, read and replied, and so on), but **one** `UPDATE broadcasts` per status change instead of up to 9. Tests prove it always equals a full recompute. To repair counts manually:
  ```sql
  UPDATE broadcasts SET
    sent_count      = (SELECT COALESCE(SUM(status IN ('sent','delivered','read','replied')),0) FROM broadcast_recipients WHERE broadcast_id = broadcasts.id),
    delivered_count = (SELECT COALESCE(SUM(status IN ('delivered','read','replied')),0)        FROM broadcast_recipients WHERE broadcast_id = broadcasts.id),
    read_count      = (SELECT COALESCE(SUM(status IN ('read','replied')),0)                    FROM broadcast_recipients WHERE broadcast_id = broadcasts.id),
    replied_count   = (SELECT COALESCE(SUM(status = 'replied'),0)                              FROM broadcast_recipients WHERE broadcast_id = broadcasts.id),
    failed_count    = (SELECT COALESCE(SUM(status = 'failed'),0)                               FROM broadcast_recipients WHERE broadcast_id = broadcasts.id)
  WHERE id = ?;
  ```
- **FTS sync (3 triggers).** Insert, update and delete of chunks, including cascades from documents and accounts.

## Moved out of the database

| Postgres object | New home | Phase |
|---|---|---|
| ~90 RLS policies, `is_account_member()` | `requireRole()` + account scoping in every API endpoint ([MIGRATION_ASSESSMENT.md §5](../MIGRATION_ASSESSMENT.md)) | 3 |
| `handle_new_user` (trigger on `auth.users`) | Better Auth `user.create.after` hook: create account + owner profile | 2 |
| `enforce_profile_privilege_columns` | Profile update API never accepts `account_role` / `account_id` | 3 |
| `notify_conversation_assigned` | `assignConversation()` inserts the notification (needs the acting user, which a trigger can't know) | 3 |
| `set_member_role`, `remove_account_member`, `transfer_account_ownership` | TS + `db.batch()` | 2–3 |
| `peek_invitation`, `redeem_invitation` | TS. The `FOR UPDATE` lock becomes a conditional `UPDATE … WHERE accepted_at IS NULL RETURNING` | 2 |
| `create_broadcast_with_recipients` | TS + `db.batch()`, chunked under D1's bound-parameter limit (VERIFY: 100 per statement) | 3–4 |
| `bump_conversation_on_inbound` | `UPDATE conversations SET unread_count = unread_count + 1, …` | 4 |
| `claim_ai_reply_slot` | `UPDATE conversations SET ai_reply_count = ai_reply_count + 1 WHERE id = ? AND ai_reply_count < ? RETURNING id` | 4 |
| `increment_automation_execution_count`, `increment_flow_execution_count`, `record_webhook_failure` | single UPDATE statements | 3–6 |
| `filter_contacts_by_tags`, `get_flow_node_leads`, `get_broadcast_button_analytics` | SQL in the data layer (`LIKE` instead of `ILIKE`; SQLite `LIKE` is case-insensitive for ASCII only) | 3 |
| `match_ai_knowledge_fts`, `match_ai_knowledge_semantic` | FTS5 query above + Vectorize query | 3 |
| `merge_duplicate_contacts`, `merge_duplicate_conversations` | not needed: the unique indexes already prevent duplicates. | n/a |
| `touch_presence` + `member_presence` table | Durable Object storage | 5 |
| `_bcast_bump`, `_bcast_cols_for_status`, `recompute_broadcast_counts` | counter triggers + repair SQL above | done |
| Realtime publication, storage buckets/policies | Durable Object / R2 | 5–6 |

## Redundant indexes dropped

Each index costs extra rows written on D1, so these were dropped because another index already covers them:
- `idx_broadcast_recipients_broadcast` (prefix of `(broadcast_id, status)`)
- `idx_messages_conversation` (prefix of unique `(conversation_id, message_id)`)
- `idx_conversations_account` (prefix of unique `(account_id, contact_id)`)
- `idx_contact_tags_contact` and `idx_message_reactions_message` (prefixes of their UNIQUE constraints)
- `idx_flow_nodes_flow` (prefix of `UNIQUE (flow_id, node_key)`)
- `idx_whatsapp_config_account`, `api_keys_key_hash_idx` and `idx_broadcast_url_tokens_token` (exact duplicates of UNIQUE columns)

## Behaviour kept exactly as in Postgres (worth knowing)

- `contacts.user_id`, `conversations.user_id` and similar columns are `ON DELETE CASCADE` to `users`. Hard-deleting a user deletes the rows they created, even in a shared account. Member removal never deletes the user, so this doesn't happen today.
- `deals.stage_id` and `deals.conversation_id` are NO ACTION: deleting a stage or conversation that still has deals fails.
- `message_templates` uniqueness is per **user** (`user_id, name, language`), not per account.
- `messages.message_id` (wamid) is unique per conversation only.

## Backups

- VERIFY: `wrangler d1 export` has historically not supported databases with virtual tables (the FTS5 table). Back up with Time Travel, or drop and recreate the FTS table around exports.
