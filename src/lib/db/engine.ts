/**
 * Executes a QueryAst against SQLite/D1 with PostgREST-compatible
 * semantics, optionally under a Policy (the port of Supabase RLS).
 *
 * Safety: table and column identifiers are validated against the
 * generated schema (never interpolated from input), and every value is
 * a bound parameter.
 */
import { errorResult, toDbError } from './engine-errors'
import { REALTIME_TABLES, type RealtimeSink } from './realtime'
import { SCHEMA, type ColumnKind, type ForeignKey } from './schema.generated'
import {
  DbQueryError,
  type DbResult,
  type Filter,
  type QueryAst,
  type Row,
  type SelectItem,
  type SqlRunner,
} from './types'

// ── Policy contract (implemented in policy.ts) ─────────────────────────
export interface SqlFragment {
  sql: string
  params: unknown[]
}

export interface Policy {
  /** false → reads return no rows (like RLS), never an error. */
  canRead(table: string): boolean
  /** Throws DbQueryError 42501 when the write is not allowed. */
  assertWrite(table: string, action: 'insert' | 'update' | 'delete'): void
  /**
   * Row condition for `table` referenced as `ref`, or null for none.
   * 'read' = rows the caller may see; 'write' = rows it may update/delete.
   */
  scope(table: string, ref: string, mode: ScopeMode): SqlFragment | null
  /** Columns that must never be returned (e.g. encrypted tokens). */
  hiddenColumns(table: string): ReadonlySet<string>
  /** Validate one row before INSERT (may throw 42501). */
  checkInsertRow(table: string, row: Row): void
  /** Validate rows' parents before INSERT (e.g. contact belongs to account). */
  checkInsertParents(table: string, rows: Row[], runner: SqlRunner): Promise<void>
  /** Validate the SET values of an UPDATE (may throw 42501). */
  checkUpdate(table: string, values: Row, runner: SqlRunner): Promise<void>
}

export type ScopeMode = 'read' | 'write'

export interface EngineOptions {
  runner: SqlRunner
  /** Pushes changes to browsers (Durable Object hub). Optional; best-effort. */
  realtime?: RealtimeSink
  /** null = service role (bypasses policies, like the Supabase service key). */
  policy: Policy | null
}

// ── Virtual columns (API name ≠ storage) ──────────────────────────────
interface VirtualColumn {
  column: string
  read: (v: unknown) => unknown
  write: (v: unknown) => unknown
}

const VIRTUAL: Record<string, Record<string, VirtualColumn>> = {
  deals: {
    // Postgres `value NUMERIC(12,2)` is stored as integer cents in D1.
    value: {
      column: 'value_cents',
      read: (v) => (v === null || v === undefined ? null : Number(v) / 100),
      write: (v) => (v === null || v === undefined || v === '' ? 0 : Math.round(Number(v) * 100)),
    },
  },
}

// Error mapping lives in engine-errors.ts (shared with the browser bundle).
export { errorResult, toDbError }

/** D1 limit on bound parameters per statement (VERIFY against current docs). */
export const MAX_BOUND_PARAMS = 100

const NOW_SQL = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`

// ── Computed columns (Postgres GENERATED ALWAYS AS … STORED) ───────────
// SQLite can't run these expressions (no regexp), so the engine derives
// them on every insert / upsert / update that writes the source column,
// for every caller (browser, server routes, webhook consumer, imports).
interface ComputedColumn {
  source: string
  compute: (sourceValue: unknown) => unknown
}

const COMPUTED: Record<string, Record<string, ComputedColumn>> = {
  contacts: {
    // 022: GENERATED ALWAYS AS (regexp_replace(phone, '\D', '', 'g')) STORED
    phone_normalized: { source: 'phone', compute: (v) => String(v ?? '').replace(/\D/g, '') },
  },
}

/** Fill computed columns from their source column, if it is being written. */
function applyComputed(table: string, row: Row): void {
  for (const [col, def] of Object.entries(COMPUTED[table] ?? {})) {
    if (def.source in row) row[col] = def.compute(row[def.source])
  }
}

/** Quote an identifier (escaping embedded quotes). Names are also schema-validated. */
const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`

function tableMeta(table: string) {
  const meta = SCHEMA[table]
  if (!meta) throw new DbQueryError(`Could not find the table '${table}'`, 'PGRST205', 404)
  return meta
}

