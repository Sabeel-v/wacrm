// Server client bound to the request's session. Was the Supabase SSR
// client; now the D1 data layer with the RLS port. See docs/data-layer.md.
import { createServerDb } from '@/lib/db/server'

export async function createClient() {
  return createServerDb()
}
