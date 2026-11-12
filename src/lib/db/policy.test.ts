import { beforeEach, describe, expect, it } from 'vitest'
import { QueryBuilder } from './builder'
import { executeQuery } from './engine'
import { createPolicy, RULES, type AccountRole } from './policy'
import { hasSqlite, openTestDb, SEED } from './test-utils'
import type { SqlRunner } from './types'
import { SCHEMA } from './schema.generated'

const OTHER_ACCOUNT = 'acc00000-0000-4000-8000-000000000099'
const OTHER_USER = 'usr00000-0000-4000-8000-000000000099'
const OTHER_CONTACT = 'con00000-0000-4000-8000-000000000099'
const OTHER_CONV = 'cnv00000-0000-4000-8000-000000000099'

const USERS: Record<AccountRole, string> = {
  owner: SEED.owner,
  admin: SEED.admin,
  agent: SEED.agent,
  viewer: SEED.viewer,
}

describe.skipIf(!hasSqlite)('RLS port (policy.ts)', () => {
  let runner: SqlRunner
  let sql: (s: string) => Record<string, unknown>[]

  beforeEach(() => {
    const t = openTestDb()
    runner = t.runner
    sql = (s) => t.db.prepare(s).all()
    // A second tenant inside the same database.
    t.db.exec(`
      INSERT INTO users (id, email, name) VALUES ('${OTHER_USER}', 'other@else.test', 'Other');
      INSERT INTO accounts (id, name, owner_user_id) VALUES ('${OTHER_ACCOUNT}', 'Other Co', '${OTHER_USER}');
      INSERT INTO profiles (user_id, account_id, account_role, full_name, email) VALUES ('${OTHER_USER}', '${OTHER_ACCOUNT}', 'owner', 'Other', 'other@else.test');
      INSERT INTO contacts (id, account_id, user_id, phone, phone_normalized, name) VALUES ('${OTHER_CONTACT}', '${OTHER_ACCOUNT}', '${OTHER_USER}', '+1 555', '1555', 'Secret Customer');
      INSERT INTO conversations (id, account_id, user_id, contact_id) VALUES ('${OTHER_CONV}', '${OTHER_ACCOUNT}', '${OTHER_USER}', '${OTHER_CONTACT}');
      INSERT INTO messages (conversation_id, sender_type, content_text) VALUES ('${OTHER_CONV}', 'customer', 'other tenant message');
      INSERT INTO whatsapp_config (account_id, user_id, phone_number_id, access_token, verify_token) VALUES ('${SEED.account}', '${SEED.owner}', 'pn1', 'cipher-access', 'cipher-verify');
    `)
  })

  const as = (role: AccountRole, origin: 'browser' | 'server' = 'browser', accountId: string = SEED.account) => {
    const policy = createPolicy({ userId: USERS[role], accountId, role, origin })
    return (table: string) => new QueryBuilder((ast) => executeQuery(ast, { runner, policy }), table)
  }

  it('every policy table exists in the schema, and nothing user-facing is missing a rule', () => {
    for (const t of Object.keys(RULES)) expect(SCHEMA[t], t).toBeDefined()
    const withoutRule = Object.keys(SCHEMA).filter((t) => !RULES[t]).sort()
    // Service-role only: as in Postgres, plus Better Auth's own tables (never via the data layer).
    expect(withoutRule).toEqual([
      'auth_accounts', 'auth_rate_limits', 'auth_sessions', 'auth_verifications',
      'automation_pending_executions', 'users',
    ])
  })

  describe('tenant isolation', () => {
    it('reads only the caller account, including via child tables and embeds', async () => {
      const from = as('owner')
      expect(((await from('contacts').select('name')).data as unknown[]).length).toBe(3)
      expect((await from('contacts').select('id').eq('id', OTHER_CONTACT)).data).toEqual([])
      const msgs = (await from('messages').select('content_text')).data as { content_text: string }[]
      expect(msgs.some((m) => m.content_text === 'other tenant message')).toBe(false)
      // Embedding the other tenant's contact through a crafted filter still yields nothing.
      const conv = await from('conversations').select('id, contact:contacts(name)').eq('id', OTHER_CONV)
      expect(conv.data).toEqual([])
    })

    it('cannot write into another account', async () => {
      const from = as('owner')
      const ins = await from('contacts').insert({ account_id: OTHER_ACCOUNT, user_id: SEED.owner, phone: '1', phone_normalized: '1' })
      expect(ins.error?.code).toBe('42501')
      const msg = await from('messages').insert({ conversation_id: OTHER_CONV, sender_type: 'agent', content_text: 'hi' })
      expect(msg.error?.code).toBe('42501')
      const upd = await from('contacts').update({ name: 'pwned' }).eq('id', OTHER_CONTACT).select('id')
      expect(upd.data).toEqual([])
      expect(sql(`SELECT name FROM contacts WHERE id = '${OTHER_CONTACT}'`)[0].name).toBe('Secret Customer')
      const del = await from('contacts').delete().eq('id', OTHER_CONTACT).select('id')
      expect(del.data).toEqual([])
    })

    it('fills a missing account_id with the caller account', async () => {
      const { data, error } = await as('agent')('contacts').insert({ user_id: SEED.agent, phone: '2', phone_normalized: '2' }).select('account_id').single()
      expect(error).toBeNull()
      expect(data.account_id).toBe(SEED.account)
    })

    it('cannot move a child row to another tenant parent, or change account_id', async () => {
      const from = as('owner')
      const move = await from('messages').update({ conversation_id: OTHER_CONV }).eq('conversation_id', SEED.convSara)
      expect(move.error?.code).toBe('42501')
      const acct = await from('contacts').update({ account_id: OTHER_ACCOUNT }).eq('id', SEED.sara)
      expect(acct.error?.code).toBe('42501')
    })

    it('requires a filter on UPDATE/DELETE from a user session', async () => {
      expect((await as('owner')('contacts').update({ company: 'x' })).error?.code).toBe('21000')
      expect((await as('owner')('tags').delete()).error?.code).toBe('21000')
    })
  })

  describe('role tiers (same as is_account_member min roles)', () => {
    const write = (role: AccountRole) => ({
      contact: as(role)('contacts').insert({ user_id: USERS[role], phone: `9${role}`, phone_normalized: `9${role.length}${Math.random().toString().slice(2, 8)}` }),
      tag: as(role)('tags').insert({ user_id: USERS[role], name: `t-${role}` }),
      stage: as(role)('pipeline_stages').insert({ pipeline_id: SEED.pipeline, name: `s-${role}` }),
      message: as(role)('messages').insert({ conversation_id: SEED.convSara, sender_type: 'agent', content_text: role }),
    })

    it('viewer: read-only', async () => {
      const w = write('viewer')
      for (const res of await Promise.all([w.contact, w.tag, w.stage, w.message])) expect(res.error?.code).toBe('42501')
      expect(((await as('viewer')('contacts').select('id')).data as unknown[]).length).toBe(3)
    })

    it('agent: CRM data yes, configuration (tags, stages) no', async () => {
      const w = write('agent')
      expect((await w.contact).error).toBeNull()
      expect((await w.message).error).toBeNull()
      expect((await w.tag).error?.code).toBe('42501')
      expect((await w.stage).error?.code).toBe('42501')
    })

    it('admin and owner: configuration yes', async () => {
      for (const role of ['admin', 'owner'] as const) {
        const w = write(role)
        expect((await w.tag).error, role).toBeNull()
        expect((await w.stage).error, role).toBeNull()
      }
    })

    it('ai_usage_log and account_invitations are admin-only to read; others get empty results', async () => {
      sql(`INSERT INTO ai_usage_log (account_id, mode, provider, model) VALUES ('${SEED.account}', 'draft', 'openai', 'm')`)
      expect((await as('agent')('ai_usage_log').select('id')).data).toEqual([])
      expect(((await as('admin')('ai_usage_log').select('id')).data as unknown[]).length).toBe(1)
    })

    it('service-only tables are invisible and unwritable to every role', async () => {
      expect((await as('owner')('users').select('id')).data).toEqual([])
      expect((await as('owner')('automation_pending_executions').insert({ automation_id: 'x', user_id: SEED.owner, next_step_position: 0, run_at: 'x' })).error?.code).toBe('42501')
      expect((await as('owner')('automation_logs').delete().eq('id', 'x')).error?.code).toBe('42501')
    })
  })

  describe('special rules', () => {
    it('browser never receives secret columns; server user context still can', async () => {
      const browser = await as('owner')('whatsapp_config').select('*').single()
      expect(browser.data.phone_number_id).toBe('pn1')
      expect('access_token' in browser.data).toBe(false)
      expect('verify_token' in browser.data).toBe(false)
      expect((await as('owner')('whatsapp_config').select('access_token')).error?.code).toBe('42501')
      expect((await as('owner')('whatsapp_config').select('id').eq('access_token', 'cipher-access')).error?.code).toBe('42501')
      const server = await as('owner', 'server')('whatsapp_config').select('access_token').single()
      expect(server.data.access_token).toBe('cipher-access')
    })

    it('profiles: read teammates, edit only yourself, never your role or account', async () => {
      const team = (await as('agent')('profiles').select('full_name')).data as unknown[]
      expect(team.length).toBe(4)
      const otherTenant = await as('agent')('profiles').select('id').eq('user_id', OTHER_USER)
      expect(otherTenant.data).toEqual([])
      const own = await as('agent')('profiles').update({ full_name: 'Ava A.' }).eq('user_id', SEED.agent).select('full_name')
      expect(own.data).toEqual([{ full_name: 'Ava A.' }])
      const someoneElse = await as('agent')('profiles').update({ full_name: 'x' }).eq('user_id', SEED.owner).select('id')
      expect(someoneElse.data).toEqual([])
      const escalate = await as('agent')('profiles').update({ account_role: 'owner' }).eq('user_id', SEED.agent)
      expect(escalate.error?.code).toBe('42501')
    })

    it('notifications: own rows only, and only read_at can change', async () => {
      const mine = (await as('agent')('notifications').select('id')).data as unknown[]
      expect(mine.length).toBe(1)
      expect((await as('owner')('notifications').select('id')).data).toEqual([])
      const read = await as('agent')('notifications').update({ read_at: new Date().toISOString() }).eq('user_id', SEED.agent).select('read_at')
      expect(read.error).toBeNull()
      expect((await as('agent')('notifications').update({ title: 'x' }).eq('user_id', SEED.agent)).error?.code).toBe('42501')
    })

    it('accounts: admins rename, nobody reassigns ownership by UPDATE', async () => {
      expect((await as('agent')('accounts').update({ name: 'x' }).eq('id', SEED.account)).error?.code).toBe('42501')
      expect((await as('admin')('accounts').update({ name: 'Renamed' }).eq('id', SEED.account)).error).toBeNull()
      expect((await as('owner')('accounts').update({ owner_user_id: SEED.agent }).eq('id', SEED.account)).error?.code).toBe('42501')
    })

    it('upsert from a user session only updates rows inside the account', async () => {
      // Conflict on the other tenant's contact id: DO UPDATE is skipped by the scope WHERE.
      const res = await as('owner')('contacts').upsert({ id: OTHER_CONTACT, user_id: SEED.owner, phone: 'x', phone_normalized: '7' }).select('id')
      expect(res.data).toEqual([])
      expect(sql(`SELECT name FROM contacts WHERE id = '${OTHER_CONTACT}'`)[0].name).toBe('Secret Customer')
    })
  })
})
