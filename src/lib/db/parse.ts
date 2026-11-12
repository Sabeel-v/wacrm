/**
 * Parsers for PostgREST string syntax used by supabase-js:
 *   - select lists:  "id, name, contact:contacts(name, phone), broadcasts!inner(id)"
 *   - .or() filters: "name.ilike.*x*,phone.ilike.*x*" / "a.lt.1,and(a.eq.1,id.lt.5)"
 */
import { DbQueryError, type Filter, type FilterOp, type SelectItem } from './types'

/** Split on commas that are not inside parentheses or double quotes. */
function splitTopLevel(input: string): string[] {
  const parts: string[] = []
  let depth = 0
  let inQuotes = false
  let current = ''
  for (const ch of input) {
    if (ch === '"') inQuotes = !inQuotes
    if (!inQuotes) {
      if (ch === '(') depth++
      else if (ch === ')') depth--
      else if (ch === ',' && depth === 0) {
        parts.push(current)
        current = ''
        continue
      }
    }
    current += ch
  }
  if (depth !== 0 || inQuotes) {
    throw new DbQueryError(`Unbalanced parentheses or quotes in "${input}"`, 'PGRST100')
  }
  parts.push(current)
  return parts.map((p) => p.trim()).filter((p) => p.length > 0)
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

export function parseSelect(input: string | undefined | null): SelectItem[] {
  const text = (input ?? '*').replace(/\s+/g, ' ').trim()
  if (text === '' || text === '*') return [{ type: 'star' }]
  return splitTopLevel(text).map(parseSelectItem)
}

function parseSelectItem(raw: string): SelectItem {
  if (raw === '*') return { type: 'star' }

  const paren = raw.indexOf('(')
  const head = (paren === -1 ? raw : raw.slice(0, paren)).trim()

  let alias: string | undefined
  let rest = head
  const colon = head.indexOf(':')
  if (colon !== -1) {
    alias = head.slice(0, colon).trim()
    rest = head.slice(colon + 1).trim()
  }

  const [name, ...hints] = rest.split('!').map((s) => s.trim())
  if (!IDENT.test(name) || (alias !== undefined && !IDENT.test(alias))) {
    throw new DbQueryError(`Invalid select item "${raw}"`, 'PGRST100')
  }

  if (paren === -1) {
    if (hints.length) throw new DbQueryError(`Unexpected "!" in column "${raw}"`, 'PGRST100')
    return alias ? { type: 'column', name, alias } : { type: 'column', name }
  }

  if (!raw.endsWith(')')) throw new DbQueryError(`Invalid embed "${raw}"`, 'PGRST100')
  const inner = hints.includes('inner')
  const hint = hints.find((h) => h !== 'inner' && h !== 'left')
  return {
    type: 'embed',
    alias: alias ?? name,
    table: name,
    hint,
    inner,
    items: parseSelect(raw.slice(paren + 1, -1)),
  }
}

// ── .or() / .and() filter strings ────────────────────────────────────

const OPS = new Set<FilterOp>(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in'])

function unquote(v: string): string {
  return v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v
}

/** Convert a PostgREST filter value string into a JS value for `op`. */
export function parseFilterValue(op: FilterOp, raw: string): unknown {
  if (op === 'in') {
    const inner = raw.trim().replace(/^\(/, '').replace(/\)$/, '')
    return inner === '' ? [] : splitTopLevel(inner).map(unquote)
  }
  if (op === 'is') {
    const v = raw.trim().toLowerCase()
    if (v === 'null') return null
    if (v === 'true') return true
    if (v === 'false') return false
    throw new DbQueryError(`Invalid "is" value "${raw}"`, 'PGRST100')
  }
  if (op === 'like' || op === 'ilike') return unquote(raw).replace(/\*/g, '%')
  return unquote(raw)
}

/** Parse a PostgREST logic expression, e.g. "a.eq.1,and(b.lt.2,c.is.null)". */
export function parseLogic(input: string): Filter[] {
  return splitTopLevel(input).map(parseLogicPart)
}

function parseLogicPart(part: string): Filter {
  let not = false
  let text = part
  if (text.startsWith('not.and(') || text.startsWith('not.or(')) {
    not = true
    text = text.slice(4)
  }
  const group = /^(and|or)\(([\s\S]*)\)$/.exec(text)
  if (group) {
    return { type: group[1] as 'and' | 'or', filters: parseLogic(group[2]), not }
  }

  // column.op.value  |  column.not.op.value  (value may contain dots)
  const first = text.indexOf('.')
  if (first === -1) throw new DbQueryError(`Invalid filter "${part}"`, 'PGRST100')
  const column = text.slice(0, first)
  let rest = text.slice(first + 1)
  if (rest.startsWith('not.')) {
    not = true
    rest = rest.slice(4)
  }
  const second = rest.indexOf('.')
  if (second === -1) throw new DbQueryError(`Invalid filter "${part}"`, 'PGRST100')
  const op = rest.slice(0, second) as FilterOp
  if (!OPS.has(op)) throw new DbQueryError(`Unsupported filter operator "${op}" in "${part}"`, 'PGRST100')
  return { type: 'cond', column, op, value: parseFilterValue(op, rest.slice(second + 1)), not }
}
