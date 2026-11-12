# WhatsApp webhook + queues (migration phase 4)

## What changed

| Before (Supabase / Vercel) | Now (Cloudflare) |
|---|---|
| Next.js route verified the signature, answered, then did **all** the work in `after()` (60 s budget; Workers would cut it short) | API worker verifies the signature, **enqueues**, answers in ~25 ms. A queue consumer does the work, with retries and a dead-letter queue |
| Inbox `messages.status` updated unconditionally: a late `sent` could overwrite `read` | Atomic forward-only update: `sending → sent → delivered → read`; `failed` only before delivery |
| Broadcast recipient status: check, then write (racy) | Same check, done atomically inside the UPDATE |
| Broadcast passes via **QStash** (optional; otherwise the browser tab drove sending) | **Cloudflare Queues** (`wacrm-broadcast`), always on. 100 recipients per pass, re-enqueued until done |
| `phone_normalized` (Postgres generated column) | Derived by the data layer on every contact write (fixes contact creation everywhere, see below) |

## Flow

```
Meta ──POST /api/whatsapp/webhook──▶ wacrm-web (Next.js) ──service binding──▶ wacrm-api (Hono)
                                     (forwarder, keeps the URL)                 │ verify X-Hub-Signature-256
                                                                                │ enqueue raw payload → 200
                                                                                ▼
                                                    queue "wacrm-inbound" ──▶ consumer: processWebhook()
                                                     (retries ×5, backoff)       contacts, messages, statuses,
                                                     └─▶ wacrm-inbound-dlq       reactions, flows, automations,
                                                                                 AI auto-reply, outbound webhooks

Broadcast "Send" ──▶ /api/whatsapp/broadcast/[id]/queue ──▶ queue "wacrm-broadcast" ──▶ consumer: runBroadcastPass()
                                                              (retries ×5) └─▶ wacrm-broadcast-dlq   100 recipients/pass,
                                                                                                    re-enqueue until done
```

| File | Purpose |
|---|---|
| `workers/api/src/webhook.ts` | Ingress: GET subscription check, POST signature check + enqueue (oversized payloads split per change) |
| `workers/api/src/queues.ts` | Consumers for `wacrm-inbound` and `wacrm-broadcast`; ack only after the work finished; exponential backoff |
| `src/lib/whatsapp/webhook-processor.ts` | All inbound processing (moved out of the Next.js route; no Next.js imports) |
| `src/lib/whatsapp/broadcast-queue.ts` | `enqueueBroadcastPass` (queue binding) + `runBroadcastPass` (unchanged logic) |
| `src/app/api/whatsapp/webhook/route.ts` | Thin forwarder so the Meta URL stays the same |
| `src/lib/cf-env.ts`, `src/lib/db/service.ts` | Let shared app code run in either worker |

**Idempotency:** a retried or redelivered webhook is safe. Inbound messages are deduped by `(conversation_id, wamid)` before any side effect (unread bump, flows, automations, AI, outbound webhooks). Statuses only move forward. Broadcast recipients leave `pending` as soon as they're sent, and a lock stops two passes overlapping.

## Run locally

```bash
npm run preview
```
Builds, copies the API worker's secrets (`ENCRYPTION_KEY`, `META_APP_SECRET`, `META_APP_ID`) from `.env.local` into `workers/api/.dev.vars` (git-ignored), and starts both workers on http://127.0.0.1:8787. The terminal shows each queue batch, e.g. `QUEUE wacrm-inbound 1/1 (55ms)`.

## Test with real WhatsApp messages (tunnel)

Meta must reach your PC over HTTPS.

1. Start the preview (`npm run preview`).
2. Open a public tunnel to it. Either press **`t`** in the Wrangler terminal (built-in tunnel), or run:

   ```bash
   cloudflared tunnel --url http://127.0.0.1:8787
   ```

   (Install cloudflared first: `winget install Cloudflare.cloudflared`.) Copy the `https://….trycloudflare.com` URL it prints.
3. Sign in, go to **Settings → WhatsApp** and connect your number. Note the **verify token** you enter there.
4. In the Meta developer dashboard (your app → WhatsApp → Configuration):
   - **Callback URL:** `https://<tunnel-host>/api/whatsapp/webhook`
   - **Verify token:** the one from step 3, then click *Verify and save* (this hits the GET check)
   - Subscribe to the **messages** webhook field (plus `message_template_status_update` if you use templates)
5. `META_APP_SECRET` in `.env.local` must be your Meta app's **App Secret**, or every POST is rejected with 401 (you'll see `rejected request with invalid signature` in the terminal).
6. Send a WhatsApp message to your business number. It appears in the inbox; refresh the page, since live updates arrive in phase 5.
7. Send a small broadcast (a few contacts) and watch `QUEUE wacrm-broadcast` lines and the recipient statuses update.

The quick-tunnel URL changes every time it restarts, so update the Callback URL in Meta when it does.

## Production notes (phase 8)

- Set the API worker's secrets: `npx wrangler secret put META_APP_SECRET -c workers/api/wrangler.jsonc`, and the same for `ENCRYPTION_KEY` and `META_APP_ID`. Use the **same** `ENCRYPTION_KEY` as the web worker.
- Optional: add a Worker **route** `your-domain/api/whatsapp/webhook*` → `wacrm-api`, so Meta reaches the API worker directly and skips the forwarding hop. The URL in Meta stays the same.
- Dead-letter queues (`wacrm-inbound-dlq`, `wacrm-broadcast-dlq`) have no consumer: failed messages wait there for inspection or replay. Watch their depth in the Cloudflare dashboard.
- QStash is no longer used: `QSTASH_TOKEN`, `QSTASH_*_SIGNING_KEY` and `BROADCAST_QUEUE_BASE_URL` can be removed. `@upstash/qstash` can be uninstalled once you're confident.
- Limits to VERIFY against current Cloudflare docs: queue message size (payloads over 100 KB are split per change), consumer wall time, subrequests per invocation (why passes are 100 recipients), max retries/delay.

## Fixed along the way

- **Contact creation was failing everywhere** after the D1 switch: `contacts.phone_normalized` was a Postgres *generated* column and no code set it, so every new contact (webhook, contact form, CSV import, API) hit `NOT NULL constraint failed`. The data layer now derives it from `phone` on every insert, upsert and update, like the generated column did (`src/lib/db/engine.ts`, `COMPUTED`), with tests.
- Inbound media mirroring no longer pulls the browser client into server code (`src/lib/storage/media-path.ts`).

## Known limitations (unchanged from before, tracked for later)

- Media is mirrored before the dedupe check, so a redelivered media message re-downloads it (no duplicate rows).
- The in-memory API rate limiter (`src/lib/rate-limit.ts`) is per isolate on Workers, so it's weaker than one shared limit.
- The browser-driven broadcast loop is still in the code as a fallback, but only runs if enqueueing fails.
- Inbound queue messages in a batch are processed one after another (keeps per-conversation order).
