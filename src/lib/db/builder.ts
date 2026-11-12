/**
 * supabase-js–compatible query builder. Produces a QueryAst and hands it
 * to an executor (direct D1 on the server, POST /api/db in the browser).
 *
 * Supported: select (columns, embeds, count/head), insert, update,
 * upsert (onConflict, ignoreDuplicates), delete, eq/neq/gt/gte/lt/lte,
 * like/ilike, is, in, contains, not, or, match, filter, order, limit,
 * range, single, maybeSingle. Anything else throws, so gaps fail loudly.
 */
import { parseFilterValue, parseLogic, parseSelect } from './parse'
import type { DbResult, Filter, FilterOp, QueryAst, Row, RpcCall } from './types'

export type QueryExecutor = (ast: QueryAst) => Promise<DbResult>
export type RpcExecutor = (call: RpcCall) => Promise<DbResult>

/* eslint-disable @typescript-eslint/no-explicit-any -- results are untyped, like supabase-js without generated types */
/**
 * `Result` mirrors supabase-js without generated types: `any[]` for lists,
 * `any` after .single()/.maybeSingle().
 */
export class QueryBuilder<Result = any[]> implements PromiseLike<DbResult<Result>> {
  private readonly ast: QueryAst

  constructor(
    private readonly exec: QueryExecutor,
    table: string,
  ) {
    this.ast = { table, action: 'select', select: null, filters: [], order: [] }
  }

