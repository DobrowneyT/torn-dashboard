// #609 slice 3 — fleet status collection and the status page.
//
// The theme: a status page must be at its most reliable exactly when the fleet
// is not. Every check here degrades to a reported failure rather than an
// exception, because a page that 500s because one container is unhealthy is a
// page that breaks at the only moment it matters.
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildAdminApp } from '../src/adminPlane/app.js'
import { hashPassword } from '../src/adminPlane/password.js'
import { generateTotpSecret } from '../src/adminPlane/totp.js'
import { mintAdminSession } from '../src/adminPlane/session.js'
import {
  slugFromDbName, discoverTenants, checkTenant, checkBackups, collectFleetStatus,
} from '../src/adminPlane/statusCollector.js'
import { statusPageHtml } from '../src/adminPlane/statusPage.js'

const SECRET = 'admin-session-secret'
const TOTP = generateTotpSecret()

const fakeDb = (rows: unknown[], meta: unknown[] = [{ schema_version: 1, oc_model_version: null, items_synced_at: null }]) => ({
  query: async (sql: string) => (sql.includes('pg_database') ? { rows } : { rows: meta }),
}) as any

const brokenDb = () => ({ query: async () => { throw new Error('ECONNREFUSED') } }) as any

const okTenant = (body: Record<string, unknown> = {}) =>
  (async () => new Response(JSON.stringify({
    status: 'ok', db: 'up', scheduler: 'armed', ticker: 'armed', global: 'not_configured', ...body,
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch

describe('slugFromDbName', () => {
  it('extracts a faction slug', () => {
    expect(slugFromDbName('faction_tnl')).toBe('tnl')
  })

  it('⚠️ excludes the dev stack', () => {
    // `_dev` databases belong to a separate compose project with its own
    // containers. Including them would report five phantom tenants as down —
    // permanent false alarms, which is how a monitor gets ignored.
    expect(slugFromDbName('faction_tnl_dev')).toBeNull()
  })

  it('ignores anything that is not a faction database', () => {
    expect(slugFromDbName('global')).toBeNull()
    expect(slugFromDbName('postgres')).toBeNull()
  })
})

describe('discoverTenants', () => {
  it('⚠️ reads the tenant list from the cluster, not from config', () => {
    // pg_database is a shared catalog the writer role can read, so the list is
    // never stale — a config file would drift the moment a faction was added.
    // The same role cannot CONNECT to a faction database, verified live.
    return expect(discoverTenants(fakeDb([
      { datname: 'faction_tnl' }, { datname: 'faction_forge' }, { datname: 'faction_tnl_dev' },
    ]))).resolves.toEqual(['tnl', 'forge'])
  })
})

describe('checkTenant', () => {
  it('reports a healthy tenant', async () => {
    const s = await checkTenant('tnl', okTenant())
    expect(s).toMatchObject({ slug: 'tnl', state: 'ok', db: 'up', scheduler: 'armed' })
    expect(s.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('⚠️ calls an unreachable tenant down, rather than throwing', async () => {
    const s = await checkTenant('gone', (async () => { throw new Error('ENOTFOUND') }) as any)
    expect(s.state).toBe('down')
    expect(s.error).toContain('ENOTFOUND')
  })

  it('⚠️ distinguishes degraded from down', async () => {
    // A process answering 503 is a different problem from a container that is
    // gone, and they need different responses. Collapsing them loses that.
    const fetchImpl = (async () => new Response(JSON.stringify({ status: 'degraded', db: 'down' }), {
      status: 503, headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
    expect((await checkTenant('sick', fetchImpl)).state).toBe('degraded')
  })

  it('⚠️ does NOT treat an unavailable control plane as a tenant fault', async () => {
    // Tenants are designed to work with the control plane down. Marking that
    // degraded would make this page report the fleet as unhealthy whenever the
    // box rendering the page is the thing that is broken.
    const s = await checkTenant('tnl', okTenant({ global: 'unavailable' }))
    expect(s.state).toBe('ok')
    expect(s.global).toBe('unavailable')
  })

  it('times out rather than hanging the whole report', async () => {
    const never = (async (_u: string, init?: RequestInit) => new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener('abort', () => {
        const e = new Error('aborted'); e.name = 'AbortError'; rej(e)
      })
    })) as unknown as typeof fetch
    const s = await checkTenant('slow', never, 30)
    expect(s.state).toBe('down')
    expect(s.error).toContain('no response')
  })
})

describe('checkBackups', () => {
  const dirWith = (files: Array<[string, number]>) => {
    const dir = mkdtempSync(join(tmpdir(), 'backups-'))
    for (const [name, ageHours] of files) {
      const p = join(dir, name)
      writeFileSync(p, 'x')
      const when = new Date(Date.now() - ageHours * 3_600_000)
      utimesSync(p, when, when)
    }
    return dir
  }

  it('reports the newest dump age', async () => {
    const dir = dirWith([
      ['faction_tnl_20260905T010000Z.sql.gz', 30],
      ['faction_forge_20260905T020000Z.sql.gz', 5],
    ])
    const b = await checkBackups(dir, ['tnl', 'forge'])
    expect(b.count).toBe(2)
    expect(b.newestAgeHours).toBeGreaterThan(4)
    expect(b.newestAgeHours).toBeLessThan(6)
    expect(b.missing).toEqual([])
  })

  it('⚠️ names a faction with NO dump at all', async () => {
    // The failure that hides: a check looking only at files present reports a
    // never-backed-up faction as perfectly healthy, because its absence is
    // invisible. Computed against the known tenant list instead.
    const dir = dirWith([['faction_tnl_20260905T010000Z.sql.gz', 2]])
    expect((await checkBackups(dir, ['tnl', 'forge', 'mayhem'])).missing).toEqual(['forge', 'mayhem'])
  })

  it('reports an unreadable directory instead of throwing', async () => {
    const b = await checkBackups('/nonexistent-backup-dir', ['tnl'])
    expect(b.error).toBeTruthy()
    expect(b.newestAgeHours).toBeNull()
  })

  it('distinguishes "no dumps yet" from "dumps are old"', async () => {
    // null means nothing has ever run; a number means it ran and stopped.
    expect((await checkBackups(dirWith([]), ['tnl'])).newestAgeHours).toBeNull()
  })
})

describe('collectFleetStatus', () => {
  it('assembles a full report', async () => {
    const s = await collectFleetStatus({
      db: fakeDb([{ datname: 'faction_tnl' }, { datname: 'faction_forge' }]),
      backupDir: '/nonexistent',
      fetchImpl: okTenant(),
    })
    expect(s.postgres.state).toBe('ok')
    expect(s.tenants.map((t) => t.slug)).toEqual(['tnl', 'forge'])
    expect(s.tenants.every((t) => t.state === 'ok')).toBe(true)
    expect(s.global).toMatchObject({ schemaVersion: 1 })
  })

  it('⚠️ still reports when Postgres itself is down', async () => {
    // "The control plane's own database is down" is the headline finding, not a
    // reason to return nothing. Aborting here would leave the operator with a
    // blank page during the incident they most need to see.
    const s = await collectFleetStatus({ db: brokenDb(), backupDir: '/nonexistent' })
    expect(s.postgres.state).toBe('down')
    expect(s.postgres.error).toContain('ECONNREFUSED')
    expect(s.generatedAt).toBeTruthy()
  })

  it('⚠️ one dead tenant does not hide the healthy ones', async () => {
    let call = 0
    const flaky = (async () => {
      call += 1
      if (call === 1) throw new Error('ECONNREFUSED')
      return new Response(JSON.stringify({ status: 'ok', db: 'up' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const s = await collectFleetStatus({
      db: fakeDb([{ datname: 'faction_a' }, { datname: 'faction_b' }]),
      backupDir: '/nonexistent', fetchImpl: flaky,
    })
    expect(s.tenants.filter((t) => t.state === 'down')).toHaveLength(1)
    expect(s.tenants.filter((t) => t.state === 'ok')).toHaveLength(1)
  })
})

describe('the status routes', () => {
  const build = async (surface: 'public' | 'local' = 'public') => buildAdminApp({
    surface, username: 'u', passwordHash: await hashPassword('a-long-test-password'),
    totpSecret: TOTP, sessionSecret: SECRET, version: '9.9.9',
    collector: { db: fakeDb([{ datname: 'faction_tnl' }]), backupDir: '/nonexistent', fetchImpl: okTenant() },
  })

  it('⚠️ requires authentication', async () => {
    // The page is public because it holds no data; the DATA is not.
    const a = await build()
    expect((await a.inject({ method: 'GET', url: '/api/admin/status' })).statusCode).toBe(401)
    await a.close()
  })

  it('returns the report to an authenticated operator', async () => {
    const a = await build()
    const token = await mintAdminSession(SECRET, 'u', 'public')
    const res = await a.inject({
      method: 'GET', url: '/api/admin/status', headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().tenants[0]).toMatchObject({ slug: 'tnl', state: 'ok' })
    await a.close()
  })

  it('serves the page unauthenticated, because it contains no data', async () => {
    const a = await build()
    const res = await a.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    await a.close()
  })

  it('⚠️ does not serve the page on the local surface', async () => {
    // The tunnel-only surface is an API for destructive operations. Serving a
    // second copy of the console there would invite doing routine work through
    // the one door that has no second factor in front of it.
    const a = await build('local')
    expect((await a.inject({ method: 'GET', url: '/' })).statusCode).toBe(404)
    await a.close()
  })
})

describe('statusPageHtml', () => {
  it('embeds the version and asks not to be indexed', () => {
    const html = statusPageHtml('1.2.3')
    expect(html).toContain('1.2.3')
    expect(html).toContain('noindex')
  })

  it('⚠️ contains no credentials or fleet data', () => {
    // It is served unauthenticated, so anything baked into it is public.
    const html = statusPageHtml('1.2.3')
    expect(html).not.toMatch(/password\s*[:=]\s*["'][^"']/i)
    expect(html).not.toContain('faction_')
  })

  it('escapes interpolated values into the DOM', () => {
    // Tenant slugs and error strings come from the fleet, not from a person,
    // but they still reach innerHTML — so the page carries its own escaper.
    expect(statusPageHtml('1.0.0')).toContain('&amp;')
  })
})
