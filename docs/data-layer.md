# Data layer and auth on D1 (migration phases 2 + 3)

The app no longer talks to Supabase. Every `createClient()` the code already calls now returns a **D1 client with the same API** as supabase-js: `.from().select().eq()…`, `.rpc()`, `.auth`, `.storage`, `.channel()`. So the ~460 existing queries and 37 client components run unchanged, on Cloudflare D1, R2 and Better Auth.

## How a query flows

```
Browser component                       Server route / lib
createClient()  (@/lib/supabase/client) createClient()  (@/lib/supabase/server)   supabaseAdmin() / serviceDb()
      │ builds a query AST                    │                                         │
      ▼                                       ▼                                         ▼
POST /api/db ── session → policy ──▶  engine (SQL on D1) ◀── session → policy     engine, no policy
                (secrets hidden)                                                  (service role)
```

| Client | Where | Policy (RLS port) | Secret columns |
|---|---|---|---|
| Browser `createClient()` | `src/lib/db/browser.ts` → `/api/db` | yes, from the signed-in session | **never returned** |
| Server `createClient()` | `src/lib/db/server.ts` `createServerDb()` | yes, from the request cookies | readable (e.g. to decrypt the Meta token) |
| Admin `supabaseAdmin()` / `serviceDb()` | webhook, engines, cron, queue | none (like the old service key) | readable |

No session means everything is denied (`anonymousPolicy`), except the `peek_invitation` RPC.

## Files

| File | Purpose |
|---|---|
| `src/lib/db/builder.ts` | supabase-js–compatible query builder → AST |
| `src/lib/db/parse.ts` | PostgREST `select=` strings (embeds, aliases, `!inner`, FK hints) and `.or()` strings |
| `src/lib/db/engine.ts` | AST → parameterised SQLite; embeds, type conversion, chunked atomic bulk inserts, upserts, Postgres-style errors |
| `src/lib/db/policy.ts` | **RLS port**: per-table rules (account scope, viewer/agent/admin/owner tiers, secret columns) |
| `src/lib/db/rpc.ts` | TypeScript ports of the 17 Postgres functions the app calls |
| `src/lib/db/validate-ast.ts` | Strict validation of queries arriving from the browser |
| `src/lib/db/schema.generated.ts` | Column kinds + foreign keys, generated from `d1/migrations` (`npm run db:gen-schema`) |
| `src/lib/db/storage-*.ts`, `src/app/api/storage/…` | Supabase Storage → R2 (buckets `avatars`, `flow-media`, `chat-media`, same path rules and limits) |
| `src/app/api/db/route.ts` | Browser query endpoint (same-origin only, 2 MB body limit) |
| `src/lib/auth/better-auth.ts` | Better Auth on D1 (tables `users` + `auth_*`, migration 0002) |
| `src/lib/auth/session.ts`, `bootstrap.ts` | Session → account + role; sign-up creates account + owner profile |
| `src/middleware.ts` | Route guard (cookie-based, edge-safe) |
| `src/app/(auth)/reset-password/page.tsx` | New: password-reset landing page (was missing) |

## Behaviour notes

- **Same results as PostgREST:** booleans come back as `true`/`false`, JSON columns parsed, `deals.value` as a decimal (stored as `value_cents`), `.single()` errors with `PGRST116`, unique violations with `23505`, policy denials with `42501`. Ordering follows Postgres (ASC NULLS LAST, DESC NULLS FIRST).
- **Writes the role may not make** return `42501`. (Postgres RLS silently affected 0 rows.) Reads outside your scope simply return no rows.
- **UPDATE/DELETE from a user session must have a filter.**
- **Unsupported query features fail loudly** (`PGRST100`/`PGRST204`), never silently: e.g. `.or()`/`.order()` on an embedded table.
- **`updated_at`** is set automatically on every UPDATE and upsert.
- **Realtime** (`channel().on('postgres_changes')`) is inert until the Durable Object hub (phase 5): pages load data but don't live-update. Refresh to see new messages.
- **Presence** (`member_presence`, `touch_presence`) is a no-op until phase 5; teammates show offline.
- **Knowledge base:** semantic (vector) search returns nothing until Vectorize is wired; retrieval uses full-text search (FTS5), which the app already falls back to.

## Auth

- Email + password via Better Auth. Passwords: scrypt. **Imported Supabase bcrypt hashes** (`$2a$`) are accepted and upgraded to scrypt on the user's next login (tested with the seed viewer).
- Sessions: `better-auth.session_token` cookie (+ a signed 5-minute `session_data` cache to save D1 reads). The role is read from `profiles` on every request, so role changes apply immediately. A revoked session can stay valid in the cache for up to 5 minutes.
- Rate limiting: stored in D1 (`auth_rate_limits`), keyed by `CF-Connecting-IP`. Locally all requests share one bucket, so more than 3 sign-ins within 10 seconds get `429`.
- Password reset: the link is **printed in the terminal** running the preview (no email provider yet, phase 8).
- Email change: needs an email provider too; until then it returns an error in Settings.
- Secret: `BETTER_AUTH_SECRET` (in `.env.local` locally; `wrangler secret put` in production).

## Local test accounts

`npm run db:reset:local` loads four users (owner, admin, agent, viewer `@wacrm.test`). The password is in `d1/seed/dev.sql`. The viewer has a Supabase-style bcrypt hash on purpose.

## Tests

| Suite | What it proves |
|---|---|
| `src/lib/db/engine.test.ts` (21) | filters, `.or()`, ordering, count, single, embeds (to-one, to-many, nested, `!inner`, FK hints), bulk insert chunking + atomicity, upserts, error codes, injection rejection |
| `src/lib/db/policy.test.ts` (16) | tenant isolation, role tiers, secrets hidden from the browser, profiles/notifications/accounts rules, scoped upserts |
| `src/lib/db/rpc.test.ts` (10) | member/ownership/invitation RPCs, contact tag filter, AI reply cap, atomic broadcast creation, FTS search, caller restrictions |
| `src/middleware.test.ts` (7) | redirects, invite redirect, no login loop, protected paths, API 401 |
| End-to-end (manual, against `npm run preview`) | 31/31: sign-in for all roles incl. bcrypt, `/api/db` role matrix, cross-origin rejection, sign-up bootstrap, sign-out revocation, page redirects |

## Not done yet (later phases)

- Realtime Durable Object hub + presence (phase 5)
- Webhook → Queues, cron jobs (phases 4, 6). The webhook and engines already run on D1 through `serviceDb()`, but still inside `after()`
- R2 public media served at `/api/storage/...`; Meta needs an absolute HTTPS URL (`NEXT_PUBLIC_SITE_URL`) to fetch outbound media
- Email provider for password reset / email change (phase 8)
- Vectorize for semantic knowledge search
- `@supabase/supabase-js` and `@supabase/ssr` are no longer imported by app code; remove them from `package.json` once you're confident
