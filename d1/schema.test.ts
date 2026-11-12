/**
 * D1 schema behaviour tests (migration phase 1).
 *
 * Runs d1/migrations/*.sql + d1/seed/dev.sql against an in-memory SQLite
 * via Node's built-in `node:sqlite` (Node >= 22.13). D1 is SQLite, so this
 * checks constraints, triggers, cascades and FTS without starting Wrangler.
 * The same files are also applied to Wrangler's local D1 by
 * `npm run db:reset:local`.
 *
 * Skipped automatically on Node versions without `node:sqlite`.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

type Row = Record<string, unknown>
interface Db {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    get(...params: unknown[]): Row | undefined
    all(...params: unknown[]): Row[]
  }
  close(): void
}

let DatabaseSync: (new (path: string) => Db) | undefined
try {
  DatabaseSync = (await import('node:sqlite')).DatabaseSync as unknown as new (path: string) => Db
} catch {
  DatabaseSync = undefined
}

const D1_DIR = join(process.cwd(), 'd1')
const MIGRATIONS = readdirSync(join(D1_DIR, 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(D1_DIR, 'migrations', f), 'utf8'))
const SEED = readFileSync(join(D1_DIR, 'seed', 'dev.sql'), 'utf8')

// Seed ids (see d1/seed/dev.sql)
const ACCOUNT = '10000000-0000-4000-8000-000000000001'
const OWNER = '00000000-0000-4000-8000-000000000001'
const AGENT = '00000000-0000-4000-8000-000000000003'
const SARA = '40000000-0000-4000-8000-000000000001'
const OMAR = '40000000-0000-4000-8000-000000000002'
const CONV_SARA = '50000000-0000-4000-8000-000000000001'
const BROADCAST = '90000000-0000-4000-8000-000000000001'
const FLOW = 'b0000000-0000-4000-8000-000000000001'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ISO_MS_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function openDb(withSeed = true): Db {
  const db = new DatabaseSync!(':memory:')
  db.exec('PRAGMA foreign_keys = ON;') // D1 always enforces foreign keys
  for (const sql of MIGRATIONS) db.exec(sql)
  if (withSeed) db.exec(SEED)
  return db
}

const counts = (db: Db, id = BROADCAST) =>
  db
    .prepare(
      'SELECT sent_count, delivered_count, read_count, replied_count, failed_count FROM broadcasts WHERE id = ?',
    )
    .get(id)

/** Ground truth, same as the old recompute_broadcast_counts(). */
const recomputed = (db: Db, id = BROADCAST) =>
  db
    .prepare(
      `SELECT
         COALESCE(SUM(status IN ('sent','delivered','read','replied')), 0) AS sent_count,
         COALESCE(SUM(status IN ('delivered','read','replied')), 0)        AS delivered_count,
         COALESCE(SUM(status IN ('read','replied')), 0)                    AS read_count,
         COALESCE(SUM(status = 'replied'), 0)                              AS replied_count,
         COALESCE(SUM(status = 'failed'), 0)                               AS failed_count
       FROM broadcast_recipients WHERE broadcast_id = ?`,
    )
    .get(id)

