// Web Push infrastructure (#207): subscription storage, VAPID key exposure,
// and stale-endpoint pruning on delivery. HTTP against the templated Postgres
// for the routes; the delivery/prune logic is exercised directly with an
// injected fake sender (no network, no real VAPID).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'
import { createPushService, type PushSender } from '../src/push.js'

let stack: TestStack
let memberToken: string
let warleadToken: string

async function loginAs(key: string, id: string) {
  stack.torn.addKey(key, { id, factionId: TEST_FACTION.tornFactionId })
  const res = await fetch(`${stack.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: key }),
  })
  expect(res.status).toBe(200)
  return ((await res.json()) as any).token as string
}

async function api(method: string, path: string, token: string, payload?: unknown) {
  const res = await fetch(`${stack.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

function sub(endpoint: string) {
  return { endpoint, keys: { p256dh: 'p256dh-' + endpoint.slice(-4), auth: 'auth-' + endpoint.slice(-4) } }
}

beforeAll(async () => {
  stack = await startTestStack()
  await stack.db.query(`INSERT INTO role_assignments (torn_user_id, role) VALUES (8100, 'warlead')`)
  warleadToken = await loginAs('PUSHLEAD8100XXXX', '8100')
  memberToken = await loginAs('PUSHMEMBER8200XX', '8200')
}, 30000)

afterAll(async () => { await stack?.close() })

describe('push routes (#207)', () => {
  it('reports no VAPID public key when push is unconfigured', async () => {
    const res = await api('GET', '/api/push/vapid-public-key', memberToken)
    expect(res.status).toBe(200)
    expect(res.body.publicKey).toBeNull()
  })

  it('stores a subscription owned by the caller', async () => {
    const res = await api('POST', '/api/push/subscribe', memberToken, sub('https://push.example/ep-8200'))
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)

    const row = await stack.db.query(
      'SELECT member_id, p256dh FROM push_subscriptions WHERE endpoint = $1',
      ['https://push.example/ep-8200']
    )
    expect(row.rows[0].member_id).toBe('8200')
  })

  it('re-subscribing the same endpoint updates rather than duplicates', async () => {
    await api('POST', '/api/push/subscribe', memberToken, sub('https://push.example/ep-dup'))
    await api('POST', '/api/push/subscribe', memberToken, sub('https://push.example/ep-dup'))
    const count = await stack.db.query('SELECT count(*)::int AS n FROM push_subscriptions WHERE endpoint = $1', ['https://push.example/ep-dup'])
    expect(count.rows[0].n).toBe(1)
  })

  it('rejects a malformed subscription', async () => {
    const res = await api('POST', '/api/push/subscribe', memberToken, { endpoint: 'not-a-url' })
    expect(res.status).toBe(400)
  })

  it('requires authentication to subscribe', async () => {
    const res = await fetch(`${stack.baseUrl}/api/push/subscribe`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sub('https://push.example/anon')),
    })
    expect(res.status).toBe(401)
  })

  it('test-send is 503 while push is unconfigured, and members cannot call it', async () => {
    expect((await api('POST', '/api/push/test', warleadToken)).status).toBe(503)
    expect((await api('POST', '/api/push/test', memberToken)).status).toBe(403)
  })

  it('unsubscribe removes the stored endpoint', async () => {
    await api('POST', '/api/push/subscribe', memberToken, sub('https://push.example/ep-bye'))
    const res = await api('POST', '/api/push/unsubscribe', memberToken, { endpoint: 'https://push.example/ep-bye' })
    expect(res.status).toBe(200)
    const row = await stack.db.query('SELECT 1 FROM push_subscriptions WHERE endpoint = $1', ['https://push.example/ep-bye'])
    expect(row.rowCount).toBe(0)
  })
})

describe('push delivery + pruning (#207)', () => {
  const vapid = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:test@example.com' }

  it('exposes the public key and reports configured when VAPID is set', () => {
    const svc = createPushService({ db: stack.db, vapid, sender: async () => {} })
    expect(svc.publicKey).toBe('pub')
    expect(svc.configured).toBe(true)
  })

  it('sends to a member and prunes only endpoints the browser dropped (410/404)', async () => {
    await stack.db.query('DELETE FROM push_subscriptions')
    for (const ep of ['live', 'gone', 'missing', 'boom']) {
      await stack.db.query(
        'INSERT INTO push_subscriptions (endpoint, member_id, p256dh, auth) VALUES ($1, $2, $3, $4)',
        [`https://push.example/${ep}`, '9000', 'p', 'a']
      )
    }
    // Fake delivery: 'gone' is 410, 'missing' is 404, 'boom' is a transient 500.
    const sender: PushSender = async (s) => {
      if (s.endpoint.endsWith('/gone')) throw { statusCode: 410 }
      if (s.endpoint.endsWith('/missing')) throw { statusCode: 404 }
      if (s.endpoint.endsWith('/boom')) throw { statusCode: 500 }
    }
    const svc = createPushService({ db: stack.db, vapid, sender })

    const result = await svc.sendToMembers(['9000'], { title: 'hi', body: 'there' })
    expect(result).toEqual({ sent: 1, pruned: 2, failed: 1 })

    // Only the dropped endpoints are gone; the live one and the transient
    // failure survive for a retry next time.
    const left = await stack.db.query('SELECT endpoint FROM push_subscriptions ORDER BY endpoint')
    expect(left.rows.map((r) => r.endpoint)).toEqual([
      'https://push.example/boom',
      'https://push.example/live',
    ])
  })

  it('is a no-op when VAPID is not configured', async () => {
    const svc = createPushService({ db: stack.db, vapid: null })
    expect(svc.publicKey).toBeNull()
    const result = await svc.sendToMembers(['9000'], { title: 'x', body: 'y' })
    expect(result).toEqual({ sent: 0, pruned: 0, failed: 0 })
  })

  it('sendToAll delivers to every distinct subscriber (surge fan-out)', async () => {
    await stack.db.query('DELETE FROM push_subscriptions')
    // Two members, one with two devices — three endpoints, all should get it.
    const subs = [
      ['https://push.example/m1-a', '5001'],
      ['https://push.example/m1-b', '5001'],
      ['https://push.example/m2', '5002'],
    ]
    for (const [ep, mid] of subs) {
      await stack.db.query('INSERT INTO push_subscriptions (endpoint, member_id, p256dh, auth) VALUES ($1,$2,$3,$4)', [ep, mid, 'p', 'a'])
    }
    const seen: string[] = []
    const svc = createPushService({ db: stack.db, vapid, sender: async (s) => { seen.push(s.endpoint) } })
    const result = await svc.sendToAll({ title: 'surge', body: 'incoming' })
    expect(result.sent).toBe(3)
    expect(seen.sort()).toEqual(subs.map(([ep]) => ep).sort())
  })
})
