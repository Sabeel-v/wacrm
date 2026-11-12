import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// --- Scenario knobs the mock reads -----------------------------------------
// `cookie`   — whether a Better Auth session cookie is present at all.
// `verified` — whether the signed session cache verifies (getCookieCache).
let cookie = false
let verified = false

vi.mock('better-auth/cookies', () => ({
  getSessionCookie: () => (cookie ? 'token' : null),
  getCookieCache: async () => (verified ? { session: { id: 's' }, user: { id: 'u' } } : null),
}))

// Imported after the mock is registered.
const { middleware } = await import('./middleware')

beforeEach(() => {
  process.env.BETTER_AUTH_SECRET = 'test-secret'
  cookie = false
  verified = false
})

const req = (path: string) => new NextRequest(new URL(path, 'http://localhost:3000'))
const location = (res: Response) => res.headers.get('location')

describe('middleware (Better Auth)', () => {
  it('redirects a verified signed-in user off /login to /dashboard', async () => {
    cookie = verified = true
    const res = await middleware(req('/login'))
    expect(res.status).toBe(307)
    expect(location(res)).toBe('http://localhost:3000/dashboard')
  })

  it('sends a signed-in user with an invite token to /join/<token>', async () => {
    cookie = verified = true
    const res = await middleware(req('/signup?invite=abc%20123'))
    expect(location(res)).toBe('http://localhost:3000/join/abc%20123')
  })

  it('does NOT redirect off /login on a cookie that fails verification (no redirect loop)', async () => {
    cookie = true
    verified = false
    const res = await middleware(req('/login'))
    expect(location(res)).toBeNull()
  })

  it('redirects an unauthenticated user from protected pages to /login', async () => {
    for (const p of ['/dashboard', '/inbox', '/flows/abc', '/agents', '/quick-replies', '/notifications', '/settings']) {
      const res = await middleware(req(p))
      expect(location(res), p).toBe('http://localhost:3000/login')
    }
  })

  it('does not treat lookalike paths as protected', async () => {
    const res = await middleware(req('/flowsheet'))
    expect(location(res)).toBeNull()
  })

  it('passes through a signed-in user on a protected page', async () => {
    cookie = true
    const res = await middleware(req('/inbox'))
    expect(location(res)).toBeNull()
    expect(res.status).toBe(200)
  })

  it('401s WhatsApp API calls without a session, but never the Meta webhook', async () => {
    const api = await middleware(req('/api/whatsapp/send'))
    expect(api.status).toBe(401)
    const hook = await middleware(req('/api/whatsapp/webhook'))
    expect(hook.status).toBe(200)
  })
})
