/**
 * TypeScript ports of the Postgres functions the app calls with
 * `supabase.rpc(...)` (supabase/migrations). D1 has no stored procedures.
 *
 * Each entry declares who may call it:
 *   - 'anon'    : no session needed (peek_invitation)
 *   - 'user'    : needs a session; runs scoped to the caller's account
 *   - 'service' : server-side admin client only (was GRANT … TO service_role)
 * Postgres error codes raised by the originals are preserved.
 */
import { SCHEMA } from './schema.generated'
import { executeQuery } from './engine'
import type { RealtimeSink } from './realtime'
import { DbQueryError, type Row, type SqlRunner } from './types'
import type { AccountRole, PolicyContext } from './policy'
import { hasMinRole } from './policy'

export interface RpcContext {
  runner: SqlRunner
  /**
   * Who is calling. 'service' = server admin client (unscoped);
   * 'user' = signed-in session (ctx required); 'anon' = no session.
   * Kept explicit so "no session" can never be mistaken for service.
   */
  caller: 'service' | 'user' | 'anon'
  /** Set when caller = 'user'. */
  ctx: PolicyContext | null
  /** Realtime hub sink (optional). */
  realtime?: RealtimeSink
}

type Access = 'anon' | 'user' | 'service'
interface RpcDef {
  access: Access
  run(args: Record<string, unknown>, rc: RpcContext): Promise<unknown>
}

const nowIso = () => new Date().toISOString()
const err = (message: string, code: string, status = 400) => new DbQueryError(message, code, status)

/** Convert a raw contacts row (0/1, JSON text) to API shape. */
function contactRow(raw: Row): Row {
  const out: Row = {}
  for (const [k, v] of Object.entries(raw)) {
    const kind = SCHEMA.contacts.columns[k]
    out[k] = kind === 'boolean' ? v === 1 : kind === 'json' && typeof v === 'string' ? JSON.parse(v) : v
  }
  return out
}

async function callerProfile(rc: RpcContext): Promise<{ userId: string; accountId: string; role: AccountRole }> {
  if (!rc.ctx) throw err('Unauthorized', '42501', 401)
  const rows = await rc.runner.all(`SELECT account_id, account_role FROM profiles WHERE user_id = ?`, [rc.ctx.userId])
  if (!rows.length || !rows[0].account_id) throw err('Caller has no account', '42501', 403)
  return { userId: rc.ctx.userId, accountId: rows[0].account_id as string, role: rows[0].account_role as AccountRole }
}

async function targetProfile(rc: RpcContext, userId: unknown) {
  const rows = await rc.runner.all(
    `SELECT account_id, account_role, full_name, email FROM profiles WHERE user_id = ?`,
    [userId],
  )
  if (!rows.length) throw err('Target user not found', '22023')
  return rows[0] as { account_id: string; account_role: AccountRole; full_name: string; email: string }
}

/** Quote each word so user input can't use FTS5 operators; words are ANDed (≈ plainto_tsquery). */
export function toFtsQuery(input: string): string | null {
  const words = input.match(/[\p{L}\p{N}]+/gu)
  if (!words?.length) return null
  return words.map((w) => `"${w}"`).join(' ')
}

