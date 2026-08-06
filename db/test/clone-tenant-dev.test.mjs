// Dev-clone helpers (#292) — the pure, deterministic pieces of the staging
// clone: dev/live database naming, the drop guard that keeps a live tenant DB
// out of reach, and the discovery filters that keep the prod and dev cron
// loops off each other's databases. The pg_dump | psql shell-out in
// db/clone-tenant-dev.mjs is exercised by the compose E2E against a real
// postgres:17 (embedded-postgres ships no pg_dump), not here.
import { describe, it, expect } from 'vitest'
import {
  devDbName,
  isDevDb,
  liveDbForDev,
  assertDevTarget,
  devDbsFromRows,
  devDatabaseUrl,
  DISABLE_SCRAPERS_SQL,
} from '../cloneDevLib.mjs'
import { factionDbsFromRows } from '../backupLib.mjs'

describe('devDbName / liveDbForDev', () => {
  it('maps a slug to its dev database and back', () => {
    expect(devDbName('forge')).toBe('faction_forge_dev')
    expect(liveDbForDev('faction_forge_dev')).toBe('faction_forge')
  })

  it('rejects a slug that is not a safe identifier', () => {
    // The name is interpolated into DROP/CREATE DATABASE, which takes no
    // parameters — so validation here is the injection boundary.
    for (const bad of ['forge; DROP DATABASE faction_tnl', 'Forge', 'forge-dev', '', '1forge']) {
      expect(() => devDbName(bad)).toThrow(/slug/i)
    }
  })

  it('returns null for a name that is not a dev database', () => {
    expect(liveDbForDev('faction_forge')).toBeNull()
    expect(liveDbForDev('postgres')).toBeNull()
  })
})

describe('isDevDb', () => {
  it('recognises only faction_<slug>_dev names', () => {
    expect(isDevDb('faction_forge_dev')).toBe(true)
    expect(isDevDb('faction_tnl_dev')).toBe(true)
    expect(isDevDb('faction_forge')).toBe(false)
    expect(isDevDb('faction_dev')).toBe(false) // no slug
    expect(isDevDb('postgres')).toBe(false)
  })
})

describe('assertDevTarget — the drop guard', () => {
  it('accepts a dev database', () => {
    expect(() => assertDevTarget('faction_forge_dev')).not.toThrow()
  })

  it('refuses to let a live tenant database be a clone target', () => {
    // This is the guard standing between `--tenant forge` and dropping the
    // live faction_forge. It must fail closed for anything not *_dev.
    for (const live of ['faction_forge', 'faction_tnl', 'postgres', 'template1']) {
      expect(() => assertDevTarget(live)).toThrow(/refus/i)
    }
  })
})

describe('discovery filters keep the prod and dev loops apart', () => {
  const rows = [
    { datname: 'postgres' },
    { datname: 'faction_forge' },
    { datname: 'faction_forge_dev' },
    { datname: 'faction_tnl' },
  ]

  it('devDbsFromRows selects only the dev copies', () => {
    expect(devDbsFromRows(rows)).toEqual([{ db: 'faction_forge_dev', slug: 'forge' }])
  })

  it('factionDbsFromRows excludes dev copies so prod backup/migrate skip them', () => {
    // deploy/update.sh migrates and db/backup.mjs dumps whatever this returns.
    // A dev copy leaking in means the prod cron writes to staging databases.
    expect(factionDbsFromRows(rows)).toEqual([
      { db: 'faction_forge', slug: 'forge' },
      { db: 'faction_tnl', slug: 'tnl' },
    ])
  })
})

describe('devDatabaseUrl', () => {
  it('points the dev API at the dev copy as the tenant scoped role', () => {
    expect(devDatabaseUrl({ slug: 'forge', password: 's3cr3t' }))
      .toBe('postgres://app_forge:s3cr3t@postgres:5432/faction_forge_dev')
  })

  it('percent-encodes a password so odd characters cannot break the URL', () => {
    expect(devDatabaseUrl({ slug: 'forge', password: 'p@ss:w/rd' }))
      .toBe('postgres://app_forge:p%40ss%3Aw%2Frd@postgres:5432/faction_forge_dev')
  })
})

describe('DISABLE_SCRAPERS_SQL', () => {
  it('turns every scraper off in the clone', () => {
    // Scrapers-off-by-default is the safety property: a fresh clone must never
    // start hitting Torn (or writing) until the operator opts in per job.
    expect(DISABLE_SCRAPERS_SQL).toMatch(/UPDATE\s+scraper_jobs\s+SET\s+enabled\s*=\s*false/i)
    expect(DISABLE_SCRAPERS_SQL).not.toMatch(/WHERE/i)
  })
})
