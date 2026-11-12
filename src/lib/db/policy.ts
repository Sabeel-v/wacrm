/**
 * Port of the Supabase RLS policies (supabase/migrations/017 onwards) to
 * the D1 data layer. Applied to every query made with a user's session —
 * from the browser via /api/db, and server routes using the user client.
 * The service (admin) client runs with no policy, like the service key.
 *
 * Model (unchanged from Postgres):
 *   - Every row belongs to an account; a user sees only their account.
 *   - Role tiers: owner > admin > agent > viewer (is_account_member).
 *   - Child tables inherit their parent's account (e.g. messages via
 *     conversations).
 *
 * Deny by default: a table with no rule is invisible and read-only.
 *
 * Differences from Postgres (deliberate):
 *   - Writes the role may not make return 42501 instead of silently
 *     affecting 0 rows, so failures are visible.
 *   - Browser requests never receive secret columns (encrypted Meta
 *     tokens, AI keys, webhook secrets, key/token hashes). Postgres RLS
 *     let any member read their ciphertext (MIGRATION_ASSESSMENT §10.4 #2).
 *   - accounts.owner_user_id and every row's id / account_id cannot be
 *     changed through an UPDATE (ownership moves via the transfer RPC).
 */
import type { Policy, ScopeMode, SqlFragment } from './engine'
import { DbQueryError, type Row, type SqlRunner } from './types'

export type AccountRole = 'owner' | 'admin' | 'agent' | 'viewer'

export interface PolicyContext {
  userId: string
  accountId: string
  role: AccountRole
  /** 'browser' requests (via /api/db) never see secret columns. */
  origin: 'browser' | 'server'
}

const RANK: Record<AccountRole, number> = { viewer: 1, agent: 2, admin: 3, owner: 4 }

type Scope =
  | { kind: 'account' } // row.account_id = caller's account
  | { kind: 'parent'; column: string; parent: string } // row.<column> → parent.id in caller's account
  | { kind: 'self_in_account' } // row.user_id = caller AND row.account_id = caller's account
  | { kind: 'account_row' } // accounts.id = caller's account
  | { kind: 'profile' } // read: self or same account; write: self only

interface TableRule {
  scope: Scope
  read: AccountRole | false
  insert: AccountRole | false
  update: AccountRole | false
  delete: AccountRole | false
  /** Never returned to the browser. */
  secret?: string[]
  /** If set, UPDATE may only change these columns. */
  updatable?: string[]
  /** UPDATE may never change these columns (in addition to id/account_id). */
  immutable?: string[]
}

const account = { kind: 'account' } as const
const rw = (read: AccountRole, write: AccountRole | false): Pick<TableRule, 'read' | 'insert' | 'update' | 'delete'> => ({
  read,
  insert: write,
  update: write,
  delete: write,
})

