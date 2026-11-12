import { supabaseAdmin } from './admin-client'
import { resumePendingExecution } from './engine'
import type { AutomationContext } from './engine'

/**
 * Resume due `automation_pending_executions` rows (the "wait" step).
 * Called every minute by the API worker's Cron Trigger, and by
 * GET /api/automations/cron for manual runs.
 *
 * The claim (pending → running, conditional on still being pending) is the
 * lock: overlapping runs never process the same row twice.
 */
export async function drainDueAutomations(limit = 50): Promise<{ processed: number }> {
  const admin = supabaseAdmin()
  const { data: due, error } = await admin
    .from('automation_pending_executions')
    .select('*')
    .eq('status', 'pending')
    .lte('run_at', new Date().toISOString())
    .order('run_at', { ascending: true })
    .limit(limit)
  if (error) throw new Error(error.message)

  let processed = 0
  for (const row of due ?? []) {
    const { data: claim } = await admin
      .from('automation_pending_executions')
      .update({ status: 'running' })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (!claim) continue

    try {
      await resumePendingExecution({
        id: row.id as string,
        automation_id: row.automation_id as string,
        // account_id is NOT NULL post-017; the engine uses it for
        // tenant-scoped lookups.
        account_id: row.account_id as string,
        user_id: row.user_id as string,
        contact_id: (row.contact_id as string | null) ?? null,
        log_id: (row.log_id as string | null) ?? null,
        parent_step_id: (row.parent_step_id as string | null) ?? null,
        branch: (row.branch as 'yes' | 'no' | null) ?? null,
        next_step_position: row.next_step_position as number,
        context: (row.context as AutomationContext) ?? {},
      })
      processed++
    } catch (err) {
      // One bad row must not block the rest of the batch, or stay stuck
      // in 'running' forever.
      console.error(`[automations-cron] ${row.id} failed:`, (err as Error).message)
      await admin
        .from('automation_pending_executions')
        .update({ status: 'failed' })
        .eq('id', row.id)
        .eq('status', 'running')
    }
  }
  return { processed }
}
