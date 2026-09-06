// #609 slice 6 — provisioning a faction from the admin console.
//
// ⚠️ The design this file is protecting: **the admin container provisions
// nothing**. It validates a request and writes a row; a host-side agent outside
// every container claims that row and runs one known command with these
// arguments. So a fully compromised admin container can ask for a faction to be
// created and nothing else — a bound that disappears the moment the Docker
// socket is mounted instead.
//
// Which means the validation IS the interface to a process holding Postgres
// superuser and Docker, and it gets tested like one.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'
import { freePort } from './harness.js'
import {
  validateProvisionRequest, findConflicts, createProvisionRequest,
  retryProvisionRequest, SLUG_PATTERN,
} from '../src/adminPlane/provisioning.js'
import { buildAdminApp } from '../src/adminPlane/app.js'
import { hashPassword } from '../src/adminPlane/password.js'
import { generateTotpSecret } from '../src/adminPlane/totp.js'
import { mintAdminSession } from '../src/adminPlane/session.js'
// @ts-expect-error — the host agent is a plain .mjs script; these are its
// duplicated copies of the rules above, and the duplication is the point.
import { validate as agentValidate, redact, composeArgs } from '../../deploy/host-agent.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = readFileSync(join(here, '..', '..', 'db', 'global-template.sql'), 'utf8')

let embedded: EmbeddedPostgres
let dataDir: string
let port: number
let admin: pg.Client
let db: pg.Pool

const SECRET = 'provisioning-session-secret'
const TOTP = generateTotpSecret()

const ok = (over: Record<string, unknown> = {}) => ({
  slug: 'mayhem', displayName: 'TNL Mayhem Dashboard', tornFactionId: '12345', ...over,
})

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'provisioning-'))
  port = await freePort()
  embedded = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port, persistent: false,
  })
  await embedded.initialise()
  await embedded.start()
  await embedded.createDatabase('global')
  const conn = { host: '127.0.0.1', port, user: 'postgres', password: 'postgres', database: 'global' }
  admin = new pg.Client(conn)
  await admin.connect()
  await admin.query(TEMPLATE)
  db = new pg.Pool({ ...conn, max: 4 })
}, 120_000)

afterAll(async () => {
  await db?.end().catch(() => {})
  await admin?.end().catch(() => {})
  await embedded?.stop().catch(() => {})
  rmSync(dataDir, { recursive: true, force: true })
})

const reset = () => admin.query('TRUNCATE provision_requests')

describe('validateProvisionRequest', () => {
  it('accepts a well-formed request', () => {
    const r = validateProvisionRequest(ok({ leaderId: '2250591' }))
    expect(r).toMatchObject({ ok: true, value: { slug: 'mayhem', leaderId: '2250591' } })
  })

  it('lowercases and trims the slug', () => {
    const r = validateProvisionRequest(ok({ slug: '  Mayhem  ' }))
    expect(r.ok && r.value.slug).toBe('mayhem')
  })

  it('treats a blank optional id as absent rather than invalid', () => {
    const r = validateProvisionRequest(ok({ leaderId: '', adminId: '   ' }))
    expect(r.ok).toBe(true)
    expect(r.ok && r.value.leaderId).toBeUndefined()
  })

  describe('⚠️ the slug is interpolated into CREATE DATABASE', () => {
    // db/new-faction.mjs builds `CREATE DATABASE faction_${slug}` and
    // `CREATE ROLE app_${slug}`. That guard used to protect a human at a CLI;
    // it now protects a web form.
    // 'Mayhem' is absent on purpose: the API lowercases before validating (see
    // the trim/lowercase test above), so it is accepted and STORED lowercase.
    // The agent, which never lowercases, refuses uppercase outright — covered
    // in the agent block below.
    for (const bad of ['a', 'may-hem', 'may hem', '1mayhem', 'may;hem', "may'hem", 'may$hem', '']) {
      it(`rejects ${JSON.stringify(bad)}`, () => {
        expect(validateProvisionRequest(ok({ slug: bad })).ok).toBe(false)
      })
    }

    it('⚠️ caps the length, because Postgres truncates identifiers SILENTLY', () => {
      // At 63 bytes two different `faction_<62 chars>` names land on the same
      // database — no error, just a collision discovered much later.
      expect(validateProvisionRequest(ok({ slug: 'a'.repeat(30) })).ok).toBe(false)
      expect(SLUG_PATTERN.test('a'.repeat(21))).toBe(true)
      expect(SLUG_PATTERN.test('a'.repeat(22))).toBe(false)
    })
  })

  it('rejects reserved slugs', () => {
    for (const s of ['global', 'postgres', 'template1', 'admin']) {
      expect(validateProvisionRequest(ok({ slug: s })).ok).toBe(false)
    }
  })

  it('⚠️ rejects a slug ending in _dev, which would be invisible to monitoring', () => {
    // The staging stack's databases are `faction_<slug>_dev`, and the status
    // collector deliberately excludes them so five phantom tenants are not
    // reported as down. A real faction slugged `mayhem_dev` would be a tenant
    // the fleet monitor never reports on.
    const r = validateProvisionRequest(ok({ slug: 'mayhem_dev' }))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('_dev')
  })

  it('rejects a non-numeric or zero Torn faction id', () => {
    for (const id of ['abc', '0', '-1', '1.5', '']) {
      expect(validateProvisionRequest(ok({ tornFactionId: id })).ok).toBe(false)
    }
  })

  it('rejects a malformed leader id', () => {
    expect(validateProvisionRequest(ok({ leaderId: 'me' })).ok).toBe(false)
  })

  it('bounds the display name', () => {
    expect(validateProvisionRequest(ok({ displayName: 'x' })).ok).toBe(false)
    expect(validateProvisionRequest(ok({ displayName: 'x'.repeat(81) })).ok).toBe(false)
  })
})

