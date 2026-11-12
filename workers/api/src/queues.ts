/**
 * Queue consumers for the API worker.
 *
 *   wacrm-inbound   → one Meta webhook payload per message → processWebhook()
 *   wacrm-broadcast → one broadcast delivery pass per message → runBroadcastPass()
 *
 * A message is acked only after its work finished. Throwing work is
 * retried with exponential backoff; after max_retries (wrangler.jsonc) the
 * queue moves it to the dead-letter queue (wacrm-*-dlq) for inspection.
 */
import { serviceDb } from '@/lib/db/service'
import {
  enqueueBroadcastPass,
  QUEUE_BUSY_DELAY_S,
  runBroadcastPass,
  type BroadcastQueueMessage,
} from '@/lib/whatsapp/broadcast-queue'
import { processWebhook } from '@/lib/whatsapp/webhook-processor'

export interface InboundEnvelope {
  kind: 'meta_webhook'
  receivedAt: string
  payload: unknown
}

/** Exponential backoff: 10 s, 20 s, 40 s … capped at 10 minutes. */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(600, 10 * 2 ** Math.max(0, attempts - 1))
}

export async function consumeInbound(batch: MessageBatch<InboundEnvelope>): Promise<void> {
  // Sequential on purpose: keeps per-conversation effects in arrival order.
  for (const message of batch.messages) {
    try {
      if (message.body?.kind !== 'meta_webhook') {
        console.error('[queue:inbound] dropping unknown message', JSON.stringify(message.body)?.slice(0, 200))
        message.ack()
        continue
      }
      await processWebhook(message.body.payload)
      message.ack()
    } catch (err) {
      console.error(
        `[queue:inbound] attempt ${message.attempts} failed:`,
        err instanceof Error ? err.message : err,
      )
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) })
    }
  }
}

function isBroadcastMessage(v: unknown): v is BroadcastQueueMessage {
  const m = v as BroadcastQueueMessage | null
  return !!m && typeof m.broadcastId === 'string' && typeof m.accountId === 'string'
}

export async function consumeBroadcast(batch: MessageBatch<unknown>): Promise<void> {
  for (const message of batch.messages) {
    if (!isBroadcastMessage(message.body)) {
      console.error('[queue:broadcast] dropping malformed message', JSON.stringify(message.body)?.slice(0, 200))
      message.ack()
      continue
    }
    const pass = message.body
    try {
      const db = serviceDb()
      const outcome = await runBroadcastPass(db, pass)
      if (outcome === 'continue') {
        await enqueueBroadcastPass(db, pass)
      } else if (outcome === 'busy') {
        await enqueueBroadcastPass(db, pass, { delaySeconds: QUEUE_BUSY_DELAY_S })
      }
      console.log(`[queue:broadcast] ${pass.broadcastId}: ${outcome}`)
      message.ack()
    } catch (err) {
      console.error(
        `[queue:broadcast] ${pass.broadcastId} attempt ${message.attempts} failed:`,
        err instanceof Error ? err.message : err,
      )
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) })
    }
  }
}
