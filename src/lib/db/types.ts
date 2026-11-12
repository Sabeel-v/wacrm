/**
 * Core types for the D1 data layer: a Supabase-compatible client
 * (`.from().select().eq()…`) that runs on Cloudflare D1 instead of
 * PostgREST. See docs/data-layer.md.
 */

export type Row = Record<string, unknown>

// ── Select list (PostgREST `select=` syntax) ─────────────────────────
export type SelectItem =
  | { type: 'star' }
  | { type: 'column'; name: string; alias?: string }
  | {
      type: 'embed'
      /** Key the embedded value is returned under. */
      alias: string
      table: string
      /** FK hint: column name or `<table>_<column>_fkey`. */
      hint?: string
      /** `!inner`: drop base rows with no match. */
      inner: boolean
      items: SelectItem[]
    }

// ── Filters ──────────────────────────────────────────────────────────
export type FilterOp =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'like'
  | 'ilike'
  | 'is'
  | 'in'
  | 'contains'

export type Filter =
  | { type: 'cond'; column: string; op: FilterOp; value: unknown; not?: boolean }
  | { type: 'or' | 'and'; filters: Filter[]; not?: boolean }

export interface OrderBy {
  column: string
  ascending: boolean
  nullsFirst?: boolean
}

// ── Query AST (what the builder produces and the engine executes) ───
export type Action = 'select' | 'insert' | 'update' | 'upsert' | 'delete'

export interface QueryAst {
  table: string
  action: Action
  /** Select list; for mutations, the RETURNING projection (null = none). */
  select: SelectItem[] | null
  filters: Filter[]
  order: OrderBy[]
  limit?: number
  offset?: number
  single?: 'single' | 'maybeSingle'
  count?: 'exact'
  head?: boolean
  values?: Row | Row[]
  onConflict?: string
  ignoreDuplicates?: boolean
}

export interface RpcCall {
  fn: string
  args: Record<string, unknown>
}

// ── Results (same shape as supabase-js) ──────────────────────────────
export interface DbError {
  message: string
  /** Postgres-compatible where it matters: 23505 unique, 23503 FK, 23514 check, 23502 not null, 42501 policy, PGRST116 single. */
  code: string
  details: string | null
  hint: string | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped like supabase-js without generated types
export interface DbResult<T = any> {
  data: T
  error: DbError | null
  count: number | null
  status: number
  statusText: string
}

export class DbQueryError extends Error {
  readonly code: string
  readonly status: number
  readonly details: string | null
  constructor(message: string, code: string, status = 400, details: string | null = null) {
    super(message)
    this.name = 'DbQueryError'
    this.code = code
    this.status = status
    this.details = details
  }
}

/** Minimal SQL runner: D1 in production, node:sqlite in tests. */
export interface SqlRunner {
  all(sql: string, params: unknown[]): Promise<Row[]>
  /** Runs statements atomically (D1 batch = one transaction). */
  batch(statements: { sql: string; params: unknown[] }[]): Promise<Row[][]>
}