describe('⚠️ the agent re-validates independently', () => {
  // "The API already validated it" stops being true the day anything else
  // writes to that table — and the agent is the process holding superuser and
  // Docker. The two checks are duplicated on purpose, so they are compared
  // against each other here rather than assumed to agree.
  const row = (over: Record<string, unknown> = {}) => ({
    slug: 'mayhem', display_name: 'TNL Mayhem Dashboard', torn_faction_id: '12345',
    leader_id: null, admin_id: null, ...over,
  })

  it('agrees with the API on a good request', () => {
    expect(agentValidate(row())).toBeNull()
  })

  for (const [label, over] of [
    ['an injected slug', { slug: 'may;hem' }],
    // ⚠️ The agent never lowercases. The API stores a lowercased slug, so an
    // uppercase one reaching here means the row did not come from the API.
    ['an uppercase slug', { slug: 'Mayhem' }],
    ['an over-long slug', { slug: 'a'.repeat(30) }],
    ['a reserved slug', { slug: 'postgres' }],
    ['a _dev slug', { slug: 'mayhem_dev' }],
    ['a bad faction id', { torn_faction_id: 'abc' }],
    ['a bad leader id', { leader_id: 'x' }],
    ['a blank display name', { display_name: '' }],
  ] as const) {
    it(`refuses ${label} even though the API should have`, () => {
      expect(agentValidate(row(over))).toBeTruthy()
    })
  }
})

describe('⚠️ the captured log is redacted', () => {
  // new-faction.mjs states the generated credential is "never printed", and it
  // is not — but this log is served over the admin API, so anything that starts
  // looking like a secret is masked here rather than relying on a promise made
  // in another file.
  it('masks an env-style credential line', () => {
    expect(redact('DB_PASSWORD_MAYHEM=deadbeefcafe\n')).toBe('DB_PASSWORD_MAYHEM=********\n')
    expect(redact('  JWT_SECRET = hunter2')).toBe('  JWT_SECRET = ********')
  })

  it('masks a password inside a connection string', () => {
    expect(redact('postgres://app_mayhem:s3cr3t@postgres:5432/faction_mayhem'))
      .toBe('postgres://app_mayhem:********@postgres:5432/faction_mayhem')
  })

  it('leaves ordinary output alone', () => {
    const line = 'Created faction_mayhem for "TNL Mayhem Dashboard" (Torn faction 12345).'
    expect(redact(line)).toBe(line)
  })
})

