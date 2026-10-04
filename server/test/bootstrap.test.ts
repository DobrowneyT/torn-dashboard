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
        // The SPA keys us-vs-them logic (war room, payout ordering) off this.
        torn_faction_id: TEST_FACTION.tornFactionId,
        branding: { primaryColor: '#f97316', logo: '/branding/logo.png' },
      },
      features: { warRoom: true },
      // Feedback is configured in the test stack by default (#253).
      feedback_enabled: true,
    })
  })

  it('authenticated callers additionally get their identity and roles', async () => {
    stack.torn.addKey('WARLEADKEY123456', { id: '222', factionId: TEST_FACTION.tornFactionId })
    await stack.db.query(`INSERT INTO role_assignments (torn_user_id, role) VALUES (222, 'warlead')`)
    await stack.db.query(
      `INSERT INTO members (member_id, member_name, is_current) VALUES ('222', 'Warleader', true)
       ON CONFLICT (member_id) DO UPDATE SET member_name = EXCLUDED.member_name`
    )
    const loginRes = await fetch(`${stack.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'WARLEADKEY123456' }),
    })
    const { token } = await loginRes.json() as any

    const { status, body } = await bootstrap(token)
    expect(status).toBe(200)
    expect(body.faction.slug).toBe(TEST_FACTION.slug)
    // member_name comes from the roster; api_key_hint (#264) is this caller's own
    // key's last 4 (WARLEADKEY123456 → 3456), stored at login enrolment.
    //
    // ⚠️ Kept as a STRICT toEqual rather than a toMatchObject. The payload is
    // what the SPA trusts to decide what this member may see, and a field
    // arriving here unnoticed is how that goes wrong — so a new one is meant
    // to fail this test and be added deliberately, as `consent_*` was (#894).
    expect(body.user).toEqual({
      torn_user_id: '222', roles: ['warlead'], member_name: 'Warleader', api_key_hint: '3456',
      // #894 — what this member last accepted, and whether it is behind the
      // current disclosure. `false` here is the important half: shipping the
      // consent mechanism must not prompt anybody who was already up to date.
      consent_version: 'login-v1',
      consent_required: false,
    })
  })

  it('never exposes another member’s key hint (#264 — own key only)', async () => {
    // A member with no pooled key sees a null hint, not someone else's.
    stack.torn.addKey('NOKEYHINT1234567', { id: '223', factionId: '42' })
    await stack.db.query(`INSERT INTO role_assignments (torn_user_id, role) VALUES (223, 'visitor')`)
    const loginRes = await fetch(`${stack.baseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'NOKEYHINT1234567' }),
    })
    const { token } = await loginRes.json() as any
    const { body } = await bootstrap(token)
    expect(body.user.api_key_hint).toBeNull() // visitor: no key on file
  })

  it('a garbage bearer token degrades to the public view, not an error', async () => {
    const { status, body } = await bootstrap('not-a-jwt')
    expect(status).toBe(200)
    expect(body.user).toBeUndefined()
  })
})
