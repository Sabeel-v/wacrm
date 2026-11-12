import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@/lib/db/client-core';

import { BroadcastError } from './broadcast-core';

const claim = vi.fn();
const release = vi.fn();
const plan = vi.fn();
const deliver = vi.fn();
const finalize = vi.fn();

vi.mock('./broadcast-resume', () => ({
  claimBroadcastDelivery: (...a: unknown[]) => claim(...a),
  releaseBroadcastDelivery: (...a: unknown[]) => release(...a),
  planBroadcastResume: (...a: unknown[]) => plan(...a),
}));

const queueSend = vi.fn();
vi.mock('@/lib/cf-env', () => ({
  getEnv: async () => ({ BROADCAST_QUEUE: { send: (...a: unknown[]) => queueSend(...a) } }),
}));

vi.mock('./broadcast-core', async (orig) => ({
  ...(await orig<typeof import('./broadcast-core')>()),
  deliverBroadcast: (...a: unknown[]) => deliver(...a),
  finalizeBroadcastStatus: (...a: unknown[]) => finalize(...a),
}));

import {
  enqueueBroadcastPass,
  isQueueActive,
  QUEUE_ACTIVE_WINDOW_MS,
  QUEUE_CONCURRENCY,
  QUEUE_PASS_SIZE,
  runBroadcastPass,
} from './broadcast-queue';

interface DbFixture {
  status?: string | null;
  pending?: number;
}

/** Minimal chainable stand-in: broadcast lookup, updates, pending count. */
function fakeDb(fx: DbFixture, updates: Record<string, unknown>[] = []) {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        update: (row: Record<string, unknown>) => {
          updates.push(row);
          return b;
        },
        maybeSingle: async () => ({
          data: fx.status === null ? null : { status: fx.status ?? 'sending' },
          error: null,
        }),
        then: (resolve: (r: unknown) => unknown) =>
          resolve(
            table === 'broadcast_recipients'
              ? { count: fx.pending ?? 0, error: null }
              : { error: null }
          ),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

const MSG = { broadcastId: 'bc-1', accountId: 'acct-1' };

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('runBroadcastPass', () => {
  it('sends one capped pass and continues while recipients remain', async () => {
    claim.mockResolvedValue(true);
    plan.mockResolvedValue({ plan: { broadcastId: 'bc-1' } });

    const outcome = await runBroadcastPass(fakeDb({ pending: 40 }), MSG);

    expect(outcome).toBe('continue');
    expect(plan).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      'bc-1',
      'pending',
      QUEUE_PASS_SIZE
    );
    expect(deliver).toHaveBeenCalledWith(
      expect.anything(),
      { broadcastId: 'bc-1' },
      { concurrency: QUEUE_CONCURRENCY }
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it('is done when nothing is left pending', async () => {
    claim.mockResolvedValue(true);
    plan.mockResolvedValue({ plan: {} });
    expect(await runBroadcastPass(fakeDb({ pending: 0 }), MSG)).toBe('done');
  });

  it('backs off when another pass holds the lock', async () => {
    claim.mockResolvedValue(false);
    expect(await runBroadcastPass(fakeDb({}), MSG)).toBe('busy');
    expect(plan).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('stops for a broadcast that is gone or no longer sending', async () => {
    expect(await runBroadcastPass(fakeDb({ status: null }), MSG)).toBe('stopped');
    expect(await runBroadcastPass(fakeDb({ status: 'sent' }), MSG)).toBe('stopped');
    expect(claim).not.toHaveBeenCalled();
  });

  it('stops on a permanent error and clears the queued stamp', async () => {
    claim.mockResolvedValue(true);
    plan.mockRejectedValue(
      new BroadcastError('whatsapp_not_configured', 'nope', 400)
    );
    const updates: Record<string, unknown>[] = [];

    const outcome = await runBroadcastPass(fakeDb({ pending: 10 }, updates), MSG);

    expect(outcome).toBe('stopped');
    expect(updates).toContainEqual({ delivery_queued_at: null });
    expect(release).toHaveBeenCalledOnce();
  });

  it('settles and re-checks when the loaded slice had nothing sendable', async () => {
    claim.mockResolvedValue(true);
    plan.mockRejectedValue(new BroadcastError('nothing_to_resume', 'none', 400));

    expect(await runBroadcastPass(fakeDb({ pending: 5 }), MSG)).toBe('continue');
    expect(finalize).toHaveBeenCalledOnce();
  });

  it('releases the lock and rethrows unexpected failures', async () => {
    claim.mockResolvedValue(true);
    plan.mockRejectedValue(new Error('db down'));

    await expect(runBroadcastPass(fakeDb({}), MSG)).rejects.toThrow('db down');
    expect(release).toHaveBeenCalledOnce();
  });
});

describe('enqueueBroadcastPass (Cloudflare Queues)', () => {
  it('sends the pass to the BROADCAST_QUEUE binding and stamps the broadcast', async () => {
    const updates: Record<string, unknown>[] = [];
    await enqueueBroadcastPass(fakeDb({}, updates), MSG);
    expect(queueSend).toHaveBeenCalledWith(MSG, undefined);
    expect(updates[0]).toHaveProperty('delivery_queued_at');
  });

  it('passes a delay through to the queue (busy back-off)', async () => {
    await enqueueBroadcastPass(fakeDb({}), MSG, { delaySeconds: 30 });
    expect(queueSend).toHaveBeenCalledWith(MSG, { delaySeconds: 30 });
  });

  it('does not stamp the broadcast when the queue rejects the message', async () => {
    queueSend.mockRejectedValueOnce(new Error('queue unavailable'));
    const updates: Record<string, unknown>[] = [];
    await expect(enqueueBroadcastPass(fakeDb({}, updates), MSG)).rejects.toThrow('queue unavailable');
    expect(updates).toEqual([]);
  });
});

describe('isQueueActive', () => {
  it('is true only inside the active window', () => {
    const now = Date.parse('2026-10-29T12:00:00Z');
    expect(isQueueActive(null, now)).toBe(false);
    expect(isQueueActive('2026-10-29T11:59:00Z', now)).toBe(true);
    expect(
      isQueueActive(new Date(now - QUEUE_ACTIVE_WINDOW_MS - 1).toISOString(), now)
    ).toBe(false);
  });
});
