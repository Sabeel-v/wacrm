# Cloudflare local development (migration phase 0)

Branch: `cloudflare-migration`. Target stack and plan: see `MIGRATION_ASSESSMENT.md`.
Everything here runs on your machine. No Cloudflare account or paid plan is needed until deploy.

## Layout

| Path | What |
|---|---|
| `wrangler.jsonc` | **wacrm-web**: the Next.js app, built by OpenNext into `.open-next/` |
| `workers/web/entry.ts` | Web worker entry: OpenNext plus the realtime WebSocket forward |
| `open-next.config.ts` | OpenNext adapter config (no ISR cache needed) |
| `workers/api/` | **wacrm-api**: Hono worker for the webhook, queue consumers, cron and the realtime Durable Object. See [webhook-queues.md](webhook-queues.md) |
| `workers/api/src/realtime-hub.ts` | `RealtimeHub` Durable Object (WebSocket hibernation). See [realtime.md](realtime.md) |
| `src/lib/cron/jobs.ts` | Cron jobs run by the API worker. See [cron-storage.md](cron-storage.md) |
| `d1/migrations/` | D1 schema migrations. Schema details and the Postgres mapping are in [d1-schema.md](d1-schema.md) |
| `d1/seed/dev.sql` | Local seed data (`npm run db:reset:local`) |
| `cloudflare-env.d.ts`, `workers/api/worker-configuration.d.ts` | generated binding types (`npm run cf-typegen`) |

### Bindings (local)

| Binding | Type | Web | API | Local resource |
|---|---|---|---|---|
| `DB` | D1 | ✓ | ✓ | `wacrm-db` (shared SQLite file in `.wrangler/state`) |
| `MEDIA` | R2 | ✓ | ✓ | `wacrm-media` |
| `BROADCAST_QUEUE` | Queue producer | ✓ | ✓ | `wacrm-broadcast` → consumer in API, DLQ `wacrm-broadcast-dlq` |
| `INBOUND_QUEUE` | Queue producer | | ✓ | `wacrm-inbound` → consumer in API, DLQ `wacrm-inbound-dlq` |
| `REALTIME` | Durable Object | ✓ (via `script_name`) | ✓ (defines class) | `RealtimeHub` |
| `API` | Service binding | ✓ | | web → api |
| Cron | Trigger | | ✓ | `* * * * *` |

The `database_id` values are placeholders. Wrangler's local mode never checks them. Replace them with real IDs at deploy time (phase 8).

## Commands

```bash
npm run preview
```
Builds with OpenNext, then runs **both** workers in the Workers runtime at http://127.0.0.1:8787 with shared local state.

```bash
npm run preview:all
```
Same, but skips the rebuild.

```bash
npm run dev
```
Plain `next dev` (fast refresh). `getCloudflareContext()` still works through Wrangler's local simulators.

```bash
npm run dev:api
```
Only the API worker on its own (default port 8787; stop the preview first or pass `--port`).

```bash
npm run cf-typegen
```
Regenerate binding types after editing either `wrangler.jsonc`.

```bash
npm run typecheck:api
```
Typecheck the API worker (`npm run typecheck` covers the Next app).

## Smoke tests

With `npm run preview` running:

```bash
curl http://127.0.0.1:8787/api/cf/health
```
Expect `"ok":true` with d1, r2, queue, durableObject and apiWorker all `true`.

```bash
curl -X POST "http://127.0.0.1:8787/cdn-cgi/local/explorer/api/local/scheduled?worker=wacrm-api" -H "Content-Type: application/json" -d "{\"cron\":\"* * * * *\"}"
```
Fires the API worker's cron handler; the terminal logs `[wacrm-api] [cron] <time> {"automations":{"processed":0}}`.

Ignore the `curl ".../cdn-cgi/local/scheduled"` hint Wrangler prints at startup. With two workers it targets the first one (the Next.js app), which has no cron handler, so it returns 500. Use the explorer command above.

`npm run db:reset:local` must run with **no** `wrangler dev` / `npm run preview` running: on Windows the running server keeps the database files locked (`EBUSY`). If it still fails with nothing visibly running, stop leftover processes with `Stop-Process -Name workerd` in PowerShell.

If the preview starts on 8788/8789 instead of 8787, another `wrangler dev` is still running. Stop it, or use the port shown in `Ready on ...`.

The API worker's `/dev/publish/:accountId` route is reachable when it runs alone via `npm run dev:api`. It returns 404 unless `ENVIRONMENT=development`.

## Environment and secrets

- Wrangler loads `.env.local` automatically in local dev (values show as `(hidden)` at startup).
- `NEXT_PUBLIC_*` values are inlined at build time.
- **Before deploying:** OpenNext also compiles `.env*` files into the worker bundle. For production, use `wrangler secret put` instead and make sure no secret-bearing `.env` file is present at build time (phase 8).

## Known warnings

- `OpenNext is not fully compatible with Windows`. Builds and runs fine here; switch to WSL if you hit odd runtime errors.
- `The "middleware" file convention is deprecated. Please use "proxy" instead.` **Do not rename** `src/middleware.ts` to `proxy.ts` yet: `proxy` runs on the Node runtime, which OpenNext supports only experimentally. The auth rewrite (phase 2) is the time to revisit this.
- `Duplicate key "options"` from a bundled dependency during `wrangler dev`. Harmless.

## Changes made in phase 0

- Next.js `16.3.5` → `16.4.6` (OpenNext 1.20.16 requires `>=16.4.5`), `eslint-config-next` to match.
- Added `@opennextjs/cloudflare`, `hono`, `wrangler`, `@cloudflare/workers-types`.
- `next.config.ts`: `images.unoptimized` (sharp can't run on Workers; the only image is a static logo), plus `initOpenNextCloudflareForDev()` for `next dev`.
- `src/app/api/cf/health/route.ts`: dev-only binding check.
- `tsconfig.json` excludes `workers/`, `.open-next/`, `.wrangler/`; ESLint ignores generated output.
