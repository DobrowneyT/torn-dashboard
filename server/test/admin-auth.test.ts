// #609 slice 2 — the admin control plane's security boundary.
//
// This is the one surface in the stack whose compromise reaches every tenant,
// so the tests here are about what must be IMPOSSIBLE rather than what should
// work: a tenant token must not authenticate, a local-only route must not exist
// on the public listener, and a wrong username must not be distinguishable from
// a wrong password.
import { describe, expect, it } from 'vitest'
import { SignJWT } from 'jose'
import { buildAdminApp } from '../src/adminPlane/app.js'
import { hashPassword, verifyPassword, looksHashed } from '../src/adminPlane/password.js'
import { generateTotpSecret, totpCode, verifyTotp, base32Decode, base32Encode, TOTP_STEP_SECONDS } from '../src/adminPlane/totp.js'
import { mintAdminSession, verifyAdminSession, ADMIN_AUDIENCE } from '../src/adminPlane/session.js'
import { LoginLimiter } from '../src/adminPlane/lockout.js'

const USERNAME = 'monchoon'
const PASSWORD = 'a-very-long-operator-password'
const SESSION_SECRET = 'admin-session-secret-not-the-tenant-one'
const TENANT_JWT_SECRET = 'tenant-jwt-secret'

let cachedHash: string | null = null
async function hash(): Promise<string> {
  // scrypt at these parameters is ~100ms by design; hashing once keeps the
  // suite quick without weakening what is under test.
  cachedHash ??= await hashPassword(PASSWORD)
  return cachedHash
}

const TOTP = generateTotpSecret()
const code = () => totpCode(TOTP, Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS))

async function app(surface: 'public' | 'local' = 'public', limiter?: LoginLimiter) {
  return buildAdminApp({
    surface, username: USERNAME, passwordHash: await hash(),
    totpSecret: TOTP, sessionSecret: SESSION_SECRET, limiter,
  })
}

const login = (a: Awaited<ReturnType<typeof app>>, body: Record<string, unknown>) =>
  a.inject({ method: 'POST', url: '/api/admin/login', payload: body })

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const stored = await hash()
    expect(await verifyPassword(PASSWORD, stored)).toBe(true)
    expect(await verifyPassword(PASSWORD + 'x', stored)).toBe(false)
  })

  it('⚠️ produces a different hash every time, so equal passwords are not linkable', async () => {
    expect(await hashPassword(PASSWORD)).not.toBe(await hashPassword(PASSWORD))
  })

  it('carries its parameters, so raising the work factor does not invalidate old hashes', async () => {
    const stored = await hash()
    const [scheme, n, r, p] = stored.split('$')
    expect(scheme).toBe('scrypt')
    expect(Number(n)).toBeGreaterThanOrEqual(1 << 16)
    expect([Number(r), Number(p)]).toEqual([8, 1])
  })

  it('⚠️ returns false rather than throwing on a malformed stored hash', async () => {
    // A mis-set environment variable must be a refusal, not a 500 — and the
    // difference must not be observable through error handling.
    for (const bad of ['', 'plaintext', 'scrypt$x', 'scrypt$1$2$3$$', 'bcrypt$1$2$3$a$b']) {
      expect(await verifyPassword(PASSWORD, bad)).toBe(false)
    }
  })

  it('recognises its own format, so a plaintext env value can be refused at boot', async () => {
    expect(looksHashed(await hash())).toBe(true)
    expect(looksHashed('hunter2')).toBe(false)
  })
})

