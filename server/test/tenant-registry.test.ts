// The fleet's tenant list for the Discord bot (#826 follow-up).
//
// ⚠️ The value of this endpoint is that there is ONE list. The tests that
// matter are the ones about what it refuses and what it admits it does not
// know — a registry that guesses a hostname is worse than one that says it
// cannot, because the guess is only discovered as a connection failure
// somewhere else.
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import {
  buildRegistry, chainWatchScope, normaliseDomain, registerTenantRegistry,
  TENANT_REGISTRY_SCOPE, warOverviewScope,
} from '../src/adminPlane/tenantRegistry.js'
import { deriveTenantToken } from '../src/fleetMetricsAuth.js'

const SECRET = 'fleet-secret'
const TOKEN = deriveTenantToken(SECRET, TENANT_REGISTRY_SCOPE)

const fakeDb = (slugs: string[]) => ({
  query: async () => ({ rows: slugs.map((s) => ({ datname: `faction_${s}` })) }),
}) as any

// ⚠️ The token is always passed explicitly. A default parameter here would
// mean `serve(x, undefined)` takes the DEFAULT rather than undefined, so the
// "no token configured" test would silently exercise the configured path and
// pass for the wrong reason. It did, until the assertion caught it.
async function serve(slugs: string[], token: string | undefined, secret?: string) {
  const app = Fastify({ logger: false })
  registerTenantRegistry(app, fakeDb(slugs), token, secret)
  await app.ready()
  return app
}

const saved = process.env.TENANT_BASE_DOMAIN
afterEach(() => {
  if (saved === undefined) delete process.env.TENANT_BASE_DOMAIN
  else process.env.TENANT_BASE_DOMAIN = saved
})

describe('normaliseDomain', () => {
  it('accepts a bare domain', () => {
    expect(normaliseDomain('monchoon.me')).toBe('monchoon.me')
    expect(normaliseDomain('  MonChoon.ME  ')).toBe('monchoon.me')
    expect(normaliseDomain('.monchoon.me.')).toBe('monchoon.me')
  })

  it('refuses anything carrying a scheme or a path', () => {
    // ⚠️ `https://monchoon.me/` would compose into
    // `https://forge.https://monchoon.me/` — wrong rather than obviously
    // broken, which is the kind that gets misdiagnosed as an auth problem.
    for (const bad of ['https://monchoon.me', 'monchoon.me/x', 'http://x.y', '']) {
      expect(normaliseDomain(bad), bad).toBeNull()
    }
  })

  it('refuses a single label, which cannot be a public host', () => {
    expect(normaliseDomain('localhost')).toBeNull()
  })
})

describe('buildRegistry', () => {
  it('derives each public URL from the slug', () => {
    expect(buildRegistry(['forge', 'tnl'], 'monchoon.me')).toEqual([
      { slug: 'forge', base_url: 'https://forge.monchoon.me' },
      { slug: 'tnl', base_url: 'https://tnl.monchoon.me' },
    ])
  })

  it('reports a null URL rather than guessing when no domain is set', () => {
    expect(buildRegistry(['forge'], null)).toEqual([{ slug: 'forge', base_url: null }])
  })
})

