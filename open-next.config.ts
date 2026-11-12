// OpenNext adapter config for Cloudflare Workers.
//
// No incremental cache override: the app has no ISR, `revalidate`,
// `unstable_cache` or `'use cache'` (see MIGRATION_ASSESSMENT.md §3.4),
// so the default (no-op) cache is enough. Add an R2/KV incremental
// cache here only if a page starts using ISR.
import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig({});