export const RPCS: Record<string, RpcDef> = {
  // ── 018: account members ───────────────────────────────────────────
  set_member_role: {
    access: 'user',
    async run({ p_user_id, p_new_role }, rc) {
      const caller = await callerProfile(rc)
      if (!hasMinRole(caller.role, 'admin')) throw err('This action requires the admin role or higher', '42501', 403)
      if (p_user_id === caller.userId) throw err('Cannot change your own role', '22023')
      const target = await targetProfile(rc, p_user_id)
      if (target.account_id !== caller.accountId) throw err('Target user is not a member of your account', '42501', 403)
      if (target.account_role === 'owner') throw err('Use transfer_account_ownership to demote an owner', '22023')
      if (p_new_role === 'owner') throw err('Use transfer_account_ownership to promote to owner', '22023')
      if (!['admin', 'agent', 'viewer'].includes(String(p_new_role))) throw err('Invalid role', '22P02')
      await rc.runner.all(`UPDATE profiles SET account_role = ?, updated_at = ? WHERE user_id = ?`, [p_new_role, nowIso(), p_user_id])
      return null
    },
  },

  remove_account_member: {
    access: 'user',
    async run({ p_user_id }, rc) {
      const caller = await callerProfile(rc)
      if (!hasMinRole(caller.role, 'admin')) throw err('This action requires the admin role or higher', '42501', 403)
      if (p_user_id === caller.userId) {
        throw err('Cannot remove yourself; transfer ownership or leave the account instead', '22023')
      }
      const target = await targetProfile(rc, p_user_id)
      if (target.account_id !== caller.accountId) throw err('Target user is not a member of your account', '42501', 403)
      if (target.account_role === 'owner') throw err('Cannot remove the account owner; transfer ownership first', '22023')
      // The removed member gets a fresh personal account (as in Postgres).
      const newAccountId = crypto.randomUUID()
      await rc.runner.batch([
        {
          sql: `INSERT INTO accounts (id, name, owner_user_id) VALUES (?, ?, ?)`,
          params: [newAccountId, target.full_name || target.email || 'My account', p_user_id],
        },
        {
          sql: `UPDATE profiles SET account_id = ?, account_role = 'owner', updated_at = ? WHERE user_id = ?`,
          params: [newAccountId, nowIso(), p_user_id],
        },
      ])
      return newAccountId
    },
  },

  transfer_account_ownership: {
    access: 'user',
    async run({ p_new_owner_user_id }, rc) {
      const caller = await callerProfile(rc)
      if (caller.role !== 'owner') throw err('Only the account owner can transfer ownership', '42501', 403)
      if (p_new_owner_user_id === caller.userId) throw err('You are already the owner', '22023')
      const target = await targetProfile(rc, p_new_owner_user_id)
      if (target.account_id !== caller.accountId) throw err('Target user is not a member of your account', '42501', 403)
      const now = nowIso()
      await rc.runner.batch([
        { sql: `UPDATE profiles SET account_role = 'admin', updated_at = ? WHERE user_id = ?`, params: [now, caller.userId] },
        { sql: `UPDATE profiles SET account_role = 'owner', updated_at = ? WHERE user_id = ?`, params: [now, p_new_owner_user_id] },
        { sql: `UPDATE accounts SET owner_user_id = ?, updated_at = ? WHERE id = ?`, params: [p_new_owner_user_id, now, caller.accountId] },
      ])
      return null
    },
  },

  // ── 019: invitations ───────────────────────────────────────────────
  peek_invitation: {
    access: 'anon',
    async run({ p_token_hash }, rc) {
      const rows = await rc.runner.all(
        `SELECT i.role, i.expires_at, i.accepted_at, a.name AS account_name
         FROM account_invitations i JOIN accounts a ON a.id = i.account_id
         WHERE i.token_hash = ?`,
        [p_token_hash],
      )
      const inv = rows[0]
      if (!inv) return { ok: false, reason: 'not_found' }
      if (inv.accepted_at) return { ok: false, reason: 'used' }
      if (String(inv.expires_at) <= nowIso()) return { ok: false, reason: 'expired' }
      return { ok: true, account_name: inv.account_name, role: inv.role, expires_at: inv.expires_at }
    },
  },

  redeem_invitation: {
    access: 'user',
    async run({ p_token_hash }, rc) {
      if (!rc.ctx) throw err('Unauthorized', '42501', 401)
      const callerId = rc.ctx.userId
      const invRows = await rc.runner.all(`SELECT * FROM account_invitations WHERE token_hash = ?`, [p_token_hash])
      const inv = invRows[0]
      if (!inv) throw err('Invitation not found', '22023')
      if (inv.accepted_at) throw err('Invitation has already been redeemed', '22023')
      if (String(inv.expires_at) <= nowIso()) throw err('Invitation has expired', '22023')

      const prof = await rc.runner.all(
        `SELECT p.account_id, a.owner_user_id FROM profiles p JOIN accounts a ON a.id = p.account_id WHERE p.user_id = ?`,
        [callerId],
      )
      if (!prof.length) throw err('Caller has no profile', '42501', 403)
      const oldAccountId = prof[0].account_id as string
      if (oldAccountId === inv.account_id) throw err('You are already a member of this account', '23505', 409)
      if (prof[0].owner_user_id !== callerId) {
        throw err('You are already in a shared account; sign up with a different email to join this one', '23505', 409)
      }
      const dataTables = ['contacts', 'conversations', 'broadcasts', 'automations', 'flows', 'pipelines',
        'message_templates', 'tags', 'custom_fields', 'contact_notes', 'whatsapp_config']
      const hasData = await rc.runner.all(
        `SELECT 1 AS x FROM (${dataTables.map((t) => `SELECT 1 FROM "${t}" WHERE account_id = ?`).join(' UNION ALL ')}) LIMIT 1`,
        dataTables.map(() => oldAccountId),
      )
      if (hasData.length) {
        throw err('Your account already contains data; sign up with a different email to join this one', '23505', 409)
      }

      // Conditional claim replaces SELECT … FOR UPDATE: only one redeem can flip accepted_at.
      const now = nowIso()
      const results = await rc.runner.batch([
        {
          sql: `UPDATE account_invitations SET accepted_at = ?, accepted_by_user_id = ? WHERE id = ? AND accepted_at IS NULL RETURNING id`,
          params: [now, callerId, inv.id],
        },
        {
          sql: `UPDATE profiles SET account_id = ?, account_role = ?, updated_at = ?
                WHERE user_id = ? AND EXISTS (SELECT 1 FROM account_invitations WHERE id = ? AND accepted_by_user_id = ?)`,
          params: [inv.account_id, inv.role, now, callerId, inv.id, callerId],
        },
        {
          sql: `DELETE FROM accounts WHERE id = ? AND NOT EXISTS (SELECT 1 FROM profiles WHERE account_id = ?)`,
          params: [oldAccountId, oldAccountId],
        },
      ])
      if (!results[0].length) throw err('Invitation has already been redeemed', '22023')
      return inv.account_id
    },
  },

  // ── 024: presence (moves to the Durable Object in phase 5) ──────────
  touch_presence: {
    access: 'user',
    async run({ p_status }, rc) {
      if (rc.ctx && rc.realtime) {
        await rc.realtime.touch(rc.ctx.accountId, rc.ctx.userId, p_status === 'away' ? 'away' : 'online')
      }
      return null
    },
  },

  // ── 025: contacts filtered by tags ──────────────────────────────────
  filter_contacts_by_tags: {
    access: 'user',
    async run({ p_tag_ids, p_search = null, p_limit = 25, p_offset = 0 }, rc) {
      const tagIds = Array.isArray(p_tag_ids) ? p_tag_ids : []
      const search = p_search === null || p_search === undefined ? null : `%${String(p_search)}%`
      const scope = rc.ctx ? `AND c.account_id = ?` : ''
      const params: unknown[] = [JSON.stringify(tagIds)]
      if (search) params.push(search, search, search)
      if (rc.ctx) params.push(rc.ctx.accountId)
      const matchedSql = `
        SELECT DISTINCT c.id FROM contacts c JOIN contact_tags ct ON ct.contact_id = c.id
        WHERE ct.tag_id IN (SELECT value FROM json_each(?))
          ${search ? `AND (c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ?)` : ''}
          ${scope}`
      const total = await rc.runner.all(`SELECT COUNT(*) AS n FROM (${matchedSql})`, params)
      const rows = await rc.runner.all(
        `SELECT c.* FROM contacts c WHERE c.id IN (${matchedSql})
         ORDER BY c.created_at DESC, c.id LIMIT ? OFFSET ?`,
        [...params, Number(p_limit), Number(p_offset)],
      )
      const totalCount = Number(total[0]?.n ?? 0)
      return rows.map((r) => ({ contact: contactRow(r), total_count: totalCount }))
    },
  },

  // ── 007 / 012: execution counters ───────────────────────────────────
  increment_automation_execution_count: {
    access: 'service',
    async run({ p_automation_id, automation_id }, rc) {
      await rc.runner.all(
        `UPDATE automations SET execution_count = execution_count + 1, last_executed_at = ?, updated_at = ? WHERE id = ?`,
        [nowIso(), nowIso(), p_automation_id ?? automation_id],
      )
      return null
    },
  },

  increment_flow_execution_count: {
    access: 'service',
    async run({ p_flow_id, flow_id }, rc) {
      await rc.runner.all(
        `UPDATE flows SET execution_count = execution_count + 1, last_executed_at = ?, updated_at = ? WHERE id = ?`,
        [nowIso(), nowIso(), p_flow_id ?? flow_id],
      )
      return null
    },
  },

  // ── 028: outbound webhook failures ──────────────────────────────────
  record_webhook_failure: {
    access: 'service',
    async run({ endpoint_id, max_failures }, rc) {
      await rc.runner.all(
        `UPDATE webhook_endpoints SET failure_count = failure_count + 1,
           is_active = CASE WHEN failure_count + 1 >= ? THEN 0 ELSE is_active END
         WHERE id = ?`,
        [Number(max_failures), endpoint_id],
      )
      return null
    },
  },

  // ── 029: AI reply budget ────────────────────────────────────────────
  claim_ai_reply_slot: {
    access: 'service',
    async run({ conversation_id, max_replies }, rc) {
      const rows = await rc.runner.all(
        `UPDATE conversations SET ai_reply_count = ai_reply_count + 1
         WHERE id = ? AND ai_reply_count < ? RETURNING id`,
        [conversation_id, Number(max_replies)],
      )
      return rows.length > 0
    },
  },

  // ── 030 / 032: knowledge-base retrieval ─────────────────────────────
  match_ai_knowledge_fts: {
    access: 'user',
    async run({ p_account_id, p_query, p_match_count }, rc) {
      const account = rc.ctx ? rc.ctx.accountId : p_account_id
      if (rc.ctx && p_account_id !== rc.ctx.accountId) return []
      const match = toFtsQuery(String(p_query ?? ''))
      if (!match) return []
      const rows = await rc.runner.all(
        `SELECT chunk_id AS id, content, -bm25(ai_knowledge_chunks_fts) AS rank
         FROM ai_knowledge_chunks_fts
         WHERE ai_knowledge_chunks_fts MATCH ? AND account_id = ?
         ORDER BY bm25(ai_knowledge_chunks_fts) LIMIT ?`,
        [match, account, Math.max(Number(p_match_count) || 0, 0)],
      )
      return rows
    },
  },

  match_ai_knowledge_semantic: {
    access: 'user',
    // pgvector search → Cloudflare Vectorize (not wired yet). Returning no
    // rows makes lib/ai/knowledge.ts fall back to full-text search.
    async run() {
      return []
    },
  },

  // ── 037: inbound unread bump ────────────────────────────────────────
  bump_conversation_on_inbound: {
    access: 'service',
    async run({ p_conversation_id, p_last_message_text }, rc) {
      const now = nowIso()
      await rc.runner.all(
        `UPDATE conversations SET unread_count = COALESCE(unread_count, 0) + 1,
           last_message_text = ?, last_message_at = ?, updated_at = ? WHERE id = ?`,
        [p_last_message_text, now, now, p_conversation_id],
      )
      if (rc.realtime) {
        const res = await executeQuery(
          {
            table: 'conversations',
            action: 'select',
            select: [{ type: 'star' }],
            filters: [{ type: 'cond', column: 'id', op: 'eq', value: p_conversation_id }],
            order: [],
          },
          { runner: rc.runner, policy: null },
        )
        if (Array.isArray(res.data)) await rc.realtime.change('conversations', 'UPDATE', res.data)
      }
      return null
    },
  },

  // ── 037 / 038 / 041: broadcast + recipients, atomically ─────────────
  create_broadcast_with_recipients: {
    access: 'service',
    async run(args, rc) {
      const contactIds = (args.p_contact_ids as string[]) ?? []
      const params = (args.p_template_params as unknown[]) ?? []
      const broadcastId = crypto.randomUUID()
      const recipients = contactIds.map((cid, i) => ({
        id: crypto.randomUUID(),
        contactId: cid,
        params: params[i] === undefined || params[i] === null ? null : JSON.stringify(params[i]),
      }))
      const statements = [
        {
          sql: `INSERT INTO broadcasts (id, account_id, user_id, name, template_name, template_language, status, total_recipients)
                VALUES (?, ?, ?, ?, ?, ?, 'sending', ?)`,
          params: [broadcastId, args.p_account_id, args.p_user_id, args.p_name, args.p_template_name,
            args.p_template_language, Number(args.p_total_recipients)],
        },
      ]
      const perStatement = 20 // 5 params per row, under D1's 100-parameter limit
      for (let i = 0; i < recipients.length; i += perStatement) {
        const chunk = recipients.slice(i, i + perStatement)
        statements.push({
          sql: `INSERT INTO broadcast_recipients (id, broadcast_id, contact_id, status, template_params) VALUES ${chunk.map(() => `(?, ?, ?, 'pending', ?)`).join(', ')}`,
          params: chunk.flatMap((r) => [r.id, broadcastId, r.contactId, r.params]),
        })
      }
      await rc.runner.batch(statements) // all-or-nothing, like the plpgsql body
      return recipients.map((r) => ({ broadcast_id: broadcastId, recipient_id: r.id, contact_id: r.contactId }))
    },
  },

  // ── 043: flow node lead tracking ────────────────────────────────────
  get_flow_node_leads: {
    access: 'user',
    async run({ p_flow_id, p_node_key, p_search = null, p_date_from = null, p_date_to = null, p_limit = 50, p_offset = 0 }, rc) {
      const where: string[] = [
        `r.flow_id = ?`, `e.event_type = 'node_entered'`, `e.node_key = ?`, `r.contact_id IS NOT NULL`,
      ]
      const params: unknown[] = [p_flow_id, p_node_key]
      if (p_date_from) { where.push(`e.created_at >= ?`); params.push(p_date_from) }
      if (p_date_to) { where.push(`e.created_at <= ?`); params.push(p_date_to) }
      if (rc.ctx) { where.push(`r.account_id = ?`); params.push(rc.ctx.accountId) }
      const searchSql = p_search ? `WHERE (c.name LIKE ? OR c.phone LIKE ?)` : ''
      const searchParams = p_search ? [`%${p_search}%`, `%${p_search}%`] : []
      const base = `
        SELECT a.contact_id, c.name AS contact_name, c.phone AS contact_phone,
               a.first_reached_at, a.last_reached_at, a.reach_count
        FROM (
          SELECT r.contact_id, MIN(e.created_at) AS first_reached_at, MAX(e.created_at) AS last_reached_at, COUNT(*) AS reach_count
          FROM flow_run_events e JOIN flow_runs r ON r.id = e.flow_run_id
          WHERE ${where.join(' AND ')}
          GROUP BY r.contact_id
        ) a JOIN contacts c ON c.id = a.contact_id
        ${searchSql}`
      const allParams = [...params, ...searchParams]
      const total = await rc.runner.all(`SELECT COUNT(*) AS n FROM (${base})`, allParams)
      const limit = p_limit === null || Number(p_limit) <= 0 ? -1 : Number(p_limit)
      const offset = p_offset === null || Number(p_offset) < 0 ? 0 : Number(p_offset)
      const rows = await rc.runner.all(
        `${base} ORDER BY a.last_reached_at DESC, a.contact_id LIMIT ? OFFSET ?`,
        [...allParams, limit, offset],
      )
      const totalCount = Number(total[0]?.n ?? 0)
      return rows.map((r) => ({ ...r, reach_count: Number(r.reach_count), total_count: totalCount }))
    },
  },

  // ── 044: broadcast button analytics ─────────────────────────────────
  get_broadcast_button_analytics: {
    access: 'user',
    async run({ p_account_id, p_broadcast_id }, rc) {
      if (rc.ctx && p_account_id !== rc.ctx.accountId) return []
      const rows = await rc.runner.all(
        `SELECT button_index, button_name, button_type, COUNT(*) AS total_clicks, COUNT(DISTINCT contact_id) AS unique_users
         FROM broadcast_button_clicks WHERE account_id = ? AND broadcast_id = ?
         GROUP BY button_index, button_name, button_type`,
        [p_account_id, p_broadcast_id],
      )
      return rows
    },
  },
}

/**
 * Execute an RPC with access control:
 *   service → may call everything (user functions run unscoped)
 *   user    → 'user' and 'anon' functions, scoped to its account
 *   anon    → 'anon' functions only
 */
export async function executeRpc(
  fn: string,
  args: Record<string, unknown>,
  rc: RpcContext,
): Promise<unknown> {
  const def = Object.prototype.hasOwnProperty.call(RPCS, fn) ? RPCS[fn] : undefined
  if (!def) throw err(`Could not find the function public.${fn}`, 'PGRST202', 404)
  if (rc.caller === 'user' && !rc.ctx) throw err('Unauthorized', '42501', 401)
  if (rc.caller !== 'user' && rc.ctx) throw err('Invalid RPC context', '42501', 500)

  const allowed =
    rc.caller === 'service' ||
    def.access === 'anon' ||
    (def.access === 'user' && rc.caller === 'user')
  if (!allowed) {
    throw err(
      rc.caller === 'anon' ? 'Unauthorized' : `permission denied for function ${fn}`,
      '42501',
      rc.caller === 'anon' ? 401 : 403,
    )
  }
  return def.run(args, rc)
}