describe('findConflicts', () => {
  it('is clean for a fresh slug', async () => {
    await reset()
    expect(await findConflicts(db, { slug: 'mayhem', displayName: 'X', tornFactionId: '1' })).toEqual([])
  })

  it('⚠️ refuses a slug whose database already exists', async () => {
    await reset()
    // Reads pg_database — a shared catalog app_global_rw can see without being
    // able to CONNECT to any of them.
    await admin.query('CREATE DATABASE faction_taken')
    const c = await findConflicts(db, { slug: 'taken', displayName: 'X', tornFactionId: '1' })
    expect(c[0]).toMatchObject({ field: 'slug' })
    await admin.query('DROP DATABASE faction_taken')
  })

  it('refuses a slug that already has a live or completed request', async () => {
    await reset()
    await createProvisionRequest(db, { slug: 'mayhem', displayName: 'X', tornFactionId: '1' }, 'me')
    const c = await findConflicts(db, { slug: 'mayhem', displayName: 'X', tornFactionId: '2' })
    expect(c.some((x) => x.field === 'slug')).toBe(true)
  })

  it('refuses the same Torn faction under a different slug', async () => {
    await reset()
    await createProvisionRequest(db, { slug: 'mayhem', displayName: 'X', tornFactionId: '999' }, 'me')
    const c = await findConflicts(db, { slug: 'other', displayName: 'X', tornFactionId: '999' })
    expect(c[0]).toMatchObject({ field: 'tornFactionId' })
    expect(c[0].reason).toContain('mayhem')
  })

  it('lets a failed request be re-requested under the same slug', async () => {
    await reset()
    const row = await createProvisionRequest(db, { slug: 'mayhem', displayName: 'X', tornFactionId: '1' }, 'me')
    await admin.query(`UPDATE provision_requests SET status = 'failed' WHERE id = $1`, [row.id])
    expect(await findConflicts(db, { slug: 'mayhem', displayName: 'X', tornFactionId: '1' })).toEqual([])
  })
})

describe('⚠️ at most one live request per slug', () => {
  it('is enforced by the database, not only by the conflict check', async () => {
    // Two agents — or one agent and an impatient operator clicking twice —
    // running new-faction.mjs for the same slug is how you get a role that
    // exists and a schema that does not.
    await reset()
    await createProvisionRequest(db, { slug: 'mayhem', displayName: 'X', tornFactionId: '1' }, 'me')
    await expect(
      createProvisionRequest(db, { slug: 'mayhem', displayName: 'X', tornFactionId: '2' }, 'me')
    ).rejects.toThrow(/duplicate key|unique/i)
  })
})

describe('retryProvisionRequest', () => {
  it('re-queues a failed request and keeps its log', async () => {
    await reset()
    const row = await createProvisionRequest(db, { slug: 'mayhem', displayName: 'X', tornFactionId: '1' }, 'me')
    await admin.query(
      `UPDATE provision_requests SET status = 'failed', log = 'previous output', finished_at = now() WHERE id = $1`,
      [row.id]
    )
    const retried = await retryProvisionRequest(db, row.id)
    expect(retried).toMatchObject({ status: 'pending', finished_at: null })
    // ⚠️ new-faction.mjs is idempotent and has an --adopt path, so "what did it
    // get through last time" is the useful question — and answering it from the
    // previous log is the difference between a retry and a guess.
    expect(retried!.log).toContain('previous output')
  })

  it('⚠️ refuses to re-queue a RUNNING request', async () => {
    // That would hand the same slug to a second agent run while the first is
    // still inside new-faction.mjs — the race the unique index exists to stop,
    // arriving through the front door instead.
    await reset()
    const row = await createProvisionRequest(db, { slug: 'mayhem', displayName: 'X', tornFactionId: '1' }, 'me')
    await admin.query(`UPDATE provision_requests SET status = 'running' WHERE id = $1`, [row.id])
    expect(await retryProvisionRequest(db, row.id)).toBeNull()
  })
})

