// ============================================================
// Broadcast delivery on Cloudflare Queues (was QStash).
//
// One queue message per pass, consumed by the Hono API worker
// (workers/api, queue "wacrm-broadcast"):
//
//   enqueueBroadcastPass()  — send { broadcastId, accountId } to the
//                             BROADCAST_QUEUE binding (optionally delayed).
//   runBroadcastPass()      — (in the consumer) take the delivery lock,
//                             plan up to QUEUE_PASS_SIZE pending
//                             recipients, send them, release the lock.
//                             Returns whether anything is left.
//   the consumer            — re-enqueues while work remains; retries a
//                             failed pass with backoff, then dead-letters.
//
// Every pass reuses the resume machinery (claim / plan / deliver), so
// the lock that stops a double-send from two Resume clicks also stops a
// queue retry from racing a pass that is still running. A recipient
// leaves 'pending' as soon as it is sent, so a retried or duplicated
// message only picks up what is genuinely still outstanding.
// ============================================================

import type { SupabaseClient } from '@/lib/db/client-core';
import { getEnv } from '@/lib/cf-env';

import {
  BroadcastError,
  deliverBroadcast,
  finalizeBroadcastStatus,
} from '@/lib/whatsapp/broadcast-core';
import {
  claimBroadcastDelivery,
  planBroadcastResume,
  releaseBroadcastDelivery,
} from '@/lib/whatsapp/broadcast-resume';

/**
 * Recipients per pass. Each recipient costs a Meta API call plus D1
 * writes, and a Worker invocation has a subrequest limit (VERIFY current
 * value; historically 1 000 on the Paid plan), so passes stay small. A
 * 3 000-recipient campaign is ~30 queue messages.
 */
export const QUEUE_PASS_SIZE = 100;

/** Parallel Meta sends inside one pass. */
export const QUEUE_CONCURRENCY = 8;

/** How long to wait before retrying a pass that found the lock held. */
export const QUEUE_BUSY_DELAY_S = 30;

export {
  isQueueActive,
  QUEUE_ACTIVE_WINDOW_MS,
} from '@/lib/whatsapp/broadcast-queue-status';

export interface BroadcastQueueMessage {
  broadcastId: string;
  accountId: string;
}

/**
 * Always true on Cloudflare: the BROADCAST_QUEUE binding is declared in
 * wrangler.jsonc. (QStash was optional; the browser-driven send loop is
 * now only a fallback for a failed enqueue.)
 */
export function isBroadcastQueueEnabled(): boolean {
  return true;
}

/**
 * Enqueue one delivery pass and stamp the broadcast as queued.
 * Throws if the queue rejects the message; the caller decides whether
 * that is fatal (enqueue route) or retryable (consumer).
 */
export async function enqueueBroadcastPass(
  db: SupabaseClient,
  message: BroadcastQueueMessage,
  { delaySeconds }: { origin?: string; delaySeconds?: number } = {}
): Promise<void> {
  const env = await getEnv();
  await env.BROADCAST_QUEUE.send(
    message,
    delaySeconds ? { delaySeconds } : undefined
  );

  await db
    .from('broadcasts')
    .update({ delivery_queued_at: new Date().toISOString() })
    .eq('id', message.broadcastId);
}

/**
 * - `continue` — a pass ran and recipients are still pending.
 * - `done`     — nothing pending; the broadcast is finalized.
 * - `busy`     — another pass holds the lock; try again shortly.
 * - `stopped`  — the broadcast is gone, no longer 'sending', or can't
 *                be delivered (no WhatsApp config, broken template).
 */
export type PassOutcome = 'continue' | 'done' | 'busy' | 'stopped';

/** Error codes that a retry can't fix — stop the chain on these. */
const PERMANENT_ERRORS = new Set([
  'not_found',
  'whatsapp_not_configured',
  'template_malformed',
]);

async function countPending(
  db: SupabaseClient,
  broadcastId: string
): Promise<number> {
  const { count, error } = await db
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId)
    .eq('status', 'pending');
  if (error) throw new Error(`Failed to count pending recipients: ${error.message}`);
  return count ?? 0;
}

/**
 * Run one capped delivery pass for a broadcast. Throws on unexpected
 * failures (the queue consumer retries the message with backoff).
 */
export async function runBroadcastPass(
  db: SupabaseClient,
  { broadcastId, accountId }: BroadcastQueueMessage
): Promise<PassOutcome> {
  const { data: broadcast, error } = await db
    .from('broadcasts')
    .select('status')
    .eq('id', broadcastId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load broadcast: ${error.message}`);
  // Deleted, finished, or flipped out of 'sending' by the user.
  if (!broadcast || broadcast.status !== 'sending') return 'stopped';

  if (!(await claimBroadcastDelivery(db, accountId, broadcastId))) {
    return 'busy';
  }

  try {
    await db
      .from('broadcasts')
      .update({ delivery_queued_at: new Date().toISOString() })
      .eq('id', broadcastId);

    try {
      const { plan } = await planBroadcastResume(
        db,
        accountId,
        broadcastId,
        'pending',
        QUEUE_PASS_SIZE
      );
      await deliverBroadcast(db, plan, { concurrency: QUEUE_CONCURRENCY });
    } catch (err) {
      if (!(err instanceof BroadcastError)) throw err;

      if (PERMANENT_ERRORS.has(err.code)) {
        console.error(
          `[broadcast-queue] stopping ${broadcastId}: ${err.code} — ${err.message}`
        );
        // Clear the stamp so the detail page offers Resume right away
        // instead of showing "sending" until the window lapses.
        await db
          .from('broadcasts')
          .update({ delivery_queued_at: null })
          .eq('id', broadcastId);
        return 'stopped';
      }

      // 'nothing_to_resume': every loaded row was unsendable (now
      // stamped failed) or nothing was pending. Settle the status; the
      // pending count below decides whether another pass is needed.
      await finalizeBroadcastStatus(db, broadcastId);
    }
  } finally {
    await releaseBroadcastDelivery(db, broadcastId);
  }

  return (await countPending(db, broadcastId)) > 0 ? 'continue' : 'done';
}
