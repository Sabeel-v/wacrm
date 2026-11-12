import { beforeEach, describe, expect, it } from 'vitest'
import type { PolicyContext } from './policy'
import { executeRpc, toFtsQuery, type RpcContext } from './rpc'
import { hasSqlite, openTestDb, SEED } from './test-utils'
import type { SqlRunner } from './types'

describe.skipIf(!hasSqlite)('RPC ports', () => {
  let runner: SqlRunner
  let sql: (s: string) => Record<string, unknown>[]
  beforeEach(() => {
    const t = openTestDb()
    runner = t.runner
    sql = (s) => t.db.prepare(s).all()
  })

  const user = (userId: string, role: PolicyContext['role']): RpcContext => ({
    runner,
    caller: 'user',
    ctx: { userId, accountId: SEED.account, role, origin: 'browser' },
  })
  const anon = (): RpcContext => ({ runner, caller: 'anon', ctx: null })
  const service = (): RpcContext => ({ runner, caller: 'service', ctx: null })

  it('anonymous callers can only reach anon functions — never service ones', async () => {
    await expect(executeRpc('create_broadcast_with_recipients', {}, anon())).rejects.toMatchObject({ code: '42501' })
    await expect(executeRpc('set_member_role', {}, anon())).rejects.toMatchObject({ code: '42501' })
    expect(await executeRpc('peek_invitation', { p_token_hash: 'nope' }, anon())).toEqual({ ok: false, reason: 'not_found' })
  })

  it('signed-in users cannot call service functions', async () => {
    await expect(executeRpc('bump_conversation_on_inbound', {}, user(SEED.owner, 'owner'))).rejects.toMatchObject({ code: '42501' })
    await expect(executeRpc('__proto__', {}, service())).rejects.toMatchObject({ code: 'PGRST202' })
  })

  it('set_member_role: admin-only, cannot touch owners or self', async () => {
    await expect(executeRpc('set_member_role', { p_user_id: SEED.viewer, p_new_role: 'agent' }, user(SEED.agent, 'agent'))).rejects.toMatchObject({ code: '42501' })
    await expect(executeRpc('set_member_role', { p_user_id: SEED.owner, p_new_role: 'agent' }, user(SEED.admin, 'admin'))).rejects.toMatchObject({ code: '22023' })
    await expect(executeRpc('set_member_role', { p_user_id: SEED.admin, p_new_role: 'agent' }, user(SEED.admin, 'admin'))).rejects.toMatchObject({ code: '22023' })
    await executeRpc('set_member_role', { p_user_id: SEED.viewer, p_new_role: 'agent' }, user(SEED.admin, 'admin'))
    expect(sql(`SELECT account_role FROM profiles WHERE user_id = '${SEED.viewer}'`)[0].account_role).toBe('agent')
  })

  it('transfer_account_ownership swaps roles and accounts.owner_user_id atomically', async () => {
    await expect(executeRpc('transfer_account_ownership', { p_new_owner_user_id: SEED.agent }, user(SEED.admin, 'admin'))).rejects.toMatchObject({ code: '42501' })
    await executeRpc('transfer_account_ownership', { p_new_owner_user_id: SEED.agent }, user(SEED.owner, 'owner'))
    const roles = Object.fromEntries(sql(`SELECT user_id, account_role FROM profiles`).map((r) => [r.user_id, r.account_role]))
    expect(roles[SEED.owner]).toBe('admin')
    expect(roles[SEED.agent]).toBe('owner')
    expect(sql(`SELECT owner_user_id FROM accounts WHERE id = '${SEED.account}'`)[0].owner_user_id).toBe(SEED.agent)
  })

  it('remove_account_member gives the member a fresh personal account', async () => {
    const newAccount = await executeRpc('remove_account_member', { p_user_id: SEED.viewer }, user(SEED.admin, 'admin'))
    const prof = sql(`SELECT account_id, account_role FROM profiles WHERE user_id = '${SEED.viewer}'`)[0]
    expect(prof).toEqual({ account_id: newAccount, account_role: 'owner' })
  })

  it('redeem_invitation moves an empty new user into the inviting account once', async () => {
    // New user with their own empty account (what sign-up creates).
    sql(`INSERT INTO users (id, email, name) VALUES ('u-new', 'new@x.test', 'New')`)
    sql(`INSERT INTO accounts (id, name, owner_user_id) VALUES ('a-new', 'New', 'u-new')`)
    sql(`INSERT INTO profiles (user_id, account_id, account_role, full_name, email) VALUES ('u-new', 'a-new', 'owner', 'New', 'new@x.test')`)
    sql(`INSERT INTO account_invitations (account_id, token_hash, role, expires_at) VALUES ('${SEED.account}', 'h-ok', 'agent', '2999-01-01T00:00:00.000Z')`)

    const ctx: RpcContext = { runner, caller: 'user', ctx: { userId: 'u-new', accountId: 'a-new', role: 'owner', origin: 'browser' } }
    expect(await executeRpc('peek_invitation', { p_token_hash: 'h-ok' }, anon())).toMatchObject({ ok: true, role: 'agent', account_name: 'Demo Business' })
    expect(await executeRpc('redeem_invitation', { p_token_hash: 'h-ok' }, ctx)).toBe(SEED.account)
    expect(sql(`SELECT account_id, account_role FROM profiles WHERE user_id = 'u-new'`)[0]).toEqual({ account_id: SEED.account, account_role: 'agent' })
    expect(sql(`SELECT count(*) AS n FROM accounts WHERE id = 'a-new'`)[0].n).toBe(0) // old empty account removed
    await expect(executeRpc('redeem_invitation', { p_token_hash: 'h-ok' }, ctx)).rejects.toMatchObject({ code: '22023' })
    expect(await executeRpc('peek_invitation', { p_token_hash: 'h-ok' }, anon())).toEqual({ ok: false, reason: 'used' })
  })

  it('filter_contacts_by_tags returns contacts + total, scoped to the caller account', async () => {
    const rows = (await executeRpc('filter_contacts_by_tags', { p_tag_ids: [SEED.tagLead], p_limit: 1, p_offset: 0 }, user(SEED.viewer, 'viewer'))) as { contact: { id: string }; total_count: number }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].total_count).toBe(2)
    const searched = (await executeRpc('filter_contacts_by_tags', { p_tag_ids: [SEED.tagLead], p_search: 'hina' }, user(SEED.viewer, 'viewer'))) as { contact: { name: string } }[]
    expect(searched.map((r) => r.contact.name)).toEqual(['Hina Raza'])
  })

  it('claim_ai_reply_slot enforces the per-conversation cap', async () => {
    const claim = () => executeRpc('claim_ai_reply_slot', { conversation_id: SEED.convSara, max_replies: 2 }, service())
    expect(await claim()).toBe(true)
    expect(await claim()).toBe(true)
    expect(await claim()).toBe(false)
  })

  it('create_broadcast_with_recipients is all-or-nothing and returns recipient ids', async () => {
    const ids = Array.from({ length: 45 }, () => SEED.sara)
    const rows = (await executeRpc('create_broadcast_with_recipients', {
      p_account_id: SEED.account, p_user_id: SEED.owner, p_name: 'b', p_template_name: 'summer_offer',
      p_template_language: 'en_US', p_total_recipients: 45, p_contact_ids: ids, p_template_params: ids.map((_, i) => [`v${i}`]),
    }, service())) as { broadcast_id: string; recipient_id: string }[]
    expect(rows).toHaveLength(45)
    expect(sql(`SELECT count(*) AS n FROM broadcast_recipients WHERE broadcast_id = '${rows[0].broadcast_id}'`)[0].n).toBe(45)

    const before = sql(`SELECT count(*) AS n FROM broadcasts`)[0].n
    await expect(executeRpc('create_broadcast_with_recipients', {
      p_account_id: SEED.account, p_user_id: SEED.owner, p_name: 'b', p_template_name: 't', p_template_language: 'en_US',
      p_total_recipients: 1, p_contact_ids: ['no-such-contact'], p_template_params: [null],
    }, service())).rejects.toThrow(/FOREIGN KEY/)
    expect(sql(`SELECT count(*) AS n FROM broadcasts`)[0].n).toBe(before) // parent rolled back too
  })

  it('match_ai_knowledge_fts finds chunks, ignores FTS operators in input, stays in account', async () => {
    const rows = (await executeRpc('match_ai_knowledge_fts', { p_account_id: SEED.account, p_query: 'Marina delivery', p_match_count: 5 }, user(SEED.agent, 'agent'))) as { content: string }[]
    expect(rows).toHaveLength(1)
    expect(await executeRpc('match_ai_knowledge_fts', { p_account_id: SEED.account, p_query: 'NEAR( "" * OR', p_match_count: 5 }, user(SEED.agent, 'agent'))).toEqual(
      expect.any(Array),
    )
    expect(await executeRpc('match_ai_knowledge_fts', { p_account_id: 'other', p_query: 'Marina', p_match_count: 5 }, user(SEED.agent, 'agent'))).toEqual([])
    expect(toFtsQuery('a "b" OR c*')).toBe('"a" "b" "OR" "c"')
  })
})
