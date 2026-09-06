// #609 slice 1 — the read-only role, proved against real Postgres.
//
// ⚠️ This is the test that holds up the architecture, not a formality. The #608
// audit chose "tenants read `global` directly" over the admin container pushing
// to tenants or tenants pulling from it, because a direct read makes #609's
// hardest constraint — *killing the admin container leaves every tenant fully
// functional* — true by construction.
//
// That choice is only safe if a tenant physically CANNOT write. A shared table
// corrupted by one faction is read by all of them, which is a worse failure
// than any amount of the duplication this replaces. Grants are easy to get
// subtly wrong and impossible to eyeball, so they are exercised here rather
// than trusted.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'
import { freePort } from './harness.js'
// @ts-expect-error — plain .mjs helper shared with db/new-global.mjs
import { applyReadOnlyGrants, applyScopedGrants } from '../../db/grants.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = readFileSync(join(here, '..', '..', 'db', 'global-template.sql'), 'utf8')

let embedded: EmbeddedPostgres
let dataDir: string
let port: number
let admin: pg.Client
let reader: pg.Pool
let writer: pg.Pool

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'global-grants-'))
  port = await freePort()
  embedded = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port, persistent: false,
  })
  await embedded.initialise()
  await embedded.start()
  await embedded.createDatabase('global')

  const conn = { host: '127.0.0.1', port, user: 'postgres', password: 'postgres' }
  admin = new pg.Client({ ...conn, database: 'global' })
  await admin.connect()
  await admin.query(TEMPLATE)
  await admin.query('REVOKE CONNECT ON DATABASE global FROM PUBLIC')
  await applyScopedGrants(admin, { dbName: 'global', roleName: 'app_global_rw', password: 'rw_pw' })
  await applyReadOnlyGrants(admin, { dbName: 'global', roleName: 'app_global_ro', password: 'ro_pw' })

  reader = new pg.Pool({ ...conn, database: 'global', user: 'app_global_ro', password: 'ro_pw', max: 2 })
  writer = new pg.Pool({ ...conn, database: 'global', user: 'app_global_rw', password: 'rw_pw', max: 2 })
}, 120_000)

afterAll(async () => {
  await reader?.end().catch(() => {})
  await writer?.end().catch(() => {})
  await admin?.end().catch(() => {})
  await embedded?.stop().catch(() => {})
  rmSync(dataDir, { recursive: true, force: true })
})

describe('app_global_ro', () => {
  it('can read the fleet metadata a tenant needs', async () => {
    const res = await reader.query('SELECT schema_version FROM fleet_meta WHERE id = 1')
    expect(res.rows[0].schema_version).toBe(0)
  })

  it('⚠️ cannot INSERT', async () => {
    await expect(reader.query(`INSERT INTO fleet_meta (id) VALUES (1)`)).rejects.toThrow(/permission denied/i)
  })

  it('⚠️ cannot UPDATE — the corruption that would reach every faction', async () => {
    await expect(
      reader.query(`UPDATE fleet_meta SET oc_model_version = 'forged' WHERE id = 1`)
    ).rejects.toThrow(/permission denied/i)
  })

  it('⚠️ cannot DELETE', async () => {
    await expect(reader.query('DELETE FROM fleet_meta')).rejects.toThrow(/permission denied/i)
  })

  it('⚠️ can read a table created AFTER the grants were applied', async () => {
    // The subtle half. Migrations run as the superuser, so without
    // ALTER DEFAULT PRIVILEGES a tenant silently cannot see any table added by
    // a later migration — and the failure surfaces as "permission denied" in
    // production long after the grant script looked like it worked.
    await admin.query('CREATE TABLE later_addition (id int PRIMARY KEY, note text)')
    await admin.query(`INSERT INTO later_addition VALUES (1, 'from a future migration')`)
    const res = await reader.query('SELECT note FROM later_addition WHERE id = 1')
    expect(res.rows[0].note).toBe('from a future migration')
  })

  it('⚠️ still cannot write to a table created after the grants', async () => {
    // The default-privileges grant must extend SELECT and only SELECT. Getting
    // this wrong would hand every future table to every tenant to write.
    await expect(
      reader.query(`INSERT INTO later_addition VALUES (2, 'nope')`)
    ).rejects.toThrow(/permission denied/i)
  })
})

describe('app_global_rw', () => {
  it('is the one role that can write', async () => {
    await writer.query(`UPDATE fleet_meta SET oc_model_version = '2026.09.05', updated_at = now() WHERE id = 1`)
    const res = await reader.query('SELECT oc_model_version FROM fleet_meta WHERE id = 1')
    expect(res.rows[0].oc_model_version).toBe('2026.09.05')
  })
})

describe('fleet_meta', () => {
  it('⚠️ is a singleton by constraint, not by convention', async () => {
    // Two rows would mean two answers to "which model version is the fleet on",
    // and whichever one a query happened to return would look authoritative.
    await expect(writer.query('INSERT INTO fleet_meta (id) VALUES (2)')).rejects.toThrow()
  })
})

describe('applyReadOnlyGrants', () => {
  it('⚠️ refuses to run against the wrong database', async () => {
    // `GRANT ... ON ALL TABLES IN SCHEMA public` applies to the CURRENT
    // database, so pointed at the wrong one every statement succeeds while
    // granting nothing — a silent no-op that leaves a tenant unable to read.
    const other = new pg.Client({
      host: '127.0.0.1', port, user: 'postgres', password: 'postgres', database: 'postgres',
    })
    await other.connect()
    try {
      await expect(
        applyReadOnlyGrants(other, { dbName: 'global', roleName: 'app_global_ro' })
      ).rejects.toThrow(/must run on global/)
    } finally {
      await other.end()
    }
  })

  it('rejects an unsafe identifier rather than interpolating it', async () => {
    await expect(
      applyReadOnlyGrants(admin, { dbName: 'global; DROP DATABASE global', roleName: 'app_global_ro' })
    ).rejects.toThrow(/Unsafe identifier/)
  })

  it('is idempotent — re-applying is free', async () => {
    await applyReadOnlyGrants(admin, { dbName: 'global', roleName: 'app_global_ro' })
    const res = await reader.query('SELECT 1 AS ok')
    expect(res.rows[0].ok).toBe(1)
  })
})
