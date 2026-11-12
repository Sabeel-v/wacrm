// Copies the secrets the API worker needs from .env.local into
// workers/api/.dev.vars (Wrangler loads that file automatically for local
// dev of that worker; `--env-file` only reaches the first worker when two
// configs run together). Runs before `npm run preview:all` / `dev:api`.
//
// The file is git-ignored (.gitignore: .dev.vars*). In production these
// are Worker secrets: `npx wrangler secret put NAME -c workers/api/wrangler.jsonc`.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const KEYS = ['ENCRYPTION_KEY', 'META_APP_SECRET', 'META_APP_ID']
const SOURCE = '.env.local'
const TARGET = 'workers/api/.dev.vars'

if (!existsSync(SOURCE)) {
  console.warn(`[sync-api-dev-vars] ${SOURCE} not found; the API worker will run without secrets.`)
  process.exit(0)
}

const values = new Map()
for (const line of readFileSync(SOURCE, 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
  if (m && KEYS.includes(m[1])) values.set(m[1], m[2])
}

const missing = KEYS.filter((k) => !values.get(k))
const body = [
  '# GENERATED from .env.local by scripts/sync-api-dev-vars.mjs. Do not commit.',
  ...KEYS.filter((k) => values.has(k)).map((k) => `${k}=${values.get(k)}`),
  '',
].join('\n')
writeFileSync(TARGET, body)
console.log(
  `[sync-api-dev-vars] wrote ${TARGET} (${KEYS.length - missing.length}/${KEYS.length} keys)` +
    (missing.length ? `; missing in ${SOURCE}: ${missing.join(', ')}` : ''),
)
