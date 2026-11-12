/**
 * Scheduled jobs, run by the API worker's Cron Trigger (every minute).
 * Replaces the externally-pinged /api/automations/cron and /api/flows/cron.
 *
 *   every minute     resume due automation waits
 *   every 5 minutes  time out abandoned flow runs; revive stalled broadcasts
 *   hourly           delete expired auth sessions / tokens / rate-limit rows
 *
 * Jobs are independent: one failing never stops the others.
 */
import { drainDueAutomations } from '@/lib/automations/cron'
import { getEnv } from '@/lib/cf-env'
import { serviceDb } from '@/lib/db/service'
import { sweepStaleFlowRuns } from '@/lib/flows/cron'
import { enqueueBroadcastPass } from '@/lib/whatsapp/broadcast-queue'

/** A 'sending' broadcast whose last pass started longer ago than this has lost its queue chain. */
export const BROADCAST_STALL_MS = 15 * 60_000
/** Stop reviving after this long: something is persistently wrong, and the user can press Resume. */
export const BROADCAST_GIVE_UP_MS = 24 * 3_600_000

/**
 * Re-enqueue broadcasts that are still 'sending' but whose pass chain died
 * (for example a pass exhausted its retries and went to the dead-letter
 * queue). `delivery_queued_at = null` means "stopped on purpose" and is
 * left alone.
 */
export async function reviveStalledBroadcasts(now = new Date()): Promise<{ revived: number }> {
  const db = serviceDb()
  const { data, error } = await db
    .from('broadcasts')
    .select('id, account_id')
    .eq('status', 'sending')
    .lt('delivery_queued_at', new Date(now.getTime() - BROADCAST_STALL_MS).toISOString())
    .gt('delivery_queued_at', new Date(now.getTime() - BROADCAST_GIVE_UP_MS).toISOString())
    .limit(20)
  if (error) throw new Error(error.message)
  let revived = 0
  for (const b of data ?? []) {
    await enqueueBroadcastPass(db, { broadcastId: b.id as string, accountId: b.account_id as string })
    revived++
  }
  return { revived }
}

/** Better Auth does not delete expired rows by itself on a SQL store. */
export async function cleanupAuth(now = new Date()): Promise<{ deleted: number }> {
  const env = await getEnv()
  const iso = now.toISOString()
  const res = await env.DB.batch([
    env.DB.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').bind(iso),
    env.DB.prepare('DELETE FROM auth_verifications WHERE expires_at < ?').bind(iso),
    env.DB.prepare('DELETE FROM auth_rate_limits WHERE last_request < ?').bind(now.getTime() - 3_600_000),
  ])
  return { deleted: res.reduce((n: number, r: { meta?: { changes?: number } }) => n + (r.meta?.changes ?? 0), 0) }
}

export type JobResult = Record<string, unknown>

/** Which jobs are due at this tick (exported for tests). */
export function jobsDueAt(at: Date): string[] {
  const minute = at.getUTCMinutes()
  const due = ['automations']
  if (minute % 5 === 0) due.push('flows', 'broadcasts')
  if (minute === 0) due.push('auth')
  return due
}

const JOBS: Record<string, (at: Date) => Promise<JobResult>> = {
  automations: () => drainDueAutomations(),
  flows: (at) => sweepStaleFlowRuns(at),
  broadcasts: (at) => reviveStalledBroadcasts(at),
  auth: (at) => cleanupAuth(at),
}

export async function runScheduledJobs(scheduledTime: number): Promise<Record<string, JobResult>> {
  const at = new Date(scheduledTime)
  const results: Record<string, JobResult> = {}
  for (const name of jobsDueAt(at)) {
    try {
      results[name] = await JOBS[name](at)
    } catch (err) {
      results[name] = { error: (err as Error).message }
      console.error(`[cron] ${name} failed:`, (err as Error).message)
    }
  }
  return results
}
