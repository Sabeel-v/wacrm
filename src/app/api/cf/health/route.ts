import { NextResponse } from 'next/server'
import { getCloudflareContext } from '@opennextjs/cloudflare'

/**
 * Phase 0 smoke test: proves the Next.js worker can reach its
 * Cloudflare bindings (D1, R2, Queue, Durable Object) and the Hono API
 * worker over the service binding. Returns booleans only, no data.
 *
 * Dev-only: 404 unless ENVIRONMENT=development (wrangler.jsonc vars).
 */
export async function GET() {
  const { env } = await getCloudflareContext({ async: true })
  if (env.ENVIRONMENT !== 'development') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const checks: Record<string, boolean | string> = {}

  try {
    const row = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>()
    checks.d1 = row?.ok === 1
  } catch (err) {
    checks.d1 = `error: ${(err as Error).message}`
  }

  try {
    await env.MEDIA.list({ limit: 1 })
    checks.r2 = true
  } catch (err) {
    checks.r2 = `error: ${(err as Error).message}`
  }

  checks.queue = typeof env.BROADCAST_QUEUE?.send === 'function'
  checks.durableObject = typeof env.REALTIME?.idFromName === 'function'

  try {
    // Hostname is ignored by service bindings; the path is what matters.
    const res = await env.API.fetch('https://wacrm-api/health')
    checks.apiWorker = res.ok
  } catch (err) {
    checks.apiWorker = `not reachable (start it with npm run dev:api): ${(err as Error).message}`
  }

  const ok = Object.values(checks).every((v) => v === true)
  return NextResponse.json({ ok, worker: 'wacrm-web', checks }, { status: ok ? 200 : 500 })
}
