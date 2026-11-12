/**
 * Realtime publishing: the server side of Supabase's `postgres_changes`.
 *
 * The data layer calls `RealtimeSink.change()` after every successful write
 * to a realtime table, and the RPCs call `touch()` for presence. The sink
 * forwards to the account's RealtimeHub Durable Object, which fans the event
 * out to every connected browser of that account.
 *
 * Publishing is best-effort: a hub problem is logged and never fails the
 * write that triggered it.
 */
import { getEnv } from '@/lib/cf-env'
import type { Row, SqlRunner } from './types'

/** Tables whose changes are pushed to browsers. */
export const REALTIME_TABLES: ReadonlySet<string> = new Set([
  'messages',
  'conversations',
  'message_reactions',
  'notifications',
])

export type ChangeType = 'INSERT' | 'UPDATE' | 'DELETE'

export interface RealtimeSink {
  /** `rows` are API-shaped rows (what a select would return). */
  change(table: string, eventType: ChangeType, rows: Row[]): Promise<void>
  /** Presence heartbeat from a signed-in member. */
  touch(accountId: string, userId: string, status: 'online' | 'away'): Promise<void>
}

/** What the hub receives and forwards to sockets. */
export interface HubEvent {
  type: 'change'
  table: string
  eventType: ChangeType
  new: Row
  old: Row
  /** When set, only this user's sockets receive the event. */
  userId?: string
}

interface HubStub {
  publish(event: HubEvent): Promise<number>
  touch(userId: string, status: 'online' | 'away'): Promise<void>
}

async function hubFor(accountId: string): Promise<HubStub> {
  const env = await getEnv()
  const ns = env.REALTIME as unknown as { idFromName(n: string): unknown; get(id: unknown): HubStub }
  return ns.get(ns.idFromName(accountId))
}

/** Resolve account ids for rows that only carry conversation_id. */
async function accountsByConversation(runner: SqlRunner, ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const unique = [...new Set(ids)]
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50)
    const rows = await runner.all(
      `SELECT id, account_id FROM conversations WHERE id IN (${chunk.map(() => '?').join(',')})`,
      chunk,
    )
    for (const r of rows) map.set(String(r.id), String(r.account_id))
  }
  return map
}

export function createRealtimeSink(runner: SqlRunner): RealtimeSink {
  return {
    async change(table, eventType, rows) {
      if (!REALTIME_TABLES.has(table) || !rows.length) return
      try {
        const needLookup = rows.filter((r) => !r.account_id && r.conversation_id).map((r) => String(r.conversation_id))
        const lookup = needLookup.length ? await accountsByConversation(runner, needLookup) : new Map<string, string>()
        await Promise.all(
          rows.map(async (row) => {
            const accountId =
              (row.account_id as string | undefined) ?? lookup.get(String(row.conversation_id ?? ''))
            if (!accountId) return
            const event: HubEvent = {
              type: 'change',
              table,
              eventType,
              new: eventType === 'DELETE' ? {} : row,
              old: eventType === 'DELETE' ? row : {},
              // Notifications are personal.
              ...(table === 'notifications' && row.user_id ? { userId: String(row.user_id) } : {}),
            }
            await (await hubFor(accountId)).publish(event)
          }),
        )
      } catch (e) {
        console.warn('[realtime] publish failed:', (e as Error).message)
      }
    },
    async touch(accountId, userId, status) {
      try {
        await (await hubFor(accountId)).touch(userId, status)
      } catch (e) {
        console.warn('[realtime] presence touch failed:', (e as Error).message)
      }
    },
  }
}
