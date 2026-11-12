/**
 * Browser data endpoint: replaces direct PostgREST access from the
 * browser. Every request runs under the caller's session with the RLS
 * port (src/lib/db/policy.ts) and never returns secret columns.
 *
 * Body: { type: 'query', ast } | { type: 'rpc', fn, args }
 * Response: a supabase-js style result { data, error, count, status }.
 */
import { NextResponse } from 'next/server'
import { getEnv } from '@/lib/cf-env'
import { getSessionContext } from '@/lib/auth/session'
import { errorResult, executeQuery } from '@/lib/db/engine'
import { anonymousPolicy, createPolicy } from '@/lib/db/policy'
import { createRealtimeSink } from '@/lib/db/realtime'
import { executeRpc } from '@/lib/db/rpc'
import { d1Runner, type D1Like } from '@/lib/db/runners'
import { DbQueryError, type DbResult } from '@/lib/db/types'
import { validateAst } from '@/lib/db/validate-ast'

const MAX_BODY_BYTES = 2 * 1024 * 1024

const respond = (result: DbResult) =>
  NextResponse.json(result, { status: 200, headers: { 'Cache-Control': 'no-store' } })

/** Reject cross-site callers (cookies are SameSite=Lax too; this is belt and braces). */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return true // same-origin fetches from older browsers / server-side calls
  // Compare with the Host header the browser sent: inside OpenNext,
  // request.url doesn't necessarily carry the public host. (X-Forwarded-Host
  // is deliberately ignored: a client can set it.)
  const host = request.headers.get('host')
  try {
    return !!host && new URL(origin).host === host
  } catch {
    return false
  }
}

export async function POST(request: Request) {
  try {
    if (!sameOrigin(request)) throw new DbQueryError('Cross-origin request rejected', '42501', 403)
    const raw = await request.text()
    if (raw.length > MAX_BODY_BYTES) throw new DbQueryError('Request body too large', 'PGRST413', 413)
    let body: { type?: string; ast?: unknown; fn?: unknown; args?: unknown }
    try {
      body = JSON.parse(raw)
    } catch {
      throw new DbQueryError('Invalid JSON body', 'PGRST100', 400)
    }

    const env = await getEnv()
    const runner = d1Runner(env.DB as unknown as D1Like)
    const session = await getSessionContext(request.headers)
    const ctx =
      session?.accountId && session.role
        ? { userId: session.userId, accountId: session.accountId, role: session.role, origin: 'browser' as const }
        : null

    if (body.type === 'query') {
      const ast = validateAst(body.ast)
      const policy = ctx ? createPolicy(ctx) : anonymousPolicy
      return respond(await executeQuery(ast, { runner, realtime: createRealtimeSink(runner), policy }))
    }

    if (body.type === 'rpc') {
      if (typeof body.fn !== 'string' || !/^[a-z_]{1,64}$/.test(body.fn)) {
        throw new DbQueryError('Invalid function name', 'PGRST100', 400)
      }
      const args = body.args && typeof body.args === 'object' ? (body.args as Record<string, unknown>) : {}
      const data = await executeRpc(body.fn, args, { runner, realtime: createRealtimeSink(runner), caller: ctx ? 'user' : 'anon', ctx })
      return respond({ data, error: null, count: null, status: 200, statusText: 'OK' })
    }

    throw new DbQueryError('Unknown request type', 'PGRST100', 400)
  } catch (err) {
    return respond(errorResult(err))
  }
}
