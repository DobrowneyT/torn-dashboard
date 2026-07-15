// Remember-me sessions with a 24h membership re-check (#119).
//
// Sessions are 30-day JWTs, but a token only ACTS for 24h from its last
// verification: protected routes reject older ones, and POST /api/auth/refresh
// exchanges a stale-but-unexpired token for a fresh one after re-checking the
// member server-side (still on the roster, or still holding DB roles). Kicked
// members are denied within 24h; nobody retypes an API key for a month.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SignJWT } from 'jose'
import { startTestStack, TEST_FACTION, TEST_JWT_SECRET, type TestStack } from './harness.js'

let stack: TestStack

const DAY = 24 * 60 * 60

// Forge a session token exactly as the server mints them, but with a chosen
// age — the only way to test the freshness gate without waiting 24 hours.
async function forgeToken(userId: string, { ageSeconds = 0, ttlSeconds = 30 * DAY, roles = [] as string[] } = {}) {
  const iat = Math.floor(Date.now() / 1000) - ageSeconds
  return new SignJWT({
    aud: 'authenticated',
    role: 'authenticated',
    torn_user_id: userId,
    faction_id: TEST_FACTION.tornFactionId,
    is_leadership: roles.includes('leadership'),
    is_admin: roles.includes('admin'),
    is_warlead: roles.includes('warlead'),
    is_ocmanager: roles.includes('ocmanager'),
    is_visitor: roles.includes('visitor'),
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(`torn-${userId}`)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ttlSeconds)
    .sign(new TextEncoder().encode(TEST_JWT_SECRET))
}

async function get(path: string, token: string) {
  const res = await fetch(`${stack.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  return { status: res.status, body: (await res.json()) as any }
}

async function refresh(token?: string) {
  const res = await fetch(`${stack.baseUrl}/api/auth/refresh`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  return { status: res.status, body: (await res.json()) as any }
}

beforeAll(async () => {
  stack = await startTestStack()
  await stack.db.query(
    `INSERT INTO members (member_id, member_name, tier, is_current) VALUES
       ('1800', 'Rememberer', 2, true),
       ('1801', 'Kicked', 2, false)`
  )
}, 30000)

afterAll(async () => {
  await stack?.close()
})

describe('remember-me sessions (#119)', () => {
  it('login mints a ~30-day token', async () => {
    const key = 'REMEMBERKEY18000'
    stack.torn.addKey(key, { id: '1800', factionId: TEST_FACTION.tornFactionId })
    const res = await fetch(`${stack.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: key }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    const now = Math.floor(Date.now() / 1000)
    expect(body.expires_at).toBeGreaterThan(now + 29 * DAY)
  })

  it('protected routes reject a token older than 24h; a fresh one passes', async () => {
    const fresh = await forgeToken('1800')
    expect((await get('/api/war-room/delta', fresh)).status).toBe(200)

    const stale = await forgeToken('1800', { ageSeconds: 25 * 60 * 60 })
    expect((await get('/api/war-room/delta', stale)).status).toBe(401)
  })

  it('refresh exchanges a stale token for a fresh one, re-reading roles from the DB', async () => {
    const stale = await forgeToken('1800', { ageSeconds: 25 * 60 * 60 })
    const first = await refresh(stale)
    expect(first.status).toBe(200)
    expect(first.body.token).toBeTruthy()
    expect(first.body.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000) + 29 * DAY)
    // The refreshed token acts again.
    expect((await get('/api/war-room/delta', first.body.token)).status).toBe(200)

    // A role granted since login lands on the next refresh, not the next login.
    await stack.db.query(
      `INSERT INTO role_assignments (torn_user_id, role) VALUES ('1800', 'warlead')`
    )
    const second = await refresh(first.body.token)
    expect(second.status).toBe(200)
    const boot = await get('/api/bootstrap', second.body.token)
    expect(boot.body.user.roles).toContain('warlead')
  })

  it('denies refresh to a member who was kicked (off-roster, no roles)', async () => {
    const stale = await forgeToken('1801', { ageSeconds: 25 * 60 * 60 })
    const res = await refresh(stale)
    expect(res.status).toBe(403)
    expect(res.body.token).toBeUndefined()
  })

  it('rejects refresh of an expired token and of no token at all', async () => {
    const expired = await forgeToken('1800', { ageSeconds: 31 * DAY, ttlSeconds: 30 * DAY })
    expect((await refresh(expired)).status).toBe(401)
    expect((await refresh()).status).toBe(401)
  })
})
