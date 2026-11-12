import { NextResponse } from 'next/server'
import { getEnv } from '@/lib/cf-env'
import { getSessionContext } from '@/lib/auth/session'
import { signTicket } from '@/lib/realtime-ticket'

/** Hands a signed-in user a 60 s ticket for the realtime WebSocket. */
export async function GET(request: Request) {
  const session = await getSessionContext(request.headers)
  if (!session?.accountId || !session.role) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const env = (await getEnv()) as unknown as { BETTER_AUTH_SECRET?: string }
  if (!env.BETTER_AUTH_SECRET) return NextResponse.json({ error: 'Realtime not configured' }, { status: 503 })
  const ticket = await signTicket(env.BETTER_AUTH_SECRET, { accountId: session.accountId, userId: session.userId })
  return NextResponse.json({ ticket }, { headers: { 'Cache-Control': 'no-store' } })
}
