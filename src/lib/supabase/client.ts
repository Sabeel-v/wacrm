// Browser client. Was the Supabase browser client; now the D1 data layer
// (same API: from/rpc/auth/storage/channel). See docs/data-layer.md.
export { createBrowserDb as createClient } from '@/lib/db/browser'
