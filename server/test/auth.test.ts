// Auth tracer (slice #60): Torn-key login → API-signed JWT, at the black-box
// HTTP seam. The only fake is the Torn fixture server.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { jwtVerify } from 'jose'
import { startTestStack, TEST_FACTION, TEST_JWT_SECRET, type TestStack } from './harness.js'

let stack: TestStack

beforeAll(async () => {
  stack = await startTestStack()
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
  return { status: res.status, body: await res.json() as any }
}

async function verifyToken(token: string) {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(TEST_JWT_SECRET))
  return payload
}

describe('POST /api/auth/login', () => {
  it('faction member with DB-assigned roles gets a 4h JWT with matching claims', async () => {
    stack.torn.addKey('LEADERKEY1234567', { id: '111', factionId: TEST_FACTION.tornFactionId })
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
    // 30-day remember-me lifetime (#119); the 24h freshness gate + refresh
    // endpoint carry the revocation guarantees (see session-refresh.test.ts).
    expect(claims.exp! - claims.iat!).toBe(30 * 24 * 60 * 60)
    expect(body.expires_at).toBe(claims.exp)
  })

  it('rejects an incorrect key with the Torn error surfaced', async () => {
    stack.torn.addBadKey('BADBADBADBADBAD1', 2, 'Incorrect key')
    const { status, body } = await login('BADBADBADBADBAD1')
    expect(status).toBe(401)
    expect(body.error).toContain('Incorrect key')
  })

  it('surfaces a transient Torn outage as 503, not an auth failure', async () => {
    // Code 9: "API disabled" — the established transient set (5/8/9/17).
    stack.torn.addBadKey('DOWNDOWNDOWNDOW1', 9, 'API disabled')
    const { status, body } = await login('DOWNDOWNDOWNDOW1')
    expect(status).toBe(503)
    expect(body.error).toContain('temporarily')
  })

  it('rejects a key below Limited Access with guidance', async () => {
    stack.torn.addKey('PUBLICKEY1234567', { id: '112', factionId: TEST_FACTION.tornFactionId, accessLevel: 1 })
    const { status, body } = await login('PUBLICKEY1234567')
    expect(status).toBe(403)
    expect(body.error).toContain('Limited Access')
  })

  it('lets a member without faction API access log in, enrolling their key unpooled (#271)', async () => {
    // Faction API access is leader-granted (a recruit in their first 72h can't
    // have it), so we must NOT bar login. The key is enrolled with
    // has_faction_access = false so it shows in the pool health view, but the
    // pool never claims it for faction calls (that filter lives in keyPool).
    await stack.db.query(
      `INSERT INTO members (member_id, member_name, tier, is_current) VALUES ('880', 'Recruit', 3, true)`
    )
    stack.torn.addKey('NOFACTIONKEY8801', { id: '880', factionId: TEST_FACTION.tornFactionId, factionAccess: false })
    const { status, body } = await login('NOFACTIONKEY8801')
    expect(status).toBe(200)
    expect(body.token).toBeTruthy()

    // Enrolled, but flagged as lacking faction access (so it's excluded from the
    // pool rotation and surfaced with a yellow badge in Key Pool Health).
    const row = await stack.db.query(
      `SELECT has_faction_access FROM member_secrets WHERE member_id = '880'`
    )
    expect(row.rows).toHaveLength(1)
    expect(row.rows[0].has_faction_access).toBe(false)
  })

  it('rejects a stranger — valid key, wrong faction, no assigned roles', async () => {
    stack.torn.addKey('STRANGERKEY12345', { id: '999', factionId: '42' })
    const { status, body } = await login('STRANGERKEY12345')
    expect(status).toBe(403)
    expect(body.error).toBe('Not a faction member')
  })

  it('visitor logs in without faction membership and no key material is stored', async () => {
    stack.torn.addKey('VISITORKEY123456', { id: '555', factionId: '42' })
    await stack.db.query(`INSERT INTO role_assignments (torn_user_id, role) VALUES (555, 'visitor')`)

    const { status, body } = await login('VISITORKEY123456')
    expect(status).toBe(200)
    const claims = await verifyToken(body.token)
    expect(claims.is_visitor).toBe(true)
    expect(claims.is_leadership).toBe(false)

    // Visitor logins persist NO key material — not the raw key, and not even
    // a key-derived cache row. (Scoped to the visitor: faction members'
    // logins in this file legitimately enroll their keys.)
    const secrets = await stack.db.query(
      `SELECT count(*)::int AS n FROM member_secrets WHERE member_id = '555'`
    )
    expect(secrets.rows[0].n).toBe(0)
    const cacheRows = await stack.db.query(
      `SELECT count(*)::int AS n FROM war_room_auth_cache WHERE user_id = '555' OR key_hash = 'VISITORKEY123456'`
    )
    expect(cacheRows.rows[0].n).toBe(0)
  })

  it('second login with the same key is served from the 24h cache, not Torn', async () => {
    stack.torn.addKey('CACHEDKEY1234567', { id: '777', factionId: TEST_FACTION.tornFactionId })
    await login('CACHEDKEY1234567')
    const hitsAfterFirst = stack.torn.hits()
    const { status } = await login('CACHEDKEY1234567')
    expect(status).toBe(200)
    expect(stack.torn.hits()).toBe(hitsAfterFirst)
  })

  it('rejects a foreign JWT signed with the same secret but a different audience', async () => {
    const { SignJWT } = await import('jose')
    const foreign = await new SignJWT({ aud: 'something-else', torn_user_id: '111' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(TEST_JWT_SECRET))
    const res = await fetch(`${stack.baseUrl}/api/members`, {
      headers: { authorization: `Bearer ${foreign}` },
    })
    expect(res.status).toBe(401)
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

describe('key-pool enrollment on login', () => {
  it('a faction member’s login key joins the consented pool, encrypted at rest', async () => {
    // The login disclosure covers pool consent; enrollment needs the member
    // row (roster) to exist for the FK.
    await stack.db.query(
      `INSERT INTO members (member_id, member_name, tier, is_current) VALUES ('222', 'Pooler', 3, true)`
    )
    stack.torn.addKey('POOLERKEY2222222', { id: '222', factionId: TEST_FACTION.tornFactionId })

    const { status } = await login('POOLERKEY2222222')
    expect(status).toBe(200)

    const row = await stack.db.query(
      `SELECT cpr_api_key, key_level, has_faction_access, consent_at, consent_version, disabled
       FROM member_secrets WHERE member_id = '222'`
    )
    expect(row.rows).toHaveLength(1)
    expect(row.rows[0].disabled).toBe(false)
    expect(row.rows[0].has_faction_access).toBe(true)
    expect(row.rows[0].consent_at).toBeTruthy()
    expect(row.rows[0].consent_version).toBe('login-v1')
    // Never the plaintext key at rest.
    expect((row.rows[0].cpr_api_key as Buffer).toString('utf8')).not.toContain('POOLERKEY2222222')
  })

  it('visitor logins never enroll a key (no key material persists at all)', async () => {
    stack.torn.addKey('VISITKEY33333333', { id: '333', factionId: null })
    await stack.db.query(`INSERT INTO role_assignments (torn_user_id, role) VALUES (333, 'visitor')`)

    const { status } = await login('VISITKEY33333333')
    expect(status).toBe(200)

    const row = await stack.db.query(`SELECT 1 FROM member_secrets WHERE member_id = '333'`)
    expect(row.rows).toHaveLength(0)
  })

  it('a cache-served login still enrolls (logins predating enrollment left a 24h cache row)', async () => {
    // Production scenario: the member logged in before enrollment existed, so
    // the server holds a valid auth-cache row but member_secrets is empty.
    // The cached login path never reaches Torn (the key is not in the fixture)
    // and must decide membership from the roster instead.
    const { createHash } = await import('node:crypto')
    await stack.db.query(
      `INSERT INTO members (member_id, member_name, tier, is_current) VALUES ('556', 'Cached', 3, true)`
    )
    await stack.db.query(
      `INSERT INTO war_room_auth_cache (key_hash, user_id, expires_at)
       VALUES ($1, '556', now() + interval '1 hour')`,
      [createHash('sha256').update('CACHEONLY5555555').digest('hex')]
    )

    const { status } = await login('CACHEONLY5555555')
    expect(status).toBe(200)

    const row = await stack.db.query(
      `SELECT consent_version FROM member_secrets WHERE member_id = '556'`
    )
    expect(row.rows).toHaveLength(1)
    expect(row.rows[0].consent_version).toBe('login-v1')
  })

  it('a member missing from the roster gets a stub row and still enrolls — fresh-faction bootstrap', async () => {
    // A brand-new faction has an empty roster and an empty key pool, and the
    // members-sync scraper needs a pooled key to fill the roster. The leader's
    // first login breaks that cycle: stub roster row, then enrollment.
    stack.torn.addKey('GHOSTKEY44444444', { id: '444', factionId: TEST_FACTION.tornFactionId })
    stack.torn.setPath('/v2/user/basic', { basic: { id: 444, name: 'Phoenix' } })
    const { status } = await login('GHOSTKEY44444444')
    expect(status).toBe(200)

    const secret = await stack.db.query(
      `SELECT consent_version FROM member_secrets WHERE member_id = '444'`
    )
    expect(secret.rows).toHaveLength(1)
    expect(secret.rows[0].consent_version).toBe('login-v1')

    // The stub is a real roster row with the member's real Torn name (fetched
    // with their own in-flight login key); members-sync refreshes it later.
    const stub = await stack.db.query(
      `SELECT member_name, is_current FROM members WHERE member_id = '444'`
    )
    expect(stub.rows[0].is_current).toBe(true)
    expect(stub.rows[0].member_name).toBe('Phoenix')

    // Out-of-faction logins (visitor already covered above) never get stubs.
    const strangers = await stack.db.query(
      `SELECT count(*)::int AS n FROM members WHERE member_id IN ('333', '555')`
    )
    expect(strangers.rows[0].n).toBe(0)
  })
})
