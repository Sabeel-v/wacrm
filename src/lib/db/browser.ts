'use client'
/**
 * Browser D1 client — what `createClient()` from @/lib/supabase/client
 * returns. Same surface as the supabase-js browser client:
 *   from()/rpc()  → POST /api/db (session + RLS port on the server)
 *   auth          → Better Auth (/api/auth/*)
 *   storage       → /api/storage/<bucket>/<path> (R2)
 *   channel()     → inert until the Durable Object hub lands (phase 5)
 */
import { createAuthClient } from 'better-auth/client'
import {
  createDbClient,
  toAuthError,
  toCompatUser,
  type AuthApi,
  type CompatSession,
  type DbClient,
  type StorageApi,
} from './client-core'
import { errorResult } from './engine-errors'
import { publicUrl } from './storage-rules'
import type { DbResult } from './types'

export const authClient = createAuthClient()

async function post(body: unknown): Promise<DbResult> {
  try {
    const res = await fetch('/api/db', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return (await res.json()) as DbResult
  } catch (err) {
    return errorResult(err)
  }
}

// ── auth ──────────────────────────────────────────────────────────────
type Listener = (event: string, session: CompatSession | null) => void
const listeners = new Set<Listener>()
const emit = (event: string, session: CompatSession | null) => listeners.forEach((l) => l(event, session))

async function currentSession(): Promise<CompatSession | null> {
  const { data } = await authClient.getSession()
  const user = toCompatUser(data?.user)
  return user ? { access_token: '', user } : null
}

const auth: AuthApi = {
  async getSession() {
    try {
      return { data: { session: await currentSession() }, error: null }
    } catch (e) {
      return { data: { session: null }, error: toAuthError(e) }
    }
  },
  async getUser() {
    const session = await currentSession().catch(() => null)
    return session
      ? { data: { user: session.user }, error: null }
      : { data: { user: null }, error: toAuthError({ message: 'Auth session missing!' }) }
  },
  async signInWithPassword({ email, password }) {
    const { error } = await authClient.signIn.email({ email, password })
    if (error) return { data: { user: null, session: null }, error: toAuthError(error, 'Invalid login credentials') }
    const session = await currentSession()
    emit('SIGNED_IN', session)
    return { data: { user: session?.user ?? null, session }, error: null }
  },
  async signUp({ email, password, options }) {
    const name = String(options?.data?.full_name ?? '')
    const { error } = await authClient.signUp.email({ email, password, name })
    if (error) return { data: { user: null, session: null }, error: toAuthError(error, 'Sign up failed') }
    const session = await currentSession()
    if (session) emit('SIGNED_IN', session)
    return { data: { user: session?.user ?? null, session }, error: null }
  },
  async signOut(options) {
    try {
      if (options?.scope === 'global') await authClient.revokeSessions()
      else if (options?.scope === 'others') await authClient.revokeOtherSessions()
      if (options?.scope !== 'others') await authClient.signOut()
      if (options?.scope !== 'others') emit('SIGNED_OUT', null)
      return { error: null }
    } catch (e) {
      return { error: toAuthError(e) }
    }
  },
  async updateUser(attrs) {
    if (attrs.password !== undefined) {
      return {
        data: { user: null },
        error: toAuthError({ message: 'Use authClient.changePassword({ currentPassword, newPassword })' }),
      }
    }
    if (attrs.email !== undefined) {
      const { error } = await authClient.changeEmail({ newEmail: attrs.email })
      if (error) return { data: { user: null }, error: toAuthError(error, 'Email change failed') }
    }
    if (attrs.data && 'full_name' in attrs.data) {
      const { error } = await authClient.updateUser({ name: String(attrs.data.full_name ?? '') })
      if (error) return { data: { user: null }, error: toAuthError(error) }
    }
    const session = await currentSession()
    emit('USER_UPDATED', session)
    return { data: { user: session?.user ?? null }, error: null }
  },
  async resetPasswordForEmail(email) {
    const { error } = await authClient.requestPasswordReset({
      email,
      redirectTo: `${window.location.origin}/reset-password`,
    })
    return { data: {}, error: toAuthError(error) }
  },
  onAuthStateChange(callback) {
    listeners.add(callback)
    return { data: { subscription: { unsubscribe: () => listeners.delete(callback) } } }
  },
}

// ── storage ───────────────────────────────────────────────────────────
const storageError = (message: string, code = 'storage_error') => ({ message, code, details: null, hint: null })
const objectUrl = (bucket: string, path: string) =>
  `/api/storage/${encodeURIComponent(bucket)}/${path.split('/').map(encodeURIComponent).join('/')}`

const storage: StorageApi = {
  from(bucket) {
    return {
      async upload(path, body, options) {
        try {
          const contentType = options?.contentType ?? (body instanceof Blob ? body.type : 'application/octet-stream')
          const res = await fetch(objectUrl(bucket, path), {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': contentType, 'x-upsert': options?.upsert ? 'true' : 'false' },
            body: body as BodyInit,
          })
          const json = (await res.json().catch(() => ({}))) as { path?: string; error?: string }
          if (!res.ok) return { data: null, error: storageError(json.error ?? `Upload failed (${res.status})`, String(res.status)) }
          return { data: { path: json.path ?? path }, error: null }
        } catch (e) {
          return { data: null, error: storageError(e instanceof Error ? e.message : 'Upload failed') }
        }
      },
      async remove(paths) {
        const results = await Promise.all(
          paths.map((p) => fetch(objectUrl(bucket, p), { method: 'DELETE', credentials: 'same-origin' })),
        )
        const failed = results.find((r) => !r.ok)
        return failed
          ? { data: null, error: storageError(`Delete failed (${failed.status})`, String(failed.status)) }
          : { data: paths.map((name) => ({ name })), error: null }
      },
      getPublicUrl(path) {
        return { data: { publicUrl: publicUrl(bucket, path, window.location.origin) } }
      },
    }
  },
}

let client: DbClient | undefined

/** Singleton browser client (same lifetime semantics as the old Supabase one). */
export function createBrowserDb(): DbClient {
  client ??= createDbClient({
    query: (ast) => post({ type: 'query', ast }),
    rpc: (call) => post({ type: 'rpc', fn: call.fn, args: call.args }),
    auth,
    storage,
  })
  return client
}
