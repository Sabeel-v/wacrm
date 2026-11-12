/**
 * Test helpers: a SqlRunner over an in-memory node:sqlite database with
 * the D1 migrations + dev seed applied. Not used at runtime.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Row, SqlRunner } from './types'

interface SyncDb {
  exec(sql: string): void
  prepare(sql: string): { all(...params: unknown[]): Row[] }
}

let DatabaseSync: (new (path: string) => SyncDb) | undefined
try {
  DatabaseSync = (await import('node:sqlite')).DatabaseSync as unknown as new (path: string) => SyncDb
} catch {
  DatabaseSync = undefined
}

export const hasSqlite = !!DatabaseSync

const root = process.cwd()
const migrations = () =>
  readdirSync(join(root, 'd1', 'migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(root, 'd1', 'migrations', f), 'utf8'))

export function openTestDb(withSeed = true): { db: SyncDb; runner: SqlRunner } {
  const db = new DatabaseSync!(':memory:')
  db.exec('PRAGMA foreign_keys = ON;')
  for (const sql of migrations()) db.exec(sql)
  if (withSeed) db.exec(readFileSync(join(root, 'd1', 'seed', 'dev.sql'), 'utf8'))

  const runner: SqlRunner = {
    async all(sql, params) {
      return db.prepare(sql).all(...(params as never[]))
    },
    async batch(statements) {
      db.exec('BEGIN')
      try {
        const out = statements.map((s) => db.prepare(s.sql).all(...(s.params as never[])))
        db.exec('COMMIT')
        return out
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    },
  }
  return { db, runner }
}

// Seed ids (d1/seed/dev.sql)
export const SEED = {
  account: '10000000-0000-4000-8000-000000000001',
  owner: '00000000-0000-4000-8000-000000000001',
  admin: '00000000-0000-4000-8000-000000000002',
  agent: '00000000-0000-4000-8000-000000000003',
  viewer: '00000000-0000-4000-8000-000000000004',
  sara: '40000000-0000-4000-8000-000000000001',
  omar: '40000000-0000-4000-8000-000000000002',
  hina: '40000000-0000-4000-8000-000000000003',
  convSara: '50000000-0000-4000-8000-000000000001',
  convOmar: '50000000-0000-4000-8000-000000000002',
  tagVip: '30000000-0000-4000-8000-000000000001',
  tagLead: '30000000-0000-4000-8000-000000000002',
  pipeline: '80000000-0000-4000-8000-000000000001',
  stageNew: '81000000-0000-4000-8000-000000000001',
  broadcast: '90000000-0000-4000-8000-000000000001',
  whatsappTemplate: '70000000-0000-4000-8000-000000000001',
} as const
