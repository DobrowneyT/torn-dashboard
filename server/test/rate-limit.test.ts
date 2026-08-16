// API rate limiting (#485).
//
// Prerequisite for the dibs userscript (#487): every client until now has been
// the SPA, driven by a handful of people per tenant. A userscript runs on a page
// members leave open for a whole war, and a retry bug in a client we ship to
// phones is discovered AFTER everyone has it.
//
// The limits are configured per-stack here rather than exercised at their real
// defaults, because a test that had to send 600 requests to prove a 600/minute
// cap would be slow and would tell us nothing the small numbers do not.
//
// ⚠️ Counters live for the whole window, so tests sharing a stack share a budget.
// Each describe below gets its OWN stack for exactly that reason — while this
// was being written, an earlier test spending the budget first made one
// assertion pass for the wrong reason and another fail for one.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import WebSocket from 'ws'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'

/**
 * Resolves with the close code if the socket is rejected, or 'open' if it stays up.
 *
 * ⚠️ Cannot resolve on the `open` event. The route authenticates AFTER the
 * handshake completes — `socket.close(4401)` — so a rejected socket opens
 * first and is closed a moment later. Treating `open` as success would report
 * an unauthenticated connection as accepted.
 */
function wsOutcome(stack: TestStack, token: string): Promise<'open' | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${stack.baseUrl.replace('http', 'ws')}/api/war-room/ws?token=${token}`)
    let settled = false
    const done = (v: 'open' | number) => { if (!settled) { settled = true; resolve(v) } }
    ws.on('open', () => setTimeout(() => { if (!settled) { done('open'); ws.close() } }, 250))
    ws.on('close', (code) => done(code))
    ws.on('error', () => { /* close fires next and carries the code */ })
  })
}

async function login(stack: TestStack, apiKey: string) {
  const res = await fetch(`${stack.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey }),
  })
  const body = (await res.json().catch(() => null)) as { token?: string } | null
  return { status: res.status, body }
}

/** Fire n requests SEQUENTIALLY and report the status of each. */
async function burst(n: number, fn: () => Promise<Response>) {
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push((await fn()).status)
  return out
}

describe('the general limit (#485)', () => {
  let stack: TestStack
  beforeAll(async () => {
    stack = await startTestStack(undefined, {}, {
      // Tiny on purpose: the shape of the rule is under test, not the magnitude.
      rateLimit: { max: 8, timeWindowMs: 60_000, authMax: 3 },
    })
  }, 120_000)
  afterAll(async () => { await stack?.close() })

  it('lets traffic through up to the cap, then refuses with 429', async () => {
    const codes = await burst(12, () => fetch(`${stack.baseUrl}/api/bootstrap`))
    expect(codes.slice(0, 8)).toEqual(Array(8).fill(200))
    expect(codes.slice(8)).toEqual(Array(4).fill(429))
  })

  it('⚠️ tells the client WHEN to come back, not just "no"', async () => {
    // A client handed a bare 429 has no way to behave well, so it retries —
    // which is the behaviour the limit exists to stop.
    const res = await fetch(`${stack.baseUrl}/api/bootstrap`)   // already over
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(((await res.json()) as { retry_after: number }).retry_after).toBeGreaterThan(0)
  })
})

describe('health checks are never limited (#485)', () => {
  let stack: TestStack
  beforeAll(async () => {
    stack = await startTestStack(undefined, {}, {
      rateLimit: { max: 3, timeWindowMs: 60_000, authMax: 3 },
    })
  }, 120_000)
  afterAll(async () => { await stack?.close() })

  it('⚠️ answers liveness and readiness far past the cap', async () => {
    // deploy/update.sh polls /api/health/ready up to 20 times in 40s per tenant
    // to decide whether a deploy worked, and Docker's HEALTHCHECK hits
    // /api/health on its own schedule. A limit catching either would turn
    // ordinary deploys into false FAILs and mark healthy containers unhealthy.
    // A monitoring endpoint that stops answering under load is worse than none.
    expect(await burst(30, () => fetch(`${stack.baseUrl}/api/health`)))
      .toEqual(Array(30).fill(200))
    expect(await burst(25, () => fetch(`${stack.baseUrl}/api/health/ready`)))
      .toEqual(Array(25).fill(200))
  })
})

