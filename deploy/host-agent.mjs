#!/usr/bin/env node
// The host-side provisioning agent (#609 slice 6).
//
// ⚠️ **This runs on the HOST, outside every container, and that is the entire
// security design.** Provisioning a faction needs Postgres superuser, write
// access to the deploy directory, and Docker. Giving those to the admin
// container — the one thing in this stack that accepts logins from the internet
// — would mean a compromise there is root on the box. Mounting the Docker
// socket into it would be the same thing wearing a hat.
//
// Instead the admin container writes a REQUEST ROW, and this agent claims it
// and runs ONE KNOWN COMMAND with schema-validated arguments. A fully
// compromised admin container can ask for a faction to be created and nothing
// else. That bound is worth the extra moving part.
//
// ⚠️ Every subprocess is spawned with an ARGV ARRAY, never a shell string.
// `spawn(cmd, [...args])` with no `shell: true` means a slug containing shell
// metacharacters is an argument, not a command — and while the validation below
// would already have rejected it, the two defences are independent on purpose.
//
// Usage (systemd runs the first form; the second is for a manual check):
//   node deploy/host-agent.mjs
//   node deploy/host-agent.mjs --once
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import dotenv from 'dotenv'
import pg from 'pg'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

// Mirrors server/src/adminPlane/provisioning.ts. ⚠️ Duplicated deliberately:
// "the API already validated it" stops being true the day anything else writes
// to that table, and this process is the one holding superuser and Docker.
const SLUG_PATTERN = /^[a-z][a-z0-9_]{1,20}$/
const RESERVED_SLUGS = new Set(['global', 'postgres', 'template0', 'template1', 'admin', 'public'])
const ID_PATTERN = /^[1-9]\d{0,9}$/

/** ⚠️ A docker build log is megabytes. Keep the tail — the end is where the
 *  error is — and say what was dropped rather than silently truncating. */
const LOG_LIMIT = 64 * 1024

/** How long one provisioning run may take before it is called failed. A hung
 *  `docker build` would otherwise hold the row in 'running' forever, and the
 *  partial unique index would block every retry for that slug. */
const STEP_TIMEOUT_MS = 15 * 60 * 1000

/** Assigned in main(); the module imports cleanly so its rules can be tested. */
let db = null

function connectionStringFrom(env, composeEnv) {
  if (env.GLOBAL_DATABASE_URL_RW) return env.GLOBAL_DATABASE_URL_RW
  if (!composeEnv.DB_PASSWORD_GLOBAL_RW) return null
  const host = composeEnv.POSTGRES_HOST_PORT ?? 5432
  return `postgres://app_global_rw:${composeEnv.DB_PASSWORD_GLOBAL_RW}@127.0.0.1:${host}/${composeEnv.GLOBAL_DB_NAME ?? 'global'}`
}

export function validate(row) {
  if (!SLUG_PATTERN.test(row.slug)) return `Invalid slug ${JSON.stringify(row.slug)}`
  if (RESERVED_SLUGS.has(row.slug)) return `Reserved slug ${JSON.stringify(row.slug)}`
  if (row.slug.endsWith('_dev')) return 'Slugs ending in "_dev" are reserved for the staging stack'
  if (!ID_PATTERN.test(row.torn_faction_id)) return `Invalid Torn faction id ${JSON.stringify(row.torn_faction_id)}`
  for (const id of [row.leader_id, row.admin_id]) {
    if (id != null && !ID_PATTERN.test(id)) return `Invalid Torn user id ${JSON.stringify(id)}`
  }
  if (typeof row.display_name !== 'string' || row.display_name.length < 2 || row.display_name.length > 80) {
    return 'Invalid display name'
  }
  return null
}

/**
 * ⚠️ Belt and braces. `new-faction.mjs` states that the generated credential is
 * "never printed", and it is not — but this log is served over the admin API,
 * so anything that ever starts looking like a secret gets masked here rather
 * than relying on a promise made in another file.
 */
export function redact(text) {
  return text
    .replace(/^(\s*(?:[A-Z0-9_]*(?:PASSWORD|SECRET|KEY|TOKEN)[A-Z0-9_]*)\s*=\s*)\S+/gm, '$1********')
    .replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/g, '$1********@')
}

async function appendLog(id, chunk) {
  await db.query(
    `UPDATE provision_requests
        SET log = right(log || $2, ${LOG_LIMIT})
      WHERE id = $1`,
    [id, redact(chunk)]
  )
}

async function setStep(id, step) {
  await db.query('UPDATE provision_requests SET step = $2 WHERE id = $1', [id, step])
}

/** Run one command, streaming its output into the request row. */
function run(id, command, argv, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, argv, {
      cwd: repoRoot,
      // ⚠️ No `shell: true`. With an argv array and no shell there is nothing
      // for a metacharacter to mean.
      shell: false,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      void appendLog(id, `\n[agent] TIMED OUT after ${STEP_TIMEOUT_MS / 1000}s — killed.\n`)
      resolve(124)
    }, STEP_TIMEOUT_MS)

    const pipe = (stream) => stream.on('data', (buf) => { void appendLog(id, buf.toString()) })
    pipe(child.stdout)
    pipe(child.stderr)

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void appendLog(id, `\n[agent] failed to start ${command}: ${err.message}\n`)
      resolve(127)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(code ?? 1)
    })
  })
}

