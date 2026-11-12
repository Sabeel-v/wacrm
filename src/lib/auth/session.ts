/**
 * Resolve the signed-in user (Better Auth) and their account + role
 * (profiles) for the current request. Used by the data layer to build
 * the RLS policy, and by the supabase.auth.getUser() compatibility shim.
 */
import { getEnv } from '@/lib/cf-env'
import { d1Runner, type D1Like } from '@/lib/db/runners'
import { isAccountRole, type AccountRole } from './roles'
import { getAuth } from './better-auth'
import { bootstrapAccount } from './bootstrap'

export interface SessionUser {
  id: string
  email: string
  name: string
  emailVerified: boolean
  image?: string | null
  createdAt?: string | Date
}

export interface SessionContext {
  user: SessionUser
  userId: string
  /** null only if the profile could not be created. */
  accountId: string | null
  role: AccountRole | null
}

export async function getSessionUser(headers: Headers): Promise<SessionUser | null> {
  const auth = await getAuth()
  const session = await auth.api.getSession({ headers })
  return (session?.user as SessionUser | undefined) ?? null
}

export async function getSessionContext(headers: Headers): Promise<SessionContext | null> {
  const user = await getSessionUser(headers)
  if (!user) return null

  const env = await getEnv()
  const runner = d1Runner(env.DB as unknown as D1Like)
  const load = () => runner.all(`SELECT account_id, account_role FROM profiles WHERE user_id = ?`, [user.id])

  let rows = await load()
  if (!rows.length) {
    // Self-heal an interrupted sign-up (see bootstrapAccount).
    await bootstrapAccount(runner, { id: user.id, email: user.email, name: user.name })
    rows = await load()
  }
  const row = rows[0]
  const role = row && isAccountRole(row.account_role) ? row.account_role : null
  return {
    user,
    userId: user.id,
    accountId: (row?.account_id as string | undefined) ?? null,
    role,
  }
}
