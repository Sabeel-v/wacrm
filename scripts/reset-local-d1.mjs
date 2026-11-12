// `npm run db:reset:local`: wipe the LOCAL D1 database, apply all
// migrations, load the dev seed. Local only; never touches --remote.
//
// Wrangler asks "About to apply N migration(s)… continue?" in an
// interactive terminal. The database was just wiped, so that prompt adds
// nothing here: run Wrangler with CI=true, its non-interactive mode.
// (`npm run db:migrate:local` keeps the prompt.)
import { rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const DIR = '.wrangler/state/v3/d1'
const LOCAL = ['--local', '--persist-to', '.wrangler/state']

// 1) Delete the local database files ---------------------------------------
try {
  rmSync(DIR, { recursive: true, force: true })
  console.log(`Removed local D1 state (${DIR}).`)
} catch (err) {
  if (err && (err.code === 'EBUSY' || err.code === 'EPERM')) {
    // Windows: a running `wrangler dev` keeps the SQLite files open.
    console.error(
      [
        '',
        'Could not delete the local D1 database: the files are in use.',
        'Stop every running `wrangler dev` / `npm run preview` / `npm run dev:api`',
        '(press x or Ctrl+C in its terminal), then run `npm run db:reset:local` again.',
        '',
        'If nothing is visibly running, a leftover process may be holding the files:',
        '  PowerShell:  Get-Process workerd   then   Stop-Process -Name workerd',
        '',
      ].join('\n'),
    )
    process.exit(1)
  }
  throw err
}

// 2) Migrate and seed, non-interactively ------------------------------------
function wrangler(args) {
  const result = spawnSync('npx', ['wrangler', ...args], {
    stdio: 'inherit',
    shell: process.platform === 'win32', // npx is npx.cmd on Windows
    env: { ...process.env, CI: 'true' },
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

wrangler(['d1', 'migrations', 'apply', 'wacrm-db', ...LOCAL])
wrangler(['d1', 'execute', 'wacrm-db', ...LOCAL, '--file', 'd1/seed/dev.sql'])

console.log('\nLocal D1 reset: schema applied and dev seed loaded.')