  // ── actions ────────────────────────────────────────────────────────
  select(columns?: string, options?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }): this {
    this.ast.select = parseSelect(columns ?? '*')
    if (this.ast.action === 'select') {
      if (options?.count) this.ast.count = 'exact'
      if (options?.head) this.ast.head = true
    }
    return this
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- accepted for supabase-js call compatibility
  insert(values: object | object[], _options?: { count?: string; defaultToNull?: boolean }): this {
    this.ast.action = 'insert'
    this.ast.values = values as Row | Row[]
    return this
  }

  upsert(
    values: object | object[],
    options?: { onConflict?: string; ignoreDuplicates?: boolean; count?: string; defaultToNull?: boolean },
  ): this {
    this.ast.action = 'upsert'
    this.ast.values = values as Row | Row[]
    this.ast.onConflict = options?.onConflict
    this.ast.ignoreDuplicates = options?.ignoreDuplicates ?? false
    return this
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- accepted for supabase-js call compatibility
  update(values: object, _options?: { count?: string }): this {
    this.ast.action = 'update'
    this.ast.values = values as Row
    return this
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- accepted for supabase-js call compatibility
  delete(_options?: { count?: string }): this {
    this.ast.action = 'delete'
    return this
  }

  // ── filters ────────────────────────────────────────────────────────
  private cond(column: string, op: FilterOp, value: unknown, not = false): this {
    this.ast.filters.push({ type: 'cond', column, op, value, not })
    return this
  }

  eq(column: string, value: unknown): this {
    return this.cond(column, 'eq', value)
  }
  neq(column: string, value: unknown): this {
    return this.cond(column, 'neq', value)
  }
  gt(column: string, value: unknown): this {
    return this.cond(column, 'gt', value)
  }
  gte(column: string, value: unknown): this {
    return this.cond(column, 'gte', value)
  }
  lt(column: string, value: unknown): this {
    return this.cond(column, 'lt', value)
  }
  lte(column: string, value: unknown): this {
    return this.cond(column, 'lte', value)
  }
  like(column: string, pattern: string): this {
    return this.cond(column, 'like', pattern.replace(/\*/g, '%'))
  }
  ilike(column: string, pattern: string): this {
    return this.cond(column, 'ilike', pattern.replace(/\*/g, '%'))
  }
  is(column: string, value: null | boolean): this {
    return this.cond(column, 'is', value)
  }
  in(column: string, values: readonly unknown[]): this {
    return this.cond(column, 'in', [...values])
  }
  contains(column: string, value: unknown): this {
    return this.cond(column, 'contains', value)
  }

  /** .not('col', 'is', null) / .not('col', 'eq', 'x') / .not('col', 'in', '(a,b)') */
  not(column: string, operator: string, value: unknown): this {
    const op = operator as FilterOp
    const v = typeof value === 'string' ? parseFilterValue(op, value) : value
    return this.cond(column, op, v, true)
  }

  /** .filter('col', 'eq', 'x') — PostgREST operator + string value. */
  filter(column: string, operator: string, value: unknown): this {
    let op = operator
    let not = false
    if (op.startsWith('not.')) {
      not = true
      op = op.slice(4)
    }
    const v = typeof value === 'string' ? parseFilterValue(op as FilterOp, value) : value
    return this.cond(column, op as FilterOp, v, not)
  }

  match(query: Record<string, unknown>): this {
    for (const [k, v] of Object.entries(query)) this.cond(k, 'eq', v)
    return this
  }

  /** PostgREST logic string, e.g. "name.ilike.*x*,phone.ilike.*x*". */
  or(filters: string, options?: { foreignTable?: string; referencedTable?: string }): this {
    if (options?.foreignTable || options?.referencedTable) {
      throw new Error('or() on an embedded table is not supported by the D1 data layer')
    }
    const parsed: Filter[] = parseLogic(filters)
    this.ast.filters.push({ type: 'or', filters: parsed })
    return this
  }

  // ── modifiers ──────────────────────────────────────────────────────
  order(
    column: string,
    options?: { ascending?: boolean; nullsFirst?: boolean; foreignTable?: string; referencedTable?: string },
  ): this {
    if (options?.foreignTable || options?.referencedTable) {
      throw new Error('order() on an embedded table is not supported by the D1 data layer')
    }
    this.ast.order.push({ column, ascending: options?.ascending ?? true, nullsFirst: options?.nullsFirst })
    return this
  }

  limit(count: number): this {
    this.ast.limit = count
    return this
  }

  range(from: number, to: number): this {
    this.ast.offset = from
    this.ast.limit = to - from + 1
    return this
  }

  single(): QueryBuilder<any> {
    this.ast.single = 'single'
    return this as unknown as QueryBuilder<any>
  }

  maybeSingle(): QueryBuilder<any> {
    this.ast.single = 'maybeSingle'
    return this as unknown as QueryBuilder<any>
  }

  /** The AST this builder would execute (used by tests and the /api/db client). */
  toAst(): QueryAst {
    return structuredClone(this.ast)
  }

  then<TResult1 = DbResult<Result>, TResult2 = never>(
    onfulfilled?: ((value: DbResult<Result>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.exec(this.ast).then(onfulfilled as never, onrejected)
  }
}

export class RpcBuilder implements PromiseLike<DbResult<any>> {
  private singleMode: 'single' | 'maybeSingle' | null = null

  constructor(
    private readonly exec: RpcExecutor,
    private readonly call: RpcCall,
  ) {}

  single(): this {
    this.singleMode = 'single'
    return this
  }

  maybeSingle(): this {
    this.singleMode = 'maybeSingle'
    return this
  }

  then<TResult1 = DbResult<any>, TResult2 = never>(
    onfulfilled?: ((value: DbResult<any>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.exec(this.call)
      .then((res): DbResult<any> => {
        if (!this.singleMode || res.error || !Array.isArray(res.data)) return res
        const rows = res.data as unknown[]
        if (rows.length === 1) return { ...res, data: rows[0] }
        if (rows.length === 0 && this.singleMode === 'maybeSingle') return { ...res, data: null }
        return {
          data: null,
          count: null,
          status: 406,
          statusText: 'Error',
          error: {
            message: 'JSON object requested, multiple (or no) rows returned',
            code: 'PGRST116',
            details: `The result contains ${rows.length} rows`,
            hint: null,
          },
        }
      })
      .then(onfulfilled, onrejected)
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
