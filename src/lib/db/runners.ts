import type { Row, SqlRunner } from './types'

/** Minimal structural type of a D1 binding (avoids depending on Workers globals here). */
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): { all(): Promise<{ results?: unknown[] }> }
  }
  batch(statements: unknown[]): Promise<{ results?: unknown[] }[]>
}

const clean = (params: unknown[]) => params.map((p) => (p === undefined ? null : p))

/** SqlRunner backed by a Cloudflare D1 binding. batch() is atomic. */
export function d1Runner(db: D1Like): SqlRunner {
  return {
    async all(sql, params) {
      const res = await db.prepare(sql).bind(...clean(params)).all()
      return (res.results ?? []) as Row[]
    },
    async batch(statements) {
      const res = await db.batch(statements.map((s) => db.prepare(s.sql).bind(...clean(s.params))))
      return res.map((r) => (r.results ?? []) as Row[])
    },
  }
}