describe('the auth limit is tighter than the general one (#485)', () => {
  let stack: TestStack
  beforeAll(async () => {
    // General deliberately roomy so "tighter" is unambiguous.
    stack = await startTestStack(undefined, {}, {
      rateLimit: { max: 100, timeWindowMs: 60_000, authMax: 3 },
    })
  }, 120_000)
  afterAll(async () => { await stack?.close() })

  it('⚠️ refuses logins long before the general cap is reached', async () => {
    // login is unauthenticated by nature and calls Torn, so it is both the most
    // expensive endpoint and the first one an attacker reaches. Asserted as a
    // relationship rather than exact counts: the claim is "much tighter than
    // general", which stays true if either number is retuned later.
    const codes = await burst(6, () => fetch(`${stack.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'WRONGKEY00000000' }),
    }))
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(2)
    // ...while the general budget (100) is nowhere near spent.
    expect((await fetch(`${stack.baseUrl}/api/bootstrap`)).status).toBe(200)
  })
})

describe('a spent general budget does not block logging in (#485)', () => {
  let stack: TestStack
  beforeAll(async () => {
    stack = await startTestStack(undefined, {}, {
      rateLimit: { max: 4, timeWindowMs: 60_000, authMax: 10 },
    })
    stack.torn.addKey('RLKEYCCCCCCCCCCC', { id: '9003', factionId: TEST_FACTION.tornFactionId })
  }, 120_000)
  afterAll(async () => { await stack?.close() })

  it('⚠️ keeps the two budgets independent', async () => {
    // One shared bucket would mean a burst of ordinary reads locks people out
    // of logging in. The two limits protect different things.
    expect(await burst(6, () => fetch(`${stack.baseUrl}/api/bootstrap`))).toContain(429)
    const res = await login(stack, 'RLKEYCCCCCCCCCCC')
    expect(res.status).toBe(200)
  })
})

describe('the limit is per-identity, not per-tenant (#485)', () => {
  let stack: TestStack
  beforeAll(async () => {
    stack = await startTestStack(undefined, {}, {
      rateLimit: { max: 6, timeWindowMs: 60_000, authMax: 50 },
    })
    stack.torn.addKey('RLUSERAAAAAAAAAA', { id: '9101', factionId: TEST_FACTION.tornFactionId })
    stack.torn.addKey('RLUSERBBBBBBBBBB', { id: '9102', factionId: TEST_FACTION.tornFactionId })
  }, 120_000)
  afterAll(async () => { await stack?.close() })

  it('⚠️ gives each logged-in member their OWN budget', async () => {
    // The failure this prevents is severe and easy to ship: in production every
    // request arrives from the same nginx container, so an IP-only key would
    // put a whole faction in one bucket and let one busy member 429 everyone
    // else mid-war. Authenticated requests key on the JWT-verified user id,
    // which cannot be forged and needs no X-Forwarded-For plumbing to be right.
    const a = (await login(stack, 'RLUSERAAAAAAAAAA')).body!.token!
    const b = (await login(stack, 'RLUSERBBBBBBBBBB')).body!.token!
    const get = (token: string) => fetch(`${stack.baseUrl}/api/members/me/battle-stats`, {
      headers: { authorization: `Bearer ${token}` },
    })

    expect(await burst(9, () => get(a))).toContain(429)  // A spends their own
    expect((await get(b)).status).not.toBe(429)          // B is untouched
  })
})

describe('the war-room socket survives an exhausted budget (#485)', () => {
  let stack: TestStack
  beforeAll(async () => {
    stack = await startTestStack(undefined, {}, {
      rateLimit: { max: 3, timeWindowMs: 60_000, authMax: 20 },
    })
    stack.torn.addKey('RLWSKEYAAAAAAAAA', { id: '9201', factionId: TEST_FACTION.tornFactionId })
  }, 120_000)
  afterAll(async () => { await stack?.close() })

  it('⚠️ still connects after REST has been rate-limited', async () => {
    // The war room reconnects on every network blip. A member whose train goes
    // through a tunnel must not come back to a locked-out roster mid-war —
    // and the roster is the entire point of the page. The socket is one
    // authenticated connection, not a request stream, so it is exempt.
    const token = (await login(stack, 'RLWSKEYAAAAAAAAA')).body!.token!
    expect(await burst(6, () => fetch(`${stack.baseUrl}/api/bootstrap`))).toContain(429)

    // Repeated reconnects, well past the REST cap, all succeed.
    for (let i = 0; i < 5; i++) {
      expect(await wsOutcome(stack, token)).toBe('open')
    }
  })

  it('still rejects a socket with no valid token', async () => {
    // Exempt from rate limiting is not exempt from auth.
    expect(await wsOutcome(stack, 'not-a-real-token')).toBe(4401)
  })
})

describe('rate limiting can be switched off (#485)', () => {
  let stack: TestStack
  beforeAll(async () => { stack = await startTestStack(undefined, {}, { rateLimit: false }) }, 120_000)
  afterAll(async () => { await stack?.close() })

  it('applies no limit at all when disabled', async () => {
    // How the rest of the suite keeps working: a few hundred tests share one
    // loopback address, and a default-on limit would make unrelated suites fail
    // in ways that look like the feature under test is broken.
    expect(await burst(40, () => fetch(`${stack.baseUrl}/api/bootstrap`)))
      .toEqual(Array(40).fill(200))
  })
})
