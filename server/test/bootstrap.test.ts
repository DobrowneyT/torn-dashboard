// /api/bootstrap: the SPA's first call. Public identity for everyone; the
// caller's roles only with a valid session token.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'

let stack: TestStack

beforeAll(async () => {
  stack = await startTestStack()
  await stack.db.query(
    `UPDATE faction_config
     SET branding = '{"primaryColor": "#f97316", "logo": "/branding/logo.png"}'::jsonb,
         features = '{"warRoom": true}'::jsonb`
  )
})

afterAll(async () => {
  await stack?.close()
})

async function bootstrap(token?: string) {
  const res = await fetch(`${stack.baseUrl}/api/bootstrap`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  return { status: res.status, body: await res.json() as any }
}

describe('GET /api/bootstrap', () => {
  it('unauthenticated callers get only the public faction identity', async () => {
    const { status, body } = await bootstrap()
    expect(status).toBe(200)
    expect(body).toEqual({
      faction: {
        slug: TEST_FACTION.slug,
        display_name: TEST_FACTION.displayName,
        branding: { primaryColor: '#f97316', logo: '/branding/logo.png' },
      },
      features: { warRoom: true },
    })
  })

  it('authenticated callers additionally get their identity and roles', async () => {
    stack.torn.addKey('WARLEADKEY123456', { id: '222', factionId: TEST_FACTION.tornFactionId })
    await stack.db.query(`INSERT INTO role_assignments (torn_user_id, role) VALUES (222, 'warlead')`)
    const loginRes = await fetch(`${stack.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'WARLEADKEY123456' }),
    })
    const { token } = await loginRes.json() as any

    const { status, body } = await bootstrap(token)
    expect(status).toBe(200)
    expect(body.faction.slug).toBe(TEST_FACTION.slug)
    expect(body.user).toEqual({ torn_user_id: '222', roles: ['warlead'] })
  })

  it('a garbage bearer token degrades to the public view, not an error', async () => {
    const { status, body } = await bootstrap('not-a-jwt')
    expect(status).toBe(200)
    expect(body.user).toBeUndefined()
  })
})
