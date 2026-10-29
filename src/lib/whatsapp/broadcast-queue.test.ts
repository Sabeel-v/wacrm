import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

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

vi.mock('./broadcast-core', async (orig) => ({
  ...(await orig<typeof import('./broadcast-core')>()),
  deliverBroadcast: (...a: unknown[]) => deliver(...a),
  finalizeBroadcastStatus: (...a: unknown[]) => finalize(...a),
}));

import {
  isQueueActive,
  QUEUE_ACTIVE_WINDOW_MS,
  QUEUE_CONCURRENCY,
  QUEUE_PASS_SIZE,
  queueBaseUrl,
  runBroadcastPass,
  verifyQStashSignature,
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

describe('verifyQStashSignature', () => {
  it('fails closed without signing keys or a signature', async () => {
    const req = new Request('https://x.test/api/queue/broadcast', {
      method: 'POST',
      headers: { 'upstash-signature': 'abc' },
    });
    expect(await verifyQStashSignature(req, '{}')).toBe(false);

    vi.stubEnv('QSTASH_CURRENT_SIGNING_KEY', 'k1');
    vi.stubEnv('QSTASH_NEXT_SIGNING_KEY', 'k2');
    const unsigned = new Request('https://x.test/api/queue/broadcast', {
      method: 'POST',
    });
    expect(await verifyQStashSignature(unsigned, '{}')).toBe(false);
  });

  it('rejects a forged signature', async () => {
    vi.stubEnv('QSTASH_CURRENT_SIGNING_KEY', 'k1');
    vi.stubEnv('QSTASH_NEXT_SIGNING_KEY', 'k2');
    const req = new Request('https://x.test/api/queue/broadcast', {
      method: 'POST',
      headers: { 'upstash-signature': 'not-a-jwt' },
    });
    expect(await verifyQStashSignature(req, '{}')).toBe(false);
  });
});

describe('queueBaseUrl', () => {
  it('prefers explicit config, then Vercel, then the request origin', () => {
    vi.stubEnv('BROADCAST_QUEUE_BASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', '');
    expect(queueBaseUrl('https://req.test/')).toBe('https://req.test');

    vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', 'app.vercel.app');
    expect(queueBaseUrl('https://req.test')).toBe('https://app.vercel.app');

    vi.stubEnv('BROADCAST_QUEUE_BASE_URL', 'https://crm.test/');
    expect(queueBaseUrl('https://req.test')).toBe('https://crm.test');
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
