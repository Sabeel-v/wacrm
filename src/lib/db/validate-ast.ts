/**
 * Strict validation of a QueryAst received from the browser (/api/db).
 * The engine also validates tables/columns against the schema; this
 * rejects anything structurally odd before it gets that far, including
 * aliases (which are emitted as SQL identifiers) and reserved prefixes.
 */
import { DbQueryError, type Filter, type QueryAst, type SelectItem } from './types'

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/
const COLUMN_PATH = /^[A-Za-z_][A-Za-z0-9_]{0,62}(\.[A-Za-z_][A-Za-z0-9_]{0,62})?$/
const ACTIONS = new Set(['select', 'insert', 'update', 'upsert', 'delete'])
const OPS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains'])
const MAX_ROWS = 1000
const MAX_FILTERS = 50

const bad = (why: string): never => {
  throw new DbQueryError(`Invalid query: ${why}`, 'PGRST100', 400)
}

function ident(v: unknown, what: string): string {
  if (typeof v !== 'string' || !IDENT.test(v) || v.startsWith('__')) bad(`${what} "${String(v)}"`)
  return v as string
}

function selectItems(items: unknown, depth = 0): SelectItem[] {
  if (!Array.isArray(items) || items.length > 200) bad('select list')
  if (depth > 4) bad('embeds nested too deeply')
  for (const it of items as SelectItem[]) {
    if (!it || typeof it !== 'object') bad('select item')
    if (it.type === 'star') continue
    if (it.type === 'column') {
      ident(it.name, 'column')
      if (it.alias !== undefined) ident(it.alias, 'alias')
      continue
    }
    if (it.type === 'embed') {
      ident(it.alias, 'alias')
      ident(it.table, 'table')
      if (it.hint !== undefined) ident(it.hint, 'hint')
      if (typeof it.inner !== 'boolean') bad('embed inner flag')
      selectItems(it.items, depth + 1)
      continue
    }
    bad('select item type')
  }
  return items as SelectItem[]
}

function filters(list: unknown, depth = 0): Filter[] {
  if (!Array.isArray(list) || list.length > MAX_FILTERS) bad('filters')
  if (depth > 4) bad('filters nested too deeply')
  for (const f of list as Filter[]) {
    if (!f || typeof f !== 'object') bad('filter')
    if (f.type === 'cond') {
      if (typeof f.column !== 'string' || !COLUMN_PATH.test(f.column)) bad(`filter column "${String(f.column)}"`)
      if (!OPS.has(f.op)) bad(`operator "${String(f.op)}"`)
      if (Array.isArray(f.value) && f.value.length > 5000) bad('IN list too long')
      continue
    }
    if (f.type === 'or' || f.type === 'and') {
      filters(f.filters, depth + 1)
      continue
    }
    bad('filter type')
  }
  return list as Filter[]
}

export function validateAst(input: unknown): QueryAst {
  if (!input || typeof input !== 'object') bad('body')
  const ast = input as QueryAst
  ident(ast.table, 'table')
  if (!ACTIONS.has(ast.action)) bad('action')
  if (ast.select !== null) selectItems(ast.select)
  filters(ast.filters)
  if (!Array.isArray(ast.order) || ast.order.length > 10) bad('order')
  for (const o of ast.order) {
    ident(o.column, 'order column')
    if (typeof o.ascending !== 'boolean') bad('order direction')
  }
  for (const n of [ast.limit, ast.offset]) {
    if (n !== undefined && (!Number.isInteger(n) || n < 0 || n > 100000)) bad('limit/offset')
  }
  if (ast.single !== undefined && ast.single !== 'single' && ast.single !== 'maybeSingle') bad('single')
  if (ast.onConflict !== undefined) {
    for (const c of String(ast.onConflict).split(',')) ident(c.trim(), 'onConflict column')
  }
  if (ast.values !== undefined) {
    const rows = Array.isArray(ast.values) ? ast.values : [ast.values]
    if (rows.length > MAX_ROWS) bad(`more than ${MAX_ROWS} rows in one request`)
    for (const r of rows) {
      if (!r || typeof r !== 'object' || Array.isArray(r)) bad('row')
      for (const k of Object.keys(r)) ident(k, 'value column')
    }
  }
  return ast
}