function columnKind(table: string, column: string): ColumnKind | undefined {
  return SCHEMA[table]?.columns[column]
}

/** Resolve an API column name to its storage column (validates it exists). */
function resolveColumn(table: string, name: string): { dbCol: string; virtual?: VirtualColumn } {
  const v = VIRTUAL[table]?.[name]
  if (v) return { dbCol: v.column, virtual: v }
  if (!(name in tableMeta(table).columns)) {
    throw new DbQueryError(`Could not find the '${name}' column of '${table}'`, 'PGRST204', 400)
  }
  return { dbCol: name }
}

/** JS value → SQLite value for `table.column`. */
function toDb(table: string, name: string, value: unknown): unknown {
  const v = VIRTUAL[table]?.[name]
  if (v) return v.write(value)
  if (value === undefined || value === null) return null
  const kind = columnKind(table, name)
  if (kind === 'json') return JSON.stringify(value)
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'object') return JSON.stringify(value)
  return value
}

/** Scalar used in a WHERE comparison (no JSON encoding of strings). */
function toDbScalar(table: string, name: string, value: unknown): unknown {
  const v = VIRTUAL[table]?.[name]
  if (v) return v.write(value)
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value !== null && typeof value === 'object') return JSON.stringify(value)
  return value
}

/** SQLite value → JS value for `table.column`. */
function fromDb(table: string, column: string, value: unknown): unknown {
  if (value === null || value === undefined) return null
  const kind = columnKind(table, column)
  if (kind === 'boolean') return value === 1 || value === true || value === '1'
  if (kind === 'json' && typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  return value
}

// ── Filters → SQL ──────────────────────────────────────────────────────
function globFromLike(pattern: string): string {
  // Case-sensitive LIKE via GLOB: escape GLOB specials, then map wildcards.
  return pattern.replace(/[[\]*?]/g, (c) => `[${c}]`).replace(/%/g, '*').replace(/_/g, '?')
}

function compileFilter(
  table: string,
  ref: string,
  f: Filter,
  hidden: ReadonlySet<string>,
): SqlFragment {
  if (f.type !== 'cond') {
    if (f.filters.length === 0) return { sql: f.type === 'and' ? '1' : '0', params: [] }
    const parts = f.filters.map((x) => compileFilter(table, ref, x, hidden))
    const joined = parts.map((p) => `(${p.sql})`).join(f.type === 'and' ? ' AND ' : ' OR ')
    return { sql: f.not ? `NOT (${joined})` : joined, params: parts.flatMap((p) => p.params) }
  }

  if (hidden.has(f.column)) {
    throw new DbQueryError(`permission denied for column ${f.column}`, '42501', 403)
  }
  const { dbCol } = resolveColumn(table, f.column)
  const col = `${q(ref)}.${q(dbCol)}`
  let sql: string
  let params: unknown[] = []
  const val = () => toDbScalar(table, f.column, f.value)

  switch (f.op) {
    case 'eq':
      sql = `${col} = ?`
      params = [val()]
      break
    case 'neq':
      sql = `${col} <> ?`
      params = [val()]
      break
    case 'gt':
      sql = `${col} > ?`
      params = [val()]
      break
    case 'gte':
      sql = `${col} >= ?`
      params = [val()]
      break
    case 'lt':
      sql = `${col} < ?`
      params = [val()]
      break
    case 'lte':
      sql = `${col} <= ?`
      params = [val()]
      break
    case 'like':
      sql = `${col} GLOB ?`
      params = [globFromLike(String(f.value))]
      break
    case 'ilike':
      sql = `${col} LIKE ?`
      params = [String(f.value)]
      break
    case 'is':
      if (f.value === null) sql = `${col} IS NULL`
      else if (f.value === true) sql = `${col} = 1`
      else if (f.value === false) sql = `${col} = 0`
      else throw new DbQueryError(`Invalid "is" value`, 'PGRST100')
      break
    case 'in': {
      const list = Array.isArray(f.value) ? f.value : [f.value]
      sql = `${col} IN (SELECT value FROM json_each(?))`
      params = [JSON.stringify(list.map((x) => toDbScalar(table, f.column, x)))]
      break
    }
    case 'contains': {
      if (!Array.isArray(f.value)) {
        throw new DbQueryError('contains() is only supported for array columns', 'PGRST100')
      }
      if (f.value.length === 0) {
        sql = '1'
      } else {
        sql = f.value.map(() => `EXISTS (SELECT 1 FROM json_each(${col}) WHERE value = ?)`).join(' AND ')
        params = f.value.map((x) => toDbScalar(table, f.column, x))
      }
      break
    }
    default:
      throw new DbQueryError(`Unsupported operator ${String(f.op)}`, 'PGRST100')
  }
  return { sql: f.not ? `NOT (${sql})` : sql, params }
}

// ── Relations for embeds ───────────────────────────────────────────────
interface Relation {
  /** forward: base.baseCol → target.targetCol (to-one). reverse: target.targetCol → base.baseCol (to-many). */
  kind: 'forward' | 'reverse'
  baseCol: string
  targetCol: string
}

function resolveRelation(base: string, target: string, hint?: string): Relation {
  tableMeta(target)
  const matchesHint = (owner: string, fk: ForeignKey) =>
    !hint || hint === fk.column || hint === `${owner}_${fk.column}_fkey`

  const forward = tableMeta(base)
    .foreignKeys.filter((fk) => fk.references === target && matchesHint(base, fk))
    .map((fk): Relation => ({ kind: 'forward', baseCol: fk.column, targetCol: fk.referencedColumn }))
  const reverse = tableMeta(target)
    .foreignKeys.filter((fk) => fk.references === base && matchesHint(target, fk))
    .map((fk): Relation => ({ kind: 'reverse', baseCol: fk.referencedColumn, targetCol: fk.column }))

  const all = [...forward, ...reverse]
  if (all.length === 1) return all[0]
  if (all.length === 0) {
    throw new DbQueryError(`Could not find a relationship between '${base}' and '${target}'`, 'PGRST200', 400)
  }
  throw new DbQueryError(
    `More than one relationship was found for '${base}' and '${target}'; add a hint like ${target}!<column>(...)`,
    'PGRST201',
    300,
  )
}

// ── Select planning and execution ──────────────────────────────────────
interface OutColumn {
  out: string
  dbCol: string
  apiName: string
  virtual?: VirtualColumn
}

interface EmbedPlan {
  item: Extract<SelectItem, { type: 'embed' }>
  rel: Relation
  filters: Filter[]
}

interface Plan {
  table: string
  out: OutColumn[]
  /** Storage columns fetched only to link embeds (stripped from output). */
  linkCols: Set<string>
  embeds: EmbedPlan[]
}

function visibleColumns(table: string, policy: Policy | null): string[] {
  const hidden = policy?.hiddenColumns(table) ?? new Set<string>()
  const virtualTargets = new Set(Object.values(VIRTUAL[table] ?? {}).map((v) => v.column))
  const cols = Object.keys(tableMeta(table).columns).filter((c) => !hidden.has(c) && !virtualTargets.has(c))
  return [...cols, ...Object.keys(VIRTUAL[table] ?? {})]
}

function planSelect(table: string, items: SelectItem[], filters: Filter[], policy: Policy | null): Plan {
  const hidden = policy?.hiddenColumns(table) ?? new Set<string>()
  const plan: Plan = { table, out: [], linkCols: new Set(), embeds: [] }
  const addColumn = (apiName: string, out: string) => {
    if (hidden.has(apiName)) {
      throw new DbQueryError(`permission denied for column ${apiName}`, '42501', 403)
    }
    const { dbCol, virtual } = resolveColumn(table, apiName)
    if (!plan.out.some((c) => c.out === out)) plan.out.push({ out, dbCol, apiName, virtual })
  }

  for (const item of items) {
    if (item.type === 'star') {
      for (const c of visibleColumns(table, policy)) addColumn(c, c)
    } else if (item.type === 'column') {
      addColumn(item.name, item.alias ?? item.name)
    } else {
      const rel = resolveRelation(table, item.table, item.hint)
      const embedFilters = filters
        .filter((f) => f.type === 'cond' && f.column.includes('.'))
        .filter((f) => {
          const prefix = (f as { column: string }).column.split('.')[0]
          return prefix === item.alias || prefix === item.table
        })
        .map((f) => ({ ...f, column: (f as { column: string }).column.split('.').slice(1).join('.') }) as Filter)
      plan.embeds.push({ item, rel, filters: embedFilters })
    }
  }

  for (const e of plan.embeds) {
    if (!plan.out.some((c) => c.dbCol === e.rel.baseCol)) plan.linkCols.add(e.rel.baseCol)
  }
  return plan
}

/** EXISTS(...) condition implementing `!inner` for an embed. */
function innerExists(baseRef: string, e: EmbedPlan, policy: Policy | null, depth: number): SqlFragment {
  const ref = `e${depth}`
  const target = e.item.table
  const hidden = policy?.hiddenColumns(target) ?? new Set<string>()
  const parts: SqlFragment[] = [
    { sql: `${q(ref)}.${q(e.rel.targetCol)} = ${q(baseRef)}.${q(e.rel.baseCol)}`, params: [] },
    ...e.filters.map((f) => compileFilter(target, ref, f, hidden)),
  ]
  if (policy) {
    if (!policy.canRead(target)) return { sql: '0', params: [] }
    const s = policy.scope(target, ref, 'read')
    if (s) parts.push(s)
  }
  return {
    sql: `EXISTS (SELECT 1 FROM ${q(target)} AS ${q(ref)} WHERE ${parts.map((p) => `(${p.sql})`).join(' AND ')})`,
    params: parts.flatMap((p) => p.params),
  }
}

interface SelectOptions {
  filters: Filter[]
  extra?: SqlFragment[]
  order?: QueryAst['order']
  limit?: number
  offset?: number
}

function buildWhere(
  table: string,
  ref: string,
  plan: Plan,
  opts: SelectOptions,
  policy: Policy | null,
  depth: number,
  mode: ScopeMode = 'read',
): SqlFragment {
  const hidden = policy?.hiddenColumns(table) ?? new Set<string>()
  const parts: SqlFragment[] = []
  for (const f of opts.filters) {
    if (f.type === 'cond' && f.column.includes('.')) {
      // Applied inside the matching embed; reject filters on tables not embedded.
      const prefix = f.column.split('.')[0]
      if (!plan.embeds.some((e) => e.item.alias === prefix || e.item.table === prefix)) {
        throw new DbQueryError(`Filter on '${f.column}' needs '${prefix}' in the select list`, 'PGRST100')
      }
      continue
    }
    parts.push(compileFilter(table, ref, f, hidden))
  }
  for (const e of plan.embeds) if (e.item.inner) parts.push(innerExists(ref, e, policy, depth + 1))
  if (policy) {
    const s = policy.scope(table, ref, mode)
    if (s) parts.push(s)
  }
  parts.push(...(opts.extra ?? []))
  if (!parts.length) return { sql: '', params: [] }
  return {
    sql: ` WHERE ${parts.map((p) => `(${p.sql})`).join(' AND ')}`,
    params: parts.flatMap((p) => p.params),
  }
}

function buildOrder(table: string, ref: string, order: QueryAst['order'] = []): string {
  if (!order.length) return ''
  const parts = order.map((o) => {
    const { dbCol } = resolveColumn(table, o.column)
    // Postgres defaults: ASC NULLS LAST, DESC NULLS FIRST.
    const nullsFirst = o.nullsFirst ?? !o.ascending
    return `${q(ref)}.${q(dbCol)} ${o.ascending ? 'ASC' : 'DESC'} NULLS ${nullsFirst ? 'FIRST' : 'LAST'}`
  })
  return ` ORDER BY ${parts.join(', ')}`
}

function convertRow(plan: Plan, raw: Row): Row {
  const out: Row = {}
  for (const c of plan.out) {
    const v = raw[c.out]
    out[c.out] = c.virtual ? c.virtual.read(v) : fromDb(plan.table, c.dbCol, v)
  }
  return out
}

async function selectRows(
  table: string,
  items: SelectItem[],
  opts: SelectOptions,
  engine: EngineOptions,
  depth = 0,
): Promise<Row[]> {
  const { runner, policy } = engine
  if (policy && !policy.canRead(table)) return []
  const plan = planSelect(table, items, opts.filters, policy)
  const ref = `t${depth}`

  const selectList = [
    ...plan.out.map((c) => `${q(ref)}.${q(c.dbCol)} AS ${q(c.out)}`),
    ...[...plan.linkCols].map((c) => `${q(ref)}.${q(c)} AS ${q(`__link_${c}`)}`),
  ]
  if (!selectList.length) selectList.push('1 AS "__none"')

  const where = buildWhere(table, ref, plan, opts, policy, depth)
  let sql = `SELECT ${selectList.join(', ')} FROM ${q(table)} AS ${q(ref)}${where.sql}${buildOrder(table, ref, opts.order)}`
  const params = [...where.params]
  if (opts.limit !== undefined) {
    sql += ` LIMIT ?`
    params.push(opts.limit)
    if (opts.offset) {
      sql += ` OFFSET ?`
      params.push(opts.offset)
    }
  } else if (opts.offset) {
    sql += ` LIMIT -1 OFFSET ?`
    params.push(opts.offset)
  }

  const rawRows = await runner.all(sql, params)
  const rows = rawRows.map((r) => convertRow(plan, r))

  for (const e of plan.embeds) {
    const linkValue = (raw: Row) => {
      const outCol = plan.out.find((c) => c.dbCol === e.rel.baseCol && !c.virtual)
      return outCol ? raw[outCol.out] : raw[`__link_${e.rel.baseCol}`]
    }
    const keys = [...new Set(rawRows.map(linkValue).filter((v) => v !== null && v !== undefined))]

    let related: Row[] = []
    const targetKeyOut = `__key_${e.rel.targetCol}`
    if (keys.length) {
      // Fetch the link column under a private alias, alongside the requested items.
      const linkItem: SelectItem = { type: 'column', name: e.rel.targetCol, alias: targetKeyOut }
      related = await selectRows(
        e.item.table,
        [...e.item.items, linkItem],
        {
          filters: [
            ...e.filters,
            { type: 'cond', column: e.rel.targetCol, op: 'in', value: keys },
          ],
        },
        engine,
        depth + 1,
      )
    }

    const byKey = new Map<unknown, Row[]>()
    for (const r of related) {
      const k = r[targetKeyOut]
      delete r[targetKeyOut]
      if (!byKey.has(k)) byKey.set(k, [])
      byKey.get(k)!.push(r)
    }

    rows.forEach((row, i) => {
      const k = linkValue(rawRows[i])
      const matches = k === null || k === undefined ? [] : byKey.get(k) ?? []
      row[e.item.alias] = e.rel.kind === 'forward' ? matches[0] ?? null : matches
    })
  }

  // `!inner` already filtered in SQL; also drop rows whose embed was hidden by policy.
  return rows.filter((row) =>
    plan.embeds.every((e) => {
      if (!e.item.inner) return true
      const v = row[e.item.alias]
      return Array.isArray(v) ? v.length > 0 : v !== null
    }),
  )
}

async function countRows(table: string, ast: QueryAst, engine: EngineOptions): Promise<number> {
  const { runner, policy } = engine
  if (policy && !policy.canRead(table)) return 0
  const plan = planSelect(table, ast.select ?? [{ type: 'star' }], ast.filters, policy)
  const where = buildWhere(table, 't0', plan, { filters: ast.filters }, policy, 0)
  const rows = await runner.all(`SELECT COUNT(*) AS n FROM ${q(table)} AS "t0"${where.sql}`, where.params)
  return Number(rows[0]?.n ?? 0)
}

// ── Mutations ──────────────────────────────────────────────────────────
function prepareRow(table: string, row: Row, policy: Policy | null): Row {
  const meta = tableMeta(table)
  const out: Row = {}
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue
    const { dbCol } = resolveColumn(table, k)
    out[dbCol] = toDb(table, k, v)
  }
  applyComputed(table, out)
  if ('id' in meta.columns && (out.id === undefined || out.id === null)) out.id = crypto.randomUUID()
  policy?.checkInsertRow(table, out)
  return out
}