export const RULES: Record<string, TableRule> = {
  // ── account-scoped tables ─────────────────────────────────────────
  contacts: { scope: account, ...rw('viewer', 'agent') },
  tags: { scope: account, ...rw('viewer', 'admin') },
  custom_fields: { scope: account, ...rw('viewer', 'admin') },
  contact_notes: { scope: account, ...rw('viewer', 'agent') },
  conversations: { scope: account, ...rw('viewer', 'agent') },
  whatsapp_config: { scope: account, ...rw('viewer', 'admin'), secret: ['access_token', 'verify_token'] },
  message_templates: { scope: account, ...rw('viewer', 'admin') },
  pipelines: { scope: account, ...rw('viewer', 'admin') },
  deals: { scope: account, ...rw('viewer', 'agent') },
  broadcasts: { scope: account, ...rw('viewer', 'agent') },
  automations: { scope: account, ...rw('viewer', 'agent') },
  automation_logs: { scope: account, ...rw('viewer', false) },
  flows: { scope: account, ...rw('viewer', 'agent') },
  flow_runs: { scope: account, ...rw('viewer', false) },
  api_keys: { scope: account, ...rw('viewer', 'admin'), secret: ['key_hash'] },
  webhook_endpoints: { scope: account, ...rw('viewer', 'admin'), secret: ['secret'] },
  ai_configs: { scope: account, ...rw('viewer', 'admin'), secret: ['api_key', 'embeddings_api_key'] },
  ai_knowledge_documents: { scope: account, ...rw('viewer', 'admin') },
  ai_knowledge_chunks: { scope: account, ...rw('viewer', 'admin') },
  ai_usage_log: { scope: account, ...rw('admin', false) },
  quick_replies: { scope: account, ...rw('viewer', 'agent') },
  broadcast_button_clicks: { scope: account, read: 'viewer', insert: 'agent', update: false, delete: 'agent' },
  broadcast_url_tokens: { scope: account, read: 'viewer', insert: 'agent', update: false, delete: 'agent' },
  account_invitations: { scope: account, ...rw('admin', 'admin'), secret: ['token_hash'] },
  // automation_pending_executions: no rule → service role only (as in Postgres)

  // ── child tables (inherit the parent's account) ────────────────────
  contact_tags: { scope: { kind: 'parent', column: 'contact_id', parent: 'contacts' }, ...rw('viewer', 'agent') },
  contact_custom_values: { scope: { kind: 'parent', column: 'contact_id', parent: 'contacts' }, ...rw('viewer', 'agent') },
  messages: { scope: { kind: 'parent', column: 'conversation_id', parent: 'conversations' }, ...rw('viewer', 'agent') },
  message_reactions: { scope: { kind: 'parent', column: 'conversation_id', parent: 'conversations' }, ...rw('viewer', 'agent') },
  pipeline_stages: { scope: { kind: 'parent', column: 'pipeline_id', parent: 'pipelines' }, ...rw('viewer', 'admin') },
  broadcast_recipients: { scope: { kind: 'parent', column: 'broadcast_id', parent: 'broadcasts' }, ...rw('viewer', 'agent') },
  automation_steps: { scope: { kind: 'parent', column: 'automation_id', parent: 'automations' }, ...rw('viewer', 'agent') },
  flow_nodes: { scope: { kind: 'parent', column: 'flow_id', parent: 'flows' }, ...rw('viewer', 'agent') },
  flow_run_events: { scope: { kind: 'parent', column: 'flow_run_id', parent: 'flow_runs' }, ...rw('viewer', false) },

  // ── special scopes ─────────────────────────────────────────────────
  notifications: {
    scope: { kind: 'self_in_account' },
    read: 'viewer',
    insert: false,
    update: 'viewer',
    delete: false,
    updatable: ['read_at'], // column-level grant in 027
  },
  accounts: {
    scope: { kind: 'account_row' },
    read: 'viewer',
    insert: false,
    update: 'admin',
    delete: false,
    immutable: ['owner_user_id'],
  },
  profiles: {
    scope: { kind: 'profile' },
    read: 'viewer',
    insert: false, // created by the signup hook (service role)
    update: 'viewer', // own profile only (write scope)
    delete: false,
    immutable: ['user_id', 'account_role'], // 034 trigger
  },
  // users, member_presence: no rule → invisible to user sessions
}

const ALWAYS_IMMUTABLE = ['id', 'account_id']

const denied = (msg: string) => new DbQueryError(msg, '42501', 403)

