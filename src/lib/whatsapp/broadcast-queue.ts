// ============================================================
// QStash-driven broadcast delivery.
//
// Opt-in: active only when QSTASH_TOKEN is set. Without it the wizard
// keeps its browser-driven send loop and nothing here runs.
//
// The flow, one QStash message per pass:
//
//   enqueueBroadcastPass()  — publish { broadcastId, accountId } to
//                             POST /api/queue/broadcast.
//   runBroadcastPass()      — (inside that route) take the delivery
//                             lock, plan up to QUEUE_PASS_SIZE pending
//                             recipients, send them, release the lock.
//                             Returns whether anything is left.
//   the route               — re-enqueues itself while work remains.
//
// Every pass reuses the resume machinery (claim / plan / deliver), so
// the lock that stops a double-send from two Resume clicks also stops a
// QStash retry from racing a pass that is still running. A recipient
// leaves 'pending' as soon as it is sent, so a retried or duplicated
// QStash message only picks up what is genuinely still outstanding.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { Client, Receiver } from '@upstash/qstash';

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
 * Recipients per pass. At QUEUE_CONCURRENCY parallel sends a pass of
 * 250 takes roughly 15–30 s, far inside the worker route's 300 s cap,
 * and a 3 000-recipient campaign is ~12 QStash messages.
 */
export const QUEUE_PASS_SIZE = 250;

/** Parallel Meta sends inside one pass. */
export const QUEUE_CONCURRENCY = 8;

/** How long to wait before retrying a pass that found the lock held. */
export const QUEUE_BUSY_DELAY_S = 30;

export {
  isQueueActive,
  QUEUE_ACTIVE_WINDOW_MS,
} from '@/lib/whatsapp/broadcast-queue-status';

/** Route QStash calls back into. Outside /api/whatsapp/ — see middleware. */
export const QUEUE_WORKER_PATH = '/api/queue/broadcast';

export interface BroadcastQueueMessage {
  broadcastId: string;
  accountId: string;
}

export function isBroadcastQueueEnabled(): boolean {
  return Boolean(process.env.QSTASH_TOKEN?.trim());
}

/**
 * Public base URL QStash should call. Explicit config first, then
 * Vercel's production domain (set automatically on Vercel), then the
 * origin of the request that triggered the enqueue.
 *
 * Preview deployments sit behind Vercel Deployment Protection, which
 * QStash can't pass — set BROADCAST_QUEUE_BASE_URL to the production
 * domain if you test there.
 */
export function queueBaseUrl(fallbackOrigin?: string): string {
  const explicit =
    process.env.BROADCAST_QUEUE_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercel) return `https://${vercel.replace(/\/+$/, '')}`;

  if (fallbackOrigin) return fallbackOrigin.replace(/\/+$/, '');
  throw new Error(
    'Cannot resolve the public URL for QStash callbacks — set BROADCAST_QUEUE_BASE_URL.'
  );
}

/**
 * Publish one delivery pass and stamp the broadcast as queued.
 * Throws if QStash rejects the publish — the caller decides whether
 * that is fatal (enqueue route) or retryable (worker route → 500).
 */
export async function enqueueBroadcastPass(
  db: SupabaseClient,
  message: BroadcastQueueMessage,
  {
    origin,
    delaySeconds,
  }: { origin?: string; delaySeconds?: number } = {}
): Promise<void> {
  // Token and region URL (QSTASH_URL) are read from the environment.
  const client = new Client({ token: process.env.QSTASH_TOKEN });
  await client.publishJSON({
    url: `${queueBaseUrl(origin)}${QUEUE_WORKER_PATH}`,
    body: message,
    retries: 3,
    ...(delaySeconds ? { delay: delaySeconds } : {}),
  });

  await db
    .from('broadcasts')
    .update({ delivery_queued_at: new Date().toISOString() })
    .eq('id', message.broadcastId);
}

/**
 * Check the `Upstash-Signature` header against the raw body. Fails
 * closed: no signing keys configured means no request is trusted.
 */
export async function verifyQStashSignature(
  request: Request,
  rawBody: string
): Promise<boolean> {
  const signature = request.headers.get('upstash-signature');
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY?.trim();
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY?.trim();
  if (!signature || !currentSigningKey || !nextSigningKey) return false;

  try {
    const receiver = new Receiver({ currentSigningKey, nextSigningKey });
    return await receiver.verify({ signature, body: rawBody });
  } catch {
    return false;
  }
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
 * failures (the route turns that into a 500 so QStash retries).
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
