/**
 * Cloudflare bindings (D1, R2, Queues, DO) for the current request.
 *
 *   - Next.js worker (preview/deploy) and `next dev`: read from OpenNext's
 *     request context (initOpenNextCloudflareForDev in next.config.ts).
 *   - Hono API worker (webhook ingress, queue consumers, cron): the worker
 *     calls setWorkerEnv(env) first, because there is no OpenNext context.
 */
let workerEnv: CloudflareEnv | null = null

/** Called by the Hono API worker before running shared app code. */
export function setWorkerEnv(env: unknown): void {
  workerEnv = env as CloudflareEnv
}

export async function getEnv(): Promise<CloudflareEnv> {
  if (workerEnv) return workerEnv
  const { getCloudflareContext } = await import('@opennextjs/cloudflare')
  return (await getCloudflareContext({ async: true })).env
}
