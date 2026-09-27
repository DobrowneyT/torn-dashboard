// Wire Chain Watch's push-a-redraw socket into the production fleet.
//
// ⚠️ **Staging has had this since #785; production never did.** The dev stack
// is one `server` service in a checked-in compose file, so its socket was wired
// there. Production is five `api-<slug>` services in a file generated per
// tenant that lives only on the box — nothing in the repo could reach it. The
// result: a faction pointed at its REAL dashboard silently falls back to the
// five-minute poll, and a board that is merely late is not something anybody
// reports.
//
//   node db/chain-notify-wire.mjs             # show what would change
//   node db/chain-notify-wire.mjs --write     # apply it, with a backup
//   node db/chain-notify-wire.mjs --write forge
//
// Then, in deploy/.env, point it at the directory the bot's socket lives in:
//
//   CHAIN_NOTIFY_DIR=/home/ubuntu/torn/run/chain-notify
//
// ⚠️ The same directory the bot creates its socket in, and the bot must be able
// to write there. Unset, every tenant mounts a dummy path and behaves exactly
// as it does today — that optionality is deliberate and must stay.
//
// After --write:  docker compose -f deploy/docker-compose.yml up -d --no-deps api-<slug>
import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setOverrideChainNotify, HOST_DIR_VAR, CONTAINER_DIR } from './chainNotifyFile.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const deployDir = join(here, '..', 'deploy')
const overridePath = join(deployDir, 'docker-compose.override.yml')

const args = process.argv.slice(2)
const write = args.includes('--write')
const positional = args.filter((a) => !a.startsWith('--'))

if (!existsSync(overridePath)) {
  console.error(
    `${overridePath} does not exist.\n` +
    'This is the production fleet\'s per-faction compose file, written by\n' +
    'db/new-faction.mjs. Run this on the box that serves the tenants.'
  )
  process.exit(2)
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

const before = readFileSync(overridePath, 'utf8')
const result = setOverrideChainNotify(before, slugs)

// ⚠️ A slug with no service is a FAILURE, not a warning — the same rule the
// token scripts state. Half a fleet wired is the worst outcome: one tenant
// pushes instantly, another is five minutes behind, and nothing says which.
if (result.missing.length > 0) {
  console.error(
    `No api-<slug> service found for: ${result.missing.join(', ')}\nNothing was written.`
  )
  process.exit(2)
}

if (result.wired.length === 0) {
  console.log(`Already wired: ${result.already.join(', ')}. Nothing to do.`)
  process.exit(0)
}

if (!write) {
  console.log(
    `Would wire ${CONTAINER_DIR} into: ${result.wired.join(', ')}` +
    (result.already.length ? `\nAlready wired: ${result.already.join(', ')}` : '') +
    `\n\nRe-run with --write to apply, then set ${HOST_DIR_VAR} in deploy/.env` +
    '\nand restart those services.'
  )
  process.exit(0)
}

// ⚠️ A backup, unlike the token scripts. Those replace one value per service;
// this inserts structure into every one of them, and the file it is editing
// holds each tenant's DATABASE_URL.
const backup = `${overridePath}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`
copyFileSync(overridePath, backup)
writeFileSync(overridePath, result.text)

console.log(
  `Wired ${CONTAINER_DIR} into ${result.wired.length} service(s): ${result.wired.join(', ')}\n` +
  `Backup: ${backup}\n\n` +
  `Next:\n` +
  `  1. Set ${HOST_DIR_VAR}=<the directory the bot's socket lives in> in deploy/.env\n` +
  `  2. docker compose -f deploy/docker-compose.yml up -d --no-deps ` +
  `${result.wired.map((s) => `api-${s}`).join(' ')}\n` +
  `\n⚠️ Leaving ${HOST_DIR_VAR} unset is safe — every tenant then behaves exactly\n` +
  `as it does now, updating the board on its poll interval.`
)