function returningList(table: string): string {
  return Object.keys(tableMeta(table).columns).map(q).join(', ')
}

/** Project mutation RETURNING rows to the requested select (or re-select if it has embeds). */
async function projectReturned(
  table: string,
  ast: QueryAst,
  returned: Row[],
  engine: EngineOptions,
): Promise<Row[]> {
  if (!ast.select) return []
  const hasEmbeds = ast.select.some((i) => i.type === 'embed')
  if (hasEmbeds && 'id' in tableMeta(table).columns) {
    const ids = returned.map((r) => r.id)
    const rows = await selectRows(table, [...ast.select, { type: 'column', name: 'id', alias: '__rid' }], {
      filters: [{ type: 'cond', column: 'id', op: 'in', value: ids }],
    }, engine)
    const byId = new Map(rows.map((r) => [r.__rid, r]))
    return ids.map((id) => {
      const r = byId.get(id)
      if (r) delete r.__rid
      return r
    }).filter((r): r is Row => !!r)
  }
  const plan = planSelect(table, ast.select, [], engine.policy)
  return returned.map((raw) => {
    const out: Row = {}
    for (const c of plan.out) {
      out[c.out] = c.virtual ? c.virtual.read(raw[c.dbCol]) : fromDb(table, c.dbCol, raw[c.dbCol])
    }
    return out
  })
}

