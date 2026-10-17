// The Torn API client under failure (#963).
//
// ⚠️ Torn's API goes down for HOURS every Halloween — the busiest event of the
// year — and the old client had no timeout, no retry, no status check, and
// called `res.json()` unconditionally. These run against a REAL local HTTP
// server so timeouts, statuses and HTML bodies go through Node's actual
// `fetch`, not a mock that agrees with whatever the code assumes.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createTornClient, isTransientTornError, TornApiError, TornUnavailableError,
  TORN_RATE_LIMIT_CODES, TORN_UNAVAILABLE_CODES, TRANSIENT_TORN_CODES,
} from '../src/scraper/tornClient.js'

/** What the server should do for each successive request. */
type Step = { status?: number; body?: string; hang?: boolean }
let script: Step[] = []
let hits = 0
let server: Server
let baseUrl = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    hits += 1
    const step = script.shift() ?? { body: JSON.stringify({ ok: true }) }
    // ⚠️ A hang never answers — the exact shape of a stalled Torn request.
    if (step.hang) return
    res.writeHead(step.status ?? 200, { 'content-type': 'text/plain' })
    res.end(step.body ?? '{}')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections?.()
  await new Promise<void>((r) => server.close(() => r()))
})

beforeEach(() => { script = []; hits = 0 })

const sleeps: number[] = []
const client = (over: Record<string, unknown> = {}) => createTornClient({
  baseUrl,
  budget: { requests: 1000, perMs: 1000 },
  timeoutMs: 300,
  retry: { attempts: 3, baseDelayMs: 10, maxDelayMs: 40 },
  // ⚠️ Injected so backoff never makes the suite sleep.
  sleep: async (ms: number) => { sleeps.push(ms) },
  ...over,
})

const ok = (v: unknown) => ({ body: JSON.stringify(v) })
const tornErr = (code: number) => ({ body: JSON.stringify({ error: { code, error: 'x' } }) })

describe('a request that never answers', () => {
  it('⚠️ times out instead of hanging', async () => {
    // THE outage shape. Node's default is five minutes; on forge's two-minute
    // attacks-sync that stacked runs during every outage.
    script = [{ hang: true }, { hang: true }, { hang: true }]
    const started = Date.now()
    await expect(client().fetch('/v2/x', 'k')).rejects.toBeInstanceOf(TornUnavailableError)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('says it timed out, rather than something unhelpful', async () => {
    script = [{ hang: true }]
    await expect(client({ retry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 } }).fetch('/v2/x', 'k'))
      .rejects.toThrow(/no response within 300ms/)
  })

  it('is retried, and succeeds when Torn comes back', async () => {
    script = [{ hang: true }, ok({ back: true })]
    await expect(client().fetch('/v2/x', 'k')).resolves.toEqual({ back: true })
    expect(hits).toBe(2)
  })
})

describe('a response that is not the API', () => {
  it('⚠️ Cloudflare HTML is a TornUnavailableError, not a JSON SyntaxError', async () => {
    // The old client said "Unexpected token '<'", which sent whoever was
    // reading the run log hunting for a bug in our own code.
    script = [{ status: 200, body: '<!DOCTYPE html><html>Attention Required! | Cloudflare</html>' }]
    const err = await client({ retry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 } })
      .fetch('/v2/x', 'k').catch((e) => e)
    expect(err).toBeInstanceOf(TornUnavailableError)
    expect(err.message).toMatch(/non-JSON/)
    expect(err.message).not.toMatch(/Unexpected token/)
  })

  it('a 503 is retried', async () => {
    script = [{ status: 503, body: 'Service Unavailable' }, ok({ fine: 1 })]
    await expect(client().fetch('/v2/x', 'k')).resolves.toEqual({ fine: 1 })
    expect(hits).toBe(2)
  })

  it('⚠️ Cloudflare\'s 403 "error code: 1010" is NOT retried', async () => {
    // Observed for real against api.torn.com: Cloudflare blocking a client by
    // its signature. Retrying the same request with the same signature cannot
    // succeed, and only spends budget.
    script = [{ status: 403, body: 'error code: 1010' }]
    const err = await client().fetch('/v2/x', 'k').catch((e) => e)
    expect(err).toBeInstanceOf(TornUnavailableError)
    expect(err.status).toBe(403)
    expect(err.message).toMatch(/1010/)
    expect(hits).toBe(1)
  })

  it('a 429 is retried', async () => {
    script = [{ status: 429, body: 'slow down' }, ok({ n: 1 })]
    await expect(client().fetch('/v2/x', 'k')).resolves.toEqual({ n: 1 })
  })

  it('never quotes a whole HTML page into the error', async () => {
    script = [{ status: 502, body: '<html>' + 'x'.repeat(5000) + '</html>' }]
    const err = await client({ retry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 } })
      .fetch('/v2/x', 'k').catch((e) => e)
    expect(err.message.length).toBeLessThan(220)
  })
})