describe.skipIf(!DatabaseSync)('D1 baseline schema', () => {
  let db: Db
  beforeEach(() => {
    db = openDb()
  })

  it('creates every table from the Postgres schema (minus member_presence, plus users and auth_*)', () => {
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_schema WHERE type = 'table'
           AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'ai_knowledge_chunks_fts%'
         ORDER BY name`,
      )
      .all()
      .map((r) => r.name)
    expect(tables).toEqual([
      'account_invitations', 'accounts', 'ai_configs', 'ai_knowledge_chunks', 'ai_knowledge_documents',
      'ai_usage_log', 'api_keys', 'auth_accounts', 'auth_rate_limits', 'auth_sessions', 'auth_verifications', 'automation_logs', 'automation_pending_executions', 'automation_steps',
      'automations', 'broadcast_button_clicks', 'broadcast_recipients', 'broadcast_url_tokens', 'broadcasts',
      'contact_custom_values', 'contact_notes', 'contact_tags', 'contacts', 'conversations', 'custom_fields',
      'deals', 'flow_nodes', 'flow_run_events', 'flow_runs', 'flows', 'message_reactions', 'message_templates',
      'messages', 'notifications', 'pipeline_stages', 'pipelines', 'profiles', 'quick_replies', 'tags',
      'users', 'webhook_endpoints', 'whatsapp_config',
    ])
  })

  it('seed loads with no foreign-key violations', () => {
    expect(db.prepare('SELECT * FROM pragma_foreign_key_check').all()).toEqual([])
  })

  it('defaults: v4 uuid ids and ISO-8601 UTC millisecond timestamps', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const row = db
        .prepare(
          `INSERT INTO tags (account_id, user_id, name) VALUES (?, ?, ?) RETURNING id, created_at`,
        )
        .get(ACCOUNT, OWNER, `t${i}`)!
      expect(row.id).toMatch(UUID_V4)
      expect(row.created_at).toMatch(ISO_MS_Z)
      ids.add(row.id as string)
    }
    expect(ids.size).toBe(200)
  })

  describe('broadcast counters trigger', () => {
    it('matches the seed (read + delivered + failed)', () => {
      expect(counts(db)).toEqual({ sent_count: 2, delivered_count: 2, read_count: 1, replied_count: 0, failed_count: 1 })
    })

    it('walks pending → sent → delivered → read → replied with cumulative counts', () => {
      const id = db
        .prepare(`INSERT INTO broadcast_recipients (broadcast_id, contact_id) VALUES (?, ?) RETURNING id`)
        .get(BROADCAST, OMAR)!.id
      const base = counts(db)!
      const setStatus = (s: string) =>
        db.prepare('UPDATE broadcast_recipients SET status = ? WHERE id = ?').run(s, id)

      expect(counts(db)).toEqual(base) // pending adds nothing
      setStatus('sent')
      expect(counts(db)).toMatchObject({ sent_count: Number(base.sent_count) + 1 })
      setStatus('delivered')
      expect(counts(db)).toMatchObject({
        sent_count: Number(base.sent_count) + 1,
        delivered_count: Number(base.delivered_count) + 1,
      })
      setStatus('read')
      setStatus('replied')
      expect(counts(db)).toEqual({
        sent_count: Number(base.sent_count) + 1,
        delivered_count: Number(base.delivered_count) + 1,
        read_count: Number(base.read_count) + 1,
        replied_count: 1,
        failed_count: base.failed_count,
      })
      expect(counts(db)).toEqual(recomputed(db))
    })

    it('stays equal to a full recompute under random transitions, inserts and deletes', () => {
      const statuses = ['pending', 'sent', 'delivered', 'read', 'replied', 'failed']
      let seed = 42
      const rand = (n: number) => {
        seed = (seed * 1103515245 + 12345) % 2 ** 31
        return seed % n
      }
      for (let i = 0; i < 300; i++) {
        const op = rand(10)
        if (op < 3) {
          db.prepare('INSERT INTO broadcast_recipients (broadcast_id, status) VALUES (?, ?)').run(
            BROADCAST,
            statuses[rand(statuses.length)],
          )
        } else if (op < 9) {
          const row = db
            .prepare('SELECT id FROM broadcast_recipients WHERE broadcast_id = ? ORDER BY random() LIMIT 1')
            .get(BROADCAST)
          if (row) {
            db.prepare('UPDATE broadcast_recipients SET status = ? WHERE id = ?').run(
              statuses[rand(statuses.length)],
              row.id,
            )
          }
        } else {
          db.prepare(
            'DELETE FROM broadcast_recipients WHERE id = (SELECT id FROM broadcast_recipients WHERE broadcast_id = ? ORDER BY random() LIMIT 1)',
          ).run(BROADCAST)
        }
        expect(counts(db)).toEqual(recomputed(db))
      }
    })

    it('writes the broadcasts row once per status change', () => {
      const id = db
        .prepare(`INSERT INTO broadcast_recipients (broadcast_id) VALUES (?) RETURNING id`)
        .get(BROADCAST)!.id
      // Old stamp, so the updated_at safety net can't fire just because the
      // seed ran in the same millisecond.
      db.prepare(`UPDATE broadcasts SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).run(BROADCAST)
      // total_changes counts every row written, including by triggers.
      const before = (db.prepare('SELECT total_changes() AS n').get()!.n as number)
      db.prepare(`UPDATE broadcast_recipients SET status = 'read' WHERE id = ?`).run(id)
      const after = (db.prepare('SELECT total_changes() AS n').get()!.n as number)
      expect(after - before).toBe(2) // the recipient row + one broadcasts row
    })
  })

  describe('updated_at safety net', () => {
    it('stamps updated_at when the app forgets to set it', () => {
      db.prepare(`UPDATE contacts SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).run(SARA)
      db.prepare(`UPDATE contacts SET name = 'Sara K.' WHERE id = ?`).run(SARA)
      const row = db.prepare('SELECT updated_at FROM contacts WHERE id = ?').get(SARA)!
      expect(row.updated_at).not.toBe('2000-01-01T00:00:00.000Z')
      expect(row.updated_at).toMatch(ISO_MS_Z)
    })

    it('keeps an explicit updated_at set by the app', () => {
      db.prepare(`UPDATE contacts SET name = 'Sara K.', updated_at = '2030-05-05T05:05:05.555Z' WHERE id = ?`).run(SARA)
      expect(db.prepare('SELECT updated_at FROM contacts WHERE id = ?').get(SARA)!.updated_at).toBe(
        '2030-05-05T05:05:05.555Z',
      )
    })
  })

  describe('contacts', () => {
    const insertContact = (phone: string, normalized: string | null, waUserId: string | null = null) =>
      db
        .prepare(
          `INSERT INTO contacts (account_id, user_id, phone, phone_normalized, wa_user_id) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(ACCOUNT, OWNER, phone, normalized, waUserId)

    it('requires phone_normalized and allows digits only', () => {
      expect(() => insertContact('+1 555 0100', null)).toThrow(/NOT NULL/)
      expect(() => insertContact('+1 555 0100', '+15550100')).toThrow(/CHECK/)
      expect(() => insertContact('+1 555 0100', '15550100')).not.toThrow()
    })

    it('dedupes by normalized phone per account (partial unique, empty exempt)', () => {
      expect(() => insertContact('971-50-123-4567', '971501234567')).toThrow(/UNIQUE/)
      expect(() => insertContact('', '')).not.toThrow()
      expect(() => insertContact('', '')).not.toThrow() // '' excluded from the unique index
    })

    it('dedupes by WhatsApp business-scoped user id per account', () => {
      insertContact('', '', 'US.123')
      expect(() => insertContact('', '', 'US.123')).toThrow(/UNIQUE/)
    })
  })

  describe('webhook idempotency and inbox invariants', () => {
    it('one conversation per contact', () => {
      expect(() =>
        db
          .prepare('INSERT INTO conversations (account_id, user_id, contact_id) VALUES (?, ?, ?)')
          .run(ACCOUNT, OWNER, SARA),
      ).toThrow(/UNIQUE/)
    })

    it('duplicate inbound wamid is a no-op with ON CONFLICT DO NOTHING RETURNING', () => {
      const insert = db.prepare(
        `INSERT INTO messages (conversation_id, sender_type, content_text, message_id, status)
         VALUES (?, 'customer', 'hello', ?, 'delivered')
         ON CONFLICT (conversation_id, message_id) DO NOTHING
         RETURNING id`,
      )
      expect(insert.all(CONV_SARA, 'wamid.NEW1')).toHaveLength(1)
      expect(insert.all(CONV_SARA, 'wamid.NEW1')).toHaveLength(0) // replay
    })

    it('rejects unknown message content types and statuses', () => {
      const ins = (ct: string, st: string) =>
        db
          .prepare(`INSERT INTO messages (conversation_id, sender_type, content_type, status) VALUES (?, 'agent', ?, ?)`)
          .run(CONV_SARA, ct, st)
      expect(() => ins('sticker', 'sent')).toThrow(/CHECK/)
      expect(() => ins('text', 'queued')).toThrow(/CHECK/)
      expect(() => ins('interactive', 'sending')).not.toThrow()
    })
  })

  it('allows one active flow run per contact, more once it ends', () => {
    const start = () =>
      db
        .prepare(`INSERT INTO flow_runs (account_id, flow_id, user_id, contact_id) VALUES (?, ?, ?, ?) RETURNING id`)
        .get(ACCOUNT, FLOW, OWNER, SARA)!
    const run = start()
    expect(() => start()).toThrow(/UNIQUE/)
    db.prepare(`UPDATE flow_runs SET status = 'completed' WHERE id = ?`).run(run.id)
    expect(() => start()).not.toThrow()
  })

  describe('CHECK constraints', () => {
    it('account roles, invitation roles and currency format', () => {
      expect(() =>
        db.prepare(`UPDATE profiles SET account_role = 'superadmin' WHERE user_id = ?`).run(AGENT),
      ).toThrow(/CHECK/)
      expect(() =>
        db
          .prepare(`INSERT INTO account_invitations (account_id, token_hash, role, expires_at) VALUES (?, 'h1', 'owner', '2030-01-01T00:00:00.000Z')`)
          .run(ACCOUNT),
      ).toThrow(/CHECK/)
      expect(() => db.prepare(`UPDATE accounts SET default_currency = 'usd' WHERE id = ?`).run(ACCOUNT)).toThrow(/CHECK/)
      expect(() => db.prepare(`UPDATE accounts SET default_currency = 'AED' WHERE id = ?`).run(ACCOUNT)).not.toThrow()
    })

    it('JSON columns must hold valid JSON; arrays must be arrays', () => {
      expect(() => db.prepare(`UPDATE automations SET trigger_config = '{bad' WHERE 1`).run()).toThrow(/CHECK/)
      expect(() => db.prepare(`UPDATE profiles SET beta_features = '{}' WHERE user_id = ?`).run(AGENT)).toThrow(/CHECK/)
      expect(() => db.prepare(`UPDATE profiles SET beta_features = '["ai"]' WHERE user_id = ?`).run(AGENT)).not.toThrow()
    })

    it('template buttons: JSON array of at most 10', () => {
      const eleven = JSON.stringify(Array.from({ length: 11 }, (_, i) => ({ type: 'QUICK_REPLY', text: `b${i}` })))
      expect(() => db.prepare(`UPDATE message_templates SET buttons = ?`).run(eleven)).toThrow(/CHECK/)
      expect(() => db.prepare(`UPDATE message_templates SET buttons = '{"a":1}'`).run()).toThrow(/CHECK/)
    })

    it('deal close date must be a real calendar date', () => {
      expect(() => db.prepare(`UPDATE deals SET expected_close_date = '2026-02-30'`).run()).toThrow(/CHECK/)
      expect(() => db.prepare(`UPDATE deals SET expected_close_date = '2026-02-28'`).run()).not.toThrow()
    })
  })

  describe('foreign-key actions match Postgres', () => {
    it('deleting a contact nulls deals and broadcast recipients, cascades its conversation', () => {
      db.prepare('DELETE FROM deals').run() // deals.conversation_id is NO ACTION, as in Postgres
      db.prepare(`INSERT INTO deals (account_id, user_id, pipeline_id, stage_id, contact_id, title)
                  VALUES (?, ?, '80000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', ?, 'd')`).run(ACCOUNT, OWNER, SARA)
      db.prepare('DELETE FROM contacts WHERE id = ?').run(SARA)
      expect(db.prepare('SELECT contact_id FROM deals').get()!.contact_id).toBeNull()
      expect(
        db.prepare(`SELECT count(*) AS n FROM broadcast_recipients WHERE whatsapp_message_id = 'wamid.BCAST001' AND contact_id IS NULL`).get()!.n,
      ).toBe(1)
      expect(db.prepare('SELECT count(*) AS n FROM conversations WHERE id = ?').get(CONV_SARA)!.n).toBe(0)
      expect(db.prepare('SELECT count(*) AS n FROM messages WHERE conversation_id = ?').get(CONV_SARA)!.n).toBe(0)
    })

    it('an account owner cannot be deleted while they own the account (RESTRICT)', () => {
      expect(() => db.prepare('DELETE FROM users WHERE id = ?').run(OWNER)).toThrow(/FOREIGN KEY/)
    })

    it('deleting the account removes all of its data', () => {
      db.prepare('DELETE FROM accounts WHERE id = ?').run(ACCOUNT)
      for (const t of ['profiles', 'contacts', 'conversations', 'messages', 'broadcasts', 'broadcast_recipients',
        'deals', 'automations', 'flows', 'notifications', 'ai_knowledge_chunks', 'ai_knowledge_chunks_fts']) {
        expect(db.prepare(`SELECT count(*) AS n FROM ${t}`).get()!.n, t).toBe(0)
      }
    })
  })

  describe('knowledge-base full-text search (FTS5)', () => {
    const search = (q: string, account = ACCOUNT) =>
      db
        .prepare(
          `SELECT chunk_id FROM ai_knowledge_chunks_fts
           WHERE ai_knowledge_chunks_fts MATCH ? AND account_id = ? ORDER BY bm25(ai_knowledge_chunks_fts)`,
        )
        .all(q, account)

    it('indexes inserted chunks, case-insensitively, scoped by account', () => {
      expect(search('MARINA')).toHaveLength(1)
      expect(search('marina', 'other-account')).toHaveLength(0)
      expect(search('refund')).toHaveLength(0)
    })

    it('follows content updates and document deletes', () => {
      db.prepare(`UPDATE ai_knowledge_chunks SET content = 'Refunds within 14 days.'`).run()
      expect(search('marina')).toHaveLength(0)
      expect(search('refunds')).toHaveLength(1)
      db.prepare('DELETE FROM ai_knowledge_documents').run()
      expect(db.prepare('SELECT count(*) AS n FROM ai_knowledge_chunks_fts').get()!.n).toBe(0)
    })
  })

  it('webhook endpoint event subscriptions query via json_each (replaces text[] @>)', () => {
    db.prepare(`INSERT INTO webhook_endpoints (account_id, url, secret, events) VALUES (?, 'https://x.test', 'enc', '["message.received","message.status_updated"]')`).run(ACCOUNT)
    const q = db.prepare(
      `SELECT count(*) AS n FROM webhook_endpoints
       WHERE account_id = ? AND is_active = 1
         AND EXISTS (SELECT 1 FROM json_each(events) WHERE value = ?)`,
    )
    expect(q.get(ACCOUNT, 'message.received')!.n).toBe(1)
    expect(q.get(ACCOUNT, 'conversation.created')!.n).toBe(0)
  })
})