async function runInsert(ast: QueryAst, engine: EngineOptions): Promise<Row[]> {
  const { table } = ast
  const { runner, policy } = engine
  const upsert = ast.action === 'upsert'
  policy?.assertWrite(table, 'insert')
  if (upsert && !ast.ignoreDuplicates) policy?.assertWrite(table, 'update')

  const input = Array.isArray(ast.values) ? ast.values : ast.values ? [ast.values] : []
  if (!input.length) return []
  const rows = input.map((r) => prepareRow(table, r, policy))
  if (policy) await policy.checkInsertParents(table, rows, runner)

  const conflictCols = upsert
    ? (ast.onConflict ?? 'id').split(',').map((c) => resolveColumn(table, c.trim()).dbCol)
    : []
  const hasUpdatedAt = 'updated_at' in tableMeta(table).columns

  // Group rows by column set so each statement has one column list.
  const groups = new Map<string, Row[]>()
  for (const r of rows) {
    const key = Object.keys(r).sort().join(',')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(r)
  }

  const statements: { sql: string; params: unknown[] }[] = []
  for (const [key, groupRows] of groups) {
    const cols = key.split(',')
    // ON CONFLICT clause. Under a policy, DO UPDATE only touches existing
    // rows inside the caller's scope (like RLS USING on the update half).
    let conflict = ''
    let conflictParams: unknown[] = []
    if (upsert) {
      const target = conflictCols.map(q).join(', ')
      const sets = cols
        .filter((c) => !conflictCols.includes(c) && c !== 'id')
        .map((c) => `${q(c)} = excluded.${q(c)}`)
      if (hasUpdatedAt && !cols.includes('updated_at')) sets.push(`"updated_at" = ${NOW_SQL}`)
      if (ast.ignoreDuplicates || !sets.length) {
        conflict = ` ON CONFLICT (${target}) DO NOTHING`
      } else {
        const scope = policy?.scope(table, table, 'write') ?? null
        conflict = ` ON CONFLICT (${target}) DO UPDATE SET ${sets.join(', ')}${scope ? ` WHERE ${scope.sql}` : ''}`
        conflictParams = scope?.params ?? []
      }
    }
    const perStatement = Math.max(1, Math.floor((MAX_BOUND_PARAMS - conflictParams.length) / cols.length))
    for (let i = 0; i < groupRows.length; i += perStatement) {
      const chunk = groupRows.slice(i, i + perStatement)
      const values = chunk.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ')
      statements.push({
        sql: `INSERT INTO ${q(table)} (${cols.map(q).join(', ')}) VALUES ${values}${conflict} RETURNING ${returningList(table)}`,
        params: [...chunk.flatMap((r) => cols.map((c) => r[c])), ...conflictParams],
      })
    }
  }

  const results = statements.length === 1
    ? [await runner.all(statements[0].sql, statements[0].params)]
    : await runner.batch(statements)
  const returned = results.flat()
  // Return rows in input order (upsert-ignored rows are absent, like PostgREST).
  const byId = new Map(returned.map((r) => [r.id, r]))
  if ('id' in tableMeta(table).columns && !upsert) {
    return rows.map((r) => byId.get(r.id)).filter((r): r is Row => !!r)
  }
  return returned
}