describe('the endpoint', () => {
  it('needs the right token', async () => {
    const app = await serve(['forge'], TOKEN)
    for (const h of [{}, { authorization: 'Bearer nope' }, { authorization: TOKEN }]) {
      const res = await app.inject({ method: 'GET', url: '/api/internal/tenants', headers: h as any })
      expect(res.statusCode).toBe(401)
    }
    await app.close()
  })

  it('answers with the fleet when the token is right', async () => {
    process.env.TENANT_BASE_DOMAIN = 'monchoon.me'
    const app = await serve(['ascension', 'forge', 'tnl'], TOKEN)
    const res = await app.inject({
      method: 'GET', url: '/api/internal/tenants',
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.base_url_available).toBe(true)
    expect(body.tenants.map((t: any) => t.slug)).toEqual(['ascension', 'forge', 'tnl'])
    expect(body.tenants[1].base_url).toBe('https://forge.monchoon.me')
    await app.close()
  })

  it('says the domain is missing rather than returning a broken URL', async () => {
    delete process.env.TENANT_BASE_DOMAIN
    const app = await serve(['forge'], TOKEN)
    const body = (await app.inject({
      method: 'GET', url: '/api/internal/tenants',
      headers: { authorization: `Bearer ${TOKEN}` },
    })).json()
    expect(body.base_url_available).toBe(false)
    expect(body.tenants[0].base_url).toBeNull()
    // ⚠️ A list with no URLs is otherwise indistinguishable from a fleet that
    // is up but unreachable, so the cause is said out loud.
    expect(body.note).toMatch(/TENANT_BASE_DOMAIN/)
    await app.close()
  })

  it('is 503, not 401, when no token is configured at all', async () => {
    // ⚠️ "Not configured" and "wrong token" have different fixes. Conflating
    // them sends whoever is debugging to rotate a credential that was fine.
    const app = await serve(['forge'], undefined)
    const res = await app.inject({
      method: 'GET', url: '/api/internal/tenants',
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(res.statusCode).toBe(503)
    await app.close()
  })

  it('uses a scope of its own, so it is not a metrics token', async () => {
    // ⚠️ Knowing which factions exist and reading a faction's metrics are
    // different privileges; one credential must not grant both.
    expect(deriveTenantToken(SECRET, TENANT_REGISTRY_SCOPE))
      .not.toBe(deriveTenantToken(SECRET, 'forge'))
  })
})

// ── The bot's own tokens (#831) ──────────────────────────────────────────────
//
// ⚠️ These are DERIVED, never stored. The whole reason this exists is that
// adding a faction used to require an SSH session to compute a value and paste
// it into a file — so in practice it did not happen, and the bot listed a
// faction it could never poll.
describe('the bot tokens', () => {
  it('uses the same scope strings the tenants were issued with', async () => {
    // ⚠️ THE test that matters. A drifted scope is a 401 with no hint as to
    // which side is wrong, so the copy in tenantRegistry.ts is held against the
    // modules the CLI issues from.
    const { chainWatchScope: dbChain } = await import('../../db/chainWatchTokenLib.mjs')
    const { warOverviewScope: dbWar } = await import('../../db/warOverviewTokenLib.mjs')
    for (const slug of ['forge', 'tnl', 'a-b-c']) {
      expect(chainWatchScope(slug)).toBe(dbChain(slug))
      expect(warOverviewScope(slug)).toBe(dbWar(slug))
    }
  })

  it('reproduces exactly what the CLI would have written into the override', async () => {
    // ⚠️ End to end against the real deriver: if this drifts, every tenant
    // 401s the bot and the only symptom is a board that never draws.
    const { createHmac } = await import('node:crypto')
    const expected = createHmac('sha256', SECRET).update('chain-watch:forge').digest('hex')
    const [forge] = buildRegistry(['forge'], 'monchoon.me', SECRET)
    expect(forge.chain_watch_token).toBe(expected)
  })

  it('gives the two features different tokens', () => {
    // ⚠️ Scoped apart on purpose: one credential should not unlock the other
    // feature's data.
    const [t] = buildRegistry(['forge'], null, SECRET)
    expect(t.chain_watch_token).not.toBe(t.war_overview_token)
  })

  it('carries no tokens unless they are asked for', async () => {
    process.env.TENANT_BASE_DOMAIN = 'monchoon.me'
    const app = await serve(['forge'], TOKEN)
    const body = (await app.inject({
      method: 'GET', url: '/api/internal/tenants',
      headers: { authorization: `Bearer ${TOKEN}` },
    })).json()
    // ⚠️ The default answer must not hand credentials to a consumer that only
    // wanted to know which factions exist.
    expect(body.tenants[0].chain_watch_token).toBeUndefined()
    expect(body.tokens_available).toBeUndefined()
    await app.close()
  })

  it('hands them over when asked, with the secret configured', async () => {
    const app = await serve(['forge'], TOKEN, SECRET)
    const body = (await app.inject({
      method: 'GET', url: '/api/internal/tenants?tokens=1',
      headers: { authorization: `Bearer ${TOKEN}` },
    })).json()
    expect(body.tokens_available).toBe(true)
    expect(body.tenants[0].chain_watch_token).toMatch(/^[0-9a-f]{64}$/)
    expect(body.tenants[0].war_overview_token).toMatch(/^[0-9a-f]{64}$/)
    await app.close()
  })

  it('says so when asked for tokens it cannot mint', async () => {
    // ⚠️ "Asked and got none" is a configuration fault. A consumer that could
    // not tell it from "this faction has no token" would hunt the wrong half.
    const app = await serve(['forge'], TOKEN, undefined)
    const body = (await app.inject({
      method: 'GET', url: '/api/internal/tenants?tokens=1',
      headers: { authorization: `Bearer ${TOKEN}` },
    })).json()
    expect(body.tokens_available).toBe(false)
    expect(body.tenants[0].chain_watch_token).toBeUndefined()
    await app.close()
  })

  it('still needs the registry token to get any of it', async () => {
    const app = await serve(['forge'], TOKEN, SECRET)
    const res = await app.inject({
      method: 'GET', url: '/api/internal/tenants?tokens=1',
      headers: { authorization: 'Bearer wrong' },
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })
})
