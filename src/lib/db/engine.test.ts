import { beforeEach, describe, expect, it } from 'vitest'
import { QueryBuilder } from './builder'
import { executeQuery } from './engine'
import { hasSqlite, openTestDb, SEED } from './test-utils'
import type { SqlRunner } from './types'

describe.skipIf(!hasSqlite)('D1 query engine (service role, no policy)', () => {
  let runner: SqlRunner
  let all: (sql: string) => Record<string, unknown>[]
  const from = (table: string) => new QueryBuilder((ast) => executeQuery(ast, { runner, policy: null }), table)

  beforeEach(() => {
    const t = openTestDb()
    runner = t.runner
    all = (sql) => t.db.prepare(sql).all()
  })

  describe('select', () => {
    it('returns rows with booleans and JSON converted like PostgREST', async () => {
      const { data, error } = await from('automations').select('*').single()
      expect(error).toBeNull()
      expect(data.is_active).toBe(true)
      expect(data.trigger_config).toEqual({ keywords: ['vip'] })
      const { data: tpl } = await from('message_templates').select('buttons').single()
      expect(Array.isArray(tpl.buttons)).toBe(true)
    })

    it('projects listed columns with aliases', async () => {
      const { data } = await from('contacts').select('id, full:name').eq('id', SEED.sara).single()
      expect(data).toEqual({ id: SEED.sara, full: 'Sara Khan' })
    })

    it('supports eq/neq/gt/gte/lt/lte/in/is/ilike/like/not', async () => {
      const names = async (b: QueryBuilder) => ((await b).data as { name: string }[]).map((r) => r.name).sort()
      expect(await names(from('contacts').select('name').eq('name', 'Omar Ali'))).toEqual(['Omar Ali'])
      expect(await names(from('contacts').select('name').neq('name', 'Omar Ali'))).toEqual(['Hina Raza', 'Sara Khan'])
      expect(await names(from('contacts').select('name').in('id', [SEED.sara, SEED.hina]))).toEqual(['Hina Raza', 'Sara Khan'])
      expect(await names(from('contacts').select('name').is('email', null))).toEqual(['Omar Ali'])
      expect(await names(from('contacts').select('name').not('email', 'is', null))).toEqual(['Hina Raza', 'Sara Khan'])
      expect(await names(from('contacts').select('name').ilike('name', '%KHAN%'))).toEqual(['Sara Khan'])
      expect(await names(from('contacts').select('name').like('name', '%KHAN%'))).toEqual([]) // like is case-sensitive
      expect(await names(from('contacts').select('name').like('name', '%Khan%'))).toEqual(['Sara Khan'])
      expect(await names(from('contacts').select('name').gte('created_at', '2000-01-01').lt('created_at', '2999-01-01'))).toHaveLength(3)
      expect(await names(from('contacts').select('name').in('id', []))).toEqual([])
    })

    it('parses .or() strings incl. nested and() and * wildcards', async () => {
      const { data } = await from('contacts').select('name').or('name.ilike.*hina*,phone.ilike.*971 50*')
      expect((data as { name: string }[]).map((r) => r.name).sort()).toEqual(['Hina Raza', 'Sara Khan'])
      const { data: d2 } = await from('contacts')
        .select('name')
        .or(`name.eq.Nobody,and(name.eq.Omar Ali,id.eq.${SEED.omar})`)
      expect(d2).toEqual([{ name: 'Omar Ali' }])
    })

    it('orders like Postgres (DESC puts NULLs first, ASC last) and paginates with range()', async () => {
      const { data } = await from('contacts').select('name, email').order('email', { ascending: false })
      expect((data as { email: string | null }[])[0].email).toBeNull()
      const { data: asc } = await from('contacts').select('name, email').order('email', { ascending: true })
      expect((asc as { email: string | null }[]).at(-1)!.email).toBeNull()
      const { data: page } = await from('contacts').select('name').order('name').range(1, 1)
      expect(page).toEqual([{ name: 'Omar Ali' }])
    })

    it('count exact with head', async () => {
      const res = await from('contacts').select('id', { count: 'exact', head: true }).eq('account_id', SEED.account)
      expect(res.data).toBeNull()
      expect(res.count).toBe(3)
    })

    it('single() errors with PGRST116 unless exactly one row; maybeSingle() allows none', async () => {
      expect((await from('contacts').select('id').single()).error?.code).toBe('PGRST116')
      expect((await from('contacts').select('id').eq('id', 'nope').single()).error?.code).toBe('PGRST116')
      const none = await from('contacts').select('id').eq('id', 'nope').maybeSingle()
      expect(none.error).toBeNull()
      expect(none.data).toBeNull()
      expect((await from('contacts').select('id').maybeSingle()).error?.code).toBe('PGRST116')
    })

    it('rejects unknown tables and columns instead of interpolating them', async () => {
      expect((await from('contacts; DROP TABLE users').select('*')).error?.code).toBe('PGRST205')
      expect((await from('contacts').select('id').eq('name" OR 1=1 --', 'x')).error?.code).toBe('PGRST204')
      expect((await from('contacts').select('id, nope')).error?.code).toBe('PGRST204')
    })
  })

  describe('embeds', () => {
    it('to-one with alias: *, contact:contacts(*)', async () => {
      const { data } = await from('conversations').select('*, contact:contacts(name, phone)').eq('id', SEED.convSara).single()
      expect(data.contact).toEqual({ name: 'Sara Khan', phone: '+971 50 123 4567' })
      expect(data.status).toBe('open')
    })

    it('to-many reverse embed and nested embeds', async () => {
      const { data } = await from('contacts').select('name, contact_tags(tag_id, tags(name))').eq('id', SEED.sara).single()
      expect(data.contact_tags).toEqual([{ tag_id: SEED.tagVip, tags: { name: 'VIP' } }])
      const { data: msgs } = await from('messages')
        .select('id, conversations(contact_id, contacts(name, phone))')
        .eq('conversation_id', SEED.convSara)
      expect((msgs as { conversations: { contacts: { name: string } } }[])[0].conversations.contacts.name).toBe('Sara Khan')
    })

    it('FK hint: assignee:profiles!deals_assigned_to_fkey(*)', async () => {
      const { data } = await from('deals')
        .select('title, value, contact:contacts(*), stage:pipeline_stages(*), assignee:profiles!deals_assigned_to_fkey(*)')
        .single()
      expect(data.assignee.full_name).toBe('Ava Agent')
      expect(data.stage.name).toBe('Negotiating')
      expect(data.value).toBe(1250.5) // value_cents 125050 exposed as decimal `value`
    })

    it('!inner with a filter on the embedded table', async () => {
      const ok = await from('broadcast_recipients').select('id, broadcasts!inner(account_id)').eq('broadcasts.account_id', SEED.account)
      expect(ok.data).toHaveLength(3)
      const none = await from('broadcast_recipients').select('id, broadcasts!inner(account_id)').eq('broadcasts.account_id', 'other')
      expect(none.data).toEqual([])
      const counted = await from('contacts')
        .select('id, tag_filter:contact_tags!inner(tag_id)', { count: 'exact' })
        .eq('tag_filter.tag_id', SEED.tagLead)
      expect(counted.count).toBe(2)
      expect(counted.data).toHaveLength(2)
    })

    it('embedding without a foreign key is a relationship error, like PostgREST', async () => {
      // conversations.assigned_agent_id has no FK in the schema.
      const res = await from('conversations').select('id, assigned:profiles!assigned_agent_id(*)').limit(1)
      expect(res.data).toBeNull()
      expect(res.error?.code).toBe('PGRST200')
    })

    it('a NULL foreign key gives a null to-one embed', async () => {
      const { data } = await from('deals').update({ contact_id: null }).eq('pipeline_id', SEED.pipeline).select('id, contact:contacts(name)').single()
      expect(data.contact).toBeNull()
    })
  })

  describe('mutations', () => {
    it('insert returns rows (with generated uuid) and converts types', async () => {
      const { data, error } = await from('automations')
        .insert({ account_id: SEED.account, user_id: SEED.owner, name: 'n', trigger_type: 'keyword', trigger_config: { a: 1 }, is_active: false })
        .select('*')
        .single()
      expect(error).toBeNull()
      expect(data.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(data.is_active).toBe(false)
      expect(data.trigger_config).toEqual({ a: 1 })
    })

    it('bulk insert chunks under the bound-parameter limit, atomically, in input order', async () => {
      const rows = Array.from({ length: 120 }, (_, i) => ({ broadcast_id: SEED.broadcast, contact_id: SEED.sara, status: 'pending', template_params: [`p${i}`] }))
      const { data, error } = await from('broadcast_recipients').insert(rows).select('id, template_params')
      expect(error).toBeNull()
      expect((data as unknown[]).length).toBe(120)
      expect((data as { template_params: string[] }[])[119].template_params).toEqual(['p119'])

      // One bad row (CHECK) → nothing inserted.
      const before = all('SELECT count(*) AS n FROM broadcast_recipients')[0].n
      const bad = [...rows.slice(0, 60), { broadcast_id: SEED.broadcast, status: 'bogus' }]
      expect((await from('broadcast_recipients').insert(bad)).error?.code).toBe('23514')
      expect(all('SELECT count(*) AS n FROM broadcast_recipients')[0].n).toBe(before)
    })

    it('maps unique violations to 23505 (code the app checks for dedupe)', async () => {
      const { error } = await from('contacts').insert({ account_id: SEED.account, user_id: SEED.owner, phone: '971501234567', phone_normalized: '971501234567' })
      expect(error?.code).toBe('23505')
    })

    it('upsert updates on conflict; ignoreDuplicates returns no row for duplicates', async () => {
      const first = await from('contact_tags').upsert({ contact_id: SEED.sara, tag_id: SEED.tagVip }, { onConflict: 'contact_id,tag_id', ignoreDuplicates: true }).select('id')
      expect(first.data).toEqual([])
      const ins = await from('messages')
        .upsert({ conversation_id: SEED.convSara, sender_type: 'customer', message_id: 'wamid.X', status: 'delivered' }, { onConflict: 'conversation_id,message_id', ignoreDuplicates: true })
        .select('id')
      expect(ins.data).toHaveLength(1)
      const replay = await from('messages')
        .upsert({ conversation_id: SEED.convSara, sender_type: 'customer', message_id: 'wamid.X', status: 'delivered' }, { onConflict: 'conversation_id,message_id', ignoreDuplicates: true })
        .select('id')
      expect(replay.data).toHaveLength(0)

      await from('message_templates').upsert(
        { account_id: SEED.account, user_id: '00000000-0000-4000-8000-000000000002', name: 'summer_offer', language: 'en_US', body_text: 'Updated', status: 'APPROVED' },
        { onConflict: 'user_id,name,language' },
      )
      expect(all(`SELECT body_text FROM message_templates WHERE name = 'summer_offer'`)[0].body_text).toBe('Updated')
    })

    it('update sets updated_at, returns rows; delete returns deleted rows', async () => {
      all(`UPDATE contacts SET updated_at = '2000-01-01T00:00:00.000Z'`)
      const { data } = await from('contacts').update({ company: 'ACME' }).eq('id', SEED.sara).select('company, updated_at').single()
      expect(data.company).toBe('ACME')
      expect(data.updated_at).not.toBe('2000-01-01T00:00:00.000Z')
      const del = await from('contact_notes').delete().eq('contact_id', SEED.sara).select('id')
      expect(del.data).toHaveLength(1)
    })

    it('derives contacts.phone_normalized from phone (was a Postgres generated column)', async () => {
      // Insert without phone_normalized: the engine computes it (digits only).
      const ins = await from('contacts')
        .insert({ account_id: SEED.account, user_id: SEED.owner, phone: '+1 (555) 010-DIAL 7' })
        .select('phone_normalized')
        .single()
      expect(ins.error).toBeNull()
      expect(ins.data.phone_normalized).toBe('15550107')

      // A client-supplied value is overridden, like GENERATED ALWAYS.
      const forced = await from('contacts')
        .insert({ account_id: SEED.account, user_id: SEED.owner, phone: '+44 20 7946 0000', phone_normalized: 'bogus' })
        .select('phone_normalized')
        .single()
      expect(forced.data.phone_normalized).toBe('442079460000')

      // Updating phone recomputes it; updating other columns leaves it alone.
      await from('contacts').update({ phone: '+971 50 999 0000' }).eq('id', SEED.sara)
      await from('contacts').update({ name: 'Sara' }).eq('id', SEED.sara)
      expect(all(`SELECT phone_normalized FROM contacts WHERE id = '${SEED.sara}'`)[0].phone_normalized).toBe('971509990000')

      // Dedupe still works through the derived value (23505 the webhook relies on).
      const dup = await from('contacts').insert({ account_id: SEED.account, user_id: SEED.owner, phone: '971-50-999-0000' })
      expect(dup.error?.code).toBe('23505')

      // Upserts derive it too.
      const up = await from('contacts')
        .upsert({ account_id: SEED.account, user_id: SEED.owner, phone: '+1 555 0199' })
        .select('phone_normalized')
        .single()
      expect(up.data.phone_normalized).toBe('15550199')
    })

    it('writes deals.value as cents', async () => {
      await from('deals').update({ value: 99.99 }).eq('pipeline_id', SEED.pipeline)
      expect(all('SELECT value_cents FROM deals')[0].value_cents).toBe(9999)
      const { data } = await from('deals').select('value').single()
      expect(data.value).toBe(99.99)
    })

    it('insert without .select() returns data null (like PostgREST return=minimal)', async () => {
      const res = await from('tags').insert({ account_id: SEED.account, user_id: SEED.owner, name: 'x' })
      expect(res.error).toBeNull()
      expect(res.data).toBeNull()
    })
  })
})
