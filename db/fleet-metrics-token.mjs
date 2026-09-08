// Print — or write — the fleet-metrics token for one faction, or for all (#632).
//
// ⚠️ Each tenant is given only its OWN token, never FLEET_METRICS_SECRET. One
// shared secret in every tenant's environment would mean a leak from any single
// faction reads every faction's metrics; one faction's compromise should be one
// faction. The admin container holds the secret and derives what it needs.
//
//   node db/fleet-metrics-token.mjs            # print every faction's line
//   node db/fleet-metrics-token.mjs mayhem     # print just one
//   node db/fleet-metrics-token.mjs --write    # write them into the override
//
// ⚠️ `--write` is the path that matters in practice. new-faction.mjs bakes the
// token in at provisioning time, which covers factions created AFTER the secret
// exists — but the secret is generated once, later, against a fleet that is
// already running. Every live tenant predates it. Hand-pasting five values is
// how one of them ends up stale, reporting `metricsError` forever while the
// other four look fine.
//
// After --write:  docker compose up -d --no-deps api-<slug> ... admin
import { createHmac } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { setOverrideTokens } from './fleetTokenFile.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const deployDir = join(here, '..', 'deploy')
const env = {}
dotenv.config({ path: join(deployDir, '.env'), processEnv: env })

const secret = process.env.FLEET_METRICS_SECRET ?? env.FLEET_METRICS_SECRET
if (!secret) {
  console.error(
    'FLEET_METRICS_SECRET is not set in deploy/.env.\n' +
    'Generate one with:  openssl rand -hex 32'
  )
  process.exit(2)
}

const token = (slug) => createHmac('sha256', secret).update(slug).digest('hex')

const args = process.argv.slice(2)
const write = args.includes('--write')
const positional = args.filter((a) => !a.startsWith('--'))

if (positional.length > 0 && !write) {
  console.log(`FLEET_METRICS_TOKEN=${token(positional[0])}`)
  process.exit(0)
}

// Every faction with a generated vhost — the same list update.sh verifies.
const vhostDir = join(deployDir, 'nginx', 'factions')
const slugs = positional.length > 0
  ? positional
  : existsSync(vhostDir)
    ? readdirSync(vhostDir).filter((f) => f.endsWith('.conf')).map((f) => f.replace(/\.conf$/, '')).sort()
    : []

if (slugs.length === 0) {
  console.error('No faction vhosts found under deploy/nginx/factions — pass a slug explicitly.')
  process.exit(2)
}

if (!write) {
  console.log('# Add each line to the matching api-<slug> service in deploy/docker-compose.override.yml:\n')
  for (const slug of slugs) console.log(`api-${slug}:  FLEET_METRICS_TOKEN: ${token(slug)}`)
  console.log(
    '\n# ⚠️ Give each service ONLY its own line. FLEET_METRICS_SECRET itself belongs\n' +
    '# to the admin container alone.  Re-run with --write to apply them.'
  )
  process.exit(0)
}

const overridePath = join(deployDir, 'docker-compose.override.yml')
if (!existsSync(overridePath)) {
  console.error(`${overridePath} does not exist — nothing to write into.`)
  process.exit(2)
}

const tokens = Object.fromEntries(slugs.map((s) => [s, token(s)]))
const before = readFileSync(overridePath, 'utf8')
const result = setOverrideTokens(before, tokens)

// ⚠️ A slug with no service in the file is a FAILURE, not a warning to scroll
// past: that tenant keeps whatever token it had, so it 401s against the new
// secret and the status page reports it as "not measured" — which #645 proved
// a human reads as healthy. Nothing is written until every slug resolved.
if (result.missing.length > 0) {
  console.error(
    `No api-<slug> service in the override for: ${result.missing.join(', ')}\n` +
    'Nothing was written. Check the slug spelling against deploy/nginx/factions.'
  )
  process.exit(2)
}

// ⚠️ Timestamped backup, kept. This file holds every tenant's DATABASE_URL and
// is gitignored, so a bad write has no `git checkout` to undo it.
const backup = `${overridePath}.bak.${Date.now()}`
writeFileSync(backup, before)
writeFileSync(overridePath, result.text)

console.log(`Wrote ${result.updated.length + result.added.length} token(s) to ${overridePath}`)
if (result.updated.length) console.log(`  replaced: ${result.updated.join(', ')}`)
if (result.added.length) console.log(`  added:    ${result.added.join(', ')}`)
console.log(`  backup:   ${backup}`)
console.log(
  '\nRestart the affected services to pick them up:\n' +
  `  docker compose ... up -d --no-deps ${slugs.map((s) => `api-${s}`).join(' ')}\n` +
  '  docker compose ... --profile admin up -d --no-deps admin'
)