/**
 * Claim exactly one pending request.
 *
 * `FOR UPDATE SKIP LOCKED` so two agents — or an agent and a manual `--once`
 * run — cannot pick up the same row.
 */
async function claim() {
  const res = await db.query(
    `UPDATE provision_requests SET status = 'running', started_at = now(), attempts = attempts + 1
      WHERE id = (
        SELECT id FROM provision_requests WHERE status = 'pending'
         ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1
      )
      RETURNING *`
  )
  return res.rows[0] ?? null
}

async function finish(id, status, step) {
  await db.query(
    `UPDATE provision_requests SET status = $2, step = $3, finished_at = now() WHERE id = $1`,
    [id, status, step]
  )
}

async function provision(row) {
  console.log(`[agent] provisioning "${row.slug}" (request ${row.id}, attempt ${row.attempts})`)

  const invalid = validate(row)
  if (invalid) {
    // ⚠️ Fails without running anything. A row that reached this process with a
    // bad slug means something wrote to the table other than the admin API, and
    // the correct response to that is to stop, not to sanitise and continue.
    await appendLog(row.id, `[agent] refusing: ${invalid}\n`)
    await finish(row.id, 'failed', 'validate')
    return
  }

  await setStep(row.id, 'new-faction')
  await appendLog(row.id, `[agent] node db/new-faction.mjs --slug ${row.slug}\n`)
  const argv = [
    'db/new-faction.mjs',
    '--slug', row.slug,
    '--name', row.display_name,
    '--faction-id', row.torn_faction_id,
  ]
  if (row.leader_id) argv.push('--leader-id', row.leader_id)
  if (row.admin_id) argv.push('--admin-id', row.admin_id)

  const created = await run(row.id, process.execPath, argv)
  if (created !== 0) {
    await appendLog(row.id, `\n[agent] new-faction.mjs exited ${created}\n`)
    await finish(row.id, 'failed', 'new-faction')
    return
  }

  // ⚠️ The ONLY step that needs Docker, and the only reason this agent exists
  // rather than the admin container doing the work. `--build` because the nginx
  // image bakes in the per-faction vhost that new-faction.mjs just wrote.
  await setStep(row.id, 'compose-up')
  await appendLog(row.id, `\n[agent] docker compose up -d --build api-${row.slug} nginx\n`)
  const up = await run(row.id, 'docker', [
    'compose', '-f', 'deploy/docker-compose.yml',
    'up', '-d', '--build', `api-${row.slug}`, 'nginx',
  ])
  if (up !== 0) {
    await appendLog(row.id, `\n[agent] docker compose exited ${up}\n`)
    // ⚠️ Deliberately NOT rolled back. The database, role and deploy artifacts
    // exist and are correct; only the container failed to come up. Undoing the
    // first step would throw away the expensive, correct work and leave a
    // retry with nothing to adopt. new-faction.mjs is idempotent, so a retry
    // walks the same path and reaches this step again.
    await finish(row.id, 'failed', 'compose-up')
    return
  }

  await appendLog(row.id, `\n[agent] done — ${row.slug} is up.\n`)
  await finish(row.id, 'done', 'compose-up')
  console.log(`[agent] "${row.slug}" provisioned`)
}

async function tick() {
  const row = await claim()
  if (!row) return false
  try {
    await provision(row)
  } catch (err) {
    // Never let one bad request stop the agent: the next poll must still run.
    console.error(`[agent] request ${row.id} threw:`, err)
    await appendLog(row.id, `\n[agent] internal error: ${err?.message ?? err}\n`).catch(() => {})
    await finish(row.id, 'failed', 'agent').catch(() => {})
  }
  return true
}

async function main() {
  const { values: args } = parseArgs({
    options: { once: { type: 'boolean' }, interval: { type: 'string' } },
  })
  const composeEnv = {}
  dotenv.config({ path: join(here, '.env'), processEnv: composeEnv })

  const connectionString = connectionStringFrom(process.env, composeEnv)
  if (!connectionString) {
    console.error(
      '[agent] No global database credential. Set GLOBAL_DATABASE_URL_RW, or run db/new-global.mjs ' +
      'so deploy/.env carries DB_PASSWORD_GLOBAL_RW.'
    )
    process.exit(1)
  }

  db = new pg.Pool({ connectionString, max: 2 })
  db.on('error', (err) => console.error('[agent] pg pool error:', err.message))

  if (args.once) {
    const did = await tick()
    console.log(did ? '[agent] handled one request' : '[agent] nothing pending')
    await db.end()
    return
  }

  const pollMs = Number(args.interval ?? process.env.PROVISION_POLL_MS ?? 20_000)
  console.log(`[agent] polling every ${pollMs}ms`)
  let stopping = false
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, async () => { stopping = true; await db.end().catch(() => {}); process.exit(0) })
  }
  while (!stopping) {
    try {
      // Drain: a burst of requests should not wait a poll interval each.
      while (await tick()) { /* keep going */ }
    } catch (err) {
      console.error('[agent] poll failed:', err.message)
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
}

// ⚠️ Only when executed directly. The rules above are duplicated from the API
// on purpose and are worth testing, which means the module has to import
// without opening a database connection or entering a poll loop.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
