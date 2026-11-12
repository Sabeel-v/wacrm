import { describe, expect, it } from 'vitest'
import { signTicket, verifyTicket } from './realtime-ticket'

const claims = { accountId: 'acc-1', userId: 'user-1' }

describe('realtime tickets', () => {
  it('round-trips claims', async () => {
    const t = await signTicket('secret', claims)
    expect(await verifyTicket('secret', t)).toEqual(claims)
  })

  it('rejects a wrong secret, tampering and garbage', async () => {
    const t = await signTicket('secret', claims)
    expect(await verifyTicket('other', t)).toBeNull()
    const [body, sig] = t.split('.')
    const forged = btoa(JSON.stringify({ a: 'acc-2', u: 'user-1', e: Date.now() + 60_000 })).replace(/=+$/, '')
    expect(await verifyTicket('secret', `${forged}.${sig}`)).toBeNull()
    expect(await verifyTicket('secret', `${body}.AAAA`)).toBeNull()
    expect(await verifyTicket('secret', 'nonsense')).toBeNull()
    expect(await verifyTicket('secret', '')).toBeNull()
  })

  it('expires after 60 seconds', async () => {
    const now = 1_000_000
    const t = await signTicket('secret', claims, now)
    expect(await verifyTicket('secret', t, now + 59_000)).toEqual(claims)
    expect(await verifyTicket('secret', t, now + 61_000)).toBeNull()
  })
})