describe('the provisioning routes', () => {
  const build = async (surface: 'public' | 'local' = 'public') =>
    buildAdminApp({
      surface, username: 'u', passwordHash: await hashPassword('a-long-test-password'),
      totpSecret: TOTP, sessionSecret: SECRET, version: '9.9.9', fleetDb: db,
    })

  const auth = async (surface: 'public' | 'local' = 'public') =>
    ({ authorization: `Bearer ${await mintAdminSession(SECRET, 'u', surface)}` })

  it('requires authentication', async () => {
    const app = await build()
    expect((await app.inject({ method: 'POST', url: '/api/admin/provision', payload: ok() })).statusCode).toBe(401)
    await app.close()
  })

  it('accepts a request and records who asked', async () => {
    await reset()
    const app = await build()
    const res = await app.inject({
      method: 'POST', url: '/api/admin/provision', headers: await auth(), payload: ok(),
    })
    // 202: accepted, not done. The agent has not run yet, and saying "created"
    // here would be a lie the operator acts on.
    expect(res.statusCode).toBe(202)
    expect(res.json().request).toMatchObject({ slug: 'mayhem', status: 'pending', requested_by: 'u' })
    await app.close()
  })

  it('rejects a bad slug with a readable error and no row', async () => {
    await reset()
    const app = await build()
    const res = await app.inject({
      method: 'POST', url: '/api/admin/provision', headers: await auth(), payload: ok({ slug: 'May-hem' }),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('lowercase')
    expect((await db.query('SELECT * FROM provision_requests')).rowCount).toBe(0)
    await app.close()
  })

  it('⚠️ reports a duplicate as a conflict rather than half-provisioning', async () => {
    await reset()
    const app = await build()
    await app.inject({ method: 'POST', url: '/api/admin/provision', headers: await auth(), payload: ok() })
    const dup = await app.inject({
      method: 'POST', url: '/api/admin/provision', headers: await auth(), payload: ok(),
    })
    expect(dup.statusCode).toBe(409)
    expect(dup.json().conflicts[0].field).toBe('slug')
    await app.close()
  })

  it('lists and fetches requests', async () => {
    await reset()
    const app = await build()
    const created = await app.inject({
      method: 'POST', url: '/api/admin/provision', headers: await auth(), payload: ok(),
    })
    const id = created.json().request.id

    const list = await app.inject({ method: 'GET', url: '/api/admin/provision', headers: await auth() })
    expect(list.json().requests).toHaveLength(1)

    const one = await app.inject({ method: 'GET', url: `/api/admin/provision/${id}`, headers: await auth() })
    expect(one.json().request.slug).toBe('mayhem')

    const missing = await app.inject({ method: 'GET', url: '/api/admin/provision/999999', headers: await auth() })
    expect(missing.statusCode).toBe(404)
    await app.close()
  })

  it('retries a failed request, and explains why it will not retry a live one', async () => {
    await reset()
    const app = await build()
    const created = await app.inject({
      method: 'POST', url: '/api/admin/provision', headers: await auth(), payload: ok(),
    })
    const id = created.json().request.id

    const tooSoon = await app.inject({
      method: 'POST', url: `/api/admin/provision/${id}/retry`, headers: await auth(),
    })
    expect(tooSoon.statusCode).toBe(409)
    expect(tooSoon.json().error).toContain('pending')

    await admin.query(`UPDATE provision_requests SET status = 'failed' WHERE id = $1`, [id])
    const retried = await app.inject({
      method: 'POST', url: `/api/admin/provision/${id}/retry`, headers: await auth(),
    })
    expect(retried.json().request.status).toBe('pending')
    await app.close()
  })
})

describe('⚠️ the agent\'s compose invocation', () => {
  // This SHIPPED broken in slice 6 and would have failed every provisioning run
  // at the last step. Every `api-<slug>` service lives in
  // docker-compose.override.yml — which db/new-faction.mjs writes moments
  // earlier in the same function — but compose auto-loads an override only when
  // NO `-f` is passed at all. So `docker compose -f deploy/docker-compose.yml
  // up api-mayhem` dies with `no such service: api-mayhem`, after the database,
  // the role and the deploy artifacts had all been created correctly.
  const repoWith = (override: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), 'compose-args-'))
    mkdirSync(join(dir, 'deploy'))
    writeFileSync(join(dir, 'deploy', 'docker-compose.yml'), 'services: {}')
    if (override) writeFileSync(join(dir, 'deploy', 'docker-compose.override.yml'), 'services: {}')
    return dir
  }

  it('passes the override file, which is where every tenant service lives', () => {
    const args = composeArgs(repoWith(true), ['up', '-d', '--build', 'api-mayhem', 'nginx'])
    expect(args.join(' ')).toBe(
      'compose -f deploy/docker-compose.yml -f deploy/docker-compose.override.yml ' +
      '--project-directory deploy up -d --build api-mayhem nginx'
    )
  })

  it('omits it on a host that has none, rather than failing on a missing file', () => {
    // A box with no factions provisioned yet has no override file at all.
    const args = composeArgs(repoWith(false), ['up', '-d'])
    expect(args).not.toContain('deploy/docker-compose.override.yml')
    expect(args.join(' ')).toContain('--project-directory deploy')
  })

  it('⚠️ never passes --remove-orphans', () => {
    // With only the base file compose calls all five running tenant containers
    // orphans — it says so in its output — so that flag on this invocation
    // would DELETE every tenant API container on the box.
    expect(composeArgs(repoWith(true), ['up', '-d', '--build', 'api-x', 'nginx']))
      .not.toContain('--remove-orphans')
  })
})
