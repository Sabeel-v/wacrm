/**
 * The D1 client object: the subset of the supabase-js client this app
 * uses (`from`, `rpc`, `auth`, `storage`, `channel`, `removeChannel`),
 * backed by D1, Better Auth, R2 and (phase 5) Durable Objects.
 *
 * `SupabaseClient` is exported as an alias so existing code and tests
 * that type a client parameter keep compiling unchanged.
 */
import { QueryBuilder, RpcBuilder, type QueryExecutor, type RpcExecutor } from './builder'
import type { DbError } from './types'

/* eslint-disable @typescript-eslint/no-explicit-any -- mirrors supabase-js's untyped surface */

/** Supabase-shaped user, built from the Better Auth user. */
export interface CompatUser {
  id: string
  email: string
  user_metadata: { full_name?: string; [k: string]: unknown }
  app_metadata: Record<string, unknown>
  created_at?: string
  email_confirmed_at?: string | null
  [k: string]: unknown
}

export interface CompatSession {
  /** Sessions are cookie-based now; kept for code that forwards a bearer token. */
  access_token: string
  user: CompatUser
}

type AuthResult<T> = Promise<{ data: T; error: DbError | null }>

export interface AuthApi {
  getUser(): AuthResult<{ user: CompatUser | null }>
  getSession(): AuthResult<{ session: CompatSession | null }>
  signInWithPassword(credentials: { email: string; password: string }): AuthResult<{ user: CompatUser | null; session: CompatSession | null }>
  signUp(credentials: {
    email: string
    password: string
    options?: { data?: Record<string, unknown>; emailRedirectTo?: string }
  }): AuthResult<{ user: CompatUser | null; session: CompatSession | null }>
  signOut(options?: { scope?: 'global' | 'local' | 'others' }): Promise<{ error: DbError | null }>
  updateUser(attrs: { email?: string; password?: string; data?: Record<string, unknown> }): AuthResult<{ user: CompatUser | null }>
  resetPasswordForEmail(email: string, options?: { redirectTo?: string }): AuthResult<Record<string, never>>
  onAuthStateChange(
    callback: (event: string, session: CompatSession | null) => void,
  ): { data: { subscription: { unsubscribe(): void } } }
}

export interface StorageFileApi {
  upload(path: string, body: Blob | ArrayBuffer | Uint8Array | File, options?: { contentType?: string; upsert?: boolean; cacheControl?: string }): Promise<{ data: { path: string } | null; error: DbError | null }>
  remove(paths: string[]): Promise<{ data: { name: string }[] | null; error: DbError | null }>
  getPublicUrl(path: string): { data: { publicUrl: string } }
}

export interface StorageApi {
  from(bucket: string): StorageFileApi
}

export interface RealtimeChannel {
  on(type: string, filter: Record<string, unknown>, callback: (payload: any) => void): RealtimeChannel
  subscribe(callback?: (status: string, err?: Error) => void): RealtimeChannel
  unsubscribe(): Promise<'ok'>
}

export interface DbClient {
  from(table: string): QueryBuilder
  rpc(fn: string, args?: Record<string, unknown>, options?: { head?: boolean; count?: string }): RpcBuilder
  auth: AuthApi
  storage: StorageApi
  channel(name: string, options?: Record<string, unknown>): RealtimeChannel
  removeChannel(channel: RealtimeChannel): Promise<'ok'>
}

/** Compatibility aliases: code typed against supabase-js keeps compiling. */
export type SupabaseClient = DbClient
export type PostgrestError = DbError
export type User = CompatUser

export interface DbClientParts {
  query: QueryExecutor
  rpc: RpcExecutor
  auth: AuthApi
  storage: StorageApi
  channel?: (name: string) => RealtimeChannel
}

/** Realtime stub until the Durable Object hub is wired (phase 5). */
export function inertChannel(name: string): RealtimeChannel {
  const ch: RealtimeChannel = {
    on: () => ch,
    subscribe: (cb) => {
      // Report SUBSCRIBED so UIs don't show a connection error; no events arrive yet.
      queueMicrotask(() => cb?.('SUBSCRIBED'))
      return ch
    },
    unsubscribe: async () => 'ok',
  }
  void name
  return ch
}

export function createDbClient(parts: DbClientParts): DbClient {
  return {
    from: (table) => new QueryBuilder(parts.query, table),
    rpc: (fn, args = {}) => new RpcBuilder(parts.rpc, { fn, args }),
    auth: parts.auth,
    storage: parts.storage,
    channel: (name) => (parts.channel ?? inertChannel)(name),
    removeChannel: async (ch) => ch.unsubscribe(),
  }
}

/** Shape a DbError from anything thrown or returned by Better Auth / fetch. */
export function toAuthError(err: unknown, fallback = 'Authentication failed'): DbError | null {
  if (!err) return null
  const e = err as { message?: string; code?: string; status?: number }
  return { message: e.message || fallback, code: e.code || 'auth_error', details: null, hint: null }
}

export function toCompatUser(u: {
  id: string
  email: string
  name?: string | null
  emailVerified?: boolean
  createdAt?: string | Date
  image?: string | null
} | null | undefined): CompatUser | null {
  if (!u) return null
  const created = u.createdAt instanceof Date ? u.createdAt.toISOString() : u.createdAt
  return {
    id: u.id,
    email: u.email,
    user_metadata: { full_name: u.name ?? '', avatar_url: u.image ?? undefined },
    app_metadata: {},
    created_at: created,
    email_confirmed_at: u.emailVerified ? created ?? null : null,
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