describe('TOTP', () => {
  it('accepts the current code', () => {
    expect(verifyTotp(TOTP, code())).toBe(true)
  })

  it('⚠️ accepts one step of clock drift either side, and no more', () => {
    // Zero tolerance rejects an operator whose phone is a few seconds off, and
    // it reads as "wrong password" — maddening to diagnose. Wider windows keep
    // an intercepted code alive longer.
    const now = Date.now()
    const counter = Math.floor(now / 1000 / TOTP_STEP_SECONDS)
    expect(verifyTotp(TOTP, totpCode(TOTP, counter - 1), now)).toBe(true)
    expect(verifyTotp(TOTP, totpCode(TOTP, counter + 1), now)).toBe(true)
    expect(verifyTotp(TOTP, totpCode(TOTP, counter - 2), now)).toBe(false)
    expect(verifyTotp(TOTP, totpCode(TOTP, counter + 2), now)).toBe(false)
  })

  it('rejects malformed input without throwing', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 5']) {
      expect(verifyTotp(TOTP, bad)).toBe(false)
    }
  })

  it('tolerates how humans actually paste secrets', () => {
    // Lowercase, spaces and padding are all normalised — rejecting them would
    // produce "invalid code" for a secret that is perfectly correct.
    const spaced = TOTP.toLowerCase().replace(/(.{4})/g, '$1 ')
    expect(verifyTotp(spaced, code())).toBe(true)
  })

  it('round-trips base32', () => {
    const buf = Buffer.from([0, 1, 127, 128, 255, 42])
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true)
  })

  it('⚠️ matches RFC 6238 test vectors, so real authenticator apps agree', () => {
    // The whole point of SHA-1 here. An implementation that is self-consistent
    // but disagrees with the RFC produces codes no app will ever generate, and
    // that is only discoverable when you are locked out.
    const secret = base32Encode(Buffer.from('12345678901234567890'))
    expect(totpCode(secret, Math.floor(59 / 30))).toBe('287082')
    expect(totpCode(secret, Math.floor(1111111109 / 30))).toBe('081804')
    expect(totpCode(secret, Math.floor(1234567890 / 30))).toBe('005924')
  })
})

describe('sessions', () => {
  it('round-trips a session', async () => {
    const token = await mintAdminSession(SESSION_SECRET, USERNAME, 'public')
    expect(await verifyAdminSession(SESSION_SECRET, token)).toMatchObject({
      sub: USERNAME, surface: 'public',
    })
  })

  it('⚠️ rejects a token signed with the TENANT secret', async () => {
    // The misconfiguration that would matter most: if the control plane shared
    // JWT_SECRET, any tenant admin's token — or any single compromised tenant
    // container — would be a fleet credential.
    const token = await mintAdminSession(TENANT_JWT_SECRET, USERNAME, 'public')
    expect(await verifyAdminSession(SESSION_SECRET, token)).toBeNull()
  })

  it('⚠️ rejects a tenant-shaped token even given the same secret', async () => {
    // Defence in depth for the same failure: the audience claim is an
    // independent guard, so a leaked-and-shared secret is still not enough.
    const tenantToken = await new SignJWT({ roles: ['admin'] })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('2250591')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(SESSION_SECRET))
    expect(await verifyAdminSession(SESSION_SECRET, tenantToken)).toBeNull()
  })

  it('rejects garbage and expired tokens without throwing', async () => {
    expect(await verifyAdminSession(SESSION_SECRET, 'not.a.token')).toBeNull()
    const expired = await new SignJWT({ surface: 'public' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(USERNAME)
      .setIssuer('tnl-admin')
      .setAudience(ADMIN_AUDIENCE)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(SESSION_SECRET))
    expect(await verifyAdminSession(SESSION_SECRET, expired)).toBeNull()
  })
})

describe('login', () => {
  it('issues a session for the right username, password and code', async () => {
    const a = await app()
    const res = await login(a, { username: USERNAME, password: PASSWORD, code: code() })
    expect(res.statusCode).toBe(200)
    expect(res.json().token).toBeTruthy()
    await a.close()
  })

  it('⚠️ refuses a valid username and password with NO second factor', async () => {
    // The reason TOTP is required at all: a public login page in front of a box
    // that can create factions and rewrite what every tenant reads.
    const a = await app()
    expect((await login(a, { username: USERNAME, password: PASSWORD })).statusCode).toBe(401)
    expect((await login(a, { username: USERNAME, password: PASSWORD, code: '000000' })).statusCode).toBe(401)
    await a.close()
  })

  it('⚠️ answers identically for a wrong username and a wrong password', async () => {
    // Distinguishing them tells an attacker which half they have already
    // solved, turning two unknowns into two separate one-unknown problems.
    const a = await app()
    const wrongUser = await login(a, { username: 'nobody', password: PASSWORD, code: code() })
    const wrongPass = await login(a, { username: USERNAME, password: 'wrong', code: code() })
    expect(wrongUser.statusCode).toBe(wrongPass.statusCode)
    expect(wrongUser.json()).toEqual(wrongPass.json())
    await a.close()
  })

  it('rejects a missing or non-string body without throwing', async () => {
    const a = await app()
    for (const payload of [{}, { username: 123, password: [], code: null }]) {
      expect((await login(a, payload as any)).statusCode).toBe(401)
    }
    await a.close()
  })

  it('⚠️ locks out after repeated failures', async () => {
    const a = await app('public', new LoginLimiter(3, 60_000))
    for (let i = 0; i < 3; i++) {
      await login(a, { username: USERNAME, password: 'wrong', code: code() })
    }
    const locked = await login(a, { username: USERNAME, password: PASSWORD, code: code() })
    expect(locked.statusCode).toBe(429)
    expect(locked.json().retry_after_seconds).toBeGreaterThan(0)
    await a.close()
  })
})

