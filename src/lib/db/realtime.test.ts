import { beforeEach, describe, expect, it, vi } from 'vitest'

const published: { account: string; event: Record<string, unknown> }[] = []
const touched: unknown[][] = []
vi.mock('@/lib/cf-env', () => ({
  getEnv: async () => ({
    REALTIME: {
      idFromName: (n: string) => n,
      get: (account: string) => ({
        publish: async (event: Record<string, unknown>) => (published.push({ account, event }), 1),
        touch: async (...a: unknown[]) => void touched.push([account, ...a]),
      }),
    },
  }),
}))

import { QueryBuilder } from './builder'
import { executeQuery } from './engine'
import { createRealtimeSink, type RealtimeSink } from './realtime'
import { executeRpc } from './rpc'
import { hasSqlite, openTestDb, SEED } from './test-utils'
import type { Row, SqlRunner } from './types'

describe.skipIf(!hasSqlite)('realtime publishing', () => {
  let runner: SqlRunner
  let calls: { table: string; eventType: string; rows: Row[] }[]
  let recorder: RealtimeSink
  const from = (table: string, realtime: RealtimeSink) =>
    new QueryBuilder((ast) => executeQuery(ast, { runner, policy: null, realtime }), table)

  beforeEach(() => {
    runner = openTestDb().runner
    calls = []
    published.length = 0
    touched.length = 0
    recorder = {
      change: async (table, eventType, rows) => void calls.push({ table, eventType, rows }),
      touch: async () => {},
    }
  })

  it('emits INSERT / UPDATE / DELETE with full API-shaped rows, even without a select', async () => {
    const { error } = await from('messages', recorder).insert({
      conversation_id: SEED.convSara, sender_type: 'agent', content_text: 'hi', ai_generated: true,
    })
    expect(error).toBeNull()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ table: 'messages', eventType: 'INSERT' })
    const row = calls[0].rows[0]
    expect(row.ai_generated).toBe(true) // boolean, not 1
    expect(row.created_at).toBeTruthy()

    await from('messages', recorder).update({ status: 'read' }).eq('id', row.id as string)
    expect(calls[1]).toMatchObject({ eventType: 'UPDATE' })
    expect(calls[1].rows[0].status).toBe('read')

    await from('messages', recorder).delete().eq('id', row.id as string)
    expect(calls[2]).toMatchObject({ eventType: 'DELETE' })
    expect(calls[2].rows[0].id).toBe(row.id)
  })

  it('emits nothing for other tables or when no row changed', async () => {
    await from('contacts', recorder).update({ name: 'X' }).eq('id', SEED.sara)
    await from('messages', recorder).update({ status: 'read' }).eq('id', 'missing')
    expect(calls).toHaveLength(0)
  })

  it('routes events to the right account hub; messages resolve it via the conversation', async () => {
    const sink = createRealtimeSink(runner)
    await from('messages', sink).insert({ conversation_id: SEED.convOmar, sender_type: 'customer', content_text: 'yo' })
    await from('conversations', sink).update({ unread_count: 3 }).eq('id', SEED.convSara)
    expect(published.map((p) => [p.account, p.event.table, p.event.eventType])).toEqual([
      [SEED.account, 'messages', 'INSERT'],
      [SEED.account, 'conversations', 'UPDATE'],
    ])
    expect(published[0].event.userId).toBeUndefined()
  })

  it('targets notifications at their owner and puts deleted rows in `old`', async () => {
    const sink = createRealtimeSink(runner)
    const { data } = await from('notifications', sink)
      .insert({ account_id: SEED.account, user_id: SEED.agent, type: 'conversation_assigned', title: 't' })
      .select('id')
      .single()
    expect(published[0].event).toMatchObject({ table: 'notifications', userId: SEED.agent })
    await from('notifications', sink).delete().eq('id', data.id)
    expect(published[1].event).toMatchObject({ eventType: 'DELETE', new: {}, old: { id: data.id } })
  })

  it('a hub failure never fails the write', async () => {
    const broken: RealtimeSink = { change: createRealtimeSink({ ...runner, all: async () => { throw new Error('boom') } }).change, touch: async () => {} }
    const { error } = await from('messages', broken).insert({ conversation_id: SEED.convSara, sender_type: 'agent', content_text: 'x' })
    expect(error).toBeNull()
  })

  it('bump_conversation_on_inbound publishes the conversation; touch_presence reaches the hub', async () => {
    const sink = createRealtimeSink(runner)
    await executeRpc('bump_conversation_on_inbound', { p_conversation_id: SEED.convSara, p_last_message_text: 'new' }, { runner, caller: 'service', ctx: null, realtime: sink })
    expect(published[0].event).toMatchObject({ table: 'conversations', eventType: 'UPDATE' })
    expect((published[0].event.new as Row).last_message_text).toBe('new')

    await executeRpc('touch_presence', { p_status: 'away' }, {
      runner, caller: 'user', realtime: sink,
      ctx: { userId: SEED.agent, accountId: SEED.account, role: 'agent', origin: 'browser' },
    })
    expect(touched).toEqual([[SEED.account, SEED.agent, 'away']])
  })
})
