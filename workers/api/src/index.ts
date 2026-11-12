import { Hono } from 'hono'
import { setWorkerEnv } from '@/lib/cf-env'
import { consumeBroadcast, consumeInbound, type InboundEnvelope } from './queues'
import { handleInbound, handleVerify } from './webhook'

export { RealtimeHub } from './realtime-hub'

/**
 * wacrm API worker (Hono).
 *
 *   phase 4 (this): Meta webhook ingress → wacrm-inbound queue → processWebhook;
 *                   broadcast passes on wacrm-broadcast (replaces QStash)
 *   phase 5: authenticated realtime WebSocket
 *   phase 6: cron jobs (automation waits, flow timeout sweep)
 *
 * Shared app code (src/lib) reads bindings through getEnv(); setWorkerEnv()
 * makes this worker's env available to it.
 */

const app = new Hono<{ Bindings: Env }>()

const isDev = (env: Env) => env.ENVIRONMENT === 'development'

app.use('*', async (c, next) => {
  setWorkerEnv(c.env)
  await next()
})

app.get('/health', async (c) => {
  const checks: Record<string, boolean | string> = {}
  try {
    const row = await c.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>()
    checks.d1 = row?.ok === 1
  } catch (err) {
    checks.d1 = `error: ${(err as Error).message}`
  }
  try {
    await c.env.MEDIA.list({ limit: 1 })
    checks.r2 = true
  } catch (err) {
    checks.r2 = `error: ${(err as Error).message}`
  }
  checks.queues = typeof c.env.INBOUND_QUEUE?.send === 'function' && typeof c.env.BROADCAST_QUEUE?.send === 'function'
  checks.durableObject = typeof c.env.REALTIME?.idFromName === 'function'
  checks.secrets = !!(c.env as unknown as Record<string, unknown>).META_APP_SECRET && !!(c.env as unknown as Record<string, unknown>).ENCRYPTION_KEY
  const ok = Object.values(checks).every((v) => v === true)
  return c.json({ ok, worker: 'wacrm-api', checks }, ok ? 200 : 500)
})

// ── Meta WhatsApp webhook ─────────────────────────────────────────────
// Same path as the Next.js route, so production can point a Worker route
// for /api/whatsapp/webhook* straight here. /webhook/whatsapp is an alias.
app.get('/api/whatsapp/webhook', handleVerify)
app.post('/api/whatsapp/webhook', handleInbound)
app.get('/webhook/whatsapp', handleVerify)
app.post('/webhook/whatsapp', handleInbound)

// ── Dev-only helpers (404 outside ENVIRONMENT=development) ──────────
app.use('/dev/*', async (c, next) => {
  if (!isDev(c.env)) return c.notFound()
  await next()
})

/** Publish a test event to every socket connected to an account's hub. */
app.post('/dev/publish/:accountId', async (c) => {
  const stub = c.env.REALTIME.get(c.env.REALTIME.idFromName(c.req.param('accountId')))
  const reached = await stub.publish({ type: 'test', at: new Date().toISOString() })
  return c.json({ reached })
})

/** Realtime WebSocket, dev-only and UNAUTHENTICATED until phase 5. */
app.get('/dev/realtime/:accountId', async (c) => {
  const stub = c.env.REALTIME.get(c.env.REALTIME.idFromName(c.req.param('accountId')))
  return stub.fetch(c.req.raw)
})

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    setWorkerEnv(env)
    if (batch.queue === 'wacrm-inbound') return consumeInbound(batch as MessageBatch<InboundEnvelope>)
    if (batch.queue === 'wacrm-broadcast') return consumeBroadcast(batch)
    console.error(`[queue] no consumer for ${batch.queue}; acking ${batch.messages.length} message(s)`)
    batch.ackAll()
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    setWorkerEnv(env)
    // Phase 6: automation waits + flow timeout sweep.
    console.log(`[cron] ${controller.cron} at ${new Date(controller.scheduledTime).toISOString()}`)
  },
} satisfies ExportedHandler<Env>
