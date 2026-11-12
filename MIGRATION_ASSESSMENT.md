# Migration Assessment: wacrm → Cloudflare (OpenNext + Hono + Queues + D1 + R2 + Durable Objects)

- **Repository:** `wacrm/` (package `wacrm` v0.8.0, `package.json:3`)
- **Assessment date:** 2026-11-12
- **Method:** read-only static review (grep/find/cat/git log). Nothing was installed, built, run, or connected to.
- **Scope note:** every platform limit or price below is marked **VERIFY**. Cloudflare and OpenNext change often. Check each one against the current docs before relying on it.
- **Secrets:** env var **names** only. No values were printed.

---

## 1. Verdict and top 5 blockers

### Verdict: **GO WITH CHANGES**

The compute side moves cleanly: Next.js on OpenNext, a Hono worker, Queues, R2 and Cron. The app is almost entirely client-rendered, has no ISR and no server actions, already ships a chunked, resumable, idempotent broadcast queue (QStash), and already dedupes webhooks. The expensive, risky part is the data layer. The browser talks straight to Supabase in 37 client files, and RLS is the only authorization on that path. Postgres features are used heavily (pgvector, tsvector, 30 PL/pgSQL functions, aggregate triggers, a regexp-generated column, arrays, enums). Swapping to D1 means writing a full API layer and re-implementing the authorization that RLS gives today. That is most of the effort.

**Fallback if the data-layer rewrite is not funded, or production data turns out large (see §11 SQL):** keep Postgres (Supabase Postgres or Neon) behind **Hyperdrive**, and move only compute, storage and realtime to Cloudflare. That removes blockers #1, #3 and most of #2. The browser-to-Supabase calls and Supabase Auth would still have to be replaced if you want Supabase gone entirely.

**Required changes for GO:**
1. Build an authenticated API layer (Next route handlers or Hono) for every query the browser runs today. That is 149 `.from()` calls in 37 client files, plus browser-side `.rpc()`, storage, auth and realtime calls. Each endpoint needs explicit role and account checks that copy the RLS rules in §5.
2. Re-implement the DB-side logic (triggers, SECURITY DEFINER RPCs, generated columns) in application code or SQLite triggers. Replace pgvector with **Vectorize** and tsvector with **D1 FTS5** (VERIFY that D1 supports FTS5).
3. Move inbound webhook processing out of `after()` and into a Queue consumer.
4. Replace the in-memory rate limiter with a Durable Object or the Workers Rate Limiting binding.
5. Fix the security issues in §10 **before** migrating, so the behavior tests in §15 capture correct behavior.

### Top 5 blockers / highest-cost items

| # | Blocker | Evidence |
|---|---|---|
| 1 | **The browser queries the DB directly and RLS is its only authz.** 149 `supabase.from()` calls in 37 `'use client'` files (460 `.from()` calls repo-wide). D1 cannot be reached from a browser, so each call becomes an API endpoint with hand-written authz. | e.g. `src/hooks/use-broadcast-sending.ts` (19 calls), `src/components/contacts/contact-detail-view.tsx` (12), `src/app/(dashboard)/pipelines/page.tsx` (8); full list in §4.1 |
| 2 | **Postgres-only features with no D1 equivalent.** `vector(1536)` + `<=>` cosine search, `tsvector GENERATED` + GIN, a `regexp_replace` generated column, `text[]`/`uuid[]` arrays, a PG enum, dynamic-SQL PL/pgSQL. | `030_ai_knowledge.sql:46-47,94-98`; `022_contact_phone_dedup.sql` (generated col, `regexp_replace`); `017_account_sharing.sql:53`; `005_broadcast_counts_incremental.sql:36-44` |
| 3 | **Business logic lives in DB triggers and RPCs.** Broadcast counters (trigger), assignment notifications (trigger), signup bootstrap (trigger on `auth.users`), the privilege-column guard (trigger), invitations, member management, ownership transfer, dedupe merges. 30 `CREATE FUNCTION`s, 17 `CREATE TRIGGER`s. | §6.3; `017_account_sharing.sql:659-689`, `027_notifications.sql:56-116`, `018_account_member_rpcs.sql`, `019_invitation_rpcs.sql` |
| 4 | **Inbound webhook does all of its work inside `after()`**, with `maxDuration = 60`. That work is the DB writes, media mirroring (download plus upload of up to 16 MB), flow engine, automations (which can chain), AI auto-reply (an LLM call), and outbound webhooks (5 s timeout each), all run in order. On Workers, `waitUntil` work after the response is time-limited (**VERIFY**: 30 s), so as written this will drop work. | `src/app/api/whatsapp/webhook/route.ts:31,256-262,889,952-961,973,991,1044`; `src/lib/webhooks/deliver.ts:31` |
| 5 | **Auth swap and realtime rebuild.** Supabase Auth (bcrypt hashes in `auth.users`, cookies via `@supabase/ssr`, `onAuthStateChange`) and 7 `postgres_changes` subscriptions (unfiltered, scoped only by RLS). D1 has no change feed, so **every write path** that touches `messages`, `conversations`, `message_reactions`, `notifications` or `member_presence` must publish events to the Durable Object itself. | `src/middleware.ts:7-26`; `src/hooks/use-auth.tsx:325,357`; `src/hooks/use-realtime.ts:48-70`; §4.4 |

---

## 2. Scorecard (0 = rewrite from scratch, 10 = trivial)

| Area | Score | Reason |
|---|---|---|
| Next.js on OpenNext | **7** | Nearly all pages are client components. No ISR, `revalidate`, `unstable_cache`, server actions or `runtime` exports. Risks: Next **16.3.5** support (VERIFY), `next/og` in `src/app/icon.tsx`, `next/image`, `output: "standalone"`. |
| Database (Postgres → D1) | **3** | 38 tables, 46 migrations (348 KB of SQL), pgvector, tsvector, enum, arrays, 30 functions, 17 triggers, partial unique indexes, a regexp generated column, 26 `count: 'exact'` queries, 17+ PostgREST embedded-join selects. |
| Auth | **4** | Email/password only (simple). But: bcrypt hash import, cookie/session rebuild, `onAuthStateChange` client hook, global sign-out, a broken password-reset flow, and an `auth.users` trigger that bootstraps accounts. |
| Realtime | **4** | 7 `postgres_changes` subscriptions plus a presence heartbeat. No DB change feed on D1, so writers must publish. Needs one DO per account with hibernating WebSockets. |
| Storage | **7** | 3 public buckets (`avatars`, `flow-media`, `chat-media`) with simple path-based policies. Uploads go browser → Supabase directly and need presigned R2 URLs or an upload endpoint. |
| Background jobs / cron | **6** | QStash pass-based queue maps almost 1:1 to Cloudflare Queues. Two cron endpoints, externally triggered, map to Cron Triggers. The flows cron does an unbounded full scan. |
| WhatsApp webhook + sending | **6** | Signature verification, early ack, dedupe and recipient status ordering already exist. But processing sits in `after()`, the `messages` status update is unordered, and status updates are read-then-write (racy). |
| Dependency compatibility | **8** | No native or TCP drivers in app code. Uses `node:crypto` (HMAC, AES-GCM/CBC, timingSafeEqual) and `node:dns/promises` plus `node:net` (SSRF guard). These need `nodejs_compat` (VERIFY dns support). `sharp` is pulled in transitively by Next. |
| Security posture | **5** | Good: HMAC webhook check, AES-GCM-encrypted tokens, SSRF guard, hashed API keys and invite tokens. Bad: SECURITY DEFINER RPCs probably executable by `anon` (incl. a global contact merge), encrypted secrets readable by `viewer`, open signup, in-memory rate limiter, broken reset flow (§10). |

---

## 3. Project inventory

### 3.1 Versions and tooling

| Item | Value | Evidence |
|---|---|---|
| Next.js | `16.3.5` | `package.json:57` |
| React / React DOM | `19.2.4` | `package.json:60-61` |
| Node | `>=20.0.0`; CI and Docker use 20 | `package.json:30`, `.github/workflows/ci.yml` (`node-version: 20`), `Dockerfile` (`node:20-alpine`) |
| Package manager | npm `10.9.9` (`package-lock.json`) | `package.json:32` |
| Router | **App Router only** (`src/app/`). No `pages/` directory. | file tree |
| TypeScript | `^6` | `package.json` devDependencies |
| Tests | Vitest, **93 test files** | `find src -name '*.test.*'` |
| i18n | `next-intl` 4, locale fixed by env `NEXT_PUBLIC_APP_LOCALE` (en/es/ko/pt) | `src/i18n/request.ts:5-12`, `messages/*.json` |
| Current hosting | Vercel (per comments) / Docker standalone / Hostinger | `next.config.ts:70,104-110`; `Dockerfile`; `src/lib/whatsapp/broadcast-queue.ts` (`VERCEL_PROJECT_PRODUCTION_URL`) |
| Extra package | `mcp-server/` (standalone MCP client of the public API; deps `@modelcontextprotocol/sdk`, `zod`). It does **not** run in the web app. | `mcp-server/package.json` |
| Git | Latest commit `73ef19b`; the QStash queue was added recently (`a678ed3`) | `git log` |

### 3.2 Pages (29 `page.tsx` + layouts)

All pages are `'use client'` **except** `src/app/page.tsx` (server `redirect('/dashboard')`), `src/app/(dashboard)/pipeline/page.tsx` (re-exports the client pipelines page) and the layouts (`src/app/layout.tsx`, `(auth)/layout.tsx`, `(dashboard)/layout.tsx`, `join/layout.tsx`). These are static metadata wrappers.

Auth: `/login`, `/signup`, `/forgot-password`. Dashboard: `/agents`, `/automations`, `/automations/new`, `/automations/[id]/edit`, `/automations/[id]/logs`, `/broadcasts`, `/broadcasts/new`, `/broadcasts/[id]`, `/contacts`, `/dashboard`, `/flows`, `/flows/[id]`, `/flows/[id]/runs`, `/inbox`, `/leads`, `/notifications`, `/pipeline`, `/pipelines`, `/quick-replies`, `/reports`, `/settings`, `/templates`. Other: `/join/[token]`.

### 3.3 Route handlers (66) and middleware

- `src/app/api/**/route.ts`: 65 handlers. `src/app/r/[token]/route.ts`: the URL-click redirect tracker.
- Middleware: `src/middleware.ts` (Supabase session refresh + redirects). No `runtime` export, so it runs on the **edge** runtime (Next default for `middleware.ts`). Next 16 deprecates `middleware.ts` in favour of `proxy.ts`, which is **Node-runtime only** (VERIFY). Renaming it would create a Node middleware, which OpenNext Cloudflare does not support (VERIFY).
- **Server actions: none.** No `'use server'` anywhere (0 matches).
- Full per-route classification is in §8.2.

### 3.4 Rendering modes

| Feature | Found? | Evidence |
|---|---|---|
| SSR of data | **No.** Data is fetched in the browser via supabase-js. | 30 of 33 page/layout/shell files start with `'use client'` |
| SSG / `generateStaticParams` | No | 0 matches |
| ISR / `revalidate` / `revalidatePath/Tag` | No | 0 matches |
| `unstable_cache` / `'use cache'` / PPR | No | 0 matches |
| `export const runtime` | No | 0 matches |
| Streaming | Only `<Suspense fallback={null}>` wrappers for `useSearchParams` | `login/page.tsx:27`, `signup/page.tsx:24`, `automations/new/page.tsx:19`, `inbox/page.tsx:29`, `settings/page.tsx:35` |
| `after()` | **Yes**, in the webhook | `src/app/api/whatsapp/webhook/route.ts:256` |
| `maxDuration` | 60 (webhook, v1 broadcasts), 300 (queue worker, resume) | webhook `:31`; `api/queue/broadcast/route.ts:30`; `api/whatsapp/broadcast/[id]/resume/route.ts`; `api/v1/broadcasts/route.ts` |

