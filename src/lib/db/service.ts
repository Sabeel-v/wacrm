/**
 * Admin (service-role) D1 client: no policies, like the old Supabase
 * service key. For trusted server code only: the webhook processor,
 * queue consumers, engines, cron.
 *
 * Kept free of Next.js imports so it runs in both workers (the Next.js app
 * and the Hono API worker). The user-scoped client lives in ./server.ts.
 */
import { getEnv } from '@/lib/cf-env'
import { createDbClient, type AuthApi, type DbClient } from './client-core'
import { errorResult, executeQuery } from './engine'
import { executeRpc } from './rpc'
import { d1Runner, type D1Like } from './runners'
import { serverStorage } from './storage-server'

async function runner() {
  const env = await getEnv()
  return d1Runner(env.DB as unknown as D1Like)
}

const noSession: AuthApi = {
  getUser: async () => ({ data: { user: null }, error: null }),
  getSession: async () => ({ data: { session: null }, error: null }),
  signInWithPassword: async () => ({ data: { user: null, session: null }, error: null }),
  signUp: async () => ({ data: { user: null, session: null }, error: null }),
  signOut: async () => ({ error: null }),
  updateUser: async () => ({ data: { user: null }, error: null }),
  resetPasswordForEmail: async () => ({ data: {}, error: null }),
  onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
}

export function serviceDb(): DbClient {
  return createDbClient({
    query: async (ast) => executeQuery(ast, { runner: await runner(), policy: null }),
    rpc: async ({ fn, args }) => {
      try {
        const data = await executeRpc(fn, args, { runner: await runner(), caller: 'service', ctx: null })
        return { data, error: null, count: null, status: 200, statusText: 'OK' }
      } catch (e) {
        return errorResult(e)
      }
    },
    auth: noSession,
    storage: serverStorage(),
  })
}
