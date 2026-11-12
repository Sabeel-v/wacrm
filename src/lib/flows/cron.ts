import { supabaseAdmin } from './admin-client'
import { resolveFallbackPolicy } from './fallback'

/**
 * Sweep abandoned active flow runs: mark any run older than its flow's
 * `fallback_policy.on_timeout_hours` (default 24h) as `timed_out` and write
 * a `flow_run_events` row.
 *
 * Not optional: an abandoned run keeps its slot in the "one active run per
 * contact" unique index forever and blocks new triggers for that contact.
 *
 * Called every 5 minutes by the API worker's Cron Trigger, and by
 * GET /api/flows/cron for manual runs.
 */
export async function sweepStaleFlowRuns(now = new Date()): Promise<{ swept: number }> {
  const admin = supabaseAdmin()
  const { data: runs, error } = await admin
    .from('flow_runs')
    .select('id, flow_id, user_id, contact_id, last_advanced_at, flows ( fallback_policy )')
    .eq('status', 'active')
  if (error) throw new Error(error.message)

  type Row = {
    id: string
    last_advanced_at: string
    flows: { fallback_policy: unknown } | { fallback_policy: unknown }[] | null
  }

  let swept = 0
  for (const r of (runs ?? []) as Row[]) {
    const flowsField = Array.isArray(r.flows) ? r.flows[0] : r.flows
    const policy = resolveFallbackPolicy(flowsField?.fallback_policy ?? null)
    const ageHours = (now.getTime() - new Date(r.last_advanced_at).getTime()) / 3_600_000
    if (ageHours < policy.on_timeout_hours) continue

    // Guarded by status='active' so a late inbound that just advanced or
    // finished the run isn't overwritten.
    const { data: updated } = await admin
      .from('flow_runs')
      .update({ status: 'timed_out', ended_at: now.toISOString(), end_reason: 'stale_sweep' })
      .eq('id', r.id)
      .eq('status', 'active')
      .select('id')

    if (Array.isArray(updated) && updated.length > 0) {
      await admin.from('flow_run_events').insert({
        flow_run_id: r.id,
        event_type: 'timeout',
        payload: { age_hours: Math.round(ageHours * 10) / 10, policy_hours: policy.on_timeout_hours },
      })
      swept += 1
    }
  }
  return { swept }
}