export function createPolicy(ctx: PolicyContext): Policy {
  const has = (min: AccountRole | false) => min !== false && RANK[ctx.role] >= RANK[min]
  const rule = (table: string) => RULES[table]

  const scope = (table: string, ref: string, mode: ScopeMode): SqlFragment | null => {
    const r = rule(table)
    if (!r) return { sql: '0', params: [] }
    const col = (c: string) => `"${ref}"."${c}"`
    switch (r.scope.kind) {
      case 'account':
        return { sql: `${col('account_id')} = ?`, params: [ctx.accountId] }
      case 'parent':
        return {
          sql: `${col(r.scope.column)} IN (SELECT "id" FROM "${r.scope.parent}" WHERE "account_id" = ?)`,
          params: [ctx.accountId],
        }
      case 'self_in_account':
        return { sql: `${col('user_id')} = ? AND ${col('account_id')} = ?`, params: [ctx.userId, ctx.accountId] }
      case 'account_row':
        return { sql: `${col('id')} = ?`, params: [ctx.accountId] }
      case 'profile':
        return mode === 'read'
          ? { sql: `(${col('user_id')} = ? OR ${col('account_id')} = ?)`, params: [ctx.userId, ctx.accountId] }
          : { sql: `${col('user_id')} = ?`, params: [ctx.userId] }
    }
  }

  return {
    canRead: (table) => {
      const r = rule(table)
      return !!r && has(r.read)
    },

    assertWrite: (table, action) => {
      const r = rule(table)
      if (!r) throw denied(`permission denied for table ${table}`)
      if (!has(r[action])) {
        const need = r[action]
        throw denied(
          need === false
            ? `${action} is not allowed on ${table}`
            : `This action requires the '${need}' role or higher`,
        )
      }
    },

    scope,

    hiddenColumns: (table) => new Set(ctx.origin === 'browser' ? rule(table)?.secret ?? [] : []),

    checkInsertRow: (table, row: Row) => {
      const r = rule(table)
      if (!r) throw denied(`permission denied for table ${table}`)
      const kind = r.scope.kind
      if (kind === 'account' || kind === 'self_in_account') {
        if (row.account_id === undefined || row.account_id === null) row.account_id = ctx.accountId
        if (row.account_id !== ctx.accountId) {
          throw denied(`new row violates row-level security policy for table "${table}"`)
        }
      }
      if (kind === 'self_in_account' && row.user_id !== ctx.userId) {
        throw denied(`new row violates row-level security policy for table "${table}"`)
      }
    },

    checkInsertParents: async (table, rows, runner: SqlRunner) => {
      const r = rule(table)
      if (!r || r.scope.kind !== 'parent') return
      const ids = [...new Set(rows.map((row) => row[r.scope.kind === 'parent' ? r.scope.column : '']))]
      if (ids.some((id) => id === null || id === undefined)) {
        throw denied(`new row violates row-level security policy for table "${table}"`)
      }
      const found = await runner.all(
        `SELECT COUNT(*) AS n FROM "${r.scope.parent}" WHERE "id" IN (SELECT value FROM json_each(?)) AND "account_id" = ?`,
        [JSON.stringify(ids), ctx.accountId],
      )
      if (Number(found[0]?.n ?? 0) !== ids.length) {
        throw denied(`new row violates row-level security policy for table "${table}"`)
      }
    },

    checkUpdate: async (table, values: Row, runner: SqlRunner) => {
      const r = rule(table)
      if (!r) throw denied(`permission denied for table ${table}`)
      const keys = Object.keys(values).filter((k) => k !== 'updated_at')
      if (r.updatable) {
        const bad = keys.filter((k) => !r.updatable!.includes(k))
        if (bad.length) throw denied(`permission denied to update ${table}.${bad.join(', ')}`)
      }
      const locked = [...ALWAYS_IMMUTABLE, ...(r.immutable ?? [])].filter((k) => k in values)
      if (locked.length) {
        throw denied(`${table}.${locked.join(', ')} cannot be changed here`)
      }
      // Moving a child row to another parent: the new parent must be in the account too.
      if (r.scope.kind === 'parent' && r.scope.column in values) {
        const found = await runner.all(
          `SELECT COUNT(*) AS n FROM "${r.scope.parent}" WHERE "id" = ? AND "account_id" = ?`,
          [values[r.scope.column], ctx.accountId],
        )
        if (Number(found[0]?.n ?? 0) !== 1) {
          throw denied(`new row violates row-level security policy for table "${table}"`)
        }
      }
    },
  }
}

/** No session (or no profile): nothing is readable or writable, like the anon role. */
export const anonymousPolicy: Policy = {
  canRead: () => false,
  assertWrite: () => {
    throw new DbQueryError('Unauthorized', '42501', 401)
  },
  scope: () => ({ sql: '0', params: [] }),
  hiddenColumns: () => new Set<string>(),
  checkInsertRow: () => {
    throw new DbQueryError('Unauthorized', '42501', 401)
  },
  checkInsertParents: async () => {
    throw new DbQueryError('Unauthorized', '42501', 401)
  },
  checkUpdate: async () => {
    throw new DbQueryError('Unauthorized', '42501', 401)
  },
}

export function hasMinRole(role: AccountRole, min: AccountRole): boolean {
  return RANK[role] >= RANK[min]
}