### 3.5 `next.config.ts`

- `output: "standalone"` (`:70`). This is for Docker. OpenNext does its own build, so drop or ignore it (VERIFY).
- `allowedDevOrigins` (`:87-98`). Dev only.
- `headers()` (`:137-161`): `/api/*` no-store; **all other paths `public, s-maxage=300, stale-while-revalidate=86400`** (`:144-150`). This was a Hostinger CDN workaround. On Cloudflare, make sure no cache rule stores per-user responses, especially middleware redirects to `/login` or `/dashboard`. Remove this rule when you move.
- Security headers, with CSP in **Report-Only** mode (`:22-64`). `connect-src`/`media-src` hard-code `*.supabase.co` (`:54,58`) and must be updated to the new origins (R2 public domain, DO WebSocket host).
- `next-intl` plugin wrapper (`:4,164`).
- No custom server, no `images` config, no rewrites or redirects.

### 3.6 Fonts, images, OG

- `next/font/google` (`Inter`). Downloaded at build time, so it is fine on OpenNext (`src/app/layout.tsx:4`).
- `next/image` used **once**, with a static local import (`src/components/layout/sidebar.tsx:5,234-238`). No remote images. Set `unoptimized` or configure the Cloudflare Images loader (VERIFY OpenNext image support and cost).
- `next/og` `ImageResponse` in `src/app/icon.tsx:1,19`. On Workers this pulls in satori/resvg WASM, which adds bundle size and CPU. **Recommend replacing it with a static `icon.png`.** VERIFY OpenNext `next/og` support.

### 3.7 OpenNext risk summary (VERIFY all against current OpenNext Cloudflare docs)