async function prepareSet(table: string, values: Row, engine: EngineOptions): Promise<Row> {
  const set: Row = {}
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) continue
    const { dbCol } = resolveColumn(table, k)
    set[dbCol] = toDb(table, k, v)
  }
  applyComputed(table, set)
  if (engine.policy) await engine.policy.checkUpdate(table, set, engine.runner)
  return set
}

async function runUpdate(ast: QueryAst, engine: EngineOptions): Promise<Row[]> {
  const { table } = ast
  const { runner, policy } = engine
  policy?.assertWrite(table, 'update')
  if (policy && ast.filters.length === 0) {
    throw new DbQueryError('UPDATE requires a WHERE clause', '21000', 400)
  }
  const set = await prepareSet(table, (ast.values as Row) ?? {}, engine)
  const sets = Object.keys(set).map((c) => `${q(c)} = ?`)
  const params: unknown[] = Object.values(set)
  if ('updated_at' in tableMeta(table).columns && !('updated_at' in set)) sets.push(`"updated_at" = ${NOW_SQL}`)
  if (!sets.length) return []

  const plan = planSelect(table, [], ast.filters, policy)
  const where = buildWhere(table, 't0', plan, { filters: ast.filters }, policy, 0, 'write')
  return runner.all(
    `UPDATE ${q(table)} AS "t0" SET ${sets.join(', ')}${where.sql} RETURNING ${returningList(table)}`,
    [...params, ...where.params],
  )
}

