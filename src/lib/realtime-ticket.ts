/**
 * Short-lived WebSocket tickets. The Next.js app (which knows the session)
 * signs `{accountId, userId, exp}`; the API worker (which owns the sockets)
 * verifies it. Browsers can't set headers on a WebSocket, and this keeps all
 * session logic out of the API worker.
 */
const TTL_MS = 60_000
const enc = new TextEncoder()

const b64url = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

async function key(secret: string, usage: 'sign' | 'verify') {
  return crypto.subtle.importKey('raw', enc.encode(`realtime-ticket:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, [usage])
}

export interface TicketClaims {
  accountId: string
  userId: string
}

export async function signTicket(secret: string, claims: TicketClaims, now = Date.now()): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify({ a: claims.accountId, u: claims.userId, e: now + TTL_MS })))
  const sig = await crypto.subtle.sign('HMAC', await key(secret, 'sign'), enc.encode(body))
  return `${body}.${b64url(sig)}`
}

export async function verifyTicket(secret: string, ticket: string, now = Date.now()): Promise<TicketClaims | null> {
  const [body, sig] = ticket.split('.')
  if (!body || !sig) return null
  try {
    const ok = await crypto.subtle.verify('HMAC', await key(secret, 'verify'), fromB64url(sig), enc.encode(body))
    if (!ok) return null
    const c = JSON.parse(new TextDecoder().decode(fromB64url(body))) as { a?: string; u?: string; e?: number }
    if (!c.a || !c.u || typeof c.e !== 'number' || c.e < now) return null
    return { accountId: c.a, userId: c.u }
  } catch {
    return null
  }
}
