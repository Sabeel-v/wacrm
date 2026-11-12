# Cron jobs and storage (migration phase 6)

## Cron

The API worker has one Cron Trigger (`* * * * *`). Its `scheduled()` handler runs `runScheduledJobs()` in [`src/lib/cron/jobs.ts`](../src/lib/cron/jobs.ts). No external pinger and no `AUTOMATION_CRON_SECRET` are needed any more.

| Job | When (UTC minute) | What |
|---|---|---|
| `automations` | every minute | Resume due "wait" steps (`automation_pending_executions`), 50 per run. `src/lib/automations/cron.ts` |
| `flows` | every 5 minutes | Mark flow runs idle longer than their flow's timeout (default 24 h) as `timed_out`. `src/lib/flows/cron.ts` |
| `broadcasts` | every 5 minutes | Re-enqueue a broadcast that is still `sending` but had no delivery pass for 15 minutes (its queue chain died). Gives up after 24 h. Broadcasts stopped on purpose are left alone. |
| `auth` | hourly | Delete expired sessions, verification tokens and old rate-limit rows. |

- Jobs are independent: one failing is logged and the others still run.
- Each tick logs one line, e.g. `[cron] 2026-11-12T16:20:02.272Z {"automations":{"processed":0},"flows":{"swept":1},"broadcasts":{"revived":0}}`.
- Overlapping runs are safe: automation rows are claimed (`pending → running`) before they run, and flow runs are only updated while still `active`.
- An automation wait that throws is now marked `failed` instead of staying `running` forever.
- `GET /api/automations/cron` and `GET /api/flows/cron` still exist for manual runs (header `x-cron-secret` = `AUTOMATION_CRON_SECRET`). They return 503 if that secret isn't set.

### Trigger it locally

Wrangler does not fire cron triggers by itself in local dev. With `npm run preview` running:

```bash
curl -X POST "http://127.0.0.1:8787/cdn-cgi/local/explorer/api/local/scheduled?worker=wacrm-api" -H "Content-Type: application/json" -d "{\"cron\":\"* * * * *\"}"
```

The 5-minute and hourly jobs only run when the current minute matches (`:00`, `:05`, …), locally too.

### Known limitation

If the worker is killed in the middle of resuming an automation wait, that row stays `running` and is not retried (there is no claim timestamp to detect it). Same as before the migration.

## Storage (R2)

Supabase Storage was already replaced by R2 in phase 3 (`/api/storage/<bucket>/<path>`, buckets `avatars`, `flow-media`, `chat-media`, same path rules, MIME lists and size limits). Phase 6 finishes the read side:

| Added | Why |
|---|---|
| `Range` requests (`206`, `Content-Range`, `Accept-Ranges`) | Seeking in audio and video; Safari won't play video without it |
| `416` for a range past the end | Correct client behaviour instead of a 500 |
| `If-None-Match` → `304` | Browsers revalidate without downloading again |
| `Content-Length` on full responses | Progress bars and Meta's media fetcher |

Verified end to end (18 checks): upload, anonymous and wrong-folder uploads rejected, HTML upload rejected, public read, the range forms above, 304, delete.

### Production notes (phase 8)

- Set `NEXT_PUBLIC_SITE_URL` to the public HTTPS origin, so media links sent to Meta are absolute.
- Optional later: serve public media from an R2 custom domain to skip the worker on reads.
