import { getCloudflareContext } from '@opennextjs/cloudflare'

/**
 * Cloudflare bindings (D1, R2, Queues, DO) for the current request.
 * Works in the Workers runtime (preview/deploy) and in `next dev`
 * (initOpenNextCloudflareForDev in next.config.ts).
 */
export async function getEnv(): Promise<CloudflareEnv> {
  return (await getCloudflareContext({ async: true })).env
}
