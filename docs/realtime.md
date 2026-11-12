# Realtime and presence (migration phase 5)

Replaces Supabase Realtime (`postgres_changes`) and the `member_presence` table with one **Durable Object per account** (`RealtimeHub`). App code is unchanged: `supabase.channel(...).on('postgres_changes', ...)` keeps working.

## Flow

```
any write (browser /api/db, server routes, webhook consumer, cron)
      │  data layer: engine.ts → emitChange()            src/lib/db/realtime.ts
      ▼
RealtimeHub Durable Object (one per account)             workers/api/src/realtime-hub.ts
      │  WebSocket (hibernation API)
      ▼
browser: channel().on('postgres_changes', …)             src/lib/db/realtime-client.ts
```

1. The browser asks `GET /api/realtime/ticket` (session cookie) for a 60-second signed ticket.
2. It opens `wss://<host>/api/realtime/socket?ticket=…`. The web worker's entry (`workers/web/entry.ts`) forwards the upgrade to the API worker, which verifies the ticket and connects the socket to the account's hub.
3. After every successful insert, update or delete on a realtime table, the data layer sends the full row to the hub, which forwards it to the account's sockets.

| Table | Who receives it |
|---|---|
| `messages`, `conversations`, `message_reactions` | every member of the account |
| `notifications` | only the user the notification belongs to |
| `member_presence` (virtual, no table) | every member of the account |

## Behaviour

- **Event shape** matches Supabase: `{ eventType: 'INSERT' | 'UPDATE' | 'DELETE', new, old, table, schema }`. `new` is the full row (booleans and JSON converted). `old` is the full row on DELETE and `{}` otherwise.
- **Filters** `column=eq.value` are applied in the browser. `event: '*'` and a specific event both work.
- **Upserts** are reported as `INSERT`.
- **One socket per tab**, shared by all channels. It closes when the last channel unsubscribes and reconnects with backoff (1 s up to 30 s) using a fresh ticket. Events sent while a tab was disconnected are not replayed (same as Supabase).
- **Publishing never fails a write.** If the hub is unreachable the write succeeds and a warning is logged.
- **Presence:** the existing heartbeat calls the `touch_presence` RPC every 30 s; the hub stores `{status, last_seen_at}` per user and tells everyone. New sockets get the current roster on connect. "Offline" is still derived in the browser from a stale `last_seen_at`.
- **Rows deleted by a cascade** (for example the messages of a deleted conversation) produce no event of their own; the parent's DELETE does.

## Security

- The ticket is an HMAC over `{accountId, userId, expiry}` signed with `BETTER_AUTH_SECRET`. The API worker needs the **same** secret as the web worker (`scripts/sync-api-dev-vars.mjs` copies it locally; `wrangler secret put` in production).
- The hub is only reachable through the API worker; the account comes from the ticket, never from the client.
- Sockets are receive-only apart from `ping`.

## Files

| File | Purpose |
|---|---|
| `workers/api/src/realtime-hub.ts` | Durable Object: sockets, fan-out, presence storage |
| `workers/api/src/index.ts` | `GET /api/realtime/socket` (ticket check, connects to the hub) |
| `workers/web/entry.ts` | Web worker entry: forwards the WebSocket upgrade, otherwise stock OpenNext |
| `src/app/api/realtime/ticket/route.ts`, `src/lib/realtime-ticket.ts` | Ticket issue / verify |
| `src/lib/db/realtime.ts` | `RealtimeSink`: routes changes to the right account hub |
| `src/lib/db/engine.ts` (`emitChange`), `src/lib/db/rpc.ts` | Publish points |
| `src/lib/db/realtime-client.ts` | Browser `channel()` implementation |

## Tests

- `src/lib/db/realtime.test.ts` (6), `src/lib/realtime-ticket.test.ts` (3).
- End-to-end against `npm run preview` (21 checks): forged, tampered and missing tickets rejected; message insert, conversation update and message delete reach other members; presence broadcast and snapshot; a notification reaches only its owner.

## Production notes (phase 8)

- `wrangler.jsonc` `main` is now `workers/web/entry.ts`, which imports the OpenNext build output.
- Set `BETTER_AUTH_SECRET` on **both** workers.
- VERIFY against current Cloudflare docs: Durable Object pricing on the $5 plan (requests, duration with hibernation), WebSocket message size limit (events carry a full row).
