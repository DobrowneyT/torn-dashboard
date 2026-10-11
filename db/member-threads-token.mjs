// Print — or write — the member-threads token for one faction, or for all (#942).
//
// ⚠️ **A FOURTH token, and not a copy of the other three.** All four come from
// FLEET_METRICS_SECRET, scoped apart:
//
//     token(slug) = HMAC-SHA256(FLEET_METRICS_SECRET, "member-threads:" + slug)
//
// This one is the only one of the four that grants WRITES. Its holder drains a
// queue of per-member performance records and marks them posted — against a
// permanent roll-call log that the faction's leadership reads. A leak of the
// Chain Watch board credential must not confer that, and vice versa: scoping
// the HMAC costs one string.
//
//   node db/member-threads-token.mjs            # print every faction's line
//   node db/member-threads-token.mjs forge      # print just one
//   node db/member-threads-token.mjs --write    # write them into the override
//
// ⚠️ The bot needs the SAME value, out of band — never through a slash command
// (#783): Discord command arguments are visible client-side and land in logs.
// In practice it does not need pasting at all: the admin plane's
// `GET /api/internal/tenants?tokens=1` derives it per tenant on demand, which
// is how the bot picks up a faction provisioned after it last restarted.
//
// After --write:  docker compose up -d --no-deps api-<slug> ...
import { createHmac } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { setOverrideTokens } from './fleetTokenFile.mjs'
import { memberThreadsScope } from './memberThreadsTokenLib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const deployDir = join(here, '..', 'deploy')
const env = {}
dotenv.config({ path: join(deployDir, '.env'), processEnv: env })

const secret = process.env.FLEET_METRICS_SECRET ?? env.FLEET_METRICS_SECRET
if (!secret) {
  console.error(
    'FLEET_METRICS_SECRET is not set in deploy/.env.\n' +
    'Generate one with:  openssl rand -hex 32\n' +
    '(The same secret backs fleet metrics; this token is scoped separately.)'
  )
  process.exit(2)
}

const token = (slug) => createHmac('sha256', secret).update(memberThreadsScope(slug)).digest('hex')

const args = process.argv.slice(2)
const write = args.includes('--write')
const positional = args.filter((a) => !a.startsWith('--'))

if (positional.length > 0 && !write) {
  console.log(`MEMBER_THREADS_TOKEN=${token(positional[0])}`)
  process.exit(0)
}

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
  for (const slug of slugs) console.log(`api-${slug}:  MEMBER_THREADS_TOKEN: ${token(slug)}`)
  console.log(
    '\n# ⚠️ Give each service ONLY its own line. FLEET_METRICS_SECRET itself\n' +
    '# belongs to the admin container alone.  Re-run with --write to apply them.'
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
const result = setOverrideTokens(before, tokens, 'MEMBER_THREADS_TOKEN')

// ⚠️ A slug with no service in the file is a FAILURE, not a warning to scroll
// past — the same rule the other three state: that tenant keeps whatever it
// had, silently, and the bot 401s against it forever while the others look
// fine. Nothing is written until every slug resolved.
if (result.missing.length > 0) {
  console.error(
    `No api-<slug> service found for: ${result.missing.join(', ')}\n` +
    'Nothing was written.'
  )
  process.exit(2)
}

writeFileSync(overridePath, result.text)
console.log(
  `Wrote MEMBER_THREADS_TOKEN for ${result.updated.length + result.added.length} service(s) ` +
  `(${result.updated.length} updated, ${result.added.length} added).\n` +
  `Restart them:  docker compose up -d --no-deps ${slugs.map((s) => `api-${s}`).join(' ')}`
)
