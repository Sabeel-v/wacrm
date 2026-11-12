import { Hono } from "hono";

export { RealtimeHub } from "./realtime-hub";

/**
 * wacrm API worker (Hono).
 *
 * Phase 0 skeleton: proves every binding works locally. Real handlers
 * land in later phases:
 *   - phase 4: POST /webhook/whatsapp (verify HMAC → INBOUND_QUEUE)
 *              and the inbound / broadcast queue consumers
 *   - phase 5: authenticated realtime WebSocket
 *   - phase 6: cron jobs (automation waits, flow timeout sweep)
 */

const app = new Hono<{ Bindings: Env }>();

const isDev = (env: Env) => env.ENVIRONMENT === "development";

app.get("/health", async (c) => {
  const checks: Record<string, boolean | string> = {};

  try {
    const row = await c.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    checks.d1 = row?.ok === 1;
  } catch (err) {
    checks.d1 = `error: ${(err as Error).message}`;
  }

  try {
    await c.env.MEDIA.list({ limit: 1 });
    checks.r2 = true;
  } catch (err) {
    checks.r2 = `error: ${(err as Error).message}`;
  }

  checks.queues = typeof c.env.INBOUND_QUEUE?.send === "function";
  checks.durableObject = typeof c.env.REALTIME?.idFromName === "function";

  const ok = Object.values(checks).every((v) => v === true);
  return c.json({ ok, worker: "wacrm-api", checks }, ok ? 200 : 500);
});

// ── Dev-only helpers (404 outside ENVIRONMENT=development) ──────────
app.use("/dev/*", async (c, next) => {
  if (!isDev(c.env)) return c.notFound();
  await next();
});

/** Push a test message through the inbound queue → consumer logs it. */
app.post("/dev/enqueue", async (c) => {
  await c.env.INBOUND_QUEUE.send({ kind: "test", at: new Date().toISOString() });
  return c.json({ enqueued: true });
});

/** Publish a test event to every socket connected to an account's hub. */
app.post("/dev/publish/:accountId", async (c) => {
  const stub = c.env.REALTIME.get(c.env.REALTIME.idFromName(c.req.param("accountId")));
  const reached = await stub.publish({ type: "test", at: new Date().toISOString() });
  return c.json({ reached });
});

/**
 * Realtime WebSocket. Phase 0 is dev-only and UNAUTHENTICATED — phase 5
 * adds session validation and derives the account from the session
 * instead of the URL.
 */
app.get("/dev/realtime/:accountId", async (c) => {
  const stub = c.env.REALTIME.get(c.env.REALTIME.idFromName(c.req.param("accountId")));
  return stub.fetch(c.req.raw);
});

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      // Phase 0: log and ack. Real consumers arrive in phase 4.
      console.log(`[queue:${batch.queue}]`, JSON.stringify(message.body));
      message.ack();
    }
    void env;
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    // Phase 0: prove the cron trigger fires. Real jobs arrive in phase 6.
    console.log(`[cron] ${controller.cron} at ${new Date(controller.scheduledTime).toISOString()}`);
    void env;
  },
} satisfies ExportedHandler<Env>;
