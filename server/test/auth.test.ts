// Auth tracer (slice #60): Torn-key login → API-signed JWT, at the black-box
// HTTP seam. The only fake is the Torn fixture server.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { jwtVerify } from 'jose'
import { startTestStack, TEST_FACTION, TEST_JWT_SECRET, type TestStack } from './harness.js'

let stack: TestStack

beforeAll(async () => {
  stack = await startTestStack(55443)
})

afterAll(async () => {
  await stack?.close()
})

async function login(apiKey: string) {
  const res = await fetch(`${stack.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey }),
  })
  return { status: res.status, body: await res.json() }
}

async function verifyToken(token: string) {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(TEST_JWT_SECRET))
  return payload
}

describe('POST /api/auth/login', () => {
  it('faction member with DB-assigned roles gets a 4h JWT with matching claims', async () => {
    stack.torn.addKey('LEADERKEY1234567', { id: '111', name: 'Boss', factionId: TEST_FACTION.tornFactionId })
    await stack.db.query(
      `INSERT INTO role_assignments (torn_user_id, role) VALUES (111, 'leadership'), (111, 'admin')`
    )

    const { status, body } = await login('LEADERKEY1234567')
    expect(status).toBe(200)

    const claims = await verifyToken(body.token)
    expect(claims.sub).toBe('torn-111')
    expect(claims.torn_user_id).toBe('111')
    expect(claims.faction_id).toBe(TEST_FACTION.tornFactionId)
    expect(claims.is_leadership).toBe(true)
    expect(claims.is_admin).toBe(true)
    expect(claims.is_warlead).toBe(false)
    expect(claims.is_ocmanager).toBe(false)
    expect(claims.is_visitor).toBe(false)
    // 4-hour lifetime, per the established session-token contract
    expect(claims.exp! - claims.iat!).toBe(4 * 60 * 60)
    expect(body.expires_at).toBe(claims.exp)
  })

  it('rejects an incorrect key with the Torn error surfaced', async () => {
    stack.torn.addBadKey('BADBADBADBADBAD1', 2, 'Incorrect key')
    const { status, body } = await login('BADBADBADBADBAD1')
    expect(status).toBe(401)
    expect(body.error).toContain('Incorrect key')
  })

  it('rejects a stranger — valid key, wrong faction, no assigned roles', async () => {
    stack.torn.addKey('STRANGERKEY12345', { id: '999', factionId: '42' })
    const { status, body } = await login('STRANGERKEY12345')
    expect(status).toBe(403)
    expect(body.error).toBe('Not a faction member')
  })

  it('visitor logs in without faction membership and no key material is stored', async () => {
    stack.torn.addKey('VISITORKEY123456', { id: '555', name: 'Dooby', factionId: '42' })
    await stack.db.query(`INSERT INTO role_assignments (torn_user_id, role) VALUES (555, 'visitor')`)

    const { status, body } = await login('VISITORKEY123456')
    expect(status).toBe(200)
    const claims = await verifyToken(body.token)
    expect(claims.is_visitor).toBe(true)
    expect(claims.is_leadership).toBe(false)

    // Visitor keys must never join the pool, and no table may hold the raw key.
    const secrets = await stack.db.query('SELECT count(*)::int AS n FROM member_secrets')
    expect(secrets.rows[0].n).toBe(0)
    const rawInCache = await stack.db.query(
      'SELECT count(*)::int AS n FROM war_room_auth_cache WHERE key_hash = $1 OR user_id = $1',
      ['VISITORKEY123456']
    )
    expect(rawInCache.rows[0].n).toBe(0)
  })

  it('second login with the same key is served from the 24h cache, not Torn', async () => {
    stack.torn.addKey('CACHEDKEY1234567', { id: '777', factionId: TEST_FACTION.tornFactionId })
    await login('CACHEDKEY1234567')
    const hitsAfterFirst = stack.torn.hits()
    const { status } = await login('CACHEDKEY1234567')
    expect(status).toBe(200)
    expect(stack.torn.hits()).toBe(hitsAfterFirst)
  })

  it('rejects a missing apiKey with 400', async () => {
    const res = await fetch(`${stack.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })
})
