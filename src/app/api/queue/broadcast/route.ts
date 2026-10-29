// ============================================================
// POST /api/queue/broadcast — QStash delivery worker.
//
// Called by QStash only (signature-verified), never by a browser. Each
// call runs one capped delivery pass for one broadcast and, while
// recipients remain pending, publishes the next pass. See
// lib/whatsapp/broadcast-queue.ts for the full flow.
//
// Lives outside /api/whatsapp/ on purpose: the middleware 401s any
// session-less request under that prefix, and QStash has no session.
//
// Status codes matter to QStash: 2xx acknowledges the message, 5xx
// makes QStash retry it (with backoff). A retry is safe — the pass
// only picks up recipients still 'pending'.
// ============================================================

import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  enqueueBroadcastPass,
  QUEUE_BUSY_DELAY_S,
  runBroadcastPass,
  verifyQStashSignature,
  type BroadcastQueueMessage,
} from '@/lib/whatsapp/broadcast-queue';

// One pass is QUEUE_PASS_SIZE sends at QUEUE_CONCURRENCY — normally
// well under a minute. 300 s is the Vercel Hobby ceiling.
export const maxDuration = 300;

function parseMessage(raw: string): BroadcastQueueMessage | null {
  try {
    const body = JSON.parse(raw) as Partial<BroadcastQueueMessage>;
    if (typeof body.broadcastId === 'string' && typeof body.accountId === 'string') {
      return { broadcastId: body.broadcastId, accountId: body.accountId };
    }
  } catch {
    // fall through
  }
  return null;
}

export async function POST(request: Request) {
  const raw = await request.text();

  if (!(await verifyQStashSignature(request, raw))) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  const message = parseMessage(raw);
  if (!message) {
    // Malformed — acknowledge so QStash doesn't retry it forever.
    return NextResponse.json({ error: 'Bad message' }, { status: 200 });
  }

  // The account id comes from a message we signed-and-published
  // ourselves, after an account-scoped auth check, so the service-role
  // client is safe here.
  const admin = supabaseAdmin();
  const origin = new URL(request.url).origin;

  try {
    const outcome = await runBroadcastPass(admin, message);

    if (outcome === 'continue') {
      await enqueueBroadcastPass(admin, message, { origin });
    } else if (outcome === 'busy') {
      await enqueueBroadcastPass(admin, message, {
        origin,
        delaySeconds: QUEUE_BUSY_DELAY_S,
      });
    }

    return NextResponse.json({ outcome });
  } catch (err) {
    console.error(
      `[queue/broadcast] pass failed for ${message.broadcastId}:`,
      err instanceof Error ? err.message : err
    );
    return NextResponse.json({ error: 'Pass failed' }, { status: 500 });
  }
}
