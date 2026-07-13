// Every Torn API call this server makes must identify the app in its `comment`
// param. Torn surfaces that comment in each member's personal API-usage log, so
// members who lend a key to the pool can see exactly what is using it — that
// transparency is the whole point, and it only works if NO call path is missed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, TEST_KEY_ENCRYPTION_KEY, type TestStack } from './harness.js'
import { createKeyPool } from '../src/scraper/keyPool.js'
import { TORN_API_COMMENT } from '../src/tornComment.js'

let stack: TestStack

beforeAll(async () => {
  stack = await startTestStack()
}, 30000)

afterAll(async () => {
  await stack?.close()
})

describe('Torn API call comments', () => {
  it('tags the login key-verification call (the first call any member ever triggers)', async () => {
    const key = 'LOGINCOMMENT1234'
    stack.torn.addKey(key, { id: '4100', factionId: TEST_FACTION.tornFactionId })

    const before = stack.torn.comments().length
    const res = await fetch(`${stack.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: key }),
    })
    expect(res.status).toBe(200)

    const fresh = stack.torn.comments().slice(before)
    expect(fresh.length).toBeGreaterThan(0)
    // Not one of them may be unlabelled.
    expect(fresh.every((c) => c === TORN_API_COMMENT)).toBe(true)
  })

  it('tags pooled-key calls made by the scraper/ticker client', async () => {
    const { createTornClient } = await import('../src/scraper/tornClient.js')
    stack.torn.setPath('/v2/faction/basic', { basic: { id: 1, name: 'X' } })
    const client = createTornClient({
      baseUrl: stack.tornBaseUrl,
      budget: { requests: 10, perMs: 100 },
    })

    const before = stack.torn.comments().length
    await client.fetch('/v2/faction/basic', 'SOMEPOOLEDKEY16')
    // …and on a path that already carries a query string (the `&` vs `?` join).
    await client.fetch('/v2/faction/basic?striptags=true', 'SOMEPOOLEDKEY16')

    const fresh = stack.torn.comments().slice(before)
    expect(fresh).toEqual([TORN_API_COMMENT, TORN_API_COMMENT])
  })

  it('uses a Torn-safe comment (no spaces or characters that need escaping)', async () => {
    expect(TORN_API_COMMENT).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})