async function runDelete(ast: QueryAst, engine: EngineOptions): Promise<Row[]> {
  const { table } = ast
  const { runner, policy } = engine
  policy?.assertWrite(table, 'delete')
  if (policy && ast.filters.length === 0) {
    throw new DbQueryError('DELETE requires a WHERE clause', '21000', 400)
  }
  const plan = planSelect(table, [], ast.filters, policy)
  const where = buildWhere(table, 't0', plan, { filters: ast.filters }, policy, 0, 'write')
  return runner.all(`DELETE FROM ${q(table)} AS "t0"${where.sql} RETURNING ${returningList(table)}`, where.params)
}

/** Publish a write to the realtime hub (full API-shaped rows, like postgres_changes). */
async function emitChange(ast: QueryAst, returned: Row[], engine: EngineOptions): Promise<void> {
  if (!engine.realtime || !REALTIME_TABLES.has(ast.table) || !returned.length) return
  const rows = await projectReturned(
    ast.table,
    { ...ast, select: [{ type: 'star' }] },
    returned,
    { ...engine, policy: null },
  )
  const eventType = ast.action === 'delete' ? 'DELETE' : ast.action === 'update' ? 'UPDATE' : 'INSERT'
  await engine.realtime.change(ast.table, eventType, rows)
}