describe('Torn\'s own error codes', () => {
  it('⚠️ a rate limit (5) is NEVER retried', async () => {
    // Hitting it again a second later is how a soft limit becomes a longer one.
    script = [tornErr(5), ok({ shouldNot: 'reach' })]
    const err = await client().fetch('/v2/x', 'k').catch((e) => e)
    expect(err).toBeInstanceOf(TornApiError)
    expect(err.tornCode).toBe(5)
    expect(hits).toBe(1)
  })

  it('an IP block (8) is never retried', async () => {
    script = [tornErr(8)]
    await client().fetch('/v2/x', 'k').catch(() => {})
    expect(hits).toBe(1)
  })

  it('⚠️ "API disabled" (9) is not retried — it lasts far longer than a backoff', async () => {
    script = [tornErr(9), ok({})]
    const err = await client().fetch('/v2/x', 'k').catch((e) => e)
    expect(err.tornCode).toBe(9)
    expect(hits).toBe(1)
  })

  it('a backend error (17) IS retried — it is usually a blip', async () => {
    script = [tornErr(17), ok({ recovered: true })]
    await expect(client().fetch('/v2/x', 'k')).resolves.toEqual({ recovered: true })
  })

  it('a bad key (2) is not retried', async () => {
    script = [tornErr(2)]
    await client().fetch('/v2/x', 'k').catch(() => {})
    expect(hits).toBe(1)
  })

  it('still carries tornCode, so the 22 existing callers keep working', async () => {
    script = [tornErr(5)]
    const err = await client().fetch('/v2/x', 'k').catch((e) => e)
    expect(err.tornCode).toBe(5)
    expect(TORN_RATE_LIMIT_CODES.has(err.tornCode)).toBe(true)
  })
})

describe('retrying', () => {
  it('gives up after the configured attempts and throws the LAST error', async () => {
    script = [{ status: 503, body: 'a' }, { status: 503, body: 'b' }, { status: 502, body: 'last' }]
    const err = await client().fetch('/v2/x', 'k').catch((e) => e)
    expect(hits).toBe(3)
    expect(err.status).toBe(502)
    expect(err.message).toMatch(/last/)
  })

  it('attempts: 1 means exactly one request — the War Room ticker\'s setting', async () => {
    // The ticker polls every second; the next tick IS the retry.
    script = [{ status: 503, body: 'x' }, ok({})]
    await client({ retry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 } })
      .fetch('/v2/x', 'k').catch(() => {})
    expect(hits).toBe(1)
  })

  it('⚠️ backs off with jitter, capped, rather than retrying instantly', async () => {
    // Five tenants reach Torn from one box. Without jitter they would all
    // retry in the same second when it comes back.
    sleeps.length = 0
    script = [{ status: 503 }, { status: 503 }, ok({})]
    await client().fetch('/v2/x', 'k')
    expect(sleeps).toHaveLength(2)
    for (const ms of sleeps) {
      expect(ms).toBeGreaterThanOrEqual(0)
      expect(ms).toBeLessThanOrEqual(40)
    }
  })

  it('⚠️ every retry goes through the rate limiter', async () => {
    // A retry that skipped the limiter would let an outage push a key past
    // Torn's per-key rate the moment Torn recovers.
    const limited = createTornClient({
      baseUrl, budget: { requests: 2, perMs: 60_000 }, timeoutMs: 300,
      retry: { attempts: 3, baseDelayMs: 0, maxDelayMs: 0 }, sleep: async () => {},
    })
    script = [{ status: 503 }, { status: 503 }, ok({})]
    const pending = limited.fetch('/v2/x', 'k')
    await new Promise((r) => setTimeout(r, 400))
    // Two dispatched within the window; the third is held by the limiter.
    expect(hits).toBe(2)
    void pending.catch(() => {})
  })
})

describe('classification', () => {
  it('the three code sets are what the comments say', () => {
    expect([...TORN_RATE_LIMIT_CODES].sort()).toEqual([5, 8])
    expect([...TORN_UNAVAILABLE_CODES].sort()).toEqual([17, 9].sort())
    expect([...TRANSIENT_TORN_CODES].sort((a, b) => a - b)).toEqual([5, 8, 9, 17])
  })

  it('isTransientTornError: outages and rate limits yes, bad keys no', () => {
    expect(isTransientTornError(new TornUnavailableError('down'))).toBe(true)
    expect(isTransientTornError(new TornApiError(9, 'x'))).toBe(true)
    expect(isTransientTornError(new TornApiError(5, 'x'))).toBe(true)
    expect(isTransientTornError(new TornApiError(2, 'x'))).toBe(false)
    expect(isTransientTornError(new Error('random'))).toBe(false)
  })

  it('a successful response is returned exactly as before', async () => {
    script = [ok({ attacks: [{ id: 1 }] })]
    await expect(client().fetch('/v2/faction/attacks', 'k'))
      .resolves.toEqual({ attacks: [{ id: 1 }] })
  })
})
