import { beforeEach, describe, expect, it, vi } from 'vitest'

const sent: unknown[] = []
let d1: { prepare: (sql: string) => unknown; batch: (s: unknown[]) => Promise<unknown[]> }
vi.mock('@/lib/cf-env', () => ({
  getEnv: async () => ({
    DB: d1,
    BROADCAST_QUEUE: { send: async (m: unknown) => void sent.push(m) },
    REALTIME: { idFromName: (n: string) => n, get: () => ({ publish: async () => 0, touch: async () => {} }) },
  }),
}))
// The automation engine itself is covered by its own tests; here we only
// check that the drain claims rows and survives a failing one.
const resume = vi.fn()
vi.mock('@/lib/automations/engine', () => ({ resumePendingExecution: (...a: unknown[]) => resume(...a) }))

import { drainDueAutomations } from '@/lib/automations/cron'
import { hasSqlite, openTestDb, SEED } from '@/lib/db/test-utils'
import { sweepStaleFlowRuns } from '@/lib/flows/cron'
import { cleanupAuth, jobsDueAt, reviveStalledBroadcasts, runScheduledJobs } from './jobs'

type Sql = { prepare(sql: string): { all(...p: unknown[]): Record<string, unknown>[]; run(...p: unknown[]): { changes: number | bigint } } }

describe('jobsDueAt', () => {
  it('schedules by minute', () => {
    expect(jobsDueAt(new Date('2026-11-12T10:07:00Z'))).toEqual(['automations'])
    expect(jobsDueAt(new Date('2026-11-12T10:05:00Z'))).toEqual(['automations', 'flows', 'broadcasts'])
    expect(jobsDueAt(new Date('2026-11-12T10:00:00Z'))).toEqual(['automations', 'flows', 'broadcasts', 'auth'])
  })
})

