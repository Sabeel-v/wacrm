import { describe, expect, it, vi } from 'vitest'

// The processor module imports the data layer and engines; stub them so this
// pure-logic test doesn't need Cloudflare bindings.
vi.mock('@/lib/db/service', () => ({ serviceDb: () => ({}) }))
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: vi.fn() }))
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: vi.fn() }))
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: vi.fn() }))
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: vi.fn() }))

import { statusesAllowedBefore } from './webhook-processor'

const MESSAGE = ['sending', 'sent', 'delivered', 'read'] as const
const RECIPIENT = ['pending', 'sent', 'delivered', 'read', 'replied'] as const

/** Apply a sequence of status webhooks the way the guarded UPDATE does. */
function replay(ladder: readonly string[], start: string, events: string[]): string {
  let current = start
  for (const e of events) if (statusesAllowedBefore(ladder, e).includes(current)) current = e
  return current
}

describe('status ordering guard (atomic forward-only UPDATE)', () => {
  it('a late "sent" or "delivered" can never overwrite "read" (the Supabase-era bug)', () => {
    expect(replay(MESSAGE, 'sent', ['read', 'delivered', 'sent'])).toBe('read')
    expect(replay(RECIPIENT, 'pending', ['read', 'sent', 'delivered'])).toBe('read')
  })

  it('in-order statuses still advance', () => {
    expect(replay(MESSAGE, 'sending', ['sent', 'delivered', 'read'])).toBe('read')
    expect(replay(RECIPIENT, 'pending', ['sent', 'delivered', 'read', 'replied'])).toBe('replied')
  })

  it('failed is accepted only before delivery, and is terminal', () => {
    expect(replay(MESSAGE, 'sent', ['failed'])).toBe('failed')
    expect(replay(MESSAGE, 'delivered', ['failed'])).toBe('delivered')
    expect(replay(MESSAGE, 'sent', ['failed', 'delivered', 'read'])).toBe('failed')
    expect(replay(RECIPIENT, 'pending', ['failed'])).toBe('failed')
    expect(replay(RECIPIENT, 'read', ['failed'])).toBe('read')
  })

  it('replays (same status twice) and unknown statuses change nothing', () => {
    expect(statusesAllowedBefore(MESSAGE, 'sending')).toEqual([])
    expect(replay(MESSAGE, 'delivered', ['delivered'])).toBe('delivered')
    expect(statusesAllowedBefore(MESSAGE, 'deleted')).toEqual([])
  })
})
