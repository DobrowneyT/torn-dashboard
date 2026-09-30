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
  buildRegistry, normaliseDomain, registerTenantRegistry, TENANT_REGISTRY_SCOPE,
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
async function serve(slugs: string[], token: string | undefined) {
  const app = Fastify({ logger: false })
  registerTenantRegistry(app, fakeDb(slugs), token)
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
