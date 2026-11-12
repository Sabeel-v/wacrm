import type { SqlRunner } from '@/lib/db/types'

/**
 * Port of the Postgres `handle_new_user()` trigger (migration 017):
 * a new user gets their own account and an `owner` profile in it.
 *
 * Idempotent and atomic (one D1 batch), so it is safe to call again if a
 * sign-up was interrupted. D1 can't wrap Better Auth's user insert and
 * this in one transaction, so getSessionContext() re-runs it for any
 * user that somehow has no profile.
 */
export async function bootstrapAccount(
  runner: SqlRunner,
  user: { id: string; email: string; name?: string | null },
): Promise<void> {
  const existing = await runner.all(`SELECT 1 FROM profiles WHERE user_id = ?`, [user.id])
  if (existing.length) return

  const fullName = (user.name ?? '').trim()
  const accountId = crypto.randomUUID()
  await runner.batch([
    {
      sql: `INSERT INTO accounts (id, name, owner_user_id) VALUES (?, ?, ?)`,
      params: [accountId, fullName || user.email || 'My account', user.id],
    },
    {
      sql: `INSERT INTO profiles (user_id, account_id, account_role, full_name, email) VALUES (?, ?, 'owner', ?, ?)`,
      params: [user.id, accountId, fullName, user.email ?? ''],
    },
  ])
}
