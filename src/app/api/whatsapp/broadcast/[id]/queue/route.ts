// ============================================================
// POST /api/whatsapp/broadcast/[id]/queue
//
// Hands a freshly planned broadcast (recipient rows inserted, status
// 'sending') to the QStash worker, so delivery no longer depends on
// the wizard's browser tab staying open.
//
// 501 { code: 'queue_disabled' } when QSTASH_TOKEN isn't set — the
// wizard treats that as "drive the send loop from the browser", which
// is the behaviour without QStash.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  enqueueBroadcastPass,
  isBroadcastQueueEnabled,
  isQueueActive,
} from '@/lib/whatsapp/broadcast-queue';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!isBroadcastQueueEnabled()) {
      return NextResponse.json(
        { error: 'Background delivery is not configured', code: 'queue_disabled' },
        { status: 501 }
      );
    }

    // Same gate as the batch send endpoint — this puts real messages
    // on real phones.
    const { supabase, accountId, userId } = await requireRole('agent');

    const limit = checkRateLimit(`broadcast:${userId}`, RATE_LIMITS.broadcast);
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;

    const { data: broadcast, error } = await supabase
      .from('broadcasts')
      .select('id, status, delivery_queued_at')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (error || !broadcast) {
      return NextResponse.json({ error: 'Broadcast not found' }, { status: 404 });
    }
    if (broadcast.status !== 'sending') {
      return NextResponse.json(
        { error: `Broadcast is '${broadcast.status}', not ready to send` },
        { status: 409 }
      );
    }
    // A chain is already running — a second one would only spin on the
    // delivery lock.
    if (isQueueActive(broadcast.delivery_queued_at)) {
      return NextResponse.json({ success: true, broadcast_id: id, queued: true });
    }

    await enqueueBroadcastPass(
      supabaseAdmin(),
      { broadcastId: id, accountId },
      { origin: new URL(request.url).origin }
    );

    return NextResponse.json(
      { success: true, broadcast_id: id, queued: true },
      { status: 202 }
    );
  } catch (error) {
    console.error('Error in broadcast queue POST:', error);
    return toErrorResponse(error);
  }
}
