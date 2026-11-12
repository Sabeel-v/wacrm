import type { SupabaseClient } from '@/lib/db/client-core'
import { serviceDb } from '@/lib/db/server'

// Lazy, shared service-role client for automation engine work.
// Mirrors the pattern used by the webhook handler
// (src/app/api/whatsapp/webhook/route.ts).
let _adminClient: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = serviceDb()
  }
  return _adminClient
}