describe.skipIf(!hasSqlite)('scheduled jobs on D1', () => {
  let db: Sql
  const q = (sql: string, ...p: unknown[]) => db.prepare(sql).all(...p)
  const run = (sql: string, ...p: unknown[]) => db.prepare(sql).run(...p)

  beforeEach(() => {
    const t = openTestDb()
    db = t.db as unknown as Sql
    // Minimal D1 facade over node:sqlite for serviceDb() and cleanupAuth().
    const stmt = (sql: string, params: unknown[] = []) => ({
      sql,
      params,
      bind: (...p: unknown[]) => stmt(sql, p),
      all: async () => ({ results: /^\s*(select|with)|returning/i.test(sql) ? db.prepare(sql).all(...(params as never[])) : (db.prepare(sql).run(...(params as never[])), []) }),
    })
    d1 = {
      prepare: (sql) => stmt(sql),
      batch: async (stmts) =>
        (stmts as { sql: string; params: unknown[] }[]).map((s) => {
          if (/^\s*(select|with)|returning/i.test(s.sql)) return { results: db.prepare(s.sql).all(...(s.params as never[])) }
          return { results: [], meta: { changes: Number(db.prepare(s.sql).run(...(s.params as never[])).changes) } }
        }),
    }
    sent.length = 0
    resume.mockReset()
  })

  const automationId = () => String(q('SELECT id FROM automations LIMIT 1')[0].id)
  const addPending = (id: string, runAt: string) =>
    run(
      `INSERT INTO automation_pending_executions (id, account_id, automation_id, user_id, next_step_position, run_at) VALUES (?, ?, ?, ?, 1, ?)`,
      id, SEED.account, automationId(), SEED.owner, runAt,
    )

  it('drainDueAutomations resumes only due rows and claims them', async () => {
    addPending('p-due', '2020-01-01T00:00:00.000Z')
    addPending('p-future', '2999-01-01T00:00:00.000Z')
    expect(await drainDueAutomations()).toEqual({ processed: 1 })
    expect(resume).toHaveBeenCalledTimes(1)
    expect(resume.mock.calls[0][0]).toMatchObject({ id: 'p-due', account_id: SEED.account, context: {} })
    const rows = Object.fromEntries(q('SELECT id, status FROM automation_pending_executions').map((r) => [r.id, r.status]))
    expect(rows).toEqual({ 'p-due': 'running', 'p-future': 'pending' })
    // Already claimed: a second (overlapping) run does nothing.
    expect(await drainDueAutomations()).toEqual({ processed: 0 })
  })

  it('a failing row is marked failed and does not block the next one', async () => {
    addPending('p-1', '2020-01-01T00:00:00.000Z')
    addPending('p-2', '2020-01-02T00:00:00.000Z')
    resume.mockRejectedValueOnce(new Error('boom'))
    expect(await drainDueAutomations()).toEqual({ processed: 1 })
    const rows = Object.fromEntries(q('SELECT id, status FROM automation_pending_executions').map((r) => [r.id, r.status]))
    expect(rows['p-1']).toBe('failed')
    expect(rows['p-2']).toBe('running')
  })

  it('sweepStaleFlowRuns times out only runs past their flow policy', async () => {
    const flowId = String(q('SELECT id FROM flows LIMIT 1')[0].id)
    const add = (id: string, contact: string, last: string) =>
      run(
        `INSERT INTO flow_runs (id, account_id, flow_id, user_id, contact_id, status, last_advanced_at) VALUES (?, ?, ?, ?, ?, 'active', ?)`,
        id, SEED.account, flowId, SEED.owner, contact, last,
      )
    run(`DELETE FROM flow_runs`)
    const now = new Date('2026-11-12T12:00:00.000Z')
    add('run-old', SEED.sara, '2026-11-10T00:00:00.000Z') // 60h
    add('run-new', SEED.omar, '2026-11-12T11:00:00.000Z') // 1h
    expect(await sweepStaleFlowRuns(now)).toEqual({ swept: 1 })
    const rows = Object.fromEntries(q('SELECT id, status, end_reason FROM flow_runs').map((r) => [r.id, r]))
    expect(rows['run-old']).toMatchObject({ status: 'timed_out', end_reason: 'stale_sweep' })
    expect(rows['run-new'].status).toBe('active')
    expect(q(`SELECT event_type FROM flow_run_events WHERE flow_run_id = 'run-old'`)).toEqual([{ event_type: 'timeout' }])
    expect(await sweepStaleFlowRuns(now)).toEqual({ swept: 0 })
  })

  it('reviveStalledBroadcasts re-enqueues only stalled sending broadcasts', async () => {
    const now = new Date('2026-11-12T12:00:00.000Z')
    const set = (status: string, queued: string | null) =>
      run(`UPDATE broadcasts SET status = ?, delivery_queued_at = ? WHERE id = ?`, status, queued, SEED.broadcast)

    set('sending', '2026-11-12T11:55:00.000Z') // a pass ran 5 min ago: healthy
    expect(await reviveStalledBroadcasts(now)).toEqual({ revived: 0 })
    set('sending', null) // stopped on purpose
    expect(await reviveStalledBroadcasts(now)).toEqual({ revived: 0 })
    set('sending', '2026-11-10T00:00:00.000Z') // older than the give-up window
    expect(await reviveStalledBroadcasts(now)).toEqual({ revived: 0 })
    set('sent', '2026-11-12T11:00:00.000Z') // finished
    expect(await reviveStalledBroadcasts(now)).toEqual({ revived: 0 })
    expect(sent).toHaveLength(0)

    set('sending', '2026-11-12T11:00:00.000Z') // stalled for an hour
    expect(await reviveStalledBroadcasts(now)).toEqual({ revived: 1 })
    expect(sent).toEqual([{ broadcastId: SEED.broadcast, accountId: SEED.account }])
    // Enqueueing re-stamps delivery_queued_at, so it isn't revived again next tick.
    const stamp = String(q('SELECT delivery_queued_at FROM broadcasts WHERE id = ?', SEED.broadcast)[0].delivery_queued_at)
    expect(stamp > '2026-11-12T11:00:00.000Z').toBe(true)
  })

  it('cleanupAuth deletes only expired rows', async () => {
    const now = new Date('2026-11-12T12:00:00.000Z')
    run(`INSERT INTO auth_sessions (id, user_id, token, expires_at) VALUES ('s-old', ?, 't-old', '2026-11-01T00:00:00.000Z'), ('s-live', ?, 't-live', '2026-12-01T00:00:00.000Z')`, SEED.owner, SEED.owner)
    run(`INSERT INTO auth_verifications (id, identifier, value, expires_at) VALUES ('v-old', 'a', 'b', '2026-11-01T00:00:00.000Z')`)
    run(`INSERT INTO auth_rate_limits (id, key, count, last_request) VALUES ('r-old', 'k1', 1, ?), ('r-new', 'k2', 1, ?)`, now.getTime() - 2 * 3_600_000, now.getTime() - 1000)
    expect(await cleanupAuth(now)).toEqual({ deleted: 3 })
    expect(q('SELECT id FROM auth_sessions').map((r) => r.id)).toEqual(['s-live'])
    expect(q('SELECT id FROM auth_rate_limits').map((r) => r.id)).toEqual(['r-new'])
  })

  it('runScheduledJobs isolates failures', async () => {
    addPending('p-due', '2020-01-01T00:00:00.000Z')
    run(`DROP TABLE flow_run_events`)
    run(`DROP TABLE flow_runs`)
    const results = await runScheduledJobs(Date.parse('2026-11-12T10:05:00Z'))
    expect(results.automations).toEqual({ processed: 1 })
    expect(results.flows).toHaveProperty('error')
    expect(results.broadcasts).toEqual({ revived: 0 })
  })
})
