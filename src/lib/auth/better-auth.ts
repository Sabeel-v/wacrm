/**
 * Better Auth on Cloudflare D1 — replaces Supabase Auth.
 *
 * Tables: users + auth_* (d1/migrations/0001, 0002). Mapping below keeps
 * the CRM's snake_case columns.
 *
 * Replaces from Postgres:
 *   - auth.users                → users (+ auth_accounts for passwords)
 *   - handle_new_user trigger   → databaseHooks.user.create.after (bootstrapAccount)
 *   - Supabase reset emails     → sendResetPassword (logged locally; wire a
 *                                 provider before production, see docs/auth.md)
 */
import { betterAuth } from 'better-auth'
import { nextCookies } from 'better-auth/next-js'
import { getEnv } from '@/lib/cf-env'
import { d1Runner, type D1Like } from '@/lib/db/runners'
import { bootstrapAccount } from './bootstrap'

function trustedOrigins(env: CloudflareEnv): string[] {
  const origins = ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:8787', 'http://127.0.0.1:8787']
  const site = (env as unknown as Record<string, string | undefined>).NEXT_PUBLIC_SITE_URL ?? process.env.NEXT_PUBLIC_SITE_URL
  if (site) origins.push(site.replace(/\/+$/, ''))
  return origins
}

function createAuth(env: CloudflareEnv) {
  const vars = env as unknown as Record<string, string | undefined>
  const secret = vars.BETTER_AUTH_SECRET ?? process.env.BETTER_AUTH_SECRET
  const runner = d1Runner(env.DB as unknown as D1Like)

  return betterAuth({
    database: env.DB,
    secret,
    baseURL: vars.BETTER_AUTH_URL ?? process.env.BETTER_AUTH_URL,
    trustedOrigins: trustedOrigins(env),
    advanced: {
      database: { generateId: 'uuid' },
      // Per-client rate limiting: Cloudflare sets CF-Connecting-IP and clients
      // can't forge it (unlike X-Forwarded-For, so that one is not trusted).
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
    },
    user: {
      modelName: 'users',
      fields: { emailVerified: 'email_verified', createdAt: 'created_at', updatedAt: 'updated_at' },
    },
    session: {
      modelName: 'auth_sessions',
      fields: {
        userId: 'user_id',
        expiresAt: 'expires_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
      // Signed session cookie cache: most requests skip the D1 session lookup.
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    account: {
      modelName: 'auth_accounts',
      fields: {
        userId: 'user_id',
        accountId: 'provider_account_id',
        providerId: 'provider_id',
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        idToken: 'id_token',
        accessTokenExpiresAt: 'access_token_expires_at',
        refreshTokenExpiresAt: 'refresh_token_expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    verification: {
      modelName: 'auth_verifications',
      fields: { expiresAt: 'expires_at', createdAt: 'created_at', updatedAt: 'updated_at' },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      modelName: 'auth_rate_limits',
      fields: { lastRequest: 'last_request' },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 6, // Supabase default
      autoSignIn: true,
      sendResetPassword: async ({ user, url }) => {
        // TODO(phase 8): send via an email provider. Locally the link is printed.
        console.log(`\n[auth] Password reset link for ${user.email}:\n  ${url}\n`)
      },
    },
    databaseHooks: {
      user: {
        create: {
          // Port of handle_new_user(): every new user gets an account + owner profile.
          after: async (user) => {
            await bootstrapAccount(runner, { id: user.id, email: user.email, name: user.name })
          },
        },
      },
    },
    plugins: [nextCookies()],
  })
}

export type Auth = ReturnType<typeof createAuth>

const cache = new WeakMap<object, Auth>()

/** Better Auth instance for the current request's D1 binding (cached per isolate). */
export async function getAuth(): Promise<Auth> {
  const env = await getEnv()
  let auth = cache.get(env.DB)
  if (!auth) {
    auth = createAuth(env)
    cache.set(env.DB, auth)
  }
  return auth
}
