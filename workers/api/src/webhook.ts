/**
 * Meta WhatsApp webhook ingress.
 *
 *   GET  — subscription check (hub.challenge), against whatsapp_config tokens
 *   POST — verify X-Hub-Signature-256 over the raw body, enqueue, return 200
 *
 * Nothing slow happens here: Meta gets its answer in milliseconds and the
 * work runs in the wacrm-inbound queue consumer, with retries + DLQ.
 */
import type { Context } from 'hono'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import { verifyWebhookSubscription } from '@/lib/whatsapp/webhook-processor'
import type { InboundEnvelope } from './queues'

/** Stay under the per-message queue size limit (VERIFY: 128 KB) with headroom. */
export const MAX_QUEUE_MESSAGE_BYTES = 100 * 1024

interface MetaPayload {
  object?: string
  entry?: { id?: string; changes?: unknown[]; [k: string]: unknown }[]
}

/**
 * Split an oversized payload into one payload per change (each still a
 * valid Meta webhook body), so every queue message fits the size limit.
 */
export function splitPayload(payload: MetaPayload, rawLength: number): MetaPayload[] {
  if (rawLength <= MAX_QUEUE_MESSAGE_BYTES) return [payload]
  const parts: MetaPayload[] = []
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      parts.push({ ...payload, entry: [{ ...entry, changes: [change] }] })
    }
  }
  return parts.length ? parts : [payload]
}

export async function handleVerify(c: Context<{ Bindings: Env }>) {
  const result = await verifyWebhookSubscription(new URL(c.req.url).searchParams)
  return c.body(result.body, result.status as 200, { 'Content-Type': result.contentType })
}

export async function handleInbound(c: Context<{ Bindings: Env }>) {
  // Raw bytes first: the HMAC is over exactly what Meta sent.
  const raw = await c.req.text()
  if (!verifyMetaWebhookSignature(raw, c.req.header('x-hub-signature-256') ?? null)) {
    // 401 (not 200) so Meta's dashboard shows a misconfigured secret loudly.
    console.warn('[webhook] rejected request with invalid signature')
    return c.json({ error: 'Invalid signature' }, 401)
  }

  let payload: MetaPayload
  try {
    payload = JSON.parse(raw)
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  const receivedAt = new Date().toISOString()
  const parts = splitPayload(payload, raw.length)
  try {
    const messages = parts.map((p) => ({ body: { kind: 'meta_webhook', receivedAt, payload: p } satisfies InboundEnvelope }))
    if (messages.length === 1) await c.env.INBOUND_QUEUE.send(messages[0].body)
    else await c.env.INBOUND_QUEUE.sendBatch(messages)
  } catch (err) {
    // Not enqueued → 500, so Meta redelivers instead of the event being lost.
    console.error('[webhook] enqueue failed:', err instanceof Error ? err.message : err)
    return c.json({ error: 'Temporarily unavailable' }, 500)
  }
  return c.json({ status: 'received' }, 200)
}