describe('protected routes', () => {
  it('refuses without a token', async () => {
    const a = await app()
    expect((await a.inject({ method: 'GET', url: '/api/admin/me' })).statusCode).toBe(401)
    await a.close()
  })

  it('accepts a session from login', async () => {
    const a = await app()
    const token = (await login(a, { username: USERNAME, password: PASSWORD, code: code() })).json().token
    const res = await a.inject({
      method: 'GET', url: '/api/admin/me', headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ username: USERNAME, surface: 'public' })
    await a.close()
  })

  it('⚠️ refuses a LOCAL token on the PUBLIC surface', async () => {
    // Different trust levels. A token minted behind the SSH tunnel must not be
    // replayable against the internet-facing listener.
    const a = await app('public')
    const localToken = await mintAdminSession(SESSION_SECRET, USERNAME, 'local')
    const res = await a.inject({
      method: 'GET', url: '/api/admin/me', headers: { authorization: `Bearer ${localToken}` },
    })
    expect(res.statusCode).toBe(401)
    await a.close()
  })
})

describe('the two-listener split', () => {
  it('⚠️ a local-only route does NOT EXIST on the public surface', async () => {
    // The structural guarantee, and the reason this is not a preHandler check.
    // 404 — not 401, not 403 — because the route was never registered. A
    // request cannot reach a route that is not in the router, whatever headers
    // it carries and whatever a guard gets wrong.
    const pub = await app('public')
    const token = await mintAdminSession(SESSION_SECRET, USERNAME, 'public')
    const res = await pub.inject({
      method: 'GET', url: '/api/admin/local/ping', headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(404)
    await pub.close()
  })

  it('the same route exists on the local surface', async () => {
    const loc = await app('local')
    const token = await mintAdminSession(SESSION_SECRET, USERNAME, 'local')
    const res = await loc.inject({
      method: 'GET', url: '/api/admin/local/ping', headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    await loc.close()
  })

  it('still requires authentication on the local surface', async () => {
    // Reachability is not authorisation: the tunnel is a network control, and
    // an unauthenticated local route would be open to anything on the host.
    const loc = await app('local')
    expect((await loc.inject({ method: 'GET', url: '/api/admin/local/ping' })).statusCode).toBe(401)
    await loc.close()
  })

  it('health is unauthenticated on both, for container healthchecks', async () => {
    for (const surface of ['public', 'local'] as const) {
      const a = await app(surface)
      const res = await a.inject({ method: 'GET', url: '/api/admin/health' })
      expect(res.statusCode).toBe(200)
      expect(res.json().surface).toBe(surface)
      await a.close()
    }
  })
})

describe('LoginLimiter', () => {
  it('unlocks after the window and starts a fresh count', () => {
    // Otherwise one bad day leaves the account permanently one mistake from
    // locking.
    const l = new LoginLimiter(2, 1000)
    l.fail('u', 0)
    expect(l.fail('u', 0)).toBe(true)
    expect(l.lockedFor('u', 500)).toBe(500)
    expect(l.lockedFor('u', 1500)).toBe(0)
    expect(l.fail('u', 1500)).toBe(false)
  })

  it('a success clears the record', () => {
    const l = new LoginLimiter(2, 1000)
    l.fail('u', 0)
    l.succeed('u')
    expect(l.fail('u', 0)).toBe(false)
  })

  it('⚠️ tracks usernames independently', () => {
    // Keyed by username, not IP: an attacker rotates addresses trivially, and
    // behind nginx every request would otherwise share one proxy address —
    // locking on that would let an attacker lock out the real operator.
    const l = new LoginLimiter(2, 1000)
    l.fail('a', 0)
    expect(l.fail('b', 0)).toBe(false)
  })
})