| Feature | Status here | Risk |
|---|---|---|
| Next 16.3.5 support | Required | **Medium.** Confirm `@opennextjs/cloudflare` supports this exact minor. |
| Edge middleware | Used (`src/middleware.ts`) | Low today. High if renamed to `proxy.ts` (Node). |
| Node middleware | Not used | n/a |
| ISR / data cache bindings (R2/KV incremental cache, DO queue, D1 tag cache) | **Not needed.** No ISR or caching. | Low. A minimal "dummy" cache config is enough (VERIFY). |
| `after()` | Webhook | **High.** Maps to `ctx.waitUntil`, which is time-limited (VERIFY). Move the work to a Queue. |
| Image optimization | One static image | Low |
| `next/og` | `icon.tsx` | Medium (bundle) |
| `maxDuration` 300 routes | queue worker, resume | **High.** Ignored on Workers. These belong in the Hono/Queue worker. |
| Alternative adapter | `vinext` (Cloudflare's Vite-based Next re-implementation) | Evaluate only if OpenNext lags on Next 16. VERIFY maturity. |

---

## 4. Supabase usage map

### 4.1 `supabase.from(...)` by table (460 calls total, excluding tests)

| Table | Calls | Where it runs (main locations) |
|---|---|---|
| contacts | 50 | client: contacts page, contact-detail-view, contact-form, import-modal, broadcast wizard steps 2–3, use-broadcast-sending; server: webhook, v1 API, engines |
| conversations | 41 | client: inbox page, conversation-list, message-thread, contact-sidebar, use-total-unread; server: webhook, send, v1 API, engines, dashboard queries |
| whatsapp_config | 30 | client: `settings/whatsapp-config.tsx:152` (`select('*')`), settings-overview, inbox page; server: config route, webhook, all send/template routes |
| broadcasts | 23 | client: broadcasts pages, use-broadcast-sending; server: broadcast core, queue, resume, v1 |
| messages | 23 | client: message-thread, use-browser-notifications; server: webhook, send-message, dashboard queries |
| broadcast_recipients | 21 | client: broadcast `[id]` page, use-broadcast-sending (bulk insert, 200/batch, `:111,631`); server: queue, resume, webhook |
| message_templates | 22 | client: template-manager, template-picker, step1; server: templates sync/submit/[id] |
| profiles | 19 | client: use-auth, profile-form, pipelines; server: account helpers, engines |
| flows / flow_nodes / flow_runs / flow_run_events | 17 / 9 / 16 / 5 | mostly server (flow routes, engine, cron); client: flows pages |
| contact_tags | 17 | client: contacts page, contact detail, import, broadcast audience; server: tag-write, engines |
| tags | 14 | client: tag-manager, contacts, import; server |
| custom_fields / contact_custom_values | 12 / 11 | client: custom-fields-manager, contact-form, contact detail, step3 |
| automations / automation_steps / automation_logs / automation_pending_executions | 13 / 6 / 6 / 4 | client: automation-builder, automations pages; server: engine, cron |
| pipelines / pipeline_stages / deals | 7 / 10 / 14 | client: pipelines page, deal-form, pipeline-settings, deals-settings; server: dashboard queries |
| ai_configs / ai_knowledge_documents / ai_knowledge_chunks / ai_usage_log | 8 / 6 / 3 / 2 | server only (`api/ai/*`, `lib/ai/*`) |
| webhook_endpoints | 7 | server (`api/v1/webhooks*`, `lib/webhooks/*`) |
| accounts / account_invitations | 7 / 3 | server (`lib/auth/account.ts`, account routes) |
| api_keys | 5 | server (`lib/api-keys/store.ts`, account routes) |
| notifications | 4 | client: notifications page, use-unread-notifications |
| quick_replies | 4 | server (quick-replies routes) |
| message_reactions | 5 | client: message-thread; server: webhook (`:637-647` upsert), react route |
| broadcast_url_tokens / broadcast_button_clicks | 4 / 4 | client: use-broadcast-sending (token inserts `:578-579`); server: `r/[token]`, button tracking |
| contact_notes | 5 | client: contact detail |
| member_presence | 1 | client: `src/hooks/use-presence.ts:117` |
| `storage.from('avatars')` | 2 | client: `settings/profile-form.tsx:125-137` |

**37 client files run 149 queries directly against the DB with the anon key and the user JWT:** `automations/page.tsx`(1), `automations/[id]/logs/page.tsx`(2), `broadcasts/new/page.tsx`(1), `broadcasts/page.tsx`(4), `broadcasts/[id]/page.tsx`(4), `contacts/page.tsx`(6), `inbox/page.tsx`(3), `leads/page.tsx`(5), `notifications/page.tsx`(3), `pipelines/page.tsx`(8), `automation-builder.tsx`(5), `step1-choose-template.tsx`(1), `step2-select-audience.tsx`(6), `step3-personalize.tsx`(3), `step4-schedule-send.tsx`(2), `contact-detail-view.tsx`(12), `contact-form.tsx`(7), `custom-fields-manager.tsx`(5), `import-modal.tsx`(4), `contact-sidebar.tsx`(4), `conversation-list.tsx`(2), `message-thread.tsx`(6), `template-picker.tsx`(1), `deal-form.tsx`(7), `pipeline-settings.tsx`(6), `deals-settings.tsx`(1), `profile-form.tsx`(3), `settings-overview.tsx`(5), `tag-manager.tsx`(3), `template-manager.tsx`(2), `whatsapp-config.tsx`(2), `use-auth.tsx`(2), `use-broadcast-sending.ts`(19), `use-browser-notifications.ts`(1), `use-presence.ts`(1), `use-total-unread.ts`(1), `use-unread-notifications.ts`(1).

PostgREST-specific query builder features used (all must become SQL): `.or()` 13, `.in()` 22, `count: 'exact'` 26, embedded-resource selects `select('…, rel(…)')` ≥17, `.upsert()` 8, `.ilike()` 2, `.contains()` on a `text[]` 1 (`src/lib/webhooks/deliver.ts:58`), `.range()` 1.

**Edge functions / server components / server actions: none run queries.** All server-side DB access is in route handlers and `src/lib/**`.

### 4.2 `supabase.rpc(...)` (14 call sites)

| RPC | Called from | Function (migration) | Notes |
|---|---|---|---|
| `filter_contacts_by_tags` | **client** `contacts/page.tsx:141` | `025` (INVOKER, ILIKE search, uuid[]) | rewrite as SQL in an API |
| `touch_presence` | **client** `presence-heartbeat.tsx:59` (every 30 s, `lib/presence.ts:16`) | `024` (DEFINER, upsert) | becomes a DO message; don't write it to D1 |
| `set_member_role` / `remove_account_member` / `transfer_account_ownership` | `api/account/members/[userId]/route.ts:84,112`, `api/account/transfer-ownership/route.ts:84` | `018` (DEFINER, multi-statement, role rules) | port to a D1 `batch()` transaction |
| `peek_invitation` / `redeem_invitation` | `api/invitations/[token]/peek/route.ts:72`, `redeem/route.ts:84` | `019` (DEFINER, `FOR UPDATE` row lock) | port; D1 has no `FOR UPDATE`, so use a conditional UPDATE |
| `match_ai_knowledge_semantic` / `match_ai_knowledge_fts` | `src/lib/ai/knowledge.ts:115,132` | `030`/`032` (pgvector `<=>`, `ts_rank`) | Vectorize + FTS5 |
| `increment_automation_execution_count` / `increment_flow_execution_count` | `lib/automations/engine.ts:225`, `lib/flows/engine.ts:1198` | `007`/`012` | single `UPDATE … SET n = n + 1` |
| `get_flow_node_leads` | `lib/flows/node-leads.ts:114,352` | `043` (INVOKER, aggregation + ILIKE) | SQL port |
| `record_webhook_failure` | `lib/webhooks/deliver.ts:151` | `028` (DEFINER) | SQL port |

Also defined but called only from triggers/migrations: `create_broadcast_with_recipients` (037/038/041; `unnest` arrays; **service_role only**, apparently used by `broadcast-core.ts` server path, VERIFY), `bump_conversation_on_inbound` (037), `claim_ai_reply_slot` (029), `merge_duplicate_contacts` (022), `merge_duplicate_conversations` (036), `recompute_broadcast_counts`, `_bcast_bump`, `_bcast_cols_for_status` (005), `get_broadcast_button_analytics` (044), `is_account_member` (017).

### 4.3 Auth

| Aspect | Finding | Evidence |
|---|---|---|
| Sign-in methods | **Email + password only.** No OAuth, magic link, OTP or MFA in code. | `login/page.tsx:52` `signInWithPassword`; `signup/page.tsx:73` `signUp` (with `full_name` metadata) |
| Email confirmation required? | UNKNOWN - needs manual check (Supabase dashboard setting, not in repo; `supabase/config.toml` says auth settings are dashboard-only) | `supabase/config.toml` header comment |
| Password reset | `resetPasswordForEmail` redirects to `/auth/callback?next=/reset-password`. **Neither route exists in `src/app`**, so the flow is broken as written. | `forgot-password/page.tsx:32-34`; file tree |
| Password change | Re-auths with `signInWithPassword`, then `updateUser` | `settings/password-form.tsx:56,65` |
| Email/profile change | `auth.updateUser` | `settings/profile-form.tsx:162` |
| Sign-out | `signOut({ scope: 'global' })` (all sessions) | `settings/sessions-card.tsx:38`, `use-auth.tsx:385`, `join/[token]/page.tsx:195` |
| Session handling | `@supabase/ssr` cookie client in middleware (refresh + cookie copy) and server; browser singleton | `src/middleware.ts:7-43`, `src/lib/supabase/server.ts`, `src/lib/supabase/client.ts` |
| Client session reads | `auth.getSession()` in 11 client places, passing the bearer token to API calls | e.g. `use-broadcast-sending.ts:317,451`, `inbox/page.tsx:181`, `pipelines/page.tsx:115,257` |
| Middleware auth | Redirects unauthenticated users to `/login` for a fixed path list. That list **omits** `/agents`, `/flows`, `/quick-replies` and `/notifications`. Returns 401 only for `/api/whatsapp/*` (not webhook). | `src/middleware.ts:73-86` |
| Roles | App-level `account_role` enum `owner/admin/agent/viewer` on `profiles`, enforced by RLS (`is_account_member(account_id, min_role)`) and by `requireRole()` in routes | `017_account_sharing.sql:53,122,136-166`; `src/lib/auth/account.ts:106-189`; `src/lib/auth/roles.ts` |
| User metadata | `raw_user_meta_data->>'full_name'`, read by the signup trigger | `017_account_sharing.sql:659-689` |
| Signup bootstrap | Trigger `on_auth_user_created` creates an `accounts` row and an `owner` profile **for every new signup** | `017_account_sharing.sql:659-689` |
| Admin API (`auth.admin.*`) | **Not used** (0 matches) | grep |
| Service role | Used server-side only, in 22 files via 5 duplicate lazy clients | `lib/ai/admin-client.ts`, `lib/automations/admin-client.ts`, `lib/flows/admin-client.ts`, `api/whatsapp/webhook/route.ts:36-44`, `r/[token]/route.ts`; importers listed in §4.8 |
| API keys (public v1 API) | Custom: SHA-256-hashed `wacrm_live_…` keys with scopes | `026_api_keys.sql`; `src/lib/api-keys/keys.ts`; `src/lib/auth/api-context.ts:80` |

### 4.4 Realtime

Publication tables: `messages`, `conversations` (`001:413,420`), `message_reactions` (`009:112`), `flow_runs` (`010:278`, **no subscriber found**), `member_presence` (`024:99`), `notifications` (`027:129`).

| Subscription | Tables / events | Filter | UI feature | Evidence |
|---|---|---|---|---|
| `useRealtime` | `messages *`, `conversations *` | **none** (RLS only) | live inbox list and thread | `src/hooks/use-realtime.ts:48-70`; used by `inbox/page.tsx:344` |
| `reactions:${conversationId}` | `message_reactions` INSERT/UPDATE/DELETE | per conversation (VERIFY filter) | emoji reactions | `src/components/inbox/message-thread.tsx:367-428` |
| `total-unread-realtime` | `conversations *` | none | sidebar unread badge | `src/hooks/use-total-unread.ts:46-69` |
| `browser-notifications` | `messages INSERT` | none | desktop notifications | `src/hooks/use-browser-notifications.ts:123-148` |
| `notifications-unread-count` | `notifications *` | none | bell badge | `src/hooks/use-unread-notifications.ts:34-58` |
| `notifications-page` | `notifications *` | none | notifications page | `src/app/(dashboard)/notifications/page.tsx:57-86` |
| `presence:${accountId}` | `member_presence *` | account | online dots (inbox assign, members tab) | `src/hooks/use-presence.ts:84-153`; heartbeat 30 s, idle at 5 min (`src/lib/presence.ts:16,26`) |

No Supabase **broadcast** or **presence** channel features are used. "Presence" is a table plus a heartbeat RPC.

### 4.5 Storage

| Bucket | Public | Limit | Used for | Evidence |
|---|---|---|---|---|
| `avatars` | **yes** | 2 MB, images | profile avatar (browser upload) | `008_profile_avatars_storage.sql:15-27`; `profile-form.tsx:125-137` |
| `flow-media` | **yes** | 16 MB, image/video/pdf/… | flow node media | `016_flow_media.sql:57-69`; `020` policies |
| `chat-media` | **yes** | 16 MB | outbound composer media (browser upload) **and mirrored inbound customer media** | `023_chat_media.sql:38-50`; `039_inbound_media_mirror.sql:83-95`; `src/lib/storage/upload-media.ts:121-150`; `src/lib/whatsapp/mirror-inbound-media.ts:213-231` |

- All reads use `getPublicUrl` (permanent public URLs). **No signed URLs** anywhere (0 `createSignedUrl` matches).
- **Inbound customer media sits in a public bucket.** Anyone with the URL can fetch it. Path entropy is UNKNOWN - needs manual check (`mirror-inbound-media.ts` path construction).
- Write policies are scoped by account-member path prefix (`023`, `020`).

### 4.6 Edge Functions

**None.** There is no `supabase/functions/` directory and no `functions.invoke` calls.

### 4.7 pg_cron, triggers, database webhooks

- **pg_cron: none in migrations.** Scheduling is external: a scheduler hits `GET /api/automations/cron` and `GET /api/flows/cron` with header `x-cron-secret` (`docs/docker.md:71-76`). Which scheduler production uses is UNKNOWN - needs manual check. `.env.local` has no `AUTOMATION_CRON_SECRET` name, so locally both endpoints return 503.
- **Triggers (17):** `set_updated_at` on 10 tables; `on_auth_user_created` (auth.users); `broadcast_recipients_aggregate` (`003:82`, logic in `005`); `on_conversation_assigned` → inserts a notification (`027:56-116`); `ai_configs_updated_at`; `ai_knowledge_documents_updated_at`; `enforce_profile_privilege_columns` (`034:58-81`).
- **Database webhooks (pg_net / supabase_functions.hooks): none in migrations.** Dashboard-configured hooks are UNKNOWN - needs manual check (SQL in §11).

### 4.8 Service-role usage in client-reachable code

**No service-role key in client bundles.** `SUPABASE_SERVICE_ROLE_KEY` has no `NEXT_PUBLIC_` prefix and is referenced only in server files: `src/lib/{ai,automations,flows}/admin-client.ts`, `src/app/api/whatsapp/webhook/route.ts`, `src/app/api/whatsapp/config/route.ts`, `src/app/r/[token]/route.ts`. Route handlers that use the admin client **after** a `requireRole()` check include: automations (3), flows (3), quick-replies (2), broadcast queue/resume, AI draft. With the service role, the explicit `account_id` filters in those handlers are the **only** tenancy guard. Review each before porting.

---

## 5. RLS analysis

**Model:** every business table has an `account_id`. A user belongs to exactly one account via `profiles.account_id` + `account_role`. Policies call `is_account_member(account_id, min_role)` (`017_account_sharing.sql:136-166`, SECURITY DEFINER, role rank owner 4 > admin 3 > agent 2 > viewer 1). This is not "authenticated sees everything": it enforces account scoping plus **role tiers**. It does **not** enforce ownership or assignment inside an account.

### 5.1 Policies (final state after all migrations)

| Table(s) | SELECT | INSERT/UPDATE/DELETE | Source |
|---|---|---|---|
| contacts, contact_notes, conversations, deals, broadcasts, automations, flows | member (viewer+) | **agent+** | `017` |
| tags, custom_fields, whatsapp_config, message_templates, pipelines | member | **admin+** | `017` |
| contact_tags, contact_custom_values | via parent contact: member | via parent contact: agent+ | `017` |
| messages | via conversation: member | via conversation: agent+ | `017` (replaces `001:185` `WITH CHECK (true)`) |
| pipeline_stages | via pipeline: member | via pipeline: **admin+** | `017` |
| broadcast_recipients | via broadcast: member | via broadcast: agent+ | `017` |
| automation_steps, flow_nodes | via parent: member | via parent: agent+ | `017` |
| automation_logs, flow_runs, flow_run_events | member | **none** (service role only) | `017` |
| message_reactions | via message→conversation: member | agent+ | `017` |
| profiles | self OR same-account member | UPDATE/INSERT self only; trigger blocks changing `account_role`/`account_id` | `017`, `034:58-81` |
| accounts | member | UPDATE admin+ | `017` |
| account_invitations | admin+ | admin+ | `017` |
| member_presence | member | none (via `touch_presence` RPC) | `024` |
| api_keys, webhook_endpoints, ai_configs, ai_knowledge_documents/chunks | member | admin+ | `026`, `028`, `029`, `030`/`032` |
| ai_usage_log | **admin+** | none | `033` |
| notifications | `user_id = auth.uid()` (per user) | UPDATE limited to column `read_at` (`027:50-51`) | `027` |
| quick_replies | member | (see `035:20-26`) | `035` |
| broadcast_button_clicks, broadcast_url_tokens | member | agent+ insert/delete | `044:51-56`, `045:48-56` |
| storage.objects (3 buckets) | public read | member path-prefix writes | `008`, `016`, `020`, `023` |

### 5.2 In-client role / ownership rules that must become explicit checks

1. **Viewer is read-only. Agent can write CRM data (contacts, conversations, messages, deals, broadcasts, automations, flows). Admin+ manages config** (tags, custom fields, pipelines and stages, templates, WhatsApp config, API keys, webhooks, AI). Every one of these needs an explicit `requireRole()` in the new API.
2. **Notifications are per-user** (`user_id = auth.uid()`), not per-account.
3. **Profile privilege columns** (`account_role`, `account_id`) are trigger-protected (`034`). The new API must never accept them on profile update.
4. **AI usage is admin-only to read** (`033`).
5. **No "agent sees only assigned conversations" rule exists.** `conversations.assigned_agent_id` (`001:145`) and `deals.assigned_to` (`002:2`) are informational only. **No soft-delete columns or filters exist.** No team or department visibility.

### 5.3 Code that relies on RLS as its only authorization

- **All 149 client-side queries in §4.1, plus `filter_contacts_by_tags` and `touch_presence`.** The browser filters by whatever it wants, and only RLS stops cross-account or under-privileged writes. Example: a `viewer` UI hides buttons (`src/components/auth/require-role.tsx`, `src/hooks/use-can.ts`), but the real enforcement is RLS.
- Route handlers that check `auth.getUser()` only, with **no `requireRole`**, and then use the user-scoped client. Here RLS supplies both the account scoping and the role check:
  `api/flows/[id]/nodes/[nodeId]/leads/route.ts`, `…/leads/export/route.ts`, `api/flows/[id]/runs/route.ts`, `api/flows/templates/route.ts`, `api/whatsapp/templates/[id]/route.ts` (PATCH/DELETE → RLS admin+), `api/whatsapp/media/[mediaId]/route.ts`, `api/whatsapp/config/verify-registration/route.ts`, `api/whatsapp/config/route.ts` (mixes `getCurrentAccount` and the admin client).
- Realtime subscriptions are unfiltered (§4.4). RLS on `postgres_changes` is the only thing preventing cross-account leakage. The DO design must scope rooms by `account_id`, and per user for notifications.

---

## 6. Database compatibility (Postgres → D1/SQLite)

### 6.1 Global risky items

| Item | Where | D1 / SQLite handling |
|---|---|---|
| `uuid` PKs, `uuid_generate_v4()` / `gen_random_uuid()` | every table (`001:8` uuid-ossp) | `TEXT` PK; generate with `crypto.randomUUID()` in app. Keep IDs as-is when migrating. |
| `timestamptz DEFAULT NOW()` | every table | `TEXT` ISO-8601 UTC (keeps lexical sort) or `INTEGER` epoch ms. Choose one and enforce it everywhere. |
| `jsonb` | custom_fields.field_options, message_templates.buttons/sample_values, broadcasts.template_variables/audience_filter, broadcast_recipients.template_params/message_params, automations.trigger_config, automation_steps.step_config, automation_logs.steps_executed, automation_pending_executions.context, flows.trigger_config/fallback_policy, flow_nodes.config, flow_runs.vars, flow_run_events.payload, messages.interactive_payload, quick_replies.interactive_payload | `TEXT` + SQLite JSON1 (`json_extract`) (VERIFY that D1 enables JSON1). Code does not use `->>` filters through PostgREST (0 matches). `jsonb_array_length` appears in a CHECK (`014:83`). |
| Arrays `text[]`, `uuid[]`, `jsonb[]` | `profiles.beta_features` (`011`), `api_keys.scopes` (`026`), `webhook_endpoints.events` (`028`, queried with `.contains`, `deliver.ts:58`); RPC params `uuid[]`/`jsonb[]` (`025`, `037`, `038`, `041`) | JSON text arrays + `json_each`, or a junction table for `events`. |
| Enum `account_role_enum` | `017:53`, used in `profiles`, `account_invitations` | `TEXT CHECK (role IN (...))` |
| `NUMERIC(12,2)` | `deals.value` (`001:275`) | `INTEGER` minor units (cents), or REAL (lossy). **Recommend cents.** |
| `DATE` | `deals.expected_close_date` | `TEXT` `YYYY-MM-DD` |
| Generated column with `regexp_replace` | `contacts.phone_normalized` (`022`) | SQLite has no `regexp_replace`. Compute in app, or use a generated column with nested `replace()` for known chars. A unique partial index depends on it. |
| `tsvector GENERATED` + GIN, `to_tsvector('simple')`, `ts_rank` | `ai_knowledge_chunks.fts` (`030:46,54`) | D1 **FTS5** virtual table + sync triggers (VERIFY FTS5 on D1). |
| `vector(1536)` + ivfflat/hnsw index + `<=>` | `ai_knowledge_chunks.embedding` (`030:47,56,94-98`) | **Cloudflare Vectorize** index (1536 dims, cosine) keyed by chunk id. D1 cannot store or search vectors efficiently. |
| `ILIKE` | `025` (search), `043` (search), `.ilike()` ×2 in code | `LIKE` (ASCII case-insensitive by default in SQLite), or `lower(col) LIKE lower(?)`. Non-ASCII (e.g. Korean/Portuguese names) case-folding differs. |
| Window functions | `037:3` (`row_number() OVER`, one-off dedupe at migration time) | SQLite supports window functions, but this is a migration-time cleanup and does not need porting. |
| CTEs with DML (`WITH … UPDATE/INSERT … RETURNING`) | `029:118-140` claim_ai_reply_slot, `037` create_broadcast_with_recipients | Rewrite as `UPDATE … WHERE ai_reply_count < ? RETURNING id` (SQLite 3.35+ RETURNING, VERIFY on D1). |
| `COUNT(*) FILTER (WHERE …)` | `005:107-130` | `SUM(CASE WHEN … THEN 1 ELSE 0 END)` |
| `SELECT … FOR UPDATE` | `019` redeem_invitation | No row locks in D1. Use a conditional `UPDATE … WHERE accepted_at IS NULL RETURNING`. |
| `GREATEST(...)` | `005:39` | `MAX(a,b)` scalar |
| Dynamic SQL (`EXECUTE format(...)`) | `005:36-44` (`_bcast_bump`), `017` backfill loop | Not available. Rewrite in app. |
| PL/pgSQL stored functions (30) / SECURITY DEFINER | §4.2 | **All move to TypeScript** in the API/Hono layer, wrapped in D1 `batch()` for atomicity (VERIFY: D1 `batch()` is the transaction primitive; no interactive `BEGIN`/`SAVEPOINT`). |
| Multi-statement transactions | `018`, `019`, `022`, `036`, `037/038/041` RPCs | D1 `batch()` (all-or-nothing). Cannot read-then-branch inside one transaction, so restructure as guarded statements. |
| LATERAL joins, materialized views, views | **none found** | n/a |
| FK cascades: `ON DELETE CASCADE` / `SET NULL` / `RESTRICT` | extensive (`001`, `004`, `006`, `010`, `017`, …) | SQLite supports them, but enforcement depends on `PRAGMA foreign_keys` (VERIFY D1 default: reportedly ON). Large cascades (deleting an account) are expensive single statements. Watch D1 statement limits. |
| References to `auth.users(id)` | ~20 FK columns | Point them at the new `users` table, or drop the FK. |
| Partial indexes (`WHERE …`) | `003` (wamid unique where not null), `006`, `015`, `017` (one active flow run), `022`, `040`, account_invitations pending | SQLite supports partial indexes. |
| Realtime publication | §4.4 | n/a (replaced by DO) |
| Bulk inserts | browser inserts recipients 200/batch (`use-broadcast-sending.ts:111,631`), url tokens 200/batch (`:578`), contacts 50/batch (`import-modal.tsx:281`); RPC `unnest(p_contact_ids)` | **D1 limits bound parameters per statement (VERIFY: 100).** A 7-column recipient row allows only ~14 rows per statement. Use `batch()` of prepared statements, or multi-row VALUES sized under the limit. |
| Loops over many rows | `flows/cron/route.ts:56-77` loads **all** active flow runs, unbounded; `automations/cron/route.ts:40-46` 50 per call, sequential | Paginate and push to a Queue. |

### 6.2 Tables (38), with rating

Index counts = explicit `CREATE INDEX` statements (PK and inline UNIQUE constraints add more). Each index adds D1 rows-written cost per write (VERIFY billing semantics).

| Table | Key columns / notable types | Idx | Rating | Reason |
|---|---|---|---|---|
| profiles | uuid, user_id→auth.users, account_id, `account_role` enum, `beta_features text[]` | 1 (+UNIQUE user_id) | MODERATE | enum, array, privilege trigger, auth FK |
| accounts | owner_user_id RESTRICT, default_currency | 1 unique | EASY | |
| account_invitations | token_hash UNIQUE, role enum, expires_at | 1 partial | MODERATE | redeem RPC uses `FOR UPDATE` |
| contacts | phone, **`phone_normalized` GENERATED regexp**, wa_user_id, wa_parent_user_id, wa_username | 5 (2 partial unique) | **HARD** | regexp generated column drives the dedupe unique index; merge RPC |
| tags | name, color | 1 | EASY | |
| contact_tags | contact_id, tag_id UNIQUE pair | 2 | EASY | |
| custom_fields | field_options jsonb | 1 | EASY | |
| contact_custom_values | value text, UNIQUE pair | 0 (+UNIQUE) | EASY | |
| contact_notes | note_text | 1 | EASY | |
| conversations | status CHECK, assigned_agent_id, unread_count, ai_* columns, last_message_at | 4 (incl. unique account+contact, `036`) | MODERATE | atomic unread bump RPC, assignment-notification trigger, merge RPC, hot realtime table |
| messages | content_type/status CHECKs, message_id (wamid), reply_to, interactive_payload jsonb, error_*, ai_generated, media_type | 4 (+unique conversation_id,message_id `037:14`) | MODERATE | largest table (likely); dedupe upsert; status ordering |
| message_reactions | UNIQUE(message_id, actor_type, actor_id) (upsert target) | 2 | EASY | |
| whatsapp_config | access_token / verify_token (encrypted text), phone_number_id UNIQUE, registration columns, mirror flag | 2 | EASY | |
| message_templates | buttons/sample_values jsonb, CHECK with `jsonb_array_length` | 3 (unique name+language) | MODERATE | CHECK rewrite |
| pipelines | | 1 | EASY | |
| pipeline_stages | position | 1 | EASY | |
| deals | **NUMERIC(12,2)**, DATE, assigned_to→profiles | 4 | MODERATE | money type |
| broadcasts | counts ×6, jsonb ×2, delivery_locked_at, delivery_queued_at | 1 | MODERATE | counters owned by trigger |
| broadcast_recipients | status ladder, whatsapp_message_id (partial unique), template_params/message_params jsonb | 4 | **HARD** | aggregate trigger (dynamic SQL), highest write volume, bulk insert |
| automations | trigger_config jsonb, partial active index | 4 | EASY | |
| automation_steps | self-FK cascade, step_config jsonb | 2 | EASY | |
| automation_logs | steps_executed jsonb (appended repeatedly) | 3 | MODERATE | read-modify-write JSON appends |
| automation_pending_executions | run_at, status, context jsonb | 2 | EASY | becomes a Queue with delay / DO alarm |
| flows | trigger_config/fallback_policy jsonb | 3 | EASY | |
| flow_nodes | config jsonb | 1 | EASY | |
| flow_runs | vars jsonb, **partial unique one-active-run** | 6 | MODERATE | 6 indexes = write amplification |
| flow_run_events | payload jsonb | 3 | EASY | append-only, may grow large |
| member_presence | status, last_seen_at | 1 | EASY | **recommend: move out of D1 into the DO** |
| api_keys | `scopes text[]` | 2 | EASY | array |
| notifications | read_at, column-level grant | 2 | MODERATE | trigger-created, per-user authz |
| webhook_endpoints | `events text[]` (queried with `@>`), encrypted secret | 1 | MODERATE | array containment query |
| ai_configs | encrypted api_key, embeddings_api_key | 0 (+UNIQUE account) | EASY | |
| ai_knowledge_documents | content | 1 | EASY | |
| ai_knowledge_chunks | **tsvector GENERATED + GIN, vector(1536) + ANN index** | 4 | **HARD** | needs Vectorize + FTS5 |
| ai_usage_log | token counts | 1 | EASY | |
| quick_replies | interactive_payload jsonb | 1 | EASY | |
| broadcast_button_clicks | inbound_message_id unique | 3 | EASY | |
| broadcast_url_tokens | token UNIQUE (+duplicate unique index `045:13`) | 3 | EASY | drop the redundant index |

### 6.3 Postgres → SQLite type mapping (types this project uses)

| Postgres | SQLite / D1 | Notes |
|---|---|---|
| `UUID` | `TEXT` | 36-char string; keep existing values |
| `TEXT` | `TEXT` | |
| `INTEGER` / `INT` | `INTEGER` | |
| `BIGINT` (RPC return counts only) | `INTEGER` | JS number safe < 2^53 |
| `BOOLEAN` | `INTEGER` 0/1 | map in code; D1 returns numbers |
| `TIMESTAMPTZ` | `TEXT` ISO-8601 `Z` (or `INTEGER` ms) | `NOW()` → `strftime('%Y-%m-%dT%H:%M:%fZ','now')` or app-side |
| `DATE` | `TEXT` | |
| `NUMERIC(12,2)` | `INTEGER` (cents) | |
| `JSONB` | `TEXT` (JSON) | JSON1 functions |
| `TEXT[]` / `UUID[]` | `TEXT` (JSON array) or junction table | |
| `account_role_enum` | `TEXT CHECK(...)` | |
| `tsvector` | FTS5 virtual table | VERIFY |
| `vector(1536)` | Vectorize | external index |
| `REAL` (rank/distance return values) | `REAL` | |

---

## 7. WhatsApp / Meta logic review

### 7.1 Webhook handler (`src/app/api/whatsapp/webhook/route.ts`, 1457 lines)

| Check | Result | Evidence |
|---|---|---|
| GET verify | Decrypts **every** `whatsapp_config.verify_token` and compares in a loop (fine for single-tenant). Opportunistically upgrades CBC→GCM. | `:139-219` |
| X-Hub-Signature-256 | **Yes.** HMAC-SHA256 over the raw body, `timingSafeEqual`, supports comma-separated rotated secrets, rejects if `META_APP_SECRET` is unset. | `:225-232`; `src/lib/whatsapp/webhook-signature.ts:34-80` |
| Reply before processing | **Yes.** `after()` then `200 {status:'received'}`. But all processing (sequential, with LLM, media and outbound webhook calls) runs in `after()` with `maxDuration = 60`. | `:31,256-264` |
| Dedupe by message ID | **Yes, for inbound messages.** `upsert … onConflict 'conversation_id,message_id' ignoreDuplicates`, early return before side effects. Unique index from `037:14`. | `:787-831` |
| Dedupe before media mirroring | **No.** `parseMessageContent` (which mirrors media, `:1044`) runs before the idempotent insert, so Meta retries re-download and re-upload media. VERIFY ordering at `:654-790`. | `:1000-1050`, `:787` |
| Out-of-order statuses: `broadcast_recipients` | **Guarded.** Forward-only ladder pending→sent→delivered→read→replied; `failed` only from pending/sent. But it is **read-then-write (not atomic)**, so two concurrent status webhooks can race. | `:379-410,470-503` |
| Out-of-order statuses: `messages` | **NOT guarded.** `update({status}).eq('message_id', id)` unconditionally, so a late `sent` can overwrite `read`, and `failed` can overwrite `delivered`. It also matches all rows with that wamid across accounts. | `:443-456` |
| Status batches | `value.statuses` processed one by one, sequentially | `:296-297` |
| Unknown phone_number_id / duplicates | Logged and dropped (`continue`) | `:310-338` |
| Reactions | Upsert on `(message_id, actor_type, actor_id)` | `:603-651` |
| Downstream fan-out | flows `:889`, automations per trigger `:952-961` (awaited, can chain through `add_tag` → `runAutomationsForTrigger`, `lib/automations/engine.ts:454`), AI auto-reply `:973`, outbound webhooks `:991` (5 s timeout each, `deliver.ts:31,76`) | as cited |

### 7.2 Bulk sender

There are **two paths**, chosen by whether `QSTASH_TOKEN` is set (`src/lib/whatsapp/broadcast-queue.ts:64`).

1. **Planning happens in the browser** for both paths. `use-broadcast-sending.ts` resolves the audience, upserts CSV contacts, inserts `broadcasts`, inserts `broadcast_recipients` 200 per batch, and inserts `broadcast_url_tokens`, all directly via supabase-js (`:111,370-379,578-579,631-650`). If the tab closes mid-plan, a partially created broadcast is left behind.
2. **Queue path (QStash):** the browser calls `POST /api/whatsapp/broadcast/[id]/queue` (`:664`). The worker `POST /api/queue/broadcast` verifies the QStash signature, takes a DB lease (`delivery_locked_at`, stale after 30 min, `broadcast-resume.ts:52,68-92`), sends **250 recipients per pass** at **concurrency 8** (`broadcast-queue.ts:43,46`), then re-enqueues itself (`continue`) or delays 30 s if busy (`:49`, `api/queue/broadcast/route.ts:64-72`). QStash `retries: 3` (`broadcast-queue.ts:110`).
3. **Fallback path (no QStash): the browser drives sending.** 50 recipients per chunk, 1.5 s delay (`use-broadcast-sending.ts:97-98`). Each chunk is a `POST /api/whatsapp/broadcast`. Pause/cancel are **in-memory React refs** (`:211-240,710-716`), so closing the tab stops the send.

| Concern | Status |
|---|---|
| Loops over contacts in one request | Queue path: bounded 250 per invocation. Fallback: 50 per request. `/resume` has `maxDuration=300`. |
| Queue | QStash (external) |
| Rate limiting toward Meta | Fixed concurrency 8 + 429 retry with `Retry-After` (`src/lib/broadcast-retry.ts:4-40`, fallback path). No throughput pacing per phone number tier. |
| Retry/backoff | Per-recipient phone-variant retry (`broadcast-core.ts:299-318`); QStash retries 3; resume endpoint re-plans `failed` recipients (`broadcast-resume.ts:154-220`). |
| Pause/stop | **Queue path: no pause/stop control found.** The worker stops only if `broadcasts.status !== 'sending'` (`broadcast-queue.ts:174-185`), and no UI or API that sets that was found. VERIFY in `broadcasts/[id]/page.tsx`. Fallback: in-browser only. |
| Per-campaign state | `broadcasts.status`, counts, `delivery_locked_at`, `delivery_queued_at`; per-recipient status + wamid. Good basis for idempotency. |
| Scheduled broadcasts | `broadcasts.scheduled_at` and status `scheduled` exist (`001:302-303`, `src/types/index.ts:421,432`), but **no scheduler code sends them** (0 matches outside types and filters). UNKNOWN whether the UI exposes scheduling (`step4-schedule-send.tsx`), needs manual check. |

### 7.3 Media

- **Inbound:** if `whatsapp_config.mirror_inbound_media` (default TRUE, `039`), the bytes are downloaded from Meta and uploaded to public `chat-media` via the service role at webhook time (`mirror-inbound-media.ts:213-231`). Otherwise the UI goes through `GET /api/whatsapp/media/[mediaId]`, which resolves a fresh Meta URL and **buffers the whole file in memory** on every view, with no caching (`api/whatsapp/media/[mediaId]/route.ts`). Meta media IDs expire (VERIFY: ~30 days), so un-mirrored old media becomes unreachable.
- **Outbound:** browser uploads to `chat-media` / `flow-media` (`src/lib/storage/upload-media.ts:121`) and the public URL is sent to Meta as a link. Template header media goes through Meta resumable upload (`meta-api.ts:599-642`, needs `META_APP_ID`).

### 7.4 Templates, 24-hour window, opt-in

- Template sync: `api/whatsapp/templates/sync/route.ts`. Submit: `…/submit`. Edit/delete: `…/[id]`. Status updates via webhook `message_template_status_update` (`src/lib/whatsapp/template-webhook.ts`). `WHATSAPP_TEMPLATES_DRY_RUN` env flag.
- **24-hour window: not enforced in code.** It is documented in comments only (`meta-api.ts:355,490`). Free-form sends outside the window fail at Meta and are surfaced via error explanations (`meta-error-explain.ts`).
- **Opt-in / opt-out tracking: none.** No opt-out column, STOP keyword handling, or suppression list (0 matches). This is a compliance gap for marketing broadcasts, unrelated to the migration but worth noting.

### 7.5 Secrets location

| Secret | Location | Protection |
|---|---|---|
| Meta access token, verify token | `whatsapp_config.access_token` / `verify_token` (DB) | AES-256-GCM with env `ENCRYPTION_KEY` (legacy CBC still decrypts) (`src/lib/whatsapp/encryption.ts:29-90`) |
| Meta app secret | env `META_APP_SECRET` | env |
| AI provider keys | `ai_configs.api_key`, `embeddings_api_key` | encrypted (comment `029`; VERIFY embeddings key encryption) |
| Outbound webhook signing secret | `webhook_endpoints.secret` | encrypted (comment `028`) |
| API keys | `api_keys.key_hash` | SHA-256 hash |
| Invitations | `account_invitations.token_hash` | hash |

### 7.6 Things that cannot run on Workers as written

- `after()` processing with a 60 s budget (webhook). Workers `waitUntil` limit: VERIFY.
- `maxDuration = 300` routes (`api/queue/broadcast`, `api/whatsapp/broadcast/[id]/resume`). Workers CPU limits are configurable (VERIFY), but wall-clock in an HTTP request is not guaranteed. Move to a Queue consumer.
- **In-memory rate limiter** `const buckets = new Map()` (`src/lib/rate-limit.ts:46`). Its own header admits multi-instance deployments defeat it (`:6-19`). On Workers it is per-isolate and effectively off. Used by 17 files.
- **Browser-driven send loop** (fallback path): survives on Workers but stops when the tab closes. Remove it and make the queue mandatory.
- Module-level singletons (`_adminClient`, `browserClient`): harmless, but D1/R2 bindings come from `env` per request, not `process.env`.
- `setTimeout`/`setInterval` in server code: **none** (only a client `URL.revokeObjectURL`, `src/lib/media/download.ts:48`).
- Local filesystem: **none** server-side. `messages/*.json` are imported at build time.
- `node:dns/promises` `lookup` + `node:net` `isIP` in the SSRF guard (`src/lib/webhooks/ssrf.ts:21-22`). VERIFY `nodejs_compat` DNS support. Workers cannot reach private IPs anyway, but keep the guard.

---

## 8. Long-running work → Hono + Queues mapping

### 8.1 Operations

| Operation | Current location | Current mechanism | Est. duration / size | Proposed target | Chunking & idempotency notes |
|---|---|---|---|---|---|
| Inbound webhook processing | `api/whatsapp/webhook/route.ts:256` | `after()` in request | seconds to tens of seconds (LLM + media + webhooks); N messages/statuses per POST | **Hono `POST /webhook`** verifies HMAC, enqueues the **raw body** to `wa-inbound` queue, returns 200. **Queue consumer** processes. DLQ `wa-inbound-dlq`. | Keep wamid unique-insert as the idempotency gate; move media mirroring **after** the gate. Consider separate queues for statuses (high volume, cheap) and messages. |
| Status updates (sent/delivered/read/failed) | same `:296-297,412-540` | sequential in `after()` | ~3 per outbound message | Queue consumer (batched) | Make atomic: `UPDATE … SET status=? WHERE id=? AND rank(status) < rank(?)`. Apply the same guard to `messages`. |
| AI auto-reply | `lib/ai/auto-reply.ts` via webhook `:973` | awaited inline | LLM call up to `AI_REQUEST_TIMEOUT_MS` | Separate queue `ai-reply` | `claim_ai_reply_slot` becomes a conditional UPDATE; dedupe on inbound wamid. |
| Outbound customer webhooks | `lib/webhooks/deliver.ts:14-76` | awaited `Promise.allSettled`, 5 s timeout | 1 fetch per endpoint per event | Queue `outbound-webhooks` with retries + DLQ | Event id (`randomUUID`) already present for receiver dedupe. |
| Flows engine on inbound | `lib/flows/engine.ts` (1213 lines) via webhook `:889` | inline | ms to s | Same consumer as inbound | one-active-run partial unique index must be preserved |
| Automations on triggers | `lib/automations/engine.ts` via webhook `:952` and tag changes | inline, recursive via `add_tag` | unbounded chain depth (UNKNOWN guard) | Consumer; enqueue chained triggers as new messages instead of recursing | add a depth / loop guard |
| Automation `wait` steps | `engine.ts:279-300` inserts `automation_pending_executions`; `api/automations/cron/route.ts` polls 50 per call | external cron + DB polling | minutes to days of delay | **Queue with `delaySeconds`** for short waits (VERIFY: max delay 12 h), plus **Cron Trigger** sweep of the table for longer waits (or Workflows `step.sleep`) | Keep the `status='pending'→'running'` conditional claim (`cron/route.ts:46-55`) |
| Flow timeout sweep | `api/flows/cron/route.ts:56-110` | external cron, **unbounded scan of all active runs** | O(active runs) | **Cron Trigger** every 5 min, with paged SQL `WHERE status='active' AND last_advanced_at < ?` | compute cutoff in SQL, not JS |
| Bulk broadcast send | `lib/whatsapp/broadcast-queue.ts`, `api/queue/broadcast/route.ts` | QStash self-re-enqueue, 250/pass, conc. 8 | 10k recipients ≈ 40 passes | **Queue `broadcast-send`**. Message = `{broadcastId, recipientIds[≤N]}` or a pass cursor. Consumer `max_batch_size`/concurrency tuned to Meta tier. DLQ. | Keep the lease or replace it with a **Durable Object per broadcast** (natural single-writer, pause/resume/stop state, alarm-driven pacing). Recipient status `pending→sent` conditional UPDATE is the idempotency gate. **Check subrequest limits per invocation (VERIFY)**: 250 Meta fetches + ≥250 D1 writes per pass. |
| Broadcast planning (audience resolve, recipient insert, URL tokens) | **browser** `use-broadcast-sending.ts:179-650` | many supabase-js calls | up to all contacts | **Hono `POST /broadcasts`** with a Queue job `broadcast-plan` that pages contacts and inserts recipients in D1 `batch()` chunks | idempotency key per broadcast; status `planning` until done |
| Broadcast resume / retry-failed | `api/whatsapp/broadcast/[id]/resume/route.ts` (`maxDuration 300`) | in request | up to 250+/call | enqueue to `broadcast-send` | |
| Scheduled broadcasts | **not implemented** (§7.2) | — | — | Cron Trigger (1 min) or DO alarm per broadcast | |
| CSV contact import | **browser** `import-modal.tsx:281-347` (50/insert) + `lib/contacts/parse-contact-csv.ts` | client loops | file size UNKNOWN | Upload CSV to R2 → Queue `contact-import` → consumer pages rows into D1 `batch()` | dedupe via `(account_id, phone_normalized)` unique |
| CSV exports (flow node leads, button clicks) | `api/flows/[id]/nodes/[nodeId]/leads/export/route.ts`, `api/whatsapp/broadcast/[id]/buttons/[buttonIndex]/export/route.ts` | in request, builds full CSV in memory | UNKNOWN row counts | Stays in Next/Hono for small sets; for large sets stream with `ReadableStream`, or generate to R2 via Queue | paginate D1 reads |
| Knowledge base reindex / embeddings | `api/ai/knowledge/reindex/route.ts`, `lib/ai/knowledge.ts:28-72`, `lib/ai/embeddings.ts:41-60` | in request, batched OpenAI calls | O(documents × chunks) | Queue `kb-index` | delete+insert chunks + Vectorize upsert, keyed by chunk id |
| Template sync | `api/whatsapp/templates/sync/route.ts` | in request | number of templates (paged Meta API) | Stays in route (short); optional daily Cron | upsert by (name, language) |
| Inbound media mirroring | `lib/whatsapp/mirror-inbound-media.ts` | inline in webhook | up to 16 MB per file | Inside the inbound consumer, **streaming** Meta → R2 (no full buffering) | key by wamid so retries overwrite |
| Media proxy | `api/whatsapp/media/[mediaId]/route.ts` | buffers full file | ≤16 MB | Stays; stream the body and cache it in R2 on first fetch | |
| Presence heartbeat | `presence-heartbeat.tsx:59` (30 s) | RPC write per tab | 2,880 writes/tab/day | **Durable Object in-memory state** (WebSocket connected = online) | no D1 writes |
| Dashboard / reports aggregation | `lib/dashboard/queries.ts:46-246` | 10+ queries, some pull raw `messages` rows to aggregate in JS (`:110-111,180-181`) | grows with message volume | Stays in Next route; convert to SQL `GROUP BY` | watch D1 rows-read |
| SSE / streaming | **none** | — | — | — | |

### 8.2 Route handler classification (66)

| Route(s) | Classification | Reason |
|---|---|---|
| `api/whatsapp/webhook` (GET, POST) | **Moves to Hono** | Meta ingress; enqueue only |
| `api/queue/broadcast` | **Moves to Hono** (becomes a Queue consumer, not HTTP) | long-running |
| `api/whatsapp/broadcast` (POST), `api/broadcast` (alias re-export, `src/app/api/broadcast/route.ts:1-3`) | **Moves to Hono** (enqueue) | bulk send |
| `api/whatsapp/broadcast/[id]/queue`, `…/[id]/resume` | **Moves to Hono** | enqueue / long-running |
| `api/automations/cron`, `api/flows/cron` | **Moves to Hono** (Cron Trigger `scheduled()` handler) | scheduled |
| `api/automations/engine` | **Moves to Hono** | runs engine (VERIFY what it triggers) |
| `api/ai/knowledge/reindex` | **Moves to Hono** (Queue) | batch embeddings |
| `api/ai/autoreply/[conversationId]` | Stays in Next | toggle (short CRUD) |
| `api/v1/broadcasts` (POST, `maxDuration 60`) | **Moves to Hono** (enqueue) | bulk |
| `api/v1/*` (contacts, conversations, messages, me, webhooks, broadcasts/[id]) | Stays in Next **or** Hono (recommend Hono for a clean public API) | short CRUD with API-key auth |
| `api/whatsapp/send`, `api/whatsapp/react` | Stays in Next | single Meta call + D1 insert |
| `api/whatsapp/templates/{sync,submit,[id]}` | Stays in Next | short Meta calls |
| `api/whatsapp/config`, `…/verify-registration` | Stays in Next | short Meta calls |
| `api/whatsapp/media/[mediaId]` | Stays in Next (stream) | proxy |
| `api/whatsapp/broadcast/[id]/buttons`, `…/buttons/[i]/export` | Stays in Next (stream export) | read/export |
| `api/flows/*` (CRUD, activate, runs, templates, leads, leads/export) | Stays in Next | short CRUD |
| `api/automations`, `api/automations/[id]`, `…/duplicate` | Stays in Next | CRUD |
| `api/quick-replies*`, `api/contacts/[id]/tags` | Stays in Next | CRUD |
| `api/account/*`, `api/invitations/[token]/{peek,redeem}` | Stays in Next | CRUD (port RPC logic) |
| `api/ai/{config,draft,knowledge,knowledge/[id],playground,test,usage}` | Stays in Next | short (draft/playground do one LLM call; VERIFY latency under CPU limits) |
| `r/[token]` | Stays in Next **or** Hono | public redirect + click insert; high fan-in after campaigns, so Hono is lighter |
| **New** endpoints replacing 149 client queries | Stays in Next (short D1 CRUD) | §4.1 |
| Server actions | none | — |

---

## 9. Cloudflare runtime compatibility

### 9.1 Dependencies (`package.json:41-63`)

| Dependency | Server-side? | Workers status | Action |
|---|---|---|---|
| `next` 16.3.5 | yes | via OpenNext (VERIFY version) | |
| `@supabase/ssr`, `@supabase/supabase-js` | yes + client | HTTP-based, works on Workers, but **removed** in target | replace with D1 bindings + auth lib |
| `@upstash/qstash` 2.12.0 | yes | HTTP, works | **replace** with Cloudflare Queues |
| `next-intl` | yes | works (VERIFY) | |
| `date-fns`, `clsx`, `tailwind-merge`, `class-variance-authority` | both | pure JS | |
| `react`, `react-dom`, `@base-ui/react`, `@dnd-kit/*`, `@xyflow/react`, `@dagrejs/dagre`, `recharts`, `lucide-react`, `sonner`, `tw-animate-css` | client | n/a | bundle size for client only |
| `opus-recorder` | client (worker file in `public/opus/encoderWorker.min.js`) | n/a | |
| `shadcn` (^4.16.2) **in `dependencies`** | CLI tool | should be a devDependency; it may pull a lot into the install. Keep it out of the server bundle. | move to devDependencies |
| `sharp` (transitive via Next, `@img/sharp-*` in lockfile; also in `overrides`) | image optimization | **native, not on Workers** | `images.unoptimized` or Cloudflare Images (VERIFY) |
| `hono` (only in `overrides`, transitive) | — | — | add as a direct dep in the new worker |
| Native / TCP / heavy libs: `bcrypt`, `pg`, `canvas`, `puppeteer`, PDF/Excel libs, `ws` | **none** in app deps | — | — |
| `node:crypto` (`createHmac`, `createCipheriv('aes-256-gcm'/'aes-256-cbc')`, `randomBytes`, `createHash`, `timingSafeEqual`, `randomUUID`) | yes (8 files) | `nodejs_compat` (VERIFY each API incl. `aes-256-cbc`) | or port to WebCrypto (`crypto.subtle`), recommended for the new Hono worker |
| `Buffer` usage | yes (signature, encryption, media) | `nodejs_compat` | |
| `node:dns/promises`, `node:net` | `src/lib/webhooks/ssrf.ts:21-22` | VERIFY | replace DNS lookup with DoH `fetch`, or rely on Workers egress restrictions |

### 9.2 Bundle size risk

- Not measured (no build run). UNKNOWN - needs manual check: run `opennextjs-cloudflare build` and check the compressed worker size.
- Likely largest **server-side** contributors: Next.js runtime itself, `next/og` (satori + resvg WASM) if `icon.tsx` stays, `@supabase/supabase-js` (removed after migration), `next-intl`, all 4 locale JSON files if they get bundled server-side. Client-heavy libs (`@xyflow/react`, `recharts`, `@dnd-kit`) should stay in client chunks.
- **Limits (VERIFY):** Workers Paid script size 10 MB compressed; CPU time default 30 s per request, configurable up to 5 min; memory 128 MB per isolate; subrequests per invocation (historically 1,000 on Paid; VERIFY the current value); `waitUntil` ~30 s after response; Queue consumer wall time (VERIFY: 15 min); Queue `delaySeconds` max (VERIFY: 12 h).
- **Parts that could approach limits:** a broadcast pass (250 Meta fetches + ≥250 D1 writes = ≥500 subrequests if D1 calls count, VERIFY); mirroring a 16 MB video while holding it in memory (`mirror-inbound-media.ts`, media proxy); exports that build whole CSVs in memory; knowledge reindex; dashboard queries that pull raw message rows (`lib/dashboard/queries.ts:110,180`).

### 9.3 Realtime design

- **Concurrent agents the UI targets:** UNKNOWN - needs manual check. The code has a roster with presence (`members-tab.tsx`), an assignment dropdown with presence dots (`message-thread.tsx:1042-1055`), and 4 roles. Nothing suggests a design for hundreds of agents. Each open tab holds ~5–7 channels.
- **DO replacement must support:**
  - one DO per `account_id` (single-tenant: effectively one, but keep the key for safety), using **WebSocket Hibernation** (VERIFY API) so idle agents cost nothing;
  - authenticated upgrade (validate session/JWT in the Worker before forwarding to the DO);
  - topics: `conversations` (list + unread), `messages` (insert/update incl. status ticks), `reactions:{conversationId}`, `notifications:{userId}` (**per-user**, must not go to other members), `presence`;
  - **publisher calls from every writer:** inbound consumer, status consumer, send/react routes, assignment updates (`notify_conversation_assigned` replacement), broadcast reply flagging, automations/flows that send messages or assign;
  - presence as in-memory DO state (connected sockets + last activity), replacing `member_presence` writes;
  - reconnect + "since cursor" catch-up (clients refetch on reconnect), since DO messages are fire-and-forget.

### 9.4 Observability

- **Current:** `console.*` only, 274 calls. **No error tracking** (no Sentry/Datadog/etc., 0 matches). No structured logging, no request IDs (except the outbound webhook event id).
- **Replace with:** Workers Logs / `wrangler tail` (VERIFY retention on Paid), Logpush (VERIFY plan availability), optionally `@sentry/cloudflare` (VERIFY). Add queue DLQ alerting, plus per-broadcast and per-webhook correlation IDs.

---

## 10. Auth and security migration

### 10.1 Users and passwords

- Users live in Supabase `auth.users` (`encrypted_password` = **bcrypt**, `$2a$`/`$2b$` cost 10; VERIFY on the export). Profile, account and role data are in `public.profiles` / `public.accounts`.
- **Carry users over without resets:** export `id, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at`. Keep `id` as the user id (every FK uses it). Configure Better Auth's password `verify` hook to accept bcrypt (pure-JS `bcryptjs`, **CPU-heavy on Workers, ~50–150 ms per verify at cost 10, VERIFY**). On successful login, rehash with the new default (scrypt/PBKDF2 via WebCrypto) and mark the user migrated. VERIFY Better Auth's custom hash hooks and D1 adapter.
- **Invite flow:** custom, token-hash based (`account_invitations`, `019`). Portable; port the RPC logic (`peek`, `redeem` with the "already has data" checks at `019:83,101`).
- **Password reset:** **currently broken** (redirects to non-existent `/auth/callback` and `/reset-password`, `forgot-password/page.tsx:33`). Build it properly in the new auth system (email provider needed: Cloudflare Email Sending / Resend / SES, VERIFY).
- **Email confirmation:** setting UNKNOWN (dashboard). Decide whether to keep it.
- **OAuth:** none.
- **Sign-up bootstrap:** the `auth.users` trigger (`017:659-689`) must become an `onUserCreated` hook. **Decide whether public signup should exist at all on a single-tenant deployment** (see 10.4 #4).

### 10.2 Sessions / cookies to rebuild

- Middleware session refresh + cookie copy (`src/middleware.ts:7-43`). Better Auth session cookie check in OpenNext middleware (edge), plus **path list fix** (`:73`).
- Server helper `getCurrentAccount()` / `requireRole()` (`src/lib/auth/account.ts:106-189`): swap the internals, keep the interface (most routes already call it).
- Client: `use-auth.tsx` (`getSession`, `onAuthStateChange`, `signOut`); 11 `getSession()` call sites that attach the bearer token to `fetch` (switch to cookie auth); global sign-out (`sessions-card.tsx:38`) needs a server-side "revoke all sessions".
- Password change re-auth flow (`password-form.tsx:56-65`).
- Public API key auth (`src/lib/auth/api-context.ts:80`) is independent of Supabase Auth. Port as-is.

### 10.3 Secrets → Worker secrets (and rotation)

Move to `wrangler secret`: `ENCRYPTION_KEY`, `META_APP_SECRET`, `META_APP_ID` (not secret, but env), `AUTOMATION_CRON_SECRET` (**drop**: Cron Triggers need no HTTP secret), `QSTASH_*` (**drop**), `SUPABASE_SERVICE_ROLE_KEY` / `NEXT_PUBLIC_SUPABASE_*` (**drop** after cut-over), new auth secret (Better Auth secret / JWT signing key), email provider key. Keep: `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_APP_LOCALE`, `AI_REQUEST_TIMEOUT_MS`, `AI_CONTEXT_MESSAGE_LIMIT`, `WHATSAPP_TEMPLATES_DRY_RUN`, `ALLOWED_INVITE_HOSTS`.
**Rotate after cut-over:** Supabase service-role and anon keys (or delete the project), the cron secret, QStash signing keys. **Keep `ENCRYPTION_KEY` identical during data migration** (the encrypted DB columns depend on it), then optionally re-encrypt and rotate. **Note: `.env.local` exists in the working tree** with names `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `ENCRYPTION_KEY`, `META_APP_SECRET`, `META_APP_ID`. Confirm it is git-ignored (`.gitignore` exists; whether it is tracked is UNKNOWN - needs manual check with `git ls-files .env.local`).

### 10.4 Security weaknesses found

| # | Severity | Issue | Evidence |
|---|---|---|---|
| 1 | **High (VERIFY)** | SECURITY DEFINER functions **not revoked from `anon`/`authenticated`**. Supabase grants EXECUTE on new public functions to `anon` and `authenticated` by default (VERIFY with the SQL in §11). `REVOKE … FROM PUBLIC` alone does not remove those grants. Affected: **`merge_duplicate_contacts()`** and **`merge_duplicate_conversations()`** (global, cross-account merges; only `REVOKE FROM PUBLIC`, `022:111`, `036:116`); `_bcast_bump(bid, col, delta)` (arbitrary counter column on any broadcast, `005:36`); `recompute_broadcast_counts`; `record_webhook_failure(endpoint_id, …)` (disable any account's webhook, `028:91-103`); `claim_ai_reply_slot` (`029:118-141`, granted to service_role only, never revoked). Compare `007:32-35`, `037:94-97`, which revoke properly. | as cited |
| 2 | Medium | Encrypted secrets readable by **any member incl. `viewer`**: `whatsapp_config` SELECT is member-level and the browser selects `*` (`settings/whatsapp-config.tsx:152-153`), shipping encrypted `access_token`/`verify_token` to the client. `ai_configs` and `webhook_endpoints` SELECT are also member-level (`029`, `028`). Ciphertext only, but it should never leave the server. | as cited |
| 3 | Medium | In-memory rate limiter ineffective on multi-instance/serverless (and on Workers) | `src/lib/rate-limit.ts:6-19,46` |
| 4 | Medium | **Open signup**: any visitor can create a user, and the trigger gives them their own `owner` account in the client's single-tenant DB, where they can connect a WhatsApp number. No signup gating found. | `signup/page.tsx:73`; `017:659-689`; no `DISABLE_SIGNUP` match |
| 5 | Medium | `messages.status` updates unordered and not account-scoped (late `sent` overwrites `read`) | `webhook/route.ts:443-456` |
| 6 | Medium | Inbound customer media in a **public** bucket with permanent URLs | `039:83-95`; `mirror-inbound-media.ts:231` |
| 7 | Low | Password reset flow broken (users can't recover) | `forgot-password/page.tsx:33` |
| 8 | Low | Middleware protected-path list omits `/agents`, `/flows`, `/quick-replies`, `/notifications` (data is still RLS-protected; the shell renders unauthenticated) | `src/middleware.ts:73` |
| 9 | Low | `public, s-maxage=300` on all non-API paths, risky if a CDN caches auth redirects | `next.config.ts:144-150` |
| 10 | Low | Broadcast-recipient status transition is read-then-write (race) | `webhook/route.ts:470-503` |
| 11 | Low | CSP is report-only and allows `'unsafe-eval'` | `next.config.ts:39-45` |
| 12 | Info | URL redirect `r/[token]` sends to any stored destination (prepends `https://`). Destinations are set by agents, so this is an open-redirect only for whoever can create broadcasts. | `src/app/r/[token]/route.ts` |
| Good | — | HMAC webhook verification, AES-GCM at rest, hashed API keys and invite tokens, SSRF guard for outbound webhooks, profile privilege trigger, column-level grant on notifications | as cited in §7 |

---

## 11. Data and operations unknowns

Code cannot tell us: production row counts and table sizes, storage volume, peak inbound/outbound message rate, number of agents and concurrent tabs, number of accounts in the deployment (signup is open), Meta messaging tier, largest broadcast size, email-confirmation setting, which external cron is used, dashboard-configured DB webhooks, whether production RLS/grants match migrations, whether `pgvector` is actually populated (embeddings key set?), and what proportion of inbound media is mirrored.

**D1 limits (VERIFY):** max database size (historically 10 GB per DB on Paid), max DBs per account, rows-written/read pricing, statement size, bound parameters per statement (historically 100). `messages`, `flow_run_events`, `broadcast_recipients` and `automation_logs` are the tables likely to grow. At ~0.5–1 KB per message row plus indexes, **~10M messages would approach 10 GB**. Whether this deployment is anywhere near that is UNKNOWN until you run the SQL below. If a client is near 5 GB today, plan archiving (old messages → R2) or choose the Hyperdrive alternative.

### SQL to run in the Supabase SQL editor (read-only; paste results back)

```sql
-- 1) Exact row count + total size per public table
SELECT
  t.table_name,
  (xpath('/row/cnt/text()',
         query_to_xml(format('SELECT count(*) AS cnt FROM public.%I', t.table_name),
                      false, true, '')))[1]::text::bigint           AS exact_rows,
  pg_size_pretty(pg_total_relation_size(format('public.%I', t.table_name)::regclass)) AS total_size,
  pg_total_relation_size(format('public.%I', t.table_name)::regclass)                AS total_bytes
FROM information_schema.tables t
WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
ORDER BY total_bytes DESC;

-- 2) Storage objects: count + total size per bucket
SELECT bucket_id,
       count(*)                                                   AS objects,
       pg_size_pretty(sum(COALESCE((metadata->>'size')::bigint,0))) AS total_size,
       sum(COALESCE((metadata->>'size')::bigint,0))                 AS total_bytes
FROM storage.objects
GROUP BY bucket_id
ORDER BY total_bytes DESC;

-- 3) Auth users
SELECT count(*)                                         AS total_users,
       count(*) FILTER (WHERE email_confirmed_at IS NULL) AS unconfirmed,
       count(*) FILTER (WHERE encrypted_password IS NULL OR encrypted_password = '') AS no_password,
       count(*) FILTER (WHERE encrypted_password LIKE '$2%') AS bcrypt_hashes
FROM auth.users;
SELECT provider, count(*) FROM auth.identities GROUP BY provider;

-- 4) Ten largest tables with table vs index size
SELECT c.relname                                         AS table_name,
       pg_size_pretty(pg_relation_size(c.oid))           AS table_size,
       pg_size_pretty(pg_indexes_size(c.oid))            AS index_size,
       pg_size_pretty(pg_total_relation_size(c.oid))     AS total_size,
       (SELECT count(*) FROM pg_index i WHERE i.indrelid = c.oid) AS index_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY pg_total_relation_size(c.oid) DESC
LIMIT 10;

-- 5) (Extra) Accounts, members per role, and message rate
SELECT count(*) AS accounts FROM public.accounts;
SELECT account_role, count(*) FROM public.profiles GROUP BY account_role;
SELECT date_trunc('day', created_at) AS day, sender_type, count(*)
FROM public.messages
WHERE created_at > now() - interval '30 days'
GROUP BY 1, 2 ORDER BY 1, 2;
SELECT date_trunc('hour', created_at) AS hour, count(*) AS msgs
FROM public.messages
WHERE created_at > now() - interval '30 days'
GROUP BY 1 ORDER BY msgs DESC LIMIT 5;                 -- peak hours
SELECT max(total_recipients) AS largest_broadcast, avg(total_recipients)::int AS avg_broadcast,
       count(*) AS broadcasts FROM public.broadcasts;

-- 6) (Extra) Security check: who can EXECUTE the SECURITY DEFINER functions
SELECT p.proname,
       p.prosecdef                                       AS security_definer,
       has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
ORDER BY p.prosecdef DESC, p.proname;

-- 7) (Extra) Confirm prod matches migrations
SELECT tablename, policyname, cmd, qual FROM pg_policies WHERE schemaname = 'public' ORDER BY 1, 2;
SELECT extname, extversion FROM pg_extension ORDER BY 1;
SELECT event_object_table, trigger_name FROM information_schema.triggers ORDER BY 1, 2;
-- pg_cron jobs (errors if pg_cron is not installed; that is also an answer)
SELECT jobid, schedule, command FROM cron.job;
-- Dashboard-configured DB webhooks (errors if schema absent)
SELECT * FROM supabase_functions.hooks ORDER BY id DESC LIMIT 20;
-- Is the knowledge base embedded?
SELECT count(*) AS chunks, count(embedding) AS embedded FROM public.ai_knowledge_chunks;
```

---

## 12. Cost sanity check (Workers Paid $5) per 10,000 messages sent

Assumptions: one broadcast of 10,000 recipients, all sent; Meta delivers `sent`, `delivered`, `read` statuses (3 per message; often fewer `read`); 10% reply; one URL-tracked button; current indexes. **All prices and quotas are VERIFY.** Historically Workers Paid included 10M requests/mo, Queues 1M ops/mo, and D1 25B rows read + 50M rows written/mo.

| Item | Estimate | Basis |
|---|---|---|
| **D1 rows written: recipient insert** | ~10k rows + ~30k index entries | `broadcast_recipients` PK + 3–4 indexes (`001:334`, `003`, `038:9`) |
| URL token insert | ~10k + ~30k index | `broadcast_url_tokens` 3 indexes + UNIQUE (`045`) |
| Recipient `pending→sent` update | ~10k + index changes on status/wamid | `broadcast-core.ts:323-332` |
| **Counter trigger bumps** (current design) | **~90k** broadcasts-row updates | trigger decrements every old-status column and increments every new one, each as a separate `UPDATE` (`005:62-105`): sent = 1, sent→delivered = 3, delivered→read = 5 → **9 updates per recipient** |
| Status updates (recipient + messages) | ~30k–60k | 3 statuses × (recipient update + status index) |
| Replies (10%) | ~1k messages + conversation bumps + `replied` flag + button clicks ≈ 5k | webhook path |
| **Total D1 rows written** | **≈ 250k–300k** per 10k messages (≈ 25–30 per message) | well under monthly quota for normal volumes |
| **Queue operations** | (a) send: 1 message per 250-recipient pass → 40 msgs × 3 ops (write/read/delete, VERIFY) ≈ **120 ops**; (b) inbound/status: if every Meta webhook POST is enqueued, ~31k webhooks × 3 ≈ **93k ops**; (c) outbound customer webhooks if enabled: +1 message per event | negligible vs 1M/mo |
| **Worker requests** | ~31k Meta webhook POSTs (fewer if Meta batches statuses) + ~10k `r/[token]` clicks (if clicked) + UI traffic; queue consumer invocations are batched | ≪ 10M/mo |
| **Subrequests per consumer invocation** | 250 Meta fetches + ≥250 D1 calls per pass | **may exceed per-invocation subrequest limit (VERIFY)**; use smaller passes (e.g. 50–100) or batch D1 writes |

**Designs that multiply writes or operations unnecessarily:**
1. **Broadcast aggregate trigger** (`005`): up to 9 `UPDATE broadcasts` per recipient, all on one hot row. Replace with one delta UPDATE per transition (`sent_count = sent_count + ?, delivered_count = …` in a single statement), or drop stored counters and compute them with `GROUP BY status` on demand (cache in the DO / KV).
2. **Presence heartbeat** every 30 s per open tab as a DB write (`presence-heartbeat.tsx:59`, `lib/presence.ts:16`): 2,880 writes/tab/day. Move to DO memory.
3. **`delivery_queued_at` + lease updates per pass** (`broadcast-queue.ts:111-113`, `:195-198`): 3 writes per pass. Fine, but a DO per broadcast removes them.
4. **6 indexes on `flow_runs`, 5 on `contacts`, 4 on `messages`/`broadcast_recipients`**: audit and drop redundant ones (e.g. `idx_broadcast_url_tokens_token` duplicates the inline `UNIQUE`, `045:9,13`).
5. **Dedupe-gate ordering**: media mirroring before the idempotent insert means Meta retries re-run R2 writes and Meta downloads.
6. **Unfiltered flows cron scan** (`flows/cron/route.ts:56-59`): reads all active runs every tick. That costs D1 rows read.
7. **Dashboard queries pulling raw message rows** into JS (`lib/dashboard/queries.ts:110,180`): rows-read grows linearly with history.

---

## 13. Effort estimate (working days, one senior full-stack engineer)

Assumptions: single deployment as the template, with per-client rollout scripted afterwards; behavior tests (§15) written first; Better Auth chosen; Vectorize/FTS5 used for AI knowledge; no new features; existing 93 Vitest files need rework where they mock Supabase.

| Area | Low | Likely | High | Confidence | Notes |
|---|---|---|---|---|---|
| Schema conversion (38 tables, 46 migrations → D1 schema, triggers, FTS5, type mapping) | 4 | 6 | 9 | Medium | consolidate into one baseline migration |
| Port 30 SQL functions / RPCs to TS (account, invitations, dedupe merges, broadcast create, counters) | 3 | 5 | 8 | Medium | transactional semantics via `batch()` |
| Webhook + send path (Hono ingress, inbound/status consumers, ordering fixes, media → R2 streaming) | 5 | 8 | 12 | Medium | 1,457-line handler |
| Broadcast queue (QStash → Queues/DO, server-side planning, pause/stop) | 3 | 5 | 8 | Medium | planning currently in browser |
| Auth (Better Auth on D1, bcrypt import, sessions, middleware, reset, invites, global sign-out) | 4 | 6 | 9 | Medium | |
| **Core APIs replacing 149 client queries + query-builder rewrite in ~60 route handlers / libs (460 `.from()`)** | 15 | 22 | 32 | **Low** | biggest item; explicit role checks |
| Frontend swap (37 client files, hooks, storage uploads, auth hooks) | 5 | 8 | 12 | Low | overlaps with the item above |
| Realtime (DO + hibernating WS, 7 subscriptions, presence, publisher calls in all writers) | 4 | 6 | 9 | Medium | |
| Automations / flows / cron (Cron Triggers, delayed queues, recursion guard) | 2 | 4 | 6 | Medium | |
| AI knowledge (Vectorize + FTS5, reindex queue) | 2 | 3 | 5 | Medium | skip if unused (§11 query) |
| Data migration (Postgres → D1 ETL, storage → R2, URL rewrite in `media_url`/`avatar_url`, auth users) | 3 | 5 | 8 | **Low** | depends on volume |
| Testing and hardening (rewrite Supabase-mocked tests, load test webhook + broadcast, security review) | 6 | 10 | 15 | Low | |
| **Total** | **56** | **88** | **133** | | ≈ 3–6 months for one engineer |

Hyperdrive alternative (keep Postgres, replace only Supabase Auth/Storage/Realtime and the compute): roughly **35 / 55 / 80** days. The query-builder rewrite shrinks but does not vanish: you still need an API layer if the browser stops using PostgREST.

---

## 14. Risks and next steps

### 14.1 Top 10 risks (by severity)

| # | Risk | Mitigation |
|---|---|---|
| 1 | Authorization regressions when RLS disappears (149 client queries + RLS-only routes) | Build a single `requireRole(min)` + `accountScope()` data-access layer; table-driven tests that run every endpoint as viewer/agent/admin/other-account. |
| 2 | Data loss / partial migration (IDs, encrypted columns, timestamps, money) | Keep UUIDs and `ENCRYPTION_KEY`; dry-run ETL with row-count and checksum parity; cents conversion tests; freeze-window cut-over. |
| 3 | Webhook drops during cut-over or under `waitUntil` limits | Ingress only enqueues; DLQ; replay tool from DLQ; keep the old endpoint live until the Meta webhook URL is switched. |
| 4 | Broadcast duplicates or overspend (double sends) | Conditional `pending→sending→sent` claims; per-broadcast DO single-writer; idempotency key on enqueue; staged rollout with small campaigns. |
| 5 | D1 size or throughput ceiling (single-writer DB, VERIFY size limit) | Run §11 SQL first; archive old messages/events to R2; if >~5 GB or high write rates, choose Hyperdrive. |
| 6 | Realtime gaps (writers forgetting to publish) | Central `publish()` called inside the data-access layer for the affected tables, not at call sites; client refetch on reconnect. |
| 7 | OpenNext / Next 16 incompatibility | Spike day 1: deploy the current app shell on OpenNext before any data work; pin versions. |
| 8 | Auth migration locks users out | bcrypt verify fallback + rehash; working reset email before cut-over; test with real hash samples. |
| 9 | Subrequest/CPU limits in consumers (broadcast passes, media) | Smaller passes, streaming R2 uploads, measure with `wrangler tail` and profiling. |
| 10 | Existing security holes carried over (§10.4) | Fix #1–#6 in the current app first, so behavior tests encode the corrected behavior. |

### 14.2 Migration order tailored to this codebase

1. **Harden the current app** (§10.4 #1, #2, #5, #7) and write the behavior tests (§15).
2. **OpenNext spike:** deploy the existing app unchanged on Workers (still pointing at Supabase), using Supabase HTTP from Workers. This proves Next 16 + middleware + `next-intl` + headers.
3. **Hono worker + Queues for the webhook:** ingress → queue → consumer, still writing to Supabase. Switch the Meta webhook URL. Removes the `after()` risk early.
4. **Broadcast queue: QStash → Cloudflare Queues** (still Supabase). Remove the browser-driven fallback; move planning server-side.
5. **Cron Triggers** replace the external cron for automations and flows.
6. **R2** for new uploads (dual-read old Supabase URLs), then copy the existing objects.
7. **Data-access layer**: replace the 149 client queries with API endpoints (still on Supabase via service role + explicit authz). This is the big, testable step. RLS becomes defense-in-depth.
8. **Durable Object realtime**, fed by the data-access layer; then remove the `postgres_changes` hooks.
9. **Auth swap** to Better Auth (still on Postgres if desired, then D1).
10. **D1 cut-over:** schema, ETL, flip the data-access layer's driver. At this point only the repository layer changes, which keeps the step contained.
11. Decommission Supabase; rotate keys.

### 14.3 First 5 concrete tasks

1. Run the §11 SQL in production (and the security grant query) and paste back. This decides D1 vs Hyperdrive.
2. Revoke EXECUTE from `anon, authenticated` on `merge_duplicate_contacts`, `merge_duplicate_conversations`, `_bcast_bump`, `recompute_broadcast_counts`, `record_webhook_failure` and `claim_ai_reply_slot` (new migration), and fix the `messages.status` ordering guard.
3. Spike: `@opennextjs/cloudflare` build + deploy of the unchanged app to a test Worker; record bundle size and any build errors.
4. Write the behavior test suite (§15) against the current app, especially webhook dedupe, status ordering, and broadcast idempotency.
5. Design the data-access layer interface (`repo.contacts.list(ctx, filters)`, etc.) and port **one vertical slice** end to end (contacts list + edit + tags), including role tests. Use it to re-estimate the 22-day core-API item.

### 15. Behavior tests to write against the CURRENT app before migrating

Webhook and messaging:
- [ ] Invalid / missing `X-Hub-Signature-256` → 401; rotated second secret accepted.
- [ ] Same inbound wamid delivered twice → one message row, unread bumped once, automations/flows/AI/outbound webhook fired once.
- [ ] Status ordering for broadcast recipients: `read` then late `delivered`/`sent` → stays `read`; `failed` after `delivered` → ignored; `failed` from `sent` → accepted with error text.
- [ ] Status ordering for inbox `messages` (currently fails; document the intended behavior and fix).
- [ ] Inbound for unknown `phone_number_id` → dropped, 200 to Meta.
- [ ] Reaction add / change / remove from customer.
- [ ] Inbound media mirrored once (and not re-mirrored on replay).
- [ ] Username-only sender (`from_user_id`, no phone) creates/finds the contact (BSUID path).
- [ ] Duplicate contacts/conversations race: two concurrent inbound messages for a new number → one contact, one conversation.

Broadcasts:
- [ ] 1,000-recipient broadcast via queue → every recipient sent exactly once; counts match `GROUP BY status`.
- [ ] Concurrent queue passes → lease prevents double send.
- [ ] Stop / pause behaviour (define it: currently none on the queue path).
- [ ] Resume re-sends only `failed`/`pending`; never `sent`.
- [ ] 429 from Meta → retried with `Retry-After`.
- [ ] Reply from a broadcast recipient flips to `replied` and bumps `replied_count`.
- [ ] Button click and URL-redirect tracking recorded once per inbound wamid / click.

Automations and flows:
- [ ] Trigger → steps execute in order; `wait` step resumes after due time via cron; claim prevents double resume.
- [ ] `add_tag` chaining into `tag_added` automations (and loop protection).
- [ ] Flow one-active-run-per-contact; timeout sweep marks stale runs `timed_out`.
- [ ] Assignment → notification created for the assignee only.
- [ ] AI auto-reply respects `auto_reply_max_per_conversation` under concurrent inbound messages; handoff behaviour.

Auth and roles:
- [ ] Viewer cannot write contacts, messages, deals; agent cannot edit templates, tags or WhatsApp config; admin cannot transfer ownership; owner can.
- [ ] Member of account A cannot read or write account B's rows through any endpoint (create two accounts; signup is open).
- [ ] Invitation peek / redeem / expired / used / "already has data" paths.
- [ ] Member role change, removal (gets a fresh personal account), ownership transfer.
- [ ] Profile update cannot change `account_role` / `account_id`.
- [ ] Global sign-out revokes other sessions.
- [ ] API key scopes enforced on `/api/v1/*`; revoked/expired key rejected.
- [ ] Outbound webhook: signature header correct; endpoint auto-disabled after N failures; SSRF targets rejected.
- [ ] Rate limits on send/broadcast/AI endpoints (document current numbers from `RATE_LIMITS`, `src/lib/rate-limit.ts:116`).

Data:
- [ ] Contact CSV import dedupes by normalized phone and applies tags.
- [ ] Deal values with cents round-trip exactly.
- [ ] Timestamps sort correctly across timezones in inbox and reports.
