import type { SupabaseClient } from '@/lib/db/client-core'
import { serviceDb } from '@/lib/db/server'

// Lazy, shared service-role client for the Flows engine.
// Mirrors src/lib/automations/admin-client.ts — same shape so anyone
// reading either file picks up the convention immediately.
let _adminClient: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = serviceDb()
  }
  return _adminClient
}
