/**
 * Server-side D1 clients (route handlers, server components, libs).
 *
 *   createServerDb()  — scoped to the signed-in user's session (policies
 *                       applied, like the Supabase anon key + user JWT).
 *   serviceDb()       — admin client: no policies, like the service key.
 *                       Only for trusted server code (webhook, queues,
 *                       engines, cron).
 */
import { headers as nextHeaders } from 'next/headers'
import { getEnv } from '@/lib/cf-env'
import { getSessionContext, type SessionContext } from '@/lib/auth/session'
import {
  createDbClient,
  toCompatUser,
  type AuthApi,
  type DbClient,
} from './client-core'
import { executeQuery, errorResult } from './engine'
import { anonymousPolicy, createPolicy } from './policy'
import { executeRpc } from './rpc'
import { d1Runner, type D1Like } from './runners'
import { serverStorage } from './storage-server'
import type { DbResult } from './types'

async function runner() {
  const env = await getEnv()
  return d1Runner(env.DB as unknown as D1Like)
}

const notOnServer = (name: string) => async () => ({
  data: { user: null, session: null } as never,
  error: { message: `supabase.auth.${name}() is browser-only in the D1 data layer`, code: 'not_supported', details: null, hint: null },
})

function serverAuth(getCtx: () => Promise<SessionContext | null>): AuthApi {
  return {
    async getUser() {
      const s = await getCtx()
      return s
        ? { data: { user: toCompatUser(s.user) }, error: null }
        : { data: { user: null }, error: { message: 'Auth session missing!', code: 'session_missing', details: null, hint: null } }
    },
    async getSession() {
      const s = await getCtx()
      const user = toCompatUser(s?.user)
      return { data: { session: user ? { access_token: '', user } : null }, error: null }
    },
    signInWithPassword: notOnServer('signInWithPassword'),
    signUp: notOnServer('signUp'),
    signOut: async () => ({ error: null }),
    updateUser: notOnServer('updateUser'),
    resetPasswordForEmail: notOnServer('resetPasswordForEmail') as AuthApi['resetPasswordForEmail'],
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  }
}

const ok = (data: unknown): DbResult => ({ data, error: null, count: null, status: 200, statusText: 'OK' })

/**
 * Client bound to the current request's session. Pass `requestHeaders`
 * where next/headers isn't available (e.g. middleware).
 */
export async function createServerDb(requestHeaders?: Headers): Promise<DbClient> {
  const h = requestHeaders ?? new Headers(await nextHeaders())
  let ctxPromise: Promise<SessionContext | null> | undefined
  const getCtx = () => (ctxPromise ??= getSessionContext(h))

  const policyFor = async () => {
    const s = await getCtx()
    return s?.accountId && s.role
      ? createPolicy({ userId: s.userId, accountId: s.accountId, role: s.role, origin: 'server' })
      : anonymousPolicy
  }

  return createDbClient({
    query: async (ast) => executeQuery(ast, { runner: await runner(), policy: await policyFor() }),
    rpc: async ({ fn, args }) => {
      try {
        const s = await getCtx()
        const ctx = s?.accountId && s.role
          ? { userId: s.userId, accountId: s.accountId, role: s.role, origin: 'server' as const }
          : null
        return ok(await executeRpc(fn, args, { runner: await runner(), caller: ctx ? 'user' : 'anon', ctx }))
      } catch (e) {
        return errorResult(e)
      }
    },
    auth: serverAuth(getCtx),
    storage: serverStorage(),
  })
}

/** Admin client (no policies). Lives in ./service.ts so it has no Next.js imports. */
export { serviceDb } from './service'
