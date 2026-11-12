/**
 * Error mapping shared by the server engine and the browser client
 * (kept separate so the browser bundle doesn't include the SQL engine).
 */
import { DbQueryError, type DbResult } from './types'

/** SQLite/D1 error → Postgres-like code the app already checks for. */
export function toDbError(err: unknown): DbQueryError {
  if (err instanceof DbQueryError) return err
  const message = err instanceof Error ? err.message : String(err)
  if (/UNIQUE constraint failed/i.test(message)) return new DbQueryError(message, '23505', 409)
  if (/FOREIGN KEY constraint failed/i.test(message)) return new DbQueryError(message, '23503', 409)
  if (/CHECK constraint failed/i.test(message)) return new DbQueryError(message, '23514', 400)
  if (/NOT NULL constraint failed/i.test(message)) return new DbQueryError(message, '23502', 400)
  return new DbQueryError(message, 'XX000', 500)
}

export function errorResult(err: unknown): DbResult<null> {
  const e = toDbError(err)
  return {
    data: null,
    error: { message: e.message, code: e.code, details: e.details, hint: null },
    count: null,
    status: e.status,
    statusText: 'Error',
  }
}
