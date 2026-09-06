// Print the fleet-metrics token for one faction, or for all of them (#632).
//
// ⚠️ Each tenant is given only its OWN token, never FLEET_METRICS_SECRET. One
// shared secret in every tenant's environment would mean a leak from any single
// faction reads every faction's metrics; one faction's compromise should be one
// faction. The admin container holds the secret and derives what it needs.
//
//   node db/fleet-metrics-token.mjs            # every faction in deploy/.env
//   node db/fleet-metrics-token.mjs mayhem     # just one
import { createHmac } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

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

const arg = process.argv[2]
if (arg) {
  console.log(`FLEET_METRICS_TOKEN=${token(arg)}`)
  process.exit(0)
}

// Every faction with a generated vhost — the same list update.sh verifies.
const dir = join(deployDir, 'nginx', 'factions')
const slugs = existsSync(dir)
  ? readFileSync
    ? (await import('node:fs')).readdirSync(dir).filter((f) => f.endsWith('.conf')).map((f) => f.replace(/\.conf$/, ''))
    : []
  : []

if (slugs.length === 0) {
  console.error('No faction vhosts found under deploy/nginx/factions — pass a slug explicitly.')
  process.exit(2)
}

console.log('# Add each line to the matching api-<slug> service in deploy/docker-compose.override.yml:\n')
for (const slug of slugs.sort()) {
  console.log(`api-${slug}:  FLEET_METRICS_TOKEN: ${token(slug)}`)
}
console.log(
  '\n# ⚠️ Give each service ONLY its own line. FLEET_METRICS_SECRET itself belongs\n' +
  '# to the admin container alone.'
)
