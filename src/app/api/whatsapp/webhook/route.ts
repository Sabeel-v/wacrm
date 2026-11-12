/**
 * Meta WhatsApp webhook — forwarder.
 *
 * The webhook is handled by the Hono API worker (workers/api): it verifies
 * the X-Hub-Signature-256, enqueues the payload on the "wacrm-inbound"
 * queue, and answers Meta immediately. Processing runs in the queue
 * consumer (src/lib/whatsapp/webhook-processor.ts) with retries and a
 * dead-letter queue, instead of Next's after().
 *
 * This route only forwards over the service binding, so the URL configured
 * in Meta (…/api/whatsapp/webhook) keeps working unchanged. In production
 * you can also route that path straight to the API worker (see
 * docs/webhook-queues.md) and skip this hop.
 */
import { getEnv } from '@/lib/cf-env'

async function forward(request: Request): Promise<Response> {
  const env = await getEnv()
  const url = new URL(request.url)
  // Hostname is ignored by service bindings; path + query are what matter.
  const target = new URL(`/api/whatsapp/webhook${url.search}`, 'https://wacrm-api')
  return env.API.fetch(
    new Request(target, {
      method: request.method,
      headers: request.headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer(),
    }),
  )
}

export const GET = forward
export const POST = forward