// ── Entry point ────────────────────────────────────────────────────────
function ok<T>(data: T, count: number | null, status = 200): DbResult<T> {
  return { data, error: null, count, status, statusText: status === 201 ? 'Created' : 'OK' }
}

function applySingle(ast: QueryAst, rows: Row[], count: number | null): DbResult {
  if (!ast.single) return ok(rows, count)
  if (rows.length === 1) return ok(rows[0], count)
  if (rows.length === 0 && ast.single === 'maybeSingle') return ok(null, count)
  const err = new DbQueryError(
    'JSON object requested, multiple (or no) rows returned',
    'PGRST116',
    406,
    `The result contains ${rows.length} rows`,
  )
  return errorResult(err)
}

export async function executeQuery(ast: QueryAst, engine: EngineOptions): Promise<DbResult> {
  try {
    tableMeta(ast.table)
    if (ast.action === 'select') {
      const count = ast.count ? await countRows(ast.table, ast, engine) : null
      if (ast.head) return ok(null, count)
      const limit = ast.single && ast.limit === undefined ? 2 : ast.limit
      const rows = await selectRows(ast.table, ast.select ?? [{ type: 'star' }], {
        filters: ast.filters,
        order: ast.order,
        limit,
        offset: ast.offset,
      }, engine)
      return applySingle(ast, rows, count)
    }

    let returned: Row[]
    if (ast.action === 'insert' || ast.action === 'upsert') returned = await runInsert(ast, engine)
    else if (ast.action === 'update') returned = await runUpdate(ast, engine)
    else returned = await runDelete(ast, engine)

    await emitChange(ast, returned, engine)
    const data = await projectReturned(ast.table, ast, returned, engine)
    const status = ast.action === 'insert' || ast.action === 'upsert' ? 201 : 200
    if (!ast.select) return { ...ok(null, null, status) }
    const result = applySingle(ast, data, null)
    return result.error ? result : { ...result, status }
  } catch (err) {
    return errorResult(err)
  }
}
